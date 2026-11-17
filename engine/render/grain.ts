// Film grain (addendum A4.1, holocloth parity): the options the output pass receives and their uniform values.
// Pure module (no three, no DOM, erasable syntax only), so tests/grain.test.ts runs it under `node --test`.
//
// holocloth's GrainShader is a last pass over display-referred sRGB: c.rgb += (gHash(vec3(mod(gl_FragCoord.xy, 1024),
// mod(uTime·120, 512))) − 0.5)·amount — monochrome white noise from Dave Hoskins' sinless hash, time used as a hash
// dimension (re-seeded every frame, nothing crawls). Ours (output.frag `grainNoise`) adds the same noise after the
// tone curve, gamut map and OETF, before the TPDF dither, with:
// - a cell size in CSS px (max(size·DPR, 1) device px), so the grain looks the same at DPR 1 and 2; a cell of one
//   device pixel is holocloth's per-pixel white noise, larger cells are smooth value noise over the cell lattice
//   (smoothstep weights, normalised by √Σw² so the contrast is the same everywhere and equals the white noise's);
// - an animated (seed from the frame time; frozen runs use the URL `t`, so renders stay deterministic) or static seed;
// - monochrome or independent per-channel noise;
// - the card's coverage as a mask unless `on background`, so the page stays exactly #000 / #FFF (Q13, N8).

/** The `grain.*` scene values the output pass uses (A4.1). */
export interface GrainOptions {
  /** Display-space amplitude: c += (u − ½)·amount with u uniform in [0, 1) (holocloth's `noise` scale). */
  amount: number;
  /** Grain cell size in CSS px (the device cell is max(sizePx·DPR, 1) px). */
  sizePx: number;
  /** Re-seeded every frame from the frame time (frozen runs: the URL `t`) vs one static pattern. */
  animated: boolean;
  /** Independent noise per channel (false: monochrome, as holocloth). */
  rgb: boolean;
  /** false: the grain is multiplied by the card coverage, so the page stays exact; true: over the whole frame. */
  onBackground: boolean;
}

/** Uniform values of the output pass's grain (amount 0 = off: the pass is bit-identical to having no grain). */
export interface GrainUniforms { amount: number; cellPx: number; seed: number; rgb: number; onBackground: number }

/** Hash-dimension period of the seed (holocloth: mod(uTime·120, 512)). */
export const GRAIN_SEED_PERIOD = 512;
/** Seed advance per second: 120 per second re-seeds every frame at up to 120 Hz. */
export const GRAIN_SEED_RATE = 120;

/** The animated seed of frame time `timeS` (s): (t·120) mod 512, computed in doubles so it never loses precision. */
export function grainSeed(timeS: number): number {
  if (!Number.isFinite(timeS)) return 0;
  const s = (timeS * GRAIN_SEED_RATE) % GRAIN_SEED_PERIOD;
  return s < 0 ? s + GRAIN_SEED_PERIOD : s;
}

/** The output pass's grain uniforms: off (amount 0) without options, at amount 0 and for raw debug views. */
export function grainUniforms(g: GrainOptions | null, dpr: number, timeS: number, raw: boolean): GrainUniforms {
  if (!g || raw || !(g.amount > 0)) return { amount: 0, cellPx: 1, seed: 0, rgb: 0, onBackground: 0 };
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const size = Number.isFinite(g.sizePx) && g.sizePx > 0 ? g.sizePx : 1;
  return {
    amount: g.amount,
    cellPx: Math.max(size * d, 1),
    seed: g.animated ? grainSeed(timeS) : 0,
    rgb: g.rgb ? 1 : 0,
    onBackground: g.onBackground ? 1 : 0,
  };
}
