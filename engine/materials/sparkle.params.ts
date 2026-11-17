// A2-1 Sky Sparkle: DialKit panel literal and parameter table (addendum A2.4.8). Pure module (spec §6.1): type-only
// imports apart from the shared option array TINT_OPTIONS, explicit `.ts` extensions, erasable syntax only, so
// `node --test` and `ui/dialConfig.ts` (checkConsistency) can import it without the shader sources.
//
// Defaults: A2.4.8 as calibrated against the reference photo (A2.4.12; implementation notes of addendum A2; record in
// tools/out/a2/sparkle/calibration.json): dot size 470 µm, coverage 0.40, irregularity 0.8, speck share 9 % at 0.9·D,
// speck dye 460 nm / 25 nm / floor 0.3, sand size 0.5·D, sand tilt 5°, haze share 0 (the rest as A2.4.8).
//
// Panel "Sky Sparkle", DialKit id `holo-mat-sparkle`, persist key `holo:v1:mat-sparkle`. Every ParamSpec.id is also the
// URL key (§6.7); `uniform` names the GLSL uniform the value drives (conversions in sparkle.ts `apply`), or null for
// CPU-side consumers (the spectral tables for the tint values, the relief waves for waviness and orange peel).
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec } from "../types.ts";
import { optionValues, TINT_OPTIONS } from "./options.ts";

export const sparkleDial = {
  dots: {
    "dot size (µm)": [470, 100, 1500, 5],
    coverage: [0.4, 0.1, 0.8, 0.01],
    irregularity: [0.8, 0, 1, 0.01],
    "tilt spread (°)": [0.3, 0, 5, 0.05],
    "dome (°)": [0.3, 0.05, 2, 0.05],
    "orientation jitter (°)": [2, 0, 15, 0.1],
  },
  grating: {
    "pitch (nm)": [1000, 500, 2000, 5],
    "groove angle (°)": [120, 0, 180, 1],
    "depth (nm)": [55, 0, 200, 1],
    "fan spread (°)": [12, 0, 30, 0.1],
    "pitch jitter (%)": [1.5, 0, 5, 0.05],
  },
  specks: {
    "speck share (%)": [9, 0, 30, 0.5],
    "speck type": {
      type: "select",
      options: [{ value: "dyed", label: "Blue-dyed satin (reference)" }, { value: "grating", label: "Fine-pitch grating" }],
      default: "dyed",
    },
    "speck dye peak (nm)": [460, 420, 520, 1],
    "speck dye width (nm)": [25, 10, 60, 1],
    "speck dye floor": [0.3, 0, 1, 0.01],
    "speck pitch (nm)": [700, 400, 2000, 5],
    "speck size": [0.9, 0.3, 1, 0.01],
  },
  base: {
    "matte roughness (°)": [8, 1, 20, 0.1],
    "sand size": [0.5, 0.15, 1, 0.01],
    "sand tilt (°)": [5, 0, 8, 0.1],
    "haze share": [0, 0, 1, 0.01],
    "haze depth (nm)": [60, 0, 200, 1],
    "haze roughness (°)": [1.5, 0.05, 6, 0.05],
    "haze fan (°)": [10, 0, 20, 0.1],
  },
  metal: {
    _collapsed: true,
    "lacquer index": [1.5, 1.4, 1.7, 0.01],
    tint: { type: "select", options: TINT_OPTIONS, default: "shortpass" },
    "tint edge (nm)": [600, 400, 700, 1],
    "tint width (nm)": [90, 5, 150, 1],
    "tint floor": [0.5, 0, 1, 0.01],
  },
  surface: {
    _collapsed: true,
    "waviness (°)": [0.3, 0, 1, 0.01],
    "coat roughness": [0.05, 0.01, 0.5, 0.005],
    "orange peel (µm)": [0.6, 0, 2, 0.05],
  },
  seed: [5, 1, 999, 1],
  reset: { type: "action", label: "Reset material" },
} satisfies DialConfig;

/** Speck models of `sparkle.speckType`, in `uSpeckType` order (0 blue-dyed satin, 1 fine-pitch grating). */
export const SPARKLE_SPECK_TYPES = ["dyed", "grating"] as const;
export type SparkleSpeckType = (typeof SPARKLE_SPECK_TYPES)[number];

