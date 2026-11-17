// Quality tiers (spec §1.4–1.6) and the GPU-memory formula of §5.5.
import type { Tier, TierConfig } from "../types.ts";

/** §1.6, one entry per tier. `msaaMaxMB` = the tier's §1.5 memory budget: MSAA is used only while the §5.5 allocation
 *  total with MSAA stays within it (the "low: 4 if ≤ budget, else 0" rule; every tier fits at its pixel cap).
 *  Addendum A1.1 item 2 adds the depth buffer of the HDR target (the non-convex objects self-occlude): 4 B per MSAA
 *  sample plus the 4 B single-sample depth three attaches to the resolve framebuffer, i.e. +20 B/px at 4×. The budgets
 *  grow with it so that MSAA stays on at every tier's pixel cap, as before: high 520 → 640 MB (634 MB at 8.3 Mpx,
 *  593 MB on the full-screen 16-inch MacBook Pro), medium 180 → 230 MB (225 MB at 3.0 Mpx), low 100 → 125 MB
 *  (123 MB at 1.6 Mpx, 104 MB on an iPhone 14).
 *  Addendum A5: the Volume Hologram's trip counts — sphere-tracing steps per traced light (48 / 36 / 24), lights traced
 *  per pixel (3 / 2 / 1) and soft-shadow steps of the recorded shading (10 / 6 / 0).
 *  Addendum A7 (depth of field, render/dof.ts): the CoC radius clamp in device px of the tier's target (64 / 40 / 24;
 *  32 / 20 / 12 half-resolution texels), the gather's aperture samples per field (far, near) at half resolution
 *  (48 / 32 / 20) and the bokeh-sprite threshold (a highlight is scattered as a shaped sprite
 *  once a texel exceeds 0.5 / 1 / 2 × display white after exposure and 1.5× its surroundings). Cost estimates in the A7.9 notes. */
export const TIERS: Readonly<Record<Tier, TierConfig>> = {
  high: {
    tier: "high", dprCap: 2, maxRtPixels: 8.3e6, msaa: 4, msaaMaxMB: 640,
    pmremSize: 512, glareLevels: 5, glareStartDiv: 2, waves: { board: 8, coat: 16 },
    defines: { RECT_EXACT: 1, RECT_LTC: 1, NB: 8, IBL_ORDERS: 1, DISCRETE_LIGHTS: 4, DISCRETE_LIGHTS_B: 2, FLAKE_ENV: 1, WEAR_CELLS: 3 },
    trips: { maxOrder: 3, ghB: 4, vorR: 2, flakeR: 1, bCells: 3, bBins: 5, bLevels: 2, volSteps: 48, volLights: 3, volShadow: 10 },
    dof: { maxRadiusPx: 64, samples: 48, spriteThreshold: 0.5 },
  },
  medium: {
    tier: "medium", dprCap: 2, maxRtPixels: 3.0e6, msaa: 4, msaaMaxMB: 230,
    pmremSize: 256, glareLevels: 4, glareStartDiv: 2, waves: { board: 6, coat: 8 },
    defines: { RECT_EXACT: 1, RECT_LTC: 1, NB: 6, IBL_ORDERS: 1, DISCRETE_LIGHTS: 4, DISCRETE_LIGHTS_B: 2, FLAKE_ENV: 1, WEAR_CELLS: 3 },
    trips: { maxOrder: 2, ghB: 4, vorR: 2, flakeR: 0, bCells: 3, bBins: 3, bLevels: 2, volSteps: 36, volLights: 2, volShadow: 6 },
    dof: { maxRadiusPx: 40, samples: 32, spriteThreshold: 1 },
  },
  low: {
    tier: "low", dprCap: 2, maxRtPixels: 1.6e6, msaa: 4, msaaMaxMB: 125,
    pmremSize: 256, glareLevels: 3, glareStartDiv: 4, waves: { board: 2, coat: 2 },
    defines: { RECT_EXACT: 0, RECT_LTC: 0, NB: 0, IBL_ORDERS: 0, DISCRETE_LIGHTS: 2, DISCRETE_LIGHTS_B: 1, FLAKE_ENV: 0, WEAR_CELLS: 2 },
    trips: { maxOrder: 2, ghB: 2, vorR: 1, flakeR: 0, bCells: 2, bBins: 2, bLevels: 1, volSteps: 24, volLights: 1, volShadow: 0 },
    dof: { maxRadiusPx: 24, samples: 20, spriteThreshold: 2 },
  },
};

