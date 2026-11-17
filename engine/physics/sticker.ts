// A9 Volume-hologram sticker on the Foil Emboss paper card: the CPU twin of the analytic sticker shapes in
// shaders/emboss.glsl (EMB_STICKER), the shape rules of the panel (aspect, corner radius, short side), the dome pillow of
// the primitive shapes, and the sticker frame (card mm ↔ the hologram's recording coordinates). Pure module (spec §6.1):
// no three, no DOM, erasable syntax only (tests/sticker.test.ts).
//
// Conventions (as the logo SDF of A6): the signed distance d [mm] is positive INSIDE the outline; its gradient g = ∇d
// points inward (|g| = 1). Shapes are centred on the sticker centre in the sticker frame (x along the element's width,
// y along its height, the frame turned by the element's rotation on the card).
//   rounded box  half sizes (hw, hh), corner radius r ≤ min(hw, hh)  (square, rect, rounded; rect: r = 0)
//   ellipse      semi-axes (hw, hh)                                     (circle, oval)
// Dome pillow (the `dome` profile; A6's dome on a logo uses the membrane u of its mask with U₀ = 0.28 mm², which on a
// 20–60 mm patch saturates within ≈ 20 µm of the edge — a cliff, not a dome): the primitive shapes use the normalised
// torsion function u_n (Δu = −1 inside, u = 0 on the outline, scaled to 1 at its maximum; exact for the ellipse,
// a 4-term series for the box), and the shader's membrane value is u = K·U₀·u_n with K = STICKER_DOME_K, so the pillow
// 1 − e^(−u/U₀) = 1 − e^(−K·u_n) rises smoothly from the edge to 95 % at the centre: a film laminated over a pillow.
import type { StickerShape } from "../materials/emboss.params.ts";
import type { Vec3 } from "../types.ts";

/** The pillow reaches 1 − e^(−K) = 95 % at the centre of a primitive sticker (see the header). */
export const STICKER_DOME_K = 3;
/** Number of odd terms (n = 1, 3, 5, 7) of the rectangle's torsion series (error ≤ 0.25 % of the maximum). */
export const TORSION_TERMS = 4;

/** Analytic shape kinds of the shader (`uLogoShape`): 0 = the logo texture (svg), 1 = rounded box, 2 = ellipse. */
export type ShapeKind = 0 | 1 | 2;

