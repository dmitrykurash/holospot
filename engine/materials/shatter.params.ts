// M2 Gold Shatter: DialKit panel literal and parameter table (spec §3.2). Pure module (§6.1): type-only imports
// apart from the shared option arrays, explicit `.ts` extensions, erasable syntax only.
//
// Panel "Gold Shatter", DialKit id `holo-mat-shatter`. Every ParamSpec.id is also the URL key (§6.7); `uniform`
// names the GLSL uniform the value drives (conversion in shatter.ts `apply`), or null for CPU-side consumers.
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec } from "../types.ts";
import { optionValues, TINT_OPTIONS } from "./options.ts";

export const shatterDial = {
  shards: {
    "shard size (mm)": [2.5, 0.5, 8, 0.1],
    irregularity: [0.9, 0, 1, 0.01],
    "splits per cell": [1.8, 0, 3, 0.1],
    "orientation steps": [0, 0, 24, 1],
    "shard tilt (°)": [1, 0, 6, 0.05],
    "fan spread (°)": [5, 0, 15, 0.1],
  },
  grating: {
    "pitch A (nm)": [1150, 500, 2000, 5],
    "pitch B (nm)": [1080, 500, 2000, 5],
    "pitch C (nm)": [870, 500, 2000, 5],
    "depth (nm)": [95, 0, 200, 1],
    coverage: [0.7, 0.2, 1, 0.01],
    "chirp (%)": [0, 0, 5, 0.1],
  },
  ridges: {
    _collapsed: true,
    "ridge height (µm)": [0.3, -0.4, 0.4, 0.01],
    "ridge half-width (µm)": [40, 10, 200, 1],
    "creased borders (%)": [50, 0, 100, 1],
  },
  metal: {
    _collapsed: true,
    "lacquer index": [1.5, 1.4, 1.7, 0.01],
    "base roughness (°)": [0.45, 0.05, 3, 0.05],
    tint: { type: "select", options: TINT_OPTIONS, default: "longpass" },
    "tint edge (nm)": [500, 400, 700, 1],
    "tint width (nm)": [70, 5, 150, 1],
    "tint floor": [0.25, 0, 1, 0.01],
  },
  surface: {
    _collapsed: true,
    "waviness (°)": [0.3, 0, 1, 0.01],
    "coat roughness": [0.05, 0.01, 0.5, 0.005],
    "orange peel (µm)": [0.6, 0, 2, 0.05],
  },
  seed: [7, 1, 999, 1],
  reset: { type: "action", label: "Reset material" },
} satisfies DialConfig;

