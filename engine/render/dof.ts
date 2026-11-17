// Depth of field (addendum A7): a thin-lens camera blur on the card pass's linear HDR radiance, between the card pass
// and the glare (render/pipeline.ts). CPU twin and the optics: physics/lens.ts. Shaders: shaders/dof_*.
//
// Passes (F = full resolution, H = half, T = 16 × 16-pixel tiles):
//   1  coc       F   signed CoC radius from the resolved depth (3 × 3 nearest depth: stable silhouettes)
//   2  tile      T   max near / far CoC of each tile's object pixels
//   3  dilate    T   the gather radius: max CoC of the tiles whose blur reaches the tile
//   4  prepare   H   2 × 2 decode (premultiplied scene-linear) + front-surface CoC        [MRT: colour, CoC]
//   5  extract   H   highlights → the sprites, the rest → the gather (mipmapped)            [MRT: gather in, highlights]
//   6  gather    H   scatter-as-gather over the aperture pattern, near and far fields      [MRT: near, far]
//   7  sprites   H   one instanced quad per quarter cell: exact aperture-shaped bokeh of highlights (additive)
//   8  composite F   tiles out of reach copied texel for texel; else near over far + sprites, re-encoded
// The output has the card target's format, so the glare and the output pass read it in its place. Off = none of this
// exists (Pipeline disposes the instance and allocates the card target without a depth texture).
//
// Depth: the card target keeps its multisampled 24-bit depth buffer; while DoF is on, Pipeline allocates it with a
// DepthTexture on the resolve framebuffer and sets `resolveDepthBuffer`, so three's MSAA resolve blits depth into it
// (one NEAREST blit, the same 4 B/px as the resolve depth renderbuffer it replaces).
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { TierDof } from "../types.ts";
import { LIB } from "../shaders/lib/index.ts";
import fullscreenVert from "../shaders/fullscreen.vert?raw";
import dofCommon from "../shaders/dof_common.glsl?raw";
import cocFrag from "../shaders/dof_coc.frag?raw";
import tileFrag from "../shaders/dof_tile.frag?raw";
import dilateFrag from "../shaders/dof_dilate.frag?raw";
import prepareFrag from "../shaders/dof_prepare.frag?raw";
import extractFrag from "../shaders/dof_extract.frag?raw";
import gatherFrag from "../shaders/dof_gather.frag?raw";
import spriteVert from "../shaders/dof_sprite.vert?raw";
import spriteFrag from "../shaders/dof_sprite.frag?raw";
import compositeFrag from "../shaders/dof_composite.frag?raw";
import {
  CATS_EYE_MAX, aperturePattern, bladeConstants, clipAreaTable, cocRadiusFactorPx, locaShiftMm, mmToPx,
} from "../physics/lens.ts";

/** What the DoF needs of a frame (main.ts builds it from the state, the camera and the focus). */
export interface DofFrame {
  zfM: number;                 // focus distance [m] (after the focus pull)
  fMm: number;                 // focal length [mm] of the camera's fov
  fNumber: number;
  near: number; far: number;   // camera planes [m]
  blades: number; bladeCurve: number; bladeAngleDeg: number;
  catsEye: number; rim: number; loca: number;
  exposure: number;            // linear exposure multiplier (sprite threshold, black-page lift)
  blackPage: boolean;
  debug: boolean;              // the `dof` debug view (signed CoC, raw)
}

/** The per-frame read-out (`info.dof`). */
export interface DofInfo {
  cocKPx: number;              // K: radius = K·(1 − z_f/z) [device px]
  cocInfPx: number;            // the CoC radius at infinity (clamped) [device px]
  locaPx: number;              // the R/B CoC shift [device px]
  maxRadiusPx: number;         // the tier clamp
  samples: number;
  spriteThreshold: number;
  heightPx: number;            // the viewport height the CoC is scaled to
}

export const DOF_TILE = 16;
/** End of the sharp → gathered blend [full px of CoC radius]. */
export const DOF_SMALL_PX = 2;
/** Highlights: contrast against the ring and the smallest scattered CoC [half px]. */
const SPRITE_K = 1.5;
const SPRITE_MIN_R = 1.5;
const PATTERN_MAX = 64;
const MAX_LOD = 4;

