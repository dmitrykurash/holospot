// Card geometry (spec §5.1; R04 §6.5): a closed, convex, indexed BufferGeometry in metres, centred at the origin with
// the front face at z = +T/2. Groups: 0 front, 1 back, 2 edge (mesh.material = [holo, back, edge]).
// Not RoundedBoxGeometry (clamps the radius to T/2) and not ExtrudeGeometry (bevelled, faceted, non-indexed).
import * as THREE from "three";

export interface CardGeometryOptions { widthM: number; heightM: number; thicknessM: number; cornerM: number; arcSegments: number }
export const CARD_GEOMETRY_DEFAULTS: Readonly<CardGeometryOptions> = {
  widthM: 0.063, heightM: 0.088, thicknessM: 0.0003, cornerM: 0.003, arcSegments: 12,
};

export interface OutlinePoint { x: number; y: number; nx: number; ny: number }

/** CCW rounded-rectangle outline (seen from +z) with outward normals; `arcSegments` chords per quarter arc
 *  (12 → chord error 0.07 px at a 1000 px card height). Arcs are tangent to the straight sides, so the normals at the
 *  arc ends equal the side normals and the edge strip shades smoothly. */
export function cardOutline(o: CardGeometryOptions): OutlinePoint[] {
  const hw = o.widthM / 2, hh = o.heightM / 2;
  const r = Math.min(Math.max(o.cornerM, 0), hw, hh);
  const n = Math.max(1, Math.round(o.arcSegments));
  const corners: [number, number, number][] = [   // arc centre x, y, start angle (CCW from the bottom-right corner)
    [hw - r, -hh + r, -Math.PI / 2],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
  ];
  const pts: OutlinePoint[] = [];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= n; k++) {
      const a = a0 + (k / n) * (Math.PI / 2);
      const nx = Math.cos(a), ny = Math.sin(a);
      pts.push({ x: cx + r * nx, y: cy + r * ny, nx, ny });
    }
  }
  return pts;
}

export function buildCardGeometry(o: CardGeometryOptions): THREE.BufferGeometry {
  const W = o.widthM, H = o.heightM, T = o.thicknessM;
  const outline = cardOutline(o);
  const N = outline.length;

  const pos: number[] = [], nor: number[] = [], uv: number[] = [], tan: number[] = [], idx: number[] = [];

  // Triangulation of the outline; Earcut's output winding is normalised to CCW seen from +z.
  const contour = outline.map((p) => new THREE.Vector2(p.x, p.y));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []).map((t) => {
    const [a, b, c] = t;
    const A = outline[a], B = outline[b], C = outline[c];
    const area2 = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    return area2 >= 0 ? [a, b, c] : [a, c, b];
  });

  // Group 0: front face, z = +T/2, normal +z, uv = (x/W + ½, y/H + ½), tangent (1, 0, 0, 1).
  const f0 = 0;
  for (const p of outline) {
    pos.push(p.x, p.y, T / 2); nor.push(0, 0, 1); uv.push(p.x / W + 0.5, p.y / H + 0.5); tan.push(1, 0, 0, 1);
  }
  for (const [a, b, c] of tris) idx.push(f0 + a, f0 + b, f0 + c);
  const frontCount = idx.length;

  // Group 1: back face, z = −T/2, reversed winding, normal −z, uv = (½ − x/W, y/H + ½) so the back reads correctly
  // after a 180° yaw, tangent (−1, 0, 0, 1) (the direction of increasing u; bitangent cross(N, T) = +y).
  const b0 = pos.length / 3;
  for (const p of outline) {
    pos.push(p.x, p.y, -T / 2); nor.push(0, 0, -1); uv.push(0.5 - p.x / W, p.y / H + 0.5); tan.push(-1, 0, 0, 1);
  }
  for (const [a, b, c] of tris) idx.push(b0 + a, b0 + c, b0 + b);
  const backCount = idx.length - frontCount;

  // Group 2: edge strip. Two vertices per outline vertex (z = ∓T/2), the first vertex repeated at u = 1 to close the
  // seam; normal = outward outline normal (radial on arcs); uv = (arc length / perimeter, z/T + ½); tangent = CCW
  // outline tangent with w = 1 (bitangent cross(N, T) = +z = toward the front face, the direction of increasing v).
  let perim = 0;
  const s: number[] = [0];
  for (let i = 0; i < N; i++) {
    const p = outline[i], q = outline[(i + 1) % N];
    perim += Math.hypot(q.x - p.x, q.y - p.y);
    s.push(perim);
  }
  const e0 = pos.length / 3;
  for (let i = 0; i <= N; i++) {
    const p = outline[i % N];
    const u = s[i] / perim;
    for (const zSign of [-1, 1]) {
      pos.push(p.x, p.y, (zSign * T) / 2);
      nor.push(p.nx, p.ny, 0);
      uv.push(u, zSign > 0 ? 1 : 0);
      tan.push(-p.ny, p.nx, 0, 1);
    }
  }
  for (let i = 0; i < N; i++) {
    const b = e0 + 2 * i, t = b + 1, bn = b + 2, tn = b + 3;   // bottom/top at i and i + 1
    idx.push(b, bn, tn, b, tn, t);                              // (T × Z) = outward for a CCW outline
  }
  const edgeCount = idx.length - frontCount - backCount;

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("tangent", new THREE.Float32BufferAttribute(tan, 4));
  g.setIndex(idx);
  g.addGroup(0, frontCount, 0);
  g.addGroup(frontCount, backCount, 1);
  g.addGroup(frontCount + backCount, edgeCount, 2);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
