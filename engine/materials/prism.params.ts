// M1 Prism Rainbow: DialKit panel literal and parameter table (spec §3.1). Pure module (§6.1): type-only imports
// apart from the shared option arrays, explicit `.ts` extensions, erasable syntax only, so `node --test` and
// `ui/dialConfig.ts` (checkConsistency) can import it without the shader sources.
//
// Panel "Prism Rainbow", DialKit id `holo-mat-prism`. Every ParamSpec.id is also the URL key (§6.7); `uniform` names
// the GLSL uniform the value drives (conversion in prism.ts `apply`), or null for CPU-side consumers (the spectral
// tables for the tint values, the relief waves for waviness and orange peel).
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec } from "../types.ts";
import { optionValues, TINT_OPTIONS } from "./options.ts";

export const prismDial = {
  grating: {
    "pitch (nm)": [1000, 500, 2000, 5],
    "groove angle (°)": [120, 0, 180, 1],
    pattern: {
      type: "select",
      options: [
        { value: "linear", label: "Linear" },
        { value: "concentric", label: "Concentric" },
        { value: "radial", label: "Radial" },
      ],
      default: "linear",
    },
    "depth (nm)": [50, 0, 200, 1],
    coverage: [1, 0, 1, 0.01],
    "fan spread (°)": [7, 0, 20, 0.1],
    "orientation jitter (°)": [0.3, 0, 5, 0.05],
    "pitch jitter (%)": [0.5, 0, 3, 0.05],
  },
  metal: {
    _collapsed: true,
    "lacquer index": [1.5, 1.4, 1.7, 0.01],
    "base roughness (°)": [0.2, 0.05, 3, 0.05],
    tint: { type: "select", options: TINT_OPTIONS, default: "clear" },
    "tint edge (nm)": [505, 400, 700, 1],
    "tint width (nm)": [35, 5, 150, 1],
    "tint floor": [0.06, 0, 1, 0.01],
  },
  surface: {
    _collapsed: true,
    "waviness (°)": [0.3, 0, 1, 0.01],
    "coat roughness": [0.04, 0.01, 0.5, 0.005],
    "orange peel (µm)": [0.6, 0, 2, 0.05],
  },
  seed: [1, 1, 999, 1],
  reset: { type: "action", label: "Reset material" },
} satisfies DialConfig;

/** Groove layouts of `prism.pattern`, in `uPattern` order (0 linear, 1 concentric, 2 radial). */
export const PRISM_PATTERNS = ["linear", "concentric", "radial"] as const;
export type PrismPattern = (typeof PRISM_PATTERNS)[number];

/** One ParamSpec per non-action control of `prismDial` (§3.1 table). */
export const PRISM_PARAMS: readonly ParamSpec[] = [
  { id: "prism.pitch", path: "grating.pitch (nm)", kind: "slider", default: 1000, min: 500, max: 2000, step: 5, unit: "nm",
    meaning: "Grating period d (1000 nm = 1000 l/mm)", uniform: "uInvD" },
  { id: "prism.grooveAngle", path: "grating.groove angle (°)", kind: "slider", default: 120, min: 0, max: 180, step: 1, unit: "°",
    meaning: "Groove direction in the card plane, CCW from card +x; bands run parallel to it", uniform: "uGDir" },
  { id: "prism.pattern", path: "grating.pattern", kind: "select", default: "linear", options: [...PRISM_PATTERNS], unit: "—",
    meaning: "Groove layout: straight lines; circles around the card centre; rays from the card centre", uniform: "uPattern" },
  { id: "prism.depth", path: "grating.depth (nm)", kind: "slider", default: 50, min: 0, max: 200, step: 1, unit: "nm",
    meaning: "Sinusoid peak-to-valley depth h (buried)", uniform: "uDepthNm" },
  { id: "prism.coverage", path: "grating.coverage", kind: "slider", default: 1, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Area fraction carrying the grating; the rest is flat mirror", uniform: "uCoverage" },
  { id: "prism.fan", path: "grating.fan spread (°)", kind: "slider", default: 7, min: 0, max: 20, step: 0.1, unit: "°",
    meaning: "RMS spread of first-order light along the grooves", uniform: "uFanQ" },
  { id: "prism.sigTheta", path: "grating.orientation jitter (°)", kind: "slider", default: 0.3, min: 0, max: 5, step: 0.05, unit: "°",
    meaning: "RMS groove-orientation error", uniform: "uSigTheta" },
  { id: "prism.sigPitch", path: "grating.pitch jitter (%)", kind: "slider", default: 0.5, min: 0, max: 3, step: 0.05, unit: "%",
    meaning: "RMS relative pitch error", uniform: "uSigFrel" },
  { id: "prism.nc", path: "metal.lacquer index", kind: "slider", default: 1.5, min: 1.4, max: 1.7, step: 0.01, unit: "—",
    meaning: "Index of the lacquer/laminate touching the relief", uniform: "uNc" },
  { id: "prism.roughness", path: "metal.base roughness (°)", kind: "slider", default: 0.2, min: 0.05, max: 3, step: 0.05, unit: "°",
    meaning: "RMS micro-slope of the metallised relief, per axis", uniform: "uSigS" },
  { id: "prism.tint", path: "metal.tint", kind: "select", default: "clear", options: optionValues(TINT_OPTIONS), unit: "—",
    meaning: "Lacquer dye filter: clear / long-pass (gold) / short-pass (blue)", uniform: null },
  { id: "prism.tintEdge", path: "metal.tint edge (nm)", kind: "slider", default: 505, min: 400, max: 700, step: 1, unit: "nm",
    meaning: "Filter edge wavelength", uniform: null },
  { id: "prism.tintWidth", path: "metal.tint width (nm)", kind: "slider", default: 35, min: 5, max: 150, step: 1, unit: "nm",
    meaning: "Half-width of the filter edge", uniform: null },
  { id: "prism.tintFloor", path: "metal.tint floor", kind: "slider", default: 0.06, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Double-pass transmittance on the blocked side", uniform: null },
  { id: "prism.waviness", path: "surface.waviness (°)", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "°",
    meaning: "RMS slope of 8–40 mm board waviness", uniform: null },
  { id: "prism.coatAlpha", path: "surface.coat roughness", kind: "slider", default: 0.04, min: 0.01, max: 0.5, step: 0.005, unit: "GGX α",
    meaning: "Clear-coat roughness", uniform: "uCoatAlpha" },
  { id: "prism.orangePeel", path: "surface.orange peel (µm)", kind: "slider", default: 0.6, min: 0, max: 2, step: 0.05, unit: "µm",
    meaning: "RMS height of 0.5–5 mm coat undulation", uniform: null },
  { id: "prism.seed", path: "seed", kind: "slider", default: 1, min: 1, max: 999, step: 1, unit: "—",
    meaning: "Random seed (wave phases and directions)", uniform: "uSeed" },
];
