#!/usr/bin/env node
// Bakes a 3D model or a logo into a hologram subject for the Volume Hologram material.
//
// WHAT A SUBJECT IS
//   The Volume Hologram shows a 3D image inside the foil. That image is a "subject": a signed-distance volume, a grid
//   of numbers that say how far each point of a small box is from the object's surface (negative inside the object).
//   The shader uploads the grid as a 3D texture and sphere-traces it. A subject is one binary file, <name>.sdf. Seven
//   ship with holospot in assets/holo3d/ (eagle, chip, wolf, globe, skull, falcon, emblem); this tool bakes your own.
//
// USAGE
//   node tools/bake-hologram.mjs --in model.glb --out assets/holo3d/my.sdf [--rotate x,y,z] [--flat] [--yaw 15] [--pitch 0] [--preview out/] [--verify]
//   node tools/bake-hologram.mjs --in logo.svg  --out my.sdf [--depth 0.07] [--bevel 0.008] [--yaw 0] [--pitch 0] [--preview out/] [--verify]
//   node tools/bake-hologram.mjs --verify assets/holo3d/eagle.sdf [--preview out/]
//
//   The first form bakes a mesh, the second extrudes a flat logo into a bevelled plate, the third bakes nothing: it
//   decodes an existing file and checks it. Node built-ins only, nothing to install. A model of 100 000 triangles
//   takes 5 to 30 seconds and about 150 MB of memory; a logo takes a second or two.
//
// OPTIONS
//   --in <file>      the model (.glb) or the logo (.svg)
//   --out <file>     the subject to write (the folder is created; the file is replaced atomically)
//   --yaw <deg>      default pose stored in the file: the subject's rest pose in the foil, to which the material adds
//   --pitch <deg>    its own `volume.yaw` / `volume.pitch`. Yaw > 0 turns the subject's front toward +x (the viewer's
//                    right), pitch > 0 tips its top toward the viewer. A slight yaw (15 to 30) makes the depth read.
//                    Default 0 and 0; |yaw| ≤ 360, |pitch| ≤ 180.
//   --rotate x,y,z   model only: turns the model into the object frame (see below) before it is baked. Degrees about
//                    the x axis, then the y axis, then the z axis (right-handed). Default 0,0,0: a glTF model that
//                    follows the glTF convention (+y up, front toward +z) needs none. Models from Tripo and Krea face
//                    +x: use --rotate 0,-90,0. A z-up model whose front faces −y: --rotate -90,0,0.
//   --flat           model only: the model is a flat plate (a chip, a coin, a badge) lying at any angle in its file.
//                    Finds the plate's plane from the face normals, squares its edges to x and y and turns its raised
//                    side toward the viewer; --rotate is then applied on top (a quarter turn about z picks which
//                    edge is up).
//   --depth <f>      logo only: thickness of the extruded plate, as a fraction of the logo's longest side (default 0.07)
//   --bevel <f>      logo only: 45° chamfer on both faces, same unit (default 0.008; 0 = sharp edges; at most depth / 2)
//   --cells <n>      voxels across the object's longest side: 122 for a model, 320 for a logo (holo.spot's values and
//                    the defaults). 16 to 500; a finer grid keeps thinner detail, costs bake time and file size, and
//                    must still fit the loader (see LIMITS).
//   --preview <dir>  also writes PNGs rendered from the BAKED file (so they check the file, not the mesh):
//                    <name>-front/-right/-top.png (256 × 256 orthographic views from +z, +x, +y), <name>-slice.png
//                    (the middle z slice: inside dark, outside light, bands every 0.025) and <name>-sheet.png (all four)
//   --verify         with --in: after baking, print the full report on the written file (a bake always decodes the
//                    file it wrote and compares it with what it baked).
//   --verify <file>  on its own: decode and validate an existing file. Exit code 0 when it is valid.
//
// LIMITS
//   Models: GLB only (binary glTF 2.0, one .glb file). Not supported: Draco or Meshopt compression, external or
//   data-URI buffers (a .gltf with a .bin beside it), sparse accessors, anything but triangles. The mesh should be
//   closed (watertight): small holes are repaired by the sign vote, a surface with large openings has no reliable
//   inside.
//   Skins, morph targets and animations are ignored: the model is baked in its rest pose, node transforms applied.
//   Logos: an SVG of filled <path> elements only (commands M L H V C S Q T Z, absolute or relative). Not supported:
//   arcs (A), transforms, strokes, mixed fill rules; <rect>, <circle>, <polygon>, <text> and other shapes are not
//   read. Convert everything to paths and flatten transforms in your drawing program first.
//   The loader: holospot loads at most 192³ = 7 077 888 voxels per subject. The defaults always fit; a large --cells or
//   --depth may not, and the tool then stops before baking.
//
// USING THE RESULT
//   Serve the .sdf next to your page and pass its URL as the setting "volume.subject" of the Volume Hologram:
//     holo.apply(mesh, { material: "volume", settings: { "volume.subject": "./my.sdf" } })
//   A URL starts with ./ ../ / http: https: blob: or data:. A bare name ("eagle") is one of the seven shipped subjects.
//   The file is gzip inside; serve it as it is (no Content-Encoding header needed, holospot decompresses it).
//
// OBJECT FRAME
//   +x right, +y up, +z toward the viewer (out of the foil). The model is rotated into this frame (--rotate, --flat),
//   then its bounding box is centred at the origin and scaled uniformly so that its longest side is exactly 1. A logo
//   is used as drawn: upright, facing the viewer, its longest side 1, extruded along z.
//   Grid: voxel size h = 1 / cells, 3 voxels of padding on every side, so n = ceil(extent / h) + 6 per axis (the
//   longest axis has cells + 6 voxels), centred on the bounding box.
//
// FILE FORMAT (.sdf): the whole file is gzip (level 9) of a 64-byte little-endian header followed by the payload:
//    0  "HSDF"            4 u32 version = 1        8/12/16 u32 nx, ny, nz
//   20/24/28 f32 bmin      object-space centre of voxel (0,0,0)          32 f32 h   voxel size (object units)
//   36 f32 basePitchDeg   40 f32 baseYawDeg   the default pose (--pitch, --yaw)
//   44 u32 encoding = 1   (IEEE binary16 bits of the signed distance, object units, negative inside)
//   48 u32 source triangle count (0 = a logo)                        52..63 zero
//   payload: nx·ny·nz u16, x fastest: index = i + nx·(j + ny·k); voxel centre = bmin + (i, j, k)·h.
//   holospot reads it with parseSdf (engine/physics/volume.ts).
//
// METHOD (a port of holo.spot's own baker, tools/bake-sdf.mjs and tools/svg-extrude.mjs: same algorithm, same
// numbers, same bytes)
//  - Input: minimal GLB v2 reader (header, JSON + BIN chunks, bufferViews/accessors with byteOffset/byteStride, node
//    matrix/TRS hierarchy). Files are untrusted data: every index, offset, length, count and component type is
//    validated before it is read.
//  - Unsigned distance: exact closest point on triangle (Ericson) over a binned-SAH BVH (leaf ≤ 8, nearest child
//    first, pruned by box distance). Voxels are visited in serpentine order and each query starts from the previous
//    voxel's closest triangle, whose distance is a tight upper bound (d is 1-Lipschitz: d(p) ≤ d(prev) + h).
//  - Sign: ray parity along x, y and z on the voxel-centre lines. Every triangle is rasterised onto the 2D lattice of
//    rays, hit depths are collected per ray and sorted, parity gives inside/outside per voxel. Rays are offset by a
//    tiny irrational fraction of h, and shared edges are evaluated with a canonical edge function + top-left rule, so
//    a crossing is never counted twice. A ray with an odd number of hits (mesh hole) abstains; the remaining axes
//    vote (ties: all three raw parities vote). Afterwards sign errors that contradict the distance field are fixed:
//    two 26-neighbours of opposite sign need a surface between them (d_a + d_b ≤ |a − b|), a voxel that violates
//    this with more neighbours than it satisfies it is flipped (repeated until stable).
//  - Logo: the paths are flattened to polylines (adaptive, ≤ ~0.25 viewBox units of chord error on typical logos);
//    the 2D signed distance d₂ is exact to that polyline (nearest segment), its sign from the fill rule (`evenodd`
//    from the fill-rule / clip-rule attribute, else nonzero) by scanline crossings per grid row. Extrusion with half
//    thickness t and chamfer legs c:  w = (d₂, |z| − t),  d_box = |max(w, 0)| + min(max(w.x, w.y), 0),
//    d = max(d_box, (d₂ + |z| − t + c) / √2). Every term is 1-Lipschitz, so d is a valid sphere-tracing bound (exact
//    inside and on the faces; outside it can underestimate only near the chamfer).
//  - Quantisation (conservative for sphere tracing): |d| < 0.02 keeps the nearest half float; beyond, |d| is rounded
//    DOWN to 6 mantissa bits (relative step 1/64); |d| ≤ 1; sign kept.
//  - Deterministic: no randomness, no time dependence, stable orders → byte-identical output on every run.
//
// HOLO.SPOT'S OWN SUBJECTS are this tool's output with these options (file for file the same bytes as assets/holo3d/):
//   eagle    --in eagle.glb   --rotate 0,-90,0
//   wolf     --in wolf.glb    --rotate 0,-90,0 --yaw 25
//   skull    --in skull.glb   --rotate 0,-90,0 --yaw 15
//   falcon   --in falcon.glb  --rotate 0,-90,0 --yaw 30
//   chip     --in chip.glb    --flat --rotate 0,0,180 --pitch -20 --yaw 20
//   emblem   --in eagle-globe.svg                      (the logo defaults: 320 cells, depth 0.07, bevel 0.008)
//   globe    is procedural in the site's baker (an analytic formula, no input file) and is not part of this tool.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const FORMAT_VERSION = 1;
const ENCODING_HALF = 1;
const HEADER_BYTES = 64;
const CELLS = 122;                         // model: voxels across the longest AABB side (--cells)
const SVG_CELLS = 320;                     // logo: voxels across the longest side, finer so thin slots and bars stay crisp
const SVG_DEPTH = 0.07;                    // logo: thickness (--depth), fraction of the longest side
const SVG_BEVEL = 0.008;                   // logo: 45° chamfer (--bevel), same unit
const MIN_CELLS = 16, MAX_CELLS = 500;     // range of --cells (what decodeSdf accepts)
const PAD = 3;                             // voxels of padding beyond the AABB on every side
const EXACT_BAND = 0.02;                   // |d| below this keeps the nearest half float
const KEEP_BITS = 6;                       // beyond: mantissa bits kept (relative step 1/64), rounded down
const LEAF_SIZE = 8;
// Ray offsets in units of h (tiny irrational fractions), indexed by the in-plane axis of the ray lattice.
const RAY_JITTER = [(Math.SQRT2 - 1) * 1e-3, (Math.sqrt(3) - 1) * 1e-3, (Math.sqrt(5) - 2) * 1e-3];
// What holospot's loader accepts (parseSdf in engine/physics/volume.ts): a larger file bakes but never loads.
const LOADER_MAX_VOXELS = 192 * 192 * 192, LOADER_MAX_DIM = 512;

const GLB_LIMITS = "  Models: GLB only (binary glTF 2.0, one .glb file); no Draco, no Meshopt, no external or data-URI buffers, " +
  "no sparse accessors; triangles only.";