/** One ParamSpec per non-action control of `shatterDial` (§3.2 table). */
export const SHATTER_PARAMS: readonly ParamSpec[] = [
  { id: "shatter.size", path: "shards.shard size (mm)", kind: "slider", default: 2.5, min: 0.5, max: 8, step: 0.1, unit: "mm",
    meaning: "Mean shard pitch after chord splitting (the Voronoi level uses 2× this)", uniform: "uShardSize" },
  { id: "shatter.jitter", path: "shards.irregularity", kind: "slider", default: 0.9, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Voronoi feature-point jitter (0 = square grid)", uniform: "uShardJit" },
  { id: "shatter.chords", path: "shards.splits per cell", kind: "slider", default: 1.8, min: 0, max: 3, step: 0.1, unit: "—",
    meaning: "Mean number of straight chords splitting each Voronoi cell (T-junctions)", uniform: "uChords" },
  { id: "shatter.orientK", path: "shards.orientation steps", kind: "slider", default: 0, min: 0, max: 24, step: 1, unit: "—",
    meaning: "Number of discrete groove orientations; 0 = continuous (12 = the 15° steps of stepped originations)", uniform: "uOrientK" },
  { id: "shatter.tilt", path: "shards.shard tilt (°)", kind: "slider", default: 1, min: 0, max: 6, step: 0.05, unit: "°",
    meaning: "RMS physical micro-tilt of the buried shard per axis", uniform: "uShardTilt" },
  { id: "shatter.fan", path: "shards.fan spread (°)", kind: "slider", default: 5, min: 0, max: 15, step: 0.1, unit: "°",
    meaning: "Along-groove spread", uniform: "uFanQ" },
  { id: "shatter.pitchA", path: "grating.pitch A (nm)", kind: "slider", default: 1150, min: 500, max: 2000, step: 5, unit: "nm",
    meaning: "Period of shard family A", uniform: "uInvDSet" },
  { id: "shatter.pitchB", path: "grating.pitch B (nm)", kind: "slider", default: 1080, min: 500, max: 2000, step: 5, unit: "nm",
    meaning: "Period of family B", uniform: "uInvDSet" },
  { id: "shatter.pitchC", path: "grating.pitch C (nm)", kind: "slider", default: 870, min: 500, max: 2000, step: 5, unit: "nm",
    meaning: "Period of family C", uniform: "uInvDSet" },
  { id: "shatter.depth", path: "grating.depth (nm)", kind: "slider", default: 95, min: 0, max: 200, step: 1, unit: "nm",
    meaning: "Peak-to-valley depth", uniform: "uDepthNm" },
  { id: "shatter.coverage", path: "grating.coverage", kind: "slider", default: 0.7, min: 0.2, max: 1, step: 0.01, unit: "—",
    meaning: "Mean grating coverage of a shard (each shard draws w in ±0.1 around it); the rest is flat dyed mirror", uniform: "uCoverage" },
  { id: "shatter.chirp", path: "grating.chirp (%)", kind: "slider", default: 0, min: 0, max: 5, step: 0.1, unit: "%",
    meaning: "± pitch gradient across a shard (UNVERIFIED in real foils)", uniform: "uChirp" },
  { id: "shatter.ridgeH", path: "ridges.ridge height (µm)", kind: "slider", default: 0.3, min: -0.4, max: 0.4, step: 0.01, unit: "µm",
    meaning: "Maximum relief-crease height (negative = groove); each creased border draws its height in [0, H]", uniform: "uRidgeH" },
  { id: "shatter.ridgeW", path: "ridges.ridge half-width (µm)", kind: "slider", default: 40, min: 10, max: 200, step: 1, unit: "µm",
    meaning: "Crease half-width", uniform: "uRidgeW" },
  { id: "shatter.creaseShare", path: "ridges.creased borders (%)", kind: "slider", default: 50, min: 0, max: 100, step: 1, unit: "%",
    meaning: "Share of borders that carry a crease", uniform: "uCreaseShare" },
  { id: "shatter.nc", path: "metal.lacquer index", kind: "slider", default: 1.5, min: 1.4, max: 1.7, step: 0.01, unit: "—",
    meaning: "Index of the lacquer/laminate touching the relief", uniform: "uNc" },
  { id: "shatter.roughness", path: "metal.base roughness (°)", kind: "slider", default: 0.45, min: 0.05, max: 3, step: 0.05, unit: "°",
    meaning: "RMS micro-slope of the metallised relief, per axis", uniform: "uSigS" },
  { id: "shatter.tint", path: "metal.tint", kind: "select", default: "longpass", options: optionValues(TINT_OPTIONS), unit: "—",
    meaning: "Lacquer dye filter: clear / long-pass (gold) / short-pass (blue)", uniform: null },
  { id: "shatter.tintEdge", path: "metal.tint edge (nm)", kind: "slider", default: 500, min: 400, max: 700, step: 1, unit: "nm",
    meaning: "Filter edge wavelength", uniform: null },
  { id: "shatter.tintWidth", path: "metal.tint width (nm)", kind: "slider", default: 70, min: 5, max: 150, step: 1, unit: "nm",
    meaning: "Half-width of the filter edge", uniform: null },
  { id: "shatter.tintFloor", path: "metal.tint floor", kind: "slider", default: 0.25, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Double-pass transmittance on the blocked side", uniform: null },
  { id: "shatter.waviness", path: "surface.waviness (°)", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "°",
    meaning: "RMS slope of 8–40 mm board waviness", uniform: null },
  { id: "shatter.coatAlpha", path: "surface.coat roughness", kind: "slider", default: 0.05, min: 0.01, max: 0.5, step: 0.005, unit: "GGX α",
    meaning: "Clear-coat roughness", uniform: "uCoatAlpha" },
  { id: "shatter.orangePeel", path: "surface.orange peel (µm)", kind: "slider", default: 0.6, min: 0, max: 2, step: 0.05, unit: "µm",
    meaning: "RMS height of 0.5–5 mm coat undulation", uniform: null },
  { id: "shatter.seed", path: "seed", kind: "slider", default: 7, min: 1, max: 999, step: 1, unit: "—",
    meaning: "Shard layout and attributes", uniform: "uSeed" },
];
