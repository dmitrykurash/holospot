// Bump maps (addendum A1.2): a grey-scale height image (luminance = height, holocloth's convention) tiled over the
// object's front surface and rendered physically, without normal-map aliasing.
//
// Physics and units
// - Height: h(u, v) ∈ [0, 1] from the image's luminance (Rec. 709 weights on the stored 8-bit values, × alpha; 1 − h
//   with `invert`), u, v ∈ [0, 1) across one tile. The relief is H·h with H = strength · BUMP_H0 · tileWidth: the height
//   scales with the tile, so slopes (what the eye sees) do not depend on `tiling` (holocloth's normal-map behaviour)
//   and `strength` scales them linearly. Tile width = U span / tiling; tile height = tile width × image aspect.
// - Slopes: a 3×3 Sobel derivative of h, wrapped (maps tile), per base texel; never derivatives at run time (§4.9).
// - LEAN moments (Olano & Baker 2010; R03 §7.4): per texel (sₓ, s_y, sₓ², s_y², sₓs_y), box-filtered into a mip chain
//   on the CPU (in a worker), stored as RGBA16F (sₓ, s_y, sₓ², s_y²) + R16F (sₓs_y), repeat wrap, trilinear and
//   anisotropic filtering. The shader (relief.glsl `bumpSlope`) fetches them over the pixel footprint and gets the
//   mean slope s = k ⊙ m₁ and the unresolved slope covariance Σ = k kᵀ ⊙ (m₂ − m₁m₁ᵀ), which join the board (layer
//   `foil`) or coat (layer `varnish`) relief: filtered-out slope variance widens the lobes instead of aliasing.
//   k = H · (texels per mm) per axis, so strength, tiling, invert (the sign of k) and the layer are uniforms only; the
//   moments are rebuilt only when the image changes.
// - Images larger than the 1024-texel base are analysed at up to twice the base resolution (≤ 2048) and box-reduced,
//   so the base level keeps their finer slopes as variance.
//
// Contract (addendum A1.3): bumpDial (the scene panel's `bump` folder), BUMP_PARAMS, BumpValues and BumpMaps, wired
// in by main.ts. `update()` never blocks: a map is fetched, decoded, drawn and turned into moments in a worker (an
// inline Blob worker running `bumpKernel`'s source), so the page only receives the finished levels and uploads them
// once; images a worker cannot decode (SVG) are decoded by the page, and without workers everything runs on the page.
// The last two steps are shared with the sticker wall (addendum A13.7, wall/reliefMaps.ts and wall/layer.ts): the mip
// chain of float moments (bumpKernel().levels) and the textures of a chain (momentTextures, there with clamped wrap).
// Erasable syntax only, explicit `.ts` imports and no DOM access at module level, so node --test can import the panel
// tables (via app/sceneParams.ts).
import * as THREE from "three";
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec, ParamValues, Uniforms, Vec2 } from "../types.ts";

// ---------------------------------------------------------------------------------------------------------------
// Panel (A1.2)
// ---------------------------------------------------------------------------------------------------------------

/** Built-in maps in public/bumps/ (seamless, grey-scale): the user's holocloth scratches + tools/gen-bumps.mjs. */
export const BUMP_MAPS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "/bumps/scratches.jpg", label: "Scratches" },
  { value: "/bumps/brushed.png", label: "Brushed metal" },
  { value: "/bumps/hammered.png", label: "Hammered" },
  { value: "/bumps/crinkle.png", label: "Crinkle" },
  { value: "/bumps/linen.png", label: "Linen weave" },
  { value: "/bumps/fingerprint.png", label: "Fingerprint whorl" },
  { value: "/bumps/sandblast.png", label: "Sandblast" },
];
export const BUMP_DEFAULT_MAP = "/bumps/scratches.jpg";

/**
 * Height of luminance 1 at strength 1, as a fraction of the tile width (dimensionless). 0.0028 is 59 µm over the
 * 21 mm tile of the card at tiling 3. It puts the holocloth scratches (public/bumps/scratches.jpg) at an RMS slope of
 * 1.62° over the map at strength 1 (sub-texel variance included), with the scratch walls — the steepest 1 % of
 * texels — beyond 6.2° and up to 23°; 4.8° RMS at strength 3. holocloth's own bump on this image (512² central
 * differences × 1.6 × bump) is 2.58° RMS per unit, 7.7° at its default 3, so holocloth's bump b ≈ strength 1.6·b here
 * (×1.6 on this constant would make the two sliders equal). The procedural maps of tools/gen-bumps.mjs are
 * normalised with the same constant.
 */
