// A5 Volume Hologram — CPU twin of the replay optics in volume.glsl and the signed-distance volume format (addendum A5).
// Pure module (§6.1): no three, no DOM, explicit `.ts` extensions.
//
// Frames and signs (spec §4.1): every direction is a unit vector in the sticker frame (T, B, N) — x along T, y along B,
// z along N — and ℓ̂ (to the light), v̂ (to the eye) and ρ̂ (to the reference source) point AWAY from the surface
// (z > 0). The recorded direction π̂ points INTO the sticker (z < 0), from the surface point X toward the recorded
// object point.
//
// Recording. At X the object wave arrives travelling along −π̂ and the reference wave along −ρ̂ (both at λ_r), so the
// recorded fringes have the tangential frequency (cycles per unit length, air directions: tangential components are
// conserved through the layers, so the index drops out)
//     f_t(π̂) = (ρ̂ₜ − π̂ₜ)/λ_r .
// Replay. A light ℓ̂ at λ, diffracted by that fringe into the eye v̂ (the order that reconstructs the object wave):
//     v̂ₜ = −ℓ̂ₜ + λ·f_t(π̂′)  ⇔  π̂′ₜ = ρ̂ₜ − (λ_r/λ)(v̂ₜ + ℓ̂ₜ),   π̂′_z = −√(1 − |π̂′ₜ|²)   (|π̂′ₜ| ≥ 1: evanescent).
// The eye at X therefore sees the recorded light field in direction π̂′. With ℓ̂ = ρ̂ and λ = λ_r: π̂′ = −v̂, the eye
// looks straight through the "window" at the recorded object (correct perspective and occlusion); moving the light
// shifts and shears the image (real behaviour).
// Reflection (thick emulsion, index n): the fringe vector must also match along the normal, (n/λ)(c_v + c_ℓ) =
// (n/λ_r)(c_ρ + c_π), with the internal cosines c = √(1 − |dₜ|²/n²): the Bragg wavelength
//     λ_B = λ_r·(c_v + c_ℓ)/(c_ρ + c_π(λ_B))
// (a fixed point: c_π depends on λ through π̂′; it converges in 2–3 steps). At the reference geometry c_π = c_v, so
// λ_B = λ_r for every eye position; tilting the sticker under a fixed light moves both ℓ̂ and v̂ and shifts λ_B (toward
// blue at steep angles).
// Rainbow (Benton, embossed): only the slit's vertical direction was recorded: π̂′_y must equal the slit direction
// π_y0(X) = (y − h)/√((y − h)² + D²) (a horizontal slit at the design distance D in front of the content centre, at the
// height h = D·tan(elevation) above it; y the height of X). This selects the wavelength
//     λ_c = λ_r·(v̂_y + ℓ̂_y)/(ρ̂_y − π_y0)
// (eye higher → redder), and the horizontal component keeps the full parallax: π̂′_x = ρ̂_x − (λ_r/λ_c)(v̂_x + ℓ̂_x).
import type { Vec3 } from "../types.ts";
import { fromHalf, toHalf } from "../spectral/half.ts";

/** Emulsion index of the reflection hologram (photopolymer / gelatin). */
export const VOLUME_N = 1.5;
/** Design viewing distance of the rainbow hologram's slit image [mm] (≈ the default camera distance, 0.32 m). */
export const VOLUME_SLIT_DISTANCE_MM = 330;
/** Elevation of the slit image above the content centre [deg]: the viewer the rainbow is designed for looks slightly
 *  down onto the sticker (rest pose: orange, first-load pose: blue, halfway: the design colour). */
export const VOLUME_SLIT_ELEVATION_DEG = 4;
/** Relative first-order efficiency of the embossed rainbow relief vs the volume hologram at the same `efficiency`. */
export const VOLUME_RAINBOW_EFF = 0.3;

