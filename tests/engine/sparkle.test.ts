// A2-1 Sky Sparkle tests SP1–SP7 (addendum A2.4.11), against the pure CPU twin of the dot construction
// (src/physics/sparkle.ts, which transcribes src/shaders/sparkle.glsl) and the dial defaults (sparkle.params.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPARKLE_PARAMS, sparkleDial } from "../../engine/materials/sparkle.params.ts";
import { checkConsistency } from "../../engine/ui/dialConfig.ts";
import {
  SAND_TILT_CLAMP, SAND_TILT_NORM, SPARKLE_LAYERS, clampedRayleighMoment, dotArea, dotCore, dotFull, dotsAt, footprintOf,
  isoFootprint, regimeC, rnd3, sandElem, sandTiltOf, searchLayer,
  sparkleCellPitch, sparkleCoverMeans, sparkleFieldOf, sparkleGratingSummary, sparkleLitFractions, sparkleNum,
  sparkleSpeckDye, sparkleTint, speckDyeT2, speckTintRatio, toLattice, pcg3d,
} from "../../engine/physics/sparkle.ts";
import type { Footprint, SparkleField } from "../../engine/physics/sparkle.ts";
import { foilRgb, materialFactor } from "../../engine/spectral/spd.ts";
import { M_E_TO_SRGB, mat3MulVec, xyzBar } from "../../engine/spectral/cmf.ts";
import { cameraDistance } from "../../engine/physics/geometry.ts";
import { referenceAt } from "../../engine/physics/reference.ts";
import { etaForLight } from "../../engine/physics/grating.ts";
import type { ParamValues, Vec3 } from "../../engine/types.ts";

