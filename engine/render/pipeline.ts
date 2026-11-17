// The render pipeline (spec §5.5, §6.4): card pass → MSAA HalfFloat target with a depth buffer → glare → output to the
// canvas. No EffectComposer (its targets have no MSAA) and no setEffects (tone mapping we do not want), R04 §3.1.
// Addendum A4.1: the output pass also adds the film grain (OutputOptions.grain, render/grain.ts) in display space.
// Depth (addendum A1.1 item 2): the non-convex objects (bent card, sheets, can, torus) occlude themselves, so the HDR
// target has a multisampled 24-bit depth buffer, cleared with the colour every frame; it is never resolved nor kept
// after the pass (resolveDepthBuffer / storeMultisampledDepthBuffer false), and it is counted in `gpuMB`.
// Addendum A7 (depth of field, render/dof.ts): while OutputOptions.dof is set, the target is allocated with a
// DepthTexture on its resolve framebuffer and `resolveDepthBuffer`, three's MSAA resolve blits depth into it, and the
// DoF stage runs between the card pass and the glare: card pass → DoF → glare → output, the DoF output (same format)
// replacing the card target for the glare, the output pass and `readHdrNow`. Without it nothing of the DoF exists:
// the target is allocated exactly as before (bit-identical output), the DoF instance and its targets are disposed.
//
// Sizes. The HDR target and the glare levels are allocated at CSS size × the tier's DPR cap, reduced until w·h ≤ the
// tier's pixel cap, and reallocated only by `resize` or a tier change. The current DPR (`setDpr`, adaptive) sizes the
// canvas drawing buffer, floor(css·dpr), and the card pass renders into the matching sub-viewport at the target's
// origin, so canvas pixels and target texels correspond 1:1 and adaptation never reallocates (§1.5).
import * as THREE from "three";
import { DataUtils } from "three";
import {
  DisplayP3ColorSpace, DisplayP3ColorSpaceImpl, LinearDisplayP3ColorSpace, LinearDisplayP3ColorSpaceImpl,
} from "three/addons/math/ColorSpaces.js";
import WebGL from "three/addons/capabilities/WebGL.js";
import type { Background, TierConfig, ToneCurve, Vec2 } from "../types.ts";
import { Glare } from "./glare.ts";
import { Dof } from "./dof.ts";
import type { DofFrame, DofInfo } from "./dof.ts";
import type { GrainOptions } from "./grain.ts";
import { OutputPass } from "./output.ts";
import { allocationSize, gpuMemoryMB } from "./tier.ts";

export type { GrainOptions } from "./grain.ts";
export type { DofFrame, DofInfo } from "./dof.ts";

export interface OutputOptions {
  exposure: number;          // linear scene multiplier 2^EV_eff (the §5.2 background adaptation already applied)
  tone: ToneCurve;
  p3: boolean;               // the `display p3` toggle; honoured only where the display and the browser support it
  background: Background;
  /** The page colour, linear sRGB (black, white or the chosen colour); defaults from `background`. */
  backgroundRgb?: readonly [number, number, number];
  glare: number;             // glare mix amount (0–0.1)
  glareRadiusPx: number;     // CSS px
  raw: boolean;              // raw debug views (§4.14): the output pass bypasses everything
  /** Film grain (addendum A4.1), null = off (bit-identical output). */
  grain?: GrainOptions | null;
  /** Frame time [s] (frozen runs: the URL `t`): seeds the animated grain. */
  timeS?: number;
  /** false: this frame is not timed (`cardMs` keeps the last timed frame's value). The runtime adaptation times only
   *  the frames drawn in motion at the adapted resolution, not the full-resolution frame of a picture at rest. */
  timed?: boolean;
  /** true: only the output pass runs, on the card, depth-of-field and glare targets of the last full frame (they are
   *  kept between frames). For a frame whose only change is the animated grain's seed: the picture under the grain is
   *  bit-identical to a full render, at the cost of one full-screen pass. Falls back to a full render when the
   *  targets were reallocated since. */
  reuse?: boolean;
  /** Addendum A7 depth of field of this frame, null = off (nothing allocated, bit-identical output). Ignored by raw
   *  debug views (they bypass DoF) and on the LDR fallback. */
  dof?: DofFrame | null;
}

