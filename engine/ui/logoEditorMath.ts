// A6.2 on-card logo editor: the pure maths of a Figma-like transform box (move, uniform scale about the opposite
// corner, rotation, nudges). Pure module (spec §6.1): no DOM, no three, erasable syntax only (tests/emboss.test.ts).
//
// Coordinates are card mm (the panel's `emboss.x` / `emboss.y`: origin bottom-left of the face, +y up). A placement is
// the logo's centre, its width (height = width × aspect, aspect = artwork height / width) and its rotation (degrees,
// counter-clockwise). Corners are numbered 0 bottom-left, 1 bottom-right, 2 top-right, 3 top-left in the logo frame,
// so the corner opposite k is (k + 2) mod 4. Addendum A9: the edges of the free-aspect sticker shapes (rect, rounded,
// oval) are numbered 0 bottom, 1 right, 2 top, 3 left (edge k joins corners k and k + 1); the edge opposite k is
// (k + 2) mod 4. An edge drag changes the width or the height alone, so it also returns the new aspect.

export interface Placement { x: number; y: number; width: number; rotationDeg: number }
export type Pt = readonly [number, number];

/** Limits of the panel sliders (emboss.params.ts) on the 63 × 88 mm card; x and y follow the card face (below). */
export const PLACEMENT_LIMITS = { x: [0, 63], y: [0, 88], width: [3, 63], rotation: [-180, 180] } as const;
/** The widest placement frame [card mm]: the largest flag's face (addendum A14: 300 mm high, 2.5 : 1, so 750 × 300 mm)
 *  around the card's centre (31.5, 44). The paper card's document (app/paperDoc.ts) stores positions within it; the
 *  editor keeps an element's centre on the face shown (setPlacementFace), so on a card exactly within the card. */
export const PLACEMENT_WIDE = { x: [31.5 - 375, 31.5 + 375], y: [44 - 150, 44 + 150], width: [3, 750] } as const;

/** The face the editor keeps the centre on [mm]: the card's (the image card's follows its picture), the Holo cloth's
 *  (the card's), the flag's (its whole face: A14); set by the app. */
let face = { x: 63, y: 88 };
/** The largest width [mm] on that face: the card's slider (63 mm) unless the app says otherwise (A14: on the flag its
 *  longer side, up to PLACEMENT_WIDE.width — a logo as large as the flag). */
let widthMax: number = PLACEMENT_LIMITS.width[1];
/** Sets the face: the centre stays within x ∈ 31.5 ± w/2, y ∈ 44 ± h/2 (the panel's card-mm frame); `maxWidth` (A14):
 *  the largest width there (default: the card's 63 mm). */
export function setPlacementFace(f: { x: number; y: number }, maxWidth: number = PLACEMENT_LIMITS.width[1]): void {
  if (Number.isFinite(f.x) && Number.isFinite(f.y) && f.x > 0 && f.y > 0) face = { x: f.x, y: f.y };
  widthMax = Number.isFinite(maxWidth) ? Math.min(Math.max(maxWidth, PLACEMENT_LIMITS.width[0]), PLACEMENT_WIDE.width[1]) : PLACEMENT_LIMITS.width[1];
}
/** The width range on the current face [mm] (the card's 3 … 63 unless the app set a larger maximum). */
export function widthRange(): [number, number] { return [PLACEMENT_LIMITS.width[0], widthMax]; }

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The range of an element's centre on a face [card mm]: x ∈ 31.5 ± w/2, y ∈ 44 ± h/2, within PLACEMENT_WIDE. */
export function faceRange(f: { x: number; y: number }): { x: [number, number]; y: [number, number] } {
  return {
    x: [Math.max(31.5 - f.x / 2, PLACEMENT_WIDE.x[0]), Math.min(31.5 + f.x / 2, PLACEMENT_WIDE.x[1])],
    y: [Math.max(44 - f.y / 2, PLACEMENT_WIDE.y[0]), Math.min(44 + f.y / 2, PLACEMENT_WIDE.y[1])],
  };
}