export interface ShapeGeometry {
  kind: ShapeKind;
  hw: number; hh: number;          // half sizes [mm] (svg: of the artwork's box)
  r: number;                        // corner radius [mm] (rounded box only)
  aspectHW: number;                 // height / width of the element (the editor box)
  freeAspect: boolean;              // edge handles change width or height alone (rect, rounded, oval)
  shortMm: number;                  // the shorter side [mm] (the hologram's size and depth are relative to it)
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The aspect limits of `emboss.aspect` (width / height). */
export const ASPECT_LIMITS = [0.25, 4] as const;

/**
 * The geometry of a sticker shape (A9.2): `square` and `circle` force the aspect 1, `rect`, `rounded` and `oval` take
 * `aspectWH` (width / height, clamped to 0.25–4), `svg` the artwork's own aspect (`logoAspectHW` = height / width).
 * The corner radius applies to `square` (a die-cut square sticker: the A9 default is a 30 mm square with 2.5 mm
 * corners) and `rounded`; `rect` is sharp. It is clamped to the shorter half size.
 */
export function shapeGeometry(shape: StickerShape, widthMm: number, aspectWH: number, cornerMm: number, logoAspectHW = 1): ShapeGeometry {
  const w = Math.max(widthMm, 1e-3);
  const free = shape === "rect" || shape === "rounded" || shape === "oval";
  const a = Number.isFinite(aspectWH) && aspectWH > 0 ? clamp(aspectWH, ASPECT_LIMITS[0], ASPECT_LIMITS[1]) : 1;
  const hwRatio = shape === "svg" ? (Number.isFinite(logoAspectHW) && logoAspectHW > 0 ? logoAspectHW : 1) : free ? 1 / a : 1;
  const hw = w / 2, hh = (w * hwRatio) / 2;
  const kind: ShapeKind = shape === "svg" ? 0 : shape === "circle" || shape === "oval" ? 2 : 1;
  const r = shape === "square" || shape === "rounded" ? clamp(Number.isFinite(cornerMm) ? cornerMm : 0, 0, Math.min(hw, hh)) : 0;
  return { kind, hw, hh, r, aspectHW: hwRatio, freeAspect: free, shortMm: 2 * Math.min(hw, hh) };
}

/** Signed distance (positive inside) and inward unit gradient of a rounded box centred at the origin. */
export function sdRoundBox(x: number, y: number, hw: number, hh: number, r: number): { d: number; gx: number; gy: number } {
  const rr = clamp(r, 0, Math.min(hw, hh));
  const sx = x < 0 ? -1 : 1, sy = y < 0 ? -1 : 1;
  const qx = Math.abs(x) - hw + rr, qy = Math.abs(y) - hh + rr;
  if (qx > 0 && qy > 0) {
    const l = Math.hypot(qx, qy);
    return { d: rr - l, gx: (-sx * qx) / l, gy: (-sy * qy) / l };
  }
  // one or no corner coordinate positive: the distance to the nearer straight side
  return qx > qy ? { d: rr - qx, gx: -sx, gy: 0 } : { d: rr - qy, gx: 0, gy: -sy };
}

/** Signed distance (positive inside) and inward unit gradient of an ellipse with semi-axes (a, b): the closest point
 *  by Newton's method on its angle (Quílez's iteration, 5 steps; tested against a dense boundary search). The
 *  gradient is the inward normal at the closest point (exact on both sides and well defined on the outline). */
export function sdEllipse(x: number, y: number, a: number, b: number): { d: number; gx: number; gy: number } {
  const px = Math.abs(x), py = Math.abs(y), sx = x < 0 ? -1 : 1, sy = y < 0 ? -1 : 1;
  if (Math.abs(a - b) <= 1e-6 * Math.max(a, b)) {                 // circle
    const l = Math.hypot(px, py);
    return l > 1e-12 ? { d: a - l, gx: (-sx * px) / l, gy: (-sy * py) / l } : { d: a, gx: -1, gy: 0 };
  }
  let w = a * (px - a) < b * (py - b) ? Math.PI / 2 : 0;
  for (let i = 0; i < 5; i++) {
    const c = Math.cos(w), s = Math.sin(w);
    const ux = a * c, uy = b * s, vx = -a * s, vy = b * c;
    const ex = px - ux, ey = py - uy;
    w += (ex * vx + ey * vy) / (ex * ux + ey * uy + vx * vx + vy * vy);
  }
  w = clamp(w, 0, Math.PI / 2);
  const cx = a * Math.cos(w), cy = b * Math.sin(w);
  const dist = Math.hypot(px - cx, py - cy);
  const inside = (px / a) ** 2 + (py / b) ** 2 < 1;
  let nx = cx / (a * a), ny = cy / (b * b);                        // outward normal at the closest point
  const nl = Math.hypot(nx, ny) || 1;
  nx /= nl; ny /= nl;
  return { d: inside ? dist : -dist, gx: -sx * nx, gy: -sy * ny };
}

/** The signed distance of a shape geometry at a sticker-frame point (kind 0, the logo texture, has no analytic form). */
export function shapeDistance(g: ShapeGeometry, x: number, y: number): { d: number; gx: number; gy: number } {
  if (g.kind === 2) return sdEllipse(x, y, g.hw, g.hh);
  return sdRoundBox(x, y, g.hw, g.hh, g.kind === 1 ? g.r : 0);
}

/** The unnormalised torsion function of the rectangle |s| ≤ A, |t| ≤ B (A ≤ B): Δu = −1 inside, u = 0 on the outline
 *  (Saint-Venant's series, TORSION_TERMS odd terms) and its gradient (∂/∂s, ∂/∂t). */
export function rectTorsion(s: number, t: number, A: number, B: number): { u: number; us: number; ut: number } {
  if (!(Math.abs(s) < A && Math.abs(t) < B)) return { u: 0, us: 0, ut: 0 };
  let u = 0.5 * (A * A - s * s), us = -s, ut = 0;
  const c = (16 * A * A) / (Math.PI ** 3);
  for (let j = 0; j < TORSION_TERMS; j++) {
    const n = 2 * j + 1, k = (n * Math.PI) / (2 * A), sg = j % 2 === 0 ? 1 : -1, cn = (c * sg) / (n * n * n);
    // cosh(k t)/cosh(k B) and sinh(k t)/cosh(k B), overflow-free
    const e = Math.exp(k * (Math.abs(t) - B)), eB = Math.exp(-2 * k * B), et = Math.exp(-2 * k * Math.abs(t));
    const ch = (e * (1 + et)) / (1 + eB), sh = (Math.sign(t) * e * (1 - et)) / (1 + eB);
    const cs = Math.cos(k * s), sn = Math.sin(k * s);
    u -= cn * ch * cs;
    us += cn * ch * k * sn;
    ut -= cn * sh * k * cs;
  }
  return { u, us, ut };
}

/** The normalised dome pillow u_n ∈ [0, 1] of a primitive shape (1 at the maximum, 0 on and outside the outline) and
 *  its gradient in the sticker frame. Rounded box: the torsion of its full box, cut at the outline. */
export function shapePillow(g: ShapeGeometry, x: number, y: number): { u: number; gx: number; gy: number } {
  if (g.kind === 2) {
    const a2 = g.hw * g.hw, b2 = g.hh * g.hh, u = 1 - (x * x) / a2 - (y * y) / b2;
    return u > 0 ? { u, gx: (-2 * x) / a2, gy: (-2 * y) / b2 } : { u: 0, gx: 0, gy: 0 };
  }
  const alongX = g.hw <= g.hh, A = Math.min(g.hw, g.hh), B = Math.max(g.hw, g.hh);
  const s = alongX ? x : y, t = alongX ? y : x;
  const umax = rectTorsion(0, 0, A, B).u;
  if (g.kind === 1 && g.r > 0 && sdRoundBox(x, y, g.hw, g.hh, g.r).d <= 0) return { u: 0, gx: 0, gy: 0 };
  const r = rectTorsion(s, t, A, B);
  const k = 1 / Math.max(umax, 1e-12);
  return alongX ? { u: r.u * k, gx: r.us * k, gy: r.ut * k } : { u: r.u * k, gx: r.ut * k, gy: r.us * k };
}

/** The rectangle's torsion maximum u(0, 0) for half sizes (A ≤ B) — the shader's normalisation (uShapeT.z = 1/u_max). */
export function rectTorsionMax(hw: number, hh: number): number {
  return rectTorsion(0, 0, Math.min(hw, hh), Math.max(hw, hh)).u;
}

// ---------------------------------------------------------------------------------------------------------------
// The sticker frame (A9.4 "Sticker coordinates"): the hologram is recorded in the element's own frame — centre,
// rotation and size — so moving, rotating or resizing the sticker moves, rotates or scales the 3D image with it.
// ---------------------------------------------------------------------------------------------------------------

export interface StickerFrame { cx: number; cy: number; rotationDeg: number; shortMm: number }

/** Card mm (face coordinates) → the sticker frame [mm from its centre, along its width and height]. */
export function toSticker(f: StickerFrame, px: number, py: number): [number, number] {
  const a = (f.rotationDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), dx = px - f.cx, dy = py - f.cy;
  return [dx * c + dy * s, -dx * s + dy * c];
}

/** A card-frame direction (unit, (T, B, N) components) in the sticker frame: its tangential part turned by −rotation. */
export function dirToSticker(f: StickerFrame, d: Vec3): Vec3 {
  const a = (f.rotationDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [d[0] * c + d[1] * s, -d[0] * s + d[1] * c, d[2]];
}

/** The hologram's relative size, depth and backdrop depth (fractions of the short side, A9.4) in mm. */
export function hologramMm(f: { shortMm: number }, rel: { size: number; depth: number; backdropDepth: number }): { sizeMm: number; depthMm: number; backdropMm: number } {
  return { sizeMm: rel.size * f.shortMm, depthMm: rel.depth * f.shortMm, backdropMm: rel.backdropDepth * f.shortMm };
}

/**
 * The recording coordinates of a card point: the point in the hologram's content box in units of the subject's size
 * (before the subject's pose rotation), exactly as volume.glsl volTrace forms them — o = (sticker-frame mm, 0),
 * (o − (0, 0, depth)) / size. Moving, rotating or scaling the sticker (with the point) leaves them unchanged.
 */
export function recordingCoords(f: StickerFrame, rel: { size: number; depth: number }, px: number, py: number): Vec3 {
  const [x, y] = toSticker(f, px, py), size = rel.size * f.shortMm, depth = rel.depth * f.shortMm;
  return [x / size, y / size, -depth / size];
}