/** One ParamSpec per non-action control of `sparkleDial` (A2.4.8 table). */
export const SPARKLE_PARAMS: readonly ParamSpec[] = [
  { id: "sparkle.size", path: "dots.dot size (µm)", kind: "slider", default: 470, min: 100, max: 1500, step: 5, unit: "µm",
    meaning: "Mean dot diameter D", uniform: "uDotD" },
  { id: "sparkle.coverage", path: "dots.coverage", kind: "slider", default: 0.4, min: 0.1, max: 0.8, step: 0.01, unit: "—",
    meaning: "Union area cover C of the two dot layers", uniform: "uDotCell" },
  { id: "sparkle.irregularity", path: "dots.irregularity", kind: "slider", default: 0.8, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Outline lobes a₂, a₃ ≤ 0.15·v and size spread ±0.4·v", uniform: "uDotIrr" },
  { id: "sparkle.tilt", path: "dots.tilt spread (°)", kind: "slider", default: 0.3, min: 0, max: 5, step: 0.05, unit: "°",
    meaning: "RMS buried dot tilt per axis", uniform: "uDotTilt" },
  { id: "sparkle.dome", path: "dots.dome (°)", kind: "slider", default: 0.3, min: 0.05, max: 2, step: 0.05, unit: "°",
    meaning: "RMS slope variation within a dot", uniform: "uDotTauF" },
  { id: "sparkle.orientJitter", path: "dots.orientation jitter (°)", kind: "slider", default: 2, min: 0, max: 15, step: 0.1, unit: "°",
    meaning: "RMS per-dot groove-orientation error (aligned dots)", uniform: "uDotSigTh" },
  { id: "sparkle.pitch", path: "grating.pitch (nm)", kind: "slider", default: 1000, min: 500, max: 2000, step: 5, unit: "nm",
    meaning: "Dot and haze grating period", uniform: "uDotInvD" },
  { id: "sparkle.grooveAngle", path: "grating.groove angle (°)", kind: "slider", default: 120, min: 0, max: 180, step: 1, unit: "°",
    meaning: "Groove direction, CCW from card +x (bands run along it)", uniform: "uDotGDir" },
  { id: "sparkle.depth", path: "grating.depth (nm)", kind: "slider", default: 55, min: 0, max: 200, step: 1, unit: "nm",
    meaning: "Dot relief depth (peak-to-valley)", uniform: "uDotDepth" },
  { id: "sparkle.fan", path: "grating.fan spread (°)", kind: "slider", default: 12, min: 0, max: 30, step: 0.1, unit: "°",
    meaning: "Diffuser spread of aligned dots along the grooves", uniform: "uDotFanQ" },
  { id: "sparkle.pitchJitter", path: "grating.pitch jitter (%)", kind: "slider", default: 1.5, min: 0, max: 5, step: 0.05, unit: "%",
    meaning: "RMS per-dot relative pitch error", uniform: "uDotSigF" },
  { id: "sparkle.speckShare", path: "specks.speck share (%)", kind: "slider", default: 9, min: 0, max: 30, step: 0.5, unit: "%",
    meaning: "Share of dots that are specks", uniform: "uSpeckShare" },
  { id: "sparkle.speckType", path: "specks.speck type", kind: "select", default: "dyed", options: [...SPARKLE_SPECK_TYPES], unit: "—",
    meaning: "dyed: non-diffracting blue-dyed satin dots; grating: randomly oriented fine-pitch gratings", uniform: "uSpeckType" },
  { id: "sparkle.speckDyePeak", path: "specks.speck dye peak (nm)", kind: "slider", default: 460, min: 420, max: 520, step: 1, unit: "nm",
    meaning: "Peak λ_s of the speck dye (dyed type)", uniform: "uSpeckTint" },
  { id: "sparkle.speckDyeWidth", path: "specks.speck dye width (nm)", kind: "slider", default: 25, min: 10, max: 60, step: 1, unit: "nm",
    meaning: "Gaussian half-width w_s of the speck dye", uniform: "uSpeckTint" },
  { id: "sparkle.speckDyeFloor", path: "specks.speck dye floor", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Double-pass T² of the speck dye away from the peak", uniform: "uSpeckTint" },
  { id: "sparkle.speckPitch", path: "specks.speck pitch (nm)", kind: "slider", default: 700, min: 400, max: 2000, step: 5, unit: "nm",
    meaning: "Speck grating period (grating type)", uniform: "uSpeckInvD" },
  { id: "sparkle.speckSize", path: "specks.speck size", kind: "slider", default: 0.9, min: 0.3, max: 1, step: 0.01, unit: "—",
    meaning: "Speck diameter / D", uniform: "uSpeckScale" },
  { id: "sparkle.matte", path: "base.matte roughness (°)", kind: "slider", default: 8, min: 1, max: 20, step: 0.1, unit: "°",
    meaning: "Total RMS micro-slope of the matte base (buried): sand-cell tilt and intra-cell slope together", uniform: "uMatteSigS" },
  { id: "sparkle.sandSize", path: "base.sand size", kind: "slider", default: 0.5, min: 0.15, max: 1, step: 0.01, unit: "—",
    meaning: "Sand-cell pitch / D", uniform: "uSandCell" },
  { id: "sparkle.sandTilt", path: "base.sand tilt (°)", kind: "slider", default: 5, min: 0, max: 8, step: 0.1, unit: "°",
    meaning: "RMS buried tilt per sand cell and axis (clamped to ≤ the matte roughness)", uniform: "uSandTilt" },
  { id: "sparkle.hazeShare", path: "base.haze share", kind: "slider", default: 0, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Share of the base carrying the shallow grating", uniform: "uHazeShare" },
  { id: "sparkle.hazeDepth", path: "base.haze depth (nm)", kind: "slider", default: 60, min: 0, max: 200, step: 1, unit: "nm",
    meaning: "Haze grating depth", uniform: "uHazeDepth" },
  { id: "sparkle.hazeRoughness", path: "base.haze roughness (°)", kind: "slider", default: 1.5, min: 0.05, max: 6, step: 0.05, unit: "°",
    meaning: "RMS micro-slope of the haze patches", uniform: "uHazeSigS" },
  { id: "sparkle.hazeFan", path: "base.haze fan (°)", kind: "slider", default: 10, min: 0, max: 20, step: 0.1, unit: "°",
    meaning: "Diffuser spread of the haze grating", uniform: "uHazeFanQ" },
  { id: "sparkle.nc", path: "metal.lacquer index", kind: "slider", default: 1.5, min: 1.4, max: 1.7, step: 0.01, unit: "—",
    meaning: "Lacquer index", uniform: "uNc" },
  { id: "sparkle.tint", path: "metal.tint", kind: "select", default: "shortpass", options: optionValues(TINT_OPTIONS), unit: "—",
    meaning: "Lacquer dye: clear / long-pass / short-pass", uniform: null },
  { id: "sparkle.tintEdge", path: "metal.tint edge (nm)", kind: "slider", default: 600, min: 400, max: 700, step: 1, unit: "nm",
    meaning: "Dye edge", uniform: null },
  { id: "sparkle.tintWidth", path: "metal.tint width (nm)", kind: "slider", default: 90, min: 5, max: 150, step: 1, unit: "nm",
    meaning: "Dye edge half-width", uniform: null },
  { id: "sparkle.tintFloor", path: "metal.tint floor", kind: "slider", default: 0.5, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Double-pass T² on the blocked side", uniform: null },
  { id: "sparkle.waviness", path: "surface.waviness (°)", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "°",
    meaning: "RMS slope of 8–40 mm board waviness", uniform: null },
  { id: "sparkle.coatAlpha", path: "surface.coat roughness", kind: "slider", default: 0.05, min: 0.01, max: 0.5, step: 0.005, unit: "GGX α",
    meaning: "Clear-coat roughness", uniform: "uCoatAlpha" },
  { id: "sparkle.orangePeel", path: "surface.orange peel (µm)", kind: "slider", default: 0.6, min: 0, max: 2, step: 0.05, unit: "µm",
    meaning: "RMS height of 0.5–5 mm coat undulation", uniform: null },
  { id: "sparkle.seed", path: "seed", kind: "slider", default: 5, min: 1, max: 999, step: 1, unit: "—",
    meaning: "Dot field and wave phases", uniform: "uSeed" },
];