/** The placement clamped to the slider ranges, rotation wrapped to (−180, 180]. */
export function clampPlacement(p: Placement): Placement {
  let r = ((p.rotationDeg + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return {
    // (a card face gives the panel's own limits: 63 × 88 → 0 … 63 × 0 … 88; the widest image card 88 → −12.5 … 75.5)
    x: clamp(p.x, ...faceRange(face).x),
    y: clamp(p.y, ...faceRange(face).y),
    width: clamp(p.width, PLACEMENT_LIMITS.width[0], widthMax),
    rotationDeg: r,
  };
}

/** Logo frame axes in card mm: u (artwork +x) and v (artwork +y). */
export function logoAxes(p: Placement): { u: Pt; v: Pt } {
  const c = Math.cos(p.rotationDeg * DEG), s = Math.sin(p.rotationDeg * DEG);
  return { u: [c, s], v: [-s, c] };
}

/** A card-mm point in the logo frame (mm, origin at the centre). */
export function toLocal(p: Placement, q: Pt): [number, number] {
  const { u, v } = logoAxes(p), dx = q[0] - p.x, dy = q[1] - p.y;
  return [dx * u[0] + dy * u[1], dx * v[0] + dy * v[1]];
}
/** A logo-frame point (mm from the centre) in card mm. */
export function fromLocal(p: Placement, l: Pt): [number, number] {
  const { u, v } = logoAxes(p);
  return [p.x + l[0] * u[0] + l[1] * v[0], p.y + l[0] * u[1] + l[1] * v[1]];
}

/** The four corners in card mm (0 BL, 1 BR, 2 TR, 3 TL of the artwork). */
export function logoCorners(p: Placement, aspect: number): [number, number][] {
  const hw = p.width / 2, hh = (p.width * aspect) / 2;
  const ls: Pt[] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return ls.map((l) => fromLocal(p, l));
}

/** A9: the four edge midpoints in card mm (0 bottom, 1 right, 2 top, 3 left of the artwork). */
export function logoEdgeMidpoints(p: Placement, aspect: number): [number, number][] {
  const hw = p.width / 2, hh = (p.width * aspect) / 2;
  const ls: Pt[] = [[0, -hh], [hw, 0], [0, hh], [-hw, 0]];
  return ls.map((l) => fromLocal(p, l));
}

/** A9: the limits of an edge drag: the width slider's range and the aspect (width / height) of `emboss.aspect`. */
export const EDGE_ASPECT_LIMITS = [0.25, 4] as const;

/**
 * A9 edge handle: drag edge `edge` to the card-mm point q. The width (edges 1, 3) or the height (edges 0, 2) alone
 * follows the pointer's coordinate across the edge, about the opposite edge (it stays where it is) or, with
 * `aboutCentre` (Alt / Option), symmetrically about the centre. The other dimension is kept; the result is clamped to
 * the width slider and to aspect (width / height) 0.25–4. Returns the placement and the new aspect (height / width).
 */
export function scaleFromEdge(p0: Placement, aspect: number, edge: number, q: Pt, aboutCentre = false): { placement: Placement; aspect: number } {
  const k = ((edge % 4) + 4) % 4, horiz = k === 1 || k === 3, sgn = k === 1 || k === 2 ? 1 : -1;
  const w0 = p0.width, h0 = p0.width * aspect;
  const [lx, ly] = toLocal(p0, q);
  const c = sgn * (horiz ? lx : ly);                            // the pointer's coordinate across the edge, outward
  const size0 = horiz ? w0 : h0;
  let size = aboutCentre ? 2 * c : c + size0 / 2;
  const [aLo, aHi] = EDGE_ASPECT_LIMITS;
  if (horiz) size = clamp(size, Math.max(PLACEMENT_LIMITS.width[0], aLo * h0), Math.min(widthMax, aHi * h0));
  else size = clamp(size, w0 / aHi, w0 / aLo);
  const shift = aboutCentre ? 0 : (sgn * (size - size0)) / 2;   // the centre moves half the change, away from the fixed edge
  const { u, v } = logoAxes(p0), ax = horiz ? u : v;
  const w = horiz ? size : w0, h = horiz ? h0 : size;
  const pl = clampPlacement({ ...p0, width: w, x: p0.x + shift * ax[0], y: p0.y + shift * ax[1] });
  return { placement: pl, aspect: h / pl.width };
}

/** True when q lies inside the logo's box grown by `marginMm`. */
export function insideBox(p: Placement, aspect: number, q: Pt, marginMm = 0): boolean {
  const [a, b] = toLocal(p, q);
  return Math.abs(a) <= p.width / 2 + marginMm && Math.abs(b) <= (p.width * aspect) / 2 + marginMm;
}

/** Move: the placement at drag start shifted by the pointer's card-mm displacement; `constrain` (Shift) keeps only the
 *  larger axis of the displacement. */
export function moveBy(p0: Placement, from: Pt, to: Pt, constrain = false): Placement {
  let dx = to[0] - from[0], dy = to[1] - from[1];
  if (constrain) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  return clampPlacement({ ...p0, x: p0.x + dx, y: p0.y + dy });
}

/**
 * Uniform scale about the corner opposite `corner` (fixed aspect ratio): the scale factor is the projection of the
 * pointer onto the box diagonal, k = ((q − O)·(D − O)) / |D − O|², with O the fixed opposite corner and D the dragged
 * corner at drag start; the width becomes k·w0 (clamped to the slider range, which then defines k) and the centre
 * O + k·(c0 − O), so O stays where it is.
 */
export function scaleFromCorner(p0: Placement, aspect: number, corner: number, q: Pt): Placement {
  const cs = logoCorners(p0, aspect), k0 = ((corner % 4) + 4) % 4;
  const D = cs[k0], O = cs[(k0 + 2) % 4];
  const ex = D[0] - O[0], ey = D[1] - O[1], len2 = ex * ex + ey * ey;
  if (!(len2 > 0)) return p0;
  let k = ((q[0] - O[0]) * ex + (q[1] - O[1]) * ey) / len2;
  const w = clamp(k * p0.width, PLACEMENT_LIMITS.width[0], widthMax);
  k = w / p0.width;
  return clampPlacement({ ...p0, width: w, x: O[0] + k * (p0.x - O[0]), y: O[1] + k * (p0.y - O[1]) });
}

/** Uniform scale about the centre by factor k (two-finger pinch). */
export function scaleAboutCentre(p0: Placement, k: number): Placement {
  return clampPlacement({ ...p0, width: p0.width * (Number.isFinite(k) && k > 0 ? k : 1) });
}

/** Rotation by the angle the pointer turned about the centre since drag start; `snapDeg` (Shift: 15°) snaps the result. */
export function rotateBy(p0: Placement, from: Pt, to: Pt, snapDeg = 0): Placement {
  const a0 = Math.atan2(from[1] - p0.y, from[0] - p0.x), a1 = Math.atan2(to[1] - p0.y, to[0] - p0.x);
  let r = p0.rotationDeg + (a1 - a0) / DEG;
  if (snapDeg > 0) r = Math.round(r / snapDeg) * snapDeg;
  return clampPlacement({ ...p0, rotationDeg: r });
}

/** Arrow-key nudge: 0.5 mm (Shift: 5 mm) along the card axes. Returns null for any other key. */
export function nudge(p: Placement, key: string, shift: boolean): Placement | null {
  const step = shift ? 5 : 0.5;
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  const v = d[key];
  return v ? clampPlacement({ ...p, x: p.x + v[0], y: p.y + v[1] }) : null;
}

/** The handle under a screen point: a corner (0–3) within `tolPx`, an edge midpoint (A9, 0–3, when shown), the
 *  rotation knob, the box interior, or null. Screen positions are CSS px; corners in the order of logoCorners, edges
 *  of logoEdgeMidpoints; `knob` may be null (not shown). Corners win over edges (a small box). */
export function pickHandle(corners: readonly (Pt | null)[], knob: Pt | null, inside: boolean, s: Pt, tolPx = 10,
  edges: readonly (Pt | null)[] = []):
  { kind: "corner"; index: number } | { kind: "edge"; index: number } | { kind: "rotate" } | { kind: "move" } | null {
  const nearest = (pts: readonly (Pt | null)[]) => {
    let best = -1, bestD = tolPx;
    pts.forEach((c, i) => {
      if (!c) return;
      const d = Math.hypot(c[0] - s[0], c[1] - s[1]);
      if (d <= bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const corner = nearest(corners);
  if (corner >= 0) return { kind: "corner", index: corner };
  const edge = nearest(edges);
  if (edge >= 0) return { kind: "edge", index: edge };
  if (knob && Math.hypot(knob[0] - s[0], knob[1] - s[1]) <= tolPx) return { kind: "rotate" };
  return inside ? { kind: "move" } : null;
}