export interface PipelineOptions {
  /** Upper bound for the allocation DPR (e.g. a fixed `dpr=` URL value without adaptation); default the tier cap. */
  maxDpr?: number;
  /** Capabilities from createRenderer (avoids re-probing P3 support). */
  p3Available?: boolean;
  /** Testing: take the LDR fallback path (UnsignedByte target, no glare) even where EXT_color_buffer_float exists. */
  forceLdr?: boolean;
}

const ENC_S = 0.25;
let p3Defined = false;

class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pool: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  ms: number | null = null;

  constructor(gl: WebGL2RenderingContext, enabled: boolean) {
    this.gl = gl;
    this.ext = enabled ? (gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null) : null;
  }
  begin(): void {
    if (!this.ext || this.active || this.pending.length > 6) return;
    const q = this.pool.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint) this.ms = ns / 1e6;
      this.pending.shift();
      this.pool.push(q);
    }
  }
  dispose(): void {
    for (const q of [...this.pool, ...this.pending]) this.gl.deleteQuery(q);
    if (this.active) this.gl.deleteQuery(this.active);
    this.pool = []; this.pending = []; this.active = null;
  }
}

export class Pipeline {
  private readonly r: THREE.WebGLRenderer;
  private readonly gl: WebGL2RenderingContext;
  private tier: TierConfig;
  private readonly opts: PipelineOptions;
  private readonly hdrCapable: boolean;
  private readonly maxSamples: number;
  private hdrRT: THREE.WebGLRenderTarget | null = null;
  private glare: Glare;
  private readonly output = new OutputPass();
  private readonly timer: GpuTimer;
  private readonly postTimer: GpuTimer;            // the passes after the card pass (depth of field, glare, output)
  private cssW = 0; private cssH = 0;
  private allocW = 1; private allocH = 1; private allocDpr = 1;
  private requestedDpr: number;
  private effDpr = 1;
  private vw = 1; private vh = 1;                  // active sub-viewport = canvas drawing buffer size
  private samples = 0;
  private memMB = 0;
  private lastRaw = false;
  private lastGlare = false;                       // the last full frame ran the glare chain (its level 0 is current)
  private lastW0 = 0;                              // … and its weight w_0
  private p3Active = false;
  private p3Avail: boolean | null;
  private dof: Dof | null = null;                  // A7: exists only while DoF is on
  private dofAlloc = false;                        // the card target carries a depth texture
  private lastRT: THREE.WebGLRenderTarget | null = null;   // the target the output pass read (readHdrNow)
  private readonly hdrScale = new THREE.Vector2(1, 1);
  private readonly hdrMax = new THREE.Vector2(1, 1);
  private readonly g0Scale = new THREE.Vector2(1, 1);
  private readonly g0Max = new THREE.Vector2(1, 1);

  constructor(r: THREE.WebGLRenderer, t: TierConfig, opts: PipelineOptions = {}) {
    this.r = r;
    this.gl = r.getContext() as WebGL2RenderingContext;
    this.tier = t;
    this.opts = opts;
    this.p3Avail = opts.p3Available ?? null;
    r.autoClear = false;
    r.toneMapping = THREE.NoToneMapping;
    this.hdrCapable = r.extensions.has("EXT_color_buffer_float") && !opts.forceLdr;
    let ms = 0;
    try {
      const fmt = this.hdrCapable ? this.gl.RGBA16F : this.gl.RGBA8;
      const s = this.gl.getInternalformatParameter(this.gl.RENDERBUFFER, fmt, this.gl.SAMPLES) as Int32Array | null;
      if (s && s.length) ms = Math.max(...Array.from(s));
    } catch { ms = 0; }
    this.maxSamples = ms;
    this.glare = new Glare(t.glareLevels, t.glareStartDiv);
    this.timer = new GpuTimer(this.gl, r.extensions.has("EXT_disjoint_timer_query_webgl2"));
    this.postTimer = new GpuTimer(this.gl, r.extensions.has("EXT_disjoint_timer_query_webgl2"));
    this.requestedDpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  }

