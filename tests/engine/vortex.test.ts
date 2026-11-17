// Addendum A2.6.10: Gilded Vortex tests V1–V9 against the CPU twin of the spiral grating (src/physics/vortex.ts), plus
// the panel consistency and the etaN family mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vec3 } from "../../engine/types.ts";
import {
  VORTEX_EYE_PITCH, armPoints, bandOnFraction, eyeRadius, squareWaveIntegral, vortexAt, vortexDefaults, vortexFamily,
  vortexPhase, vortexPitch, type VortexInputs,
} from "../../engine/physics/vortex.ts";
import { cameraDistance, padToDir } from "../../engine/physics/geometry.ts";
import { etaForLight, etaNormalization, rAl } from "../../engine/physics/grating.ts";
import { tintT2 } from "../../engine/spectral/spd.ts";
import { SPEC_NODES } from "../../engine/spectral/tables.ts";
import { checkConsistency } from "../../engine/ui/dialConfig.ts";
import { VORTEX_HANDEDNESS, VORTEX_PARAMS, vortexDial } from "../../engine/materials/vortex.params.ts";

const D2R = Math.PI / 180;
const S = vortexDefaults();                                          // d₀ 1250 nm, r_s 15 mm, ccw, centre (31.5, 44)
const CAM: Vec3 = [0, 0, cameraDistance(4 / 3)];                       // §7 reference geometry (0.32337 m)
const lightAt = (pad: [number, number], d: number): Vec3 => { const v = padToDir(pad[0], pad[1]); return [v[0] * d, v[1] * d, v[2] * d]; };
const SPOT_A = lightAt([0.48, 0.28], 1.0);

