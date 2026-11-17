// A2-3 Gilded Vortex (addendum A2.6): a spiral kinetic foil. One coherent, deterministic spiral grating over the whole
// object — a chirped multi-start Archimedean spiral whose grooves run radially at the centre and concentrically at the
// rim (local pitch 0 → 1250 nm) — under a gold (long-pass) lacquer on aluminium, with 24 spiral coverage bands. Each
// light draws two S-shaped rainbow arms through a pale-gold mirror "eye"; tilting rotates them around it.
//
// MaterialDef (§6.3): dial literal and ParamSpecs from vortex.params.ts; this module adds the shader source and the CPU
// conversions of the A2.6.7 "Uniform ← conversion" column. The CPU twin of the field is physics/vortex.ts.
import * as THREE from "three";
import type { GratingSummary, MaterialDef, ParamValues, ReliefInputs, TintInputs, Uniforms, Vec2 } from "../types.ts";
import fragmentMain from "../shaders/holo_vortex.frag?raw";
import { VORTEX_HANDEDNESS, VORTEX_PARAMS, vortexDial } from "./vortex.params.ts";
import { DEG, numParam, selectParam, setUniform, tintParam } from "./build.ts";
import { VORTEX_EYE_PITCH } from "../physics/vortex.ts";

/** Default gold dye (vortex.params.ts; A2.6.1 had edge 480 / floor 0.35): long-pass, edge 500 nm, half-width 50 nm, floor 0.30. */
const DEFAULT_TINT: TintInputs = { type: "longpass", edgeNm: 500, widthNm: 50, floor: 0.3 };
const DEFAULTS: ParamValues = Object.fromEntries(VORTEX_PARAMS.map((p) => [p.id, p.default]));

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const pitchNm = (v: ParamValues) => clamp(numParam(v, "vortex.pitch", 1250), 1, 1e5);
const depthNm = (v: ParamValues) => Math.max(numParam(v, "vortex.depth", 45), 0);
const lacquer = (v: ParamValues) => clamp(numParam(v, "vortex.nc", 1.5), 1.0001, 3);
const seedOf = (v: ParamValues) => Math.max(Math.round(numParam(v, "vortex.seed", 9)), 0);

/** The centre pad (half-domain units), each axis clamped to [−1, 1]. */
function centreOf(v: ParamValues): Vec2 {
  const c = v["vortex.centre"];
  const ok = typeof c === "object" && c !== null && "x" in c && "y" in c;
  const x = ok ? Number((c as Vec2).x) : 0, y = ok ? Number((c as Vec2).y) : 0;
  return { x: Number.isFinite(x) ? clamp(x, -1, 1) : 0, y: Number.isFinite(y) ? clamp(y, -1, 1) : 0 };
}

function apply(values: ParamValues, u: Uniforms): void {
  const d0 = pitchNm(values);
  setUniform(u, "uInvD0", 1 / d0);
  setUniform(u, "uSwirlR", clamp(numParam(values, "vortex.swirl", 15), 0, 1e4));
  setUniform(u, "uHand", selectParam(values, "vortex.handedness", VORTEX_HANDEDNESS, "ccw") === "cw" ? -1 : 1);
  const c = centreOf(values), off = u.uVortexOff?.value;
  if (off instanceof THREE.Vector2) off.set(c.x, c.y); else setUniform(u, "uVortexOff", new THREE.Vector2(c.x, c.y));
  // etaN family coordinates in 1/d: (1/300 eye, 1/(0.7·d₀), 1/d₀) — the GratingSummary families
  const fam = u.uVortexFam?.value, f = [1 / VORTEX_EYE_PITCH, 1 / (0.7 * d0), 1 / d0] as const;
  if (fam instanceof THREE.Vector3) fam.set(f[0], f[1], f[2]); else setUniform(u, "uVortexFam", new THREE.Vector3(f[0], f[1], f[2]));
  setUniform(u, "uDepthNm", depthNm(values));
  setUniform(u, "uFanQ", Math.max(numParam(values, "vortex.fan", 1.5), 0) * DEG);           // q units ← radians
  setUniform(u, "uBands", Math.max(Math.round(numParam(values, "vortex.bands", 24)), 0));
  setUniform(u, "uBandContrast", clamp(numParam(values, "vortex.contrast", 0.45), 0, 1));
  setUniform(u, "uNc", lacquer(values));
  setUniform(u, "uSigS", Math.max(numParam(values, "vortex.roughness", 0.25), 0) * DEG);
  setUniform(u, "uCoatAlpha", clamp(numParam(values, "vortex.coatAlpha", 0.045), 1e-3, 1));
}

export const vortex: MaterialDef = {
  id: "vortex",
  name: "Gilded Vortex",
  analog: "spiral kinetic foil (gold-swirl 1/1 parallels, hyper-swirl prizms, vortex film)",
  caption: "gold spiral kinetic foil · 800 l/mm vortex",
  dial: vortexDial,
  params: VORTEX_PARAMS,
  fragmentMain,
  extraChunks: [],

  createUniforms(): Uniforms {
    const u: Uniforms = {
      uInvD0: { value: 1 / 1250 }, uSwirlR: { value: 15 }, uHand: { value: 1 }, uVortexOff: { value: new THREE.Vector2(0, 0) },
      uVortexFam: { value: new THREE.Vector3(1 / 300, 1 / 875, 1 / 1250) }, uDepthNm: { value: 45 }, uFanQ: { value: 1.5 * DEG },
      uBands: { value: 24 }, uBandContrast: { value: 0.45 }, uNc: { value: 1.5 }, uSigS: { value: 0.25 * DEG },
      uCoatAlpha: { value: 0.045 },
    };
    apply(DEFAULTS, u);
    return u;
  },

  apply,

  defines(): Record<string, string | number> {
    return {};
  },

  // Families: 0 = the eye (300 nm; its etaN follows the real order count of each light), 1 = 0.7·d₀, 2 = d₀; ĝ ∥ q for
  // the orders and orientation means for mirrors and environment (gAzimuthRad null), recycling as M1.
  gratingSummary(values: ParamValues): GratingSummary {
    const d0 = pitchNm(values);
    return {
      pitchesNm: [VORTEX_EYE_PITCH, 0.7 * d0, d0],
      depthNm: depthNm(values),
      nc: lacquer(values),
      gAzimuthRad: null,
      recycle: true,
      tint: tintParam(values, "vortex", DEFAULT_TINT),
    };
  },

  relief(values: ParamValues): ReliefInputs {
    return {
      seed: seedOf(values),
      wavinessDeg: Math.max(numParam(values, "vortex.waviness", 0.3), 0),
      orangePeelUm: Math.max(numParam(values, "vortex.orangePeel", 0.6), 0),
    };
  },

  wobbleAxisDeg(): number | null {
    return null;
  },
};