const SVG_LIMITS = "  Logos: an SVG of filled <path> elements only (M L H V C S Q T Z); no arcs, no transforms, no strokes, " +
  "no <rect>/<circle>/<polygon>/<text>. Convert shapes to paths and flatten transforms first.";

// ---------------------------------------------------------------------------------------------------------------
// Small linear algebra (3×3 row-major as nested arrays)
// ---------------------------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;
function rotX(deg) { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
function rotY(deg) { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
function rotZ(deg) { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
function matMul(A, B) {
  return A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const fmtMat = (M) => "[" + M.map((r) => "[" + r.map((v) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6)).join(", ") + "]").join(", ") + "]";

/** Eigen-decomposition of a symmetric 3×3 matrix (cyclic Jacobi). Returns eigenvalues + unit eigenvectors, sorted
 *  by decreasing eigenvalue. Deterministic. */
function eigSym3(M) {
  const a = M.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off <= 1e-30 * (a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A ← Jᵀ A J
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const out = [0, 1, 2].map((i) => ({ value: a[i][i], vector: norm3([v[0][i], v[1][i], v[2][i]]) }));
  return out.sort((x, y) => y.value - x.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Half floats
// ---------------------------------------------------------------------------------------------------------------

const scratchView = new DataView(new ArrayBuffer(8));
/** floor(log2 a) for a normal, finite, positive double (exact: read from the exponent bits). */
function floorLog2(a) {
  scratchView.setFloat64(0, a);
  return ((scratchView.getUint32(0) >>> 20) & 0x7ff) - 1023;
}
/** Round-to-nearest-even double → IEEE binary16 bits (subnormals, ±Inf, NaN handled; no double rounding). */
export function halfFromFloat(v) {
  if (Number.isNaN(v)) return 0x7e00;
  const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0;
  const a = Math.abs(v);
  if (a >= 65520) return sign | 0x7c00;
  if (a < 6.103515625e-5) {                     // below 2^-14: subnormal, unit 2^-24
    const s = a * 16777216;
    let m = Math.floor(s);
    const f = s - m;
    if (f > 0.5 || (f === 0.5 && (m & 1))) m++;
    return sign | m;                            // m = 1024 is exactly the smallest normal's bit pattern
  }
  let e = floorLog2(a);
  const s = a * 2 ** (10 - e);                  // in [1024, 2048), exact
  let m = Math.floor(s);
  const f = s - m;
  if (f > 0.5 || (f === 0.5 && (m & 1))) m++;
  if (m === 2048) { m = 1024; e++; }
  if (e > 15) return sign | 0x7c00;
  return sign | ((e + 15) << 10) | (m - 1024);
}
export function halfToFloat(b) {
  const s = b & 0x8000 ? -1 : 1, e = (b >> 10) & 31, m = b & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1024 + m) * 2 ** (e - 25);
}
/** Signed distance → stored half bits: |d| clamped to 1; nearest half below EXACT_BAND, else rounded DOWN to
 *  KEEP_BITS mantissa bits so the stored magnitude never exceeds the true one. */
export function quantiseDistance(d) {
  const a = Math.min(Math.abs(d), 1);
  let bits;
  if (a < EXACT_BAND) bits = halfFromFloat(a);
  else {
    const e = floorLog2(a);
    const m = Math.floor(a * 2 ** (KEEP_BITS - e));          // in [64, 128)
    bits = ((e + 15) << 10) | ((m - (1 << KEEP_BITS)) << (10 - KEEP_BITS));
  }
  return d < 0 ? bits | 0x8000 : bits;
}

// ---------------------------------------------------------------------------------------------------------------
// GLB reader (untrusted input: parse only, validate everything)
// ---------------------------------------------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPRESSION_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression"];
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const MAX_ELEMENTS = 1 << 25;

class GlbError extends Error {}                  // a model this tool cannot read (printed with the model limits)
class SvgError extends Error {}                  // a logo this tool cannot read (printed with the logo limits)
class SdfError extends Error {}                  // an .sdf file that is not a valid subject
class UsageError extends Error {}                // a wrong command line
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isUint = (v) => Number.isSafeInteger(v) && v >= 0;

/** Splits a GLB container into its parsed JSON and BIN chunk. */
export function parseGlb(buf, file) {
  const bad = (msg) => { throw new GlbError(`${file}: ${msg}`); };
  if (buf.length < 20) bad("file too small for a GLB");
  if (buf.readUInt32LE(0) !== GLB_MAGIC) bad("not a GLB: the file does not start with the binary glTF magic \"glTF\"");
  if (buf.readUInt32LE(4) !== 2) bad(`unsupported GLB version ${buf.readUInt32LE(4)} (only binary glTF 2.0 is read)`);
  const total = buf.readUInt32LE(8);
  if (total < 20 || total > buf.length) bad(`header length ${total} inconsistent with file size ${buf.length}`);
  let off = 12, json = null, bin = null;
  while (off + 8 <= total) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const start = off + 8, end = start + len;
    if (end > total) bad(`chunk at ${off} (${len} bytes) runs past the end of the file`);
    if (json === null) {
      if (type !== CHUNK_JSON) bad("first chunk is not JSON");
      json = buf.subarray(start, end);
    } else if (type === CHUNK_BIN) {
      if (bin !== null) bad("more than one BIN chunk");
      bin = buf.subarray(start, end);
    }                                            // unknown chunk types are skipped (glTF spec)
    off = end;
  }
  if (off !== total) bad("trailing bytes after the last chunk");
  if (json === null) bad("missing JSON chunk");
  let gltf;
  try { gltf = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)); } catch { bad("JSON chunk is not valid UTF-8 JSON"); }
  if (!isObj(gltf)) bad("JSON chunk is not an object");
  return { gltf, bin: bin ?? Buffer.alloc(0) };
}

/** Reads a .glb file into one indexed triangle soup (see glbMesh). */
export function loadGlbMesh(file) {
  return glbMesh(fs.readFileSync(file), path.basename(file));
}

/** Reads every triangle primitive of the default scene, node transforms applied, into one indexed soup.
 *  `bytes`: the content of a .glb; `name`: the file's name, for error messages. */
export function glbMesh(bytes, name) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (msg) => { throw new GlbError(`${name}: ${msg}`); };
  const { gltf, bin } = parseGlb(buf, name);
  const list = (key) => {
    const v = gltf[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) bad(`"${key}" is not an array`);
    return v;
  };
  const ref = (arr, i, what) => {
    if (!isUint(i) || i >= arr.length || !isObj(arr[i])) bad(`invalid ${what} index ${JSON.stringify(i)}`);
    return arr[i];
  };

  // Compression extensions are refused outright; any other required extension is unsupported.
  for (const key of ["extensionsUsed", "extensionsRequired"]) {
    for (const ext of list(key)) {
      if (COMPRESSION_EXTENSIONS.includes(ext)) bad(`uses ${ext}; compressed meshes are not supported — export the GLB uncompressed`);
      if (key === "extensionsRequired") bad(`requires unsupported extension ${JSON.stringify(ext)}`);
    }
  }
  const accessors = list("accessors"), bufferViews = list("bufferViews"), buffers = list("buffers");
  const meshes = list("meshes"), nodes = list("nodes"), scenes = list("scenes");
  for (const bv of bufferViews) {
    if (isObj(bv) && isObj(bv.extensions) && COMPRESSION_EXTENSIONS.some((e) => e in bv.extensions)) bad("compressed bufferView (Meshopt) is not supported");
  }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  /** Validated reader of one accessor → plain array view {count, comps, get(i, c)}. */
  const accessor = (index, allowedTypes, allowedComponents, what) => {
    const acc = ref(accessors, index, `${what} accessor`);
    if (acc.sparse !== undefined) bad(`${what} accessor uses sparse storage (unsupported)`);
    if (!allowedTypes.includes(acc.type)) bad(`${what} accessor has type ${JSON.stringify(acc.type)}`);
    if (!allowedComponents.includes(acc.componentType)) bad(`${what} accessor has componentType ${JSON.stringify(acc.componentType)}`);
    if (!isUint(acc.count) || acc.count < 1 || acc.count > MAX_ELEMENTS) bad(`${what} accessor count ${JSON.stringify(acc.count)}`);
    const comps = TYPE_COMPONENTS[acc.type], cBytes = COMPONENT_BYTES[acc.componentType], elem = comps * cBytes;
    const bv = ref(bufferViews, acc.bufferView, `${what} bufferView`);
    const buffer = ref(buffers, bv.buffer, `${what} buffer`);
    if (bv.buffer !== 0 || buffer.uri !== undefined) bad("only the GLB-embedded buffer 0 is supported (no external or data-URI buffers)");
    if (!isUint(buffer.byteLength) || buffer.byteLength > bin.length) bad("buffer 0 is larger than the BIN chunk");
    const bvOff = bv.byteOffset ?? 0, bvLen = bv.byteLength;
    if (!isUint(bvOff) || !isUint(bvLen) || bvOff + bvLen > buffer.byteLength) bad(`${what} bufferView range out of bounds`);
    const stride = bv.byteStride ?? elem;
    if (!isUint(stride) || stride < elem || stride > 255) bad(`${what} bufferView byteStride ${JSON.stringify(bv.byteStride)}`);
    const accOff = acc.byteOffset ?? 0;
    if (!isUint(accOff)) bad(`${what} accessor byteOffset`);
    if (accOff + stride * (acc.count - 1) + elem > bvLen) bad(`${what} accessor runs past its bufferView`);
    const base = bvOff + accOff, ct = acc.componentType;
    const read = ct === 5126 ? (o) => dv.getFloat32(o, true) : ct === 5125 ? (o) => dv.getUint32(o, true)
      : ct === 5123 ? (o) => dv.getUint16(o, true) : ct === 5122 ? (o) => dv.getInt16(o, true)
        : ct === 5121 ? (o) => dv.getUint8(o) : (o) => dv.getInt8(o);
    return { count: acc.count, comps, get: (i, c) => read(base + i * stride + c * cBytes) };
  };

  // Node hierarchy → world matrices (column-major 4×4, glTF convention).
  const localMatrix = (node) => {
    const nums = (v, n, what) => {
      if (!Array.isArray(v) || v.length !== n || !v.every(Number.isFinite)) bad(`node ${what} is not ${n} finite numbers`);
      return v;
    };
    if (node.matrix !== undefined) return nums(node.matrix, 16, "matrix").slice();
    const t = node.translation === undefined ? [0, 0, 0] : nums(node.translation, 3, "translation");
    const q = node.rotation === undefined ? [0, 0, 0, 1] : nums(node.rotation, 4, "rotation");
    const s = node.scale === undefined ? [1, 1, 1] : nums(node.scale, 3, "scale");
    const ql = Math.hypot(...q);
    if (!(ql > 0)) bad("node rotation quaternion has zero length");
    const [x, y, z, w] = q.map((v) => v / ql);
    const r = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];  // column-major 3×3
    return [r[0] * s[0], r[1] * s[0], r[2] * s[0], 0, r[3] * s[1], r[4] * s[1], r[5] * s[1], 0,
      r[6] * s[2], r[7] * s[2], r[8] * s[2], 0, t[0], t[1], t[2], 1];
  };
  const mul4 = (A, B) => {
    const C = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) C[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
    return C;
  };
  let roots;
  if (scenes.length) {
    const scene = ref(scenes, gltf.scene ?? 0, "scene");
    roots = scene.nodes === undefined ? [] : scene.nodes;
    if (!Array.isArray(roots)) bad("scene.nodes is not an array");
  } else {
    const child = new Set();
    nodes.forEach((n) => { if (isObj(n) && Array.isArray(n.children)) n.children.forEach((c) => child.add(c)); });
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
  }
  const visited = new Set();
  const stack = roots.map((i) => [i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]]).reverse();
  const instances = [];
  while (stack.length) {
    const [ni, parent] = stack.pop();
    const node = ref(nodes, ni, "node");
    if (visited.has(ni)) bad(`node ${ni} is referenced twice (cycle or shared child)`);
    visited.add(ni);
    const world = mul4(parent, localMatrix(node));
    if (node.mesh !== undefined) instances.push([ref(meshes, node.mesh, "mesh"), world]);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) bad("node.children is not an array");
      for (let c = node.children.length - 1; c >= 0; c--) stack.push([node.children[c], world]);
    }
  }

  const pos = [], idx = [];
  let nVerts = 0;
  for (const [mesh, M] of instances) {
    if (!Array.isArray(mesh.primitives)) bad("mesh.primitives is not an array");
    for (const prim of mesh.primitives) {
      if (!isObj(prim) || !isObj(prim.attributes)) bad("invalid primitive");
      if (isObj(prim.extensions) && COMPRESSION_EXTENSIONS.some((e) => e in prim.extensions)) bad("compressed primitive (Draco) is not supported");
      const mode = prim.mode ?? 4;
      if (mode !== 4) bad(`primitive mode ${JSON.stringify(mode)} is not supported (triangles only)`);
      const P = accessor(prim.attributes.POSITION, ["VEC3"], [5126], "POSITION");
      const base = nVerts;
      for (let i = 0; i < P.count; i++) {
        const x = P.get(i, 0), y = P.get(i, 1), z = P.get(i, 2);
        const wx = M[0] * x + M[4] * y + M[8] * z + M[12], wy = M[1] * x + M[5] * y + M[9] * z + M[13];
        const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
        if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) bad(`non-finite POSITION ${i}`);
        pos.push(wx, wy, wz);
      }
      nVerts += P.count;
      if (prim.indices !== undefined) {
        const I = accessor(prim.indices, ["SCALAR"], [5121, 5123, 5125], "indices");
        if (I.count % 3) bad("index count is not a multiple of 3");
        for (let i = 0; i < I.count; i++) {
          const v = I.get(i, 0);
          if (v >= P.count) bad(`index ${v} out of range (${P.count} vertices)`);
          idx.push(base + v);
        }
      } else {
        if (P.count % 3) bad("non-indexed vertex count is not a multiple of 3");
        for (let i = 0; i < P.count; i++) idx.push(base + i);
      }
      if (idx.length > 3 * MAX_ELEMENTS) bad("too many triangles");
    }
  }
  if (!idx.length) bad("no triangles in the default scene");
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx), nVerts, nTris: idx.length / 3 };
}

