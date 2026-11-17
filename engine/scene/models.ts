// Your own GLB models (spec addendum A3): loading, geometry processing and the model store behind the `model` object.
//
// Pipeline (A3.2, A3.3)
//   bytes (upload, drop, IndexedDB, `model=` URL, __holo.loadModel)
//   → container check and JSON rewrite on the page (`readGltfContainer`, `stripGltf`): every material becomes a bare
//     { name, doubleSided }; textures, images, samplers, animations and morph targets are dropped, and so are the
//     texture/material extensions from extensionsUsed/Required (a file that needs KTX2 only for its textures loads its
//     geometry) — the holographic materials replace all of it
//   → GLTFLoader (lazy chunk) with DRACOLoader (decoders in public/draco/, wasm with a JS retry) and MeshoptDecoder
//     (in its own workers)
//   → `extractParts` on the page: every Mesh / SkinnedMesh (posed by its skeleton at load, i.e. three's bind pose) /
//     InstancedMesh (one part per instance) with its world matrix, position, normal, TEXCOORD_0 and index only
//   → the processing kernel (`modelKernel`, run in an inline Blob worker; on the page only where workers fail):
//     bake the matrices (normals by the cofactor matrix, winding flipped under mirroring), drop unreferenced vertices
//     and broken triangles, merge, normalise (bounding box centred, largest side 1), weld by position, count boundary
//     edges, compute missing normals (angle-weighted, smooth up to a 60° crease), analyse the UVs, then build: mapping
//     (uv / box / sphere), tangents, double-sided duplication
//   → the page wraps the arrays in one BufferGeometry (positions × model size) with one group 0 = holo.
//
// Units: the kernel works in normalised model units (largest bounding-box side = 1); `model size (mm)` scales the
// positions (in place, no rebuild) and every domain, so p = uv·domainMm stays physical mm along the surface:
//   uv      domainMm = (mmPerUv, mmPerUv)·size·structureScale, mmPerUv = √(Σ area₃D / Σ area_UV) (texel density)
//   box     uv = projected coordinate + ½ on the dominant axis of each triangle's face normal (vertices split per
//           projection face), domainMm = (size, size)·structureScale — the spec's "mm / 100 with (100, 100)" up to an
//           offset that puts the model centre at the domain centre (Prism's concentric centre, wear placement)
//   sphere  longitude/latitude about the bounding-box centre (u = ½ faces the camera, seam split at the back),
//           domainMm = (2π R̄, π R̄)·size·structureScale with R̄ the area-weighted mean radius
// The bump map tiles over a fixed 100 mm domain (MODEL_BUMP_DOMAIN_MM), so its tile is 100/tiling mm of p in every
// mapping and at every model size, and `structure scale` resizes it with the shards and flakes (A3.1).
//
// Pure parts (kernel, container, JSON rewrite, error messages) carry no DOM access; the module imports three only, so
// node --test can load it (tests/models.test.ts). Loaders, workers, IndexedDB and the DOM are used at run time only.
import * as THREE from "three";
import type { Vec2 } from "../types.ts";
import type { ObjectInfo } from "./objects.ts";

// ---------------------------------------------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------------------------------------------

/** Largest accepted file (A3.2). */
export const MODEL_MAX_BYTES = 256 * 1024 * 1024;
/** Above this many merged triangles the caption warns (A3.2: the M4 handles it, phones may stall). */
export const MODEL_WARN_TRIANGLES = 3_000_000;
/** Hard limit (merged triangles before any double-sided copy): beyond it the arrays alone exceed ~2 GB. */
export const MODEL_MAX_TRIANGLES = 24_000_000;
/** `model size (mm)` default and range (A3.1). */
export const MODEL_SIZE_MM = { default: 90, min: 20, max: 400 } as const;
/** p-domain the bump map tiles over on a model [mm] (see the header). */
export const MODEL_BUMP_DOMAIN_MM = 100;
/** IndexedDB record of the last uploaded model (A3.1). */
export const MODEL_PERSIST_KEY = "holo:v1:model";
/** The file input's accept list (A3.1). */
export const MODEL_ACCEPT = ".glb,.gltf,model/gltf-binary,model/gltf+json";

export const MODEL_MAPPINGS = ["auto", "uv", "box", "sphere"] as const;
export type ModelMapping = (typeof MODEL_MAPPINGS)[number];
export type UsedMapping = "uv" | "box" | "sphere";
export function isModelMapping(v: unknown): v is ModelMapping {
  return typeof v === "string" && (MODEL_MAPPINGS as readonly string[]).includes(v);
}

/** The `object.*` values that shape the model (A3.1). */
export interface ModelParams { sizeMm: number; mapping: ModelMapping; structureScale: number; doubleSided: boolean }

/** One mesh of the file as handed to the kernel. Matrices are column-major (three.js Matrix4.elements). */
export interface ModelPart {
  pos: Float32Array;               // 3 per vertex, mesh-local
  nor: Float32Array | null;        // 3 per vertex, or null (computed)
  uv: Float32Array | null;         // 2 per vertex (TEXCOORD_0), or null
  idx: Uint32Array | null;         // 3 per triangle, or null (consecutive triplets)
  m: ArrayLike<number> | null;     // 16, world matrix; null = identity
  doubleSided: boolean;            // glTF material.doubleSided
}

/** UV statistics of the merged model (A3.3 item 4). */
export interface UvInfo {
  present: boolean;                // some part has TEXCOORD_0
  usable: boolean;                 // passes the A3.3 rules (`auto` uses the UVs)
  reason: string | null;           // why not
  mmPerUv: number;                 // model units per uv unit (√(Σ area₃D / Σ area_UV) over non-degenerate triangles)
  degenerateFraction: number;      // triangles (with 3D area) whose UV area is ~0, or without UVs
  cv: number;                      // area-weighted coefficient of variation of the per-triangle mm-per-UV ratio
  uvArea: number;                  // Σ area_UV of the non-degenerate triangles
}

/** What the kernel learnt about the merged model (normalised units: largest side 1). */
export interface ModelStats {
  triangles: number; vertices: number; dropped: number;
  boundaryEdges: number; materialDoubleSided: boolean; open: boolean;
  computedNormals: number;          // vertices whose normal was computed (missing or invalid in the file)
  halfN: [number, number, number];  // bounding-box half extents
  radiusN: number;                  // largest distance of a vertex from the centre
  meanRadiusN: number;              // area-weighted mean distance of the surface from the centre
  areaN: number;                    // surface area
  uv: UvInfo;
  ms: Record<string, number>;       // kernel timings
}

/** A built mapping (the arrays the page wraps in a BufferGeometry; positions normalised). */
export interface ModelBuilt {
  mapping: UsedMapping; note: string | null; doubleSided: boolean;
  domain: [number, number];         // domainMm per mm of model size (× structure scale)
  pos: Float32Array; nor: Float32Array; tan: Float32Array; uv: Float32Array; idx: Uint32Array;
  tangentFallback: number;          // vertices whose tangent had to be invented (degenerate uv)
  ms: number;
}

/** A model error with a short caption message (A3.1: "Not a glTF 2.0 file", "Draco decoder failed", …). */
export class ModelError extends Error {
  readonly detail: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ModelError";
    this.detail = detail ?? message;
  }
}
/** A load replaced by a newer one (not an error for the user). */
export class ModelSuperseded extends Error {
  constructor() { super("superseded"); this.name = "ModelSuperseded"; }
}

// ---------------------------------------------------------------------------------------------------------------
// The processing kernel. Self-contained (no reference outside its own body): its source text is the worker's code
// (Function.prototype.toString), so it must survive bundling and minification; tests call it directly.
// ---------------------------------------------------------------------------------------------------------------

