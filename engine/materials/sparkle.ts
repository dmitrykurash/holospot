// A2-1 Sky Sparkle (addendum A2.4): the MaterialDef — panel literal and parameter table from sparkle.params.ts, the
// fragment main holo_sparkle.frag with the extra chunks glitter.glsl and sparkle.glsl (appended in that order; the
// sparkle chunk reuses glitter's FLight, coverage, lattice and aperture helpers and its uSeed / uNc), the uniform
// conversions of the A2.4.8 table, the grating summary (three families: dots, haze, grating specks, each with its own
// depth, A2.3.2) and the relief inputs.
//
// Physical model in one line: an embossed holographic sparkle film — ≈ 13,900 irregular dots per card (D = 470 µm,
// two jittered lattices, union cover 0.40) sharing one 1000 l/mm grating (grooves at 120°, 55 nm deep, 12° diffuser fan,
// small per-dot tilt, orientation and pitch errors), 9 % of them blue-dyed satin specks, over a sand-matte aluminium
// base (resolved 235 µm micro-facets, 5° facet tilt, 8° total slope; no haze at the calibrated default), all under a
// sky-blue short-pass lacquer (600 / 90 nm, floor 0.5, n = 1.5). Defaults calibrated against the reference photo
// (A2.4.12; tools/out/a2/sparkle/).
//
// The pure conversions (panel values → dot field, speck dye) live in physics/sparkle.ts, the CPU twin the tests use.
import * as THREE from "three";
import type { GratingSummary, MaterialDef, ParamValues, ReliefInputs, TierConfig, Uniforms } from "../types.ts";
import { SPD_IDS } from "../types.ts";
import { SPARKLE_PARAMS, sparkleDial } from "./sparkle.params.ts";
import {
  SPECK_SIZE_MOMENT, lobeAreaFactor, sizeMoment, sparkleCoverMeans, sparkleFieldOf, sparkleGratingSummary, sparkleNum,
  sparkleSpeckDye, sparkleTint, speckTintRatio,
} from "../physics/sparkle.ts";
import { DEG, setUniform } from "./build.ts";
import sparkleFrag from "../shaders/holo_sparkle.frag?raw";
import glitterGlsl from "../shaders/glitter.glsl?raw";
import sparkleGlsl from "../shaders/sparkle.glsl?raw";

const DEFAULTS: ParamValues = Object.fromEntries(SPARKLE_PARAMS.map((p) => [p.id, p.default]));
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The speck tint uniforms are recomputed only when a dye or tint value changes (5 × 3 numbers, ≈ 5 ms). */
let tintCache: { key: string; rgb: number[][] } | null = null;
function speckTints(values: ParamValues): number[][] {
  const t = sparkleTint(values), d = sparkleSpeckDye(values);
  const key = `${t.type}|${t.edgeNm}|${t.widthNm}|${t.floor}|${d.peakNm}|${d.widthNm}|${d.floor}`;
  if (tintCache && tintCache.key === key) return tintCache.rgb;
  const rgb = SPD_IDS.map((id) => [...speckTintRatio(id, t, d)]);
  tintCache = { key, rgb };
  return rgb;
}

function setVec2(u: Uniforms, name: string, x: number, y: number): void {
  const v = u[name]?.value;
  if (v instanceof THREE.Vector2) v.set(x, y); else setUniform(u, name, new THREE.Vector2(x, y));
}

/** Every material uniform of A2.4.8 from the panel values. */
function apply(values: ParamValues, u: Uniforms): void {
  const f = sparkleFieldOf(values);
  setUniform(u, "uDotD", f.D);
  setUniform(u, "uDotCell", f.cell);
  setUniform(u, "uDotIrr", f.irr);
  setUniform(u, "uDotTilt", f.tilt);
  setUniform(u, "uDotTauF", Math.max(sparkleNum(values, "sparkle.dome"), 0) * DEG);
  setUniform(u, "uDotSigTh", f.sigTh);
  setUniform(u, "uDotSigF", f.sigF);
  setUniform(u, "uDotFanQ", Math.max(sparkleNum(values, "sparkle.fan"), 0) * DEG);
  setUniform(u, "uDotDepth", Math.max(sparkleNum(values, "sparkle.depth"), 0));
  setUniform(u, "uDotInvD", f.invD);
  setVec2(u, "uDotGDir", f.gDir[0], f.gDir[1]);
  // coverage kernels (mean outline areas) and the field's mean cover with the smaller specks (regime C, specks)
  const Ds = f.speckScale * f.D;
  setUniform(u, "uDotAreaMean", (Math.PI / 4) * f.D * f.D * sizeMoment(f.irr) * lobeAreaFactor(f.irr));
  setUniform(u, "uSpeckAreaMean", (Math.PI / 4) * Ds * Ds * SPECK_SIZE_MOMENT * lobeAreaFactor(f.irr));
  const cm = sparkleCoverMeans(f);
  setUniform(u, "uDotCover", cm.union);
  setUniform(u, "uSpeckArea", cm.speckArea);
  // specks
  setUniform(u, "uSpeckShare", f.speckShare);
  setUniform(u, "uSpeckInvD", f.speckInvD);
  setUniform(u, "uSpeckScale", f.speckScale);
  setUniform(u, "uSpeckType", f.speckGrating ? 1 : 0);
  const tints = speckTints(values);
  const arr = u.uSpeckTint?.value;
  if (Array.isArray(arr) && arr.length === 5 && arr.every((v) => v instanceof THREE.Vector3)) {
    tints.forEach((c, k) => (arr[k] as THREE.Vector3).set(c[0], c[1], c[2]));
  } else setUniform(u, "uSpeckTint", tints.map((c) => new THREE.Vector3(c[0], c[1], c[2])));
  // base: sand-matte cells and the haze patches
  setUniform(u, "uMatteSigS", f.matteSigS);
  setUniform(u, "uSandCell", f.sandCell);
  setUniform(u, "uSandTilt", f.sandTilt);
  setUniform(u, "uSandSigS", f.sandSigS);
  setUniform(u, "uHazeShare", clamp(sparkleNum(values, "sparkle.hazeShare"), 0, 1));
  setUniform(u, "uHazeDepth", Math.max(sparkleNum(values, "sparkle.hazeDepth"), 0));
  setUniform(u, "uHazeSigS", Math.max(sparkleNum(values, "sparkle.hazeRoughness"), 0) * DEG);
  setUniform(u, "uHazeFanQ", Math.max(sparkleNum(values, "sparkle.hazeFan"), 0) * DEG);
  // lacquer, coat, seed (uint)
  setUniform(u, "uNc", clamp(sparkleNum(values, "sparkle.nc"), 1.0001, 3));
  setUniform(u, "uCoatAlpha", clamp(sparkleNum(values, "sparkle.coatAlpha"), 1e-3, 1));
  setUniform(u, "uSeed", f.seed >>> 0);
}