const DEF: ParamValues = Object.fromEntries(SPARKLE_PARAMS.map((p) => [p.id, p.default]));
const F0 = sparkleFieldOf(DEF);
const D2R = Math.PI / 180;

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} ± ${tol}`);
}
/** Deterministic uniform generator for test sampling (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function oklab(c: Vec3): { L: number; C: number; h: number } {
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
const lumaY = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test("sparkle panel: checkConsistency clean, defaults on the step grid", () => {
  assert.deepEqual(checkConsistency(sparkleDial, SPARKLE_PARAMS), []);
  for (const p of SPARKLE_PARAMS) if (p.kind === "slider") {
    const k = ((p.default as number) - (p.min as number)) / (p.step as number);
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `${p.id} default off its step grid`);
  }
});

test("hash twin: pcg3d / rnd3 reproduce common.glsl's uint arithmetic", () => {
  // reference values of the GLSL (uint wrap-around) computed by hand-checked BigInt arithmetic
  const big = (x: number, y: number, z: number): [number, number, number] => {
    const M = 0xffffffffn;
    let a = (BigInt(x) * 1664525n + 1013904223n) & M, b = (BigInt(y) * 1664525n + 1013904223n) & M, c = (BigInt(z) * 1664525n + 1013904223n) & M;
    a = (a + b * c) & M; b = (b + c * a) & M; c = (c + a * b) & M;
    a ^= a >> 16n; b ^= b >> 16n; c ^= c >> 16n;
    a = (a + b * c) & M; b = (b + c * a) & M; c = (c + a * b) & M;
    return [Number(a), Number(b), Number(c)];
  };
  for (const [x, y, z] of [[0, 0, 0], [1048576, 1048577, 0x51a2c3e0], [4294967295, 123456789, 987654321], [1048000, 1049999, 5]]) {
    assert.deepEqual(pcg3d(x, y, z), big(x, y, z));
  }
  const u = rnd3(-3, 7, 0x1234);
  for (const v of u) assert.ok(v >= 0 && v < 1);
});

// ---------------------------------------------------------------------------------------------------------------

/** The A2.4.1 design configuration the spec's literal numbers refer to (D 500 µm, C 0.5, irregularity 0.5, 8 % specks
 *  of 0.6·D); the calibrated defaults (A2.4.12) differ, and the tests derive their expectations from them as well. */
const SPEC_CFG: ParamValues = { ...DEF, "sparkle.size": 500, "sparkle.coverage": 0.5, "sparkle.irregularity": 0.5,
  "sparkle.speckShare": 8, "sparkle.speckSize": 0.6 };
const FS = sparkleFieldOf(SPEC_CFG);

/** Monte-Carlo union and layer-0 cover of a field over the card interior. */
function coverMC(f: SparkleField, n: number, seed: number): { union: number; single: number } {
  const R = prng(seed);
  let union = 0, single = 0;
  for (let k = 0; k < n; k++) {
    const ds = dotsAt(f, 10 + 43 * R(), 10 + 68 * R());
    if (ds.length) union++;
    if (ds.some((d) => d.layer === 0)) single++;
  }
  return { union: union / n, single: single / n };
}

test("SP1 union cover of the two layers 0.50 ± 0.02, single layer 0.293 ± 0.01 (Monte-Carlo, irr 0.5); the defaults' cover", () => {
  // the cover target C is defined for the aligned dot sizes (A2.4.1 lattice pitch); specks off for the definition
  const a = coverMC({ ...FS, speckShare: 0 }, 40000, 11);
  near(a.union, 0.5, 0.02, "union cover");
  near(a.single, 0.293, 0.01, "single-layer cover");
  // the calibrated defaults: C = sparkle.coverage, single layer 1 − √(1 − C)
  const C = sparkleNum(DEF, "sparkle.coverage");
  const b = coverMC({ ...F0, speckShare: 0 }, 40000, 12);
  near(b.union, C, 0.02, "union cover at the defaults");
  near(b.single, 1 - Math.sqrt(1 - C), 0.01, "single-layer cover at the defaults");
  // with the specks (smaller dots) the visible cover is the mean of sparkleCoverMeans
  for (const [f, seed] of [[FS, 13], [F0, 14]] as const) near(coverMC(f, 40000, seed).union, sparkleCoverMeans(f).union, 0.015, "cover with specks vs sparkleCoverMeans");
});

/** Dots of both layers whose centres lie on a 63 × 88 mm card. */
function dotsPerCard(f: SparkleField): number {
  let count = 0;
  for (let L = 0; L < SPARKLE_LAYERS; L++) {
    const cs = [[0, 0], [63, 0], [0, 88], [63, 88]].map(([x, y]) => toLattice(x, y, L, f.cell));
    const i0 = Math.floor(Math.min(...cs.map((c) => c[0]))) - 1, i1 = Math.ceil(Math.max(...cs.map((c) => c[0]))) + 1;
    const j0 = Math.floor(Math.min(...cs.map((c) => c[1]))) - 1, j1 = Math.ceil(Math.max(...cs.map((c) => c[1]))) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = dotCore(f, L, i, j);
      if (k.cx >= 0 && k.cx < 63 && k.cy >= 0 && k.cy < 88) count++;
    }
  }
  return count;
}

test("SP2 specks: share 8 ± 0.4 %, mean diameter 0.6·D ± 3 %; ≈ 16,300 ± 3 % dots per 63 × 88 mm card (and at the defaults)", () => {
  for (const [f, share, size] of [[FS, 0.08, 0.6], [F0, sparkleNum(DEF, "sparkle.speckShare") / 100, sparkleNum(DEF, "sparkle.speckSize")]] as const) {
    let n = 0, specks = 0, sumD = 0;
    for (let L = 0; L < SPARKLE_LAYERS; L++) for (let j = 0; j < 120; j++) for (let i = 0; i < 120; i++) {
      const d = dotFull(f, dotCore(f, L, i, j));
      n++;
      if (d.speck) { specks++; sumD += 2 * d.R; }
    }
    near(specks / n, share, 0.05 * share, "speck share");
    near(sumD / specks / f.D, size, size * 0.03, "mean speck diameter / D");
  }
  near(dotsPerCard(FS), 16300, 16300 * 0.03, "dots per card (A2.4.1 configuration)");
  near(FS.cell, sparkleCellPitch(0.5, 0.5, 0.5), 1e-12, "lattice pitch");
  near(FS.cell, 0.825, 0.005, "lattice pitch c ≈ 1.65·D");
  const expected = (2 * 63 * 88) / (F0.cell * F0.cell);
  near(dotsPerCard(F0), expected, expected * 0.03, "dots per card at the defaults");
  // mean outline area of the aligned dots matches the lattice's E[s²]·lobe factor
  for (const f of [FS, F0]) {
    let a = 0, m = 0;
    for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) { const d = dotFull(f, dotCore(f, 0, i, j)); if (!d.speck) { a += dotArea(d); m++; } }
    const w = 0.8 * f.irr, l = 0.15 * f.irr;
    near(a / m / ((Math.PI / 4) * f.D * f.D), (1 + (w * w) / 12) * (1 + (l * l) / 3), 0.012, "mean aligned dot area / (π/4)D²");
  }
});

test("SP3 lit fractions under spot A at rest (A2.4.2 lobe model): aligned 95.3 ± 3 %, band centre ≥ 94 %; grating specks A/B/panel", () => {
  const o = { domeRad: sparkleNum(DEF, "sparkle.dome") * D2R, fanQ: sparkleNum(DEF, "sparkle.fan") * D2R, nc: 1.5, camZ: cameraDistance(4 / 3) };
  const A = { pad: [0.48, 0.28] as [number, number], distanceM: 1, sizeDeg: 1.5 };
  for (const f of [F0, FS]) {
    const rA = sparkleLitFractions(f, A, o);
    near(rA.aligned, 0.953, 0.03, "aligned lit, spot A");
    assert.ok(rA.centre >= 0.94, `band centre lit ${rA.centre}`);
    assert.ok(rA.centreN > 800, `band-centre sample ${rA.centreN}`);
  }
  // grating specks: ≈ 1,300 per card, so the shares are pooled over 12 seeds (≈ 16,000 specks, σ ≈ 0.18 % at 5 %)
  const pooled = (light: { pad: [number, number]; distanceM: number; sizeDeg: number }) => {
    let lit = 0, n = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = sparkleLitFractions({ ...FS, speckGrating: true, seed }, light, o);
      lit += r.specks * r.specksN; n += r.specksN;
    }
    return lit / n;
  };
  near(pooled(A), 0.0105, 0.002, "grating specks lit, spot A");
  near(pooled({ pad: [-0.25, -0.68], distanceM: 1.2, sizeDeg: 2.5 }), 0.023, 0.003, "grating specks lit, spot B");
  near(pooled({ pad: [-0.29, 0.5], distanceM: 0.9, sizeDeg: 14 }), 0.053, 0.006, "grating specks lit, panel");
});

test("SP4 colours from the dial defaults: matte base and dyed speck (equal energy, mirror lobe, foilRgb)", () => {
  const tint = sparkleTint(DEF), dye = sparkleSpeckDye(DEF);
  const rho = materialFactor(tint);
  const base = foilRgb("equal", rho), speck = foilRgb("equal", (l) => rho(l) * speckDyeT2(l, dye));
  const ob = oklab(base), os = oklab(speck);
  // expectations derived from the defaults by an independent 1 nm sum of the CIE 1931 CMFs (equal energy, E → D65
  // Bradford, linear sRGB): R_Al·T²_M (base) and R_Al·T²_M·T²_s (speck), A2.4.7
  const brute = (f: (l: number) => number): Vec3 => {
    const xyz = [0, 0, 0];
    let yN = 0;
    for (let l = 360; l <= 830; l += 1) { const c = xyzBar(l); for (let k = 0; k < 3; k++) xyz[k] += f(l) * c[k]; yN += c[1]; }
    return mat3MulVec(M_E_TO_SRGB, [xyz[0] / yN, xyz[1] / yN, xyz[2] / yN]);
  };
  const eb = oklab(brute(rho)), es = oklab(brute((l) => rho(l) * speckDyeT2(l, dye)));
  near(ob.h, eb.h, 1, "base hue vs the 1 nm sum");
  near(ob.C / ob.L, eb.C / eb.L, 0.003, "base C/L vs the 1 nm sum");
  near(os.h, es.h, 1, "speck hue vs the 1 nm sum");
  near(lumaY(speck) / lumaY(base), es.L ** 3 / eb.L ** 3, 0.02, "speck Y / base Y vs the 1 nm sum");
  // A2.4.12 calibration windows: the reference photo's off-band base (A2.0: OKLab h 208–214°; step 3.7: 205–215°), a
  // pale tint (C/L 0.04–0.08); the speck deep blue (reference 249–268°, measured through the camera blur that mixes in
  // the base) and clearly darker than the base
  assert.ok(ob.h >= 205 && ob.h <= 215, `base hue ${ob.h}`);
  assert.ok(ob.C / ob.L >= 0.04 && ob.C / ob.L <= 0.08, `base C/L ${ob.C / ob.L}`);
  assert.ok(os.h >= 255 && os.h <= 270, `speck hue ${os.h}`);
  const yr = lumaY(speck) / lumaY(base);
  assert.ok(yr >= 0.2 && yr <= 0.45, `speck Y / base Y ${yr}`);
  // the shader's uSpeckTint (sparkle.ts apply → speckTintRatio) is this ratio, per channel and SPD layer
  for (const id of ["equal", "daylight", "tungsten", "led", "triphosphor"] as const) {
    const r = speckTintRatio(id, tint, dye), a = foilRgb(id, (l) => rho(l) * speckDyeT2(l, dye)), b = foilRgb(id, rho);
    for (let c = 0; c < 3; c++) near(r[c], a[c] / b[c], 1e-12, `uSpeckTint[${id}][${c}]`);
  }
  // equal-energy speck tint applied to the base colour gives the speck colour
  const t = speckTintRatio("equal", tint, dye);
  for (let c = 0; c < 3; c++) near(base[c] * t[c], speck[c], 1e-12, "tint × base");
});

test("SP5 λ map equals M1's (P8): referenceAt with pitchesNm[0] and gAzimuthRad ± 1 nm; families and depths", () => {
  const s = sparkleGratingSummary(DEF);
  assert.deepEqual(s.pitchesNm, [1000, 1000, 700]);
  assert.deepEqual(s.depthsNm, [55, 60, 55]);
  assert.equal(s.depthNm, 55);
  near(s.gAzimuthRad ?? NaN, 30 * D2R, 1e-12, "ĝ azimuth");
  assert.equal(s.tint.type, "shortpass");
  const camPos: Vec3 = [0, 0, cameraDistance(4 / 3)];
  const I: [number, number, number, number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const P8: [[number, number], number][] = [[[31.5, 44], 555.7], [[48.8, 54], 480.0], [[14.2, 34], 631.0], [[57.5, 81], 400.7], [[5.5, 7], 708.6]];
  const A: Vec3 = [0.48, 0.28, Math.sqrt(1 - 0.48 * 0.48 - 0.28 * 0.28)];
  for (const [mm, lam] of P8) {
    const r = referenceAt({ camPos, cardRot: I, lightPos: A, pitchNm: s.pitchesNm[0], gAzimuthRad: s.gAzimuthRad ?? 0 }, mm);
    assert.ok(r.lambda1 !== null);
    near(r.lambda1 ?? 0, lam, 1, `λ at (${mm})`);
  }
  // per-family depth reaches etaNorm (A2.3.2): family 1 (haze, 60 nm) differs from family 0 (dots, 55 nm)
  const e = etaForLight(s, { x: 0.42, y: 0.24 }, { x: 0, y: 0 });
  assert.ok(e.ord.slice(0, 4).some((v, k) => Math.abs(v - e.ord[4 + k]) > 1e-6), "haze family uses its own depth");
});

test("SP6 sand: facet tilt RMS tan(sand tilt) ± 3 %; mean slope covariance 8° ± 0.2° per axis at every footprint; N_s ≥ 6 is the plain lobe", () => {
  let sx = 0, sy = 0, n = 0, tMax = 0;
  for (let j = 0; j < 320; j++) for (let i = 0; i < 320; i++) {
    const t = sandTiltOf(F0, i - 160, j - 160);
    sx += t[0] * t[0]; sy += t[1] * t[1]; n++;
    tMax = Math.max(tMax, Math.hypot(t[0], t[1]));
  }
  const tilt = Math.tan(sparkleNum(DEF, "sparkle.sandTilt") * D2R);
  near(Math.sqrt(sx / n), tilt, 0.03 * tilt, "tilt RMS x");
  near(Math.sqrt(sy / n), tilt, 0.03 * tilt, "tilt RMS y");
  // bounded facet slopes (no TIR pits): radial clamp at 2.5σ, RMS-preserving normalisation
  near(SAND_TILT_NORM, 1 / Math.sqrt(clampedRayleighMoment(SAND_TILT_CLAMP) / 2), 1e-5, "clamp normalisation");
  assert.ok(tMax <= tilt * SAND_TILT_NORM * SAND_TILT_CLAMP * (1 + 1e-9), `largest facet slope ${tMax}`);
  assert.ok(tMax > 0.95 * tilt * SAND_TILT_NORM * SAND_TILT_CLAMP, "the clamp is reached");
  near(sparkleNum(DEF, "sparkle.matte"), 8, 1e-12, "matte roughness default");
  const R = prng(7), c = F0.sandCell;
  for (const Ns of [0.1, 1, 4, 16]) {
    const F = isoFootprint((c * Math.sqrt(Ns)) / Math.sqrt(2 * Math.PI));   // pixel area N_s·c²
    let xx = 0, yy = 0, mx = 0, my = 0, m = 0;
    for (let k = 0; k < 20000; k++) {
      const e = sandElem(F0, F, 5 + 50 * R(), 5 + 75 * R());
      // population slope covariance: the element's own spread + its mean tilt
      xx += e.sigS * e.sigS + e.SgA[0] + e.s[0] * e.s[0];
      yy += e.sigS * e.sigS + e.SgA[2] + e.s[1] * e.s[1];
      mx += e.s[0]; my += e.s[1]; m++;
      assert.ok(e.SgA[0] >= -1e-15 && e.SgA[2] >= -1e-15 && e.SgA[0] * e.SgA[2] - e.SgA[1] * e.SgA[1] >= -1e-15, "SgA PSD");
    }
    near(Math.sqrt(xx / m) / D2R, 8, 0.2, `RMS x at N_s ${Ns}`);
    near(Math.sqrt(yy / m) / D2R, 8, 0.2, `RMS y at N_s ${Ns}`);
    near(mx / m, 0, 0.004, `mean slope x at N_s ${Ns}`);
    near(my / m, 0, 0.004, `mean slope y at N_s ${Ns}`);
  }
  for (const Ns of [6, 9, 30]) {
    const F = isoFootprint((c * Math.sqrt(Ns)) / Math.sqrt(2 * Math.PI));
    const e = sandElem(F0, F, 31.2, 40.7);
    assert.deepEqual(e.s, [0, 0]);
    assert.deepEqual(e.SgA, [0, 0, 0]);
    near(e.sigS, F0.matteSigS, 1e-12, `plain lobe at N_s ${Ns}`);
  }
  // hard facets (no softness floor) and a small pixel inside one facet: exactly its tilt and the intra-cell spread
  const hard: SparkleField = { ...F0, sandSoft: 0 };
  for (const [x, y] of [[30.03, 40.01], [12.7, 66.2], [51.1, 8.4]]) {
    const e = sandElem(hard, isoFootprint(1e-5), x, y);
    const t = sandTiltOf(hard, e.facet[0], e.facet[1]);
    near(e.s[0], t[0], 1e-6, "single facet slope x");
    near(e.s[1], t[1], 1e-6, "single facet slope y");
    near(e.sigS, F0.sandSigS, 1e-12, "single facet intra-cell spread");
  }
});

test("SP7 search: the 3×3 / 5×5 rule with the two-stage reject finds every dot with c > 1e-3; the reject never drops c > 1e-4", () => {
  // Every footprint regime A evaluates (w_C < 1: N_fp < 6 and σ_maj < 0.5 cell), isotropic or elongated. With the
  // ±0.4-cell centre jitter the 5×5 block is exact only to σ_maj ≈ 0.5 cell along an elongated footprint (its point-like
  // coverage reaches 2.1 cells), so the main hands regime A over to the mean field by σ_maj = 0.5 cell (A2.4.12 notes).
  const R = prng(3);
  const fields: SparkleField[] = [F0, sparkleFieldOf({ ...DEF, "sparkle.irregularity": 1, "sparkle.coverage": 0.8 })];
  let checked = 0, wide = 0;
  for (const f of fields) {
    for (let k = 0; k < 1500; k++) {
      // footprint σ_maj up to 0.5 cell, isotropic or anisotropic (random orientation, axis ratio up to 1:8)
      const sMaj = f.cell * 0.5 * Math.pow(R(), 0.7), ratio = R() < 0.5 ? 1 : 1 + 7 * R(), th = Math.PI * R();
      const px = sMaj * Math.sqrt(2 * Math.PI), py = px / ratio;
      const F: Footprint = footprintOf([px * Math.cos(th), px * Math.sin(th)], [-py * Math.sin(th), py * Math.cos(th)]);
      const x = 8 + 47 * R(), y = 8 + 72 * R();
      for (let L = 0; L < SPARKLE_LAYERS; L++) {
        const brute = searchLayer(f, F, x, y, L, 3, false);
        const rule = searchLayer(f, F, x, y, L);
        const rejOnly = searchLayer(f, F, x, y, L, 3, true);
        const key = (d: { dot: { i: number; j: number } }) => `${d.dot.i},${d.dot.j}`;
        const inRule = new Set(rule.map(key)), inRej = new Set(rejOnly.map(key));
        for (const b of brute) {
          if (b.c > 1e-3) assert.ok(inRule.has(key(b)), `rule misses a dot (c ${b.c}) at σ_maj ${sMaj / f.cell} cell, layer ${L}`);
          if (b.c > 1e-4) assert.ok(inRej.has(key(b)), `stage-1 reject drops a dot (c ${b.c})`);
        }
        checked++;
        if (F.sMaj > 0.25 * f.cell) wide++;
      }
    }
  }
  assert.ok(checked === 6000 && wide > 500, `coverage of the test (${checked} pixels, ${wide} with the 5×5 block)`);
  // beyond σ_maj = 0.5 cell (or 6 dots per pixel) the explicit regime is off
  assert.equal(regimeC(F0, isoFootprint(0.51 * F0.cell)), 1);
  assert.equal(regimeC(F0, footprintOf([0.51 * F0.cell * 2.5066, 0], [0, 0.05 * F0.cell])), 1);
  assert.equal(regimeC(F0, isoFootprint(0.05 * F0.cell)), 0);
});
