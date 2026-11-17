// A6 Foil Emboss · paper card: DialKit panel literal, parameter table and the paper-stock presets (addendum A6.1).
// Pure module (spec §6.1): type-only imports, explicit `.ts` extensions, erasable syntax only, so `node --test` and
// `ui/dialConfig.ts` (checkConsistency) can import it without the shader sources.
//
// Panel "Foil Emboss", DialKit id `holo-mat-emboss`, persist key `holo:v1:mat-emboss`. Every ParamSpec.id is also the
// URL key (§6.7); `uniform` names the GLSL uniform the value drives (conversions in emboss.ts `apply`), or null for
// CPU-side consumers (the logo SDF texture, the paper micro-structure maps, the card thickness, the editor).
//
// Folders: logo (element type, image, sticker shape, placement, editor toggle) · relief (height field of the sculpted
// die) · foil (the hot-stamped holographic foil on the raised logo) · hologram (addendum A9: the volume-hologram
// sticker, generated from A5's VOLUME_PARAMS / volumeDial) · paper (the uncoated cotton stock around it) · seed.
//
// Addendum A9: `emboss.element` chooses the placed element — the foil logo (default; renders exactly as before A9) or
// a volume-hologram sticker of `emboss.shape` (square, rect, rounded, circle, oval, or the logo's outline) on the same
// relief. The hologram folder's controls are A5's, namespaced `emboss.holo.*`: generated from VOLUME_PARAMS and
// volumeDial (STICKER_HOLO_MAP), so later A5 changes reach the sticker; size, depth and backdrop depth are relative to
// the sticker's shorter side (the 3D image scales with the sticker), the coat roughness is the cover film's.
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec, ParamValue } from "../types.ts";
import { VOLUME_PARAMS, volumeDial } from "./volume.params.ts";

/** Built-in logos in public/logos/ (pure SVG paths, no text): value = path, label = picker name. */
export const LOGO_OPTIONS: { value: string; label: string }[] = [
  { value: "/logos/rosette.svg", label: "Rosette seal" },
  { value: "/logos/koru.svg", label: "Koru frond" },
  { value: "/logos/wordmark.svg", label: "HOLO wordmark" },
  { value: "/logos/leaf.svg", label: "Leaf" },
  { value: "/logos/facets.svg", label: "Faceted hexagon" },
];
export const LOGO_DEFAULT = "/logos/rosette.svg";

/** Relief profiles of `emboss.profile`, in `uRelProfile` order. */
export const EMBOSS_PROFILES = ["round", "bevel", "dome", "deboss"] as const;
export type EmbossProfile = (typeof EMBOSS_PROFILES)[number];
/** Foil types of `emboss.foil`, in `uFoilType` order. */
export const FOIL_TYPES = ["rainbow", "concentric", "sparkle", "silver", "gold"] as const;
export type FoilType = (typeof FOIL_TYPES)[number];
/** Paper stocks of `emboss.stock`, in `uPaperStock` order (also the paper-map generator's stock index). */
export const PAPER_STOCKS = ["cotton", "felt", "smooth", "laid", "linen", "kraft"] as const;
export type PaperStock = (typeof PAPER_STOCKS)[number];
/** A9: the placed element of `emboss.element`. */
export const EMBOSS_ELEMENTS = ["foil", "hologram"] as const;
export type EmbossElement = (typeof EMBOSS_ELEMENTS)[number];
/** A9: the sticker shapes of `emboss.shape` (physics/sticker.ts shapeGeometry). */
export const STICKER_SHAPES = ["square", "rect", "rounded", "circle", "oval", "svg"] as const;
export type StickerShape = (typeof STICKER_SHAPES)[number];

/** The element of a panel snapshot (default foil). */
export function embossElementOf(values: Readonly<Record<string, unknown>>): EmbossElement {
  return values["emboss.element"] === "hologram" ? "hologram" : "foil";
}
/** The sticker shape of a panel snapshot (default square). */
export function stickerShapeOf(values: Readonly<Record<string, unknown>>): StickerShape {
  const v = values["emboss.shape"];
  return typeof v === "string" && (STICKER_SHAPES as readonly string[]).includes(v) ? (v as StickerShape) : "square";
}

