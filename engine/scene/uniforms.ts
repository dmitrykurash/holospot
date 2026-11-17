// Shared uniforms (spec §6.5): one map of IUniform objects spread into every card material (`{ ...shared, ...mat }`
// keeps the object identity, so one update reaches all materials). `cameraPosition` is three's built-in uniform.
import * as THREE from "three";
import { RectAreaLightTexturesLib } from "three/addons/lights/RectAreaLightTexturesLib.js";
import type { FrameInputs, TierConfig, Uniforms } from "../types.ts";
import type { SpectralTextures } from "./spectralTextures.ts";
import type { WaveSet } from "./relief.ts";
import { applyLights, MAX_LIGHTS } from "./lights.ts";

/** Print inks of §5.7 as sRGB hex (linearised into the uniforms). */
export const INK_DEFAULTS = {
  uInkBorder: "#ece9e2", uInkText: "#1e1e1e", uInkPanel: "#f2efe8", uInkSubject: "#1f4a66",
  uInkSubjectRim: "#3f7aa0", uInkGold: "#e2b04a", uInkSpark: "#f4f1ea",
} as const;
export const BACK_COLOUR_DEFAULT = "#22304a";
export const PRINT_MODE_INDEX = { none: 0, frame: 1, window: 2, art: 3 } as const;
const NB_MAX = 8;

/** Linear-sRGB colour from a CSS colour string (sRGB EOTF; three's ColorManagement converts into the linear working
 *  space), as a THREE.Color, which is a valid vec3 uniform value. */
export function linearColor(css: string, out = new THREE.Color()): THREE.Color {
  return out.set(css);
}

const texOf = new WeakMap<Uniforms, { tex: SpectralTextures; version: number; nb: number }>();
let ltc: { LTC_HALF_1: THREE.DataTexture; LTC_HALF_2: THREE.DataTexture } | null = null;
let bumpPlaceholder: { mom: THREE.DataTexture; cross: THREE.DataTexture } | null = null;

/** 1 × 1 zero moment textures (RGBA16F, R16F) bound while no bump map is loaded (uBumpMode 0 never samples them). */
function bumpPlaceholders(): { mom: THREE.DataTexture; cross: THREE.DataTexture } {
  if (bumpPlaceholder) return bumpPlaceholder;
  const make = (format: THREE.PixelFormat, n: number) => {
    const t = new THREE.DataTexture(new Uint16Array(n), 1, 1, format, THREE.HalfFloatType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.name = "bump-placeholder";
    t.needsUpdate = true;
    return t;
  };
  bumpPlaceholder = { mom: make(THREE.RGBAFormat, 4), cross: make(THREE.RedFormat, 1) };
  return bumpPlaceholder;
}

/** Every name of §6.5 with defaults. The environment (`uEnv`, `uEnvMaxLod`) is set by `StudioEnv.apply`, the print
 *  text by `renderPrintText`, the waves by `applyWaves`, the lights by `applyLights` (via `updateFrameUniforms`). */
export function createSharedUniforms(tex: SpectralTextures): Uniforms {
  if (!ltc) ltc = RectAreaLightTexturesLib.init() as unknown as { LTC_HALF_1: THREE.DataTexture; LTC_HALF_2: THREE.DataTexture };
  const ink = (hex: string) => ({ value: linearColor(hex) });
  const u: Uniforms = {
    // card pose and geometry
    uCardRot: { value: new THREE.Matrix3() }, uPrevCardRot: { value: new THREE.Matrix3() },
    uPrevModelMatrix: { value: new THREE.Matrix4() },
    // the Holo cloth's fold shadow (card.vert `aOcc`): 1 while the cloth is shown
    uOcc: { value: 0 },
    uCardSizeMm: { value: new THREE.Vector2(63, 88) },
    // period of p [mm] along U / V on closed objects (addendum A1: periodic cell patterns, relief.glsl); 0 = open
    uWrapMm: { value: new THREE.Vector2(0, 0) },
    uCornerMm: { value: 3 }, uBowMm: { value: 0.5 }, uBowAxis: { value: 0 },
    // lights (§4.3)
    uLightType: { value: new Int32Array(MAX_LIGHTS) },
    uLightOrder: { value: new Int32Array(MAX_LIGHTS).fill(-1) },
    uLightPos: { value: new Float32Array(3 * MAX_LIGHTS) }, uPrevLightPos: { value: new Float32Array(3 * MAX_LIGHTS) },
    uLightU: { value: new Float32Array(3 * MAX_LIGHTS) }, uLightW: { value: new Float32Array(3 * MAX_LIGHTS) },
    uLightRadius: { value: new Float32Array(MAX_LIGHTS).fill(0.01) },
    uLightRad: { value: new Float32Array(MAX_LIGHTS) },
    uLightSpd: { value: new Int32Array(MAX_LIGHTS) },
    uLightRGB: { value: new Float32Array(3 * MAX_LIGHTS).fill(1) },
    uEtaOrd: { value: new Float32Array(4 * 3 * MAX_LIGHTS).fill(1) },
    uEtaMir: { value: new Float32Array(4 * MAX_LIGHTS).fill(1) },
    uEtaEnv: { value: new Float32Array(4).fill(1) },
    uKeyLight: { value: -1 },
    // loop trip counts (TierConfig.trips, §6.1)
    uMaxOrder: { value: 3 }, uGhB: { value: 4 }, uVorR: { value: 2 }, uFlakeR: { value: 1 },
    uBCells: { value: 3 }, uBBins: { value: 5 }, uBLevels: { value: 2 },
    uVolSteps: { value: 48 }, uVolLights: { value: 3 }, uVolShadowSteps: { value: 10 },   // A5 Volume Hologram
    // environment (§4.6)
    uEnv: { value: null }, uEnvMaxLod: { value: 0 }, uEnvIntensity: { value: 1 },
    uEnvRot: { value: new THREE.Matrix3() }, uEnvUniform: { value: 0 },
    // spectral tables (§4.2)
    uCmfConv: { value: tex.conv }, uCmfCum: { value: tex.cum }, uSpecProj: { value: tex.specProj },
    // environment bins: always NB_MAX entries (the K = NB set, zero-padded) so that a program of either NB keeps
    // valid arrays while a tier change swaps materials (GL ignores the extra values of a shorter uniform array)
    uBinLam: { value: new Array<number>(NB_MAX).fill(0) },
    uBinW: { value: Array.from({ length: NB_MAX }, () => new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0)) },
    uBinWidth: { value: 37.5 },
    // LTC (§4.3.3)
    uLtc1: { value: ltc.LTC_HALF_1 }, uLtc2: { value: ltc.LTC_HALF_2 },
    // relief (§4.9)
    uWave: { value: new Float32Array(128) },
    uWaveBoard: { value: new THREE.Vector2(0, 0) }, uWaveCoat: { value: new THREE.Vector2(0, 0) },
    // bump map (addendum A1.2; driven by scene/bumpMaps.ts BumpMaps): mode 0 off, 1 foil, 2 varnish
    uBumpMode: { value: 0 },
    uBumpMom: { value: bumpPlaceholders().mom }, uBumpCross: { value: bumpPlaceholders().cross },
    uBumpScale: { value: new THREE.Vector2(1, 1) }, uBumpK: { value: new THREE.Vector2(0, 0) },
    // print (§5.7)
    uPrintMode: { value: PRINT_MODE_INDEX.art }, uBorderMode: { value: 0 },
    uInkBorder: ink(INK_DEFAULTS.uInkBorder), uInkText: ink(INK_DEFAULTS.uInkText), uInkPanel: ink(INK_DEFAULTS.uInkPanel),
    uInkSubject: ink(INK_DEFAULTS.uInkSubject), uInkSubjectRim: ink(INK_DEFAULTS.uInkSubjectRim),
    uInkGold: ink(INK_DEFAULTS.uInkGold), uInkSpark: ink(INK_DEFAULTS.uInkSpark),
    uTextTex: { value: null },
    uSmokeT2: { value: 0.3 }, uEdgeSilver: { value: 0 },
    uWear: { value: 0.3 },
    uBackColor: ink(BACK_COLOUR_DEFAULT),
    // debug (§4.14)
    uDebugLight: { value: 1 }, uDebugRaw: { value: 0 },
    // sub-viewport (§5.5)
    uViewScale: { value: new THREE.Vector2(1, 1) },
  };
  texOf.set(u, { tex, version: -1, nb: -1 });
  refreshBins(u, 8);
  return u;
}