  // ---- public read-outs (§6.4, §6.8)
  get dpr(): number { return this.effDpr; }
  get msaa(): number { return this.samples; }
  get rtPixels(): number { return this.allocW * this.allocH; }
  get gpuMB(): number { return this.memMB; }
  get cardMs(): number | null { return this.timer.ms; }
  /** GPU time of the passes after the card pass (depth of field, glare, output) [ms], or null without a GPU timer. */
  get postMs(): number | null { return this.postTimer.ms; }
  /** True for the HalfFloat HDR path; false for the LDR fallback (materials then store encodeCard of the gamut-mapped
   *  colour, §5.5). */
  get hdr(): boolean { return this.hdrCapable; }
  /** Whether the last frame was output in Display P3. */
  get p3(): boolean { return this.p3Active; }
  /** Sub-viewport scale (active / allocated), the `uViewScale` of FrameInputs. */
  get viewScale(): Vec2 { return { x: this.hdrScale.x, y: this.hdrScale.y }; }
  /** Active drawing-buffer size in device pixels. */
  get viewport(): { width: number; height: number } { return { width: this.vw, height: this.vh }; }
  get tierConfig(): TierConfig { return this.tier; }
  /** A7: whether the last frame ran the depth of field, and its read-out. */
  get dofActive(): boolean { return this.dofAlloc && this.dof !== null; }
  get dofInfo(): DofInfo | null { return this.dofActive && this.dof ? this.dof.info : null; }

  /** Tier change: new glare chain and targets (reallocation is expected here, §5.5). */
  setTier(t: TierConfig): void {
    if (t === this.tier) return;
    this.tier = t;
    this.glare.dispose();
    this.glare = new Glare(t.glareLevels, t.glareStartDiv);
    if (this.cssW > 0) this.allocate();
  }

  resize(cssW: number, cssH: number): void {
    const w = Math.max(1, Math.round(cssW)), h = Math.max(1, Math.round(cssH));
    if (w === this.cssW && h === this.cssH && this.hdrRT) return;
    this.cssW = w; this.cssH = h;
    this.allocate();
  }

  setDpr(dpr: number): void {
    if (Number.isFinite(dpr) && dpr > 0) this.requestedDpr = dpr;
    if (this.cssW > 0) this.applyDpr();
  }

  private allocate(): void {
    const t = this.tier;
    const a = allocationSize(t, this.cssW, this.cssH, this.opts.maxDpr ?? t.dprCap);
    this.allocW = a.w; this.allocH = a.h; this.allocDpr = a.dpr;
    // MSAA: the tier's count, capped by what an RGBA16F renderbuffer supports (not MAX_SAMPLES), and dropped when the
    // §5.5 total would exceed the tier budget (low tier rule).
    const bpt = this.hdrCapable ? 8 : 4;
    let samples = t.msaa > 0 ? Math.min(t.msaa, this.maxSamples) : 0;
    if (samples === 1) samples = 0;
    if (samples > 0 && gpuMemoryMB(t, a.w * a.h, samples, this.hdrCapable, bpt) > t.msaaMaxMB) samples = 0;
    this.samples = samples;
    this.memMB = gpuMemoryMB(t, a.w * a.h, samples, this.hdrCapable, bpt);

    this.hdrRT?.dispose();
    this.hdrRT?.depthTexture?.dispose();
    this.lastRT = null;
    this.hdrRT = new THREE.WebGLRenderTarget(a.w, a.h, {
      type: this.hdrCapable ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat, samples,
      depthBuffer: true, stencilBuffer: false, resolveDepthBuffer: false, storeMultisampledDepthBuffer: false,
      generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      // A7: the resolve framebuffer's depth becomes a sampleable texture (same DEPTH_COMPONENT24, same bytes)
      ...(this.dofAlloc ? { depthTexture: new THREE.DepthTexture(a.w, a.h) } : {}),
    });
    if (this.dofAlloc && this.dof) {
      this.dof.allocate(a.w, a.h);
      this.memMB += this.dof.memoryMB;
    }
    this.hdrRT.texture.name = "hdrRT";
    // LDR fallback: keep the compressed value in an sRGB8 target (hardware encode on write, decode on read), which
    // has ~6× finer steps than linear RGBA8 in the darks where 8-bit banding shows (c = 0.05: 6 % instead of 31 %).
    if (!this.hdrCapable) this.hdrRT.texture.colorSpace = THREE.SRGBColorSpace;
    if (this.hdrCapable) this.glare.allocate(a.w, a.h);
    this.applyDpr();
  }