// ---------------------------------------------------------------------------------------------------------------
// A9 hologram folder, generated from A5's VOLUME_PARAMS and volumeDial
// ---------------------------------------------------------------------------------------------------------------

/** A5 volume parameters the sticker does not take: the card film's waviness and orange peel (the sticker lies on the
 *  paper, whose cockle and relief it follows) and the material seed (`emboss.seed` seeds the speckle). */
export const STICKER_HOLO_EXCLUDED: readonly string[] = ["volume.waviness", "volume.orangePeel", "volume.seed"];

/** A5 parameters whose unit becomes relative to the sticker (A9.4: the 3D image scales with the sticker): the panel key
 *  of the emboss control and its slider [default, min, max, step] in % of the sticker's shorter side. */
export const STICKER_HOLO_RELATIVE: Readonly<Record<string, { key: string; slider: [number, number, number, number]; meaning: string }>> = {
  "volume.size": { key: "size (% of short side)", slider: [80, 20, 200, 1],
    meaning: "Size of the recorded object (its longest dimension) in % of the sticker's shorter side: the image scales with the sticker" },
  "volume.depth": { key: "depth (% of short side)", slider: [-25, -150, 50, 0.5],
    meaning: "Depth of the object centre in % of the sticker's shorter side (negative = behind the film; parts may come forward)" },
  "volume.backdropDepth": { key: "backdrop depth (% of short side)", slider: [-100, -300, -15, 1],
    meaning: "Depth of the recorded background layer (grid, stars) in % of the sticker's shorter side" },
  // A10: the diffractive pattern scales with the sticker and lies just behind its film
  "volume.patternSize": { key: "size (% of short side)", slider: [50, 10, 300, 1],
    meaning: "Diffractive pattern: radius of the seal / scale of the pattern in % of the sticker's shorter side (50 = the seal spans the patch), centred on the sticker" },
  "volume.patternDepth": { key: "depth (% of short side)", slider: [-8, -60, 0, 0.5],
    meaning: "Diffractive pattern: depth of its plane behind the film in % of the sticker's shorter side (0 = on the film; shallow, as on real 2D/3D labels)" },
};

/** A10: sticker defaults that differ from A5's (the whole-card Volume Hologram keeps its grid backdrop and optical
 *  recording): the sticker opens on the diffractive guilloche seal, recorded as a stereogram (the image steps from view
 *  to view, as most commercial 3D stickers). Applied to the generated ParamSpec and its DialKit node. */
export const STICKER_HOLO_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  "volume.backdrop": "seal", "volume.recording": "stereogram",
  // A12: a pleasant default — the sticker's surface never whites out (the whole-card material keeps the physical mirror)
  "volume.glare": 0.15, "volume.viewBlend": 0.5, "volume.slit": 9,
};

/** Controls lifted out of the collapsed sub-folders to the top of the `hologram` folder (right under type and
 *  subject), so the background and the stop-motion are one click away: A5 id → panel key. */
export const STICKER_HOLO_TOP: Readonly<Record<string, string>> = {
  "volume.backdrop": "backdrop",
  "volume.recording": "stop-motion (recording)",
  "volume.views": "stop-motion views",
};

/** One generated hologram control: the emboss ParamSpec id, the A5 id it maps from, and whether it is relative. */
export interface StickerHoloEntry { id: string; from: string; relative: boolean }