/** Unit direction from pad direction cosines (x, y) = sinθ(cosφ, sinφ); |(x, y)| > 1 is scaled back onto the horizon. */
export function padDirection(x: number, y: number): Vec3 {
  const r2 = x * x + y * y, s = r2 > 1 ? 1 / Math.sqrt(r2) : 1;
  const tx = x * s, ty = y * s;
  return [tx, ty, Math.sqrt(Math.max(1 - tx * tx - ty * ty, 0))];
}

/** Internal cosine of a direction with tangential part (tx, ty) in a medium of index n. */
export function cosInside(tx: number, ty: number, n: number = VOLUME_N): number {
  return Math.sqrt(Math.max(1 - (tx * tx + ty * ty) / (n * n), 0));
}

/** π̂′ = (ρ̂ₜ − (λ_r/λ)(v̂ₜ + ℓ̂ₜ), −√(1 − |·|²)), or null when evanescent (|π̂′ₜ| ≥ 1). */
export function replayDirection(rho: Vec3, l: Vec3, v: Vec3, lambdaR: number, lambda: number): Vec3 | null {
  const k = lambdaR / lambda;
  const x = rho[0] - k * (v[0] + l[0]), y = rho[1] - k * (v[1] + l[1]);
  const t2 = x * x + y * y;
  if (!(t2 < 1)) return null;
  return [x, y, -Math.sqrt(1 - t2)];
}

export interface Replay { lambda: number; pi: Vec3 }

/**
 * Reflection hologram: the Bragg-matched wavelength λ_B and the replayed direction π̂′(λ_B) for light ℓ̂ and eye v̂
 * (fixed-point iteration from λ_r, `iters` steps). Null when the light or the eye is below the surface or π̂′ is
 * evanescent at the solution.
 */
export function braggReplay(rho: Vec3, l: Vec3, v: Vec3, lambdaR: number, n: number = VOLUME_N, iters = 3): Replay | null {
  if (!(l[2] > 0) || !(v[2] > 0)) return null;
  const num = cosInside(v[0], v[1], n) + cosInside(l[0], l[1], n), cr = cosInside(rho[0], rho[1], n);
  let lambda = lambdaR;
  let pi = replayDirection(rho, l, v, lambdaR, lambda);
  for (let i = 0; i < iters; i++) {
    const cp = pi ? cosInside(pi[0], pi[1], n) : Math.sqrt(1 - 1 / (n * n));   // evanescent start: the grazing cosine
    lambda = lambdaR * num / (cr + cp);
    pi = replayDirection(rho, l, v, lambdaR, lambda);
  }
  return pi ? { lambda, pi } : null;
}

/** Slit direction π_y0 for a surface point at height y [mm] above the content centre (slit at distance D, elevated by
 *  `elevationDeg` above the centre). */
export function slitDirection(yMm: number, distanceMm: number = VOLUME_SLIT_DISTANCE_MM,
  elevationDeg: number = VOLUME_SLIT_ELEVATION_DEG): number {
  const d = yMm - distanceMm * Math.tan((elevationDeg * Math.PI) / 180);
  return d / Math.sqrt(d * d + distanceMm * distanceMm);
}

/** Rainbow hologram: λ_c = λ_r(v̂_y + ℓ̂_y)/(ρ̂_y − π_y0) and π̂′(λ_c) (π̂′_y = π_y0). The reference may come from above
 *  (ρ̂_y > π_y0, light from above) or below (both negative). Null when no positive wavelength satisfies the slit
 *  condition or π̂′ is evanescent. */
export function rainbowReplay(rho: Vec3, l: Vec3, v: Vec3, lambdaR: number, piY0: number): Replay | null {
  if (!(l[2] > 0) || !(v[2] > 0)) return null;
  const den = rho[1] - piY0, num = v[1] + l[1];
  if (!(Math.abs(den) > 1e-6) || !(num / den > 1e-6)) return null;
  const lambda = lambdaR * num / den;
  const pi = replayDirection(rho, l, v, lambdaR, lambda);
  return pi ? { lambda, pi } : null;
}