  private applyDpr(): void {
    const eff = Math.min(Math.max(this.requestedDpr, 0.25), this.allocDpr);
    const canvas = this.r.domElement;
    const size = new THREE.Vector2();
    this.r.getSize(size);
    // Reassigning canvas.width resets the drawing buffer even when the value is unchanged: only resize on a change.
    if (eff !== this.r.getPixelRatio() || size.x !== this.cssW || size.y !== this.cssH
      || canvas.width !== Math.floor(this.cssW * eff) || canvas.height !== Math.floor(this.cssH * eff)) {
      this.r.setDrawingBufferSize(this.cssW, this.cssH, eff);
    }
    this.effDpr = eff;
    this.vw = Math.min(Math.max(1, canvas.width), this.allocW);
    this.vh = Math.min(Math.max(1, canvas.height), this.allocH);
    this.hdrScale.set(this.vw / this.allocW, this.vh / this.allocH);
    this.hdrMax.set((this.vw - 0.5) / this.allocW, (this.vh - 0.5) / this.allocH);
  }

  private applyColorSpace(wantP3: boolean): void {
    let want = false;
    if (wantP3) {
      if (this.p3Avail === null) {
        try {
          this.p3Avail = typeof matchMedia === "function" && matchMedia("(color-gamut: p3)").matches
            && WebGL.isColorSpaceAvailable(DisplayP3ColorSpace);
        } catch { this.p3Avail = false; }
      }
      want = this.p3Avail;
    }
    if (want === this.p3Active) return;
    if (want && !p3Defined) {
      THREE.ColorManagement.define({
        [DisplayP3ColorSpace]: DisplayP3ColorSpaceImpl, [LinearDisplayP3ColorSpace]: LinearDisplayP3ColorSpaceImpl,
      });
      p3Defined = true;
    }
    this.r.outputColorSpace = want ? DisplayP3ColorSpace : THREE.SRGBColorSpace;
    this.p3Active = want;
  }

  /** A7: DoF on/off → the card target with or without its depth texture; the DoF instance is created on first use and
   *  kept while off with its targets freed (R11: its eight pass programs stay linked, so an entity with depth of field
   *  shows without linking them again). */
  private setDof(on: boolean): void {
    if (on === this.dofAlloc) return;
    this.dofAlloc = on;
    if (on) this.dof ??= new Dof();
    else this.dof?.release();
    if (this.cssW > 0) this.allocate();
  }

  /** R12 (__holo.perf): the render passes of a full frame at the current allocation, in order, with their sizes in
   *  device px (structural: the GPU time is the GPU timer's, where there is one). `glare`: the glare pass runs. */
  passPlan(glare: boolean): { pass: string; w: number; h: number; note?: string }[] {
    const vw = this.vw, vh = this.vh, c = this.r.domElement;
    const out: { pass: string; w: number; h: number; note?: string }[] = [
      { pass: "card", w: vw, h: vh, note: this.samples > 0 ? `MSAA ${this.samples}× (${this.allocW}×${this.allocH} allocated), resolved` : `no MSAA (${this.allocW}×${this.allocH} allocated)` },
    ];
    if (this.dofActive && this.dof) out.push(...this.dof.plan(vw, vh, this.tier.dof.samples));
    if (glare && this.hdrCapable) out.push(...this.glare.plan(vw, vh));
    out.push({ pass: "output", w: c.width, h: c.height, note: "tone map, glare composite, grain, into the canvas" });
    return out;
  }

  /** R11: the DoF pass materials, created ahead of their first use so they can be compiled in the background. */
  dofMaterials(): THREE.Material[] {
    this.dof ??= new Dof();
    return this.dof.materials;
  }

