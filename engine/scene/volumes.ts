// A5 Volume Hologram subjects: the signed-distance volumes baked by tools/bake-sdf.mjs (public/holo3d/<subject>.sdf,
// gzip-compressed, format in physics/volume.ts), loaded lazily — only while the Volume material is selected — into an
// R16F THREE.Data3DTexture (trilinear, clamp-to-edge, no mips) and kept for the session (≤ 4 MB of GPU memory each).
// The app binds a loaded grid into the material's uniforms (materials/volume.ts bindVolumeGrid) and holds `ready` (the
// harness readiness) until the selected subject is loaded or has failed (bounded by VOLUME_WAIT_MS).
import * as THREE from "three";
import { isGzip, parseSdf } from "../physics/volume.ts";
import type { SdfVolume } from "../physics/volume.ts";
import type { VolumeSubject } from "../materials/volume.params.ts";
import type { VolumeGrid } from "../materials/volume.ts";

/** Longest wait for the subject volume before `ready` turns true anyway (a failed fetch must not hang the harness). */
export const VOLUME_WAIT_MS = 120_000;

/** URL of a subject's volume. */
export function volumeUrl(subject: VolumeSubject): string {
  return `/holo3d/${subject}.sdf`;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") throw new Error("this browser cannot decompress gzip (DecompressionStream)");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A parsed volume as a texture grid: R16F Data3DTexture (trilinear, clamp-to-edge, no mips). */
export function gridFromVolume(v: SdfVolume, name: string): VolumeGrid {
  const tex = new THREE.Data3DTexture(v.data, v.nx, v.ny, v.nz);
  tex.format = THREE.RedFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 2;
  tex.name = name;
  tex.needsUpdate = true;
  return { texture: tex, n: [v.nx, v.ny, v.nz], bmin: [v.bmin[0], v.bmin[1], v.bmin[2]], h: v.h, basePitchDeg: v.basePitchDeg, baseYawDeg: v.baseYawDeg };
}

/** Fetches, decompresses (unless the server already did) and parses a subject volume into a texture grid. */
export async function loadVolumeGrid(url: string): Promise<VolumeGrid> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  const bytes: Uint8Array = isGzip(raw) ? await gunzip(raw) : raw;
  return gridFromVolume(parseSdf(bytes), `volume:${url}`);
}

export class VolumeStore {
  private readonly grids = new Map<VolumeSubject, VolumeGrid>();
  private readonly loads = new Map<VolumeSubject, Promise<void>>();
  private readonly failed = new Set<VolumeSubject>();
  /** Called after a subject finished loading (or failed). */
  onChange: (() => void) | null = null;

  /** The loaded grid of a subject, or null. */
  get(subject: VolumeSubject): VolumeGrid | null { return this.grids.get(subject) ?? null; }

  /** Starts loading a subject once (no-op while it loads, after it loaded, or after it failed). */
  request(subject: VolumeSubject): void {
    if (this.grids.has(subject) || this.loads.has(subject) || this.failed.has(subject)) return;
    const p = loadVolumeGrid(volumeUrl(subject)).then((g) => {
      this.grids.set(subject, g);
    }, (e) => {
      this.failed.add(subject);
      console.warn(`[volume] could not load the ${subject} volume: ${String(e?.message ?? e)}`);
    }).finally(() => {
      this.loads.delete(subject);
      this.onChange?.();
    });
    this.loads.set(subject, p);
  }

  /** Loaded or failed: nothing more will happen for this subject. */
  settled(subject: VolumeSubject): boolean { return this.grids.has(subject) || this.failed.has(subject); }

  /** A load is in flight. */
  get pending(): boolean { return this.loads.size > 0; }

  /** GPU bytes of the loaded volumes (2 B per voxel). */
  get gpuBytes(): number {
    let b = 0;
    for (const g of this.grids.values()) b += 2 * g.n[0] * g.n[1] * g.n[2];
    return b;
  }
}

/** A11: several subjects in one 3D texture for the paper card's multi-element program (one sampler for every hologram
 *  sticker): the grids stacked along z in a (max nx) × (max ny) × (Σ nz) texture. Each grid's `scale` and `offset` map
 *  its own texture coordinates into its slab; the shader clamps to the slab first (clamp-to-edge per subject). */
export interface VolumeAtlas { texture: THREE.Data3DTexture; slabs: Map<VolumeGrid, { scale: [number, number, number]; offset: [number, number, number] }>; bytes: number }
export function buildVolumeAtlas(grids: readonly VolumeGrid[]): VolumeAtlas {
  const nx = Math.max(...grids.map((g) => g.n[0]), 1), ny = Math.max(...grids.map((g) => g.n[1]), 1);
  const nz = Math.max(grids.reduce((a, g) => a + g.n[2], 0), 1);
  const data = new Uint16Array(nx * ny * nz);
  const slabs: VolumeAtlas["slabs"] = new Map();
  let z0 = 0;
  for (const g of grids) {
    const src = (g.texture.image as { data: Uint16Array }).data, [gx, gy, gz] = g.n;
    for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) {
      data.set(src.subarray((z * gy + y) * gx, (z * gy + y + 1) * gx), ((z0 + z) * ny + y) * nx);
    }
    slabs.set(g, { scale: [gx / nx, gy / ny, gz / nz], offset: [0, 0, z0 / nz] });
    z0 += gz;
  }
  const tex = new THREE.Data3DTexture(data, nx, ny, nz);
  tex.format = THREE.RedFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 2;
  tex.name = "volume-atlas";
  tex.needsUpdate = true;
  return { texture: tex, slabs, bytes: 2 * nx * ny * nz };
}