/** Replay window (H1 aperture + Bragg response): exp(−½(θ/σ)²), θ = angle of π̂′ from the inward normal. */
export function replayWindow(pi: Vec3, sigmaRad: number): number {
  const st = Math.min(Math.hypot(pi[0], pi[1]), 1), th = Math.asin(st);
  return Math.exp(-0.5 * (th / Math.max(sigmaRad, 1e-6)) ** 2);
}

/** Row-major rotation object → sticker box: R = R_y(yaw)·R_x(pitch). Pitch > 0 tips the object's top (+y) toward the
 *  viewer (+z); yaw > 0 turns its front (+z) toward +x. */
export function volumeRotation(yawDeg: number, pitchDeg: number): [number, number, number, number, number, number, number, number, number] {
  const a = (yawDeg * Math.PI) / 180, b = (pitchDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  // R_y(a) = [[ca, 0, sa], [0, 1, 0], [−sa, 0, ca]];  R_x(b) = [[1, 0, 0], [0, cb, −sb], [0, sb, cb]]
  return [ca, sa * sb, sa * cb, 0, cb, -sb, -sa, ca * sb, ca * cb];
}

// ---------------------------------------------------------------------------------------------------------------
// Signed-distance volume format (tools/bake-sdf.mjs → public/holo3d/<subject>.sdf). The file is gzip-compressed;
// inside: a 64-byte little-endian header, then nx·ny·nz IEEE half floats (x fastest, then y, then z) of the signed
// distance in object units (the object's longest dimension = 1; negative inside).
//   0 "HSDF" · 4 u32 version 1 · 8/12/16 u32 nx, ny, nz · 20/24/28 f32 bmin (centre of voxel 0,0,0) · 32 f32 h (voxel
//   size) · 36/40 f32 basePitchDeg, baseYawDeg (recommended pose offset) · 44 u32 encoding 1 (float16) · 48 u32
//   source triangles · 52–63 zero.
// ---------------------------------------------------------------------------------------------------------------

export const SDF_HEADER_BYTES = 64;
export const SDF_MAX_VOXELS = 192 * 192 * 192;

export interface SdfVolume {
  nx: number; ny: number; nz: number;
  bmin: Vec3; h: number;
  basePitchDeg: number; baseYawDeg: number;
  triangles: number;
  data: Uint16Array;               // half-float bits, length nx·ny·nz
}

/** True for a gzip stream (magic 1f 8b): the loader decompresses it first. */
export function isGzip(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/** Parses a decompressed .sdf (throws a descriptive Error on any malformed field; never trusts sizes). */
export function parseSdf(bytes: Uint8Array): SdfVolume {
  if (bytes.length < SDF_HEADER_BYTES) throw new Error("sdf: file shorter than its header");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "HSDF") throw new Error(`sdf: bad magic "${magic}"`);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`sdf: unsupported version ${version}`);
  const nx = dv.getUint32(8, true), ny = dv.getUint32(12, true), nz = dv.getUint32(16, true);
  if (![nx, ny, nz].every((n) => n >= 2 && n <= 512)) throw new Error(`sdf: bad dimensions ${nx}×${ny}×${nz}`);
  const count = nx * ny * nz;
  if (count > SDF_MAX_VOXELS) throw new Error(`sdf: ${count} voxels exceed the limit`);
  const bmin: Vec3 = [dv.getFloat32(20, true), dv.getFloat32(24, true), dv.getFloat32(28, true)];
  const h = dv.getFloat32(32, true);
  const basePitchDeg = dv.getFloat32(36, true), baseYawDeg = dv.getFloat32(40, true);
  const encoding = dv.getUint32(44, true), triangles = dv.getUint32(48, true);
  if (encoding !== 1) throw new Error(`sdf: unsupported encoding ${encoding}`);
  if (!(h > 0 && h < 1) || !bmin.every((x) => Number.isFinite(x) && Math.abs(x) < 10)) throw new Error("sdf: bad grid placement");
  if (!Number.isFinite(basePitchDeg) || !Number.isFinite(baseYawDeg) || Math.abs(basePitchDeg) > 180 || Math.abs(baseYawDeg) > 360) {
    throw new Error("sdf: bad base pose");
  }
  const need = SDF_HEADER_BYTES + 2 * count;
  if (bytes.length !== need) throw new Error(`sdf: ${bytes.length} bytes, expected ${need}`);
  const data = new Uint16Array(count);
  for (let i = 0; i < count; i++) data[i] = dv.getUint16(SDF_HEADER_BYTES + 2 * i, true);
  return { nx, ny, nz, bmin, h, basePitchDeg, baseYawDeg, triangles, data };
}

