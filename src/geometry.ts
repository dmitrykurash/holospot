// Geometry: any three.js object → the geometry the holographic materials need.
//
// The materials work in real units. They need positions in metres, a tangent frame, and a surface coordinate measured
// in millimetres along the surface, so that a 1000 nm grating or a 0.4 mm glitter flake has the right size on the
// object. holo.spot's model loader already builds exactly that for an uploaded GLB (engine/scene/models.ts): it merges
// the meshes, welds them, fixes normals, picks a mapping (the mesh's own UVs when they are usable, else a box or
// sphere projection) and computes tangents. This module runs the same kernel on an object from the caller's scene.
import * as THREE from "three";
import { extractParts, modelKernel } from "../engine/scene/models.ts";
import type { ModelBuilt, ModelMapping, ModelPart, ModelStats } from "../engine/scene/models.ts";

export interface Prepared {
  /** Positions in metres, centred on the object's bounding-box centre; normal, uv, tangent; indexed. */
  geometry: THREE.BufferGeometry;
  /** The object's bounding-box centre in the source object's own frame, and its largest side there. */
  centerLocal: THREE.Vector3;
  sizeLocal: number;
  /** Half extents and bounding radius of the prepared geometry [m]. */
  halfM: THREE.Vector3;
  radiusM: number;
  /** The surface coordinate's span [mm]: p = uv · domainMm. */
  domainMm: { x: number; y: number };
  mapping: string;
  doubleSided: boolean;
  triangles: number;
  note: string | null;
}

let kernel: ReturnType<typeof modelKernel> | null = null;

/** The bounding box the kernel normalises by: over the vertices that valid triangles use, after each part's matrix. */
function kernelBox(parts: readonly ModelPart[]): { center: THREE.Vector3; size: number } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const P = p.pos, n = Math.floor(P.length / 3), src = p.idx;
    const tc = src ? Math.floor(src.length / 3) : Math.floor(n / 3);
    const used = new Uint8Array(n);
    const finite = (v: number) => Number.isFinite(P[3 * v]) && Number.isFinite(P[3 * v + 1]) && Number.isFinite(P[3 * v + 2]);
    for (let t = 0; t < tc; t++) {
      const a = src ? src[3 * t] : 3 * t, b = src ? src[3 * t + 1] : 3 * t + 1, c = src ? src[3 * t + 2] : 3 * t + 2;
      if (!(a < n && b < n && c < n) || a === b || b === c || a === c || !finite(a) || !finite(b) || !finite(c)) continue;
      used[a] = used[b] = used[c] = 1;
    }
    const e = p.m && p.m.length >= 16 ? p.m : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const A = [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
    for (let v = 0; v < n; v++) {
      if (!used[v]) continue;
      const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
      const X = A[0] * x + A[1] * y + A[2] * z + A[3], Y = A[4] * x + A[5] * y + A[6] * z + A[7], Z = A[8] * x + A[9] * y + A[10] * z + A[11];
      if (X < lo[0]) lo[0] = X; if (X > hi[0]) hi[0] = X;
      if (Y < lo[1]) lo[1] = Y; if (Y > hi[1]) hi[1] = Y;
      if (Z < lo[2]) lo[2] = Z; if (Z > hi[2]) hi[2] = Z;
    }
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return { center: new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2), size };
}

export interface PrepareOptions {
  /** Real-world size of the object's largest side [mm]. */
  sizeMm: number;
  /** `auto`: the mesh's UVs when they are usable, else a box projection. */
  mapping: ModelMapping;
  /** null: double-sided when the surface is open (a sheet), single-sided when it is closed. */
  doubleSided: boolean | null;
  /** Density of the structure (shards, flakes, bump tiles) on the object: above 1 smaller, below 1 larger. */
  structureScale: number;
}

/** Every mesh under `root` (the root's own transform left out), merged and built for the holographic materials. */
export async function prepareGeometry(root: THREE.Object3D, o: PrepareOptions): Promise<Prepared> {
  root.updateWorldMatrix(true, true);
  const { parts, triangles } = await extractParts(root);
  // parts carry world matrices; the kit wants the root's own frame, so the object can keep moving in the scene
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), m = new THREE.Matrix4();
  for (const p of parts) {
    m.fromArray(p.m ? Array.from(p.m) : new THREE.Matrix4().elements);
    p.m = m.premultiply(inv).elements.slice();
  }
  const box = kernelBox(parts);
  if (!(box.size > 0) || !Number.isFinite(box.size)) throw new Error("holo: the object has no extent");
  kernel ??= modelKernel();
  const base = kernel.prepare(parts);
  const built: ModelBuilt = kernel.build(base, o.mapping, o.doubleSided);
  const stats: ModelStats = base.stats;
  const k = o.sizeMm * 1e-3;
  const pos = new Float32Array(built.pos.length);
  for (let i = 0; i < pos.length; i++) pos[i] = built.pos[i] * k;
  const g = new THREE.BufferGeometry();
  g.name = "holo-object";
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(built.nor, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(built.uv, 2));
  g.setAttribute("tangent", new THREE.BufferAttribute(built.tan, 4));
  g.setIndex(new THREE.BufferAttribute(built.idx, 1));
  const h = stats.halfN;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-h[0] * k, -h[1] * k, -h[2] * k), new THREE.Vector3(h[0] * k, h[1] * k, h[2] * k));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), stats.radiusN * k);
  return {
    geometry: g, centerLocal: box.center, sizeLocal: box.size,
    halfM: new THREE.Vector3(h[0] * k, h[1] * k, h[2] * k), radiusM: stats.radiusN * k,
    domainMm: { x: built.domain[0] * o.sizeMm * o.structureScale, y: built.domain[1] * o.sizeMm * o.structureScale },
    mapping: built.mapping, doubleSided: built.doubleSided, triangles, note: built.note,
  };
}

/** The source meshes under `root` (what the kit hides while it draws the holographic version). */
export function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
  return out;
}