/** Bytes per full-resolution pixel of the DoF targets (counted in `gpuMB` while DoF is on): output RGBA16F 8 + CoC
 *  R16F 2, and at ¼ the pixel count: prepare RGBA16F 8 + CoC RG16F with mips 5.33, gather input RGBA16F with mips
 *  10.67 + highlights 8, near + far 16, sprites 8 — 24 B/px in all (tiles negligible). The depth texture replaces the
 *  resolve depth renderbuffer (no extra bytes). */
export function dofBytesPerPixel(): number {
  return 8 + 2 + (8 + (4 * 4) / 3 + (8 * 4) / 3 + 8 + 16 + 8) / 4;
}

const common = { depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending } as const;
const TRIP_UNIFORMS = () => ({
  uMaxOrder: { value: 0 }, uGhB: { value: 0 }, uVorR: { value: 0 }, uFlakeR: { value: 0 },
  uBCells: { value: 0 }, uBBins: { value: 0 }, uBLevels: { value: 0 },
});

function rt(w: number, h: number, o: { format?: THREE.PixelFormat; linear?: boolean; count?: number } = {}): THREE.WebGLRenderTarget {
  const filter = o.linear ? THREE.LinearFilter : THREE.NearestFilter;
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: o.format ?? THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false, minFilter: filter, magFilter: filter, count: o.count ?? 1,
  });
  return t;
}

export class Dof {
  /** Review / bench switches (never set by the app): 1 = skip the bokeh sprites, 2 = skip the highlight split. */
  static debugFlags = 0;
  // targets (allocated for the full card target)
  private cocF: THREE.WebGLRenderTarget | null = null;
  private tiles: THREE.WebGLRenderTarget | null = null;
  private dil: THREE.WebGLRenderTarget | null = null;
  private prep: THREE.WebGLRenderTarget | null = null;
  private ext: THREE.WebGLRenderTarget | null = null;
  private gath: THREE.WebGLRenderTarget | null = null;
  private spr: THREE.WebGLRenderTarget | null = null;
  private out: THREE.WebGLRenderTarget | null = null;
  private allocW = 0; private allocH = 0; private halfW = 1; private halfH = 1; private tilesW = 1; private tilesH = 1;

  // materials
  private readonly shape: Record<string, THREE.IUniform>;
  private readonly mCoc: THREE.ShaderMaterial;
  private readonly mTile: THREE.ShaderMaterial;
  private readonly mDilate: THREE.ShaderMaterial;
  private readonly mPrep: THREE.ShaderMaterial;
  private readonly mExt: THREE.ShaderMaterial;
  private readonly mGather: THREE.ShaderMaterial;
  private readonly mSprite: THREE.ShaderMaterial;
  private readonly mComp: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private readonly spriteGeo: THREE.InstancedBufferGeometry;
  private readonly spriteMesh: THREE.Mesh;
  private readonly spriteCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private shapeKey = "";
  info: DofInfo | null = null;

