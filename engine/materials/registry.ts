// Material registry (spec §6.2 WP-G): MaterialId → MaterialDef of the three materials (§3), imported by their
// contract paths (§6.4 WP-C/WP-D). The registry is the only place that knows the full set; the app looks every
// material up here by the scene panel's `material` value.
import type { MaterialDef, MaterialId } from "../types.ts";
import { MATERIAL_IDS } from "../types.ts";
import { prism } from "./prism.ts";
import { shatter } from "./shatter.ts";
import { nebula } from "./nebula.ts";
import { sparkle } from "./sparkle.ts";
import { vortex } from "./vortex.ts";
import { volume } from "./volume.ts";
import { emboss } from "./emboss.ts";

/** Every material: the three of spec §3, two of addendum A2 (Oil Slick was removed by addendum A5) and A5's Volume
 *  Hologram, and A6's Foil Emboss (paper card). A persisted or URL `material=slick` falls back to the default material (materialOf). */
export const MATERIALS: Readonly<Record<MaterialId, MaterialDef>> = { prism, shatter, nebula, sparkle, vortex, volume, emboss };

/** The MaterialDef of an id, or of the default material (`prism`) for anything unknown. */
export function materialOf(id: string): MaterialDef {
  return (MATERIAL_IDS as readonly string[]).includes(id) ? MATERIALS[id as MaterialId] : MATERIALS.prism;
}