  /** Card pass into the HDR target, DoF (A7), glare, output into the canvas. */
  render(scene: THREE.Object3D, camera: THREE.Camera, o: OutputOptions): void {
    const r = this.r;
    const dofFrame = o.dof && this.hdrCapable && (!o.raw || o.dof.debug) ? o.dof : null;
    if (!this.hdrRT) this.resize(r.domElement.clientWidth || r.domElement.width, r.domElement.clientHeight || r.domElement.height);
    if (o.reuse === true && this.lastRT !== null) {            // the output pass alone, on the last full frame's targets
      this.applyColorSpace(o.p3);
      r.setRenderTarget(null);
      this.output.render(r, {
        hdr: this.lastRT.texture, hdrScale: this.hdrScale, hdrMax: this.hdrMax,
        glare: this.lastGlare ? this.glare.level0 : null, gw0: this.lastW0, g0Scale: this.g0Scale, g0Max: this.g0Max,
        exposure: o.exposure, tone: o.tone, p3: this.p3Active, background: o.background, glareAmount: this.lastGlare ? o.glare : 0,
        backgroundRgb: o.backgroundRgb ?? (o.background === "white" ? [1, 1, 1] : [0, 0, 0]),
        raw: this.lastRaw, grain: o.grain ?? null, dpr: this.effDpr, timeS: o.timeS ?? 0,
      });
      return;
    }
    this.setDof(dofFrame !== null);
    const hdrRT = this.hdrRT as THREE.WebGLRenderTarget;
    hdrRT.resolveDepthBuffer = this.dofAlloc;
    this.timer.poll();
    this.postTimer.poll();
    const timed = o.timed !== false;
    this.applyColorSpace(o.p3);

    // 1. Card pass: transparent clear (coverage composite, §5.5) and depth clear, sub-viewport, MSAA resolved by three
    //    after render().
    const sc = scene as THREE.Scene;
    const bg = sc.isScene ? sc.background : null;
    if (sc.isScene) sc.background = null;
    hdrRT.viewport.set(0, 0, this.vw, this.vh);
    hdrRT.scissor.set(0, 0, this.allocW, this.allocH);
    hdrRT.scissorTest = false;
    r.setRenderTarget(hdrRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    if (timed) this.timer.begin();
    r.render(scene, camera);
    if (timed) this.timer.end();
    if (sc.isScene) sc.background = bg;

    // 1b. Depth of field (A7): the card target (its depth resolved into the depth texture) → the DoF output, which
    //     replaces it below. The `dof` debug view writes raw values.
    let src: THREE.WebGLRenderTarget = hdrRT;
    const raw = o.raw || (dofFrame !== null && dofFrame.debug);
    if (timed) this.postTimer.begin();
    if (dofFrame && this.dof) {
      this.dof.render(r, hdrRT, this.vw, this.vh, dofFrame, this.tier.dof);
      src = this.dof.target ?? hdrRT;
    }

    // 2. Glare (HDR path only; skipped for raw views and glare 0).
    const useGlare = this.hdrCapable && !raw && o.glare > 0;
    let w0 = 0;
    if (useGlare) {
      w0 = this.glare.render(r, src.texture, this.vw, this.vh, o.glareRadiusPx, this.effDpr);
      this.glare.outputMapping(this.vw, this.vh, this.g0Scale, this.g0Max);
    }

    // 3. Output to the canvas.
    r.setRenderTarget(null);
    this.output.render(r, {
      hdr: src.texture, hdrScale: this.hdrScale, hdrMax: this.hdrMax,
      glare: useGlare ? this.glare.level0 : null, gw0: w0, g0Scale: this.g0Scale, g0Max: this.g0Max,
      exposure: o.exposure, tone: o.tone, p3: this.p3Active, background: o.background, glareAmount: useGlare ? o.glare : 0,
      backgroundRgb: o.backgroundRgb ?? (o.background === "white" ? [1, 1, 1] : [0, 0, 0]),
      raw, grain: o.grain ?? null, dpr: this.effDpr, timeS: o.timeS ?? 0,
    });
    if (timed) this.postTimer.end();
    this.lastRaw = raw;
    this.lastGlare = useGlare;
    this.lastW0 = w0;
    this.lastRT = src;
  }

  // ---- read-backs (§6.8): one readPixels over the bounding box of all points, CSS px from the canvas top-left.

  private toDevice(px: ReadonlyArray<readonly [number, number]>): { pts: [number, number][]; x0: number; y0: number; w: number; h: number } {
    const sx = this.vw / Math.max(this.cssW, 1), sy = this.vh / Math.max(this.cssH, 1);
    const pts = px.map(([x, y]) => {
      const dx = Math.min(Math.max(Math.floor(x * sx), 0), this.vw - 1);
      const dy = Math.min(Math.max(this.vh - 1 - Math.floor(y * sy), 0), this.vh - 1);
      return [dx, dy] as [number, number];
    });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (!pts.length) { x0 = y0 = 0; x1 = y1 = 0; }
    return { pts, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** RGBA bytes of the canvas at CSS px points. MUST be called in the same task right after `render` (the drawing
   *  buffer is not preserved). */
  readCanvasNow(px: ReadonlyArray<readonly [number, number]>): number[][] {
    if (!px.length) return [];
    const gl = this.gl, b = this.toDevice(px);
    this.r.setRenderTarget(null);
    const buf = new Uint8Array(b.w * b.h * 4);
    gl.readPixels(b.x0, b.y0, b.w, b.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return b.pts.map(([x, y]) => {
      const i = ((y - b.y0) * b.w + (x - b.x0)) * 4;
      return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
    });
  }

  /** Scene-linear RGBA at CSS px points from the resolved card target: un-premultiplied, decompressed (ENC_S),
   *  a = coverage. Raw debug views return the raw [0, 1] values (un-premultiplied). Call right after `render`. */
  readHdrNow(px: ReadonlyArray<readonly [number, number]>): number[][] {
    if (!px.length || !this.hdrRT) return px.map(() => [0, 0, 0, 0]);
    const gl = this.gl, b = this.toDevice(px), rt = this.lastRT ?? this.hdrRT;   // A7: the DoF output while on
    const n = b.w * b.h * 4;
    let vals: Float32Array;
    if (!this.hdrCapable) {
      const u8 = new Uint8Array(n);
      this.r.readRenderTargetPixels(rt, b.x0, b.y0, b.w, b.h, u8);
      vals = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = u8[i] / 255;                       // sRGB8 storage: decode colour, alpha is linear
        vals[i] = (i & 3) === 3 ? v : v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      }
    } else {
      // three binds the resolve framebuffer; RGBA/HALF_FLOAT is valid where it is the implementation read type,
      // otherwise read RGBA/FLOAT (always accepted for float colour buffers in WebGL 2 + EXT_color_buffer_float).
      const fb = (this.r.properties.get(rt) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer ?? null;
      this.r.state.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
      const readFmt = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
      if (readType === gl.HALF_FLOAT && readFmt === gl.RGBA) {
        const u16 = new Uint16Array(n);
        this.r.readRenderTargetPixels(rt, b.x0, b.y0, b.w, b.h, u16);
        vals = new Float32Array(n);
        for (let i = 0; i < n; i++) vals[i] = DataUtils.fromHalfFloat(u16[i]);
      } else {
        vals = new Float32Array(n);
        gl.readPixels(b.x0, b.y0, b.w, b.h, gl.RGBA, gl.FLOAT, vals);
      }
      this.r.setRenderTarget(null);
    }
    return b.pts.map(([x, y]) => {
      const i = ((y - b.y0) * b.w + (x - b.x0)) * 4;
      const a = Math.min(Math.max(vals[i + 3], 0), 1);
      if (!(a > 1e-5)) return [0, 0, 0, 0];
      const cu = [vals[i] / a, vals[i + 1] / a, vals[i + 2] / a];
      if (this.lastRaw) return [cu[0], cu[1], cu[2], a];
      const m = Math.max(cu[0], cu[1], cu[2], 0);
      const k = 1 / (ENC_S * Math.max(1 - m, 1e-4));
      return [cu[0] * k, cu[1] * k, cu[2] * k, a];
    });
  }

  dispose(): void {
    this.hdrRT?.depthTexture?.dispose();
    this.hdrRT?.dispose();
    this.hdrRT = null;
    this.dof?.dispose();
    this.dof = null;
    this.lastRT = null;
    this.glare.dispose();
    this.output.dispose();
    this.timer.dispose();
    this.postTimer.dispose();
  }
}