export const BUMP_H0 = 0.0028;

export const bumpDial = {
  map: { type: "image", options: BUMP_MAPS.map((o) => ({ value: o.value, label: o.label })), default: BUMP_DEFAULT_MAP },
  strength: [1, 0, 3, 0.01],
  tiling: [3, 1, 12, 0.5],
  layer: {
    type: "select",
    options: [
      { value: "foil", label: "Embossed foil (bends the grating)" },
      { value: "varnish", label: "Textured varnish (coat only)" },
    ],
    default: "foil",
  },
  invert: false,
} satisfies DialConfig;

/** One ParamSpec per control of `bumpDial` (ids = URL keys = the scene panel's dot paths). */
export const BUMP_PARAMS: readonly ParamSpec[] = [
  { id: "bump.map", path: "bump.map", kind: "image", default: BUMP_DEFAULT_MAP, options: BUMP_MAPS.map((o) => o.value), unit: "—",
    meaning: "Height image (luminance = height): a built-in map, an uploaded image or none (URL: scratches, brushed, …, a same-origin path, none)",
    uniform: "uBumpMom" },
  { id: "bump.strength", path: "bump.strength", kind: "slider", default: 1, min: 0, max: 3, step: 0.01, unit: "—",
    meaning: "Relief height = strength × H₀ (holocloth's bump); slopes scale linearly, 0 switches the map off", uniform: "uBumpK" },
  { id: "bump.tiling", path: "bump.tiling", kind: "slider", default: 3, min: 1, max: 12, step: 0.5, unit: "—",
    meaning: "Repeats of the map across the object's U span (holocloth's bumpTiling); the slopes do not change", uniform: "uBumpScale" },
  { id: "bump.layer", path: "bump.layer", kind: "select", default: "foil", options: ["foil", "varnish"], unit: "—",
    meaning: "Embossed foil (the stack bends: diffraction and mirror deflect) or a textured varnish (coat only)", uniform: "uBumpMode" },
  { id: "bump.invert", path: "bump.invert", kind: "toggle", default: false, unit: "—",
    meaning: "Height = 1 − luminance (ridges instead of grooves)", uniform: "uBumpK" },
];

export interface BumpValues { map: string; strength: number; tiling: number; layer: "foil" | "varnish"; invert: boolean }

/** BumpValues from flat panel values (ParamSpec ids), with the defaults for anything missing or malformed. */
export function bumpValuesOf(v: ParamValues): BumpValues {
  const num = (id: string, d: number) => { const x = v[id]; return typeof x === "number" && Number.isFinite(x) ? x : d; };
  return {
    map: typeof v["bump.map"] === "string" ? (v["bump.map"] as string) : BUMP_DEFAULT_MAP,
    strength: Math.max(num("bump.strength", 1), 0),
    tiling: Math.max(num("bump.tiling", 3), 0.01),
    layer: v["bump.layer"] === "varnish" ? "varnish" : "foil",
    invert: v["bump.invert"] === true,
  };
}