/** Deterministic uniform numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test("V1 ĝ and 1/d vs the finite-difference gradient of the phase φ = (r + s_h·r_s·θ)/d₀", () => {
  const rnd = rng(7);
  let worstA = 0, worstR = 0;
  for (const s of [S, { ...S, hand: -1 as const }, { ...S, swirlMm: 4 }, { ...S, swirlMm: 0 }]) {
    for (let k = 0; k < 400; k++) {
      const mm: [number, number] = [2 + 59 * rnd(), 2 + 84 * rnd()];
      const dx = mm[0] - s.centreMm[0], dy = mm[1] - s.centreMm[1];
      if (Math.hypot(dx, dy) < 0.5 || (dx < 0 && Math.abs(dy) < 0.5)) continue;   // the eye and the θ = ±π branch cut
      const h = 1e-4;
      const gx = (vortexPhase([mm[0] + h, mm[1]], s) - vortexPhase([mm[0] - h, mm[1]], s)) / (2 * h);
      const gy = (vortexPhase([mm[0], mm[1] + h], s) - vortexPhase([mm[0], mm[1] - h], s)) / (2 * h);   // cycles/mm
      const e = vortexAt(mm, s);
      // ĝ ≡ −ĝ: compare orientations mod π
      const a = angleDiff(2 * Math.atan2(e.g.y, e.g.x), 2 * Math.atan2(gy, gx)) / 2;
      const r = Math.abs(e.invD * 1e6 / Math.hypot(gx, gy) - 1);
      worstA = Math.max(worstA, a); worstR = Math.max(worstR, r);
    }
  }
  assert.ok(worstA <= 1e-6, `angle ${worstA}`);
  assert.ok(worstR <= 1e-6, `relative 1/d ${worstR}`);
});

// A2.6.3: spot A at rest, card mm and first-order λ of the left and right arm points
const TABLE_A: readonly { r: number; left: [number, number, number]; right: [number, number, number] }[] = [
  { r: 9, left: [23.9, 48.8, 368], right: [39.6, 40.1, 346] },
  { r: 12, left: [20.6, 49.1, 455], right: [43.0, 40.5, 411] },
  { r: 15, left: [17.3, 48.9, 525], right: [46.3, 41.3, 454] },
  { r: 20, left: [11.9, 48.1, 614], right: [51.5, 43.5, 493] },
  { r: 25, left: [6.6, 46.7, 680], right: [56.4, 46.0, 506] },
  { r: 30, left: [1.5, 45.0, 731], right: [61.1, 48.8, 505] },
];

test("V2 armPoints for spot A at rest reproduce the A2.6.3 table (± 0.3 mm, λ₁ ± 3 nm)", () => {
  const pts = armPoints(SPOT_A, CAM, S, TABLE_A.map((x) => x.r));
  for (const row of TABLE_A) {
    const at = pts.filter((p) => p.r === row.r);
    assert.equal(at.length, 2, `two arms at r ${row.r}`);
    for (const ref of [row.left, row.right]) {
      const p = at.reduce((best, q) => (Math.hypot(q.mm[0] - ref[0], q.mm[1] - ref[1]) < Math.hypot(best.mm[0] - ref[0], best.mm[1] - ref[1]) ? q : best));
      const d = Math.hypot(p.mm[0] - ref[0], p.mm[1] - ref[1]);
      assert.ok(d <= 0.3, `r ${row.r}: (${p.mm.map((x) => x.toFixed(2))}) vs (${ref[0]}, ${ref[1]}): ${d.toFixed(2)} mm`);
      assert.ok(Math.abs(p.lambda1 - ref[2]) <= 3, `r ${row.r}: λ₁ ${p.lambda1.toFixed(1)} vs ${ref[2]}`);
    }
  }
});

test("V3 local pitch d(3.7 mm) = 300 ± 2 nm; d(r) chirps to d₀ at the rim", () => {
  assert.ok(Math.abs(vortexPitch(3.7, S) - 300) <= 2, `${vortexPitch(3.7, S)}`);
  for (const [r, d] of [[9, 643], [15, 884], [25, 1072]] as const) assert.ok(Math.abs(vortexPitch(r, S) - d) <= 1.5, `d(${r}) ${vortexPitch(r, S)}`);
  assert.ok(vortexPitch(1e4, S) > 1249.99);
});

test("V4 the right arm under spot A has no visible first order at r ≤ 9 mm (λ₁ < 360 nm)", () => {
  const pts = armPoints(SPOT_A, CAM, S, [3, 4, 5, 6, 7, 8, 9]).filter((p) => p.mm[0] > S.centreMm[0]);
  assert.ok(pts.length >= 7, "one right-arm point per radius");
  for (const p of pts) assert.ok(p.lambda1 < 360, `r ${p.r}: λ₁ ${p.lambda1.toFixed(0)}`);
});

test("V5 band coverage: card mean 1 − contrast/2 ± 0.01 for any footprint; always within [w_lo, 1]", () => {
  const rnd = rng(11);
  for (const sigma of [0, 0.02, 0.1, 0.4, 2]) for (const s of [S, { ...S, contrast: 0.8, bands: 60 }, { ...S, swirlMm: 0 }]) {
    let sum = 0, lo = Infinity, hi = -Infinity;
    const n = 40000;
    for (let k = 0; k < n; k++) {
      const b = vortexAt([63 * rnd(), 88 * rnd()], s, sigma).band;
      sum += b; lo = Math.min(lo, b); hi = Math.max(hi, b);
    }
    const mean = sum / n, want = 1 - s.contrast / 2;
    assert.ok(Math.abs(mean - want) <= 0.01, `σ ${sigma}, contrast ${s.contrast}: mean ${mean.toFixed(4)} vs ${want}`);
    assert.ok(lo >= 1 - s.contrast - 1e-9 && hi <= 1 + 1e-12, `range [${lo}, ${hi}]`);
  }
  // the box filter: P is the exact integral of the square wave, I → ½ for wide footprints, a step for none
  assert.ok(Math.abs(squareWaveIntegral(2.3) - 1.3) < 1e-12 && Math.abs(squareWaveIntegral(2.7) - 1.5) < 1e-12);
  assert.ok(Math.abs(bandOnFraction(0.25, 0) - 1) < 1e-12 && bandOnFraction(0.75, 0) === 0);
  assert.ok(Math.abs(bandOnFraction(0.37, 40) - 0.5) < 0.01);
  assert.equal(vortexAt([10, 10], { ...S, bands: 0 }, 0).band, 1);
});

test("V6 handedness mirrors the arm offsets: θ − ψ_q = −s_h·atan(r_s/r) (mod π)", () => {
  const radii = [9, 12, 15, 20, 25];
  for (const hand of [1, -1] as const) {
    const pts = armPoints(SPOT_A, CAM, { ...S, hand }, radii);
    assert.ok(pts.length >= 8);
    for (const p of pts) {
      const off = (p.thetaDeg - p.psiQDeg) * D2R, want = -hand * Math.atan(S.swirlMm / p.r);
      assert.ok(angleDiff(2 * off, 2 * want) / 2 < 1e-6, `hand ${hand} r ${p.r}: offset ${(off / D2R).toFixed(3)}° vs ${(want / D2R).toFixed(3)}°`);
    }
  }
  // the clockwise spiral is the mirror image: same radii, offsets of opposite sign
  const ccw = armPoints(SPOT_A, CAM, S, [15]), cw = armPoints(SPOT_A, CAM, { ...S, hand: -1 }, [15]);
  const offs = (ps: typeof ccw) => ps.map((p) => Math.atan2(Math.sin((p.thetaDeg - p.psiQDeg) * D2R * 2), Math.cos((p.thetaDeg - p.psiQDeg) * D2R * 2)) / 2);
  for (const o of offs(ccw)) assert.ok(o < 0);
  for (const o of offs(cw)) assert.ok(o > 0);
});

test("V7 r_s = 0 reduces to M1's concentric field: ĝ radial, constant pitch d₀", () => {
  const s0: VortexInputs = { ...S, swirlMm: 0 };
  const rnd = rng(3);
  for (let k = 0; k < 200; k++) {
    const mm: [number, number] = [63 * rnd(), 88 * rnd()];
    const e = vortexAt(mm, s0), dx = mm[0] - S.centreMm[0], dy = mm[1] - S.centreMm[1], r = Math.hypot(dx, dy);
    if (r < 0.1) continue;
    assert.ok(Math.abs(Math.abs(e.g.x * dx + e.g.y * dy) / r - 1) < 1e-12, "ĝ ∥ r̂");
    assert.ok(Math.abs(e.invD * 1250 - 1) < 1e-12, "1/d = 1/d₀");
  }
});

test("V8 eye radius: λ₁ reaches 380 nm at 9–12 mm on both arms of spot A; r_eye(|q|) formula within 1 %", () => {
  const radii: number[] = [];
  for (let r = 5; r <= 14; r += 0.05) radii.push(Math.round(r * 100) / 100);
  const pts = armPoints(SPOT_A, CAM, S, radii);
  for (const side of [-1, 1]) {
    const arm = pts.filter((p) => Math.sign(p.mm[0] - S.centreMm[0]) === side).sort((a, b) => a.r - b.r);
    const first = arm.find((p) => p.lambda1 >= 380);
    assert.ok(first && first.r >= 9 && first.r <= 12, `${side < 0 ? "left" : "right"} arm: λ₁ = 380 nm at r ${first?.r}`);
  }
  // along a ray with ĝ ∥ q at a fixed |q|, λ₁(r) = |q|/(1/d(r)) crosses 380 nm at r_s/√((d₀|q|/380)² − 1)
  for (const q of [0.45, 0.6, 0.8, 1.27]) {
    const want = eyeRadius(q, S);
    let r = 0.05;
    while (q / vortexAt([S.centreMm[0] + r, S.centreMm[1]], S).invD < 380 && r < 60) r += 1e-3;
    assert.ok(Math.abs(r / want - 1) < 0.01, `|q| ${q}: crossing ${r.toFixed(3)} vs ${want.toFixed(3)} mm`);
  }
  assert.ok(Math.abs(eyeRadius(1.27, S) - 3.7) < 0.15, "3.7 mm only at |q| ≈ 1.27");
});

test("V9 eye family (300 nm): grazing light antiparallel to ĝ counts its order below 585 nm; normal incidence is mirror-only where λ/d ≥ n_c", () => {
  const sum = { pitchesNm: [VORTEX_EYE_PITCH, 875, 1250], depthNm: 45, nc: 1.5, gAzimuthRad: null, recycle: true,
    tint: { type: "longpass" as const, edgeNm: 480, widthNm: 50, floor: 0.35 } };
  const R = (l: number) => rAl(l) * tintT2(l, sum.tint);
  // the mirror-only value: etaN with the m = 0 order alone (1/(η₀ − R·η₀·τ(0))) — evaluate at a pitch so fine that
  // no order exists at any node
  const mirrorOnly = (l: { x: number; y: number }, lam: number) => etaNormalization({ lg: l.x, lt: l.y, ci: Math.sqrt(1 - l.x * l.x - l.y * l.y),
    invD: 1 / 50, depthNm: 45, nc: 1.5, lambdaNm: lam, R: R(lam), recycle: true });
  // grazing: |l| = 0.95 antiparallel to ĝ (ĝ ∥ q̂ = normalize(l + v), v = 0 here, so ĝ = −l̂: l_g = −0.95)
  const lG = { x: 0.95, y: 0 }, v = { x: 0, y: 0 };
  const g = etaForLight(sum, lG, v);
  SPEC_NODES.forEach((lam, k) => {
    const e0 = g.ord[k], m0 = mirrorOnly(lG, lam);
    if (lam < 585) assert.ok(Math.abs(e0 / m0 - 1) > 1e-3, `grazing ${lam} nm: the order is counted (${e0} vs mirror-only ${m0})`);
  });
  // normal incidence: m = ±1 at λ/d = 1.70, 1.97, 2.23 is evanescent even inside the lacquer (≥ n_c 1.5): mirror only.
  // (At 430 nm, λ/d = 1.43 < n_c: the first order propagates inside the lacquer, is trapped by TIR and recycled.)
  const n = etaForLight(sum, { x: 0, y: 0 }, v);
  SPEC_NODES.forEach((lam, k) => {
    const e0 = n.ord[k], m0 = mirrorOnly({ x: 0, y: 0 }, lam);
    if (lam / VORTEX_EYE_PITCH >= 1.5) assert.ok(Math.abs(e0 / m0 - 1) < 1e-6, `normal ${lam} nm: ${e0} vs ${m0}`);
    else assert.ok(Math.abs(e0 / m0 - 1) > 1e-4, `normal ${lam} nm: trapped order counted`);
  });
});

test("vortex: family coordinate piecewise linear in 1/d (0 at ≥ 1/300, 1 at 1/(0.7 d₀), 2 at 1/d₀)", () => {
  assert.equal(vortexFamily(1 / 100, 1250), 0);
  assert.equal(vortexFamily(1 / 300, 1250), 0);
  assert.ok(Math.abs(vortexFamily(1 / 875, 1250) - 1) < 1e-12);
  assert.ok(Math.abs(vortexFamily(1 / 1250, 1250) - 2) < 1e-12);
  const mid = 0.5 * (1 / 300 + 1 / 875);
  assert.ok(Math.abs(vortexFamily(mid, 1250) - 0.5) < 1e-12);
  // along the radius the family coordinate rises monotonically from the eye to the rim
  let prev = -1;
  for (let r = 0.5; r < 60; r += 0.5) { const f = vortexFamily(vortexAt([S.centreMm[0] + r, S.centreMm[1]], S).invD, 1250); assert.ok(f >= prev - 1e-12); prev = f; }
});

test("vortex panel: checkConsistency clean, ids in the vortex namespace", () => {
  assert.deepEqual(checkConsistency(vortexDial, VORTEX_PARAMS), []);
  for (const p of VORTEX_PARAMS) assert.ok(p.id.startsWith("vortex."), p.id);
  assert.deepEqual([...VORTEX_HANDEDNESS], ["ccw", "cw"]);
  const pad = VORTEX_PARAMS.find((p) => p.id === "vortex.centre");
  assert.equal(pad?.kind, "pad");
});
