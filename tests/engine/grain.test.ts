// Addendum A4.1 film grain: the output pass's uniform values (src/render/grain.ts) and a float64 twin of output.frag's
// grainHash / grainNoise that checks the design claims (white noise at one device pixel per cell; smooth value noise
// with the same contrast everywhere for larger cells; static vs animated seeds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRAIN_SEED_PERIOD, grainSeed, grainUniforms } from "../../engine/render/grain.ts";
import type { GrainOptions } from "../../engine/render/grain.ts";

const G: GrainOptions = { amount: 0.18, sizePx: 1, animated: true, rgb: false, onBackground: false };

test("A4.1 grainUniforms: off without options, at amount 0 and for raw debug views; CSS px → device px cells (≥ 1)", () => {
  const off = { amount: 0, cellPx: 1, seed: 0, rgb: 0, onBackground: 0 };
  assert.deepEqual(grainUniforms(null, 2, 3, false), off);
  assert.deepEqual(grainUniforms({ ...G, amount: 0 }, 2, 3, false), off);
  assert.deepEqual(grainUniforms(G, 2, 3, true), off, "raw debug views bypass the output pass");
  assert.deepEqual(grainUniforms(G, 1, 0, false), { amount: 0.18, cellPx: 1, seed: 0, rgb: 0, onBackground: 0 });
  assert.equal(grainUniforms(G, 2, 0, false).cellPx, 2, "1 CSS px = 2 device px at DPR 2");
  assert.equal(grainUniforms({ ...G, sizePx: 2.5 }, 2, 0, false).cellPx, 5);
  assert.equal(grainUniforms(G, 0.75, 0, false).cellPx, 1, "never below one device pixel (adaptive DPR < 1)");
  assert.equal(grainUniforms(G, Number.NaN, 0, false).cellPx, 1);
  const u = grainUniforms({ ...G, rgb: true, onBackground: true, animated: false }, 1, 7.3, false);
  assert.deepEqual([u.rgb, u.onBackground, u.seed], [1, 1, 0], "static grain: one seed for every frame");
});

test("A4.1 grainSeed: (t·120) mod 512, a new seed every frame up to 120 Hz, deterministic for a frozen t", () => {
  assert.equal(grainSeed(0), 0);
  assert.equal(grainSeed(1), 120);
  assert.equal(grainSeed(5), 600 - GRAIN_SEED_PERIOD);
  assert.ok(Math.abs(grainSeed(1 / 60) - 2) < 1e-9);
  assert.ok(grainSeed(-1) >= 0 && grainSeed(-1) < GRAIN_SEED_PERIOD);
  assert.equal(grainSeed(Number.POSITIVE_INFINITY), 0);
  const t = 12345.678;
  assert.equal(grainSeed(t), grainSeed(t), "frozen runs (URL t) render the same grain");
  for (let f = 0; f < 600; f++) {
    const a = grainSeed(f / 120), b = grainSeed((f + 1) / 120);
    assert.ok(Math.abs(a - b) > 0.5, `frames ${f} and ${f + 1} share a seed`);
  }
  // long sessions keep full precision (computed in doubles on the CPU)
  const big = 86400 * 30 + 0.25;
  assert.ok(Math.abs(grainSeed(big) - ((big * 120) % 512)) < 1e-6);
  assert.equal(grainUniforms(G, 1, 1, false).seed, 120);
});

