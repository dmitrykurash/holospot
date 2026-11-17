// Addendum A11 stage 2: the paper card's document — an ordered list of placed elements (bottom → top), each a foil
// logo or a hologram sticker with its own name, visibility, placement, relief and type-specific settings.
// Pure module (spec §6.1): type-only and pure imports, so `node --test` imports it.
//
// Where it lives: in the Foil Emboss panel itself, as the text value `emboss.doc` (materials/emboss.params.ts). The
// panel therefore stays the single source of truth, and DialKit's persistence (`holo:v1:mat-emboss`), its saved
// versions, view presets, URLs and `__holo.setState` carry the document with no storage of their own.
//   • `emboss.doc` = "" — the document is the ONE element described by the panel's own element values
//     (`emboss.element`, `emboss.logo`, `emboss.x`, …, `emboss.holo.*`): every URL, saved version and view made before
//     A11 is such a state and loads as a one-element document.
//   • otherwise — compact JSON: {"v":1,"e":[{"i":"e2","t":"h","n":"Sticker 2","h":1,"p":{"x":20,"holo.subject":"wolf"}}]}
//     (t: f = foil logo, h = hologram sticker; h: 1 = hidden; p: the element's values that differ from the type's
//     defaults, keyed by the ParamSpec id without "emboss."). The panel's own element values are then not used.
// A document that IS a single default-named visible element is always written in the first form (docValues), so a
// one-element card is byte-for-byte the pre-A11 state: same URL keys, same saved versions, same render.
//
// Addendum A14 (the flag's stickers): an element's position (`emboss.x`, `emboss.y`, card mm) may lie anywhere on the
// largest flag's face and its width (`emboss.width`) reach that flag's longer side, 750 mm (logoEditorMath.ts
// PLACEMENT_WIDE), not only the panel's card ranges: the JSON form keeps them (the decoder clamps to those ranges), a
// single element beyond the card's ranges is written in the JSON form (the legacy form's panel sliders hold only the
// card's), and on a card such an element is drawn as it is — off the card, or larger than it and cut by its outline.
//
// An element's values are keyed by the same ParamSpec ids as the panel's (ELEMENT_PARAMS ⊂ EMBOSS_PARAMS), so
// `elementValues(panelValues, element)` — the panel's paper values with one element's values over them — is a complete
// Foil Emboss snapshot that every existing consumer (materials/emboss.ts apply, the logo editor, the assets) reads.
import type { ParamSpec, ParamValue, ParamValues } from "../types.ts";
import { EMBOSS_PARAMS, STICKER_PRESET, embossElementOf } from "../materials/emboss.params.ts";
import type { EmbossElement } from "../materials/emboss.params.ts";
import { sameValue, sanitizeValue } from "../ui/dialConfig.ts";
import { PLACEMENT_WIDE, faceRange } from "../ui/logoEditorMath.ts";

export const DOC_ID = "emboss.doc";
/** The most elements a card holds. Six: the multi-element shader keeps every element's uniforms in arrays of this
 *  length (≈ 40 uniforms each) and tests each against the pixel; six stays far below the uniform limits of phones and
 *  costs nothing visible on a laptop GPU, and a 63 × 88 mm card has no room for more. */
export const MAX_ELEMENTS = 6;
/** Distinct SVG artworks and distinct hologram subjects among the visible elements (the multi-element shader's texture
 *  units: WebGL 2 guarantees 16 per fragment shader, 11 are taken). */
export const MAX_LOGOS = 4;
export const MAX_SUBJECTS = 4;

export type ElementType = EmbossElement;
export interface DocElement { id: string; type: ElementType; name: string; visible: boolean; values: Record<string, ParamValue> }
export interface PaperDoc { elements: DocElement[] }

const P = "emboss.";
/** The parameters an element owns: the panel's logo (but not the type select or the editor toggle), relief, foil and
 *  hologram folders. Everything else (paper, exposure, seed) belongs to the card. */
