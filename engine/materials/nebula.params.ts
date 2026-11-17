// M3 Nebula Glitter: DialKit panel literal and parameter table (spec §3.3). Pure module (§6.1): type-only imports
// apart from the shared option array TINT_OPTIONS (§6.4 WP-C), explicit `.ts` extensions, erasable syntax only, so
// `node --test` and `ui/dialConfig.ts` (checkConsistency) can import it without the shader sources.
//
// Panel "Nebula Glitter", DialKit id `holo-mat-nebula`. Every ParamSpec.id is also the URL key (§6.7); `uniform`
// names the GLSL uniform the value drives (conversion in nebula.ts `apply`), or null for CPU-side consumers (the
// spectral tables for the tint values, the relief waves for waviness and orange peel).
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec } from "../types.ts";
import { TINT_OPTIONS } from "./options.ts";

/** Stored values of a DialKit select's options (plain strings or `{ value, label }`). */
const selectValues = (o: readonly (string | { value: string })[]): string[] => o.map((x) => (typeof x === "string" ? x : x.value));

export const nebulaDial = {
  flakes: {
    "flake size (µm)": [200, 50, 400, 5],
    shape: {
      type: "select",
      options: [
        { value: "hex", label: "Hexagon" },
        { value: "square", label: "Square" },
        { value: "round", label: "Round" },
      ],
      default: "hex",
    },
    layers: [2, 1, 3, 1],
    "tilt spread (°)": [4.6, 0, 20, 0.1],
    "curvature (°)": [0.4, 0.05, 3, 0.05],
    "grating coverage": [0.65, 0, 1, 0.01],
  },
  grating: {
    "pitch min (nm)": [665, 400, 2000, 5],
    "pitch max (nm)": [740, 400, 2000, 5],
    "depth (nm)": [100, 0, 200, 1],
  },
  stars: {
    "star size (µm)": [600, 150, 1500, 10],
    "star density (%)": [3, 0, 30, 0.5],
  },
  base: {
    "base colour": "#0c0a24",
  },
  metal: {
    _collapsed: true,
    "lacquer index": [1.5, 1.4, 1.7, 0.01],
    tint: { type: "select", options: TINT_OPTIONS, default: "shortpass" },
    "tint edge (nm)": [525, 400, 700, 1],
    "tint width (nm)": [30, 5, 150, 1],
    "tint floor": [0.15, 0, 1, 0.01],
  },
  surface: {
    _collapsed: true,
    "waviness (°)": [0.3, 0, 1, 0.01],
    "coat roughness": [0.06, 0.01, 0.5, 0.005],
    "orange peel (µm)": [0.6, 0, 2, 0.05],
  },
  seed: [3, 1, 999, 1],
  reset: { type: "action", label: "Reset material" },
} satisfies DialConfig;

/** Flake outlines of `nebula.shape`, in `uShape` order (0 hex, 1 square, 2 round). */
export const NEBULA_SHAPES = ["hex", "square", "round"] as const;
export type NebulaShape = (typeof NEBULA_SHAPES)[number];

/** Flake area per D² (D = flat-to-flat size, square side or disc diameter): (√3/2)D², D², (π/4)D². */
export const NEBULA_SHAPE_AREA: Readonly<Record<NebulaShape, number>> = { hex: Math.sqrt(3) / 2, square: 1, round: Math.PI / 4 };
/** Lattice pitch c of every flake layer in units of D (§3.3: c = 1.25·D; also the star lattice in units of D_star). */
export const NEBULA_CELL_PER_D = 1.25;