// ---- float64 twin of output.frag (grainHash, grainLattice, grainNoise) ----------------------------------------
const fract = (x: number) => x - Math.floor(x);
const mod = (x: number, y: number) => x - y * Math.floor(x / y);
function grainHash(x: number, y: number, z: number): number {
  let p0 = fract(x * 0.1031), p1 = fract(y * 0.1031), p2 = fract(z * 0.1031);
  const d = p0 * (p2 + 31.32) + p1 * (p1 + 31.32) + p2 * (p0 + 31.32);
  p0 += d; p1 += d; p2 += d;
  return fract((p0 + p1) * p2);
}
const lattice = (qx: number, qy: number, z: number) => grainHash(mod(qx, 2048), mod(qy, 2048), z) - 0.5;
function grainNoise(fx: number, fy: number, cell: number, z: number): number {
  if (cell <= 1) return lattice(Math.floor(fx), Math.floor(fy), z);
  const x = fx / cell - 0.5, y = fy / cell - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy;
  const sx = u * u * (3 - 2 * u), sy = v * v * (3 - 2 * v);
  const w = [(1 - sx) * (1 - sy), sx * (1 - sy), (1 - sx) * sy, sx * sy];
  const val = [lattice(ix, iy, z), lattice(ix + 1, iy, z), lattice(ix, iy + 1, z), lattice(ix + 1, iy + 1, z)];
  const dot = w[0] * val[0] + w[1] * val[1] + w[2] * val[2] + w[3] * val[3];
  return dot / Math.sqrt(w[0] ** 2 + w[1] ** 2 + w[2] ** 2 + w[3] ** 2);
}
const stats = (xs: number[]) => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { mean: m, sd: Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) };
};
const SD_UNIFORM = 1 / Math.sqrt(12);

test("A4.1 grain twin: one device pixel per cell is uniform white noise (holocloth); neighbours and frames uncorrelated", () => {
  const xs: number[] = [], prod: number[] = [], frames: number[] = [];
  for (let j = 0; j < 160; j++) for (let i = 0; i < 160; i++) {
    const a = grainNoise(i + 0.5, j + 0.5, 1, 0);
    xs.push(a);
    prod.push(a * grainNoise(i + 1.5, j + 0.5, 1, 0));
    frames.push(a * grainNoise(i + 0.5, j + 0.5, 1, 2));        // the next frame at 60 Hz (seed + 2)
  }
  const s = stats(xs);
  assert.ok(Math.abs(s.mean) < 0.01, `mean ${s.mean}`);
  assert.ok(Math.abs(s.sd / SD_UNIFORM - 1) < 0.03, `σ ${s.sd} vs ${SD_UNIFORM}`);
  assert.ok(xs.every((x) => x >= -0.5 && x < 0.5));
  const r1 = stats(prod).mean / s.sd ** 2, rf = stats(frames).mean / s.sd ** 2;
  assert.ok(Math.abs(r1) < 0.05, `neighbour correlation ${r1}`);
  assert.ok(Math.abs(rf) < 0.05, `frame-to-frame correlation ${rf}`);
});

test("A4.1 grain twin: larger cells are smooth value noise with the white noise's contrast at every sub-cell phase", () => {
  for (const cell of [2, 2.5, 4, 8]) {
    // the contrast at a fixed phase inside the cell, over many cells, must not depend on the phase (no lattice pattern)
    const phases = [0, 0.25, 0.5, 0.75].map((ph) => {
      const xs: number[] = [];
      for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) xs.push(grainNoise((i + 0.5 + ph) * cell, (j + 0.5 + ph) * cell, cell, 37));
      return stats(xs).sd;
    });
    for (const sd of phases) assert.ok(Math.abs(sd / SD_UNIFORM - 1) < 0.07, `cell ${cell}: σ per phase ${phases.map((x) => x.toFixed(3))}`);
    // smooth: neighbouring device pixels are strongly correlated (no blocky steps, no white-noise sparkle)
    let sum = 0, n = 0;
    for (let j = 0; j < 120; j++) for (let i = 0; i < 120; i++) {
      sum += grainNoise(i + 0.5, j + 0.5, cell, 37) * grainNoise(i + 1.5, j + 0.5, cell, 37); n++;
    }
    const r = sum / n / SD_UNIFORM ** 2;
    assert.ok(r > 0.3, `cell ${cell}: neighbour correlation ${r.toFixed(2)}`);
  }
  // continuity with the one-pixel case: lattice points sit on the cell centres, so at a lattice point the value is the hash
  assert.equal(grainNoise(3 * 2 + 1, 5 * 2 + 1, 2, 9), lattice(3, 5, 9));
});
