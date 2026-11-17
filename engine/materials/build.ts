// The shared material builder (spec §6.4 WP-C) and small helpers the MaterialDefs share for reading panel values.
//
// buildHoloMaterial(def, tier, shared, mat, debugView) → THREE.ShaderMaterial:
//   vertex   card.vert (shared by every card material, §6.6)
//   fragment assemble({ ...tier.defines, ...def.defines(tier), MATERIAL_<ID>: 1, NSPD: 5, MAX_LIGHTS: 4,
//            DEBUG_VIEW: debugView }, def.extraChunks, def.fragmentMain)
//   uniforms { ...shared, ...mat } — spreading copies the property references, so every material keeps the same
//            IUniform objects as the shared map and one update of a shared uniform reaches all materials.
//   toneMapped false, depthTest / depthWrite true (addendum A1.1 item 2: the HDR target has a depth buffer, so the
//   non-convex objects occlude themselves; the convex card renders exactly as before), no blending (alpha = 1 on the
//   object; the target is cleared to 0 and the output pass composites by coverage, §5.5).
//   HOLO_LDR (no float colour buffer, Pipeline.hdr false): the mains gamut-map before encodeCard (§5.5).
// The defines select features and array sizes only; loop trip counts are uniforms (§6.1), so a tier change or a
// debug-view change builds a new material (compiled with renderer.compileAsync) and never edits a live one (§1.6).
import * as THREE from "three";
import type { MaterialDef, ParamValues, TierConfig, TintInputs, TintType, Uniforms } from "../types.ts";
import { assemble } from "../shaders/lib/index.ts";
import cardVert from "../shaders/card.vert?raw";

/** Optional build switches beyond the §6.4 signature (all default off). */
export interface HoloMaterialOptions {
  /** LDR fallback (no EXT_color_buffer_float, §5.5): the main gamut-maps before `encodeCard` so the compressed value
   *  fits the [0, 1) UNORM target (define `HOLO_LDR`, the same switch as the back and edge shaders). */
  ldr?: boolean;
  /** A9: the program variant (MaterialDef.variant; "" = the default program), passed to `def.defines`. */
  variant?: string;
}

/** The define set of a holo front material (§6.4), in the order the assembler writes it. */
export function holoDefines(def: MaterialDef, tier: TierConfig, debugView: number, o: HoloMaterialOptions = {}):
  Record<string, string | number> {
  const dv = Number.isInteger(debugView) && debugView >= 0 ? debugView : 0;
  return {
    ...tier.defines,
    ...def.defines(tier, o.variant ?? ""),
    ["MATERIAL_" + def.id.toUpperCase()]: 1,
    NSPD: 5,
    MAX_LIGHTS: 4,
    DEBUG_VIEW: dv,
    ...(o.ldr ? { HOLO_LDR: 1 } : {}),
  };
}

/** Builds the front-face ShaderMaterial of a holo material for a tier and a debug view (§6.4). */
export function buildHoloMaterial(def: MaterialDef, tier: TierConfig, shared: Uniforms, mat: Uniforms, debugView: number,
  o: HoloMaterialOptions = {}): THREE.ShaderMaterial {
  const defines = holoDefines(def, tier, debugView, o);
  return new THREE.ShaderMaterial({
    name: `holo-${def.id}${o.variant ? `-${o.variant}` : ""}-${tier.tier}-dv${defines.DEBUG_VIEW}${o.ldr ? "-ldr" : ""}`,
    vertexShader: cardVert,
    fragmentShader: ((src: string) => (def.transformFragment ? def.transformFragment(src, o.variant ?? "") : src))(assemble(defines, def.extraChunks, def.fragmentMain)),
    uniforms: { ...shared, ...mat },
    side: THREE.FrontSide,
    toneMapped: false,
    depthTest: true,
    depthWrite: true,
    blending: THREE.NoBlending,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Panel values (ParamValues are keyed by ParamSpec.id). URL values are coerced before they are set (§6.7), but the
// materials still fall back to the default for a missing or non-finite value, so a partial snapshot never produces
// NaN uniforms.
// ---------------------------------------------------------------------------------------------------------------

export const DEG = Math.PI / 180;

/** Numeric value of `id`, or `fallback` when it is missing or not a finite number. */
export function numParam(values: ParamValues, id: string, fallback: number): number {
  const v = values[id];
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : fallback;
}

/** Select value of `id` if it is one of `allowed`, else `fallback`. */
export function selectParam<T extends string>(values: ParamValues, id: string, allowed: readonly T[], fallback: T): T {
  const v = values[id];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const TINT_TYPES: readonly TintType[] = ["clear", "longpass", "shortpass"];

/** The tint inputs of a material panel (`<prefix>.tint`, `.tintEdge`, `.tintWidth`, `.tintFloor`, §4.2.6). */
export function tintParam(values: ParamValues, prefix: string, d: TintInputs): TintInputs {
  return {
    type: selectParam(values, `${prefix}.tint`, TINT_TYPES, d.type),
    edgeNm: numParam(values, `${prefix}.tintEdge`, d.edgeNm),
    widthNm: Math.max(numParam(values, `${prefix}.tintWidth`, d.widthNm), 1e-3),
    floor: Math.min(Math.max(numParam(values, `${prefix}.tintFloor`, d.floor), 0), 1),
  };
}

/** Sets a uniform's value (creating the IUniform if the map lacks it). */
export function setUniform(u: Uniforms, name: string, value: unknown): void {
  const e = u[name];
  if (e) e.value = value;
  else u[name] = { value };
}
