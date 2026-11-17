// M3 Nebula Glitter (spec §3.3, §4.11): the MaterialDef — panel literal and parameter table from nebula.params.ts,
// the fragment main holo_nebula.frag with the extra chunk glitter.glsl (flakes, stars, regimes A/B/C), the uniform
// conversions of the §3.3 table, the grating summary for the CPU tables and etaNorm, and the relief inputs.
//
// Physical model in one line: metallised, embossed PET hexagonal flakes (D = 200 µm, two rotated layers, buried tilt
// 4.6° RMS, 665–740 nm pitch, 100 nm deep, 65 % grating coverage) and 600 µm concentric-groove "star" dots in a blue
// short-pass binder (525 / 30 nm, floor 0.15, n = 1.5) over a deep indigo base ink; flakes do not recycle the light
// they trap (it leaves the flake sideways), so etaNorm runs without recycling (§4.4.1).
//
// Dependencies are the §6 contracts only: types.ts, ui/color.ts parseCssColor (§6.4 WP-G), the shader sources.
import * as THREE from "three";
import type { GratingSummary, MaterialDef, ParamValues, ReliefInputs, TierConfig, TintInputs, TintType, Uniforms } from "../types.ts";
import { NEBULA_CELL_PER_D, NEBULA_PARAMS, NEBULA_SHAPE_AREA, NEBULA_SHAPES, nebulaDial } from "./nebula.params.ts";
import { parseCssColor } from "../ui/color.ts";
import nebulaFrag from "../shaders/holo_nebula.frag?raw";
import glitterGlsl from "../shaders/glitter.glsl?raw";

const DEG = Math.PI / 180;

/** §3.3 / A.5 default dye of the binder: blue short-pass, edge 525 nm, half-width 30 nm, floor 0.15. */
const NEBULA_TINT: TintInputs = { type: "shortpass", edgeNm: 525, widthNm: 30, floor: 0.15 };
const TINT_TYPES: readonly TintType[] = ["clear", "longpass", "shortpass"];
/** Default base ink `#0c0a24`; linear sRGB ≈ (0.0037, 0.0030, 0.0176) (§3.3). */
const BASE_DEFAULT = "#0c0a24";
const BASE_DEFAULT_LINEAR: readonly [number, number, number] = [0.0036423, 0.0030353, 0.0176419];

const DEFAULTS: ParamValues = Object.fromEntries(NEBULA_PARAMS.map((p) => [p.id, p.default]));

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

// ---------------------------------------------------------------------------------------------------------------
// Panel values (ParamValues keyed by ParamSpec.id). URL values are coerced before they are set (§6.7); a missing or
// non-finite value still falls back to the §3.3 default, so a partial snapshot never produces NaN uniforms.
// ---------------------------------------------------------------------------------------------------------------