export function modelKernel() {
  /** A3.3 UV rules and the normal crease. */
  const RULES = { maxDegenerate: 0.3, maxCv: 1.5, creaseDeg: 60 };
  const Q = 131071;                     // weld grid: 2¹⁷ − 1 steps over the unit box (≈ 0.7 µm on a 90 mm model)

  interface Merged {
    pos: Float32Array; nor: Float32Array; uv: Float32Array | null; noUv: Uint8Array | null; needN: Uint8Array | null;
    idx: Uint32Array; dropped: number; doubleSided: boolean; size: number;
  }
  interface Split { uv: Float32Array; idx: Uint32Array; src: Uint32Array }
  interface Geo { pos: Float32Array; nor: Float32Array; tan: Float32Array; uv: Float32Array; idx: Uint32Array }

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  /** Rows of the affine map of a column-major 4×4 (identity for null). */
  function affine(m: ArrayLike<number> | null): number[] {
    if (!m || m.length < 16) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const e = m;
    return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
  }

  /**
   * 1. Bakes every part's matrix, validates and merges: triangles with an index out of range, repeated corners or a
   * non-finite corner are dropped, unreferenced vertices removed (primitives may share one vertex buffer), winding
   * flipped where the matrix mirrors. Positions are normalised on the way (bounding box centred at the origin, largest
   * side 1; computed in doubles first, so far-from-origin CAD coordinates keep their precision).
   */
  function merge(parts: readonly ModelPart[]): Merged {
    interface Info { p: ModelPart; tri: Uint32Array; nt: number; remap: Int32Array; used: number; A: number[]; det: number; cof: number[] }
    const infos: Info[] = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let nV = 0, nT = 0, dropped = 0, anyUv = false, anyNoUv = false, dbl = false;
    for (const p of parts) {
      const n = Math.floor(p.pos.length / 3);
      const src = p.idx;
      const tc = src ? Math.floor(src.length / 3) : Math.floor(n / 3);
      const P = p.pos;
      const finite = new Uint8Array(n);
      for (let v = 0; v < n; v++) finite[v] = Number.isFinite(P[3 * v]) && Number.isFinite(P[3 * v + 1]) && Number.isFinite(P[3 * v + 2]) ? 1 : 0;
      const remap = new Int32Array(n).fill(-1);
      const tri = new Uint32Array(3 * tc);
      let k = 0;
      for (let t = 0; t < tc; t++) {
        const a = src ? src[3 * t] : 3 * t, b = src ? src[3 * t + 1] : 3 * t + 1, c = src ? src[3 * t + 2] : 3 * t + 2;
        if (!(a < n && b < n && c < n) || a === b || b === c || a === c || !finite[a] || !finite[b] || !finite[c]) { dropped++; continue; }
        tri[k++] = a; tri[k++] = b; tri[k++] = c;
        remap[a] = remap[b] = remap[c] = 0;
      }
      let used = 0;
      for (let v = 0; v < n; v++) if (remap[v] === 0) remap[v] = used++;
      const A = affine(p.m);
      const [a00, a01, a02, , a10, a11, a12, , a20, a21, a22] = A;
      const c00 = a11 * a22 - a12 * a21, c01 = a12 * a20 - a10 * a22, c02 = a10 * a21 - a11 * a20;
      const c10 = a02 * a21 - a01 * a22, c11 = a00 * a22 - a02 * a20, c12 = a01 * a20 - a00 * a21;
      const c20 = a01 * a12 - a02 * a11, c21 = a02 * a10 - a00 * a12, c22 = a00 * a11 - a01 * a10;
      const det = a00 * c00 + a01 * c01 + a02 * c02;
      for (let v = 0; v < n; v++) {
        if (remap[v] < 0) continue;
        const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
        const X = A[0] * x + A[1] * y + A[2] * z + A[3], Y = A[4] * x + A[5] * y + A[6] * z + A[7], Z = A[8] * x + A[9] * y + A[10] * z + A[11];
        if (X < lo[0]) lo[0] = X; if (X > hi[0]) hi[0] = X;
        if (Y < lo[1]) lo[1] = Y; if (Y > hi[1]) hi[1] = Y;
        if (Z < lo[2]) lo[2] = Z; if (Z > hi[2]) hi[2] = Z;
      }
      infos.push({ p, tri, nt: k / 3, remap, used, A, det, cof: [c00, c01, c02, c10, c11, c12, c20, c21, c22] });
      nV += used; nT += k / 3;
      if (k > 0) { if (p.uv) anyUv = true; else anyNoUv = true; if (p.doubleSided) dbl = true; }
    }
    if (nT === 0) throw new Error("no triangles");
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (!(size > 0) || !Number.isFinite(size)) throw new Error("the model has no extent");
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2, inv = 1 / size;
    const pos = new Float32Array(3 * nV), nor = new Float32Array(3 * nV);
    const uv = anyUv ? new Float32Array(2 * nV) : null;
    const noUv = anyUv && anyNoUv ? new Uint8Array(nV) : null;
    const needN = new Uint8Array(nV);
    const idx = new Uint32Array(3 * nT);
    let base = 0, ti = 0, anyNeed = false;
    for (const f of infos) {
      if (f.nt === 0) continue;
      const P = f.p.pos, N = f.p.nor, U = f.p.uv, A = f.A, C = f.cof, s = f.det < 0 ? -1 : 1, n = f.remap.length;
      for (let v = 0; v < n; v++) {
        const r = f.remap[v];
        if (r < 0) continue;
        const o = base + r, x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
        pos[3 * o] = (A[0] * x + A[1] * y + A[2] * z + A[3] - cx) * inv;
        pos[3 * o + 1] = (A[4] * x + A[5] * y + A[6] * z + A[7] - cy) * inv;
        pos[3 * o + 2] = (A[8] * x + A[9] * y + A[10] * z + A[11] - cz) * inv;
        let ok = false;
        if (N && 3 * v + 2 < N.length) {
          const a = N[3 * v], b = N[3 * v + 1], c = N[3 * v + 2];
          const nx = s * (C[0] * a + C[1] * b + C[2] * c), ny = s * (C[3] * a + C[4] * b + C[5] * c), nz = s * (C[6] * a + C[7] * b + C[8] * c);
          const l = Math.hypot(nx, ny, nz);
          if (l > 1e-20 && Number.isFinite(l)) { nor[3 * o] = nx / l; nor[3 * o + 1] = ny / l; nor[3 * o + 2] = nz / l; ok = true; }
        }
        if (!ok) { needN[o] = 1; anyNeed = true; }
        if (uv) {
          if (U && 2 * v + 1 < U.length) {
            const a = U[2 * v], b = U[2 * v + 1];
            uv[2 * o] = Number.isFinite(a) ? a : 0; uv[2 * o + 1] = Number.isFinite(b) ? b : 0;
          } else if (noUv) noUv[o] = 1;
        }
      }
      const T = f.tri, flip = f.det < 0;
      for (let k = 0; k < 3 * f.nt; k += 3) {
        idx[ti++] = base + f.remap[T[k]];
        idx[ti++] = base + f.remap[T[flip ? k + 2 : k + 1]];
        idx[ti++] = base + f.remap[T[flip ? k + 1 : k + 2]];
      }
      base += f.used;
    }
    return { pos, nor, uv, noUv, needN: anyNeed ? needN : null, idx, dropped, doubleSided: dbl, size };
  }

  /**
   * Welds vertices by position: welded id per vertex. Sort-based on the 2¹⁷ grid of the unit box; two vertices in
   * adjacent cells are welded too when they lie within WELD_TOL of each other (float noise must not split a seam just
   * because the two copies straddle a cell boundary: that would fake boundary edges on closed meshes).
   */
  function weld(pos: Float32Array): { id: Int32Array; count: number } {
    const n = pos.length / 3, keys = new Float64Array(n), S = Q + 1, TOL = 1e-6, tq = TOL * Q;
    const g = (x: number) => (Math.min(Math.max(x, -0.5), 0.5) + 0.5) * Q;
    const key = (a: number, b: number, c: number) => (a * S + b) * S + c;
    for (let v = 0; v < n; v++) keys[v] = key(Math.round(g(pos[3 * v])), Math.round(g(pos[3 * v + 1])), Math.round(g(pos[3 * v + 2])));
    const s = keys.slice().sort();
    let u = 0;
    for (let i = 0; i < n; i++) if (i === 0 || s[i] !== s[i - 1]) s[u++] = s[i];
    const find = (k: number) => {
      let a = 0, b = u - 1;
      while (a < b) { const m = (a + b) >> 1; if (s[m] < k) a = m + 1; else b = m; }
      return s[a] === k ? a : -1;
    };
    const id = new Int32Array(n), rep = new Int32Array(u).fill(-1);
    for (let v = 0; v < n; v++) { id[v] = find(keys[v]); if (rep[id[v]] < 0) rep[id[v]] = v; }
    // straddling pairs: probe the neighbour cell(s) across every nearby cell boundary, union within TOL
    const parent = new Int32Array(u);
    for (let i = 0; i < u; i++) parent[i] = i;
    const root = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    let merged = false;
    const q = [0, 0, 0], alt = [0, 0, 0];
    for (let v = 0; v < n; v++) {
      let mask = 0;
      for (let k = 0; k < 3; k++) {
        const f = g(pos[3 * v + k]), r = Math.round(f), d = f - r;
        q[k] = r;
        if (Math.abs(d) > 0.5 - tq) { mask |= 1 << k; alt[k] = r + (d > 0 ? 1 : -1); }
      }
      if (!mask) continue;
      for (let sub = mask; sub; sub = (sub - 1) & mask) {
        const w = find(key(sub & 1 ? alt[0] : q[0], sub & 2 ? alt[1] : q[1], sub & 4 ? alt[2] : q[2]));
        if (w < 0) continue;
        const o = rep[w];
        if (Math.hypot(pos[3 * o] - pos[3 * v], pos[3 * o + 1] - pos[3 * v + 1], pos[3 * o + 2] - pos[3 * v + 2]) > TOL) continue;
        const a = root(id[v]), b = root(w);
        if (a !== b) { parent[Math.max(a, b)] = Math.min(a, b); merged = true; }
      }
    }
    if (!merged) return { id, count: u };
    const label = new Int32Array(u).fill(-1);
    let c = 0;
    for (let i = 0; i < u; i++) { const r = root(i); if (label[r] < 0) label[r] = c++; label[i] = label[r]; }
    for (let v = 0; v < n; v++) id[v] = label[id[v]];
    return { id, count: c };
  }

  /** Edges used by exactly one triangle after welding by position (A3.3 item 6: an open mesh). */
  function boundaryEdges(idx: Uint32Array, id: Int32Array, count: number): number {
    const T = idx.length / 3, keys = new Float64Array(3 * T);
    let k = 0;
    const key = (a: number, b: number) => (a < b ? a * count + b : b * count + a);
    for (let t = 0; t < T; t++) {
      const a = id[idx[3 * t]], b = id[idx[3 * t + 1]], c = id[idx[3 * t + 2]];
      if (a === b || b === c || a === c) continue;
      keys[k++] = key(a, b); keys[k++] = key(b, c); keys[k++] = key(c, a);
    }
    const s = keys.subarray(0, k).sort();
    let boundary = 0;
    for (let i = 0; i < k;) {
      let j = i + 1;
      while (j < k && s[j] === s[i]) j++;
      if (j - i === 1) boundary++;
      i = j;
    }
    return boundary;
  }

  /**
   * 2. Normals of the vertices that have none (or an invalid one): angle-weighted over the faces around the welded
   * position whose normal is within the crease angle of the corner's face, so curved surfaces shade smoothly across
   * UV seams while a box keeps its corners. A vertex whose corners get different normals is split.
   */
  function fixNormals(m: Merged, id: Int32Array, count: number): { m: Merged; computed: number } {
    const need = m.needN;
    if (!need) return { m, computed: 0 };
    const { pos, idx } = m, T = idx.length / 3, V = pos.length / 3;
    const fn = new Float32Array(3 * T), ang = new Float32Array(3 * T);
    for (let t = 0; t < T; t++) {
      const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
      const P = [pos[a], pos[a + 1], pos[a + 2]], Qp = [pos[b], pos[b + 1], pos[b + 2]], R = [pos[c], pos[c + 1], pos[c + 2]];
      const e1 = [Qp[0] - P[0], Qp[1] - P[1], Qp[2] - P[2]], e2 = [R[0] - P[0], R[1] - P[1], R[2] - P[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) { fn[3 * t] = nx / l; fn[3 * t + 1] = ny / l; fn[3 * t + 2] = nz / l; }
      const corner = (o: number[], p1: number[], p2: number[]) => {
        const ux = p1[0] - o[0], uy = p1[1] - o[1], uz = p1[2] - o[2], vx = p2[0] - o[0], vy = p2[1] - o[1], vz = p2[2] - o[2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        return Math.atan2(Math.hypot(cx, cy, cz), ux * vx + uy * vy + uz * vz);
      };
      ang[3 * t] = corner(P, Qp, R); ang[3 * t + 1] = corner(Qp, R, P); ang[3 * t + 2] = corner(R, P, Qp);
    }
    // corners by welded position (CSR)
    const start = new Int32Array(count + 1);
    for (let c = 0; c < 3 * T; c++) start[id[idx[c]] + 1]++;
    for (let w = 0; w < count; w++) start[w + 1] += start[w];
    const fill = start.slice(0, count), list = new Int32Array(3 * T);
    for (let c = 0; c < 3 * T; c++) list[fill[id[idx[c]]]++] = c;
    const cosC = Math.cos((RULES.creaseDeg * Math.PI) / 180);
    const nor = m.nor, assigned = new Uint8Array(V), newIdx = idx.slice();
    const extraSrc: number[] = [], extraN: number[] = [];
    const extraOf = new Map<number, number[]>();
    let computed = 0;
    const f32 = Math.fround;
    for (let c = 0; c < 3 * T; c++) {
      const v = idx[c];
      if (!need[v]) continue;
      const t = (c / 3) | 0, w = id[v];
      const fx = fn[3 * t], fy = fn[3 * t + 1], fz = fn[3 * t + 2];
      // a zero-area triangle (e.g. at a lat-long pole) has no normal of its own: its corners take the smooth
      // average of every face around the position, so they agree with the real triangles sharing the vertex
      const flat = fx === 0 && fy === 0 && fz === 0;
      let nx = 0, ny = 0, nz = 0;
      for (let i = start[w]; i < start[w + 1]; i++) {
        const c2 = list[i], t2 = (c2 / 3) | 0;
        const gx = fn[3 * t2], gy = fn[3 * t2 + 1], gz = fn[3 * t2 + 2];
        if (!flat && fx * gx + fy * gy + fz * gz < cosC) continue;
        nx += ang[c2] * gx; ny += ang[c2] * gy; nz += ang[c2] * gz;
      }
      let l = Math.hypot(nx, ny, nz);
      if (!(l > 1e-20)) { nx = fx; ny = fy; nz = fz; l = Math.hypot(nx, ny, nz); }
      if (!(l > 1e-20)) { nx = 0; ny = 0; nz = 1; l = 1; }
      const ax = f32(nx / l), ay = f32(ny / l), az = f32(nz / l);
      if (!assigned[v]) { nor[3 * v] = ax; nor[3 * v + 1] = ay; nor[3 * v + 2] = az; assigned[v] = 1; computed++; continue; }
      if (nor[3 * v] === ax && nor[3 * v + 1] === ay && nor[3 * v + 2] === az) continue;
      let ex = extraOf.get(v);
      if (!ex) { ex = []; extraOf.set(v, ex); }
      let hit = -1;
      for (const e of ex) {
        const o = 3 * (e - V);
        if (extraN[o] === ax && extraN[o + 1] === ay && extraN[o + 2] === az) { hit = e; break; }
      }
      if (hit < 0) { hit = V + extraSrc.length; extraSrc.push(v); extraN.push(ax, ay, az); ex.push(hit); }
      newIdx[c] = hit;
    }
    const E = extraSrc.length;
    if (E === 0) return { m: { ...m, needN: null }, computed };
    const V2 = V + E;
    const pos2 = new Float32Array(3 * V2), nor2 = new Float32Array(3 * V2);
    pos2.set(pos); nor2.set(nor);
    const uv2 = m.uv ? new Float32Array(2 * V2) : null, noUv2 = m.noUv ? new Uint8Array(V2) : null;
    if (uv2 && m.uv) uv2.set(m.uv);
    if (noUv2 && m.noUv) noUv2.set(m.noUv);
    for (let e = 0; e < E; e++) {
      const s = extraSrc[e], o = V + e;
      pos2[3 * o] = pos[3 * s]; pos2[3 * o + 1] = pos[3 * s + 1]; pos2[3 * o + 2] = pos[3 * s + 2];
      nor2[3 * o] = extraN[3 * e]; nor2[3 * o + 1] = extraN[3 * e + 1]; nor2[3 * o + 2] = extraN[3 * e + 2];
      if (uv2 && m.uv) { uv2[2 * o] = m.uv[2 * s]; uv2[2 * o + 1] = m.uv[2 * s + 1]; }
      if (noUv2 && m.noUv) noUv2[o] = m.noUv[s];
    }
    return { m: { ...m, pos: pos2, nor: nor2, uv: uv2, noUv: noUv2, needN: null, idx: newIdx }, computed: computed + E };
  }

  /**
   * 4. UV statistics (A3.3 item 4): per triangle with a 3D area, the UV area; degenerate when ~0 (relative to the
   * model's average density) or without UVs. mmPerUv = √(Σ area₃D / Σ area_UV) over the non-degenerate triangles; CV of
   * the per-triangle ratio √(area₃D / area_UV), weighted by 3D area. Unusable when the UV area is ~0, more than 30 %
   * of the triangles are degenerate or CV > 1.5.
   */
  function uvStats(pos: Float32Array, uv: Float32Array | null, idx: Uint32Array, noUv: Uint8Array | null): UvInfo {
    const T = idx.length / 3;
    const none: UvInfo = { present: false, usable: false, reason: "no UVs", mmPerUv: 0, degenerateFraction: 1, cv: 0, uvArea: 0 };
    if (!uv) return none;
    const A3 = new Float64Array(T), Au = new Float64Array(T);
    let s3 = 0, su = 0, total3 = 0;
    for (let t = 0; t < T; t++) {
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      const e1x = pos[3 * b] - pos[3 * a], e1y = pos[3 * b + 1] - pos[3 * a + 1], e1z = pos[3 * b + 2] - pos[3 * a + 2];
      const e2x = pos[3 * c] - pos[3 * a], e2y = pos[3 * c + 1] - pos[3 * a + 1], e2z = pos[3 * c + 2] - pos[3 * a + 2];
      A3[t] = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      total3 += A3[t];
      if (noUv && (noUv[a] || noUv[b] || noUv[c])) { Au[t] = -1; continue; }
      const du1 = uv[2 * b] - uv[2 * a], dv1 = uv[2 * b + 1] - uv[2 * a + 1], du2 = uv[2 * c] - uv[2 * a], dv2 = uv[2 * c + 1] - uv[2 * a + 1];
      Au[t] = 0.5 * Math.abs(du1 * dv2 - du2 * dv1);
      s3 += A3[t]; su += Au[t];
    }
    const ratio = s3 > 0 ? su / s3 : 0;          // mean UV area per 3D area
    const a3Floor = 1e-12 * Math.max(total3, 1e-30) / Math.max(T, 1);
    let counted = 0, deg = 0, nd3 = 0, ndu = 0;
    for (let t = 0; t < T; t++) {
      if (!(A3[t] > a3Floor)) continue;
      counted++;
      if (!(Au[t] > Math.max(1e-14, 1e-6 * A3[t] * ratio))) { deg++; Au[t] = -1; continue; }
      nd3 += A3[t]; ndu += Au[t];
    }
    const mmPerUv = ndu > 0 ? Math.sqrt(nd3 / ndu) : 0;
    let m1 = 0, m2 = 0;
    if (ndu > 0) {
      for (let t = 0; t < T; t++) {
        if (!(A3[t] > a3Floor) || !(Au[t] > 0)) continue;
        const r = Math.sqrt(A3[t] / Au[t]);
        m1 += A3[t] * r; m2 += A3[t] * r * r;
      }
    }
    const mean = nd3 > 0 ? m1 / nd3 : 0, cv = mean > 0 ? Math.sqrt(Math.max(m2 / nd3 - mean * mean, 0)) / mean : 0;
    const degenerateFraction = counted > 0 ? deg / counted : 1;
    let reason: string | null = null;
    if (!(ndu > 1e-12)) reason = "UV area ≈ 0";
    else if (degenerateFraction > RULES.maxDegenerate) reason = `${Math.round(degenerateFraction * 100)} % of the triangles have no UV area`;
    else if (cv > RULES.maxCv) reason = `UV scale too uneven (CV ${cv.toFixed(2)})`;
    return { present: true, usable: reason === null, reason, mmPerUv, degenerateFraction, cv, uvArea: ndu };
  }

  /** The robust bounding square of a UV set: offset (0.5 % quantiles of u and v over ≤ 65536 sampled vertices) and
   *  side (the larger 0.5–99.5 % range), so stray vertices do not squash the rest. */
  function uvFrame(uv: Float32Array): { u0: number; v0: number; size: number } {
    const n = uv.length / 2, step = Math.max(1, Math.floor(n / 65536)), us: number[] = [], vs: number[] = [];
    for (let i = 0; i < n; i += step) { us.push(uv[2 * i]); vs.push(uv[2 * i + 1]); }
    us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
    const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
    const u0 = q(us, 0.005), v0 = q(vs, 0.005), size = Math.max(q(us, 0.995) - u0, q(vs, 0.995) - v0);
    return size > 1e-12 && Number.isFinite(size) ? { u0, v0, size } : { u0: 0, v0: 0, size: 1 };
  }

  /** Box projection (A3.3 item 4): each triangle on the plane of its face normal's dominant axis; vertices split per
   *  projection face. uv = projected coordinate + ½, oriented so cross(∂S/∂u, ∂S/∂v) points out of that face. */
  function boxMap(pos: Float32Array, nor: Float32Array, idx: Uint32Array): Split {
    const V = pos.length / 3, T = idx.length / 3;
    const slot = new Int32Array(6 * V).fill(-1), src = new Uint32Array(3 * T), uv = new Float32Array(6 * T), out = new Uint32Array(3 * T);
    let nv = 0;
    for (let t = 0; t < T; t++) {
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      const e1x = pos[3 * b] - pos[3 * a], e1y = pos[3 * b + 1] - pos[3 * a + 1], e1z = pos[3 * b + 2] - pos[3 * a + 2];
      const e2x = pos[3 * c] - pos[3 * a], e2y = pos[3 * c + 1] - pos[3 * a + 1], e2z = pos[3 * c + 2] - pos[3 * a + 2];
      let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      if (!(Math.abs(fx) + Math.abs(fy) + Math.abs(fz) > 0)) {             // degenerate: the shading normals decide
        fx = nor[3 * a] + nor[3 * b] + nor[3 * c]; fy = nor[3 * a + 1] + nor[3 * b + 1] + nor[3 * c + 1]; fz = nor[3 * a + 2] + nor[3 * b + 2] + nor[3 * c + 2];
      }
      const ax = Math.abs(fx), ay = Math.abs(fy), az = Math.abs(fz);
      const face = ax >= ay && ax >= az ? (fx < 0 ? 1 : 0) : ay >= az ? (fy < 0 ? 3 : 2) : (fz < 0 ? 5 : 4);
      for (let k = 0; k < 3; k++) {
        const v = idx[3 * t + k];
        let s = slot[6 * v + face];
        if (s < 0) {
          s = nv++;
          slot[6 * v + face] = s;
          src[s] = v;
          const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
          let u: number, w: number;
          switch (face) {
            case 0: u = -z; w = y; break;     // +x
            case 1: u = z; w = y; break;      // −x
            case 2: u = x; w = -z; break;     // +y
            case 3: u = x; w = z; break;      // −y
            case 4: u = x; w = y; break;      // +z
            default: u = -x; w = y; break;    // −z
          }
          uv[2 * s] = u + 0.5; uv[2 * s + 1] = w + 0.5;
        }
        out[3 * t + k] = s;
      }
    }
    return { uv: uv.slice(0, 2 * nv), idx: out, src: src.slice(0, nv) };
  }

  /** Spherical projection about the centre (A3.3 item 4): u = longitude/2π + ½ (½ toward the camera, +z), v =
   *  latitude/π + ½; triangles across the back seam get u + 1 on their low side (vertices split); a corner on the
   *  polar axis takes the mean u of its triangle's other corners (its own vertex). */
  function sphereMap(pos: Float32Array, idx: Uint32Array): Split {
    const V = pos.length / 3, T = idx.length / 3;
    const U = new Float64Array(V), W = new Float64Array(V), pole = new Uint8Array(V);
    for (let v = 0; v < V; v++) {
      const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2], r = Math.hypot(x, y, z), h = Math.hypot(x, z);
      if (!(r > 1e-9) || !(h > 1e-7 * r)) { pole[v] = 1; U[v] = 0.5; W[v] = r > 1e-9 ? (y > 0 ? 1 : 0) : 0.5; continue; }
      U[v] = Math.atan2(x, z) / (2 * Math.PI) + 0.5;
      W[v] = Math.asin(Math.min(Math.max(y / r, -1), 1)) / Math.PI + 0.5;
    }
    const slot = new Int32Array(2 * V).fill(-1), src = new Uint32Array(3 * T), uv = new Float32Array(6 * T), out = new Uint32Array(3 * T);
    let nv = 0;
    for (let t = 0; t < T; t++) {
      let mn = Infinity, mx = -Infinity;
      for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; if (!pole[v]) { mn = Math.min(mn, U[v]); mx = Math.max(mx, U[v]); } }
      const seam = mx - mn > 0.5;
      let su = 0, sn = 0;
      for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; if (!pole[v]) { su += seam && U[v] < 0.5 ? U[v] + 1 : U[v]; sn++; } }
      for (let k = 0; k < 3; k++) {
        const v = idx[3 * t + k];
        let s: number;
        if (pole[v]) {
          s = nv++;
          src[s] = v; uv[2 * s] = sn > 0 ? su / sn : 0.5; uv[2 * s + 1] = W[v];
        } else {
          const variant = seam && U[v] < 0.5 ? 1 : 0;
          s = slot[2 * v + variant];
          if (s < 0) { s = nv++; slot[2 * v + variant] = s; src[s] = v; uv[2 * s] = U[v] + variant; uv[2 * s + 1] = W[v]; }
        }
        out[3 * t + k] = s;
      }
    }
    return { uv: uv.slice(0, 2 * nv), idx: out, src: src.slice(0, nv) };
  }

  /** 5. Tangents from the final uv (A3.3 item 5): per triangle ∂S/∂u and ∂S/∂v, normalised and area-weighted onto its
   *  corners, summed over the copies of one surface point (bit-identical position, normal and uv), Gram–Schmidt
   *  against the vertex normal, w = sign of cross(N, T)·∂S/∂v. Degenerate or NaN results get any unit vector
   *  orthogonal to the normal with w = +1. */
  function tangents(pos: Float32Array, nor: Float32Array, uv: Float32Array, idx: Uint32Array): { tan: Float32Array; fallback: number } {
    const V = pos.length / 3, T = idx.length / 3;
    const ta = new Float64Array(3 * V), ba = new Float64Array(3 * V);
    for (let t = 0; t < T; t++) {
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      const e1x = pos[3 * b] - pos[3 * a], e1y = pos[3 * b + 1] - pos[3 * a + 1], e1z = pos[3 * b + 2] - pos[3 * a + 2];
      const e2x = pos[3 * c] - pos[3 * a], e2y = pos[3 * c + 1] - pos[3 * a + 1], e2z = pos[3 * c + 2] - pos[3 * a + 2];
      const du1 = uv[2 * b] - uv[2 * a], dv1 = uv[2 * b + 1] - uv[2 * a + 1], du2 = uv[2 * c] - uv[2 * a], dv2 = uv[2 * c + 1] - uv[2 * a + 1];
      const r = du1 * dv2 - du2 * dv1;
      if (!(Math.abs(r) > 1e-20)) continue;
      const sx = (e1x * dv2 - e2x * dv1) / r, sy = (e1y * dv2 - e2y * dv1) / r, sz = (e1z * dv2 - e2z * dv1) / r;
      const tx = (e2x * du1 - e1x * du2) / r, ty = (e2y * du1 - e1y * du2) / r, tz = (e2z * du1 - e1z * du2) / r;
      const area = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      const ls = Math.hypot(sx, sy, sz), lt = Math.hypot(tx, ty, tz);
      if (!(ls > 0) || !(lt > 0) || !Number.isFinite(ls + lt + area)) continue;
      const ws = area / ls, wt = area / lt;
      for (const v of [a, b, c]) {
        ta[3 * v] += sx * ws; ta[3 * v + 1] += sy * ws; ta[3 * v + 2] += sz * ws;
        ba[3 * v] += tx * wt; ba[3 * v + 1] += ty * wt; ba[3 * v + 2] += tz * wt;
      }
    }
    // Copies of one surface point (bit-identical position, normal and uv under different indices: non-indexed files
    // such as Fox.glb, a file's UV-seam copies that the box / sphere projection maps to the same uv) share one frame;
    // otherwise each copy only sees its own triangles and the frame jumps at every such edge (faceted gratings).
    const rep = new Int32Array(V);
    {
      const PB = new Uint32Array(pos.buffer, pos.byteOffset, 3 * V), NB = new Uint32Array(nor.buffer, nor.byteOffset, 3 * V);
      const UB = new Uint32Array(uv.buffer, uv.byteOffset, 2 * V);
      let cap = 16;
      while (cap < 2 * V) cap *= 2;
      const table = new Int32Array(cap).fill(-1), mask = cap - 1;
      const same = (a: number, b: number) => PB[3 * a] === PB[3 * b] && PB[3 * a + 1] === PB[3 * b + 1] && PB[3 * a + 2] === PB[3 * b + 2]
        && NB[3 * a] === NB[3 * b] && NB[3 * a + 1] === NB[3 * b + 1] && NB[3 * a + 2] === NB[3 * b + 2] && UB[2 * a] === UB[2 * b] && UB[2 * a + 1] === UB[2 * b + 1];
      for (let v = 0; v < V; v++) {
        let h = 0x811c9dc5;
        const words = [PB[3 * v], PB[3 * v + 1], PB[3 * v + 2], NB[3 * v], NB[3 * v + 1], NB[3 * v + 2], UB[2 * v], UB[2 * v + 1]];
        for (const w of words) { h = Math.imul(h ^ w, 0x01000193); h ^= h >>> 15; }
        let s = h & mask;
        for (;;) {
          const o = table[s];
          if (o < 0) { table[s] = v; rep[v] = v; break; }
          if (same(o, v)) { rep[v] = o; break; }
          s = (s + 1) & mask;
        }
      }
      for (let v = 0; v < V; v++) {
        const r = rep[v];
        if (r === v) continue;
        for (let k = 0; k < 3; k++) { ta[3 * r + k] += ta[3 * v + k]; ba[3 * r + k] += ba[3 * v + k]; }
      }
    }
    const tan = new Float32Array(4 * V);
    let fallback = 0;
    for (let v = 0; v < V; v++) {
      const nx = nor[3 * v], ny = nor[3 * v + 1], nz = nor[3 * v + 2], r = rep[v];
      const ax = ta[3 * r], ay = ta[3 * r + 1], az = ta[3 * r + 2], la = Math.hypot(ax, ay, az);
      const d = nx * ax + ny * ay + nz * az;
      let tx = ax - nx * d, ty = ay - ny * d, tz = az - nz * d;
      let l = Math.hypot(tx, ty, tz), w = 1;
      if (!(l > 1e-6 * la) || !(l > 1e-30) || !Number.isFinite(l)) {
        fallback++;
        const ex = Math.abs(nx) < 0.9 ? 1 : 0, ey = ex ? 0 : 1;          // the axis least aligned with N
        const e = ex * nx + ey * ny;
        tx = ex - nx * e; ty = ey - ny * e; tz = -nz * e;
        l = Math.hypot(tx, ty, tz);
        if (!(l > 0)) { tx = 1; ty = 0; tz = 0; l = 1; }
      } else {
        const bx = ba[3 * r], by = ba[3 * r + 1], bz = ba[3 * r + 2];
        const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
        w = cx * bx + cy * by + cz * bz < 0 ? -1 : 1;
      }
      tan[4 * v] = tx / l; tan[4 * v + 1] = ty / l; tan[4 * v + 2] = tz / l; tan[4 * v + 3] = w;
    }
    return { tan, fallback };
  }

  /** 6. Double-sided copy (A3.3 item 6): every triangle again, reversed, with negated normals, the same tangent xyz
   *  and negated w, so cross(N, T)·w stays the ∂S/∂v direction and every material stays FrontSide. */
  function doubleSide(g: Geo): Geo {
    const V = g.pos.length / 3, T = g.idx.length / 3;
    const pos = new Float32Array(6 * V), nor = new Float32Array(6 * V), tan = new Float32Array(8 * V), uv = new Float32Array(4 * V), idx = new Uint32Array(6 * T);
    pos.set(g.pos); pos.set(g.pos, 3 * V);
    nor.set(g.nor);
    for (let i = 0; i < 3 * V; i++) nor[3 * V + i] = -g.nor[i];
    tan.set(g.tan);
    for (let v = 0; v < V; v++) {
      const o = 4 * (V + v), s = 4 * v;
      tan[o] = g.tan[s]; tan[o + 1] = g.tan[s + 1]; tan[o + 2] = g.tan[s + 2]; tan[o + 3] = -g.tan[s + 3];
    }
    uv.set(g.uv); uv.set(g.uv, 2 * V);
    idx.set(g.idx);
    for (let t = 0; t < T; t++) {
      idx[3 * (T + t)] = g.idx[3 * t] + V; idx[3 * (T + t) + 1] = g.idx[3 * t + 2] + V; idx[3 * (T + t) + 2] = g.idx[3 * t + 1] + V;
    }
    return { pos, nor, tan, uv, idx };
  }

  interface Base { m: Merged; stats: ModelStats }

  /** Steps 1–4 of A3.3 and the statistics. */
  function prepare(parts: readonly ModelPart[]): Base {
    const ms: Record<string, number> = {};
    let t0 = now();
    let m = merge(parts);
    ms.merge = now() - t0; t0 = now();
    const w = weld(m.pos);
    ms.weld = now() - t0; t0 = now();
    const boundary = boundaryEdges(m.idx, w.id, w.count);
    ms.boundary = now() - t0; t0 = now();
    const fixed = fixNormals(m, w.id, w.count);
    m = fixed.m;
    ms.normals = now() - t0; t0 = now();
    const { pos, idx } = m, V = pos.length / 3, T = idx.length / 3;
    const half: [number, number, number] = [0, 0, 0];
    let radius = 0;
    for (let v = 0; v < V; v++) {
      const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
      half[0] = Math.max(half[0], Math.abs(x)); half[1] = Math.max(half[1], Math.abs(y)); half[2] = Math.max(half[2], Math.abs(z));
      radius = Math.max(radius, Math.hypot(x, y, z));
    }
    let area = 0, rArea = 0;
    for (let t = 0; t < T; t++) {
      const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const A = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      area += A;
      rArea += A * Math.hypot((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3);
    }
    const uv = uvStats(pos, m.uv, idx, m.noUv);
    ms.stats = now() - t0;
    return {
      m,
      stats: {
        triangles: T, vertices: V, dropped: m.dropped, boundaryEdges: boundary, materialDoubleSided: m.doubleSided,
        open: boundary > 0 || m.doubleSided, computedNormals: fixed.computed,
        halfN: half, radiusN: radius, meanRadiusN: area > 0 ? rArea / area : radius, areaN: area, uv, ms,
      },
    };
  }

  /** Mapping (A3.3 item 4), tangents (5) and the double-sided copy (6) of a prepared model. `doubleSided` null =
   *  automatic (open mesh or a double-sided glTF material). */
  function build(b: Base, mapping: ModelMapping, doubleSided: boolean | null): ModelBuilt {
    const t0 = now(), m = b.m, s = b.stats, uvOk = !!m.uv && s.uv.mmPerUv > 0;
    let used: UsedMapping, note: string | null = null;
    if (mapping === "auto") { used = s.uv.usable ? "uv" : "box"; if (used === "box") note = s.uv.present ? "UVs unusable" : "no UVs"; }
    else if (mapping === "uv" && !uvOk) { used = "box"; note = s.uv.present ? "no UV area" : "no UVs"; }
    else used = mapping;
    let g: Geo, domain: [number, number], fallback: number;
    if (used === "uv" && m.uv) {
      // UVs into their robust bounding square (0.5–99.5 % quantiles): quantised (gltfpack) or tiled UVs keep p
      // physical either way, but this way domainMm is the real p extent (wear placement, Prism's centre) and vUv
      // stays near [0, 1] (float precision)
      const f = uvFrame(m.uv), uv = m.uv.slice();
      for (let i = 0; i < uv.length; i += 2) { uv[i] = (uv[i] - f.u0) / f.size; uv[i + 1] = (uv[i + 1] - f.v0) / f.size; }
      const t = tangents(m.pos, m.nor, uv, m.idx);
      g = { pos: m.pos.slice(), nor: m.nor.slice(), tan: t.tan, uv, idx: m.idx.slice() };
      fallback = t.fallback;
      domain = [s.uv.mmPerUv * f.size, s.uv.mmPerUv * f.size];
    } else {
      const sp = used === "sphere" ? sphereMap(m.pos, m.idx) : boxMap(m.pos, m.nor, m.idx);
      const n = sp.src.length, pos = new Float32Array(3 * n), nor = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        const v = sp.src[i];
        pos[3 * i] = m.pos[3 * v]; pos[3 * i + 1] = m.pos[3 * v + 1]; pos[3 * i + 2] = m.pos[3 * v + 2];
        nor[3 * i] = m.nor[3 * v]; nor[3 * i + 1] = m.nor[3 * v + 1]; nor[3 * i + 2] = m.nor[3 * v + 2];
      }
      const t = tangents(pos, nor, sp.uv, sp.idx);
      g = { pos, nor, tan: t.tan, uv: sp.uv, idx: sp.idx };
      fallback = t.fallback;
      domain = used === "sphere" ? [2 * Math.PI * s.meanRadiusN, Math.PI * s.meanRadiusN] : [1, 1];
    }
    const dbl = doubleSided ?? s.open;
    if (dbl) g = doubleSide(g);
    return { mapping: used, note, doubleSided: dbl, domain, ...g, tangentFallback: fallback, ms: now() - t0 };
  }

  return { RULES, merge, weld, boundaryEdges, fixNormals, uvStats, boxMap, sphereMap, tangents, doubleSide, prepare, build };
}

