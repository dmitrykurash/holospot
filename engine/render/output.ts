// Output pass (spec §5.5 item 3): decode, glare mix, exposure, gamut and tone mapping, exact background composite,
// sRGB/P3 transfer, film grain (addendum A4.1) and dither, full-screen triangle into the canvas. Internal to the
// pipeline.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { Background, ToneCurve } from "../types.ts";
import { LIB } from "../shaders/lib/index.ts";
import fullscreenVert from "../shaders/fullscreen.vert?raw";
import outputFrag from "../shaders/output.frag?raw";
import { grainUniforms } from "./grain.ts";
import type { GrainOptions } from "./grain.ts";

export const TONE_INDEX: Readonly<Record<ToneCurve, number>> = { neutral: 0, agx: 1, clamp: 2 };

export interface OutputInputs {
  hdr: THREE.Texture; hdrScale: THREE.Vector2; hdrMax: THREE.Vector2;          // card target, vUv → uv, last active uv
  glare: THREE.Texture | null; gw0: number; g0Scale: THREE.Vector2; g0Max: THREE.Vector2;
  exposure: number; tone: ToneCurve; p3: boolean; background: Background; glareAmount: number; raw: boolean;
  /** The page colour, linear sRGB (black, white or the chosen colour). */
  backgroundRgb: readonly [number, number, number];
  /** A4.1 film grain (null = off), the canvas DPR (CSS px → device px) and the frame time (animated seed). */
  grain: GrainOptions | null; dpr: number; timeS: number;
}

export class OutputPass {
  readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly black: THREE.DataTexture;

  constructor() {
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.black.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      name: "HoloOutput",
      vertexShader: fullscreenVert,
      fragmentShader: `${LIB.common}\n${outputFrag}`,
      uniforms: {
        tHdr: { value: null }, tG0: { value: this.black }, uGW0: { value: 0 },
        uViewScale: { value: new THREE.Vector2(1, 1) }, uHdrMax: { value: new THREE.Vector2(1, 1) },
        uG0Scale: { value: new THREE.Vector2(1, 1) }, uG0Max: { value: new THREE.Vector2(1, 1) },
        uGlare: { value: 0 }, uExposure: { value: 1 }, uTone: { value: 0 }, uP3: { value: 0 }, uRaw: { value: 0 },
        uBg: { value: new THREE.Vector3(0, 0, 0) },
        // A4.1 film grain: amount (0 = off), cell [device px], seed, per-channel, over the background
        uGrain: { value: 0 }, uGrainCell: { value: 1 }, uGrainSeed: { value: 0 }, uGrainRgb: { value: 0 }, uGrainBg: { value: 0 },
        // common.glsl trip-count uniforms are declared but unused here; keep them bound to valid values
        uMaxOrder: { value: 0 }, uGhB: { value: 0 }, uVorR: { value: 0 }, uFlakeR: { value: 0 },
        uBCells: { value: 0 }, uBBins: { value: 0 }, uBLevels: { value: 0 },
      },
      depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Renders into the currently bound target (the canvas). */
  render(renderer: THREE.WebGLRenderer, o: OutputInputs): void {
    const u = this.material.uniforms;
    u.tHdr.value = o.hdr;
    (u.uViewScale.value as THREE.Vector2).copy(o.hdrScale);
    (u.uHdrMax.value as THREE.Vector2).copy(o.hdrMax);
    const useGlare = o.glare !== null && o.glareAmount > 0 && !o.raw;
    u.tG0.value = useGlare ? o.glare : this.black;
    u.uGW0.value = useGlare ? o.gw0 : 0;
    u.uGlare.value = useGlare ? o.glareAmount : 0;
    (u.uG0Scale.value as THREE.Vector2).copy(o.g0Scale);
    (u.uG0Max.value as THREE.Vector2).copy(o.g0Max);
    u.uExposure.value = o.exposure;
    u.uTone.value = TONE_INDEX[o.tone] ?? 0;
    u.uP3.value = o.p3 ? 1 : 0;
    u.uRaw.value = o.raw ? 1 : 0;
    const bg = o.backgroundRgb;
    (u.uBg.value as THREE.Vector3).set(bg[0], bg[1], bg[2]);
    const g = grainUniforms(o.grain, o.dpr, o.timeS, o.raw);
    u.uGrain.value = g.amount;
    u.uGrainCell.value = g.cellPx;
    u.uGrainSeed.value = g.seed;
    u.uGrainRgb.value = g.rgb;
    u.uGrainBg.value = g.onBackground;
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.black.dispose();
  }
}