/** Serialises a volume (uncompressed; the baker gzips it). Inverse of parseSdf. */
export function encodeSdf(v: SdfVolume): Uint8Array {
  const count = v.nx * v.ny * v.nz;
  const out = new Uint8Array(SDF_HEADER_BYTES + 2 * count);
  const dv = new DataView(out.buffer);
  out.set([0x48, 0x53, 0x44, 0x46], 0);                                 // "HSDF"
  dv.setUint32(4, 1, true);
  dv.setUint32(8, v.nx, true); dv.setUint32(12, v.ny, true); dv.setUint32(16, v.nz, true);
  dv.setFloat32(20, v.bmin[0], true); dv.setFloat32(24, v.bmin[1], true); dv.setFloat32(28, v.bmin[2], true);
  dv.setFloat32(32, v.h, true);
  dv.setFloat32(36, v.basePitchDeg, true); dv.setFloat32(40, v.baseYawDeg, true);
  dv.setUint32(44, 1, true); dv.setUint32(48, v.triangles >>> 0, true);
  for (let i = 0; i < count; i++) dv.setUint16(SDF_HEADER_BYTES + 2 * i, v.data[i], true);
  return out;
}

/** The far corner (centre of the last voxel) of a volume. */
export function sdfBmax(v: SdfVolume): Vec3 {
  return [v.bmin[0] + (v.nx - 1) * v.h, v.bmin[1] + (v.ny - 1) * v.h, v.bmin[2] + (v.nz - 1) * v.h];
}

/** Trilinear signed distance at an object-space point (clamped to the grid, as the GPU's clamp-to-edge sampler). */
export function sdfAt(v: SdfVolume, p: Vec3): number {
  const g = [(p[0] - v.bmin[0]) / v.h, (p[1] - v.bmin[1]) / v.h, (p[2] - v.bmin[2]) / v.h];
  const n = [v.nx, v.ny, v.nz];
  const i0 = [0, 0, 0], f = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const c = Math.min(Math.max(g[a], 0), n[a] - 1);
    i0[a] = Math.min(Math.floor(c), n[a] - 2);
    f[a] = c - i0[a];
  }
  const at = (i: number, j: number, k: number) => fromHalf(v.data[i + v.nx * (j + v.ny * k)]);
  let s = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    if (w) s += w * at(i0[0] + dx, i0[1] + dy, i0[2] + dz);
  }
  return s;
}

/** A volume sampled from an analytic SDF (tests and fixtures): grid n³ over [−½, ½]³ with a 3-voxel margin. */
export function volumeFromFunction(n: number, f: (p: Vec3) => number): SdfVolume {
  const h = 1 / (n - 6), b0 = -0.5 - 3 * h;
  const data = new Uint16Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    data[i + n * (j + n * k)] = toHalf(f([b0 + i * h, b0 + j * h, b0 + k * h]));
  }
  return { nx: n, ny: n, nz: n, bmin: [b0, b0, b0], h, basePitchDeg: 0, baseYawDeg: 0, triangles: 0, data };
}
