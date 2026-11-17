// M1 Prism Rainbow (spec §3.1, §4.10): one coherent linear (or concentric / radial) grating over the whole card,
// clear lacquer on aluminium, champagne-silver mirror, the full violet→red first-order spectrum.
// MaterialDef (§6.3): the dial literal and ParamSpecs live in the pure prism.params.ts; this module adds the shader
// source and the CPU conversions of §3.1's "Uniform ← conversion" column.
import * as THREE from "three";
import type { GratingSummary, MaterialDef, ParamValues, ReliefInputs, TintInputs, Uniforms } from "../types.ts";
import fragmentMain from "../shaders/holo_prism.frag?raw";
import { prismDial, PRISM_PARAMS, PRISM_PATTERNS } from "./prism.params.ts";
import { DEG, numParam, selectParam, setUniform, tintParam } from "./build.ts";

const DEFAULT_TINT: TintInputs = { type: "clear", edgeNm: 505, widthNm: 35, floor: 0.06 };
const DEFAULTS: ParamValues = Object.fromEntries(PRISM_PARAMS.map((p) => [p.id, p.default]));

const pitchNm = (v: ParamValues) => Math.max(numParam(v, "prism.pitch", 1000), 1);
const grooveDeg = (v: ParamValues) => numParam(v, "prism.grooveAngle", 120);
const pattern = (v: ParamValues) => selectParam(v, "prism.pattern", PRISM_PATTERNS, "linear");
const depthNm = (v: ParamValues) => Math.max(numParam(v, "prism.depth", 50), 0);
const lacquer = (v: ParamValues) => Math.max(numParam(v, "prism.nc", 1.5), 1.0001);

export const prism: MaterialDef = {
  id: "prism",
  name: "Prism Rainbow",
  analog: "rainbow holographic laminate (traditional foils)",
  caption: "smooth silver rainbow foil · 1000 l/mm",
  dial: prismDial,
  params: PRISM_PARAMS,
  fragmentMain,
  extraChunks: [],

  createUniforms(): Uniforms {
    const u: Uniforms = {
      uInvD: { value: 1e-3 }, uGDir: { value: new THREE.Vector2(1, 0) }, uPattern: { value: 0 },
      uDepthNm: { value: 50 }, uCoverage: { value: 1 }, uFanQ: { value: 0 }, uSigTheta: { value: 0 },
      uSigFrel: { value: 0 }, uNc: { value: 1.5 }, uSigS: { value: 0 }, uCoatAlpha: { value: 0.04 }, uSeed: { value: 1 },
    };
    prism.apply(DEFAULTS, u);
    return u;
  },

  apply(values: ParamValues, u: Uniforms): void {
    setUniform(u, "uInvD", 1 / pitchNm(values));
    // ĝ ⟂ grooves: grooves at angle a (CCW from card +x) → ĝ = (sin a, −cos a) (§3.1), e.g. 120° → ĝ at 30°
    const a = grooveDeg(values) * DEG;
    const g = u.uGDir?.value;
    if (g instanceof THREE.Vector2) g.set(Math.sin(a), -Math.cos(a));
    else setUniform(u, "uGDir", new THREE.Vector2(Math.sin(a), -Math.cos(a)));
    setUniform(u, "uPattern", PRISM_PATTERNS.indexOf(pattern(values)));
    setUniform(u, "uDepthNm", depthNm(values));
    setUniform(u, "uCoverage", Math.min(Math.max(numParam(values, "prism.coverage", 1), 0), 1));
    setUniform(u, "uFanQ", Math.max(numParam(values, "prism.fan", 7), 0) * DEG);             // q units ← radians
    setUniform(u, "uSigTheta", Math.max(numParam(values, "prism.sigTheta", 0.3), 0) * DEG);
    setUniform(u, "uSigFrel", Math.max(numParam(values, "prism.sigPitch", 0.5), 0) / 100);
    setUniform(u, "uNc", lacquer(values));
    setUniform(u, "uSigS", Math.max(numParam(values, "prism.roughness", 0.2), 0) * DEG);
    setUniform(u, "uCoatAlpha", Math.min(Math.max(numParam(values, "prism.coatAlpha", 0.04), 1e-3), 1));
    setUniform(u, "uSeed", Math.max(Math.round(numParam(values, "prism.seed", 1)), 0) >>> 0);
  },

  defines(): Record<string, string | number> {
    return {};
  },

  // One family; the linear pattern reports its grating-vector azimuth (grooves at a ⇒ ĝ at a − 90°), the circular
  // patterns null (ĝ ∥ q for the orders, orientation means for mirrors and environment, §4.4.1).
  gratingSummary(values: ParamValues): GratingSummary {
    return {
      pitchesNm: [pitchNm(values)],
      depthNm: depthNm(values),
      nc: lacquer(values),
      gAzimuthRad: pattern(values) === "linear" ? (grooveDeg(values) - 90) * DEG : null,
      recycle: true,
      tint: tintParam(values, "prism", DEFAULT_TINT),
    };
  },

  relief(values: ParamValues): ReliefInputs {
    return {
      seed: Math.max(Math.round(numParam(values, "prism.seed", 1)), 0),
      wavinessDeg: Math.max(numParam(values, "prism.waviness", 0.3), 0),
      orangePeelUm: Math.max(numParam(values, "prism.orangePeel", 0.6), 0),
    };
  },

  // The aligned wobble of §5.6 turns about the groove axis (hue sweep) and about ĝ (band slide).
  wobbleAxisDeg(values: ParamValues): number | null {
    return pattern(values) === "linear" ? grooveDeg(values) : null;
  },
};