export type ModelKernel = ReturnType<typeof modelKernel>;
type Base = ReturnType<ModelKernel["prepare"]>;

// ---------------------------------------------------------------------------------------------------------------
// glTF container and JSON rewrite (pure)
// ---------------------------------------------------------------------------------------------------------------

/** Loose glTF JSON (only the fields this module reads or rewrites). */
interface GltfJson {
  asset?: { version?: unknown };
  extensionsUsed?: string[]; extensionsRequired?: string[]; extensions?: Record<string, unknown>;
  materials?: { name?: string; doubleSided?: boolean }[];
  meshes?: { primitives?: { targets?: unknown; extensions?: Record<string, unknown>; material?: number }[]; weights?: unknown }[];
  nodes?: { weights?: unknown }[];
  buffers?: { uri?: string; byteLength?: number }[];
  textures?: unknown; images?: unknown; samplers?: unknown; animations?: unknown;
  [k: string]: unknown;
}

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;

/** A GLB's JSON and BIN chunk, or a .gltf's JSON; "Not a glTF 2.0 file" for anything else. */
export function readGltfContainer(bytes: ArrayBuffer): { json: GltfJson; bin: Uint8Array | null; glb: boolean } {
  const notGltf = (why: string) => new ModelError("Not a glTF 2.0 file", why);
  const dec = new TextDecoder();
  let json: unknown, bin: Uint8Array | null = null, glb = false;
  if (bytes.byteLength >= 12 && new DataView(bytes).getUint32(0, true) === GLB_MAGIC) {
    glb = true;
    const dv = new DataView(bytes), version = dv.getUint32(4, true), length = Math.min(dv.getUint32(8, true), bytes.byteLength);
    if (version !== 2) throw new ModelError(version === 1 ? "glTF 1.0 is not supported (glTF 2.0 only)" : "Not a glTF 2.0 file", `GLB version ${version}`);
    let off = 12;
    while (off + 8 <= length) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      off += 8;
      if (off + len > length) throw notGltf("truncated GLB chunk");
      if (type === CHUNK_JSON && json === undefined) {
        try { json = JSON.parse(dec.decode(new Uint8Array(bytes, off, len))); } catch (e) { throw notGltf(`GLB JSON: ${String(e)}`); }
      } else if (type === CHUNK_BIN && bin === null) bin = new Uint8Array(bytes, off, len);
      off += len;
    }
    if (json === undefined) throw notGltf("GLB without a JSON chunk");
  } else {
    const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 64));
    let i = 0;
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;          // UTF-8 BOM
    while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
    if (head[i] !== 0x7b) throw notGltf("neither GLB nor JSON");
    try { json = JSON.parse(dec.decode(bytes)); } catch (e) { throw notGltf(`JSON: ${String(e)}`); }
  }
  const j = json as GltfJson;
  const v = j && typeof j === "object" && j.asset && typeof j.asset === "object" ? String(j.asset.version ?? "") : "";
  if (!/^2\.\d+/.test(v)) throw new ModelError(v.startsWith("1") ? "glTF 1.0 is not supported (glTF 2.0 only)" : "Not a glTF 2.0 file", `asset.version "${v}"`);
  return { json: j, bin, glb };
}

