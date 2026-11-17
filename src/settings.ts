// Settings: holo.spot's parameter tables, the looks the site ships, and how a caller's settings resolve.
//
// A look resolves in holo.spot's own order: the parameter's default, then what the site ships for that kind of object
// on that material, then the caller's settings. So `holo.apply(mesh, { material: "nebula" })` with no settings gives
// the Nebula that holo.spot's 3D object opens with, and a "Copy settings" blob from the site lands on the same values
// it was copied from.
import type { Background, ParamValue, ParamValues, SpdId, StudioValues, ToneCurve, Vec2 } from "../engine/types.ts";
import { MATERIAL_IDS, SPD_IDS } from "../engine/types.ts";
import type { MaterialId } from "../engine/types.ts";
import { DEFAULT_F_STOP, DEFAULT_LENS_MM, F_STOPS, FOCUS_MODES } from "../engine/physics/lens.ts";
import type { FocusMode } from "../engine/physics/lens.ts";
import paramsJson from "./data/params.json" with { type: "json" };
import looksJson from "./data/looks.json" with { type: "json" };
import presetsJson from "./data/studio-presets.json" with { type: "json" };

export interface ParamInfo {
  id: string; kind: string; default: ParamValue; min?: number; max?: number; step?: number;
  options?: string[]; unit: string; meaning: string;
}
/** A holo.spot entity: the kind of object a shipped look belongs to. */
export type EntityId = "card" | "object" | "image" | "cloth" | "stickers" | "flag";
/** A look to start from: one of holo.spot's entities, or `plain` (the bare parameter defaults, as a holo.spot URL
 *  without an entity gives). */
export type LookId = EntityId | "plain";
export interface View { az: number; el: number; zoom: number; offset: readonly [number, number, number] }
export interface Pose { rx: number; ry: number; rz: number; flip: boolean }
interface Surface { values: Record<string, ParamValue>; view: View; pose: Pose }
interface Look { title: string; material: MaterialId; quality: "low" | "medium" | "high"; surfaces: Partial<Record<MaterialId, Surface>> }

const P = paramsJson as unknown as {
  scene: ParamInfo[]; materials: Record<MaterialId, ParamInfo[]>;
  presets?: Partial<Record<MaterialId, Record<string, Record<string, Record<string, ParamValue>>>>>;
};
const LOOKS = looksJson as unknown as Record<EntityId, Look>;

/** Every scene-level parameter (lights, display, grain, bump map, depth of field, card finish). */
export const SCENE_PARAMS: readonly ParamInfo[] = P.scene;
/** Every parameter of each material. */
export const MATERIAL_PARAMS: Readonly<Record<MaterialId, readonly ParamInfo[]>> = P.materials;
/** holo.spot's lighting presets (`studio.preset`): each is a set of `studio.*` values. */
export const STUDIO_PRESETS = presetsJson as unknown as Readonly<Record<string, Readonly<Record<string, ParamValue>>>>;
export const LOOK_IDS: readonly LookId[] = ["card", "object", "image", "cloth", "stickers", "flag", "plain"];

const SCENE_IDS = new Map(P.scene.map((p) => [p.id, p]));
const MATERIAL_ID_MAPS = Object.fromEntries(MATERIAL_IDS.map((m) => [m, new Map(P.materials[m].map((p) => [p.id, p]))])) as Record<MaterialId, Map<string, ParamInfo>>;

export function isMaterialId(v: unknown): v is MaterialId {
  return typeof v === "string" && (MATERIAL_IDS as readonly string[]).includes(v);
}

/** A "Copy settings" blob from holo.spot (the `</>` button of the Object tab). */
export interface CopyBlob {
  holoDev: 1; entity: EntityId; material: string; values: Record<string, ParamValue>;
  view?: View; pose?: Pose; assets?: Record<string, string>;
}
/** Settings as a caller may give them: a Copy settings blob, or a flat map of parameter ids to values. */
export type SettingsInput = CopyBlob | Readonly<Record<string, ParamValue>> | null | undefined;