/** The URL a map value loads from: built-in names (`scratches`) resolve to their path; "", "none" → null. */
export function bumpMapUrl(map: string): string | null {
  const s = map.trim();
  if (s === "" || s.toLowerCase() === "none") return null;
  const named = BUMP_MAPS.find((o) => mapName(o.value) === s.toLowerCase());
  return named ? named.value : s;
}
/** The file stem of a built-in map path ("/bumps/scratches.jpg" → "scratches"). */
export function mapName(path: string): string {
  const f = path.split(/[?#]/)[0].split("/").pop() ?? "";
  return f.replace(/\.[^.]*$/, "").toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------
// Uniform values (pure; A1.2 "strength and tiling only change uniforms")
// ---------------------------------------------------------------------------------------------------------------

/** Which parametric directions of the object close on themselves (closed objects: the U seam; a torus also V). */
export interface BumpWrap { u: boolean; v: boolean }
const NO_WRAP: BumpWrap = { u: false, v: false };

/** Dimensions of a built map: base level texels and the image aspect (height / width). */
export interface BumpMapDims { nw: number; nh: number; aspect: number }

export interface BumpUniformValues {
  mode: 0 | 1 | 2;                 // uBumpMode: 0 off, 1 foil (board relief), 2 varnish (coat relief)
  scale: [number, number];         // uBumpScale: tile coordinates per mm
  k: [number, number];             // uBumpK: slope [mm/mm] per moment unit (∂h per base texel); sign = invert
  tileMm: [number, number];        // tile size [mm]
  heightMm: number;                // H: relief height of luminance 1 [mm]
}

/**
 * Uniform values of a map with dimensions `d` on a surface whose parameter domain is `domainMm` (U × V mm). With
 * `wrap.u` the number of tiles across U is rounded to an integer (a seamless closed object); with `wrap.v` the tile
 * height is stretched to an integer number of tiles across V.
 */
export function bumpUniformValues(v: BumpValues, domainMm: Vec2, d: BumpMapDims | null, wrap: BumpWrap = NO_WRAP): BumpUniformValues {
  const du = Math.max(domainMm.x, 1e-3), dv = Math.max(domainMm.y, 1e-3);
  const tiling = Math.max(Number.isFinite(v.tiling) ? v.tiling : 3, 0.01);
  const tx = wrap.u ? du / Math.max(1, Math.round(tiling)) : du / tiling;
  let ty = tx * (d ? d.aspect : 1);
  if (wrap.v) ty = dv / Math.max(1, Math.round(dv / ty));
  const strength = Math.max(Number.isFinite(v.strength) ? v.strength : 0, 0);
  const H = strength * BUMP_H0 * tx, sign = v.invert ? -1 : 1;
  const on = d !== null && strength > 0;
  return {
    mode: on ? (v.layer === "varnish" ? 2 : 1) : 0,
    scale: [1 / tx, 1 / ty],
    k: on ? [sign * H * d.nw / tx, sign * H * d.nh / ty] : [0, 0],
    tileMm: [tx, ty],
    heightMm: H,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The moment builder. Self-contained (no reference outside its own body): its source text is the worker's code, so
// it must survive Function.prototype.toString after bundling and minification.
// ---------------------------------------------------------------------------------------------------------------

export interface BumpLevel { w: number; h: number; mom: Uint16Array; cross: Uint16Array }
export interface BumpBuild {
  levels: BumpLevel[];             // base first, down to 1 × 1; half-float bits
  rms: number;                     // RMS slope magnitude of the base level [∂h per base texel] (incl. sub-texel variance)
  p99: number;                     // 99th percentile of |m₁| at the base level [∂h per base texel]
}

/** The builder: `build(rgba, aw, ah, nw, nh)` turns an aw × ah RGBA8 image into the moment mip chain of an nw × nh base
 *  (aw/nw, ah/nh ∈ {1, 2}); `levels(moments, nw, nh)` is its last step on its own — the float moments of a base level
 *  (5 per texel: sₓ, s_y, sₓ², s_y², sₓs_y, row 0 = the bottom) box-filtered into the mip chain as half floats — so a
 *  caller that computes its moments otherwise (the sticker wall's float height fields, wall/reliefMaps.ts) gets the same
 *  levels; `sizes(w, h)` picks those sizes for a w × h image; `pixels(src, aw, ah)` draws an image source at the
 *  analysis size and reads it back. */
export function bumpKernel(): {
  build(px: ArrayLike<number>, aw: number, ah: number, nw: number, nh: number): BumpBuild;
  levels(moments: Float32Array, nw: number, nh: number): BumpLevel[];
  sizes(w: number, h: number): { nw: number; nh: number; aw: number; ah: number };
  pixels(src: CanvasImageSource, aw: number, ah: number): Uint8ClampedArray;
  half(x: number): number;
} {
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  // float32 bits → IEEE half bits, round half up, finite values clamped to ±65504
  function halfBits(b: number): number {
    const s = (b >>> 16) & 0x8000, e = (b >>> 23) & 0xff, m = b & 0x7fffff;
    if (e === 0xff) return s | 0x7c00 | (m !== 0 ? 0x200 : 0);
    const E = e - 112;
    if (E >= 31) return s | 0x7bff;
    if (E <= 0) {
      if (E < -10) return s;
      const sh = 14 - E;
      return s | (((m | 0x800000) + (1 << (sh - 1))) >> sh);
    }
    return s | Math.min((E << 10) + ((m + 0x1000) >> 13), 0x7bff);
  }
  function half(x: number): number { f32[0] = x; return halfBits(u32[0]); }
  // base (≤ 1024, powers of two, aspect kept) and analysis (2× the base where the image has ≥ 1.5× its resolution) sizes
  function sizes(w: number, h: number): { nw: number; nh: number; aw: number; ah: number } {
    const pot = (x: number) => Math.pow(2, Math.round(Math.log2(Math.max(x, 1))));
    const s = Math.min(1, 1024 / Math.max(w, h, 1));
    const nw = Math.min(1024, Math.max(16, pot(w * s))), nh = Math.min(1024, Math.max(16, pot(h * s)));
    return { nw, nh, aw: w >= 1.5 * nw ? 2 * nw : nw, ah: h >= 1.5 * nh ? 2 * nh : nh };
  }
  function pixels(src: CanvasImageSource, aw: number, ah: number): Uint8ClampedArray {
    let g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (typeof OffscreenCanvas !== "undefined") g = new OffscreenCanvas(aw, ah).getContext("2d", { willReadFrequently: true });
    else {
      const c = document.createElement("canvas");
      c.width = aw; c.height = ah;
      g = c.getContext("2d", { willReadFrequently: true });
    }
    if (!g) throw new Error("no 2D canvas context");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, aw, ah);
    return g.getImageData(0, 0, aw, ah).data;
  }
  function build(px: ArrayLike<number>, aw: number, ah: number, nw: number, nh: number): BumpBuild {
    // 1. heights in GL row order (row 0 = the image's bottom row, so the map shows upright on the card)
    const h = new Float32Array(aw * ah);
    for (let y = 0; y < ah; y++) {
      const s = (ah - 1 - y) * aw * 4, d = y * aw;
      for (let x = 0; x < aw; x++) {
        const i = s + 4 * x;
        h[d + x] = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) * px[i + 3] * (1 / 65025);
      }
    }
    // 2. wrapped Sobel slopes per base texel; moments (sₓ, s_y, sₓ², s_y², sₓs_y) interleaved, box-reduced from the
    //    analysis to the base resolution
    const fx = Math.max(1, Math.round(aw / nw)), fy = Math.max(1, Math.round(ah / nh)), n = nw * nh;
    const cur = new Float32Array(5 * n);
    const kx = fx / 8, ky = fy / 8;
    for (let y = 0; y < ah; y++) {
      const rm = ((y + ah - 1) % ah) * aw, r0 = y * aw, rp = ((y + 1) % ah) * aw, row = ((y / fy) | 0) * nw;
      for (let x = 0; x < aw; x++) {
        const xm = x === 0 ? aw - 1 : x - 1, xp = x === aw - 1 ? 0 : x + 1;
        const gx = (h[rm + xp] + 2 * h[r0 + xp] + h[rp + xp] - h[rm + xm] - 2 * h[r0 + xm] - h[rp + xm]) * kx;
        const gy = (h[rp + xm] + 2 * h[rp + x] + h[rp + xp] - h[rm + xm] - 2 * h[rm + x] - h[rm + xp]) * ky;
        const o = 5 * (row + ((x / fx) | 0));
        cur[o] += gx; cur[o + 1] += gy; cur[o + 2] += gx * gx; cur[o + 3] += gy * gy; cur[o + 4] += gx * gy;
      }
    }
    const inv = 1 / (fx * fy);
    let s2 = 0, mx = 0;
    for (let i = 0; i < 5 * n; i++) cur[i] *= inv;
    for (let i = 0; i < n; i++) {
      const o = 5 * i, sx = cur[o], sy = cur[o + 1];
      s2 += cur[o + 2] + cur[o + 3];
      mx = Math.max(mx, Math.sqrt(sx * sx + sy * sy));
    }
    const hist = new Uint32Array(1024), hs = 1023 / (mx || 1);
    for (let i = 0; i < n; i++) { const sx = cur[5 * i], sy = cur[5 * i + 1]; hist[Math.min(1023, (Math.sqrt(sx * sx + sy * sy) * hs) | 0)]++; }
    let p99 = mx, acc = 0;
    for (let b = 0; b < 1024; b++) { acc += hist[b]; if (acc >= 0.99 * n) { p99 = ((b + 1) / 1024) * mx; break; } }
    return { levels: levels(cur, nw, nh), rms: Math.sqrt(s2 / n), p99 };
  }
  // 3. mip chain by 2 × 2 box filtering of the float moments (GL sizes: max(1, ⌊size/2⌋)), then half floats
  function levels(moments: Float32Array, nw: number, nh: number): BumpLevel[] {
    const out: BumpLevel[] = [];
    let cur = moments, w = nw, hh = nh;
    for (;;) {
      const m = w * hh, mom = new Uint16Array(4 * m), cross = new Uint16Array(m), bits = new Uint32Array(cur.buffer, cur.byteOffset, 5 * m);
      for (let i = 0; i < m; i++) {
        const o = 5 * i, q = 4 * i;
        mom[q] = halfBits(bits[o]); mom[q + 1] = halfBits(bits[o + 1]); mom[q + 2] = halfBits(bits[o + 2]); mom[q + 3] = halfBits(bits[o + 3]);
        cross[i] = halfBits(bits[o + 4]);
      }
      out.push({ w, h: hh, mom, cross });
      if (w === 1 && hh === 1) break;
      const w2 = Math.max(1, w >> 1), h2 = Math.max(1, hh >> 1), sx = w > 1 ? 2 : 1, sy = hh > 1 ? 2 : 1, k = 1 / (sx * sy);
      const next = new Float32Array(5 * w2 * h2);
      for (let y = 0; y < h2; y++) {
        for (let x = 0; x < w2; x++) {
          const d = 5 * (y * w2 + x);
          for (let j = 0; j < sy; j++) {
            for (let i = 0; i < sx; i++) {
              const s = 5 * ((y * sy + j) * w + x * sx + i);
              next[d] += cur[s]; next[d + 1] += cur[s + 1]; next[d + 2] += cur[s + 2]; next[d + 3] += cur[s + 3]; next[d + 4] += cur[s + 4];
            }
          }
          next[d] *= k; next[d + 1] *= k; next[d + 2] *= k; next[d + 3] *= k; next[d + 4] *= k;
        }
      }
      cur = next; w = w2; hh = h2;
    }
    return out;
  }
  return { build, levels, sizes, pixels, half };
}

let sharedKernel: ReturnType<typeof bumpKernel> | null = null;
/** Base and analysis sizes of a w × h image: powers of two, the base ≤ 1024 (aspect kept), the analysis 2× the base
 *  where the image has ≥ 1.5× its resolution (≤ 2048). */
export function bumpSizes(w: number, h: number): { nw: number; nh: number; aw: number; ah: number } {
  return (sharedKernel ??= bumpKernel()).sizes(w, h);
}

// ---------------------------------------------------------------------------------------------------------------
// BumpMaps
// ---------------------------------------------------------------------------------------------------------------

interface Loaded extends BumpMapDims { key: string; mom: THREE.DataTexture; cross: THREE.DataTexture; bytes: number; rms: number; p99: number }
/** A built map: the moments and the base size / aspect they were built for. */
interface Built extends BumpMapDims { r: BumpBuild }

/** Addition (the sticker wall, A13): the map a BumpMaps shows for its shared uniform map — its moment textures (repeat
 *  wrap), dimensions and the panel values — so wall/layer.ts can lay it over the stickers' own reliefs at the card's
 *  scale. Read only; null without a loaded map. */
export interface ShownBumpMap { key: string; mom: THREE.Texture; cross: THREE.Texture; dims: BumpMapDims; values: BumpValues }
const SHOWN = new WeakMap<Uniforms, ShownBumpMap>();
export function shownBumpMap(shared: Uniforms): ShownBumpMap | null { return SHOWN.get(shared) ?? null; }
/** A worker reply: built, or `decode` (the worker cannot decode or draw this image: the page must), or an error. */
interface WorkerReply { id: number; r?: BumpBuild; nw?: number; nh?: number; aspect?: number; decode?: boolean; error?: string }
interface WorkerJob { resolve(r: WorkerReply): void; reject(e: Error): void }
/** The worker could not start (e.g. a CSP without blob: workers) or crashed: the load is retried on the main thread. */
class WorkerLost extends Error {}

// Worker protocol. { id, url }: fetch, decode (no colour management), draw at the analysis size and build, all in the
// worker, so a load costs the page one task (plus the texture upload). { id, px, aw, ah, nw, nh, aspect }: build only
// (pixels drawn by the page). Replies { id, r, nw, nh, aspect } with the level buffers transferred, { id, decode } when
// this worker cannot decode or draw the image (SVG, no OffscreenCanvas), or { id, error }.
const WORKER_MAIN = `
function done(id, r, nw, nh, aspect) {
  const t = [];
  for (const l of r.levels) t.push(l.mom.buffer, l.cross.buffer);
  self.postMessage({ id, r, nw, nh, aspect }, t);
}
self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.url) {
      const res = await fetch(d.url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      let bmp;
      try {
        if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") throw new Error("no OffscreenCanvas");
        bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      } catch (err) {
        self.postMessage({ id: d.id, decode: true, error: String((err && err.message) || err) });
        return;
      }
      const s = K.sizes(bmp.width, bmp.height), aspect = bmp.height / bmp.width;
      const px = K.pixels(bmp, s.aw, s.ah);
      bmp.close();
      done(d.id, K.build(px, s.aw, s.ah, s.nw, s.nh), s.nw, s.nh, aspect);
    } else {
      done(d.id, K.build(new Uint8ClampedArray(d.px), d.aw, d.ah, d.nw, d.nh), d.nw, d.nh, d.aspect);
    }
  } catch (err) {
    self.postMessage({ id: d.id, error: String((err && err.message) || err) });
  }
};`;

/**
 * The bump map of the scene (addendum A1.2): owns the moment textures and drives the bump uniforms of the shared map
 * (scene/uniforms.ts creates them with a placeholder, so materials built before the first map still bind them).
 */
export class BumpMaps {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly u: Uniforms;
  private loaded: Loaded | null = null;
  private wanted: string | null = null;            // map key requested last ("" = none)
  private loadingToken = 0;                         // token of the load in flight (0: none)
  private token = 0;
  private values: BumpValues | null = null;
  private domain: Vec2 = { x: 63, y: 88 };
  private wrap: BumpWrap = NO_WRAP;
  private worker: Worker | null = null;
  private workerUrl = "";
  private workerFailed = false;
  private jobId = 0;
  private readonly jobs = new Map<number, WorkerJob>();
  private kernel: ReturnType<typeof bumpKernel> | null = null;
  private disposed = false;
  private readonly idle: { mom: THREE.Texture | null; cross: THREE.Texture | null };   // the placeholders

  constructor(renderer: THREE.WebGLRenderer, shared: Uniforms) {
    this.renderer = renderer;
    this.u = shared;
    // createSharedUniforms (scene/uniforms.ts) provides these; fill in any that a caller's map lacks
    shared.uBumpMode ??= { value: 0 };
    shared.uBumpMom ??= { value: null };
    shared.uBumpCross ??= { value: null };
    shared.uBumpScale ??= { value: new THREE.Vector2(1, 1) };
    shared.uBumpK ??= { value: new THREE.Vector2(0, 0) };
    shared.uBumpMode.value = 0;
    this.idle = { mom: shared.uBumpMom.value as THREE.Texture | null, cross: shared.uBumpCross.value as THREE.Texture | null };
  }

  /** False while a map is loading (the previous map, if any, stays on screen meanwhile). */
  get ready(): boolean { return this.loadingToken === 0; }

  /** GPU bytes of the moment textures (RGBA16F + R16F mip chains; ≈ 14 MB for a 1024² map). */
  get gpuBytes(): number { return this.loaded ? this.loaded.bytes : 0; }

  /** Diagnostics of the map on screen (null without one). */
  get info(): { map: string; width: number; height: number; tileMm: [number, number]; heightUm: number; rmsSlopeDeg: number; p99SlopeDeg: number } | null {
    const L = this.loaded, v = this.values;
    if (!L || !v) return null;
    const uv = bumpUniformValues(v, this.domain, L, this.wrap);
    const k = Math.hypot(uv.k[0], uv.k[1]) / Math.SQRT2;   // isotropic equivalent of the per-axis scale
    const deg = (x: number) => Math.round((Math.atan(x) * 180 / Math.PI) * 100) / 100;
    return {
      map: L.key.startsWith("data:") ? "upload" : L.key, width: L.nw, height: L.nh, tileMm: [round3(uv.tileMm[0]), round3(uv.tileMm[1])],
      heightUm: Math.round(uv.heightMm * 1e4) / 10, rmsSlopeDeg: deg(k * L.rms), p99SlopeDeg: deg(k * L.p99),
    };
  }

  /**
   * Applies panel values for an object whose parameter domain is `domainMm` (U × V mm, `p = uv · domainMm`). A changed
   * map starts an asynchronous load and rebuild; everything else only sets uniforms. `wrap` (optional) names the
   * parametric directions that close on themselves, so that closed objects get an integer number of tiles.
   */
  update(v: BumpValues, domainMm: Vec2, wrap: BumpWrap = NO_WRAP): void {
    if (this.disposed) return;
    this.values = { map: v.map, strength: v.strength, tiling: v.tiling, layer: v.layer, invert: v.invert };
    this.domain = { x: domainMm.x, y: domainMm.y };
    this.wrap = { u: wrap.u, v: wrap.v };
    const url = bumpMapUrl(typeof v.map === "string" ? v.map : "") ?? "";
    if (url !== this.wanted) {
      this.wanted = url;
      if (url === "") this.clear();
      else void this.load(url);
    }
    this.applyUniforms();
  }

  dispose(): void {
    this.disposed = true;
    this.token++;
    this.loadingToken = 0;
    this.clear();
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = "";
    for (const j of this.jobs.values()) j.reject(new Error("disposed"));
    this.jobs.clear();
  }

  // ---- internals

  private applyUniforms(): void {
    const v = this.values, L = this.loaded;
    if (L && v) SHOWN.set(this.u, { key: L.key, mom: L.mom, cross: L.cross, dims: { nw: L.nw, nh: L.nh, aspect: L.aspect }, values: { ...v } });
    else SHOWN.delete(this.u);
    if (!v) return;
    const r = bumpUniformValues(v, this.domain, L, this.wrap);
    this.u.uBumpMode.value = r.mode;
    (this.u.uBumpScale.value as THREE.Vector2).set(r.scale[0], r.scale[1]);
    (this.u.uBumpK.value as THREE.Vector2).set(r.k[0], r.k[1]);
  }

  private clear(): void {
    this.token++;
    this.loadingToken = 0;
    const L = this.loaded;
    this.loaded = null;
    SHOWN.delete(this.u);
    this.u.uBumpMode.value = 0;
    if (L) {
      this.u.uBumpMom.value = this.idle.mom;
      this.u.uBumpCross.value = this.idle.cross;
      L.mom.dispose();
      L.cross.dispose();
    }
  }

  private async load(url: string, retry = true): Promise<void> {
    const token = ++this.token;
    this.loadingToken = token;
    try {
      const b = await this.buildMap(url);
      if (token !== this.token || this.disposed) return;
      this.install({ key: url, nw: b.nw, nh: b.nh, aspect: b.aspect, rms: b.r.rms, p99: b.r.p99 }, b.r.levels);
    } catch (e) {
      if (token !== this.token) return;
      if (retry && e instanceof WorkerLost) { void this.load(url, false); return; }
      this.loadingToken = 0;
      const what = url.startsWith("data:") || url.startsWith("blob:") ? "the uploaded image" : url;
      const msg = `[bump] could not load ${what}: ${e instanceof Error ? e.message : String(e)}`;
      // a missing built-in map is a deployment fault (an error); an unreadable upload or a user-given path is the
      // user's input (a warning, §6.8)
      if (BUMP_MAPS.some((o) => o.value === url)) console.error(msg); else console.warn(msg);
      this.clear();
    }
  }

  private install(meta: Omit<Loaded, "mom" | "cross" | "bytes">, levels: BumpLevel[]): void {
    const { mom, cross, bytes } = momentTextures(this.renderer, levels, THREE.RepeatWrapping, "bump");
    const old = this.loaded;
    this.loaded = { ...meta, mom, cross, bytes };
    this.u.uBumpMom.value = mom;
    this.u.uBumpCross.value = cross;
    this.loadingToken = 0;
    this.applyUniforms();
    if (old) { old.mom.dispose(); old.cross.dispose(); }
  }

  /** Fetches, decodes and builds a map: entirely in the worker where possible; else the page decodes (SVG, no
   *  OffscreenCanvas in workers) and the worker builds; without a worker everything runs here (one-off stall). */
  private async buildMap(url: string): Promise<Built> {
    const w = this.ensureWorker();
    if (w) {
      const reply = await this.post(w, { url: absoluteUrl(url) });
      if (reply.r) return { r: reply.r, nw: reply.nw ?? 0, nh: reply.nh ?? 0, aspect: reply.aspect ?? 1 };
      if (!reply.decode) throw new Error(reply.error ?? "worker failed");
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bmp = await decodeImage(await res.blob());
    const k = (this.kernel ??= bumpKernel()), s = k.sizes(bmp.width, bmp.height), aspect = bmp.height / bmp.width;
    const px = k.pixels(bmp, s.aw, s.ah);
    bmp.close();
    const w2 = this.ensureWorker();
    if (w2) {
      const reply = await this.post(w2, { px: px.buffer, aw: s.aw, ah: s.ah, nw: s.nw, nh: s.nh, aspect }, [px.buffer]);
      if (reply.r) return { r: reply.r, nw: s.nw, nh: s.nh, aspect };
      throw new Error(reply.error ?? "worker failed");
    }
    return { r: k.build(px, s.aw, s.ah, s.nw, s.nh), nw: s.nw, nh: s.nh, aspect };
  }

  private post(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<WorkerReply> {
    const id = ++this.jobId;
    return new Promise<WorkerReply>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      try {
        w.postMessage({ id, ...msg }, transfer);
      } catch (e) {
        this.jobs.delete(id);
        this.workerFailed = true;
        this.worker?.terminate();
        this.worker = null;
        reject(new WorkerLost(e instanceof Error ? e.message : String(e)));
      }
    });
  }

  private ensureWorker(): Worker | null {
    if (this.workerFailed) return null;
    if (this.worker) return this.worker;
    try {
      if (typeof Worker === "undefined" || typeof Blob === "undefined") throw new Error("no workers");
      const src = `"use strict";\nconst K = (${bumpKernel.toString()})();\n${WORKER_MAIN}\n`;
      this.workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const w = new Worker(this.workerUrl);
      w.onmessage = (e: MessageEvent) => {
        const d = e.data as WorkerReply;
        const job = this.jobs.get(d.id);
        if (!job) return;
        this.jobs.delete(d.id);
        job.resolve(d);
      };
      w.onerror = (e: ErrorEvent) => {
        // the worker could not start (CSP) or crashed: fail the pending jobs (their loads retry on the main thread)
        // and build on the main thread from now on
        e.preventDefault();
        this.workerFailed = true;
        this.worker?.terminate();
        this.worker = null;
        for (const j of this.jobs.values()) j.reject(new WorkerLost(`worker error: ${e.message || "unavailable"}`));
        this.jobs.clear();
      };
      this.worker = w;
    } catch {
      this.workerFailed = true;
      this.worker = null;
    }
    return this.worker;
  }
}

/**
 * The moment textures of a built mip chain (the uniforms uBumpMom, uBumpCross): an RGBA16F and an R16F DataTexture
 * with the levels supplied by hand (no GPU mipmaps), trilinear and anisotropic (≤ 16) filtering, `wrap` on both axes
 * (a tiling map repeats; a field over one bounded surface, such as a wall sticker's relief, clamps), named
 * `<name>-mom` / `<name>-cross`, and uploaded now (once per map), not inside a frame. `bytes`: their GPU memory
 * (10 bytes per texel of every level).
 */
export function momentTextures(renderer: THREE.WebGLRenderer, levels: readonly BumpLevel[], wrap: THREE.Wrapping, name: string):
  { mom: THREE.DataTexture; cross: THREE.DataTexture; bytes: number } {
  const tex = (kind: "mom" | "cross"): THREE.DataTexture => {
    const l0 = levels[0];
    const t = new THREE.DataTexture(kind === "mom" ? l0.mom : l0.cross, l0.w, l0.h,
      kind === "mom" ? THREE.RGBAFormat : THREE.RedFormat, THREE.HalfFloatType);
    t.mipmaps = levels.map((l) => ({ data: kind === "mom" ? l.mom : l.cross, width: l.w, height: l.h }));
    t.wrapS = t.wrapT = wrap;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = false;
    t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    t.name = `${name}-${kind}`;
    t.needsUpdate = true;
    return t;
  };
  const mom = tex("mom"), cross = tex("cross");
  renderer.initTexture(mom);
  renderer.initTexture(cross);
  let bytes = 0;
  for (const l of levels) bytes += l.w * l.h * 10;
  return { mom, cross, bytes };
}

function round3(x: number): number { return Math.round(x * 1000) / 1000; }

/** An absolute URL for the worker (a blob: worker cannot resolve page-relative paths); data: and blob: URLs pass. */
function absoluteUrl(url: string): string {
  try { return typeof location !== "undefined" ? new URL(url, location.href).href : url; } catch { return url; }
}

/** Decodes an image blob to an ImageBitmap without colour management (height data); SVG and other formats that
 *  createImageBitmap(Blob) rejects go through an <img> and a canvas. */
async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  } catch (first) {
    if (typeof document === "undefined") throw first;
    const src = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = src;
      await img.decode();
      const w = Math.min(img.naturalWidth || 1024, 2048), h = Math.min(img.naturalHeight || 1024, 2048);
      const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const g = c.getContext("2d");
      if (!g) throw first;
      g.drawImage(img, 0, 0, w, h);
      return await createImageBitmap(c);
    } finally {
      URL.revokeObjectURL(src);
    }
  }
}