export const ELEMENT_PARAMS: readonly ParamSpec[] = EMBOSS_PARAMS.filter((p) =>
  /^(logo|relief|foil|hologram)\./.test(p.path) && p.id !== "emboss.element" && p.id !== "emboss.edit");
export const ELEMENT_IDS: ReadonlySet<string> = new Set(ELEMENT_PARAMS.map((p) => p.id));
/** Ids that describe the legacy single element (a URL or view that sets one of them without a document means it). */
export const isLegacyElementKey = (id: string) => id === "emboss.element" || ELEMENT_IDS.has(id);

const clone = (v: ParamValue): ParamValue => (typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) as ParamValue : v);
const DEFAULTS: Readonly<Record<string, ParamValue>> = Object.fromEntries(ELEMENT_PARAMS.map((p) => [p.id, p.default]));

/** The values a new element of a type starts with (a hologram sticker: the A9 default sticker). */
export function elementDefaults(type: ElementType): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(DEFAULTS)) out[k] = clone(v);
  if (type === "hologram") Object.assign(out, STICKER_PRESET);
  return out;
}
export const defaultName = (type: ElementType, n: number) => `${type === "hologram" ? "Sticker" : "Logo"} ${n}`;
export const typeLabel = (type: ElementType) => (type === "hologram" ? "Hologram sticker" : "Foil logo");

// ---- reading -------------------------------------------------------------------------------------------------------

/** The compact JSON of a document (always the JSON form; docValues decides between it and the legacy form). */
export function encodeDoc(doc: PaperDoc): string {
  return JSON.stringify({
    v: 1,
    e: doc.elements.map((el) => {
      const base = elementDefaults(el.type), p: Record<string, ParamValue> = {};
      for (const s of ELEMENT_PARAMS) {
        const v = el.values[s.id];
        if (v !== undefined && !sameValue(v, base[s.id])) p[s.id.slice(P.length)] = v;
      }
      return { i: el.id, t: el.type === "hologram" ? "h" : "f", n: el.name, ...(el.visible ? {} : { h: 1 }), p };
    }),
  });
}

/** Parses the JSON form; null when it is not a document (the caller falls back to the legacy element). Unknown keys
 *  and invalid values are dropped (the type's default stands), elements beyond MAX_ELEMENTS are cut. */
export function decodeDoc(text: string): PaperDoc | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== "object" || !Array.isArray((j as { e?: unknown }).e)) return null;
  const elements: DocElement[] = [], seen = new Set<string>();
  for (const raw of (j as { e: unknown[] }).e.slice(0, MAX_ELEMENTS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type: ElementType = r.t === "h" ? "hologram" : "foil";
    const values = elementDefaults(type);
    if (r.p && typeof r.p === "object") {
      for (const s of ELEMENT_PARAMS) {
        const v = sanitizeValue(s, (r.p as Record<string, unknown>)[s.id.slice(P.length)]);
        if (v === undefined) continue;
        const [lo, hi] = rangeOf(s);
        values[s.id] = s.kind === "slider" && typeof v === "number" ? Math.min(Math.max(v, lo), hi) : v;
      }
    }
    let id = typeof r.i === "string" && /^[a-z0-9]{1,12}$/i.test(r.i) ? r.i : "";
    if (!id || seen.has(id)) id = nextId({ elements });
    seen.add(id);
    const name = typeof r.n === "string" && r.n.trim() ? r.n.trim().slice(0, 40) : defaultName(type, elements.length + 1);
    elements.push({ id, type, name, visible: r.h !== 1 && r.h !== true, values });
  }
  return { elements };
}

const cache = new WeakMap<object, PaperDoc>();

/** The document of a Foil Emboss snapshot (cached per snapshot object; treat the result as read-only). */
export function docOf(values: ParamValues): PaperDoc {
  const hit = cache.get(values);
  if (hit) return hit;
  const text = values[DOC_ID];
  let doc = typeof text === "string" && text.trim() !== "" ? decodeDoc(text) : null;
  if (!doc) {
    const type = embossElementOf(values), v: Record<string, ParamValue> = {};
    for (const s of ELEMENT_PARAMS) v[s.id] = clone(values[s.id] ?? s.default);
    doc = { elements: [{ id: "e1", type, name: defaultName(type, 1), visible: true, values: v }] };
  }
  cache.set(values, doc);
  return doc;
}

