// Energy-conserving glare (spec §5.5 item 2; R04 §3.4, Jimenez 2014 / LearnOpenGL "physically based bloom"):
// no threshold, no Karis average; level 0 at ½ (low tier ¼) resolution decodes the card target per texel, levels
// 1…n−1 repeat the 13-tap downsample, then the progressive 3 × 3 tent upsample adds k_i·tent(level_i) into level_(i−1)
// in place (k_i = w_i/w_(i−1)), so the output pass reads G = w_0·level_0 = Σ_i w_i·level_i with Σ w_i = 1.
// Every level is allocated for the full HDR target (tier cap) and rendered into its active sub-viewport (§5.5).
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { LIB } from "../shaders/lib/index.ts";
import fullscreenVert from "../shaders/fullscreen.vert?raw";
import downFrag from "../shaders/glare_down.frag?raw";
import upFrag from "../shaders/glare_up.frag?raw";

const TRIP_UNIFORMS = () => ({
  uMaxOrder: { value: 0 }, uGhB: { value: 0 }, uVorR: { value: 0 }, uFlakeR: { value: 0 },
  uBCells: { value: 0 }, uBBins: { value: 0 }, uBLevels: { value: 0 },
});

/** w_i ∝ exp(−σ_i/r): σ_i = size of a level-i texel in CSS px (div·2^i/DPR), r = `glare radius (px)` in CSS px, so the
 *  halo keeps its on-screen size at any DPR. Σ w_i = 1. At DPR 1 and div 2 with r = 8: 0.41 / 0.32 / 0.19 / 0.07 / 0.01. */