export function isCopyBlob(s: unknown): s is CopyBlob {
  return !!s && typeof s === "object" && (s as CopyBlob).holoDev === 1 && typeof (s as CopyBlob).values === "object";
}

export interface Resolved {
  look: LookId; material: MaterialId;
  /** Every scene parameter, by id. */
  scene: Record<string, ParamValue>;
  /** Every parameter of `material`, by id. */
  values: Record<string, ParamValue>;
  /** How holo.spot frames and tilts this look (for callers that want the same shot). */
  view: View; pose: Pose;
  /** Ids in the settings that are not parameters of the scene or of this material. */
  unknown: string[];
  /** The SVG artwork a Copy settings blob carried ("asset:<name>" references), by name. */
  assets: Record<string, string>;
}

const clone = <T>(v: T): T => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) as T : v);

/** Resolves a look: parameter defaults ← what holo.spot ships for `look` on `material` ← `settings`. A Copy settings
 *  blob brings its own entity and material; `material` and `look`, when given, win over the blob's. */
export function resolveSettings(o: { material?: string; look?: LookId; settings?: SettingsInput }): Resolved {
  const blob = isCopyBlob(o.settings) ? o.settings : null;
  const look: LookId = o.look ?? (blob && LOOK_IDS.includes(blob.entity) ? blob.entity : "object");
  const wanted = o.material ?? blob?.material ?? (look === "plain" ? "prism" : LOOKS[look].material);
  if (!isMaterialId(wanted)) throw new Error(`holo: unknown material "${wanted}" (one of ${MATERIAL_IDS.join(", ")})`);
  const material = wanted;
  // a look that holo.spot does not ship on this material (the paper card on a foil) falls back to the 3D object's
  const shipped = look === "plain" ? null : LOOKS[look].surfaces[material] ?? LOOKS.object.surfaces[material] ?? LOOKS.cloth.surfaces[material];
  const scene: Record<string, ParamValue> = {}, values: Record<string, ParamValue> = {};
  for (const p of P.scene) scene[p.id] = clone(p.default);
  for (const p of P.materials[material]) values[p.id] = clone(p.default);
  const unknown: string[] = [];
  const write = (id: string, v: ParamValue, strict: boolean) => {
    if (SCENE_IDS.has(id)) scene[id] = clone(v);
    else if (MATERIAL_ID_MAPS[material].has(id)) values[id] = clone(v);
    else if (strict && !MATERIAL_IDS.some((m) => m !== material && MATERIAL_ID_MAPS[m].has(id))) unknown.push(id);
  };
  if (shipped) for (const [id, v] of Object.entries(shipped.values)) write(id, v, false);
  const given = blob ? blob.values : (o.settings as Record<string, ParamValue> | null | undefined) ?? {};
  // `studio.preset` first, so explicit light values given with it win
  const preset = given["studio.preset"];
  if (typeof preset === "string" && STUDIO_PRESETS[preset]) for (const [id, v] of Object.entries(STUDIO_PRESETS[preset])) write(id, v, false);
  // likewise a material's own preset selects (the paper stock writes the paper's values, as choosing it on holo.spot does)
  for (const [id, options] of Object.entries(P.presets?.[material] ?? {})) {
    const choice = given[id];
    if (typeof choice === "string" && options[choice]) for (const [k, v] of Object.entries(options[choice])) write(k, v, false);
  }
  for (const [id, v] of Object.entries(given)) if (v !== undefined) write(id, v, true);
  scene["scene.material"] = material;
  return {
    look, material, scene, values, unknown,
    view: blob?.view ?? shipped?.view ?? { az: 0, el: 0, zoom: 1, offset: [0, 0, 0] },
    pose: blob?.pose ?? shipped?.pose ?? { rx: 0, ry: 0, rz: 0, flip: false },
    assets: blob?.assets ?? {},
  };
}