/** Lower bound of the low tier's adaptive DPR range (§1.6 "adaptive 1.25–2"); 1.0 elsewhere (§1.5 floor). */
export function dprFloor(t: TierConfig): number { return t.tier === "low" ? 1.25 : 1.0; }

const HIGH_RE = /NVIDIA|GeForce|RTX|Quadro|Radeon RX|Radeon Pro|Arc A|Apple M\d|Apple GPU/i;

/** Unmasked renderer string: WEBGL_debug_renderer_info when exposed, else gl.RENDERER (§1.6). */
export function rendererString(gl: WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    if (typeof s === "string" && s.length > 0) return s;
  } catch { /* fall through */ }
  const r = gl.getParameter(gl.RENDERER);
  return typeof r === "string" ? r : "";
}

/** §1.6 auto selection (`quality=auto`). */
export function detectTier(gl: WebGL2RenderingContext): Tier {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const touch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  const small = typeof screen !== "undefined" && Math.min(screen.width, screen.height) < 900;
  if (coarse && touch && small) return "low";
  return HIGH_RE.test(rendererString(gl)) ? "high" : "medium";
}

// ---- GPU memory (§5.5 + addendum A1.1 item 2). Bytes are counted as 10⁶ per MB, as in §1.5 / A.6. At the pixel
// caps with 4× MSAA: high 634 MB, medium 225 MB, low 123 MB (without the depth buffer 468 / 165 / 91 MB).

/** Environment memory: capture cube 6·s²·8 + PMREM source copy 6·s²·8·4/3 + PMREM output 6·s²·8·4/3 [bytes]. */
export function envBytes(pmremSize: number): number {
  const face = 6 * pmremSize * pmremSize * 8;
  return face + 2 * face * (4 / 3);
}
/** Spectral tables (uCmfConv + uCmfCum, 0.84 MB each) [bytes]. */
export const TABLE_BYTES = 1.7e6;

/** Σ_i 1/(div²·4^i) over the glare levels (§5.5). */
export function glareAreaFactor(levels: number, startDiv: number): number {
  let s = 0;
  for (let i = 0; i < levels; i++) s += 1 / (startDiv * startDiv * Math.pow(4, i));
  return s;
}

/** Depth bytes per sample of the HDR target's depth buffer (DEPTH_COMPONENT24, stored in 32 bits). */
export const DEPTH_BYTES = 4;

/** Depth bytes per pixel: one depth value per MSAA sample on the multisampled framebuffer, plus the single-sample
 *  depth renderbuffer three attaches to the resolve framebuffer of every target with `depthBuffer` (r187,
 *  WebGLTextures.setupDepthRenderbuffer; it is never written: `resolveDepthBuffer` is false). */
export function depthBytesPerPixel(samples: number): number {
  return DEPTH_BYTES * (Math.max(samples, 0) + 1);
}

/**
 * Allocation total in MB for an HDR target of `pixels` (= W·H at the tier cap) with `samples` MSAA samples:
 * W·H·(bpt·samples + bpt (resolve) + 8·Σ 1/(div²·4^i) (glare levels) + 8 (two RGBA8 canvas buffers) + depth
 * (4·samples + 4)) + environment + tables (§5.5, addendum A1.1 item 2).
 */
export function gpuMemoryMB(t: TierConfig, pixels: number, samples: number, glare = true, bytesPerTexel = 8, depth = true): number {
  const perPx = bytesPerTexel * samples + bytesPerTexel + (glare ? 8 * glareAreaFactor(t.glareLevels, t.glareStartDiv) : 0) + 8
    + (depth ? depthBytesPerPixel(samples) : 0);
  return (pixels * perPx + envBytes(t.pmremSize) + TABLE_BYTES) / 1e6;
}

/** Allocation size of the HDR target: CSS size × the DPR cap, reduced until w·h ≤ the tier's pixel cap (§5.5). */
export function allocationSize(t: TierConfig, cssW: number, cssH: number, dprMax = t.dprCap): { w: number; h: number; dpr: number } {
  const w0 = Math.max(1, cssW), h0 = Math.max(1, cssH);
  let dpr = Math.max(0.25, Math.min(dprMax, t.dprCap));
  const fit = Math.sqrt(t.maxRtPixels / (w0 * h0));
  if (dpr > fit) dpr = fit;
  let w = Math.max(1, Math.floor(w0 * dpr)), h = Math.max(1, Math.floor(h0 * dpr));
  while (w * h > t.maxRtPixels && dpr > 0.05) {          // guard against rounding up past the cap
    dpr *= 0.999; w = Math.max(1, Math.floor(w0 * dpr)); h = Math.max(1, Math.floor(h0 * dpr));
  }
  return { w, h, dpr };
}