/** One ParamSpec per non-action control of `nebulaDial` (§3.3 table). */
export const NEBULA_PARAMS: readonly ParamSpec[] = [
  { id: "nebula.size", path: "flakes.flake size (µm)", kind: "slider", default: 200, min: 50, max: 400, step: 5, unit: "µm",
    meaning: "Flat-to-flat flake size D", uniform: "uFlakeD" },
  { id: "nebula.shape", path: "flakes.shape", kind: "select", default: "hex", options: [...NEBULA_SHAPES], unit: "—",
    meaning: "hex / square / round", uniform: "uShape" },
  { id: "nebula.layers", path: "flakes.layers", kind: "slider", default: 2, min: 1, max: 3, step: 1, unit: "—",
    meaning: "Stacked flake layers (55 / 81 / 91 % cover for hex)", uniform: "uLayers" },
  { id: "nebula.tilt", path: "flakes.tilt spread (°)", kind: "slider", default: 4.6, min: 0, max: 20, step: 0.1, unit: "°",
    meaning: "RMS physical flake slope per axis (buried)", uniform: "uTiltRMS" },
  { id: "nebula.curv", path: "flakes.curvature (°)", kind: "slider", default: 0.4, min: 0.05, max: 3, step: 0.05, unit: "°",
    meaning: "RMS slope variation within a flake", uniform: "uTauF" },
  { id: "nebula.coverage", path: "flakes.grating coverage", kind: "slider", default: 0.65, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Area fraction of a flake carrying the grating; the rest is flat dyed mirror", uniform: "uCoverage" },
  { id: "nebula.pitchMin", path: "grating.pitch min (nm)", kind: "slider", default: 665, min: 400, max: 2000, step: 5, unit: "nm",
    meaning: "Smallest flake period", uniform: "uInvDRange" },
  { id: "nebula.pitchMax", path: "grating.pitch max (nm)", kind: "slider", default: 740, min: 400, max: 2000, step: 5, unit: "nm",
    meaning: "Largest flake period (swap if min > max)", uniform: "uInvDRange" },
  { id: "nebula.depth", path: "grating.depth (nm)", kind: "slider", default: 100, min: 0, max: 200, step: 1, unit: "nm",
    meaning: "Flake relief depth", uniform: "uDepthNm" },
  { id: "nebula.starSize", path: "stars.star size (µm)", kind: "slider", default: 600, min: 150, max: 1500, step: 10, unit: "µm",
    meaning: "Mean star-dot diameter (each star ×0.6–1.4)", uniform: "uStarD" },
  { id: "nebula.starDensity", path: "stars.star density (%)", kind: "slider", default: 3, min: 0, max: 30, step: 0.5, unit: "%",
    meaning: "Share of 1.25·D_star lattice cells that hold a star", uniform: "uStarOcc" },
  { id: "nebula.baseColor", path: "base.base colour", kind: "color", default: "#0c0a24", unit: "colour",
    meaning: "Ink under the binder", uniform: "uBaseColor" },
  { id: "nebula.nc", path: "metal.lacquer index", kind: "slider", default: 1.5, min: 1.4, max: 1.7, step: 0.01, unit: "—",
    meaning: "Binder index", uniform: "uNc" },
  { id: "nebula.tint", path: "metal.tint", kind: "select", default: "shortpass", options: selectValues(TINT_OPTIONS), unit: "—",
    meaning: "Binder dye filter: clear / long-pass (gold) / short-pass (blue)", uniform: null },
  { id: "nebula.tintEdge", path: "metal.tint edge (nm)", kind: "slider", default: 525, min: 400, max: 700, step: 1, unit: "nm",
    meaning: "Filter edge wavelength", uniform: null },
  { id: "nebula.tintWidth", path: "metal.tint width (nm)", kind: "slider", default: 30, min: 5, max: 150, step: 1, unit: "nm",
    meaning: "Half-width of the filter edge", uniform: null },
  { id: "nebula.tintFloor", path: "metal.tint floor", kind: "slider", default: 0.15, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Double-pass transmittance on the blocked side", uniform: null },
  { id: "nebula.waviness", path: "surface.waviness (°)", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "°",
    meaning: "RMS slope of 8–40 mm board waviness", uniform: null },
  { id: "nebula.coatAlpha", path: "surface.coat roughness", kind: "slider", default: 0.06, min: 0.01, max: 0.5, step: 0.005, unit: "GGX α",
    meaning: "Clear-coat roughness", uniform: "uCoatAlpha" },
  { id: "nebula.orangePeel", path: "surface.orange peel (µm)", kind: "slider", default: 0.6, min: 0, max: 2, step: 0.05, unit: "µm",
    meaning: "RMS height of 0.5–5 mm coat undulation", uniform: null },
  { id: "nebula.seed", path: "seed", kind: "slider", default: 3, min: 1, max: 999, step: 1, unit: "—",
    meaning: "Flake field", uniform: "uSeed" },
];