export const visibleElements = (doc: PaperDoc): DocElement[] => doc.elements.filter((e) => e.visible);

/** A complete Foil Emboss snapshot showing one element: the panel's paper values with the element's over them
 *  (null: no element — no logo, no relief). Cached per (snapshot, element). */
const fxCache = new WeakMap<object, Map<string, ParamValues>>();
export function elementValues(values: ParamValues, el: DocElement | null): ParamValues {
  let m = fxCache.get(values);
  if (!m) fxCache.set(values, (m = new Map()));
  const key = el ? el.id : "";
  let out = m.get(key);
  if (!out) {
    out = el ? { ...values, ...el.values, "emboss.element": el.type }
      : { ...values, "emboss.element": "foil", "emboss.logo": "", "emboss.height": 0, "emboss.puff": 0 };
    m.set(key, out);
  }
  return out;
}

/** The snapshot of the card's first visible element (the whole card while at most one is visible). */
export function primaryValues(values: ParamValues): ParamValues {
  return elementValues(values, visibleElements(docOf(values))[0] ?? null);
}

// ---- writing -------------------------------------------------------------------------------------------------------

/** True when the document is exactly what the legacy form expresses: one visible, default-named element "e1". */
export function isLegacyDoc(doc: PaperDoc): boolean {
  const e = doc.elements[0];
  return doc.elements.length === 1 && e.visible && e.id === "e1" && e.name === defaultName(e.type, 1)
    && ["emboss.x", "emboss.y", "emboss.width"].every((id) => onCardFrame(id, e.values[id]));   // A14: beyond the card's ranges: JSON
}

/** The panel values (by ParamSpec id) that store a document: the legacy form whenever it can express it. */
export function docValues(doc: PaperDoc): Record<string, ParamValue> {
  if (!isLegacyDoc(doc)) return { [DOC_ID]: encodeDoc(doc) };
  const e = doc.elements[0], out: Record<string, ParamValue> = { [DOC_ID]: "", "emboss.element": e.type };
  for (const s of ELEMENT_PARAMS) out[s.id] = clone(e.values[s.id] ?? s.default);
  return out;
}

export function nextId(doc: PaperDoc): string {
  let n = 1;
  for (const e of doc.elements) { const m = /^e(\d+)$/.exec(e.id); if (m) n = Math.max(n, Number(m[1]) + 1); }
  while (doc.elements.some((e) => e.id === `e${n}`)) n++;
  return `e${n}`;
}

function freeName(doc: PaperDoc, type: ElementType): string {
  for (let n = 1; ; n++) { const name = defaultName(type, n); if (!doc.elements.some((e) => e.name === name)) return name; }
}

const copy = (doc: PaperDoc): PaperDoc => ({ elements: doc.elements.map((e) => ({ ...e, values: { ...e.values } })) });
const clampTo = (id: string, x: number) => { const s = ELEMENT_PARAMS.find((p) => p.id === id); return Math.min(Math.max(x, s?.min ?? -Infinity), s?.max ?? Infinity); };
/** A14: a slider's stored range in the document: the widest placement frame for the position and the width, the
 *  panel's otherwise. */