/** emboss.holo.<suffix> of a volume.<suffix> id. */
const holoId = (volumeId: string) => `emboss.holo.${volumeId.slice("volume.".length)}`;
/** The emboss panel path of a volume panel path: under `hologram`, A5's `surface` folder becomes `film`. */
const holoPath = (volumePath: string, relKey?: string) => {
  const parts = volumePath.split(".");
  if (parts[0] === "surface") parts[0] = "film";
  if (relKey) parts[parts.length - 1] = relKey;
  return `hologram.${parts.join(".")}`;
};
function volumeNodeAt(path: string): unknown {
  let cur: unknown = volumeDial;
  for (const k of path.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/** The generated hologram ParamSpecs (A5's, mapped) and their A5 source ids, in VOLUME_PARAMS order. */
const HOLO_GENERATED: { spec: ParamSpec; entry: StickerHoloEntry; node: unknown }[] = VOLUME_PARAMS
  .filter((p) => !STICKER_HOLO_EXCLUDED.includes(p.id))
  .map((p) => {
    const rel = STICKER_HOLO_RELATIVE[p.id];
    const id = holoId(p.id), path = STICKER_HOLO_TOP[p.id] ? `hologram.${STICKER_HOLO_TOP[p.id]}` : holoPath(p.path, rel?.key);
    const spec: ParamSpec = rel
      ? { id, path, kind: "slider", default: rel.slider[0], min: rel.slider[1], max: rel.slider[2], step: rel.slider[3], unit: "%", meaning: rel.meaning, uniform: p.uniform }
      : { ...p, id, path, meaning: p.id === "volume.coatAlpha" ? "Roughness of the sticker's glossy cover film (A5's coat)" : p.meaning };
    // the A5 node, copied (the two panels never share config objects)
    const node = rel ? [...rel.slider] : JSON.parse(JSON.stringify(volumeNodeAt(p.path))) as unknown;
    const def = STICKER_HOLO_DEFAULTS[p.id];
    if (def !== undefined && !rel) {                              // A10: a sticker-specific default (select nodes)
      spec.default = def;
      if (Array.isArray(node)) node[0] = def;                     // a slider node [default, min, max, step]
      else if (node && typeof node === "object" && "default" in node) (node as Record<string, unknown>).default = def;
    }
    return { spec, entry: { id, from: p.id, relative: !!rel }, node };
  });

/** A9: the generated hologram controls (emboss id → A5 id). */
export const STICKER_HOLO_MAP: readonly StickerHoloEntry[] = HOLO_GENERATED.map((g) => g.entry);

/** A9: the A5 `volume.*` values of the sticker's `emboss.holo.*` values — the relative size, depth and backdrop depth
 *  (% of the sticker's shorter side `shortMm`) in mm, the seed from `emboss.seed` — for volume.ts applyVolumeUniforms. */
export function stickerVolumeValues(values: Readonly<Record<string, ParamValue>>, shortMm: number): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const e of STICKER_HOLO_MAP) {
    const v = values[e.id];
    if (v === undefined) continue;
    out[e.from] = e.relative && typeof v === "number" ? (v / 100) * shortMm : v;
  }
  out["volume.seed"] = values["emboss.seed"] ?? 7;
  return out;
}

/** A9: the film thickness of the sticker (the micro-step of its die-cut edge). */
const FILM_SPEC: ParamSpec = { id: "emboss.filmUm", path: "hologram.film.thickness (µm)", kind: "slider", default: 40, min: 10, max: 100, step: 1, unit: "µm",
  meaning: "Thickness of the sticker's laminate (photopolymer + cover film on a black backing): the step at its die-cut edge, which catches a thin specular line and casts a hairline shadow on the paper",
  uniform: "uFilmMm" };

/** A9: how far the sticker's film runs down the relief's walls. */
const FILM_WALL_SPEC: ParamSpec = { id: "emboss.filmWall", path: "hologram.film.down the walls", kind: "slider", default: 0, min: 0, max: 1, step: 0.01, unit: "—",
  meaning: "How far the sticker's film runs down the emboss walls: 0 = the patch lies on the raised plateau and the die's shoulder (paper) frames it, as when a sticker is laminated onto a blind-embossed pad; 1 = the film runs to the foot of the wall (the die is the sticker's shape)",
  uniform: "uFilmGrow" };

/** The `hologram` folder of the emboss panel: A5's controls (generated) and the film thickness; the sub-folders start
 *  collapsed (type and subject stay at the top). */