  constructor() {
    const glsl = (body: string) => `${LIB.common}\n${dofCommon}\n${body}`;
    this.shape = {
      uBladeN: { value: 9 }, uBladeStraight: { value: 0 }, uBladeC: { value: 1 }, uBladeDc: { value: 0 }, uBladeQ: { value: 1 },
      uBladeNormal0: { value: 0 }, uCatsCentre: { value: new THREE.Vector2() }, uCatsScale: { value: 0 },
      uClip: { value: Array.from({ length: 8 }, () => new THREE.Vector4(1, 1, 1, 1)) }, uAreaRatio: { value: 1 },
      uLocaPx: { value: 0 }, uLocaFade: { value: new THREE.Vector2(0.5, 2) }, uPageH: { value: 0 },
      ...TRIP_UNIFORMS(),
    };
    const mat = (name: string, frag: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({ ...common, name, vertexShader: fullscreenVert, fragmentShader: glsl(frag), uniforms: { ...this.shape, ...uniforms }, ...extra });
    const v2 = () => ({ value: new THREE.Vector2() });
    const iv2 = () => ({ value: new THREE.Vector2() });
    const tex = () => ({ value: null as THREE.Texture | null });
    this.mCoc = mat("DofCoc", cocFrag, {
      tDepth: tex(), uSize: iv2(), uNear: { value: 0.01 }, uFar: { value: 20 }, uZf: { value: 1 }, uCocK: { value: 0 }, uMaxR: { value: 64 },
    });
    this.mTile = mat("DofTile", tileFrag, { tCoc: tex(), uSize: iv2() });
    this.mDilate = mat("DofDilate", dilateFrag, { tTile: tex(), uTiles: iv2(), uReach: { value: 4 } });
    this.mPrep = mat("DofPrepare", prepareFrag, { tHdr: tex(), tCoc: tex(), uSize: iv2(), uHalf: iv2() },
      { glslVersion: THREE.GLSL3 });
    this.mExt = mat("DofExtract", extractFrag, {
      tCol: tex(), tCoc: tex(), uHalf: iv2(), uThresh: { value: 1 }, uK: { value: SPRITE_K }, uMinR: { value: SPRITE_MIN_R },
    }, { glslVersion: THREE.GLSL3 });
    this.mGather = mat("DofGather", gatherFrag, {
      tCol: tex(), tCoc: tex(), tTile: tex(), uHalf: iv2(), uHalfAlloc: v2(),
      uPat: { value: Array.from({ length: PATTERN_MAX }, () => new THREE.Vector4()) }, uN: { value: 32 }, uMaxLod: { value: MAX_LOD },
      uRimFar: { value: 0 }, uRimNear: { value: 0 },
    }, { glslVersion: THREE.GLSL3 });
    this.mSprite = new THREE.ShaderMaterial({
      name: "DofSprite", glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      vertexShader: glsl(spriteVert), fragmentShader: glsl(spriteFrag),
      uniforms: {
        ...this.shape, tHi: tex(), tCoc: tex(), tNear: tex(), uHalf: iv2(), uCellsX: { value: 1 }, uMinR: { value: SPRITE_MIN_R },
        uRimFar: { value: 0 }, uRimNear: { value: 0 },
      },
    });
    this.mComp = mat("DofComposite", compositeFrag, {
      tHdr: tex(), tCocF: tex(), tTile: tex(), tNear: tex(), tFar: tex(), tCocH: tex(), tSpr: tex(),
      uSize: iv2(), uHalf: iv2(), uHalfAlloc: v2(), uSmall: { value: DOF_SMALL_PX }, uLift: { value: 0 }, uDebug: { value: 0 },
      uMaxR: { value: 64 }, uPageR: { value: 0 },
    });
    // the sprite quad: corners (±1, ±1), two triangles, instanced per quarter cell
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    g.instanceCount = 0;
    this.spriteGeo = g;
    this.spriteMesh = new THREE.Mesh(g, this.mSprite);
    this.spriteMesh.frustumCulled = false;
  }

  /** The output texture of the last `render` (the card target's format). */
  get texture(): THREE.Texture | null { return this.out ? this.out.texture : null; }
  get target(): THREE.WebGLRenderTarget | null { return this.out; }

  /** (Re)allocates every target for a card target of w × h texels. */
  allocate(w: number, h: number): void {
    if (w === this.allocW && h === this.allocH && this.out) return;
    this.disposeTargets();
    this.allocW = w; this.allocH = h;
    this.halfW = Math.ceil(w / 2); this.halfH = Math.ceil(h / 2);
    this.tilesW = Math.ceil(w / DOF_TILE); this.tilesH = Math.ceil(h / DOF_TILE);
    this.cocF = rt(w, h, { format: THREE.RedFormat });
    this.tiles = rt(this.tilesW, this.tilesH, { format: THREE.RGFormat });
    this.dil = rt(this.tilesW, this.tilesH, { format: THREE.RGFormat });
    this.prep = rt(this.halfW, this.halfH, { count: 2, linear: true });   // the CoC is read bilinearly by the gather
    const cocH = this.prep.textures[1];                     // (CoC·coverage, coverage) with mips (dof_common cocOf)
    cocH.format = THREE.RGFormat;
    cocH.generateMipmaps = true;
    cocH.minFilter = THREE.LinearMipmapLinearFilter;
    this.ext = rt(this.halfW, this.halfH, { count: 2 });
    const gin = this.ext.textures[0];
    gin.generateMipmaps = true;
    gin.minFilter = THREE.LinearMipmapLinearFilter;
    gin.magFilter = THREE.LinearFilter;
    this.ext.textures[1].generateMipmaps = false;
    this.gath = rt(this.halfW, this.halfH, { count: 2, linear: true });
    this.spr = rt(this.halfW, this.halfH, { linear: true });
    this.out = rt(w, h, { linear: true });
    this.out.texture.name = "dofRT";
    const names = ["dofCoc", "dofTiles", "dofDil"];
    [this.cocF, this.tiles, this.dil].forEach((t, i) => { t.texture.name = names[i]; });
  }

  /** Allocated bytes [MB, 10⁶] for the current allocation. */
  get memoryMB(): number { return this.out ? (this.allocW * this.allocH * dofBytesPerPixel()) / 1e6 : 0; }

  private updateShape(f: DofFrame, n: number): void {
    const key = `${f.blades}|${f.bladeCurve}|${f.bladeAngleDeg}|${n}`;
    if (key === this.shapeKey) return;
    this.shapeKey = key;
    const s = { blades: f.blades, curvature: f.bladeCurve, angleDeg: f.bladeAngleDeg };
    const k = bladeConstants(s), u = this.shape;
    u.uBladeN.value = k.round ? 0 : k.n;
    u.uBladeStraight.value = k.straight ? 1 : 0;
    u.uBladeC.value = k.c;
    u.uBladeDc.value = Number.isFinite(k.dc) ? k.dc : 0;
    u.uBladeQ.value = Number.isFinite(k.q) ? k.q : 1;
    u.uBladeNormal0.value = k.normal0;
    const pat = aperturePattern(s, n);
    u.uAreaRatio.value = pat.areaRatio;
    const pv = this.mGather.uniforms.uPat.value as THREE.Vector4[];
    for (let i = 0; i < PATTERN_MAX; i++) {
      if (i < n) pv[i].set(pat.pts[4 * i], pat.pts[4 * i + 1], pat.pts[4 * i + 2], pat.pts[4 * i + 3]);
      else pv[i].set(0, 0, 2, 0);
    }
    const table = clipAreaTable(s, 32);
    const cv = u.uClip.value as THREE.Vector4[];
    for (let i = 0; i < 8; i++) cv[i].set(table[4 * i], table[4 * i + 1], table[4 * i + 2], table[4 * i + 3]);
  }

  /**
   * Runs the passes on the resolved card target (`hdr`, active region vw × vh, its depth texture attached) and returns
   * the output texture (same format, same active region). `tier` gives the clamp, samples and sprite threshold.
   */
  render(r: THREE.WebGLRenderer, hdr: THREE.WebGLRenderTarget, vw: number, vh: number, f: DofFrame, tier: TierDof): THREE.Texture {
    if (!this.out || !this.cocF || !this.tiles || !this.dil || !this.prep || !this.ext || !this.gath || !this.spr) {
      throw new Error("Dof.render before allocate");
    }
    const depth = hdr.depthTexture;
    const n = Math.min(Math.max(Math.round(tier.samples), 4), PATTERN_MAX);
    this.updateShape(f, n);
    const hw = Math.ceil(vw / 2), hh = Math.ceil(vh / 2), tw = Math.ceil(vw / DOF_TILE), th = Math.ceil(vh / DOF_TILE);
    const maxR = Math.max(tier.maxRadiusPx, 1);

    // optics → uniforms (CoC radius in device px of the active viewport: the 24 mm sensor spans vh)
    const K = cocRadiusFactorPx(f.zfM, f.fMm, f.fNumber, vh);
    const cocInf = Math.min(K, maxR);
    const locaPx = mmToPx(locaShiftMm(f.loca, f.zfM, f.fMm, f.fNumber), vh) / 2;
    const u = this.shape;
    this.info = { cocKPx: K, cocInfPx: cocInf, locaPx, maxRadiusPx: maxR, samples: n, spriteThreshold: tier.spriteThreshold, heightPx: vh };

    // 1. CoC (full)
    this.setCats(f, vw / 2, vh / 2, vh / 2);
    const mc = this.mCoc.uniforms;
    mc.tDepth.value = depth;
    (mc.uSize.value as THREE.Vector2).set(vw, vh);
    mc.uNear.value = f.near; mc.uFar.value = f.far; mc.uZf.value = f.zfM; mc.uCocK.value = K; mc.uMaxR.value = maxR;
    this.pass(r, this.cocF, this.mCoc, vw, vh);

    if (f.debug) {
      const m = this.mComp.uniforms;
      m.uDebug.value = 1; m.tHdr.value = hdr.texture; m.tCocF.value = this.cocF.texture; m.uMaxR.value = maxR; m.uPageR.value = cocInf;
      this.pass(r, this.out, this.mComp, vw, vh);
      return this.out.texture;
    }

    // 2–3. tiles and dilation
    (this.mTile.uniforms.tCoc as THREE.IUniform).value = this.cocF.texture;
    (this.mTile.uniforms.uSize.value as THREE.Vector2).set(vw, vh);
    this.pass(r, this.tiles, this.mTile, tw, th);
    const md = this.mDilate.uniforms;
    md.tTile.value = this.tiles.texture;
    (md.uTiles.value as THREE.Vector2).set(tw, th);
    md.uReach.value = Math.min(Math.ceil(maxR / DOF_TILE), 8);
    this.pass(r, this.dil, this.mDilate, tw, th);

    // half-resolution passes use the half-pixel optics
    this.setCats(f, hw / 2, hh / 2, hh / 2);
    u.uLocaPx.value = locaPx / 2;
    (u.uLocaFade.value as THREE.Vector2).set(0.25, 1);

    // 4. prepare
    const mp = this.mPrep.uniforms;
    mp.tHdr.value = hdr.texture; mp.tCoc.value = this.cocF.texture;
    (mp.uSize.value as THREE.Vector2).set(vw, vh);
    (mp.uHalf.value as THREE.Vector2).set(hw, hh);
    u.uPageH.value = cocInf / 2;
    this.pass(r, this.prep, this.mPrep, hw, hh);

    // 5. extract (whole allocation: the gather's mip chain must see zeros, not stale texels, outside the active area)
    const me = this.mExt.uniforms;
    me.tCol.value = this.prep.textures[0]; me.tCoc.value = this.prep.textures[1];
    (me.uHalf.value as THREE.Vector2).set(hw, hh);
    me.uThresh.value = Dof.debugFlags & 2 ? 1e30 : tier.spriteThreshold / Math.max(f.exposure, 1e-6);
    this.pass(r, this.ext, this.mExt, this.halfW, this.halfH);

    // 6. gather
    const mg = this.mGather.uniforms;
    mg.tCol.value = this.ext.textures[0]; mg.tCoc.value = this.prep.textures[1]; mg.tTile.value = this.dil.texture;
    (mg.uHalf.value as THREE.Vector2).set(hw, hh);
    (mg.uHalfAlloc.value as THREE.Vector2).set(this.halfW, this.halfH);
    mg.uN.value = n;
    mg.uMaxLod.value = Math.min(MAX_LOD, Math.floor(Math.log2(Math.max(this.halfW, this.halfH))));
    mg.uRimFar.value = f.rim; mg.uRimNear.value = -f.rim;
    this.pass(r, this.gath, this.mGather, hw, hh);

    // 7. sprites
    const ms = this.mSprite.uniforms;
    ms.tHi.value = this.ext.textures[1]; ms.tCoc.value = this.prep.textures[1]; ms.tNear.value = this.gath.textures[0];
    (ms.uHalf.value as THREE.Vector2).set(hw, hh);
    const cellsX = Math.ceil(hw / 2), cellsY = Math.ceil(hh / 2);
    ms.uCellsX.value = cellsX;
    ms.uRimFar.value = f.rim; ms.uRimNear.value = -f.rim;
    this.spriteGeo.instanceCount = cellsX * cellsY;
    this.spr.viewport.set(0, 0, hw, hh);
    this.spr.scissorTest = false;
    r.setRenderTarget(this.spr);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    if (!(Dof.debugFlags & 1)) r.render(this.spriteMesh, this.spriteCam);

    // 8. composite (full)
    this.setCats(f, vw / 2, vh / 2, vh / 2);
    const m = this.mComp.uniforms;
    m.uDebug.value = 0;
    m.tHdr.value = hdr.texture; m.tCocF.value = this.cocF.texture; m.tTile.value = this.dil.texture;
    m.tNear.value = this.gath.textures[0]; m.tFar.value = this.gath.textures[1]; m.tCocH.value = this.prep.textures[1];
    m.tSpr.value = this.spr.texture;
    (m.uSize.value as THREE.Vector2).set(vw, vh);
    (m.uHalf.value as THREE.Vector2).set(hw, hh);
    (m.uHalfAlloc.value as THREE.Vector2).set(this.halfW, this.halfH);
    m.uLift.value = f.blackPage ? f.exposure / 0.5 : 0;
    m.uMaxR.value = maxR; m.uPageR.value = cocInf;
    this.pass(r, this.out, this.mComp, vw, vh);
    return this.out.texture;
  }

  /** Cat's-eye uniforms for a pass whose optical centre is (cx, cy) and whose half height is `halfH` [px]. */
  private setCats(f: DofFrame, cx: number, cy: number, halfH: number): void {
    const u = this.shape;
    (u.uCatsCentre.value as THREE.Vector2).set(cx, cy);
    const aspect = cx / Math.max(cy, 1e-6);
    // |b| = catsEye·0.6·(field radius / corner radius); the corner radius in px = halfH·hypot(aspect, 1)
    u.uCatsScale.value = (Math.max(f.catsEye, 0) * CATS_EYE_MAX) / (halfH * Math.hypot(aspect, 1));
  }

  private pass(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, m: THREE.ShaderMaterial, w: number, h: number): void {
    target.viewport.set(0, 0, w, h);
    target.scissorTest = false;
    r.setRenderTarget(target);
    this.quad.material = m;
    this.quad.render(r);
  }

  /** R12 (__holo.perf): the passes `render` runs for an active viewport of vw × vh (device px) with `samples` gather
   *  samples, in order, with their sizes (the sprites: one instanced quad per 2 × 2 half-resolution texels). */
  plan(vw: number, vh: number, samples: number): { pass: string; w: number; h: number; note?: string }[] {
    const hw = Math.ceil(vw / 2), hh = Math.ceil(vh / 2), tw = Math.ceil(vw / DOF_TILE), th = Math.ceil(vh / DOF_TILE);
    const n = Math.min(Math.max(Math.round(samples), 4), PATTERN_MAX);
    return [
      { pass: "dof coc", w: vw, h: vh }, { pass: "dof tiles", w: tw, h: th }, { pass: "dof dilate", w: tw, h: th },
      { pass: "dof prepare", w: hw, h: hh }, { pass: "dof extract", w: this.halfW, h: this.halfH, note: "+ mips" },
      { pass: "dof gather", w: hw, h: hh, note: `${n} samples × near and far` },
      { pass: "dof sprites", w: hw, h: hh, note: `${Math.ceil(hw / 2) * Math.ceil(hh / 2)} instanced quads` },
      { pass: "dof composite", w: vw, h: vh },
    ];
  }

  /** The pass materials (main.ts compiles them ahead of the first use: R11 prewarm). */
  get materials(): THREE.ShaderMaterial[] {
    return [this.mCoc, this.mTile, this.mDilate, this.mPrep, this.mExt, this.mGather, this.mSprite, this.mComp];
  }

  /** R11: DoF turned off — the targets are freed; the materials (so their compiled programs) and the aperture shape are
   *  kept for the next time it is turned on (the texture uniforms are cleared as a new instance has them; every other
   *  uniform is written by each render), so turning it on again links no program. */
  release(): void {
    this.disposeTargets();
    for (const m of this.materials) for (const u of Object.values(m.uniforms)) if (u.value instanceof THREE.Texture) u.value = null;
    this.info = null;
  }

  private disposeTargets(): void {
    for (const t of [this.cocF, this.tiles, this.dil, this.prep, this.ext, this.gath, this.spr, this.out]) t?.dispose();
    this.cocF = this.tiles = this.dil = this.prep = this.ext = this.gath = this.spr = this.out = null;
    this.allocW = this.allocH = 0;
  }

  dispose(): void {
    this.disposeTargets();
    for (const m of [this.mCoc, this.mTile, this.mDilate, this.mPrep, this.mExt, this.mGather, this.mSprite, this.mComp]) m.dispose();
    this.spriteGeo.dispose();
    this.quad.dispose();
  }
}