function rangeOf(s: ParamSpec): [number, number] {
  if (s.id === "emboss.x") return [PLACEMENT_WIDE.x[0], PLACEMENT_WIDE.x[1]];
  if (s.id === "emboss.y") return [PLACEMENT_WIDE.y[0], PLACEMENT_WIDE.y[1]];
  if (s.id === "emboss.width") return [PLACEMENT_WIDE.width[0], PLACEMENT_WIDE.width[1]];
  return [s.min ?? -Infinity, s.max ?? Infinity];
}
/** The value lies within the panel's (card) range of its ParamSpec. */
function onCardFrame(id: string, v: ParamValue | undefined): boolean {
  const s = ELEMENT_PARAMS.find((p) => p.id === id);
  return typeof v !== "number" || !s || (v >= (s.min ?? -Infinity) && v <= (s.max ?? Infinity));
}
/** A position clamped to a face [mm] (A14: the flag's), or to the panel's card range without one. */
const placeOn = (id: "emboss.x" | "emboss.y", v: number, face?: { x: number; y: number }) => {
  if (!face) return clampTo(id, v);
  const r = faceRange(face)[id === "emboss.x" ? "x" : "y"];
  return Math.min(Math.max(v, r[0]), r[1]);
};

/** Adds an element on top (null at the cap). New elements are 24 mm wide and stepped away from the centre, so they
 *  neither cover the card nor hide each other. A14: on another face (the flag's) the steps scale with it (never beyond
 *  the card's) and stay on it; without `face` exactly as on the card. */
export function addElement(doc: PaperDoc, type: ElementType, face?: { x: number; y: number }): { doc: PaperDoc; id: string } | null {
  if (doc.elements.length >= MAX_ELEMENTS) return null;
  const out = copy(doc), id = nextId(doc), k = doc.elements.length, values = elementDefaults(type);
  if (k > 0) {
    const sx = face ? Math.min(1, face.x / 63) : 1, sy = face ? Math.min(1, face.y / 88) : 1;
    values["emboss.width"] = 24;
    values["emboss.x"] = placeOn("emboss.x", 31.5 + sx * [0, -14, 14, -14, 14, 0][k % 6], face);
    values["emboss.y"] = placeOn("emboss.y", 44 + sy * [0, 24, 24, -24, -24, -30][k % 6], face);
  }
  out.elements.push({ id, type, name: freeName(doc, type), visible: true, values });
  return { doc: out, id };
}

/** Duplicates an element right above it, shifted 4 mm (null at the cap; A14: kept on `face` when given). */
export function duplicateElement(doc: PaperDoc, id: string, face?: { x: number; y: number }): { doc: PaperDoc; id: string } | null {
  const k = doc.elements.findIndex((e) => e.id === id);
  if (k < 0 || doc.elements.length >= MAX_ELEMENTS) return null;
  const out = copy(doc), src = out.elements[k], nid = nextId(doc);
  const values = Object.fromEntries(Object.entries(src.values).map(([key, v]) => [key, clone(v)]));
  values["emboss.x"] = placeOn("emboss.x", Number(values["emboss.x"]) + 4, face);
  values["emboss.y"] = placeOn("emboss.y", Number(values["emboss.y"]) - 4, face);
  out.elements.splice(k + 1, 0, { id: nid, type: src.type, name: freeName(doc, src.type), visible: true, values });
  return { doc: out, id: nid };
}

export function removeElement(doc: PaperDoc, id: string): PaperDoc {
  return { elements: copy(doc).elements.filter((e) => e.id !== id) };
}

/** Moves an element in the z-order (delta > 0: towards the top). */
export function moveElement(doc: PaperDoc, id: string, delta: number): PaperDoc {
  const out = copy(doc), k = out.elements.findIndex((e) => e.id === id);
  const to = Math.min(Math.max(k + delta, 0), out.elements.length - 1);
  if (k < 0 || to === k) return out;
  const [e] = out.elements.splice(k, 1);
  out.elements.splice(to, 0, e);
  return out;
}

export function patchElement(doc: PaperDoc, id: string, patch: { name?: string; visible?: boolean; values?: Readonly<Record<string, ParamValue>> }): PaperDoc {
  const out = copy(doc), e = out.elements.find((x) => x.id === id);
  if (!e) return out;
  if (patch.name !== undefined && patch.name.trim()) e.name = patch.name.trim().slice(0, 40);
  if (patch.visible !== undefined) e.visible = patch.visible;
  if (patch.values) for (const [k, v] of Object.entries(patch.values)) if (ELEMENT_IDS.has(k)) e.values[k] = clone(v);
  return out;
}