function hologramFolder(): DialConfig {
  const f: Record<string, unknown> = {};
  const put = (path: string, node: unknown) => {
    const parts = path.split(".").slice(1);                       // below `hologram`
    let cur = f;
    for (const k of parts.slice(0, -1)) cur = (cur[k] ??= { _collapsed: true }) as Record<string, unknown>;
    cur[parts[parts.length - 1]] = node;
  };
  // top-level controls first (type, subject, then STICKER_HOLO_TOP), then the collapsed sub-folders
  const top = (g: { spec: ParamSpec }) => g.spec.path.split(".").length === 2;
  for (const g of HOLO_GENERATED) if (top(g)) put(g.spec.path, g.node);
  for (const g of HOLO_GENERATED) if (!top(g)) put(g.spec.path, g.node);
  put(FILM_SPEC.path, [40, 10, 100, 1]);
  put(FILM_WALL_SPEC.path, [0, 0, 1, 0.01]);
  return f as DialConfig;
}

export const embossDial = {
  logo: {
    element: {
      type: "select",
      options: [
        { value: "foil", label: "Foil logo (hot-stamped)" },
        { value: "hologram", label: "Hologram sticker (3D)" },
      ],
      default: "foil",
    },
    logo: { type: "image", options: LOGO_OPTIONS, default: LOGO_DEFAULT },
    shape: {
      type: "select",
      options: [
        { value: "square", label: "Square" },
        { value: "rect", label: "Rectangle" },
        { value: "rounded", label: "Rounded rectangle" },
        { value: "circle", label: "Circle" },
        { value: "oval", label: "Oval" },
        { value: "svg", label: "Logo outline (SVG)" },
      ],
      default: "square",
    },
    "aspect (w / h)": [1, 0.25, 4, 0.01],
    "corner radius (mm)": [2.5, 0, 15, 0.1],
    "x (mm)": [31.5, -12.5, 75.5, 0.1],
    "y (mm)": [44, 0, 88, 0.1],
    "width (mm)": [36, 3, 63, 0.1],
    "rotation (°)": [0, -180, 180, 0.5],
    "edit logo": false,
  },
  relief: {
    "height (µm)": [450, 0, 1000, 5],
    "shoulder (mm)": [0.6, 0.05, 2, 0.01],
    profile: {
      type: "select",
      options: [
        { value: "round", label: "Rounded" },
        { value: "bevel", label: "Bevelled" },
        { value: "dome", label: "Sculpted dome" },
        { value: "deboss", label: "Debossed (pressed in)" },
      ],
      default: "round",
    },
    puff: [0.4, 0, 1, 0.01],
  },
  foil: {
    type: {
      type: "select",
      options: [
        { value: "rainbow", label: "Rainbow (linear grating)" },
        { value: "concentric", label: "Rainbow rings" },
        { value: "sparkle", label: "Sparkle" },
        { value: "silver", label: "Silver (no grating)" },
        { value: "gold", label: "Gold (no grating)" },
      ],
      default: "rainbow",
    },
    "pitch (nm)": [1000, 500, 2000, 5],
    "groove angle (°)": [120, 0, 180, 1],
    "foil coverage": [0.85, 0, 1, 0.01],
    "edge breakup": [0.35, 0, 1, 0.01],
    "paper show-through": [0.25, 0, 1, 0.01],
    gloss: [0.8, 0, 1, 0.01],
    "sparkle size (µm)": [160, 40, 600, 5],
    "bump map on foil": [0.25, 0, 1, 0.01],
  },
  hologram: hologramFolder(),
  // the image card: the user's picture printed on the paper; the card takes the picture's proportions
  print: {
    image: { type: "image", options: [], default: "" },
    "ink strength": [1, 0, 1, 0.01],
    upload: { type: "action", label: "Upload image…" },
    remove: { type: "action", label: "Remove image" },
  },
  paper: {
    colour: "#f3f1ea",
    stock: {
      type: "select",
      options: [
        { value: "cotton", label: "Cotton (letterpress)" },
        { value: "felt", label: "Felt-marked" },
        { value: "smooth", label: "Smooth uncoated" },
        { value: "laid", label: "Laid (lines)" },
        { value: "linen", label: "Linen embossed" },
        { value: "kraft", label: "Kraft" },
      ],
      default: "cotton",
    },
    "texture strength": [1, 0, 2, 0.01],
    "fibre amount": [0.55, 0, 1, 0.01],
    "fibre scale": [1, 0.5, 2, 0.01],
    "tooth (µm)": [7, 0, 30, 0.5],
    "formation contrast": [0.45, 0, 1, 0.01],
    roughness: [0.75, 0.2, 1, 0.01],
    sheen: [0.35, 0, 1, 0.01],
    translucency: [0.35, 0, 1, 0.01],
    "thickness (mm)": [0.8, 0.3, 1.2, 0.01],
    "cockle (°)": [0.12, 0, 1, 0.01],
    "bump map on paper": false,
  },
  "exposure (stops)": [0.6, -2, 2, 0.1],
  seed: [7, 1, 999, 1],
  // A11: the paper card's document (app/paperDoc.ts) as text — never shown as a control; "" = the single element
  // described by this panel's own logo / relief / foil / hologram values (every state saved before A11)
  doc: { type: "text", default: "" },
  reset: { type: "action", label: "Reset material" },
} satisfies DialConfig;