function createUniforms(): Uniforms {
  const u: Uniforms = {
    uDotD: { value: 0.5 }, uDotCell: { value: 0.82 }, uDotIrr: { value: 0.5 }, uDotTilt: { value: 0.005 },
    uDotTauF: { value: 0.005 }, uDotSigTh: { value: 0.035 }, uDotSigF: { value: 0.015 }, uDotFanQ: { value: 0.21 },
    uDotDepth: { value: 55 }, uDotInvD: { value: 1e-3 }, uDotGDir: { value: new THREE.Vector2(0.866, 0.5) },
    uDotAreaMean: { value: 0.2 }, uSpeckAreaMean: { value: 0.07 }, uDotCover: { value: 0.48 }, uSpeckArea: { value: 0.03 },
    uSpeckShare: { value: 0.08 }, uSpeckInvD: { value: 1 / 700 }, uSpeckScale: { value: 0.6 }, uSpeckType: { value: 0 },
    uSpeckTint: { value: SPD_IDS.map(() => new THREE.Vector3(1, 1, 1)) },
    uMatteSigS: { value: 0.14 }, uSandCell: { value: 0.2 }, uSandTilt: { value: 0.087 }, uSandSigS: { value: 0.108 },
    uHazeShare: { value: 0.1 }, uHazeDepth: { value: 60 }, uHazeSigS: { value: 0.026 }, uHazeFanQ: { value: 0.17 },
    uNc: { value: 1.5 }, uCoatAlpha: { value: 0.05 }, uSeed: { value: 5 },
    // glitter.glsl's M3 uniforms, unused by this material (its sparkle chunk reuses only helpers), held at 0
    uFlakeD: { value: 0 }, uCell: { value: 0 }, uFlakeArea: { value: 0 }, uVisFrac: { value: 0 }, uTiltRMS: { value: 0 },
    uTauF: { value: 0 }, uCoverage: { value: 0 }, uDepthNm: { value: 0 }, uStarD: { value: 0 }, uStarOcc: { value: 0 },
    uShape: { value: 0 }, uLayers: { value: 0 }, uInvDRange: { value: new THREE.Vector2(0, 0) },
  };
  apply(DEFAULTS, u);
  return u;
}

/** Three families (dots, haze, grating specks) with their own depths: physics/sparkle.ts sparkleGratingSummary. */
function gratingSummary(values: ParamValues): GratingSummary {
  return sparkleGratingSummary(values);
}

function relief(values: ParamValues): ReliefInputs {
  return {
    seed: Math.max(Math.round(sparkleNum(values, "sparkle.seed")), 0),
    wavinessDeg: Math.max(sparkleNum(values, "sparkle.waviness"), 0),
    orangePeelUm: Math.max(sparkleNum(values, "sparkle.orangePeel"), 0),
  };
}

export const sparkle: MaterialDef = {
  id: "sparkle",
  name: "Sky Sparkle",
  analog: "embossed holographic sparkle film (glitter-pattern vinyl, speckle refractor)",
  caption: "sky-blue holographic sparkle film · 1000 l/mm dots",
  dial: sparkleDial,
  params: SPARKLE_PARAMS,
  fragmentMain: sparkleFrag,
  extraChunks: [glitterGlsl, sparkleGlsl],
  createUniforms,
  apply,
  defines(_tier: TierConfig): Record<string, string | number> { return {}; },   // the tier defines suffice (A2.4.10)
  gratingSummary,
  relief,
  wobbleAxisDeg: (values) => sparkleNum(values, "sparkle.grooveAngle"),        // aligned with the grating, as M1 (§5.6)
};