/** Extension prefixes the rewrite removes (textures, materials, animation pointers): the holographic materials replace
 *  every material, and a file must not fail to load because of an unsupported texture format. */
const DROPPED_EXTENSIONS = /^(?:KHR_texture_|KHR_materials_|EXT_texture_|KHR_animation_pointer$|EXT_lights_image_based$|MSFT_texture_dds$|KHR_xmp)/;

/** Rewrites glTF JSON in place for geometry-only loading (see the header); returns the per-material doubleSided flags. */
export function stripGltf(json: GltfJson): { doubleSided: boolean[] } {
  const mats = Array.isArray(json.materials) ? json.materials : [];
  const doubleSided = mats.map((m) => !!(m && m.doubleSided === true));
  if (Array.isArray(json.materials)) json.materials = mats.map((m, i) => ({ name: typeof m?.name === "string" ? m.name : `material ${i}`, doubleSided: doubleSided[i] }));
  delete json.textures; delete json.images; delete json.samplers; delete json.animations;
  for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
    if (!mesh) continue;
    delete mesh.weights;
    for (const pr of Array.isArray(mesh.primitives) ? mesh.primitives : []) {
      if (!pr) continue;
      delete pr.targets;
      if (pr.extensions && typeof pr.extensions === "object") {
        for (const k of Object.keys(pr.extensions)) if (DROPPED_EXTENSIONS.test(k)) delete pr.extensions[k];
      }
    }
  }
  for (const node of Array.isArray(json.nodes) ? json.nodes : []) if (node) delete node.weights;
  const keep = (list: unknown) => (Array.isArray(list) ? list.filter((x) => typeof x === "string" && !DROPPED_EXTENSIONS.test(x)) : undefined);
  if (json.extensionsUsed) json.extensionsUsed = keep(json.extensionsUsed) ?? [];
  if (json.extensionsRequired) json.extensionsRequired = keep(json.extensionsRequired) ?? [];
  if (json.extensions && typeof json.extensions === "object") for (const k of Object.keys(json.extensions)) if (DROPPED_EXTENSIONS.test(k)) delete json.extensions[k];
  return { doubleSided };
}