export function glareWeights(levels: number, startDiv: number, radiusCssPx: number, dpr: number): number[] {
  const r = Math.max(radiusCssPx, 1e-3), w: number[] = [];
  for (let i = 0; i < levels; i++) w.push(Math.exp(-(startDiv * Math.pow(2, i)) / Math.max(dpr, 1e-3) / r));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

interface Level { rt: THREE.WebGLRenderTarget; A: THREE.Vector2; a: THREE.Vector2 }   // allocated, active size

export class Glare {
  private levels: Level[] = [];
  private readonly down0: THREE.ShaderMaterial;
  private readonly downN: THREE.ShaderMaterial;
  private readonly up: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private srcW = 1; private srcH = 1;
  readonly count: number;
  readonly startDiv: 2 | 4;

  constructor(levels: number, startDiv: 2 | 4) {
    this.count = Math.max(1, Math.round(levels));
    this.startDiv = startDiv;
    const common = { depthTest: false, depthWrite: false, toneMapped: false } as const;
    const downUniforms = () => ({
      tSrc: { value: null as THREE.Texture | null }, uSrcTexel: { value: new THREE.Vector2(1, 1) },
      uSrcSize: { value: new THREE.Vector2(1, 1) }, uSrcMin: { value: new THREE.Vector2() }, uSrcMax: { value: new THREE.Vector2() },
      ...TRIP_UNIFORMS(),
    });
    this.down0 = new THREE.ShaderMaterial({
      ...common, name: "GlareDown0", blending: THREE.NoBlending, defines: { GLARE_MODE: startDiv === 4 ? 1 : 0 },
      vertexShader: fullscreenVert, fragmentShader: `${LIB.common}\n${downFrag}`, uniforms: downUniforms(),
    });
    this.downN = new THREE.ShaderMaterial({
      ...common, name: "GlareDown", blending: THREE.NoBlending, defines: { GLARE_MODE: 2 },
      vertexShader: fullscreenVert, fragmentShader: `${LIB.common}\n${downFrag}`, uniforms: downUniforms(),
    });
    this.up = new THREE.ShaderMaterial({
      ...common, name: "GlareUp",
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      vertexShader: fullscreenVert, fragmentShader: upFrag,
      uniforms: {
        tSrc: { value: null as THREE.Texture | null }, uSrcTexel: { value: new THREE.Vector2(1, 1) },
        uSrcMin: { value: new THREE.Vector2() }, uSrcMax: { value: new THREE.Vector2() }, uK: { value: 1 },
      },
    });
  }

  /** (Re)allocates the levels for an HDR target of srcW × srcH texels. */
  allocate(srcW: number, srcH: number): void {
    this.disposeTargets();
    this.srcW = srcW; this.srcH = srcH;
    let w = Math.max(1, Math.ceil(srcW / this.startDiv)), h = Math.max(1, Math.ceil(srcH / this.startDiv));
    for (let i = 0; i < this.count; i++) {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      rt.texture.name = `glare${i}`;
      this.levels.push({ rt, A: new THREE.Vector2(w, h), a: new THREE.Vector2(w, h) });
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
    }
  }

  /** R12 (__holo.perf): the passes `render` runs for an active region of vw × vh texels — the downsample chain, then the
   *  upsample back to level 0 — with their sizes. */
  plan(vw: number, vh: number): { pass: string; w: number; h: number }[] {
    const sizes: [number, number][] = [];
    let aw = Math.max(1, Math.ceil(vw / this.startDiv)), ah = Math.max(1, Math.ceil(vh / this.startDiv));
    for (let i = 0; i < this.count; i++) { sizes.push([aw, ah]); aw = Math.max(1, Math.ceil(aw / 2)); ah = Math.max(1, Math.ceil(ah / 2)); }
    const out = sizes.map(([w, h], i) => ({ pass: `glare down ${i}`, w, h }));
    for (let i = sizes.length - 1; i >= 1; i--) out.push({ pass: `glare up ${i - 1}`, w: sizes[i - 1][0], h: sizes[i - 1][1] });
    return out;
  }

  /** Level 0 after `render`: G/w_0 (premultiplied scene-linear glare), read by the output pass. */
  get level0(): THREE.Texture | null { return this.levels.length ? this.levels[0].rt.texture : null; }

  /** vUv → level-0 uv scale and the largest active level-0 uv, for an active card region of vw × vh texels. */
  outputMapping(vw: number, vh: number, scale: THREE.Vector2, max: THREE.Vector2): void {
    if (!this.levels.length) { scale.set(1, 1); max.set(1, 1); return; }
    const L = this.levels[0];
    scale.set(vw / this.startDiv / L.A.x, vh / this.startDiv / L.A.y);
    max.set((L.a.x - 0.5) / L.A.x, (L.a.y - 0.5) / L.A.y);
  }

  /** Runs the chain on the resolved card target (`src`, active region vw × vh) and leaves G/w_0 in level 0.
   *  Returns w_0. */
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, vw: number, vh: number, radiusCssPx: number, dpr: number): number {
    const n = this.levels.length;
    if (!n) return 0;
    const w = glareWeights(n, this.startDiv, radiusCssPx, dpr);
    // active sizes
    let aw = Math.max(1, Math.ceil(vw / this.startDiv)), ah = Math.max(1, Math.ceil(vh / this.startDiv));
    for (const L of this.levels) {
      L.a.set(Math.min(aw, L.A.x), Math.min(ah, L.A.y));
      aw = Math.max(1, Math.ceil(aw / 2)); ah = Math.max(1, Math.ceil(ah / 2));
    }
    // downsample chain
    for (let i = 0; i < n; i++) {
      const L = this.levels[i];
      const m = i === 0 ? this.down0 : this.downN;
      const u = m.uniforms;
      if (i === 0) {
        u.tSrc.value = src;
        (u.uSrcTexel.value as THREE.Vector2).set(1 / this.srcW, 1 / this.srcH);
        (u.uSrcSize.value as THREE.Vector2).set(vw, vh);
      } else {
        const S = this.levels[i - 1];
        u.tSrc.value = S.rt.texture;
        (u.uSrcTexel.value as THREE.Vector2).set(1 / S.A.x, 1 / S.A.y);
        (u.uSrcMin.value as THREE.Vector2).set(0.5 / S.A.x, 0.5 / S.A.y);
        (u.uSrcMax.value as THREE.Vector2).set((S.a.x - 0.5) / S.A.x, (S.a.y - 0.5) / S.A.y);
      }
      this.draw(renderer, L, m);
    }
    // progressive tent upsample, coarse to fine, additive and in place
    for (let i = n - 1; i >= 1; i--) {
      const S = this.levels[i], D = this.levels[i - 1], u = this.up.uniforms;
      u.tSrc.value = S.rt.texture;
      (u.uSrcTexel.value as THREE.Vector2).set(1 / S.A.x, 1 / S.A.y);
      (u.uSrcMin.value as THREE.Vector2).set(0.5 / S.A.x, 0.5 / S.A.y);
      (u.uSrcMax.value as THREE.Vector2).set((S.a.x - 0.5) / S.A.x, (S.a.y - 0.5) / S.A.y);
      u.uK.value = w[i] / Math.max(w[i - 1], 1e-30);
      this.draw(renderer, D, this.up);
    }
    return w[0];
  }

  private draw(renderer: THREE.WebGLRenderer, L: Level, m: THREE.ShaderMaterial): void {
    L.rt.viewport.set(0, 0, L.a.x, L.a.y);
    L.rt.scissorTest = false;
    renderer.setRenderTarget(L.rt);
    this.quad.material = m;
    this.quad.render(renderer);
  }

  private disposeTargets(): void {
    for (const L of this.levels) L.rt.dispose();
    this.levels = [];
  }

  dispose(): void {
    this.disposeTargets();
    this.down0.dispose(); this.downN.dispose(); this.up.dispose();
  }
}
