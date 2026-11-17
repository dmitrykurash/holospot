// A2-3 Gilded Vortex: DialKit panel literal and parameter table (addendum A2.6.7). Pure module (§6.1): type-only
// imports apart from the shared option arrays, explicit `.ts` extensions, erasable syntax only, so `node --test` and
// `ui/dialConfig.ts` (checkConsistency) can import it without the shader sources.
//
// Panel "Gilded Vortex", DialKit id `holo-mat-vortex`, persist key `holo:v1:mat-vortex`. Every ParamSpec.id is also the
// URL key (§6.7); `uniform` names the GLSL uniform the value drives (conversion in vortex.ts `apply`), or null for
// CPU-side consumers (the spectral tables for the tint values, the relief waves for waviness, orange peel and seed).
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec } from "../types.ts";
import { optionValues, TINT_OPTIONS } from "./options.ts";

// Defaults that differ from A2.6.7 (rendered and judged in scratch/a2-t): fan 1.5° (was 3.5°: the arms read as broad
// wedges; at 1.5° they are crisp curved swooshes, ≈ 1.1 mm FWHM at r 15 mm) and the dye edge 500 nm / floor 0.30 (was
// 480 / 0.35: G/R 0.93, h 103°, which looked olive in dim reflections; now G/R 0.83, B/R 0.19, h 97° — a warm yellow
// gold, still yellower than Gold Shatter's h 89°).

/** Spiral sense of `vortex.handedness`: ccw → uHand +1, cw → −1. */
export const VORTEX_HANDEDNESS = ["ccw", "cw"] as const;
export type VortexHandedness = (typeof VORTEX_HANDEDNESS)[number];

export const vortexDial = {
  spiral: {
    "rim pitch (nm)": [1250, 600, 2000, 5],
    "swirl radius (mm)": [15, 0, 60, 0.5],
    handedness: {
      type: "select",
      options: [{ value: "ccw", label: "Counter-clockwise" }, { value: "cw", label: "Clockwise" }],
      default: "ccw",
    },
    centre: { type: "pad", x: [0, -1, 1, 0.01], y: [0, -1, 1, 0.01], labels: { x: "Centre x (half widths)", y: "Centre y (half heights)" } },
    "depth (nm)": [45, 0, 200, 1],
    "fan spread (°)": [1.5, 0, 10, 0.1],
  },
  bands: {
    "band count": [24, 0, 96, 1],
    "band contrast": [0.45, 0, 1, 0.01],
  },
  metal: {
    _collapsed: true,
    "lacquer index": [1.5, 1.4, 1.7, 0.01],
    "base roughness (°)": [0.25, 0.05, 3, 0.05],
    tint: { type: "select", options: TINT_OPTIONS, default: "longpass" },
    "tint edge (nm)": [500, 400, 700, 1],
    "tint width (nm)": [50, 5, 150, 1],
    "tint floor": [0.3, 0, 1, 0.01],
  },
  surface: {
    _collapsed: true,
    "waviness (°)": [0.3, 0, 1, 0.01],
    "coat roughness": [0.045, 0.01, 0.5, 0.005],
    "orange peel (µm)": [0.6, 0, 2, 0.05],
  },
  seed: [9, 1, 999, 1],
  reset: { type: "action", label: "Reset material" },
} satisfies DialConfig;

/** One ParamSpec per non-action control of `vortexDial` (A2.6.7 table). */
export const VORTEX_PARAMS: readonly ParamSpec[] = [
  { id: "vortex.pitch", path: "spiral.rim pitch (nm)", kind: "slider", default: 1250, min: 600, max: 2000, step: 5, unit: "nm",
    meaning: "Radial pitch d₀ (= the local pitch at r ≫ r_s)", uniform: "uInvD0" },
  { id: "vortex.swirl", path: "spiral.swirl radius (mm)", kind: "slider", default: 15, min: 0, max: 60, step: 0.5, unit: "mm",
    meaning: "r_s: where the grooves run at 45°; 0 = concentric (CD-like)", uniform: "uSwirlR" },
  { id: "vortex.handedness", path: "spiral.handedness", kind: "select", default: "ccw", options: [...VORTEX_HANDEDNESS], unit: "—",
    meaning: "Spiral sense", uniform: "uHand" },
  { id: "vortex.centre", path: "spiral.centre", kind: "pad", default: { x: 0, y: 0 }, min: -1, max: 1, step: 0.01, unit: "—",
    meaning: "Centre offset in half-domain units (x, y)", uniform: "uVortexOff" },
  { id: "vortex.depth", path: "spiral.depth (nm)", kind: "slider", default: 45, min: 0, max: 200, step: 1, unit: "nm",
    meaning: "Relief depth (peak-to-valley)", uniform: "uDepthNm" },
  { id: "vortex.fan", path: "spiral.fan spread (°)", kind: "slider", default: 1.5, min: 0, max: 10, step: 0.1, unit: "°",
    meaning: "Along-groove spread (arm width)", uniform: "uFanQ" },
  { id: "vortex.bands", path: "bands.band count", kind: "slider", default: 24, min: 0, max: 96, step: 1, unit: "—",
    meaning: "Number of spiral coverage bands (0 = none)", uniform: "uBands" },
  { id: "vortex.contrast", path: "bands.band contrast", kind: "slider", default: 0.45, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "1 − w_lo: coverage contrast of the bands", uniform: "uBandContrast" },
  { id: "vortex.nc", path: "metal.lacquer index", kind: "slider", default: 1.5, min: 1.4, max: 1.7, step: 0.01, unit: "—",
    meaning: "Index of the lacquer touching the relief", uniform: "uNc" },
  { id: "vortex.roughness", path: "metal.base roughness (°)", kind: "slider", default: 0.25, min: 0.05, max: 3, step: 0.05, unit: "°",
    meaning: "RMS micro-slope of the metallised relief, per axis", uniform: "uSigS" },
  { id: "vortex.tint", path: "metal.tint", kind: "select", default: "longpass", options: optionValues(TINT_OPTIONS), unit: "—",
    meaning: "Lacquer dye filter: clear / long-pass (gold) / short-pass (blue)", uniform: null },
  { id: "vortex.tintEdge", path: "metal.tint edge (nm)", kind: "slider", default: 500, min: 400, max: 700, step: 1, unit: "nm",
    meaning: "Filter edge wavelength", uniform: null },
  { id: "vortex.tintWidth", path: "metal.tint width (nm)", kind: "slider", default: 50, min: 5, max: 150, step: 1, unit: "nm",
    meaning: "Half-width of the filter edge", uniform: null },
  { id: "vortex.tintFloor", path: "metal.tint floor", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Double-pass transmittance on the blocked side", uniform: null },
  { id: "vortex.waviness", path: "surface.waviness (°)", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "°",
    meaning: "RMS slope of 8–40 mm board waviness", uniform: null },
  { id: "vortex.coatAlpha", path: "surface.coat roughness", kind: "slider", default: 0.045, min: 0.01, max: 0.5, step: 0.005, unit: "GGX α",
    meaning: "Clear-coat roughness", uniform: "uCoatAlpha" },
  { id: "vortex.orangePeel", path: "surface.orange peel (µm)", kind: "slider", default: 0.6, min: 0, max: 2, step: 0.05, unit: "µm",
    meaning: "RMS height of 0.5–5 mm coat undulation", uniform: null },
  { id: "vortex.seed", path: "seed", kind: "slider", default: 9, min: 1, max: 999, step: 1, unit: "—",
    meaning: "Random seed (wave phases; the spiral itself is deterministic)", uniform: null },
];