/** Numeric value of `id` (numbers or numeric strings), else its §3.3 default. */
function num(values: ParamValues, id: string): number {
  const v = values[id];
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : (DEFAULTS[id] as number);
}
/** Select value of `id` if it is one of `allowed`, else `fallback`. */
function pick<T extends string>(values: ParamValues, id: string, allowed: readonly T[], fallback: T): T {
  const v = values[id];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
/** The flake outline of the panel. */
const shapeOf = (values: ParamValues) => pick(values, "nebula.shape", NEBULA_SHAPES, "hex");
/** Pitch range [nm] as (min, max); the panel's min and max are swapped when min > max (§3.3). */
function pitchRange(values: ParamValues): [number, number] {
  const a = Math.max(num(values, "nebula.pitchMin"), 1), b = Math.max(num(values, "nebula.pitchMax"), 1);
  return [Math.min(a, b), Math.max(a, b)];
}
const binderIndex = (values: ParamValues) => clamp(num(values, "nebula.nc"), 1.0001, 3);
const depthNm = (values: ParamValues) => Math.max(num(values, "nebula.depth"), 0);
const seedOf = (values: ParamValues) => Math.max(Math.round(num(values, "nebula.seed")), 0);

/** Visible share of a flake in the union of L independently placed (rotated) layers of single-layer coverage c₁:
 *  (1 − (1 − c₁)^L)/(L·c₁) (§4.11 item 1; exact for regime B). */
export function nebulaVisFrac(c1: number, layers: number): number {
  const c = clamp(c1, 1e-6, 1), L = Math.max(layers, 1);
  return (1 - Math.pow(1 - c, L)) / (L * c);
}

/** Single-layer coverage c₁ = flake area / c² of an outline (hex 0.554, square 0.64, round 0.503; §4.11 item 1). */
export function nebulaLayerCoverage(shape: (typeof NEBULA_SHAPES)[number]): number {
  return NEBULA_SHAPE_AREA[shape] / (NEBULA_CELL_PER_D * NEBULA_CELL_PER_D);
}

// ---------------------------------------------------------------------------------------------------------------
// Uniforms (§3.3 "Uniform ← conversion" column)
// ---------------------------------------------------------------------------------------------------------------

function setValue(u: Uniforms, name: string, value: unknown): void {
  const e = u[name];
  if (e) e.value = value; else u[name] = { value };
}

/** Every material uniform of §3.3 from the panel values. */
function apply(values: ParamValues, u: Uniforms): void {
  // Flakes: size D [mm], lattice pitch c = 1.25·D, outline area, stacked layers and their union statistics.
  const D = Math.max(num(values, "nebula.size"), 1) * 1e-3;
  const shape = shapeOf(values);
  const layers = Math.round(clamp(num(values, "nebula.layers"), 1, 3));
  const cell = NEBULA_CELL_PER_D * D;
  setValue(u, "uFlakeD", D);
  setValue(u, "uCell", cell);
  setValue(u, "uFlakeArea", NEBULA_SHAPE_AREA[shape] * D * D);
  setValue(u, "uShape", NEBULA_SHAPES.indexOf(shape));
  setValue(u, "uLayers", layers);
  setValue(u, "uVisFrac", nebulaVisFrac(nebulaLayerCoverage(shape), layers));
  setValue(u, "uTiltRMS", Math.tan(clamp(num(values, "nebula.tilt"), 0, 80) * DEG));      // physical slope (buried, §4.1)
  setValue(u, "uTauF", Math.max(num(values, "nebula.curv"), 0) * DEG);
  setValue(u, "uCoverage", clamp(num(values, "nebula.coverage"), 0, 1));
  // Pitch range as (1/d_max, 1/d_min) [nm⁻¹].
  const [lo, hi] = pitchRange(values);
  const r = u.uInvDRange?.value;
  if (r instanceof THREE.Vector2) r.set(1 / hi, 1 / lo); else setValue(u, "uInvDRange", new THREE.Vector2(1 / hi, 1 / lo));
  setValue(u, "uDepthNm", depthNm(values));
  // Stars: mean diameter [mm] and lattice occupancy.
  setValue(u, "uStarD", Math.max(num(values, "nebula.starSize"), 1) * 1e-3);
  setValue(u, "uStarOcc", clamp(num(values, "nebula.starDensity") / 100, 0, 1));
  // Base ink under the binder: linear sRGB from the CSS colour string (§6.4 ui/color.ts); an unparsable string keeps
  // the default. Wide-gamut inputs may leave [0, 1]: a reflectance is clamped to it.
  const bv = values["nebula.baseColor"];
  const parsed = (typeof bv === "string" ? parseCssColor(bv) : null) ?? parseCssColor(BASE_DEFAULT);
  const rgb = (parsed?.rgb ?? BASE_DEFAULT_LINEAR).map((x) => clamp(x, 0, 1));
  const bc = u.uBaseColor?.value;
  if (bc instanceof THREE.Vector3) bc.set(rgb[0], rgb[1], rgb[2]); else setValue(u, "uBaseColor", new THREE.Vector3(rgb[0], rgb[1], rgb[2]));
  // Binder, coat, seed (uint).
  setValue(u, "uNc", binderIndex(values));
  setValue(u, "uCoatAlpha", clamp(num(values, "nebula.coatAlpha"), 1e-3, 1));
  setValue(u, "uSeed", seedOf(values) >>> 0);
}

function createUniforms(): Uniforms {
  const u: Uniforms = {
    uFlakeD: { value: 0.2 }, uCell: { value: 0.25 }, uFlakeArea: { value: 0.0346 }, uShape: { value: 0 },
    uLayers: { value: 2 }, uVisFrac: { value: 0.723 }, uTiltRMS: { value: 0.08 }, uTauF: { value: 0.007 },
    uCoverage: { value: 0.65 }, uInvDRange: { value: new THREE.Vector2(1 / 740, 1 / 665) }, uDepthNm: { value: 100 },
    uStarD: { value: 0.6 }, uStarOcc: { value: 0.03 }, uBaseColor: { value: new THREE.Vector3(...BASE_DEFAULT_LINEAR) },
    uNc: { value: 1.5 }, uCoatAlpha: { value: 0.06 }, uSeed: { value: 3 },
  };
  apply(DEFAULTS, u);
  return u;
}

// ---------------------------------------------------------------------------------------------------------------
// CPU summaries
// ---------------------------------------------------------------------------------------------------------------

/** §6.3 GratingSummary of M3: the families are the minimum, middle (harmonic mean, i.e. the mean of 1/d) and maximum
 *  pitch, interpolated per flake linearly in 1/d (Elem.fam, glitter.glsl glitterFam); no recycling of trapped light
 *  (§4.4.1); ĝ ∥ q for the orders and orientation means for mirrors and environment (gAzimuthRad null). */
function gratingSummary(values: ParamValues): GratingSummary {
  const [lo, hi] = pitchRange(values);
  return {
    pitchesNm: [lo, 2 / (1 / lo + 1 / hi), hi],
    depthNm: depthNm(values),
    nc: binderIndex(values),
    gAzimuthRad: null,
    recycle: false,
    tint: {
      type: pick(values, "nebula.tint", TINT_TYPES, NEBULA_TINT.type),
      edgeNm: num(values, "nebula.tintEdge"),
      widthNm: Math.max(num(values, "nebula.tintWidth"), 1e-3),
      floor: clamp(num(values, "nebula.tintFloor"), 0, 1),
    },
  };
}

function relief(values: ParamValues): ReliefInputs {
  return {
    seed: seedOf(values),
    wavinessDeg: Math.max(num(values, "nebula.waviness"), 0),
    orangePeelUm: Math.max(num(values, "nebula.orangePeel"), 0),
  };
}

export const nebula: MaterialDef = {
  id: "nebula",
  name: "Nebula Glitter",
  analog: "metallised holographic glitter flakes (galaxy / cosmos foils)",
  caption: "sparkly blue holo glitter · 1350–1500 l/mm",
  dial: nebulaDial,
  params: NEBULA_PARAMS,
  fragmentMain: nebulaFrag,
  extraChunks: [glitterGlsl],
  createUniforms,
  apply,
  defines(_tier: TierConfig): Record<string, string | number> { return {}; },   // the tier defines suffice (§1.6)
  gratingSummary,
  relief,
  wobbleAxisDeg: () => null,                    // isotropic glitter: no grating-aligned wobble (§5.6)
};