/** What a material's preset selects write for the choices in `given` (the paper stock's paper values), by id. */
export function materialPresetWrites(material: MaterialId, given: Readonly<Record<string, ParamValue>>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [id, options] of Object.entries(P.presets?.[material] ?? {})) {
    const choice = given[id];
    if (typeof choice === "string" && options[choice]) for (const [k, v] of Object.entries(options[choice])) if (MATERIAL_ID_MAPS[material].has(k)) out[k] = clone(v);
  }
  return out;
}

/** The material a look opens with on holo.spot, and the quality the site ships it at. */
export function lookInfo(look: LookId): { title: string; material: MaterialId; quality: "low" | "medium" | "high"; materials: MaterialId[] } {
  if (look === "plain") return { title: "Parameter defaults", material: "prism", quality: "medium", materials: [...MATERIAL_IDS] };
  const l = LOOKS[look];
  return { title: l.title, material: l.material, quality: l.quality, materials: Object.keys(l.surfaces) as MaterialId[] };
}

// ---- scene values → what the engine takes. These follow holo.spot's app/state.ts (appStateFrom and its helpers)
// line for line; the parity check compares the two pictures.

const num = (v: ParamValues, id: string, d: number): number => { const x = v[id]; return typeof x === "number" && Number.isFinite(x) ? x : d; };
const bool = (v: ParamValues, id: string, d: boolean): boolean => { const x = v[id]; return typeof x === "boolean" ? x : d; };
const str = (v: ParamValues, id: string, d: string): string => { const x = v[id]; return typeof x === "string" ? x : d; };
const pick = <T extends string>(v: ParamValues, id: string, options: readonly T[], d: T): T => {
  const x = v[id];
  return typeof x === "string" && (options as readonly string[]).includes(x) ? (x as T) : d;
};
const vec = (v: ParamValues, id: string, d: Vec2): Vec2 => {
  const x = v[id] as Vec2 | undefined;
  return x && typeof x === "object" && typeof x.x === "number" && typeof x.y === "number" ? { x: x.x, y: x.y } : d;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

function light(v: ParamValues, k: string, d: { on: boolean; dir: Vec2; radiance: number; distanceM: number }) {
  return {
    on: bool(v, `studio.${k}.on`, d.on),
    dir: vec(v, `studio.${k}.dir`, d.dir),
    radiance: Math.max(num(v, `studio.${k}.radiance`, d.radiance), 0),
    distanceM: Math.max(num(v, `studio.${k}.distance`, d.distanceM), 0.05),
    spd: pick<SpdId>(v, `studio.${k}.spd`, SPD_IDS, "equal"),
  };
}

export function studioFromValues(v: ParamValues): StudioValues {
  return {
    panel: {
      ...light(v, "panel", { on: true, dir: { x: -0.48, y: 0.66 }, radiance: 4, distanceM: 0.9 }),
      widthDeg: num(v, "studio.panel.width", 14), lengthDeg: num(v, "studio.panel.length", 50),
    },
    spotA: { ...light(v, "spotA", { on: true, dir: { x: -0.04, y: -0.1 }, radiance: 1200, distanceM: 1 }), sizeDeg: num(v, "studio.spotA.size", 1.5) },
    spotB: { ...light(v, "spotB", { on: true, dir: { x: -0.25, y: -0.68 }, radiance: 600, distanceM: 1.2 }), sizeDeg: num(v, "studio.spotB.size", 2.5) },
    spotC: { ...light(v, "spotC", { on: false, dir: { x: 0.21, y: -0.37 }, radiance: 1200, distanceM: 1 }), sizeDeg: num(v, "studio.spotC.size", 1) },
    ambient: {
      rims: num(v, "studio.ambient.rims", 3), fill: num(v, "studio.ambient.fill", 0.4), scrim: num(v, "studio.ambient.scrim", 0.4),
      cameraSide: num(v, "studio.ambient.cameraSide", 0.004), cameraTexture: num(v, "studio.ambient.cameraTexture", 1),
      backdrop: num(v, "studio.ambient.backdrop", 1), rotationDeg: num(v, "studio.ambient.rotation", 0),
    },
    flash: {
      sizeMm: num(v, "studio.flash.size", 8.5), distanceM: num(v, "studio.flash.distance", 0.3),
      radiance: Math.max(num(v, "studio.flash.radiance", 1500), 0), spd: pick<SpdId>(v, "studio.flash.spd", SPD_IDS, "equal"),
    },
  };
}

export interface DofState {
  on: boolean; fNumber: number; focus: FocusMode; point: { x: number; y: number; z: number }; distanceCm: number; offsetMm: number;
  lensMm: number; blades: number; bladeCurve: number; bladeAngleDeg: number; catsEye: number; rim: number; loca: number;
}
export function dofFromValues(v: ParamValues): DofState {
  const p = vec(v, "dof.point", { x: 0, y: 0 });
  return {
    on: bool(v, "dof.on", false),
    fNumber: Number(pick(v, "dof.fstop", F_STOPS, DEFAULT_F_STOP)),
    focus: pick<FocusMode>(v, "dof.focus", FOCUS_MODES, "object"),
    point: { x: p.x, y: p.y, z: num(v, "dof.pointZ", 0) },
    distanceCm: clamp(num(v, "dof.distance", 32), 5, 200),
    offsetMm: clamp(num(v, "dof.offset", 0), -50, 50),
    lensMm: clamp(num(v, "dof.lens", DEFAULT_LENS_MM), 24, 200),
    blades: Number(pick(v, "dof.blades", ["0", "5", "6", "7", "8", "9", "10", "11"], "9")),
    bladeCurve: clamp(num(v, "dof.bladeCurve", 0.6), 0, 1),
    bladeAngleDeg: num(v, "dof.bladeAngle", 0),
    catsEye: clamp(num(v, "dof.catsEye", 0.3), 0, 1),
    rim: clamp(num(v, "dof.rim", 0.15), -1, 1),
    loca: clamp(num(v, "dof.loca", 0.2), 0, 1),
  };
}

export interface SceneState {
  background: Background; bgColor: string;
  /** The printed layer of a card (`scene.print`): none, or holo.spot's art, window or frame layout. */
  print: "art" | "window" | "frame" | "none";
  studio: StudioValues;
  display: { ev: number; tone: ToneCurve; glare: number; glareRadiusPx: number; wideGamut: boolean };
  grain: { on: boolean; amount: number; sizePx: number; animated: boolean; colour: "mono" | "rgb"; onBackground: boolean };
  card: {
    bowMm: number; bowAxis: "across" | "along"; cornerMm: number; thicknessMm: number;
    emboss: "none" | "lines" | "crosshatch"; embossPitchMm: number; embossHeightUm: number; embossLayer: "foil" | "varnish";
    border: "ink" | "foil"; borderColor: string; backColor: string; edgeSilver: boolean; wear: number;
  };
  bump: { map: string; strength: number; tiling: number; layer: "foil" | "varnish"; invert: boolean };
  dof: DofState;
  object: { modelSizeMm: number; modelMapping: "auto" | "uv" | "box" | "sphere"; structureScale: number; doubleSided: boolean };
}

export const BG_COLOUR_DEFAULT = "#3a4458";

export function hexColour(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return fallback;
}
export function linearOfHex(hex: string): [number, number, number] {
  const h = hexColour(hex, "#000000"), lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
}
export function backgroundLinear(bg: Background, hex: string): [number, number, number] {
  return bg === "white" ? [1, 1, 1] : bg === "colour" ? linearOfHex(hex) : [0, 0, 0];
}
/** Lightness of the page for the lighting adaptation: 0 on black, 1 on white, a colour's luminance between. */
export function backgroundTone(bg: Background, hex: string): number {
  if (bg !== "colour") return bg === "white" ? 1 : 0;
  const [r, g, b] = linearOfHex(hex);
  return clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
}
/** Linear exposure multiplier for the output pass: 2^(EV − 0.2·tone). */
export function exposureMultiplier(ev: number, tone: number): number {
  return Math.pow(2, ev - 0.2 * clamp(tone, 0, 1));
}

export function sceneStateFrom(scene: ParamValues): SceneState {
  return {
    background: pick<Background>(scene, "scene.background", ["black", "white", "colour"], "white"),
    bgColor: hexColour(scene["scene.bgColor"], BG_COLOUR_DEFAULT),
    print: pick<"art" | "window" | "frame" | "none">(scene, "scene.print", ["art", "window", "frame", "none"], "none"),
    studio: studioFromValues(scene),
    display: {
      ev: num(scene, "display.ev", 0.5),
      tone: pick<ToneCurve>(scene, "display.tone", ["neutral", "agx", "clamp"], "neutral"),
      glare: Math.max(num(scene, "display.glare", 0.03), 0),
      glareRadiusPx: Math.max(num(scene, "display.glareRadius", 8), 0.5),
      wideGamut: bool(scene, "display.wideGamut", true),
    },
    grain: {
      on: bool(scene, "grain.on", true),
      amount: clamp(num(scene, "grain.amount", 0.18), 0, 0.6),
      sizePx: clamp(num(scene, "grain.size", 1), 1, 4),
      animated: bool(scene, "grain.animated", true),
      colour: pick<"mono" | "rgb">(scene, "grain.colour", ["mono", "rgb"], "mono"),
      onBackground: bool(scene, "grain.onBackground", false),
    },
    card: {
      bowMm: num(scene, "card.bow", 1.6),
      bowAxis: pick<"across" | "along">(scene, "card.bowAxis", ["across", "along"], "across"),
      cornerMm: num(scene, "card.corner", 3.2),
      thicknessMm: num(scene, "card.thickness", 0.33),
      emboss: pick<"none" | "lines" | "crosshatch">(scene, "card.emboss", ["none", "lines", "crosshatch"], "crosshatch"),
      embossPitchMm: Math.max(num(scene, "card.embossPitch", 1.17), 0.01),
      embossHeightUm: Math.max(num(scene, "card.embossHeight", 0.5), 0),
      embossLayer: pick<"foil" | "varnish">(scene, "card.embossLayer", ["foil", "varnish"], "varnish"),
      border: pick<"ink" | "foil">(scene, "card.border", ["ink", "foil"], "ink"),
      borderColor: str(scene, "card.borderColor", "#ece9e2"),
      backColor: str(scene, "card.backColor", "#22304a"),
      edgeSilver: bool(scene, "card.edgeSilver", true),
      wear: clamp(num(scene, "card.wear", 0.16), 0, 1),
    },
    bump: {
      map: str(scene, "bump.map", ""),
      strength: Math.max(num(scene, "bump.strength", 0.78), 0),
      tiling: Math.max(num(scene, "bump.tiling", 3.5), 0.01),
      layer: pick<"foil" | "varnish">(scene, "bump.layer", ["foil", "varnish"], "foil"),
      invert: bool(scene, "bump.invert", true),
    },
    dof: dofFromValues(scene),
    object: {
      modelSizeMm: clamp(num(scene, "object.modelSize", 90), 20, 400),
      modelMapping: pick<"auto" | "uv" | "box" | "sphere">(scene, "object.modelMapping", ["auto", "uv", "box", "sphere"], "auto"),
      structureScale: clamp(num(scene, "object.structureScale", 1), 0.25, 4),
      doubleSided: bool(scene, "object.doubleSided", true),
    },
  };
}