/** Boundary edges (used by one triangle) and non-manifold edges (> 2), after welding vertices by exact position. */
function edgeStats(mesh) {
  const { positions: P, indices: I, nVerts } = mesh;
  const weld = new Uint32Array(nVerts), ids = new Map();
  for (let v = 0; v < nVerts; v++) {
    const key = `${P[3 * v]},${P[3 * v + 1]},${P[3 * v + 2]}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    weld[v] = id;
  }
  const nW = ids.size, uses = new Map();
  for (let t = 0; t < I.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = weld[I[t + e]], b = weld[I[t + (e + 1) % 3]];
      if (a === b) continue;
      const key = a < b ? a * nW + b : b * nW + a;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const n of uses.values()) { if (n === 1) boundary++; else if (n > 2) nonManifold++; }
  return { weldedVerts: nW, edges: uses.size, boundary, nonManifold };
}

// ---------------------------------------------------------------------------------------------------------------
// Orientation of a flat plate (--flat)
// ---------------------------------------------------------------------------------------------------------------

/** Rotation for a flat package (--flat; holo.spot's chip subject). Plate normal: dominant eigenvector of the
 *  area-weighted normal tensor Σ A·n nᵀ,
 *  refined by an axial mean shift of the face normals in a narrowing cone (the tensor alone is biased ~4° by the
 *  relief walls; the shift converges on the large flat top/bottom faces). In-plane angle: minimum-area projected
 *  AABB (package edges along x/y). The side whose extreme heights sit near the middle of the plate (the raised heat
 *  spreader) faces +z. Returns rows [u; v; n] (right-handed). */
function plateRotation(mesh, log) {
  const { positions: P, indices: I } = mesh;
  const nT = I.length / 3, fn = new Float64Array(3 * nT), fa = new Float64Array(nT);
  const T = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < nT; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ab = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const ac = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const nn = cross3(ab, ac), len = Math.hypot(nn[0], nn[1], nn[2]);
    if (!(len > 0)) continue;
    fa[t] = 0.5 * len;
    for (let i = 0; i < 3; i++) fn[3 * t + i] = nn[i] / len;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[i][j] += fa[t] * fn[3 * t + i] * fn[3 * t + j];
  }
  const eig = eigSym3(T);
  let n = eig[0].vector;
  const n0 = n;
  let flatShare = 0;
  for (const cone of [10, 5, 3, 2, 1.5, 1, 1, 1, 1, 1, 1, 1, 1]) {
    const cc = Math.cos(cone * DEG), s = [0, 0, 0];
    let A = 0, Atot = 0;
    for (let t = 0; t < nT; t++) {
      const d = fn[3 * t] * n[0] + fn[3 * t + 1] * n[1] + fn[3 * t + 2] * n[2];
      Atot += fa[t];
      if (Math.abs(d) < cc) continue;
      const w = d > 0 ? fa[t] : -fa[t];
      s[0] += w * fn[3 * t]; s[1] += w * fn[3 * t + 1]; s[2] += w * fn[3 * t + 2]; A += fa[t];
    }
    n = norm3(s);
    flatShare = A / Atot;
  }
  log(`  plate normal: tensor eigenvector ${n0.map((x) => x.toFixed(4)).join(", ")} → mean shift ` +
    `${n.map((x) => x.toFixed(4)).join(", ")} (${(Math.acos(Math.min(1, Math.abs(dot3(n, n0)))) / DEG).toFixed(2)}°, ` +
    `${(100 * flatShare).toFixed(1)}% of the area within 1°)`);
  // Deterministic in-plane start axis, then the angle of the minimum-area AABB (coarse scan + refinement).
  const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0 = norm3(cross3(helper, n)), v0 = cross3(n, u0);
  const nv = P.length / 3, pu = new Float64Array(nv), pv = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const p = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    pu[i] = dot3(p, u0); pv[i] = dot3(p, v0);
  }
  const area = (th) => {
    const c = Math.cos(th), s = Math.sin(th);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < nv; i++) {
      const x = c * pu[i] + s * pv[i], y = -s * pu[i] + c * pv[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return (x1 - x0) * (y1 - y0);
  };
  let best = 0, bestA = Infinity;
  for (let k = 0; k < 360; k++) { const th = k * 0.25 * DEG, A = area(th); if (A < bestA) { bestA = A; best = th; } }
  const lo = best - 0.25 * DEG;
  for (let k = 0; k <= 100; k++) { const th = lo + k * 0.005 * DEG, A = area(th); if (A < bestA) { bestA = A; best = th; } }
  const c = Math.cos(best), s = Math.sin(best);
  let u = [c * u0[0] + s * v0[0], c * u0[1] + s * v0[1], c * u0[2] + s * v0[2]];
  let v = cross3(n, u);
  // Heat-spreader side: compare how central the top-2% and bottom-2% heights are (normalised in-plane radius).
  const hgt = new Float64Array(nv), rad = new Float64Array(nv);
  let h0 = Infinity, h1 = -Infinity, uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < nv; i++) {
    const p = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    hgt[i] = dot3(p, n); const x = dot3(p, u), y = dot3(p, v);
    pu[i] = x; pv[i] = y;
    h0 = Math.min(h0, hgt[i]); h1 = Math.max(h1, hgt[i]);
    uMin = Math.min(uMin, x); uMax = Math.max(uMax, x); vMin = Math.min(vMin, y); vMax = Math.max(vMax, y);
  }
  const uc = (uMin + uMax) / 2, vc = (vMin + vMax) / 2, uh = (uMax - uMin) / 2, vh = (vMax - vMin) / 2;
  for (let i = 0; i < nv; i++) rad[i] = Math.max(Math.abs(pu[i] - uc) / uh, Math.abs(pv[i] - vc) / vh);
  const band = 0.02 * (h1 - h0);
  let topR = 0, topN = 0, botR = 0, botN = 0;
  for (let i = 0; i < nv; i++) {
    if (hgt[i] >= h1 - band) { topR += rad[i]; topN++; }
    if (hgt[i] <= h0 + band) { botR += rad[i]; botN++; }
  }
  topR /= topN; botR /= botN;
  if (botR < topR) { n = n.map((x) => -x); v = v.map((x) => -x); }   // keep right-handed: (u, −v, −n)
  log(`  plate: normal tensor eigenvalues ${eig.map((e) => e.value.toFixed(4)).join(", ")}; in-plane angle ` +
    `${(best / DEG).toFixed(3)}°; mean radius of extreme heights +n ${topR.toFixed(3)} / −n ${botR.toFixed(3)} ` +
    `→ spreader on ${botR < topR ? "−n (flipped)" : "+n"}`);
  return [u, v, n];
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation and grid
// ---------------------------------------------------------------------------------------------------------------

/** Rotates the vertices, centres the AABB at the origin and scales the longest side to 1 (in place). */
function orientAndNormalise(mesh, R) {
  const P = mesh.positions, nv = P.length / 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    for (let r = 0; r < 3; r++) {
      const q = R[r][0] * x + R[r][1] * y + R[r][2] * z;
      P[3 * i + r] = q;
      if (q < lo[r]) lo[r] = q; if (q > hi[r]) hi[r] = q;
    }
  }
  const ext = [0, 1, 2].map((r) => hi[r] - lo[r]), centre = [0, 1, 2].map((r) => (hi[r] + lo[r]) / 2);
  const scale = 1 / Math.max(...ext);
  for (let i = 0; i < nv; i++) for (let r = 0; r < 3; r++) P[3 * i + r] = (P[3 * i + r] - centre[r]) * scale;
  return { scale, extent: ext.map((e) => e * scale), sourceExtent: ext };
}

/** Grid around an origin-centred AABB of the given extent: h = 1/cells (the f32 value stored in the header),
 *  n = ceil(extent/h) + 2·PAD, centred. */
export function makeGrid(extent, cells = CELLS) {
  const h = Math.fround(1 / cells);
  const n = extent.map((e) => Math.max(1, Math.ceil(e * cells - 1e-6)) + 2 * PAD);
  const bmin = n.map((k) => Math.fround(-((k - 1) / 2) * h));
  return { n, bmin, h, count: n[0] * n[1] * n[2] };
}

// ---------------------------------------------------------------------------------------------------------------
// BVH + exact unsigned distance
// ---------------------------------------------------------------------------------------------------------------

/** Binned-SAH BVH. Returns node boxes (6 per node), node info (child index | first triangle, triangle count) and
 *  the triangle data in leaf order: a, b − a, c − a (9 doubles per triangle). */
function buildBvh(P, I) {
  const nT = I.length / 3;
  const tb = new Float64Array(6 * nT), cen = new Float64Array(3 * nT);
  for (let t = 0; t < nT; t++) {
    for (let r = 0; r < 3; r++) {
      const a = P[3 * I[3 * t] + r], b = P[3 * I[3 * t + 1] + r], c = P[3 * I[3 * t + 2] + r];
      tb[6 * t + r] = Math.min(a, b, c); tb[6 * t + 3 + r] = Math.max(a, b, c);
      cen[3 * t + r] = (a + b + c) / 3;
    }
  }
  const order = new Uint32Array(nT).map((_, i) => i), tmp = new Uint32Array(nT);
  const maxNodes = 2 * nT;
  const box = new Float64Array(6 * maxNodes), info = new Int32Array(2 * maxNodes);
  const BINS = 16, binN = new Int32Array(BINS), binB = new Float64Array(6 * BINS);
  const rightA = new Float64Array(BINS), rightN = new Int32Array(BINS);
  const halfArea = (B, o) => {                    // half surface area; 0 for an empty (inverted) box
    const x = B[o + 3] - B[o], y = B[o + 4] - B[o + 1], z = B[o + 5] - B[o + 2];
    return x >= 0 ? x * y + y * z + z * x : 0;
  };
  let nodes = 1;
  const work = [[0, 0, nT]];
  while (work.length) {
    const [node, s, e] = work.pop();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const clo = [Infinity, Infinity, Infinity], chi = [-Infinity, -Infinity, -Infinity];
    for (let k = s; k < e; k++) {
      const t = order[k];
      for (let r = 0; r < 3; r++) {
        lo[r] = Math.min(lo[r], tb[6 * t + r]); hi[r] = Math.max(hi[r], tb[6 * t + 3 + r]);
        clo[r] = Math.min(clo[r], cen[3 * t + r]); chi[r] = Math.max(chi[r], cen[3 * t + r]);
      }
    }
    box.set([...lo, ...hi], 6 * node);
    const cnt = e - s;
    if (cnt <= LEAF_SIZE) { info[2 * node] = s; info[2 * node + 1] = cnt; continue; }
    const ext = [chi[0] - clo[0], chi[1] - clo[1], chi[2] - clo[2]];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    let mid = -1;
    if (ext[axis] > 0) {
      const k0 = clo[axis], kScale = BINS / ext[axis] * (1 - 1e-9);
      binN.fill(0);
      for (let b = 0; b < BINS; b++) binB.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], 6 * b);
      const binOf = (t) => Math.min(BINS - 1, Math.floor((cen[3 * t + axis] - k0) * kScale));
      for (let k = s; k < e; k++) {
        const t = order[k], b = binOf(t);
        binN[b]++;
        for (let r = 0; r < 3; r++) {
          binB[6 * b + r] = Math.min(binB[6 * b + r], tb[6 * t + r]);
          binB[6 * b + 3 + r] = Math.max(binB[6 * b + 3 + r], tb[6 * t + 3 + r]);
        }
      }
      const acc = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      let accN = 0;
      for (let b = BINS - 1; b > 0; b--) {
        accN += binN[b];
        for (let r = 0; r < 3; r++) { acc[r] = Math.min(acc[r], binB[6 * b + r]); acc[3 + r] = Math.max(acc[3 + r], binB[6 * b + 3 + r]); }
        rightN[b] = accN; rightA[b] = accN ? halfArea(acc, 0) : 0;
      }
      acc.splice(0, 6, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
      accN = 0;
      let bestCost = Infinity, bestSplit = -1;
      for (let b = 1; b < BINS; b++) {
        accN += binN[b - 1];
        for (let r = 0; r < 3; r++) { acc[r] = Math.min(acc[r], binB[6 * (b - 1) + r]); acc[3 + r] = Math.max(acc[3 + r], binB[6 * (b - 1) + 3 + r]); }
        if (!accN || !rightN[b]) continue;
        const cost = halfArea(acc, 0) * accN + rightA[b] * rightN[b];
        if (cost < bestCost) { bestCost = cost; bestSplit = b; }
      }
      if (bestSplit > 0) {                       // stable partition by bin
        let l = s, r = 0;
        for (let k = s; k < e; k++) { const t = order[k]; if (binOf(t) < bestSplit) order[l++] = t; else tmp[r++] = t; }
        order.set(tmp.subarray(0, r), l);
        mid = l;
      }
    }
    if (mid <= s || mid >= e) mid = s + (cnt >> 1); // identical centroids: split by position in the list
    const left = nodes;
    nodes += 2;
    info[2 * node] = left; info[2 * node + 1] = 0;
    work.push([left + 1, mid, e], [left, s, mid]);
  }
  const tri = new Float64Array(9 * nT);
  for (let k = 0; k < nT; k++) {
    const t = order[k], a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    for (let r = 0; r < 3; r++) {
      tri[9 * k + r] = P[a + r]; tri[9 * k + 3 + r] = P[b + r] - P[a + r]; tri[9 * k + 6 + r] = P[c + r] - P[a + r];
    }
  }
  return { box: box.subarray(0, 6 * nodes), info: info.subarray(0, 2 * nodes), tri, nodes, nT };
}

/** Squared distance from p to triangle k of the leaf-ordered array (Ericson, Real-Time Collision Detection 5.1.5). */
function triDist2(T, k, px, py, pz) {
  const o = 9 * k;
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3], aby = T[o + 4], abz = T[o + 5], acx = T[o + 6], acy = T[o + 7], acz = T[o + 8];
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3), x = apx - v * abx, y = apy - v * aby, z = apz - v * abz;
    return x * x + y * y + z * z;
  }
  const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6), x = apx - w * acx, y = apy - w * acy, z = apz - w * acz;
    return x * x + y * y + z * z;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));        // on edge bc: p − (b + w (c − b))
    const x = bpx - w * (acx - abx), y = bpy - w * (acy - aby), z = bpz - w * (acz - abz);
    return x * x + y * y + z * z;
  }
  const sum = va + vb + vc;
  if (!(sum > 0)) return Math.min(segDist2(apx, apy, apz, abx, aby, abz), segDist2(apx, apy, apz, acx, acy, acz),
    segDist2(bpx, bpy, bpz, acx - abx, acy - aby, acz - abz));   // degenerate (zero-area) triangle
  const v = vb / sum, w = vc / sum;
  const x = apx - v * abx - w * acx, y = apy - v * aby - w * acy, z = apz - v * abz - w * acz;
  return x * x + y * y + z * z;
}
/** Squared distance from point (relative to segment start) to segment with direction d. */
function segDist2(px, py, pz, dx, dy, dz) {
  const dd = dx * dx + dy * dy + dz * dz;
  let t = dd > 0 ? (px * dx + py * dy + pz * dz) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = px - t * dx, y = py - t * dy, z = pz - t * dz;
  return x * x + y * y + z * z;
}

/** Exact unsigned distance at every voxel centre (serpentine order, warm-started bound). */
function unsignedDistances(bvh, grid) {
  const { box, info, tri } = bvh, { n, bmin, h } = grid, [nx, ny, nz] = n;
  const out = new Float64Array(grid.count);
  const stackN = new Int32Array(256), stackD = new Float64Array(256);
  let prevTri = 0, visits = 0, row = 0;
  for (let k = 0; k < nz; k++) {
    for (let jj = 0; jj < ny; jj++, row++) {
      const j = k & 1 ? ny - 1 - jj : jj;
      for (let ii = 0; ii < nx; ii++) {
        const i = row & 1 ? nx - 1 - ii : ii;
        const px = bmin[0] + i * h, py = bmin[1] + j * h, pz = bmin[2] + k * h;
        let best2 = triDist2(tri, prevTri, px, py, pz), bestTri = prevTri;
        let sp = 0;
        stackN[sp] = 0; stackD[sp++] = 0;
        while (sp > 0) {
          const node = stackN[--sp];
          if (stackD[sp] >= best2) continue;
          visits++;
          const cnt = info[2 * node + 1];
          if (cnt > 0) {
            const s = info[2 * node];
            for (let t = s; t < s + cnt; t++) {
              const d2 = triDist2(tri, t, px, py, pz);
              if (d2 < best2) { best2 = d2; bestTri = t; }
            }
            continue;
          }
          const l = info[2 * node], r = l + 1;
          let o = 6 * l;
          let dx = Math.max(box[o] - px, 0, px - box[o + 3]), dy = Math.max(box[o + 1] - py, 0, py - box[o + 4]);
          let dz = Math.max(box[o + 2] - pz, 0, pz - box[o + 5]);
          const dl = dx * dx + dy * dy + dz * dz;
          o = 6 * r;
          dx = Math.max(box[o] - px, 0, px - box[o + 3]); dy = Math.max(box[o + 1] - py, 0, py - box[o + 4]);
          dz = Math.max(box[o + 2] - pz, 0, pz - box[o + 5]);
          const dr = dx * dx + dy * dy + dz * dz;
          if (dl <= dr) {                         // push the farther child first so the nearer one is popped next
            if (dr < best2) { stackN[sp] = r; stackD[sp++] = dr; }
            if (dl < best2) { stackN[sp] = l; stackD[sp++] = dl; }
          } else {
            if (dl < best2) { stackN[sp] = l; stackD[sp++] = dl; }
            if (dr < best2) { stackN[sp] = r; stackD[sp++] = dr; }
          }
        }
        prevTri = bestTri;
        out[i + nx * (j + ny * k)] = Math.sqrt(best2);
      }
    }
  }
  return { dist: out, visits };
}

// ---------------------------------------------------------------------------------------------------------------
// Sign: ray parity along three axes, vote, consistency clean-up
// ---------------------------------------------------------------------------------------------------------------

/** Top-left tie rule for an oriented (CCW-normalised) edge direction; reversing the direction negates it. */
const topLeft = (dx, dy) => dy < 0 || (dy === 0 && dx > 0);

/** Per-axis parity (1 = inside) for every voxel, plus a per-axis flag whether the voxel's ray had an odd number of
 *  crossings (unreliable). */
function rayParity(P, I, grid) {
  const { n, bmin, h } = grid, nv = P.length / 3, nT = I.length / 3;
  const stride = [1, n[0], n[0] * n[1]];
  const inside = [0, 1, 2].map(() => new Uint8Array(grid.count));
  const odd = [0, 1, 2].map(() => new Uint8Array(grid.count));
  const stats = [];
  const gx = new Float64Array(nv), gy = new Float64Array(nv);
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, c = (a + 2) % 3, nb = n[b], nc = n[c], na = n[a];
    const ob = bmin[b] + RAY_JITTER[b] * h, oc = bmin[c] + RAY_JITTER[c] * h;
    for (let v = 0; v < nv; v++) { gx[v] = (P[3 * v + b] - ob) / h; gy[v] = (P[3 * v + c] - oc) / h; }
    const counts = new Int32Array(nb * nc + 1);
    let depths = null;
    const fillPos = new Int32Array(nb * nc);
    for (let pass = 0; pass < 2; pass++) {
      for (let t = 0; t < nT; t++) {
        const iA = I[3 * t], iB = I[3 * t + 1], iC = I[3 * t + 2];
        const Ax = gx[iA], Ay = gy[iA], Bx = gx[iB], By = gy[iB], Cx = gx[iC], Cy = gy[iC];
        const area2 = (Bx - Ax) * (Cy - Ay) - (By - Ay) * (Cx - Ax);
        if (area2 === 0 || !Number.isFinite(area2)) continue;
        const x0 = Math.max(0, Math.ceil(Math.min(Ax, Bx, Cx))), x1 = Math.min(nb - 1, Math.floor(Math.max(Ax, Bx, Cx)));
        const y0 = Math.max(0, Math.ceil(Math.min(Ay, By, Cy))), y1 = Math.min(nc - 1, Math.floor(Math.max(Ay, By, Cy)));
        if (x0 > x1 || y0 > y1) continue;
        const s = area2 > 0 ? 1 : -1;
        // Canonical edge (lexicographically smaller endpoint first) so that a shared edge is evaluated bit-identically
        // in both triangles; mult turns it into this triangle's CCW-oriented edge function.
        const E = [[Ax, Ay, Bx, By], [Bx, By, Cx, Cy], [Cx, Cy, Ax, Ay]].map(([px, py, qx, qy]) => {
          const swap = px > qx || (px === qx && py > qy);
          const Px = swap ? qx : px, Py = swap ? qy : py, dx = swap ? px - qx : qx - px, dy = swap ? py - qy : qy - py;
          const mult = swap ? -s : s;
          return [Px, Py, dx, dy, mult, mult > 0 ? topLeft(dx, dy) : topLeft(-dx, -dy)];
        });
        const zA = P[3 * iA + a], zB = P[3 * iB + a], zC = P[3 * iC + a];
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            let ok = true;
            const w = [0, 0, 0];
            for (let e = 0; e < 3; e++) {
              const [Px, Py, dx, dy, mult, tl] = E[e];
              const val = mult * (dx * (y - Py) - dy * (x - Px));
              if (val < 0 || (val === 0 && !tl)) { ok = false; break; }
              w[e] = val;
            }
            if (!ok) continue;
            const ray = x + nb * y;
            if (pass === 0) counts[ray]++;
            else {
              const ws = w[0] + w[1] + w[2];
              depths[fillPos[ray]++] = (w[1] * zA + w[2] * zB + w[0] * zC) / ws;  // w[e] weights the opposite vertex
            }
          }
        }
      }
      if (pass === 0) {
        let sum = 0;
        for (let r = 0; r < nb * nc; r++) { const k = counts[r]; counts[r] = sum; fillPos[r] = sum; sum += k; }
        counts[nb * nc] = sum;
        depths = new Float64Array(sum);
      }
    }
    let oddRays = 0;
    for (let y = 0; y < nc; y++) {
      for (let x = 0; x < nb; x++) {
        const ray = x + nb * y, s0 = counts[ray], s1 = counts[ray + 1];
        const hits = depths.subarray(s0, s1).sort();
        const isOdd = (s1 - s0) & 1;
        oddRays += isOdd;
        let q = 0;
        const base = x * stride[b] + y * stride[c];
        for (let m = 0; m < na; m++) {
          const z = bmin[a] + m * h;
          while (q < hits.length && hits[q] < z) q++;
          const idx = base + m * stride[a];
          inside[a][idx] = q & 1;
          odd[a][idx] = isOdd;
        }
      }
    }
    stats.push({ axis: "xyz"[a], rays: nb * nc, hits: counts[nb * nc], oddRays });
  }
  return { inside, odd, stats };
}

/** Combines the three parities into one sign per voxel (1 = inside) and fixes sign errors that contradict the
 *  unsigned distances. */
function resolveSign(dist, par, grid) {
  const N = grid.count, inside = new Uint8Array(N);
  let disagree = 0, tieFallback = 0;
  for (let i = 0; i < N; i++) {
    const r0 = par.inside[0][i], r1 = par.inside[1][i], r2 = par.inside[2][i];
    if (r0 !== r1 || r1 !== r2) disagree++;
    let yes = 0, no = 0;
    for (let a = 0; a < 3; a++) if (!par.odd[a][i]) { if (par.inside[a][i]) yes++; else no++; }
    if (yes !== no) inside[i] = yes > no ? 1 : 0;
    else { inside[i] = r0 + r1 + r2 >= 2 ? 1 : 0; tieFallback++; }
  }
  const flips = cleanupSign(dist, inside, grid);
  return { inside, disagree, tieFallback, flips };
}

/** Two voxels a, b of opposite sign need a surface between them, i.e. d_a + d_b ≤ |a − b|. A voxel that violates
 *  this with more of its 26 neighbours than it satisfies it (same sign, d_a + d_b > |a − b|) is flipped; Jacobi
 *  sweeps until stable. Only touches voxels that are provably inconsistent, so correct thin features survive. */
export function cleanupSign(dist, inside, grid) {
  const [nx, ny, nz] = grid.n, h = grid.h;
  const offs = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx || dy || dz) offs.push([dx, dy, dz, dx + nx * (dy + ny * dz), Math.hypot(dx, dy, dz) * h * (1 + 1e-9)]);
  }
  let total = 0;
  const flip = [];
  for (let pass = 0; pass < 64; pass++) {
    flip.length = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const idx = i + nx * (j + ny * k), s = inside[idx], d = dist[idx];
      let bad = 0, good = 0;
      for (const [dx, dy, dz, o, len] of offs) {
        const x = i + dx, y = j + dy, z = k + dz;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        if (d + dist[idx + o] <= len) continue;   // a surface may lie between them: no constraint
        if (inside[idx + o] === s) good++; else bad++;
      }
      if (bad > good) flip.push(idx);
    }
    if (!flip.length) break;
    for (const idx of flip) inside[idx] ^= 1;
    total += flip.length;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------------------
// Logos: SVG paths → extruded, chamfer-bevelled signed distance
// ---------------------------------------------------------------------------------------------------------------

const NUM = /[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** Parses one path `d` into subpaths of [x, y] points (curves flattened adaptively, `tol` in path units). */
export function flattenPath(d, tol = 0.25) {
  const tok = d.match(NUM) ?? [];
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lqx = 0, lqy = 0, prev = "";
  const subs = [];
  let cur = null;
  const num = () => {
    if (i >= tok.length || /[A-Za-z]/.test(tok[i])) throw new Error(`svg path: number expected at token ${i}`);
    return parseFloat(tok[i++]);
  };
  const lineTo = (nx, ny) => { cur.push([nx, ny]); x = nx; y = ny; };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.min(256, Math.max(4, Math.ceil(Math.sqrt(len / tol) * 1.2)));
    const x0 = x, y0 = y;
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      cur.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
    }
    x = x3; y = y3; lcx = x2; lcy = y2;
  };
  const quad = (x1, y1, x2, y2) => {
    lqx = x1; lqy = y1;
    cubic(x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2);
    lqx = x1; lqy = y1;
  };
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    else if (!cmd) throw new Error("svg path: data must start with a command");
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === "A") throw new Error("svg path: arcs (A) are not supported — convert them to curves");
    if (C === "Z") {
      if (cur) { cur.push([sx, sy]); x = sx; y = sy; }
      cur = null; prev = "Z";
      continue;
    }
    if (C === "M") {
      const nx = num() + ox, ny = num() + oy;
      cur = [[nx, ny]]; subs.push(cur); x = sx = nx; y = sy = ny;
      cmd = rel ? "l" : "L"; prev = "M";                       // implicit lineto for further pairs
      continue;
    }
    if (!cur) { cur = [[x, y]]; subs.push(cur); sx = x; sy = y; }
    if (C === "L") lineTo(num() + ox, num() + oy);
    else if (C === "H") lineTo(num() + ox, y);
    else if (C === "V") lineTo(x, num() + oy);
    else if (C === "C") cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy);
    else if (C === "S") {
      const [rx, ry] = prev === "C" || prev === "S" ? [2 * x - lcx, 2 * y - lcy] : [x, y];
      cubic(rx, ry, num() + ox, num() + oy, num() + ox, num() + oy);
    } else if (C === "Q") quad(num() + ox, num() + oy, num() + ox, num() + oy);
    else if (C === "T") {
      const [rx, ry] = prev === "Q" || prev === "T" ? [2 * x - lqx, 2 * y - lqy] : [x, y];
      quad(rx, ry, num() + ox, num() + oy);
    } else throw new Error(`svg path: unknown command ${cmd}`);
    prev = C;
  }
  return subs.filter((s) => s.length >= 2);
}

/** Reads the filled paths of an SVG file: { subpaths, evenOdd, bbox }. Every <path> counts as filled. */
export function readSvgShape(file) {
  return svgShape(fs.readFileSync(file, "utf8"), file);
}

/** The filled paths of an SVG document (`src`: its text; `file`: its name, for error messages). */
export function svgShape(src, file) {
  if (/\btransform\s*=/.test(src)) throw new Error(`${file}: transforms are not supported (flatten them first)`);
  const paths = [...src.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
  if (!paths.length) throw new Error(`${file}: no <path> elements`);
  const subpaths = [];
  let evenOdd = null;
  for (const p of paths) {
    const d = /\sd\s*=\s*"([^"]*)"/.exec(p)?.[1];
    if (!d) continue;
    const fr = /\s(?:fill-rule|clip-rule)\s*=\s*"(\w+)"/.exec(p)?.[1] ?? "nonzero";
    const eo = fr === "evenodd";
    if (evenOdd !== null && evenOdd !== eo) throw new Error(`${file}: mixed fill rules are not supported`);
    evenOdd = eo;
    subpaths.push(...flattenPath(d));
  }
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const s of subpaths) for (const [px, py] of s) {
    lo[0] = Math.min(lo[0], px); lo[1] = Math.min(lo[1], py); hi[0] = Math.max(hi[0], px); hi[1] = Math.max(hi[1], py);
  }
  return { subpaths, evenOdd: !!evenOdd, bbox: { lo, hi } };
}

/**
 * Bakes the extruded SDF on a grid. `shape` from readSvgShape; `opts` = { cells, thickness, bevel } in units of the
 * artwork's longest side. Returns { grid, values } like the mesh bake (values via `quantise`). `onGrid`, when given,
 * sees the grid before any voxel is computed (and may throw to refuse it).
 */
export function bakeExtrusion(shape, opts, quantise, PAD, onGrid) {
  const { lo, hi } = shape.bbox;
  const ext2 = [hi[0] - lo[0], hi[1] - lo[1]], scale = 1 / Math.max(...ext2);
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  const t = opts.thickness / 2, c = opts.bevel, cells = opts.cells, h = Math.fround(1 / cells);
  const extent = [ext2[0] * scale, ext2[1] * scale, opts.thickness];
  const n = extent.map((e) => Math.max(1, Math.ceil(e * cells - 1e-6)) + 2 * PAD);
  const bmin = n.map((k) => Math.fround(-((k - 1) / 2) * h));
  const grid = { n, bmin, h, count: n[0] * n[1] * n[2] };
  if (onGrid) onGrid(grid);
  // segments in the object frame (y flipped)
  const seg = [];
  for (const s of shape.subpaths) for (let k = 0; k + 1 < s.length; k++) {
    const ax = (s[k][0] - cx) * scale, ay = -(s[k][1] - cy) * scale, bx = (s[k + 1][0] - cx) * scale, by = -(s[k + 1][1] - cy) * scale;
    if (ax !== bx || ay !== by) seg.push(ax, ay, bx, by);
  }
  const nSeg = seg.length / 4, [nx, ny, nz] = n;
  const d2 = new Float64Array(nx * ny);
  const xs = [];
  for (let j = 0; j < ny; j++) {
    const py = bmin[1] + j * h;
    // crossings of the row with every segment (half-open in y), with winding direction
    xs.length = 0;
    for (let q = 0; q < nSeg; q++) {
      const ay = seg[4 * q + 1], by = seg[4 * q + 3];
      if ((ay <= py) === (by <= py)) continue;
      const ax = seg[4 * q], bx = seg[4 * q + 2];
      xs.push([ax + (py - ay) / (by - ay) * (bx - ax), by > ay ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let p = 0, wind = 0, cross = 0;
    for (let i = 0; i < nx; i++) {
      const px = bmin[0] + i * h;
      while (p < xs.length && xs[p][0] < px) { wind += xs[p][1]; cross++; p++; }
      const inside = shape.evenOdd ? (cross & 1) === 1 : wind !== 0;
      let best = Infinity;
      for (let q = 0; q < nSeg; q++) {
        const ax = seg[4 * q], ay = seg[4 * q + 1], ex = seg[4 * q + 2] - ax, ey = seg[4 * q + 3] - ay;
        const wx = px - ax, wy = py - ay;
        const u = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
        const dx = wx - u * ex, dy = wy - u * ey, dd = dx * dx + dy * dy;
        if (dd < best) best = dd;
      }
      d2[i + nx * j] = inside ? -Math.sqrt(best) : Math.sqrt(best);
    }
  }
  const values = new Uint16Array(grid.count);
  for (let k = 0; k < nz; k++) {
    const dz = Math.abs(bmin[2] + k * h) - t;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = d2[i + nx * j];
      const box = Math.hypot(Math.max(a, 0), Math.max(dz, 0)) + Math.min(Math.max(a, dz), 0);
      const d = c > 0 ? Math.max(box, (a + dz + c) * Math.SQRT1_2) : box;
      values[i + nx * (j + ny * k)] = quantise(d);
    }
  }
  return { grid, values, extent, segments: nSeg, scale };
}

// ---------------------------------------------------------------------------------------------------------------
// Baking, file I/O, verification
// ---------------------------------------------------------------------------------------------------------------

/** The file for a baked grid: { raw (header + payload), gz (the .sdf file: raw, gzip level 9) }. `pose` = [pitch, yaw]. */
export function encodeSdf(grid, values, triangles, pose = [0, 0]) {
  const raw = Buffer.alloc(HEADER_BYTES + 2 * grid.count);
  raw.write("HSDF", 0, "ascii");
  raw.writeUInt32LE(FORMAT_VERSION, 4);
  grid.n.forEach((v, i) => raw.writeUInt32LE(v, 8 + 4 * i));
  grid.bmin.forEach((v, i) => raw.writeFloatLE(v, 20 + 4 * i));
  raw.writeFloatLE(grid.h, 32);
  raw.writeFloatLE(pose[0], 36);
  raw.writeFloatLE(pose[1], 40);
  raw.writeUInt32LE(ENCODING_HALF, 44);
  raw.writeUInt32LE(triangles, 48);
  for (let i = 0; i < grid.count; i++) raw.writeUInt16LE(values[i], HEADER_BYTES + 2 * i);
  const gz = zlib.gzipSync(raw, { level: 9 });   // gzip header: mtime 0, no name
  gz[9] = 3;                                      // OS byte pinned to "Unix" (zlib writes its build's OS code)
  return { raw, gz };
}

/** Decodes and validates an .sdf file; returns header + decoded distances (Float32Array). Throws an SdfError that
 *  names the first thing that is wrong. Checks everything this baker guarantees and everything holospot's loader
 *  (parseSdf in engine/physics/volume.ts) requires. */
export function decodeSdf(fileBuf, label) {
  const bad = (msg) => { throw new SdfError(`${label}: ${msg}`); };
  let raw;
  try { raw = zlib.gunzipSync(fileBuf, { maxOutputLength: HEADER_BYTES + 2 * LOADER_MAX_VOXELS }); } catch (err) {
    bad(err?.code === "ERR_BUFFER_TOO_LARGE" ? `decompresses to more than holospot loads (192³ = ${LOADER_MAX_VOXELS} voxels)` : "not a gzip file, or a truncated one (a subject is gzip-compressed)");
  }
  if (raw.length < HEADER_BYTES || raw.toString("ascii", 0, 4) !== "HSDF") bad("bad magic: the decompressed data does not start with \"HSDF\"");
  const hdr = {
    version: raw.readUInt32LE(4), n: [raw.readUInt32LE(8), raw.readUInt32LE(12), raw.readUInt32LE(16)],
    bmin: [raw.readFloatLE(20), raw.readFloatLE(24), raw.readFloatLE(28)], h: raw.readFloatLE(32),
    basePitchDeg: raw.readFloatLE(36), baseYawDeg: raw.readFloatLE(40), encoding: raw.readUInt32LE(44),
    triangles: raw.readUInt32LE(48),
  };
  if (hdr.version !== FORMAT_VERSION) bad(`format version ${hdr.version} (this tool and holospot read version ${FORMAT_VERSION})`);
  if (hdr.encoding !== ENCODING_HALF) bad(`encoding ${hdr.encoding} (only ${ENCODING_HALF}, half floats, exists)`);
  for (let o = 52; o < 64; o++) if (raw[o] !== 0) bad("reserved header bytes are not zero");
  // models use h = 1/122 and logos 1/320 unless --cells said otherwise
  const cells = Math.round(1 / hdr.h);
  if (hdr.h !== Math.fround(1 / cells) || cells < MIN_CELLS || cells > MAX_CELLS) bad(`h ${hdr.h} is not 1/cells`);
  if (Math.max(...hdr.n) !== cells + 2 * PAD || Math.min(...hdr.n) < 2 * PAD + 1) bad(`dims ${hdr.n.join("×")}`);
  hdr.n.forEach((k, i) => {
    if (hdr.bmin[i] !== Math.fround(-((k - 1) / 2) * hdr.h)) bad(`bmin.${"xyz"[i]} not centred`);
  });
  const count = hdr.n[0] * hdr.n[1] * hdr.n[2];
  // holospot's loader: at most 192³ voxels and 512 per axis, a finite pose within ±180° (pitch) and ±360° (yaw)
  if (count > LOADER_MAX_VOXELS || Math.max(...hdr.n) > LOADER_MAX_DIM) bad(`${hdr.n.join("×")} = ${count} voxels, more than holospot loads (192³ = ${LOADER_MAX_VOXELS})`);
  if (!(Math.abs(hdr.basePitchDeg) <= 180) || !(Math.abs(hdr.baseYawDeg) <= 360)) bad(`default pose pitch ${hdr.basePitchDeg}°, yaw ${hdr.baseYawDeg}° is out of range`);
  if (raw.length !== HEADER_BYTES + 2 * count) bad(`payload ${raw.length - HEADER_BYTES} bytes, expected ${2 * count}`);
  const field = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = halfToFloat(raw.readUInt16LE(HEADER_BYTES + 2 * i));
    if (!(Math.abs(v) <= 1)) bad(`voxel ${i} holds ${v}`);
    field[i] = v;
  }
  // The padding shell must be outside (positive) everywhere.
  const [nx, ny, nz] = hdr.n;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i && j && k && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
    if (!(field[i + nx * (j + ny * k)] > 0)) bad(`border voxel (${i},${j},${k}) is not outside`);
  }
  return { hdr, field, raw };
}

/** Trilinear sample of a decoded field at an object-space point (clamped to the grid, like CLAMP_TO_EDGE). */
export function sampleField(field, hdr, x, y, z) {
  const [nx, ny, nz] = hdr.n, h = hdr.h;
  let gx = (x - hdr.bmin[0]) / h, gy = (y - hdr.bmin[1]) / h, gz = (z - hdr.bmin[2]) / h;
  gx = Math.min(Math.max(gx, 0), nx - 1); gy = Math.min(Math.max(gy, 0), ny - 1); gz = Math.min(Math.max(gz, 0), nz - 1);
  const i = Math.min(Math.floor(gx), nx - 2), j = Math.min(Math.floor(gy), ny - 2), k = Math.min(Math.floor(gz), nz - 2);
  const fx = gx - i, fy = gy - j, fz = gz - k, o = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
  const c00 = field[o] + (field[o + 1] - field[o]) * fx, c10 = field[o + sy] + (field[o + sy + 1] - field[o + sy]) * fx;
  const c01 = field[o + sz] + (field[o + sz + 1] - field[o + sz]) * fx;
  const c11 = field[o + sz + sy] + (field[o + sz + sy + 1] - field[o + sz + sy]) * fx;
  const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}

/** Half-float codec self-test (RNE ties, subnormals, round-down band). */
function selfTestHalf() {
  const cases = [[0, 0], [1, 0x3c00], [-2, 0xc000], [65504, 0x7bff], [65520, 0x7c00], [2 ** -24, 0x0001],
    [2 ** -25, 0x0000], [3 * 2 ** -25, 0x0002], [2 ** -14, 0x0400], [1 + 2 ** -11, 0x3c00], [1 + 3 * 2 ** -11, 0x3c02],
    [0.1, 0x2e66], [(1023.5 / 1024) * 2 ** -14, 0x0400]];
  for (const [v, bits] of cases) if (halfFromFloat(v) !== bits) throw new Error(`halfFromFloat(${v}) = ${halfFromFloat(v).toString(16)}, expected ${bits.toString(16)}`);
  for (let b = 0; b < 0x7c00; b++) if (halfFromFloat(halfToFloat(b)) !== b) throw new Error(`half round trip failed for ${b}`);
  for (const d of [0.019, 0.02, 0.0213, 0.3, -0.77, 1, 5]) {
    const q = halfToFloat(quantiseDistance(d)), a = Math.min(Math.abs(d), 1);
    if (Math.sign(q) !== Math.sign(d) || Math.abs(q) > a * (1 + 2 ** -11) || Math.abs(q) < a * (1 - 1 / 64) - 1e-12) throw new Error(`quantiseDistance(${d}) = ${q}`);
    if (a >= EXACT_BAND && Math.abs(q) > a) throw new Error(`quantiseDistance(${d}) rounds up`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Previews (rendered from the decoded file)
// ---------------------------------------------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** Minimal RGB8 PNG encoder (filter 0, zlib). */
export function encodePng(w, h, rgb) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = Buffer.alloc(h * (1 + 3 * w));
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * 3 * w, 3 * w).copy(rows, y * (1 + 3 * w) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export const VIEWS = {
  front: { fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },     // from +z
  right: { fwd: [-1, 0, 0], right: [0, 0, -1], up: [0, 1, 0] },    // from +x
  top: { fwd: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1] },      // from +y, front (+z) at the bottom
};
const BG = [26, 30, 38];

/** Orthographic sphere-traced render of the decoded grid (trilinear), Lambert from upper-left-front + ambient. */
export function renderView(dec, view, size = 256, halfWidth = 0.58) {
  const { hdr, field } = dec, img = new Uint8Array(size * size * 3);
  const lo = hdr.bmin, hi = hdr.bmin.map((b, i) => b + (hdr.n[i] - 1) * hdr.h);
  const Lc = norm3([-0.5, 0.6, 0.62]);                               // camera space: left, up, toward the camera
  const L = [0, 1, 2].map((i) => view.right[i] * Lc[0] + view.up[i] * Lc[1] - view.fwd[i] * Lc[2]);
  const S = (p) => sampleField(field, hdr, p[0], p[1], p[2]);
  const e = hdr.h * 0.5;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sx = ((px + 0.5) / size * 2 - 1) * halfWidth, sy = (1 - (py + 0.5) / size * 2) * halfWidth;
      const o = [0, 1, 2].map((i) => view.right[i] * sx + view.up[i] * sy - view.fwd[i] * 2);
      const d = view.fwd;
      let t0 = -Infinity, t1 = Infinity;
      for (let i = 0; i < 3; i++) {
        if (d[i] === 0) { if (o[i] < lo[i] || o[i] > hi[i]) t0 = Infinity; continue; }
        const a = (lo[i] - o[i]) / d[i], b = (hi[i] - o[i]) / d[i];
        t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
      }
      let col = BG;
      if (t0 < t1) {
        let t = t0, hit = false;
        for (let step = 0; step < 600 && t <= t1; step++) {
          const dist = S([o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
          if (dist < 2e-4) { hit = true; break; }
          t += Math.max(dist * 0.9, 1e-4);
        }
        if (hit) {
          const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
          const g = [0, 1, 2].map((i) => {
            const a = p.slice(), b = p.slice();
            a[i] += e; b[i] -= e;
            return S(a) - S(b);
          });
          const nrm = Math.hypot(...g) > 0 ? norm3(g) : [0, 0, 0];
          const lum = 0.2 + 0.8 * Math.max(0, dot3(nrm, L));
          const v = Math.round(Math.min(1, lum) * 235);
          col = [v, v, v];
        }
      }
      img.set(col, 3 * (py * size + px));
    }
  }
  return img;
}

/** Mid-z slice: inside dark, outside light, alternating 0.025 distance bands; +y up, upscaled ×2. */
function renderSlice(dec) {
  const { hdr, field } = dec, [nx, ny, nz] = hdr.n, k = Math.floor(nz / 2), S = 2;
  const w = nx * S, h = ny * S, img = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = Math.floor(x / S), j = ny - 1 - Math.floor(y / S), d = field[i + nx * (j + ny * k)];
    const band = Math.floor(Math.abs(d) / 0.025) & 1 ? 18 : 0;
    const v = d < 0 ? [40 + band, 44 + band, 60 + band] : [215 - band, 212 - band, 200 - band];
    img.set(v, 3 * (y * w + x));
  }
  return { w, h, img };
}

function writePreviews(dir, name, dec) {
  fs.mkdirSync(dir, { recursive: true });
  const size = 256, gap = 4, panels = [];
  for (const [label, view] of Object.entries(VIEWS)) {
    const img = renderView(dec, view, size);
    fs.writeFileSync(path.join(dir, `${name}-${label}.png`), encodePng(size, size, img));
    panels.push(img);
  }
  const sl = renderSlice(dec);
  fs.writeFileSync(path.join(dir, `${name}-slice.png`), encodePng(sl.w, sl.h, sl.img));
  // Slice fitted into a size×size panel (nearest), then the contact sheet.
  const fit = new Uint8Array(size * size * 3), sc = Math.max(sl.w, sl.h) / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ox = Math.floor((x - (size - sl.w / sc) / 2) * sc), oy = Math.floor((y - (size - sl.h / sc) / 2) * sc);
    fit.set(ox >= 0 && oy >= 0 && ox < sl.w && oy < sl.h ? sl.img.subarray(3 * (oy * sl.w + ox), 3 * (oy * sl.w + ox) + 3) : BG, 3 * (y * size + x));
  }
  panels.push(fit);
  const W = panels.length * size + (panels.length - 1) * gap, sheet = new Uint8Array(W * size * 3).fill(90);
  panels.forEach((p, n) => {
    for (let y = 0; y < size; y++) sheet.set(p.subarray(3 * y * size, 3 * (y + 1) * size), 3 * (y * W + n * (size + gap)));
  });
  fs.writeFileSync(path.join(dir, `${name}-sheet.png`), encodePng(W, size, sheet));
}

// ---------------------------------------------------------------------------------------------------------------
// Baking a model or a logo
// ---------------------------------------------------------------------------------------------------------------

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
const NO_INSIDE = "  warning: no voxel is inside the object. An open surface has no inside: close the mesh (make it watertight) and bake again.";

/** Stops a bake whose grid holospot's loader would refuse (parseSdf: at most 192³ voxels, 512 per axis). */
function checkLoadable(grid, label, hint) {
  if (grid.count > LOADER_MAX_VOXELS || Math.max(...grid.n) > LOADER_MAX_DIM) {
    throw new UsageError(`${label}: the grid would be ${grid.n.join(" × ")} = ${grid.count} voxels, more than holospot loads ` +
      `(192³ = ${LOADER_MAX_VOXELS}); ${hint}`);
  }
}

/** The rotation of a model into the object frame: --flat first (the plate's own frame), then the turns of --rotate
 *  about x, y and z. A zero angle adds no factor, so a single turn is exactly rotX / rotY / rotZ. */
function meshRotation(mesh, opts, log) {
  const [rx, ry, rz] = opts.rotate ?? [0, 0, 0];
  const turns = [];
  if (rz) turns.push(rotZ(rz));
  if (ry) turns.push(rotY(ry));
  if (rx) turns.push(rotX(rx));
  if (opts.flat) turns.push(plateRotation(mesh, log));
  return turns.length ? turns.reduce((acc, M) => matMul(acc, M)) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

/** Bakes a model. `buf`: the bytes of a .glb; `opts` = { rotate: [x, y, z] degrees, flat, cells }.
 *  Returns { grid, values (half-float bits per voxel), triangles }. */
export function bakeGlb(buf, name, opts = {}, log = () => {}) {
  const t0 = performance.now();
  const mesh = glbMesh(buf, name);
  const edges = edgeStats(mesh);
  const R = meshRotation(mesh, opts, log);
  const norm = orientAndNormalise(mesh, R);
  if (!(Math.max(...norm.sourceExtent) > 0) || !Number.isFinite(norm.scale)) throw new GlbError(`${name}: the model has no size (all its vertices are at one point)`);
  const grid = makeGrid(norm.extent, opts.cells ?? CELLS);
  checkLoadable(grid, name, "lower --cells");
  const tLoad = performance.now();
  const bvh = buildBvh(mesh.positions, mesh.indices);
  const tBvh = performance.now();
  const { dist, visits } = unsignedDistances(bvh, grid);
  const tDist = performance.now();
  const par = rayParity(mesh.positions, mesh.indices, grid);
  const sign = resolveSign(dist, par, grid);
  const tSign = performance.now();
  const values = new Uint16Array(grid.count);
  for (let i = 0; i < grid.count; i++) values[i] = quantiseDistance(sign.inside[i] ? -dist[i] : dist[i]);
  log(`  rotation ${fmtMat(R)}`);
  log(`  source AABB ${norm.sourceExtent.map((e) => e.toFixed(4)).join(" × ")} (mesh units) → scale ${norm.scale.toFixed(6)}; ` +
    `normalised extent ${norm.extent.map((e) => e.toFixed(4)).join(" × ")}`);
  log(`  mesh: ${mesh.nTris} triangles, ${mesh.nVerts} vertices (${edges.weldedVerts} welded), ${edges.edges} edges, ` +
    `${edges.boundary} boundary, ${edges.nonManifold} non-manifold`);
  if (edges.boundary) log(`  warning: the mesh is not closed (${edges.boundary} open edge${edges.boundary > 1 ? "s" : ""}). Small holes are filled by the sign vote; look at the --preview images to see what was baked.`);
  log(`  BVH ${bvh.nodes} nodes; ${(visits / grid.count).toFixed(1)} node visits per voxel`);
  log(`  sign rays: ${par.stats.map((s) => `${s.axis} ${s.rays} rays / ${s.hits} hits / ${s.oddRays} odd`).join("; ")}`);
  log(`  sign: ${sign.disagree} voxels where the axes disagree, ${sign.tieFallback} tie fallbacks, ${sign.flips} flipped by clean-up`);
  log(`  timings: load+orient ${((tLoad - t0) / 1000).toFixed(2)} s, BVH ${((tBvh - tLoad) / 1000).toFixed(2)} s, ` +
    `distance ${((tDist - tBvh) / 1000).toFixed(2)} s, sign ${((tSign - tDist) / 1000).toFixed(2)} s`);
  return { grid, values, triangles: mesh.nTris };
}

/** Bakes a logo: the artwork extruded and chamfered. `src`: the text of an .svg; `opts` = { cells, depth, bevel }
 *  (depth and bevel in units of the artwork's longest side). Returns { grid, values, triangles: 0 }. */
export function bakeSvg(src, name, opts = {}, log = () => {}) {
  const t0 = performance.now();
  const spec = { cells: opts.cells ?? SVG_CELLS, thickness: opts.depth ?? SVG_DEPTH, bevel: opts.bevel ?? SVG_BEVEL };
  let shape;
  try { shape = svgShape(src, name); } catch (err) {
    throw new SvgError(String(err.message).startsWith(`${name}:`) ? err.message : `${name}: ${err.message}`);
  }
  const { lo, hi } = shape.bbox;
  if (!shape.subpaths.length) throw new SvgError(`${name}: no outline found (every <path> needs a d="…" attribute, in double quotes, that draws at least one segment)`);
  if (!(Math.max(hi[0] - lo[0], hi[1] - lo[1]) > 0)) throw new SvgError(`${name}: the artwork has no size`);
  for (const [tag, count] of svgOtherShapes(src)) log(`  warning: ${count} <${tag}> element${count > 1 ? "s are" : " is"} not read (only <path> is); convert ${count > 1 ? "them" : "it"} to a path`);
  const out = bakeExtrusion(shape, spec, quantiseDistance, PAD, (grid) => checkLoadable(grid, name, "lower --cells or --depth"));
  log(`  svg ${name}: ${shape.subpaths.length} subpaths, ${out.segments} segments, ${shape.evenOdd ? "evenodd" : "nonzero"}; ` +
    `extent ${out.extent.map((e) => e.toFixed(4)).join(" × ")}; thickness ${spec.thickness}, chamfer ${spec.bevel}, ${spec.cells} cells`);
  log(`  timings: 2D distance + extrusion ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  return { grid: out.grid, values: out.values, triangles: 0 };
}

/** Shapes of an SVG that the reader does not read (tag, count), for a warning. */
function svgOtherShapes(src) {
  const out = [];
  for (const tag of ["rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "image", "use"]) {
    const count = src.split(`<${tag}`).slice(1).filter((rest) => /^[\s/>]/.test(rest)).length;
    if (count) out.push([tag, count]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------

const HELP = `Bakes a 3D model or a logo into a hologram subject (.sdf) for the Volume Hologram material.

  node tools/bake-hologram.mjs --in model.glb --out my.sdf [--rotate x,y,z] [--flat] [--yaw 15] [--pitch 0] [--preview out/] [--verify]
  node tools/bake-hologram.mjs --in logo.svg  --out my.sdf [--depth 0.07] [--bevel 0.008] [--yaw 0] [--pitch 0] [--preview out/] [--verify]
  node tools/bake-hologram.mjs --verify my.sdf [--preview out/]

  --in <file>      the model (.glb) or the logo (.svg)
  --out <file>     the subject to write
  --yaw <deg>      default pose stored in the file: yaw > 0 turns the front toward the viewer's right (default 0)
  --pitch <deg>    default pose stored in the file: pitch > 0 tips the top toward the viewer (default 0)
  --rotate x,y,z   model: degrees about x, then y, then z, into the frame +x right, +y up, +z toward the viewer
                   (default 0,0,0; a model that faces +x, as Tripo and Krea export: 0,-90,0)
  --flat           model: a flat plate at any angle in its file: find its plane, square its edges, raised side forward
  --depth <f>      logo: thickness as a fraction of the logo's longest side (default ${SVG_DEPTH})
  --bevel <f>      logo: 45° chamfer, same unit (default ${SVG_BEVEL}; 0 = sharp; at most depth / 2)
  --cells <n>      voxels across the longest side (default ${CELLS} for a model, ${SVG_CELLS} for a logo; ${MIN_CELLS} to ${MAX_CELLS})
  --preview <dir>  also write PNG views of the baked file: <name>-front/-right/-top/-slice/-sheet.png
  --verify         with --in: print the full report on the written file
  --verify <file>  on its own: decode and validate an existing file (exit code 0 when valid)

Limits
${GLB_LIMITS}
${SVG_LIMITS}
  holospot loads at most 192³ voxels per subject; the defaults always fit.

Use the result: holo.apply(mesh, { material: "volume", settings: { "volume.subject": "./my.sdf" } })`;

function parseArgs(argv) {
  const o = { in: null, out: null, yaw: 0, pitch: 0, rotate: null, flat: false, cells: null, depth: null, bevel: null,
    preview: null, verify: false, verifyFile: null, help: false };
  const number = (text, flag, what = "a number") => {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) throw new UsageError(`${flag} needs ${what}, got "${text}"`);
    return Number(text);
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = (what) => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") throw new UsageError(`${flag} needs ${what}`);
      return v;
    };
    if (flag === "--in") o.in = value("a file (.glb or .svg)");
    else if (flag === "--out") o.out = value("a file to write (.sdf)");
    else if (flag === "--yaw") o.yaw = number(value("degrees"), flag, "degrees");
    else if (flag === "--pitch") o.pitch = number(value("degrees"), flag, "degrees");
    else if (flag === "--rotate") {
      const parts = value("three angles: x,y,z").split(",");
      if (parts.length !== 3) throw new UsageError(`--rotate needs three angles in degrees, as x,y,z (for example 0,-90,0)`);
      o.rotate = parts.map((p) => number(p.trim(), flag, "three angles in degrees, as x,y,z"));
    } else if (flag === "--flat") o.flat = true;
    else if (flag === "--cells") o.cells = number(value("a whole number"), flag, "a whole number");
    else if (flag === "--depth") o.depth = number(value("a fraction of the logo's longest side"), flag);
    else if (flag === "--bevel") o.bevel = number(value("a fraction of the logo's longest side"), flag);
    else if (flag === "--preview") o.preview = value("a folder");
    else if (flag === "--verify") {
      o.verify = true;                           // a file may follow: `--verify my.sdf`
      const next = inline ?? (i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : null);
      if (next !== null && next !== "") o.verifyFile = next;
    } else if (flag === "--help" || flag === "-h") o.help = true;
    else throw new UsageError(`unknown argument ${argv[i]}`);
  }
  if (o.help) return o;
  if (o.verifyFile !== null) {
    if (o.in !== null || o.out !== null) throw new UsageError("--verify <file> checks an existing file and cannot be combined with --in / --out (after a bake, plain --verify reports on the file just written)");
    for (const k of ["rotate", "cells", "depth", "bevel"]) if (o[k] !== null) throw new UsageError(`--${k} has no meaning with --verify <file>`);
    if (o.flat || o.yaw || o.pitch) throw new UsageError("--flat, --yaw and --pitch have no meaning with --verify <file>");
    return o;
  }
  if (o.in === null || o.out === null) {
    throw new UsageError(o.verify && o.in === null && o.out === null ? "--verify needs the file to check" : "a bake needs both --in <model.glb | logo.svg> and --out <file.sdf>");
  }
  o.kind = inputKind(o.in);
  if (Math.abs(o.yaw) > 360) throw new UsageError(`--yaw ${o.yaw} is out of range (−360 to 360 degrees)`);
  if (Math.abs(o.pitch) > 180) throw new UsageError(`--pitch ${o.pitch} is out of range (−180 to 180 degrees)`);
  if (o.cells !== null && !(Number.isInteger(o.cells) && o.cells >= MIN_CELLS && o.cells <= MAX_CELLS)) {
    throw new UsageError(`--cells ${o.cells} is out of range (a whole number from ${MIN_CELLS} to ${MAX_CELLS})`);
  }
  if (o.kind === "svg") {
    if (o.rotate !== null || o.flat) throw new UsageError("--rotate and --flat apply to a model (.glb); a logo is used as drawn, upright and facing the viewer");
    const depth = o.depth ?? SVG_DEPTH, bevel = o.bevel ?? SVG_BEVEL;
    if (!(depth > 0 && depth <= 1)) throw new UsageError(`--depth ${depth} is out of range (above 0, at most 1: a fraction of the logo's longest side)`);
    if (!(bevel >= 0 && bevel <= depth / 2)) throw new UsageError(`--bevel ${bevel} is out of range (0 to depth / 2 = ${depth / 2})`);
  } else if (o.depth !== null || o.bevel !== null) throw new UsageError("--depth and --bevel apply to a logo (.svg); a model keeps its own shape");
  return o;
}

/** "glb" or "svg" by the file's extension; anything else is refused with the limits. */
function inputKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".glb") return "glb";
  if (ext === ".svg") return "svg";
  const why = ext === ".gltf" ? "a text .gltf keeps its geometry in external or data-URI buffers, which are not read: export a binary .glb instead"
    : `${ext ? `"${ext}" files are` : "a file without an extension is"} not read: give a .glb model or an .svg logo`;
  throw new UsageError(`${file}: ${why}\n${GLB_LIMITS}\n${SVG_LIMITS}`);
}

/** The full report on a decoded file. `gzBytes`: the size of the file on disk. */
function report(dec, gzBytes, log) {
  const { hdr, field } = dec, cells = Math.round(1 / hdr.h);
  let inside = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < field.length; i++) { const v = field[i]; if (v < 0) inside++; if (v < lo) lo = v; if (v > hi) hi = v; }
  log(`  ok   gzip container, "HSDF" header, version ${hdr.version}, encoding ${hdr.encoding} (half-float distances)`);
  log(`  ok   grid ${hdr.n.join(" × ")} = ${field.length} voxels, voxel size 1/${cells}, ${PAD} voxels of padding, centred`);
  log(`  ok   every voxel is a finite distance within ±1 (${lo.toFixed(4)} to ${hi.toFixed(4)}); the outer shell is outside the object`);
  log(`  ok   within holospot's loader limits (${field.length} of ${LOADER_MAX_VOXELS} voxels)`);
  log(`  default pose: pitch ${hdr.basePitchDeg}°, yaw ${hdr.baseYawDeg}°`);
  log(`  source: ${hdr.triangles ? `${hdr.triangles} triangles` : "no triangles (a logo or a procedural subject)"}`);
  log(`  size: ${kb(gzBytes)} on disk, ${kb(dec.raw.length)} decompressed`);
  log(`  inside the object: ${inside} voxels (${(100 * inside / field.length).toFixed(1)}%)`);
  if (!inside) log(NO_INSIDE);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  const log = (s) => console.log(s);
  const t0 = performance.now();
  selfTestHalf();
  if (o.verifyFile !== null) {
    const file = o.verifyFile, bytes = fs.readFileSync(file);
    console.log(`${file}:`);
    const dec = decodeSdf(bytes, file);
    report(dec, bytes.length, log);
    if (o.preview !== null) writePreviews(path.resolve(o.preview), path.basename(file).replace(/\.sdf$/i, ""), dec);
    console.log(`  valid (${((performance.now() - t0) / 1000).toFixed(2)} s)`);
    return;
  }
  const name = path.basename(o.in), bytes = fs.readFileSync(o.in);
  console.log(`${o.in} → ${o.out}:`);
  const baked = o.kind === "glb" ? bakeGlb(bytes, name, { rotate: o.rotate, flat: o.flat, cells: o.cells }, log)
    : bakeSvg(bytes.toString("utf8"), name, { cells: o.cells, depth: o.depth, bevel: o.bevel }, log);
  const { raw, gz } = encodeSdf(baked.grid, baked.values, baked.triangles, [o.pitch, o.yaw]);
  fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
  fs.writeFileSync(`${o.out}.tmp`, gz);
  fs.renameSync(`${o.out}.tmp`, o.out);            // atomic replace: never a half-written volume
  const dec = decodeSdf(fs.readFileSync(o.out), o.out);
  if (!dec.raw.equals(raw)) throw new Error(`${o.out}: the file does not decode to the baked bytes`);
  const g = baked.grid;
  console.log(`  grid ${g.n.join(" × ")} = ${g.count} voxels, bmin ${g.bmin.map((v) => v.toFixed(5)).join(", ")}, h 1/${Math.round(1 / g.h)}`);
  console.log(`  ${o.out}: raw ${kb(raw.length)}, gzip ${kb(gz.length)}`);
  const inside = dec.field.reduce((n, v) => n + (v < 0), 0);
  console.log(`  verified ${o.out}: ${dec.hdr.n.join("×")}, ${dec.hdr.triangles} source triangles, ` +
    `${inside} inside voxels (${(100 * inside / dec.field.length).toFixed(1)}%), default pose pitch ${dec.hdr.basePitchDeg}° yaw ${dec.hdr.baseYawDeg}°`);
  if (!inside) console.log(NO_INSIDE);
  if (o.verify) report(dec, gz.length, log);
  if (o.preview !== null) writePreviews(path.resolve(o.preview), path.basename(o.out).replace(/\.sdf$/i, ""), dec);
  console.log(`  total ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  console.log(`  use it: holo.apply(mesh, { material: "volume", settings: { "volume.subject": "<the URL of ${path.basename(o.out)}>" } })`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    process.exitCode = 1;
    if (err instanceof UsageError) { console.error(`bake-hologram: ${err.message}\n  (--help lists the options)`); process.exitCode = 2; }
    else if (err instanceof GlbError) console.error(`bake-hologram: ${err.message}\n${GLB_LIMITS}`);
    else if (err instanceof SvgError) console.error(`bake-hologram: ${err.message}\n${SVG_LIMITS}`);
    else if (err instanceof SdfError) console.error(`bake-hologram: ${err.message}\n  not a valid hologram subject`);
    else if (err && typeof err.code === "string" && err.syscall) console.error(`bake-hologram: ${err.message}`);   // file system
    else console.error(`bake-hologram: ${err?.stack ?? err}`);
  }
}
