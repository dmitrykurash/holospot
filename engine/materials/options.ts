// Shared select options of the material panels (tint, §3.1–3.3) and of the scene panel (light spectra, §5.8).
// Pure module (§6.1): no runtime imports, explicit `.ts` extensions, erasable syntax only, so the Node tests and
// `ui/dialConfig.ts` can import the dial literals that use these arrays.
//
// The arrays are plain mutable arrays on purpose: DialKit's `SelectConfig.options` is typed
// `(string | { value: string; label: string })[]`, which a readonly tuple would not satisfy in `satisfies DialConfig`.
import type { MaterialId, SpdId, TintType } from "../types.ts";

/** One option of a DialKit select: the stored `value` and the shown `label`. */
export interface SelectOption<V extends string = string> { value: V; label: string }

/** The scene panel's material select (`scene.material`, §5.8), in the order of `MATERIAL_IDS` (src/types.ts). A new
 *  material is added here, to `MaterialId`/`MATERIAL_IDS` and to `materials/registry.ts` — nothing in src/app or src/ui
 *  lists materials by hand (url.ts derives its namespaces from `MATERIAL_IDS`, sceneParams.ts uses this array). */
export const MATERIAL_OPTIONS: SelectOption<MaterialId>[] = [
  { value: "prism", label: "Prism Rainbow · smooth" },
  { value: "shatter", label: "Gold Shatter · fragmented" },
  { value: "nebula", label: "Nebula Glitter · sparkle" },
  { value: "sparkle", label: "Sky Sparkle · dotted rainbow" },
  { value: "vortex", label: "Gilded Vortex · kinetic spiral" },
  { value: "volume", label: "Volume Hologram · 3D depth" },
  { value: "emboss", label: "Foil Emboss · paper card" },
];

/** Lacquer / binder dye filter of every material panel (`<material>.tint`, §4.2.6 `tintT2`). */
export const TINT_OPTIONS: SelectOption<TintType>[] = [
  { value: "clear", label: "Clear" },
  { value: "longpass", label: "Gold / amber (long-pass)" },
  { value: "shortpass", label: "Blue (short-pass)" },
];

/** Light spectra of the scene panel's lights, in the texture layer order of `SPD_IDS` (§4.2.2). */
export const SPD_OPTIONS: SelectOption<SpdId>[] = [
  { value: "equal", label: "Equal energy (white)" },
  { value: "daylight", label: "Daylight 5600 K" },
  { value: "tungsten", label: "Tungsten 3200 K" },
  { value: "led", label: "White LED" },
  { value: "triphosphor", label: "Tri-phosphor fluorescent" },
];

/** The option values of a select, e.g. for `ParamSpec.options`. */
export function optionValues<V extends string>(o: readonly SelectOption<V>[]): V[] {
  return o.map((x) => x.value);
}