/** A GLB from JSON and an optional BIN chunk (the rewritten file handed to GLTFLoader). */
export function buildGlb(json: unknown, bin: Uint8Array | null): ArrayBuffer {
  const js = new TextEncoder().encode(JSON.stringify(json));
  const jl = (js.length + 3) & ~3, bl = bin ? (bin.byteLength + 3) & ~3 : 0;
  const total = 12 + 8 + jl + (bin ? 8 + bl : 0);
  const out = new ArrayBuffer(total), dv = new DataView(out), u8 = new Uint8Array(out);
  dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, CHUNK_JSON, true);
  u8.set(js, 20);
  for (let i = 20 + js.length; i < 20 + jl; i++) u8[i] = 0x20;
  if (bin) {
    const o = 20 + jl;
    dv.setUint32(o, bl, true); dv.setUint32(o + 4, CHUNK_BIN, true);
    u8.set(bin, o + 8);
  }
  return out;
}

/** The short caption message of a loading failure (A3.1). */
export function modelErrorMessage(e: unknown): string {
  if (e instanceof ModelError) return e.message;
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/draco/i.test(s)) return "Draco decoder failed";
  if (/meshopt/i.test(s)) return "Meshopt decoder failed";
  const buf = /Failed to load buffer "([^"]*)"/.exec(s);
  if (buf) return `missing file ${decodeURIComponent(buf[1]).split("/").pop()}`;
  if (/Unsupported asset|glTF versions|JSON/i.test(s)) return "Not a glTF 2.0 file";
  if (/no triangles/.test(s)) return "no triangle meshes in this file";
  if (/no extent/.test(s)) return "the model has no extent (all vertices coincide)";
  if (/memory|allocation|Array buffer/i.test(s)) return "out of memory (model too large)";
  return "could not read the model";
}

/** A load that failed because of the file's own bytes (the A3.1 messages above), so it can never succeed: a stored copy
 *  (IndexedDB) that fails this way is deleted. False for failures that may pass on another try — a loader chunk or decoder
 *  that could not be fetched (offline, a new deployment), memory, an unexpected exception — so they never cost the user
 *  the stored model. */