function refreshBins(u: Uniforms, nb: number): void {
  const e = texOf.get(u);
  if (!e || nb <= 0) return;
  if (e.version === e.tex.version && e.nb === nb) return;
  const src = e.tex.bins[nb === 6 ? 6 : 8];
  const lam = u.uBinLam.value as number[], W = u.uBinW.value as THREE.Matrix3[];
  for (let j = 0; j < NB_MAX; j++) {
    if (j < src.lambda.length) { lam[j] = src.lambda[j]; W[j].copy(src.W[j]); }
    else { lam[j] = 0; W[j].set(0, 0, 0, 0, 0, 0, 0, 0, 0); }
  }
  u.uBinWidth.value = src.width;
  e.version = e.tex.version; e.nb = nb;
}

function setMat3RowMajor(m: THREE.Matrix3, r: readonly number[]): void {
  m.set(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]);
}

/** Per-frame update (§6.4): the uPrev* uniforms first (from the inputs' previous values, which the CPU sets equal to
 *  the current ones under freeze=1 so the motion kernel is zero), then pose, lights, etaNorm, trip counts, bins and
 *  the sub-viewport scale. */
export function updateFrameUniforms(u: Uniforms, f: FrameInputs, t: TierConfig): void {
  setMat3RowMajor(u.uPrevCardRot.value as THREE.Matrix3, f.prevCardRot);
  (u.uPrevModelMatrix.value as THREE.Matrix4).fromArray(f.prevModelMatrix);
  (u.uPrevLightPos.value as Float32Array).set(f.prevLightPos);
  setMat3RowMajor(u.uCardRot.value as THREE.Matrix3, f.cardRot);
  applyLights(u, f.lights);
  (u.uEtaOrd.value as Float32Array).set(f.eta.ord);
  (u.uEtaMir.value as Float32Array).set(f.eta.mir);
  (u.uEtaEnv.value as Float32Array).set(f.eta.env);
  const tr = t.trips;
  u.uMaxOrder.value = tr.maxOrder; u.uGhB.value = tr.ghB; u.uVorR.value = tr.vorR; u.uFlakeR.value = tr.flakeR;
  u.uBCells.value = tr.bCells; u.uBBins.value = tr.bBins; u.uBLevels.value = tr.bLevels;
  u.uVolSteps.value = tr.volSteps; u.uVolLights.value = tr.volLights; u.uVolShadowSteps.value = tr.volShadow;
  refreshBins(u, t.defines.NB);
  (u.uViewScale.value as THREE.Vector2).set(f.viewScale.x, f.viewScale.y);
}

/** Relief waves (§4.9) from `buildWaves`. */
export function applyWaves(u: Uniforms, w: WaveSet): void {
  (u.uWave.value as Float32Array).set(w.data);
  (u.uWaveBoard.value as THREE.Vector2).set(w.board[0], w.board[1]);
  (u.uWaveCoat.value as THREE.Vector2).set(w.coat[0], w.coat[1]);
}
