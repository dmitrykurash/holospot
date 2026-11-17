// Addendum A7 depth of field: the thin-lens CPU twin (src/physics/lens.ts) — CoC against hand values, lens ↔ fov,
// focus modes and the focus pull, the per-channel LoCA shift, the aperture shape and its sampling pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATS_EYE_MAX, DEFAULT_FOV_DEG, DEFAULT_LENS_MM, F_STOPS, DEFAULT_F_STOP, FocusPull, apertureGauge, aperturePattern,
  bladeConstants, bladeRho, catsEyeOffset, channelCocPx, clipAreaAt, clipAreaTable, cocMm, cocRadiusFactorPx,
  cocRadiusPx, fieldRim, focalLengthMm, focusDistanceM, framingScale, lensFovDeg, locaFocusOffsetM, locaShiftMm,
  mmToPx, polygonAreaRatio, rimProfile, vesicaGauge,
} from "../../engine/physics/lens.ts";
import { CAMERA_FOV_DEG, fitDistance } from "../../engine/scene/camera.ts";

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (± ${tol})`);

test("A7.2 lens ↔ fov: 22° ↔ 61.73 mm; the default 62 mm is exactly today's 22°; 24 / 135 mm", () => {
  near(focalLengthMm(22), 61.735, 0.001);
  assert.equal(DEFAULT_LENS_MM, 62);
  assert.equal(lensFovDeg(62), 22, "the default reproduces the camera bit for bit");
  assert.equal(lensFovDeg(DEFAULT_LENS_MM), CAMERA_FOV_DEG);
  assert.equal(DEFAULT_FOV_DEG, CAMERA_FOV_DEG);
  near(lensFovDeg(focalLengthMm(22)), 22, 1e-9, "2·atan(12/f) is the inverse of f = 12/tan(fov/2)");
  near(lensFovDeg(24), 53.13, 0.01);
  near(lensFovDeg(135), 10.16, 0.01);
  near(focalLengthMm(lensFovDeg(100)), 100, 1e-9);
  // monotone through the default (no fold at 62 mm)
  assert.ok(lensFovDeg(61) > lensFovDeg(62) && lensFovDeg(62) > lensFovDeg(63));
  // framing: the fitted distance scales with 1/tan(fov/2) (the object keeps its size on screen)
  near(fitDistance(4 / 3, null, lensFovDeg(124)) / fitDistance(4 / 3, null), framingScale(lensFovDeg(124)), 1e-9);
  near(framingScale(lensFovDeg(124)), 124 / focalLengthMm(22), 1e-9);
  assert.equal(fitDistance(4 / 3, null, CAMERA_FOV_DEG), fitDistance(4 / 3, null), "the default fov is the old fit");
});

test("A7.2 thin-lens CoC: c = A·f·(z − z_f)/(z·(z_f − f)) against hand values", () => {
  // f = 50 mm, N = 2 (A = 25 mm), z_f = 1 m, z = 2 m: 25·50·1000/(2000·950) = 0.657895 mm
  near(cocMm(2, 1, 50, 2), (25 * 50 * 1000) / (2000 * 950), 1e-12);
  near(cocMm(2, 1, 50, 2), 0.657895, 1e-6);
  // in front: z = 0.5 m → 25·50·(−500)/(500·950) = −1.315789 mm
  near(cocMm(0.5, 1, 50, 2), -1.315789, 1e-6);
  assert.equal(cocMm(1, 1, 50, 2), 0, "in focus");
  // infinity: A·f/(z_f − f) = 1250/950
  near(cocMm(Infinity, 1, 50, 2), 1.315789, 1e-6);
  // the default camera: f = 61.73 mm, f/2.8, focus 0.3234 m, a point 15 mm behind → 0.2318 mm
  const f = focalLengthMm(22);
  near(cocMm(0.3384, 0.3234, f, 2.8), (f / 2.8) * f * 15 / (338.4 * (323.4 - f)), 1e-12);
  // px: 24 mm = the viewport height
  near(mmToPx(0.24, 900), 9, 1e-12);
  near(cocRadiusPx(2, 1, 50, 2, 900), 0.657895 / 24 * 900 / 2, 1e-4);
  assert.equal(cocRadiusPx(Infinity, 0.06, 50, 0.95, 2000, 64), 64, "clamped to the tier radius");
  assert.equal(cocRadiusPx(0.051, 0.06, 50, 0.95, 2000, 64), -64);
  // the shaders' factor form K·(1 − z_f/z)
  const K = cocRadiusFactorPx(1, 50, 2, 900);
  near(K * (1 - 1 / 2), cocRadiusPx(2, 1, 50, 2, 900), 1e-9);
  near(K * (1 - 1 / 0.5), cocRadiusPx(0.5, 1, 50, 2, 900), 1e-9);
  // monotone in z, sign flips at the focus
  let prev = -Infinity;
  for (let z = 0.2; z < 3; z += 0.05) { const c = cocMm(z, 1, 50, 2); assert.ok(c > prev); prev = c; }
  // stopping down by one stop halves A and the CoC by √2
  near(cocMm(2, 1, 50, 2.8) / cocMm(2, 1, 50, 2), 2 / 2.8, 1e-12);
});

test("A7.2 focus modes: object (+ offset), point (+ offset, falls back to the object), manual, never closer than f", () => {
  const base = { objectDepthM: 0.32, pointDepthM: 0.34, manualCm: 50, offsetMm: 0, fMm: 62 };
  assert.equal(focusDistanceM("object", base), 0.32);
  assert.equal(focusDistanceM("point", base), 0.34);
  assert.equal(focusDistanceM("manual", base), 0.5);
  near(focusDistanceM("object", { ...base, offsetMm: 12 }), 0.332, 1e-12);
  near(focusDistanceM("point", { ...base, offsetMm: -20 }), 0.32, 1e-12);
  assert.equal(focusDistanceM("manual", { ...base, offsetMm: 30 }), 0.5, "the offset applies to object and point only");
  assert.equal(focusDistanceM("point", { ...base, pointDepthM: null }), 0.32, "no picked point: the object's centre");
  near(focusDistanceM("manual", { ...base, manualCm: 5, fMm: 200 }), 0.21, 1e-12);
});

test("A7.2 focus pull: continuous targets are followed exactly; a jump eases critically damped in ≈ 0.3 s", () => {
  const p = new FocusPull();
  assert.equal(p.update(0.3, 1 / 60, false, false), 0.3);
  assert.equal(p.update(0.31, 1 / 60, false, false), 0.31, "continuous motion follows directly");
  let v = p.update(0.5, 1 / 60, true, false);
  assert.ok(v > 0.31 && v < 0.33, `starts from the shown focus (${v})`);
  let t = 1 / 60, prev = v;
  const trace: number[] = [];
  while (t < 0.8) { v = p.update(0.5, 1 / 60, false, false); trace.push(v); assert.ok(v >= prev - 1e-12, "no overshoot"); prev = v; t += 1 / 60; }
  const at = (s: number) => trace[Math.round(s * 60) - 2];
  assert.ok((0.5 - at(0.3)) / 0.19 < 0.06, `≥ 94 % there at 0.3 s (${at(0.3)})`);
  assert.ok(Math.abs(v - 0.5) < 1e-4);
  // frozen runs are exact
  const q = new FocusPull();
  q.update(0.3, 1 / 60, false, true);
  assert.equal(q.update(0.7, 1 / 60, true, true), 0.7);
});

test("A7.3 LoCA: R and B focus Δ behind G; constant CoC shift; magenta rims in front, green rims behind; in focus neutral", () => {
  const f = 62, n = 1.4, zf = 0.32, loca = 0.6;
  const d = locaFocusOffsetM(loca, zf, f);
  near(d, (0.6 * 0.5 * ((320 - 62) / 62) ** 2) / 1000, 1e-12);
  assert.ok(d > 0);
  const eps = locaShiftMm(loca, zf, f, n);
  assert.ok(eps > 0);
  // the per-channel z_f offset shifts the signed CoC by ≈ −ε at every depth of the scene (first order)
  for (const z of [0.25, 0.3, 0.34, 0.4, 0.6]) {
    const shift = cocMm(z, zf + d, f, n) - cocMm(z, zf, f, n);
    near(shift, -eps, 0.12 * eps, `z = ${z}`);
  }
  // in front (G < 0): |R| = |B| > |G| → magenta outer rim; behind (G > 0): |G| > |R| = |B| → green outer rim
  const [r1, g1, b1] = channelCocPx(-20, 3);
  assert.ok(Math.abs(r1) > Math.abs(g1) && r1 === b1, "near: magenta rims");
  const [r2, g2, b2] = channelCocPx(20, 3);
  assert.ok(Math.abs(g2) > Math.abs(r2) && r2 === b2, "far: green rims");
  assert.deepEqual(channelCocPx(0, 3), [0, 0, 0], "in focus: neutral");
  assert.deepEqual(channelCocPx(0.4, 3), [0.4, 0.4, 0.4], "below 0.5 px: neutral");
  const [r3, g3] = channelCocPx(1, 30);
  assert.ok(r3 > 0 && r3 >= 0.5 * g3, "a strong shift never flips the field");
  assert.equal(locaShiftMm(0, zf, f, n), -0, "loca 0: no fringing");
  // stronger wide open
  assert.ok(locaShiftMm(loca, zf, f, 1.4) > locaShiftMm(loca, zf, f, 5.6) * 3.9);
});

test("A7.3 aperture: blade polygon inscribed in the unit circle, curvature 0 → polygon, 1 → circle", () => {
  for (const blades of [5, 6, 7, 9, 11]) {
    const k = bladeConstants({ blades, curvature: 0, angleDeg: 0 });
    // vertices on the unit circle, edge midpoints at cos(π/n)
    for (let v = 0; v < blades; v++) near(bladeRho(k, Math.PI / 2 + (v * 2 * Math.PI) / blades), 1, 1e-9, `vertex ${v}`);
    near(bladeRho(k, k.normal0), Math.cos(Math.PI / blades), 1e-9);
    near(polygonAreaRatio(k), (blades * Math.sin((2 * Math.PI) / blades)) / (2 * Math.PI), 1e-4, "regular polygon area");
    const kc = bladeConstants({ blades, curvature: 0.6, angleDeg: 17 });
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * 2 * Math.PI;
      const r0 = bladeRho(bladeConstants({ blades, curvature: 0, angleDeg: 17 }), th), r = bladeRho(kc, th);
      assert.ok(r <= 1 + 1e-9 && r >= r0 - 1e-9, "a curved blade lies between the straight edge and the circle");
    }
    for (let v = 0; v < blades; v++) near(bladeRho(kc, (90 + 17) * Math.PI / 180 + (v * 2 * Math.PI) / blades), 1, 1e-9);
  }
  const round = bladeConstants({ blades: 9, curvature: 1, angleDeg: 0 });
  assert.ok(round.round);
  assert.equal(bladeRho(bladeConstants({ blades: 0, curvature: 0.3, angleDeg: 0 }), 1.234), 1, "0 blades = circular");
  // the gauge: the boundary has gauge 1, scaling is linear
  const k9 = bladeConstants({ blades: 9, curvature: 0.6, angleDeg: 0 });
  for (let i = 0; i < 64; i++) {
    const th = (i / 64) * 2 * Math.PI, r = bladeRho(k9, th);
    near(apertureGauge(k9, 0, 0, r * Math.cos(th), r * Math.sin(th)), 1, 1e-9);
    near(apertureGauge(k9, 0, 0, 0.3 * r * Math.cos(th), 0.3 * r * Math.sin(th)), 0.3, 1e-9);
  }
});

test("A7.4 aperture pattern: uniform over the polygon, centroid at the centre, inside the unit circle, gauge = spiral radius", () => {
  for (const shape of [{ blades: 9, curvature: 0.6, angleDeg: 0 }, { blades: 5, curvature: 0, angleDeg: 13 }, { blades: 0, curvature: 0, angleDeg: 0 }]) {
    for (const n of [24, 32, 48, 64]) {
      const { pts, areaRatio } = aperturePattern(shape, n);
      const k = bladeConstants(shape);
      let cx = 0, cy = 0, w = 0;
      for (let i = 0; i < n; i++) {
        const x = pts[4 * i], y = pts[4 * i + 1], u = pts[4 * i + 2], om = pts[4 * i + 3];
        assert.ok(Math.hypot(x, y) <= 1 + 1e-6, "inscribed");
        near(apertureGauge(k, 0, 0, x, y), u, 1e-5, "gauge = the spiral radius");
        cx += om * x; cy += om * y; w += om;
      }
      near(w, n, 1e-3, "weights sum to n");
      assert.ok(Math.hypot(cx / w, cy / w) < 1.6 / n, `area-weighted centroid at the centre (${shape.blades} blades, n ${n}: ${Math.hypot(cx / w, cy / w)})`);
      assert.ok(areaRatio > 0.7 && areaRatio <= 1);
    }
  }
  // uniform over the polygon: the weighted share of points within gauge ρ is ρ² (± 1.5 points)
  const { pts } = aperturePattern({ blades: 9, curvature: 0.6, angleDeg: 0 }, 64);
  for (const rho of [0.25, 0.5, 0.75, 1]) {
    let s = 0;
    for (let i = 0; i < 64; i++) if (pts[4 * i + 2] <= rho) s += pts[4 * i + 3];
    near(s, 64 * rho * rho, 1.5 + 0.1 * 64 * rho * rho, `ρ = ${rho}`);
  }
});

test("A7.3 cat's eye: vesica of two offset unit circles, tangential lemon, area shrinks monotonically toward the corner", () => {
  // the vesica boundary has gauge 1: along b at 1 − |b|, across at √(1 − |b|²)
  near(vesicaGauge(0.6, 0, 0.4, 0), 1, 1e-12);
  near(vesicaGauge(0, Math.sqrt(1 - 0.16), 0.4, 0), 1, 1e-12);
  near(vesicaGauge(0.3, 0.2, 0, 0), Math.hypot(0.3, 0.2), 1e-12, "no offset: the circle");
  // b points radially: at the right edge b ∥ x, so the lemon is long in y (tangential)
  const [bx, by] = catsEyeOffset(1, 1, 0, 16 / 10);
  assert.ok(bx > 0 && Math.abs(by) < 1e-12);
  near(Math.hypot(...catsEyeOffset(1, 1, 1, 16 / 10)), CATS_EYE_MAX, 1e-12, "|b| = 0.6 at the corner");
  assert.deepEqual(catsEyeOffset(0.3, 0, 0, 1.5), [0, 0], "no cat's eye on the optical axis");
  // the clipped area falls monotonically from the centre to the corner (the table and the pattern agree)
  const shape = { blades: 9, curvature: 0.6, angleDeg: 0 };
  const table = clipAreaTable(shape, 16);
  near(table[0], 1, 1e-6);
  for (let j = 1; j < table.length; j++) assert.ok(table[j] <= table[j - 1] + 1e-12, "monotone");
  // two unit circles at ±0.6: a lens of area 2(acos 0.6 − 0.6·0.8)/π = 0.285 of the circle
  assert.ok(table[table.length - 1] < 0.4 && table[table.length - 1] > 0.2, `strong clip at the corner (${table[table.length - 1]})`);
  let prev = Infinity;
  for (let i = 0; i <= 10; i++) {
    const [x, y] = catsEyeOffset(1, i / 10, (i / 10) * 0.9, 1.6);
    const a = clipAreaAt(table, Math.hypot(x, y));
    assert.ok(a <= prev + 1e-12, "area shrinks toward the edges");
    prev = a;
  }
  // the vesica is centred: the clipped pattern's centroid stays at the centre
  const { pts } = aperturePattern(shape, 4096);
  for (const b of [0.2, 0.4, 0.6]) {
    let cx = 0, cy = 0, w = 0;
    for (let i = 0; i < 4096; i++) {
      const g = apertureGauge(bladeConstants(shape), b * 0.6, b * 0.8, pts[4 * i], pts[4 * i + 1]);
      if (g <= 1) { cx += pts[4 * i + 3] * pts[4 * i]; cy += pts[4 * i + 3] * pts[4 * i + 1]; w += pts[4 * i + 3]; }
    }
    assert.ok(Math.hypot(cx / w, cy / w) < 0.01, `clipped centroid at the centre (|b| ${b})`);
  }
});

test("A7.3 bokeh rim profile: energy-conserving for every strength, sign flips between fields", () => {
  for (const s of [-1, -0.5, -0.15, 0, 0.15, 0.5, 1]) {
    let e = 0, minI = Infinity;
    const m = 20000;
    for (let i = 0; i < m; i++) { const t = (i + 0.5) / m; const I = rimProfile(t, s); e += I * 2 * t / m; minI = Math.min(minI, I); }
    near(e, 1, 1e-6, `∫ I·2t dt (s = ${s})`);
    assert.ok(minI >= -1e-9, "non-negative");
  }
  assert.ok(rimProfile(1, 0.5) > rimProfile(0, 0.5), "bright rim");
  assert.ok(rimProfile(1, -0.5) < rimProfile(0, -0.5), "soft edge");
  assert.equal(fieldRim(0.15, true), 0.15);
  assert.equal(fieldRim(0.15, false), -0.15, "under-corrected: soft foreground bokeh");
});

test("A7.3 f-number series: f/0.95, then third stops to f/22; default f/2.8", () => {
  assert.equal(F_STOPS[0], "0.95");
  assert.equal(F_STOPS[F_STOPS.length - 1], "22");
  assert.ok(F_STOPS.includes(DEFAULT_F_STOP));
  const xs = F_STOPS.map(Number);
  for (let i = 1; i < xs.length; i++) {
    const stops = 2 * Math.log2(xs[i] / xs[i - 1]);
    assert.ok(stops > 0.14 && stops < 0.5, `${xs[i - 1]} → ${xs[i]}: ${stops} stops`);
  }
  near(2 * Math.log2(22 / 1), 8.92, 0.01, "f/1 → f/22 ≈ 9 stops");
});