/** One ParamSpec per non-action control of `embossDial` (A6.1). */
export const EMBOSS_PARAMS: readonly ParamSpec[] = [
  { id: "emboss.element", path: "logo.element", kind: "select", default: "foil", options: [...EMBOSS_ELEMENTS], unit: "—",
    meaning: "The placed element: the hot-stamped foil logo, or a volume-hologram sticker (a 3D image at depth in a die-cut patch) on the same emboss; switching to the sticker in the panel sets a 30 mm square, 250 µm raised (once)",
    uniform: null },
  { id: "emboss.logo", path: "logo.logo", kind: "image", default: LOGO_DEFAULT, options: LOGO_OPTIONS.map((o) => o.value), unit: "—",
    meaning: "Logo artwork: a built-in SVG mark or an uploaded SVG / PNG (transparent = no logo); URL: rosette, koru, …, a same-origin path, none",
    uniform: "uLogoTex" },
  { id: "emboss.shape", path: "logo.shape", kind: "select", default: "square", options: [...STICKER_SHAPES], unit: "—",
    meaning: "Hologram sticker: die-cut shape — square (rounded corners), sharp rectangle, rounded rectangle, circle, oval, or the outline of the logo artwork",
    uniform: "uLogoShape" },
  { id: "emboss.aspect", path: "logo.aspect (w / h)", kind: "slider", default: 1, min: 0.25, max: 4, step: 0.01, unit: "—",
    meaning: "Hologram sticker: width / height of the rectangle, rounded rectangle and oval (square and circle: 1; logo outline: the artwork's)",
    uniform: "uShapeK" },
  { id: "emboss.cornerRadius", path: "logo.corner radius (mm)", kind: "slider", default: 2.5, min: 0, max: 15, step: 0.1, unit: "mm",
    meaning: "Hologram sticker: corner radius of the square and the rounded rectangle", uniform: "uShapeK" },
  { id: "emboss.x", path: "logo.x (mm)", kind: "slider", default: 31.5, min: -12.5, max: 75.5, step: 0.1, unit: "mm",
    meaning: "Logo centre, card x (from the left edge of the 63 mm card; a wider image card extends it to −12.5 … 75.5; other objects: offset from the face centre by x − 31.5)", uniform: "uLogoXf" },
  { id: "emboss.y", path: "logo.y (mm)", kind: "slider", default: 44, min: 0, max: 88, step: 0.1, unit: "mm",
    meaning: "Logo centre, card y (from the bottom edge; other objects: offset y − 44)", uniform: "uLogoXf" },
  { id: "emboss.width", path: "logo.width (mm)", kind: "slider", default: 36, min: 3, max: 63, step: 0.1, unit: "mm",
    meaning: "Width of the logo's artwork; its height follows the artwork's aspect ratio", uniform: "uLogoExt" },
  { id: "emboss.rotation", path: "logo.rotation (°)", kind: "slider", default: 0, min: -180, max: 180, step: 0.5, unit: "°",
    meaning: "Logo rotation, counter-clockwise", uniform: "uLogoXf" },
  { id: "emboss.edit", path: "logo.edit logo", kind: "toggle", default: false, unit: "—",
    meaning: "On-card logo editor (key E): the card faces the camera; click the logo, drag to move, drag a corner to scale", uniform: null },
  { id: "emboss.height", path: "relief.height (µm)", kind: "slider", default: 450, min: 0, max: 1000, step: 5, unit: "µm",
    meaning: "Emboss height of the logo above the paper (debossed: depth)", uniform: "uRelief" },
  { id: "emboss.shoulder", path: "relief.shoulder (mm)", kind: "slider", default: 0.6, min: 0.05, max: 2, step: 0.01, unit: "mm",
    meaning: "Wall width: horizontal run of the sculpted shoulder from the paper to the top", uniform: "uRelief" },
  { id: "emboss.profile", path: "relief.profile", kind: "select", default: "round", options: [...EMBOSS_PROFILES], unit: "—",
    meaning: "Die profile: rounded shoulders, a bevel, a sculpted (pillowed) dome, or pressed into the paper", uniform: "uRelProfile" },
  { id: "emboss.puff", path: "relief.puff", kind: "slider", default: 0.4, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Stretched-paper swell outside the wall (height up to 12 % of the emboss, reach 0.6–1.8 mm)", uniform: "uRelief" },
  { id: "emboss.foil", path: "foil.type", kind: "select", default: "rainbow", options: [...FOIL_TYPES], unit: "—",
    meaning: "Hot-stamping foil: linear rainbow grating, concentric rings, sparkle cells, plain silver or gold", uniform: "uFoilType" },
  { id: "emboss.pitch", path: "foil.pitch (nm)", kind: "slider", default: 1000, min: 500, max: 2000, step: 5, unit: "nm",
    meaning: "Grating period of the foil", uniform: "uInvD" },
  { id: "emboss.grooveAngle", path: "foil.groove angle (°)", kind: "slider", default: 120, min: 0, max: 180, step: 1, unit: "°",
    meaning: "Groove direction (rainbow foil), CCW from card +x; the grating rides on the embossed surface", uniform: "uGDir" },
  { id: "emboss.foilCoverage", path: "foil.foil coverage", kind: "slider", default: 0.85, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "How far the foil runs down the walls (1 = to the foot of the wall, 0 = top of the shoulder only)", uniform: "uFoil" },
  { id: "emboss.edgeBreakup", path: "foil.edge breakup", kind: "slider", default: 0.35, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Microscopically ragged foil edge and tiny voids in the paper's tooth valleys", uniform: "uFoil" },
  { id: "emboss.showThrough", path: "foil.paper show-through", kind: "slider", default: 0.25, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "How much of the paper's tooth telegraphs through the foil or the hologram sticker's film (relief and haze)", uniform: "uFoil" },
  { id: "emboss.gloss", path: "foil.gloss", kind: "slider", default: 0.8, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Foil top-coat gloss (1 = mirror-smooth lacquer, 0 = satin)", uniform: "uCoatAlpha" },
  { id: "emboss.sparkleSize", path: "foil.sparkle size (µm)", kind: "slider", default: 160, min: 40, max: 600, step: 5, unit: "µm",
    meaning: "Cell size of the sparkle foil (each cell its own grating orientation)", uniform: "uSparkleCell" },
  { id: "emboss.foilBump", path: "foil.bump map on foil", kind: "slider", default: 0.25, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Share of the scene's bump map on the foil and on the hologram sticker's cover film (the hot die's polish flattens surface texture; 1 = the full map)", uniform: "uFoilBump" },
  ...HOLO_GENERATED.map((g) => g.spec),
  FILM_SPEC,
  FILM_WALL_SPEC,
  { id: "emboss.print", path: "print.image", kind: "image", default: "", options: [], unit: "—",
    meaning: "Image card: the picture printed on the paper (an uploaded image, scaled to ≤ 1600 px); the card takes its proportions (long side 88 mm) and stickers sit on top; empty = the plain paper card",
    uniform: "uPrintTex" },
  { id: "emboss.printInk", path: "print.ink strength", kind: "slider", default: 1, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Image card: how strongly the ink covers the paper (1 = the picture as it is; lower = a faded print, the paper's colour showing through)",
    uniform: "uPrintK" },
  { id: "emboss.paperColour", path: "paper.colour", kind: "color", default: "#f3f1ea", unit: "—",
    meaning: "Paper colour (as-measured diffuse reflectance)", uniform: "uPaperRgb" },
  { id: "emboss.stock", path: "paper.stock", kind: "select", default: "cotton", options: [...PAPER_STOCKS], unit: "—",
    meaning: "Paper stock: selecting one writes its preset of the paper dials; also selects the stock's surface pattern", uniform: "uPaperStock" },
  { id: "emboss.textureStrength", path: "paper.texture strength", kind: "slider", default: 1, min: 0, max: 2, step: 0.01, unit: "—",
    meaning: "Overall strength of the paper micro-structure (relief and albedo)", uniform: "uPaperK" },
  { id: "emboss.fibreAmount", path: "paper.fibre amount", kind: "slider", default: 0.55, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Surface fibres per area (paper maps rebuilt)", uniform: null },
  { id: "emboss.fibreScale", path: "paper.fibre scale", kind: "slider", default: 1, min: 0.5, max: 2, step: 0.01, unit: "—",
    meaning: "Fibre length (×, 1 = 0.5–3 mm) and width (×√, 1 = 15–40 µm) (paper maps rebuilt)", uniform: null },
  { id: "emboss.tooth", path: "paper.tooth (µm)", kind: "slider", default: 7, min: 0, max: 30, step: 0.5, unit: "µm",
    meaning: "RMS height of the paper surface (tooth, fibres, felt marks)", uniform: "uPaperK" },
  { id: "emboss.formation", path: "paper.formation contrast", kind: "slider", default: 0.45, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Cloudy fibre-density mottling (1–6 mm) in albedo and translucency", uniform: "uPaperK" },
  { id: "emboss.roughness", path: "paper.roughness", kind: "slider", default: 0.75, min: 0.2, max: 1, step: 0.01, unit: "—",
    meaning: "Micro-roughness below the texture: Oren–Nayar σ and the sheen lobe width", uniform: "uPaperBrdf" },
  { id: "emboss.sheen", path: "paper.sheen", kind: "slider", default: 0.35, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Strength of the broad specular sheen of the uncoated surface (F0 0.04)", uniform: "uPaperBrdf" },
  { id: "emboss.translucency", path: "paper.translucency", kind: "slider", default: 0.35, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Light diffusing inside the cotton stock: wrapped diffuse, softened micro-shadows", uniform: "uPaperBrdf" },
  { id: "emboss.thickness", path: "paper.thickness (mm)", kind: "slider", default: 0.8, min: 0.3, max: 1.2, step: 0.01, unit: "mm",
    meaning: "Card thickness (heavy stock); the card edge shows the paper", uniform: null },
  { id: "emboss.waviness", path: "paper.cockle (°)", kind: "slider", default: 0.12, min: 0, max: 1, step: 0.01, unit: "°",
    meaning: "RMS slope of the paper's cockle (8–40 mm waviness of the sheet; A6's fixed 0.12°)", uniform: null },
  { id: "emboss.paperBump", path: "paper.bump map on paper", kind: "toggle", default: false, unit: "—",
    meaning: "The scene's bump map also on the paper (it always applies to the foil)", uniform: "uPaperBump" },
  { id: "emboss.exposure", path: "exposure (stops)", kind: "slider", default: 0.6, min: -2, max: 2, step: 0.1, unit: "stops",
    meaning: "Exposure compensation of this material on top of the display exposure (which is set for specular foil cards): a photographer exposes a white paper card for the paper", uniform: "uEmbExposure" },
  { id: "emboss.seed", path: "seed", kind: "slider", default: 7, min: 1, max: 999, step: 1, unit: "—",
    meaning: "Paper micro-structure, foil breakup and sparkle cells", uniform: "uSeed" },
  { id: "emboss.doc", path: "doc", kind: "text", default: "", unit: "—",
    meaning: "A11: the paper card's elements as compact JSON (app/paperDoc.ts; several logos and hologram stickers, each with its own settings); empty = the single element of the values above",
    uniform: null },
];

/** A9.2 default sticker, written once when the user switches `emboss.element` to `hologram` in the panel (never for a
 *  URL, a saved version, a view or a reset): a 30 mm square with 2.5 mm corners, centred, raised 250 µm, round. */
export const STICKER_PRESET: Readonly<Record<string, ParamValue>> = {
  "emboss.shape": "square", "emboss.cornerRadius": 2.5, "emboss.width": 30, "emboss.x": 31.5, "emboss.y": 44,
  "emboss.height": 250, "emboss.profile": "round",
};
/** The element presets (foil: none — the foil keeps its values). */
export const ELEMENT_PRESETS: Readonly<Record<string, Readonly<Record<string, ParamValue>>>> = { hologram: STICKER_PRESET };

/** Paper-stock presets (A6.1): selecting `emboss.stock` writes these dials (unlisted dials keep their values). */
export const STOCK_PRESETS: Readonly<Record<PaperStock, Readonly<Record<string, ParamValue>>>> = {
  cotton: {
    "emboss.paperColour": "#f3f1ea", "emboss.textureStrength": 1, "emboss.fibreAmount": 0.55, "emboss.fibreScale": 1,
    "emboss.tooth": 7, "emboss.formation": 0.45, "emboss.roughness": 0.75, "emboss.sheen": 0.35, "emboss.translucency": 0.35,
  },
  felt: {
    "emboss.paperColour": "#f2efe7", "emboss.textureStrength": 1.15, "emboss.fibreAmount": 0.45, "emboss.fibreScale": 1,
    "emboss.tooth": 10, "emboss.formation": 0.4, "emboss.roughness": 0.8, "emboss.sheen": 0.3, "emboss.translucency": 0.3,
  },
  smooth: {
    "emboss.paperColour": "#f5f4f0", "emboss.textureStrength": 0.7, "emboss.fibreAmount": 0.3, "emboss.fibreScale": 0.8,
    "emboss.tooth": 3, "emboss.formation": 0.3, "emboss.roughness": 0.55, "emboss.sheen": 0.5, "emboss.translucency": 0.25,
  },
  laid: {
    "emboss.paperColour": "#efe9dc", "emboss.textureStrength": 1, "emboss.fibreAmount": 0.45, "emboss.fibreScale": 1.1,
    "emboss.tooth": 6, "emboss.formation": 0.55, "emboss.roughness": 0.7, "emboss.sheen": 0.35, "emboss.translucency": 0.4,
  },
  linen: {
    "emboss.paperColour": "#f5f3ee", "emboss.textureStrength": 1, "emboss.fibreAmount": 0.35, "emboss.fibreScale": 0.9,
    "emboss.tooth": 4.5, "emboss.formation": 0.3, "emboss.roughness": 0.65, "emboss.sheen": 0.4, "emboss.translucency": 0.3,
  },
  kraft: {
    "emboss.paperColour": "#b48c63", "emboss.textureStrength": 1.2, "emboss.fibreAmount": 0.85, "emboss.fibreScale": 1.4,
    "emboss.tooth": 8, "emboss.formation": 0.6, "emboss.roughness": 0.8, "emboss.sheen": 0.25, "emboss.translucency": 0.15,
  },
};