export function isModelFileFault(e: unknown): boolean {
  return e instanceof ModelError
    && /^(Not a glTF 2\.0 file|glTF 1\.0 is not supported|missing file |model too large \(|no triangle meshes|the model has no extent|file larger than)/.test(e.message);
}

/** "15.5k", "46k", "3.2M". */
export function formatTriangles(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1) : Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

/** The caption's mapping text: "UV mapping", "box mapping (no UVs)", … */
export function mappingLabel(b: { mapping: UsedMapping; note: string | null }): string {
  const name = b.mapping === "uv" ? "UV mapping" : b.mapping === "box" ? "box mapping" : "spherical mapping";
  return b.note ? `${name} (${b.note})` : name;
}

/** External buffers of a .gltf loaded from bytes (no URL to resolve them against) must be data: URIs or among the
 *  files given with it; otherwise "missing file …" before anything is fetched. */
export function checkExternalBuffers(json: GltfJson, files: ReadonlyMap<string, unknown> | null): void {
  const have = new Set([...(files?.keys() ?? [])].map((n) => n.toLowerCase()));
  for (const b of Array.isArray(json.buffers) ? json.buffers : []) {
    const uri = b && typeof b.uri === "string" ? b.uri : null;
    if (!uri || uri.startsWith("data:")) continue;
    const name = baseName(uri);
    if (!have.has(name.toLowerCase())) throw new ModelError(`missing file ${name} (select it together with the .gltf)`);
  }
}

/** File name of a URL or path ("/models/duck.glb?x" → "duck.glb"). */
export function baseName(s: string): string {
  const f = s.split(/[?#]/)[0].split(/[\\/]/).pop() ?? "";
  try { return decodeURIComponent(f) || "model"; } catch { return f || "model"; }
}

// ---------------------------------------------------------------------------------------------------------------
// Loaders (lazy chunk) and the scene → parts extraction (page)
// ---------------------------------------------------------------------------------------------------------------

type GltfLoaderModule = typeof import("three/addons/loaders/GLTFLoader.js");
interface Loaders { mod: GltfLoaderModule; draco: import("three/addons/loaders/DRACOLoader.js").DRACOLoader; dracoJs: boolean; meshopt: unknown }
let loadersPromise: Promise<Loaders> | null = null;

function dracoPath(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}draco/`;
}

async function loaders(): Promise<Loaders> {
  loadersPromise ??= (async () => {
    const [mod, dracoMod, meshoptMod] = await Promise.all([
      import("three/addons/loaders/GLTFLoader.js"),
      import("three/addons/loaders/DRACOLoader.js"),
      import("three/addons/libs/meshopt_decoder.module.js"),
    ]);
    const draco = new dracoMod.DRACOLoader();
    draco.setDecoderPath(dracoPath());               // wasm where WebAssembly exists, else draco_decoder.js
    const meshopt = meshoptMod.MeshoptDecoder as unknown as { ready: Promise<void>; useWorkers?(n: number): void };
    try {
      const n = typeof navigator !== "undefined" ? Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;
      meshopt.useWorkers?.(n);                       // decode off the page
    } catch { /* decode on the page */ }
    return { mod, draco, dracoJs: false, meshopt };
  })();
  try {
    return await loadersPromise;
  } catch (e) {
    loadersPromise = null;
    throw new ModelError("could not load the glTF loader", String(e));
  }
}

/** Draco decoding failed with the wasm decoder: a fresh DRACOLoader on the JS decoder (A3.2 "wasm with JS fallback"). */
async function dracoJsFallback(L: Loaders): Promise<boolean> {
  if (L.dracoJs) return false;
  const dracoMod = await import("three/addons/loaders/DRACOLoader.js");
  L.draco.dispose();
  const d = new dracoMod.DRACOLoader();
  d.setDecoderPath(dracoPath());
  (d as unknown as { decoderConfig: Record<string, unknown> }).decoderConfig.type = "js";   // (setDecoderConfig is deprecated)
  L.draco = d;
  L.dracoJs = true;
  return true;
}

interface ParsedGltf { scene: THREE.Object3D }

/** Parses the rewritten file: GLB bytes, or JSON with a resource path / file map for external buffers. */
async function parseGltf(data: ArrayBuffer | object, resourcePath: string, files: Map<string, Blob> | null): Promise<ParsedGltf> {
  const L = await loaders();
  const run = (): Promise<ParsedGltf> => {
    const manager = new THREE.LoadingManager();
    const urls: string[] = [];
    if (files && files.size) {
      const byName = new Map<string, string>();
      for (const [name, blob] of files) { const u = URL.createObjectURL(blob); urls.push(u); byName.set(name.toLowerCase(), u); }
      manager.setURLModifier((url) => {
        if (url.startsWith("data:") || url.startsWith("blob:")) return url;
        return byName.get(baseName(url).toLowerCase()) ?? url;
      });
    }
    const loader = new L.mod.GLTFLoader(manager);
    loader.setDRACOLoader(L.draco);
    loader.setMeshoptDecoder(L.meshopt as never);
    return new Promise<ParsedGltf>((resolve, reject) => {
      try {
        loader.parse(data as ArrayBuffer, resourcePath, (g) => resolve(g as unknown as ParsedGltf), (err) => reject(err));
      } catch (e) { reject(e); }
    }).finally(() => { for (const u of urls) URL.revokeObjectURL(u); });
  };
  try {
    return await run();
  } catch (e) {
    if (/draco/i.test(String(e instanceof Error ? e.message : e)) && (await dracoJsFallback(L))) return run();
    throw e;
  }
}

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** An attribute's values as a fresh Float32Array of `itemSize` components (de-interleaved, de-quantised). */
function attributeFloats(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, itemSize: number): Float32Array {
  const n = attr.count;
  if (!(attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && attr.array instanceof Float32Array
    && attr.itemSize === itemSize && !attr.normalized) return attr.array.slice(0, n * itemSize);
  const out = new Float32Array(n * itemSize), k = Math.min(itemSize, attr.itemSize);
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * itemSize + c] = attr.getComponent(i, c);
  return out;
}

/** Every triangle mesh of the scene as kernel parts (A3.3 item 1). SkinnedMesh: positions (and normals, by a
 *  finite difference) through the skeleton at its loaded pose; InstancedMesh: one part per instance. Yields between
 *  meshes and every ~50k skinned vertices so the frame loop keeps running. */
export async function extractParts(scene: THREE.Object3D): Promise<{ parts: ModelPart[]; triangles: number }> {
  scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const parts: ModelPart[] = [];
  let triangles = 0, budget = 0;
  for (const mesh of meshes) {
    const g = mesh.geometry as THREE.BufferGeometry | undefined;
    const pa = g?.getAttribute("position");
    if (!g || !pa || pa.count < 3) continue;
    let pos = attributeFloats(pa, 3);
    const na = g.getAttribute("normal"), ua = g.getAttribute("uv");
    let nor = na ? attributeFloats(na, 3) : null;
    const uv = ua ? attributeFloats(ua, 2) : null;
    let idx: Uint32Array | null = null;
    if (g.index) {
      const ia = g.index.array;
      const start = Math.max(0, g.drawRange.start), end = Math.min(ia.length, Number.isFinite(g.drawRange.count) ? start + g.drawRange.count : ia.length);
      idx = Uint32Array.from(ia.subarray(start, end));
    }
    const sk = mesh as THREE.SkinnedMesh;
    if (sk.isSkinnedMesh && sk.skeleton && g.getAttribute("skinIndex") && g.getAttribute("skinWeight")) {
      const v = new THREE.Vector3(), w = new THREE.Vector3(), n = pa.count;
      g.computeBoundingBox();
      const eps = 1e-3 * Math.max(g.boundingBox ? g.boundingBox.getSize(new THREE.Vector3()).length() : 1, 1e-9);
      const out = new Float32Array(3 * n), nout = nor ? new Float32Array(3 * n) : null;
      for (let i = 0; i < n; i++) {
        v.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
        if (nout && nor) w.set(pos[3 * i] + eps * nor[3 * i], pos[3 * i + 1] + eps * nor[3 * i + 1], pos[3 * i + 2] + eps * nor[3 * i + 2]);
        sk.applyBoneTransform(i, v);
        out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z;
        if (nout) {
          sk.applyBoneTransform(i, w);
          nout[3 * i] = w.x - v.x; nout[3 * i + 1] = w.y - v.y; nout[3 * i + 2] = w.z - v.z;
        }
        if (++budget >= 50_000) { budget = 0; await yieldTask(); }
      }
      pos = out;
      nor = nout;
    }
    const mat = mesh.material;
    const doubleSided = (Array.isArray(mat) ? mat : [mat]).some((m) => !!m && m.side === THREE.DoubleSide);
    const tris = idx ? Math.floor(idx.length / 3) : Math.floor(pa.count / 3);
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      const M = new THREE.Matrix4(), I = new THREE.Matrix4();
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, I);
        M.multiplyMatrices(mesh.matrixWorld, I);
        parts.push({ pos, nor, uv, idx, m: M.elements.slice(), doubleSided });
        triangles += tris;
        if (triangles > MODEL_MAX_TRIANGLES) break;
      }
    } else {
      parts.push({ pos, nor, uv, idx, m: mesh.matrixWorld.elements.slice(), doubleSided });
      triangles += tris;
    }
    if (triangles > MODEL_MAX_TRIANGLES) throw new ModelError(`model too large (more than ${formatTriangles(MODEL_MAX_TRIANGLES)} triangles)`);
    budget += pa.count;
    if (budget >= 50_000) { budget = 0; await yieldTask(); }
  }
  if (!parts.length) throw new ModelError("no triangle meshes in this file");
  return { parts, triangles };
}

// ---------------------------------------------------------------------------------------------------------------
// The worker (an inline Blob worker running the kernel's source; the page runs the kernel itself where that fails)
// ---------------------------------------------------------------------------------------------------------------

// Protocol: { id, cmd: "prepare", model, parts, mapping, doubleSided } → { id, stats, built } (arrays transferred);
// { id, cmd: "build", model, mapping, doubleSided } → { id, built }; { id, cmd: "retain", model } → { id }; failures
// { id, error }. The worker keeps prepared models by id for later builds (mapping / double-sided changes) until the
// page's "retain" names the one still in use: the model on screen keeps its prepared copy while a newer file is
// processed, so a file that fails in the kernel (or a load superseded by another) never costs it its rebuilds.
const WORKER_MAIN = `
const bases = new Map();
function arrays(b) { return [b.pos.buffer, b.nor.buffer, b.tan.buffer, b.uv.buffer, b.idx.buffer]; }
self.onmessage = (e) => {
  const d = e.data;
  try {
    if (d.cmd === "prepare") {
      const b = K.prepare(d.parts);
      bases.set(d.model, b);
      const built = K.build(b, d.mapping, d.doubleSided);
      self.postMessage({ id: d.id, stats: b.stats, built }, arrays(built));
    } else if (d.cmd === "build") {
      const b = bases.get(d.model);
      if (!b) throw new Error("model not prepared");
      const built = K.build(b, d.mapping, d.doubleSided);
      self.postMessage({ id: d.id, built }, arrays(built));
    } else if (d.cmd === "retain") {
      for (const k of [...bases.keys()]) if (k !== d.model) bases.delete(k);
      self.postMessage({ id: d.id });
    }
  } catch (err) {
    self.postMessage({ id: d.id, error: String((err && err.message) || err) });
  }
};`;

/** The worker's whole source: the kernel's text and the message loop (tests run it with a stand-in `self`). */
export function workerSource(): string {
  return `"use strict";\nconst K = (${modelKernel.toString()})();\n${WORKER_MAIN}\n`;
}

interface WorkerReply { id: number; stats?: ModelStats; built?: ModelBuilt; error?: string }
class WorkerLost extends Error {}

class KernelHost {
  private worker: Worker | null = null;
  private url = "";
  private failed = false;
  private jobId = 0;
  private readonly jobs = new Map<number, { resolve(r: WorkerReply): void; reject(e: Error): void }>();
  /** The page's kernel and its prepared models by id (only where the worker failed). */
  private local: { k: ModelKernel; bases: Map<number, Base> } | null = null;
  /** True once the page had to run the kernel itself (diagnostics). */
  usedPage = false;

  /** Steps 1–6 for a new model (kept, by id, for rebuilds until `retain` names another). */
  async prepare(model: number, parts: ModelPart[], mapping: ModelMapping, doubleSided: boolean | null): Promise<{ stats: ModelStats; built: ModelBuilt }> {
    const w = this.ensure();
    if (w) {
      const transfer: Transferable[] = [];
      const seen = new Set<ArrayBufferLike>();
      for (const p of parts) for (const a of [p.pos, p.nor, p.uv, p.idx]) if (a && !seen.has(a.buffer)) { seen.add(a.buffer); transfer.push(a.buffer as ArrayBuffer); }
      // a WorkerLost rejection means the transferred parts are gone: the caller extracts them again (the host now
      // runs the kernel on the page)
      const r = await this.post(w, { cmd: "prepare", model, parts, mapping, doubleSided }, transfer);
      if (r.error || !r.stats || !r.built) throw new Error(r.error ?? "worker failed");
      return { stats: r.stats, built: r.built };
    }
    await yieldTask();
    const L = this.page();
    const b = L.k.prepare(parts);
    L.bases.set(model, b);
    return { stats: b.stats, built: L.k.build(b, mapping, doubleSided) };
  }

  async build(model: number, mapping: ModelMapping, doubleSided: boolean | null): Promise<ModelBuilt> {
    const L = this.local, b = L?.bases.get(model);
    if (L && b) {
      await yieldTask();
      return L.k.build(b, mapping, doubleSided);
    }
    const w = this.ensure();
    if (!w) throw new Error("model not prepared");
    const r = await this.post(w, { cmd: "build", model, mapping, doubleSided });
    if (r.error || !r.built) throw new Error(r.error ?? "worker failed");
    return r.built;
  }

  /** Frees every prepared model except `model` (-1: all). */
  retain(model: number): void {
    if (this.local) for (const k of [...this.local.bases.keys()]) if (k !== model) this.local.bases.delete(k);
    if (this.worker) void this.post(this.worker, { cmd: "retain", model }).catch(() => {});
  }

  get workerActive(): boolean { return this.worker !== null && !this.failed; }

  private page(): { k: ModelKernel; bases: Map<number, Base> } {
    this.usedPage = true;
    this.local ??= { k: modelKernel(), bases: new Map() };
    return this.local;
  }

  private post(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<WorkerReply> {
    const id = ++this.jobId;
    return new Promise<WorkerReply>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      try {
        w.postMessage({ id, ...msg }, transfer);
      } catch (e) {
        this.jobs.delete(id);
        this.kill();
        reject(new WorkerLost(e instanceof Error ? e.message : String(e)));
      }
    });
  }

  private kill(): void {
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const j of this.jobs.values()) j.reject(new WorkerLost("worker lost"));
    this.jobs.clear();
  }

  private ensure(): Worker | null {
    if (this.failed) return null;
    if (this.worker) return this.worker;
    try {
      if (typeof Worker === "undefined" || typeof Blob === "undefined") throw new Error("no workers");
      this.url = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
      const w = new Worker(this.url);
      w.onmessage = (e: MessageEvent) => {
        const d = e.data as WorkerReply;
        const job = this.jobs.get(d.id);
        if (!job) return;
        this.jobs.delete(d.id);
        job.resolve(d);
      };
      w.onerror = (e: ErrorEvent) => { e.preventDefault(); this.kill(); };
      this.worker = w;
    } catch {
      this.failed = true;
      this.worker = null;
    }
    return this.worker;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Persistence (IndexedDB, A3.1): the raw bytes of the last uploaded model and its name
// ---------------------------------------------------------------------------------------------------------------

export interface StoredModel { name: string; bytes: ArrayBuffer; extra?: { name: string; bytes: ArrayBuffer }[] }
const IDB_NAME = "holo-simulator", IDB_STORE = "files";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no IndexedDB")); return; }
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(IDB_STORE)) rq.result.createObjectStore(IDB_STORE); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error ?? new Error("IndexedDB open failed"));
    rq.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}
async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode), rq = f(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(rq.result);
      tx.onerror = () => reject(tx.error ?? rq.error ?? new Error("IndexedDB failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB aborted"));
    });
  } finally {
    db.close();
  }
}
export async function saveStoredModel(m: StoredModel): Promise<void> { await idb("readwrite", (s) => s.put(m, MODEL_PERSIST_KEY)); }
export async function loadStoredModel(): Promise<StoredModel | null> {
  try {
    const r = await idb<unknown>("readonly", (s) => s.get(MODEL_PERSIST_KEY));
    const m = r as StoredModel | undefined;
    return m && typeof m.name === "string" && m.bytes instanceof ArrayBuffer ? m : null;
  } catch { return null; }
}
export async function hasStoredModel(): Promise<boolean> {
  try { return (await idb<IDBValidKey | undefined>("readonly", (s) => s.getKey(MODEL_PERSIST_KEY))) !== undefined; } catch { return false; }
}
export async function clearStoredModel(): Promise<void> {
  try { await idb("readwrite", (s) => s.delete(MODEL_PERSIST_KEY)); } catch { /* nothing stored */ }
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------

/** What to load: bytes (upload, drop, stored, API) or a URL; `files` are a multi-file .gltf's other files by name. */
export interface ModelInput {
  name: string;
  bytes?: ArrayBuffer;
  url?: string;
  files?: Map<string, Blob>;
  source: "file" | "url" | "stored" | "api";
}

export type ModelProgress = { phase: "download"; fraction: number | null } | { phase: "process" };

async function fetchBytes(url: string, onProgress: (f: number | null) => void): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch (e) {
    throw new ModelError("could not download the model (network or CORS error)", String(e));
  }
  if (!res.ok) throw new ModelError(`could not download the model (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (total > MODEL_MAX_BYTES) throw new ModelError("file larger than 256 MB");
  if (!res.body || typeof res.body.getReader !== "function") return res.arrayBuffer();
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  let got = 0;
  onProgress(total ? 0 : null);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (got > MODEL_MAX_BYTES) { void reader.cancel(); throw new ModelError("file larger than 256 MB"); }
    onProgress(total ? Math.min(got / total, 0.99) : null);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

/** The model files among dropped/selected files: the first .glb/.gltf is the model, the rest its resources. */
export function pickModelFiles(files: readonly File[]): { main: File; extra: Map<string, Blob> } | null {
  const isModel = (f: File) => /\.(glb|gltf)$/i.test(f.name) || f.type === "model/gltf-binary" || f.type === "model/gltf+json";
  const main = files.find((f) => /\.glb$/i.test(f.name) || f.type === "model/gltf-binary") ?? files.find(isModel);
  if (!main) return null;
  const extra = new Map<string, Blob>();
  for (const f of files) if (f !== main) extra.set(f.name, f);
  return { main, extra };
}

// ---------------------------------------------------------------------------------------------------------------
// The model store
// ---------------------------------------------------------------------------------------------------------------

/** What the caption and `__holo` report about the loaded model. */
export interface ModelSummary {
  name: string;
  triangles: number;                 // merged source triangles (before a double-sided copy)
  mapping: UsedMapping;
  note: string | null;               // e.g. "no UVs" when auto chose the box
  doubleSided: boolean;
  open: boolean;                     // auto-detection result
  source: ModelInput["source"];
  url: string | null;                // the URL it came from (URL key / API), else null
  warning: string | null;            // e.g. the > 3 M triangles warning
  uv: UvInfo;
  stats: ModelStats;
  timings: Record<string, number>;
  worker: boolean;
}

interface Current {
  model: number;
  summary: ModelSummary;
  stats: ModelStats;
  built: ModelBuilt;
  requested: { mapping: ModelMapping; doubleSided: boolean | null };
}

const PLACEHOLDER_INFO: Omit<ObjectInfo, "domainMm" | "boundsRadiusM" | "frameHalfM"> = {
  printable: false, slab: false, cardOutline: false, wrapU: false, wrapV: false,
};

/**
 * The model behind object `model` (A3.4): loads (one at a time; a newer load supersedes an older one), keeps the
 * current build and its BufferGeometry, rebuilds on mapping / double-sided changes and rescales in place on size
 * changes. Listeners hear about a new geometry (`onChange`) and progress.
 */
export class ModelStore {
  private readonly host = new KernelHost();
  private cur: Current | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private posN: Float32Array | null = null;
  private sizeMm: number = MODEL_SIZE_MM.default;
  private rev = 0;
  private token = 0;
  private buildToken = 0;
  private modelId = 0;
  private inFlight = 0;
  private readonly empty = emptyGeometry();
  /** A new geometry is ready (the holder should swap it in). */
  onChange: (() => void) | null = null;

  /** True once a model is loaded. */
  get loaded(): boolean { return this.cur !== null; }
  /** A load or a rebuild is in flight. */
  get pending(): boolean { return this.inFlight > 0; }
  /** Changes whenever the geometry is replaced (objects.ts geometryKey). */
  get revision(): number { return this.rev; }
  get summary(): ModelSummary | null { return this.cur ? this.cur.summary : null; }
  /** GPU bytes of the model's vertex and index buffers. */
  get gpuBytes(): number {
    const g = this.geo;
    if (!g) return 0;
    let n = g.index ? g.index.array.byteLength : 0;
    for (const a of Object.values(g.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
    return n;
  }

  /** The geometry of object `model` (an empty geometry while none is loaded). */
  geometry(): THREE.BufferGeometry { return this.geo ?? this.empty; }

  /** ObjectInfo of object `model` (A3.3 item 7) for the panel values `p`. */
  info(p: ModelParams): ObjectInfo {
    const size = p.sizeMm, s = p.structureScale;
    if (!this.cur) {
      return { ...PLACEHOLDER_INFO, domainMm: { x: MODEL_BUMP_DOMAIN_MM, y: MODEL_BUMP_DOMAIN_MM }, boundsRadiusM: (size / 2) * 1e-3,
        frameHalfM: { x: (size / 2) * 1e-3, y: (size / 2) * 1e-3 } };
    }
    const st = this.cur.stats, d = this.cur.built.domain, mm = size * 1e-3;
    return {
      ...PLACEHOLDER_INFO,
      domainMm: { x: d[0] * size * s, y: d[1] * size * s },
      boundsRadiusM: st.radiusN * mm,
      frameHalfM: { x: st.halfN[0] * mm, y: st.halfN[1] * mm },
    };
  }

  /** Model size: positions rescaled in place (the GPU buffer is re-uploaded; no rebuild, the holder keeps it). */
  setSize(mm: number): void {
    const v = Math.min(Math.max(Number.isFinite(mm) ? mm : MODEL_SIZE_MM.default, MODEL_SIZE_MM.min), MODEL_SIZE_MM.max);
    if (v === this.sizeMm) return;
    this.sizeMm = v;
    const g = this.geo, n = this.posN;
    if (!g || !n) return;
    const attr = g.getAttribute("position") as THREE.BufferAttribute, a = attr.array as Float32Array, k = v * 1e-3;
    for (let i = 0; i < a.length; i++) a[i] = n[i] * k;
    attr.needsUpdate = true;
    this.bounds(g);
  }

  /**
   * Loads a model (A3.2) and builds it with `opts` (doubleSided null = automatic). Resolves with its summary once the
   * geometry is ready (the listener has been told); rejects with a ModelError (short message), or ModelSuperseded when a
   * newer load replaced it. The current model stays until the new one is ready.
   */
  async load(input: ModelInput, opts: { mapping: ModelMapping; doubleSided: boolean | null }, onProgress?: (p: ModelProgress | null) => void): Promise<ModelSummary> {
    const token = ++this.token;
    this.inFlight++;
    const progress = (p: ModelProgress | null) => { if (token === this.token) onProgress?.(p); };
    const check = () => { if (token !== this.token) throw new ModelSuperseded(); };
    const timings: Record<string, number> = {};
    let t0 = performance.now();
    try {
      let bytes = input.bytes ?? null;
      if (!bytes) {
        if (!input.url) throw new ModelError("nothing to load");
        progress({ phase: "download", fraction: null });
        bytes = await fetchBytes(input.url, (f) => progress({ phase: "download", fraction: f }));
      }
      check();
      if (bytes.byteLength > MODEL_MAX_BYTES) throw new ModelError("file larger than 256 MB");
      timings.read = performance.now() - t0; t0 = performance.now();
      progress({ phase: "process" });
      await yieldTask();
      const c = readGltfContainer(bytes);
      stripGltf(c.json);
      if (!input.url) checkExternalBuffers(c.json, input.files ?? null);
      const data: ArrayBuffer | object = c.glb ? buildGlb(c.json, c.bin) : c.json;
      const resourcePath = input.url ? THREE.LoaderUtils.extractUrlBase(new URL(input.url, location.href).href) : "";
      timings.rewrite = performance.now() - t0; t0 = performance.now();
      const gltf = await parseGltf(data, resourcePath, input.files ?? null);
      check();
      timings.parse = performance.now() - t0; t0 = performance.now();
      let { parts } = await extractParts(gltf.scene);
      check();
      timings.extract = performance.now() - t0; t0 = performance.now();
      const model = ++this.modelId;
      let r: { stats: ModelStats; built: ModelBuilt };
      try {
        r = await this.host.prepare(model, parts, opts.mapping, opts.doubleSided);
      } catch (e) {
        if (!(e instanceof WorkerLost)) throw e;
        // the worker died with the (transferred) parts: extract again and run the kernel on the page
        ({ parts } = await extractParts(gltf.scene));
        check();
        r = await this.host.prepare(model, parts, opts.mapping, opts.doubleSided);
      }
      check();
      timings.kernel = performance.now() - t0;
      for (const [k, v] of Object.entries(r.stats.ms)) timings[`kernel.${k}`] = Math.round(v);
      timings[`kernel.build`] = Math.round(r.built.ms);
      const summary: ModelSummary = {
        name: input.name, triangles: r.stats.triangles, mapping: r.built.mapping, note: r.built.note,
        doubleSided: r.built.doubleSided, open: r.stats.open, source: input.source, url: input.url ?? null,
        warning: r.stats.triangles > MODEL_WARN_TRIANGLES ? `${formatTriangles(r.stats.triangles)} triangles: phones may stall` : null,
        uv: r.stats.uv, stats: r.stats, timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])),
        worker: this.host.workerActive,
      };
      // (the file's bytes are not kept: the caller stores them for the next visit, and nothing else needs them)
      this.cur = { model, summary, stats: r.stats, built: r.built, requested: { ...opts } };
      this.install(r.built);
      return summary;
    } catch (e) {
      if (e instanceof ModelSuperseded || token !== this.token) throw new ModelSuperseded();
      throw e instanceof ModelError ? e : new ModelError(modelErrorMessage(e), e instanceof Error ? e.stack || e.message : String(e));
    } finally {
      this.inFlight--;
      progress(null);
      // the latest load frees the prepared copies of every other model (failed or superseded ones included)
      if (token === this.token) this.host.retain(this.cur ? this.cur.model : -1);
    }
  }

  /** Mapping / double-sided change (A3.1): rebuilds in the worker unless the current build already matches. A newer
   *  request — also one back to the current build — cancels a build still in flight; a new model replaces it. */
  async rebuild(opts: { mapping: ModelMapping; doubleSided: boolean | null }): Promise<boolean> {
    const c = this.cur;
    if (!c) return false;
    const want = opts.doubleSided ?? c.stats.open;
    const token = ++this.buildToken;
    if (c.requested.mapping === opts.mapping && c.built.doubleSided === want) return false;
    const stale = () => token !== this.buildToken || this.cur !== c;
    this.inFlight++;
    try {
      let built: ModelBuilt;
      try {
        built = await this.host.build(c.model, opts.mapping, opts.doubleSided);
      } catch (e) {
        if (stale()) return false;                           // a newer model or build replaced this one
        throw e instanceof ModelError ? e : new ModelError(modelErrorMessage(e), String(e));
      }
      if (stale()) return false;
      c.built = built;
      c.requested = { ...opts };
      c.summary = { ...c.summary, mapping: built.mapping, note: built.note, doubleSided: built.doubleSided };
      this.install(built);
      return true;
    } finally {
      this.inFlight--;
    }
  }

  /** Forgets the model (the holder should switch to another object first). */
  clear(): void {
    this.token++;
    this.buildToken++;
    this.cur = null;
    this.geo = null;
    this.posN = null;
    this.rev++;
    this.host.retain(-1);
    this.onChange?.();
  }

  private install(b: ModelBuilt): void {
    const g = new THREE.BufferGeometry();
    g.name = "object-model";
    const k = this.sizeMm * 1e-3, pos = new Float32Array(b.pos.length);
    for (let i = 0; i < pos.length; i++) pos[i] = b.pos[i] * k;
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(b.nor, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(b.uv, 2));
    g.setAttribute("tangent", new THREE.BufferAttribute(b.tan, 4));
    g.setIndex(new THREE.BufferAttribute(b.idx, 1));
    g.addGroup(0, b.idx.length, 0);                          // one group: 0 = holo (A3.3 item 7)
    this.posN = b.pos;
    this.geo = g;
    this.bounds(g);
    this.rev++;
    this.onChange?.();
  }

  private bounds(g: THREE.BufferGeometry): void {
    const c = this.cur;
    if (!c) return;
    const k = this.sizeMm * 1e-3, h = c.stats.halfN;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-h[0] * k, -h[1] * k, -h[2] * k), new THREE.Vector3(h[0] * k, h[1] * k, h[2] * k));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), c.stats.radiusN * k);
  }
}

function emptyGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.name = "object-model-empty";
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(0), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(0), 2));
  g.setAttribute("tangent", new THREE.BufferAttribute(new Float32Array(0), 4));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(0), 1));
  g.addGroup(0, 0, 0);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.05);
  return g;
}

/** The app's model store (one model at a time). */
export const models = new ModelStore();

/** objects.ts delegation (A3.4): the model's geometry and info, and its geometry identity. */
export function getModelGeometry(): THREE.BufferGeometry { return models.geometry(); }
export function getModelInfo(p: ModelParams): ObjectInfo { return models.info(p); }
export function modelRevision(): number { return models.revision; }

// ---------------------------------------------------------------------------------------------------------------
// Page helpers: the hidden file input and drag & drop (A3.1)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The hidden `<input type="file">` of the upload action (holocloth's bump-upload pattern). `open()` MUST be called
 * synchronously inside the user gesture (the panel's click). `onCancel` runs when the picker closes without a file
 * (the `cancel` event; where a browser lacks it, focus returning without a `change` within 1.5 s).
 */
export class ModelFileInput {
  private readonly input: HTMLInputElement;
  private open_ = false;
  private onCancel: (() => void) | null = null;
  private focusTimer = 0;

  constructor(onFiles: (files: File[]) => void) {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = MODEL_ACCEPT;
    el.multiple = true;                                      // a .gltf with its .bin (and textures)
    el.className = "holo-file-input";
    el.hidden = true;
    el.tabIndex = -1;
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("change", () => {
      const files = el.files ? Array.from(el.files) : [];
      el.value = "";
      this.close();
      if (files.length) onFiles(files);
      else this.fireCancel();
    });
    el.addEventListener("cancel", () => { this.close(); this.fireCancel(); });
    document.body.appendChild(el);
    this.input = el;
    window.addEventListener("focus", () => {
      if (!this.open_) return;
      clearTimeout(this.focusTimer);
      this.focusTimer = window.setTimeout(() => { if (this.open_) { this.close(); this.fireCancel(); } }, 1500);
    });
  }

  /** Opens the picker (call synchronously in the gesture); `onCancel` runs if the user closes it without a file. */
  open(onCancel?: () => void): void {
    this.onCancel = onCancel ?? null;
    this.open_ = true;
    this.input.value = "";
    this.input.click();
  }

  private close(): void { this.open_ = false; clearTimeout(this.focusTimer); }
  private fireCancel(): void { const f = this.onCancel; this.onCancel = null; f?.(); }
}

/** Drag & drop anywhere on the page (A3.1): `onFiles` with the dropped files; `onHover(true/false)` for the overlay.
 *  Drops a DialKit control already handled (its image control) are left alone. */
export function installModelDrop(onFiles: (files: File[]) => void, onHover: (on: boolean) => void): () => void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth++; onHover(true); };
  const over = (e: DragEvent) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) onHover(false); };
  const drop = (e: DragEvent) => {
    depth = 0;
    onHover(false);
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    onFiles(e.dataTransfer ? Array.from(e.dataTransfer.files) : []);
  };
  window.addEventListener("dragenter", enter);
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragenter", enter);
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
  };
}

/** The ParamSpec-side sizes for objects.ts (kept here so the model's limits live in one module). */
export const MODEL_PARAM_DEFAULTS: Readonly<ModelParams> = { sizeMm: MODEL_SIZE_MM.default, mapping: "auto", structureScale: 1, doubleSided: true };

/** The bump-map domain of the model (see the header): a fixed 100 mm square of p. */
export const MODEL_BUMP_DOMAIN: Readonly<Vec2> = { x: MODEL_BUMP_DOMAIN_MM, y: MODEL_BUMP_DOMAIN_MM };
