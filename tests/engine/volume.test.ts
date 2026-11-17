// Addendum A5 Volume Hologram: the CPU twin of the replay optics (src/physics/volume.ts) — tangential replay, Bragg
// wavelength vs geometry, rainbow wavelength vs vertical angle, the replay window, the pose rotation — the SDF file format
// and the baked subjects in public/holo3d/, and the material's ParamSpecs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Vec3 } from "../../engine/types.ts";
import {
  VOLUME_N, VOLUME_SLIT_ELEVATION_DEG, braggReplay, cosInside, encodeSdf, isGzip, padDirection, parseSdf, rainbowReplay, replayDirection, replayWindow,
  sdfAt, sdfBmax, slitDirection, volumeFromFunction, volumeRotation,
} from "../../engine/physics/volume.ts";
import { VOLUME_BACKDROPS, VOLUME_PARAMS, VOLUME_PATTERNS, VOLUME_SUBJECTS, isPatternBackdrop, patternUniformValues, recordingUniformValues, volumeDial, volumeSubjectOf } from "../../engine/materials/volume.params.ts";
import { EMBOSS_PARAMS, embossDial, stickerVolumeValues } from "../../engine/materials/emboss.params.ts";
import { checkConsistency } from "../../engine/ui/dialConfig.ts";
import { toHalf } from "../../engine/spectral/half.ts";

const D2R = Math.PI / 180;
let seed = 99;
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
/** A random direction above the surface with sin θ ≤ r. */
const dir = (r: number): Vec3 => { const a = 2 * Math.PI * rnd(), s = r * Math.sqrt(rnd()); return padDirection(s * Math.cos(a), s * Math.sin(a)); };
/** Direction at polar angle θ (deg) in the vertical plane (y up), above the surface. */
const vert = (thDeg: number): Vec3 => [0, Math.sin(thDeg * D2R), Math.cos(thDeg * D2R)];
const close = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (± ${eps})`);

test("A5 replay identity: light at the reference and λ = λ_r ⇒ π̂′ = −v̂ (both types' tangential equation)", () => {
  for (let i = 0; i < 200; i++) {
    const rho = dir(0.9), v = dir(0.95);
    const pi = replayDirection(rho, rho, v, 545, 545);
    assert.ok(pi, "never evanescent at the reference geometry");
    for (let k = 0; k < 3; k++) close(pi![k], -v[k], 1e-12, `component ${k}`);
  }
});

test("A5 tangential replay: π̂′ₜ = ρ̂ₜ − (λ_r/λ)(v̂ₜ + ℓ̂ₜ), unit, into the sticker; evanescent beyond |π̂′ₜ| = 1", () => {
  const rho = padDirection(-0.3, 0.55), l: Vec3 = padDirection(0.1, 0.2), v: Vec3 = padDirection(0, 0);
  const pi = replayDirection(rho, l, v, 545, 600)!;
  close(pi[0], -0.3 - (545 / 600) * 0.1, 1e-12);
  close(pi[1], 0.55 - (545 / 600) * 0.2, 1e-12);
  assert.ok(pi[2] < 0);
  close(Math.hypot(...pi), 1, 1e-12);
  // a light far on the other side (below) pushes π̂′ past the horizon: nothing is replayed (spot B of the studio)
  assert.equal(replayDirection(rho, padDirection(-0.25, -0.68), v, 545, 545), null);
  // the recorded fringe frequency f = (ρ̂ₜ − π̂ₜ)/λ_r diffracts ℓ̂ into v̂: v̂ₜ = −ℓ̂ₜ + λ f
  const f = [(rho[0] - pi[0]) / 545, (rho[1] - pi[1]) / 545];
  close(-l[0] + 600 * f[0], v[0], 1e-12);
  close(-l[1] + 600 * f[1], v[1], 1e-12);
});

test("A5 Bragg wavelength: λ_r at the reference geometry for every eye; the exact 3D Bragg condition holds", () => {
  for (let i = 0; i < 100; i++) {
    const rho = dir(0.85), v = dir(0.8);
    const b = braggReplay(rho, rho, v, 545, VOLUME_N, 6);
    assert.ok(b);
    close(b!.lambda, 545, 1e-9, "λ_B at the reference geometry");
  }
  // any geometry: (1/λ)(v′ + ℓ′) = (1/λ_r)(ρ′ − π′_in) in all three components (internal unit vectors × n)
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const rho = dir(0.85), l = dir(0.9), v = dir(0.8);
    const b = braggReplay(rho, l, v, 545, VOLUME_N, 12);
    if (!b) continue;
    n++;
    const lam = b.lambda, pi = b.pi;
    const nz = (d: Vec3) => VOLUME_N * cosInside(d[0], d[1]);          // n·(internal cosine): the normal wave-vector part
    close((v[0] + l[0]) / lam, (rho[0] - pi[0]) / 545, 1e-12, "tangential x");
    close((v[1] + l[1]) / lam, (rho[1] - pi[1]) / 545, 1e-12, "tangential y");
    close((nz(v) + nz(l)) / lam, (nz(rho) + nz(pi)) / 545, 1e-7, "normal (Bragg)");
  }
  assert.ok(n > 150, `${n} replayable cases`);
});

test("A5 Bragg wavelength vs incidence: coaxial light → red (λ_r/c_ρ′), steep symmetric geometry → blue, monotone", () => {
  const rho = vert(45);
  // eye and light along the normal: the replayed component is the one recorded along the reference mirror, λ = λ_r/c_ρ′
  const co = braggReplay(rho, vert(0), vert(0), 545)!;
  close(co.lambda, 545 / cosInside(0, Math.sin(45 * D2R)), 1e-6, "coaxial");
  assert.ok(co.lambda > 600 && co.lambda < 630, `coaxial λ ${co.lambda}`);
  // tilting the sticker under a fixed light at the reference: the light goes steeper (θ_ℓ = 45° + τ) and the eye leaves
  // the normal the other way (θ_v = −τ); λ_B falls monotonically (blue shift at steep angles)
  let prev = Infinity;
  const rows: string[] = [];
  for (const tau of [0, 5, 10, 15, 20, 25]) {
    const b = braggReplay(rho, vert(45 + tau), vert(-tau), 545);
    assert.ok(b, `τ ${tau}°`);
    rows.push(`${tau}°: ${b!.lambda.toFixed(1)} nm`);
    assert.ok(b!.lambda < prev + 1e-9, `monotone at τ ${tau}°: ${rows.join(", ")}`);
    prev = b!.lambda;
  }
  assert.ok(prev < 520, `τ 25° shifts toward blue: ${rows.join(", ")}`);
  // the other way (light toward the normal, eye toward the light): toward red
  assert.ok(braggReplay(rho, vert(30), vert(10), 545)!.lambda > 545);
});

test("A5 rainbow wavelength vs vertical angle: λ_c = λ_r(v_y + ℓ_y)/(ρ_y − π_y0), eye higher → redder; horizontal parallax kept", () => {
  const rho = vert(33.4), l = rho;                      // light at the reference (from above)
  const lam = (thEye: number) => rainbowReplay(rho, l, vert(thEye), 545, 0)!.lambda;
  close(lam(0), 545, 1e-9, "straight-on: the design colour");
  const ls = [-12, -8, -4, 0, 4, 8].map(lam);
  for (let i = 1; i < ls.length; i++) assert.ok(ls[i] > ls[i - 1], `monotone: ${ls.map((x) => x.toFixed(0))}`);
  assert.ok(ls[1] < 470 && ls[5] > 650, `the visible spectrum within ±8° of vertical tilt: ${ls.map((x) => x.toFixed(0))}`);
  // vertical parallax is absent: π̂′_y is pinned to the slit whatever the vertical eye angle
  for (const th of [-6, 0, 6]) close(rainbowReplay(rho, l, vert(th), 545, 0.02)!.pi[1], 0.02, 1e-12);
  // horizontal eye motion changes π̂′_x (parallax), not λ
  const a = rainbowReplay(rho, l, padDirection(0.15, 0), 545, 0)!, b = rainbowReplay(rho, l, padDirection(-0.15, 0), 545, 0)!;
  close(a.lambda, b.lambda, 1e-9);
  assert.ok(a.pi[0] < -0.1 && b.pi[0] > 0.1);
  // the slit direction at the design distance: the colour is uniform over the sticker seen from the slit
  const D = 330;
  for (const elev of [0, VOLUME_SLIT_ELEVATION_DEG]) {
    const hs = D * Math.tan(elev * D2R);
    for (const y of [-40, 0, 40]) {
      const eye: Vec3 = (() => { const d = Math.hypot(hs - y, D); return [0, (hs - y) / d, D / d]; })();   // (0, y) → the slit
      close(rainbowReplay(rho, l, eye, 545, slitDirection(y, D, elev))!.lambda, 545, 1e-9, `y ${y} mm, slit ${elev}°`);
    }
  }
  close(Math.atan(D * Math.tan(VOLUME_SLIT_ELEVATION_DEG * D2R) / D) / D2R, 4, 1e-9);
  close(330 * Math.tan(4 * D2R), 23.08, 0.01, "VOL_SLIT_H of holo_volume.frag");
  assert.equal(rainbowReplay(rho, vert(-50), vert(-20), 545, 0), null, "no positive wavelength");
  // a reference from below (the default, the studio's spot B): the same equation with both terms negative
  const lo = vert(-42.8), below = (th: number) => rainbowReplay(lo, lo, vert(th), 545, 0)!.lambda;
  close(below(0), 545, 1e-9);
  assert.ok(below(6) < 545 && below(-6) > 545, "eye higher → bluer for a reference from below");
});

test("A5 replay window: 1 straight on, exp(−½) at σ, symmetric", () => {
  close(replayWindow([0, 0, -1], 0.3), 1, 1e-12);
  const s = 18 * D2R, d: Vec3 = [Math.sin(s), 0, -Math.cos(s)];
  close(replayWindow(d, s), Math.exp(-0.5), 1e-9);
  close(replayWindow([-d[0], 0, d[2]], s), Math.exp(-0.5), 1e-9);
});

test("A5 pose rotation: orthonormal; pitch > 0 tips the top toward the viewer, yaw > 0 turns the front toward +x", () => {
  for (const [y, p] of [[0, 0], [30, -10], [-120, 45], [180, 90]]) {
    const R = volumeRotation(y, p);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const d = R[3 * i] * R[3 * j] + R[3 * i + 1] * R[3 * j + 1] + R[3 * i + 2] * R[3 * j + 2];
      close(d, i === j ? 1 : 0, 1e-12);
    }
  }
  const P = volumeRotation(0, 20), top = [P[1], P[4], P[7]];         // R·(0, 1, 0)
  assert.ok(top[2] > 0.3, "top toward +z");
  const Y = volumeRotation(20, 0), front = [Y[2], Y[5], Y[8]];       // R·(0, 0, 1)
  assert.ok(front[0] > 0.3, "front toward +x");
});

test("A5 SDF format: encode/parse round trip, gzip detection, malformed files rejected", () => {
  const v = volumeFromFunction(12, (p) => Math.hypot(p[0], p[1], p[2]) - 0.3);
  const bytes = encodeSdf(v);
  assert.equal(bytes.length, 64 + 2 * 12 ** 3);
  assert.ok(!isGzip(bytes));
  const w = parseSdf(bytes);
  assert.deepEqual([w.nx, w.ny, w.nz], [12, 12, 12]);
  close(w.h, v.h, 1e-7);
  assert.deepEqual(Array.from(w.data), Array.from(v.data));
  close(sdfAt(w, [0, 0, 0]), -0.3, 2e-3);
  close(sdfAt(w, [0.4, 0, 0]), 0.1, 2e-3);
  const bad = (f: (b: Uint8Array) => void, re: RegExp) => { const b = bytes.slice(); f(b); assert.throws(() => parseSdf(b), re); };
  bad((b) => { b[0] = 0x58; }, /magic/);
  bad((b) => { new DataView(b.buffer).setUint32(4, 2, true); }, /version/);
  bad((b) => { new DataView(b.buffer).setUint32(8, 100000, true); }, /dimensions/);
  bad((b) => { new DataView(b.buffer).setUint32(44, 7, true); }, /encoding/);
  bad((b) => { new DataView(b.buffer).setFloat32(32, Number.NaN, true); }, /placement/);
  assert.throws(() => parseSdf(bytes.slice(0, bytes.length - 2)), /bytes/);
  assert.throws(() => parseSdf(bytes.slice(0, 20)), /header/);
  assert.equal(toHalf(-0.3) >= 0x8000, true);
});

test("A5 baked subjects: every public/holo3d/<subject>.sdf parses, fits the limits, is inside at its body and outside at the corners", () => {
  for (const s of VOLUME_SUBJECTS) {
    const file = new URL(`../../assets/holo3d/${s}.sdf`, import.meta.url);
    assert.ok(existsSync(file), `${s}.sdf exists`);
    const raw = new Uint8Array(readFileSync(file));
    assert.ok(raw.length <= 4 * 1024 * 1024, `${s}: ${raw.length} bytes ≤ 4 MB`);
    assert.ok(isGzip(raw), `${s} is gzip-compressed`);
    const v = parseSdf(new Uint8Array(gunzipSync(raw)));
    // mesh subjects: 128 cells across; SVG emblems (tools/svg-extrude.mjs) a finer but thin grid
    assert.ok(Math.max(v.nx, v.ny, v.nz) <= 400 && v.nx * v.ny * v.nz <= 160 ** 3, `${s}: ${v.nx}×${v.ny}×${v.nz}`);
    const hi = sdfBmax(v);
    const ext = [hi[0] - v.bmin[0], hi[1] - v.bmin[1], hi[2] - v.bmin[2]];
    assert.ok(Math.max(...ext) > 0.98 && Math.max(...ext) < 1.15, `${s}: longest extent ${Math.max(...ext)} ≈ 1 + margin`);
    // the corners of the grid are outside (positive); some voxel is well inside; the zero level exists
    for (const c of [[0, 0, 0], [1, 1, 1], [1, 0, 1], [0, 1, 0]]) {
      const p: Vec3 = [c[0] ? hi[0] : v.bmin[0], c[1] ? hi[1] : v.bmin[1], c[2] ? hi[2] : v.bmin[2]];
      assert.ok(sdfAt(v, p) > 0, `${s}: corner ${c} outside`);
    }
    let minD = Infinity, inside = 0;
    for (let i = 0; i < v.data.length; i += 7) {
      const h = v.data[i], neg = (h & 0x8000) !== 0 && (h & 0x7fff) !== 0;
      if (neg) inside++;
    }
    for (let k = 0; k < 2000; k++) minD = Math.min(minD, sdfAt(v, [v.bmin[0] + rnd() * ext[0], v.bmin[1] + rnd() * ext[1], v.bmin[2] + rnd() * ext[2]]));
    assert.ok(inside > 50, `${s}: ${inside} sampled voxels inside`);
    assert.ok(minD < -0.005, `${s}: deepest sampled distance ${minD}`);
  }
});

test("A5 panel: checkConsistency clean, ids in the volume namespace, defaults on the step grid, subject fallback", () => {
  assert.deepEqual(checkConsistency(volumeDial, VOLUME_PARAMS), []);
  for (const p of VOLUME_PARAMS) {
    assert.ok(p.id.startsWith("volume."), p.id);
    if (p.kind === "slider") {
      const k = ((p.default as number) - (p.min as number)) / (p.step as number);
      assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `${p.id} default off its grid`);
    }
  }
  assert.equal(volumeSubjectOf({ "volume.subject": "wolf" }), "wolf");
  assert.equal(volumeSubjectOf({ "volume.subject": "../../etc/passwd" }), "eagle");
  assert.equal(volumeSubjectOf({}), "eagle");
});

test("A10 backdrops: A5's none / grid / stars keep their uniform indices 0–2, the diffractive patterns follow; the card keeps grid, the sticker opens on seal", () => {
  assert.deepEqual(VOLUME_BACKDROPS.slice(0, 3), ["none", "grid", "stars"]);
  assert.deepEqual(VOLUME_BACKDROPS.slice(3), [...VOLUME_PATTERNS]);
  for (const b of VOLUME_BACKDROPS) assert.equal(isPatternBackdrop(b), VOLUME_BACKDROPS.indexOf(b) >= 3, b);
  const card = VOLUME_PARAMS.find((p) => p.id === "volume.backdrop")!;
  assert.equal(card.default, "grid");
  assert.deepEqual(card.options, [...VOLUME_BACKDROPS]);
  const sticker = EMBOSS_PARAMS.find((p) => p.id === "emboss.holo.backdrop")!;
  assert.equal(sticker.default, "seal");
  assert.deepEqual(sticker.options, [...VOLUME_BACKDROPS]);
  const node = (embossDial as unknown as { hologram: { backdrop: { default: string } } }).hologram.backdrop;   // lifted to the folder's top
  assert.equal(node.default, "seal");
  assert.equal((volumeDial.image.backdrop as { default: string }).default, "grid", "the A5 node is never mutated by the sticker's copy");
  // the pattern controls exist on both panels (the sticker's size and depth relative to its shorter side)
  for (const id of ["patternSize", "lineWidth", "gratingPitch", "patternStrength", "patternRotation", "patternDepth"]) {
    assert.ok(VOLUME_PARAMS.some((p) => p.id === `volume.${id}`), id);
    assert.ok(EMBOSS_PARAMS.some((p) => p.id === `emboss.holo.${id}`), id);
  }
  assert.equal(EMBOSS_PARAMS.find((p) => p.id === "emboss.holo.patternSize")!.unit, "%");
  assert.equal(EMBOSS_PARAMS.find((p) => p.id === "emboss.holo.patternDepth")!.unit, "%");
});

test("A10 pattern uniforms: radius, line width, 1/Λ, strength, rotation and depth (sticker: relative to the shorter side), clamped", () => {
  const d = patternUniformValues({});
  assert.deepEqual(d.pat, [28, 0.22, 1 / 1000, 1]);
  assert.deepEqual(d.pat2, [1, 0, -3, 0]);
  const v = patternUniformValues({ "volume.patternSize": 20, "volume.lineWidth": 0.3, "volume.gratingPitch": 1250, "volume.patternStrength": 2,
    "volume.patternRotation": 90, "volume.patternDepth": -5 });
  close(v.pat[0], 20, 1e-12); close(v.pat[1], 0.3, 1e-12); close(v.pat[2], 0.0008, 1e-15); close(v.pat[3], 2, 1e-12);
  close(v.pat2[0], 0, 1e-12); close(v.pat2[1], 1, 1e-12); close(v.pat2[2], -5, 1e-12);
  const c = patternUniformValues({ "volume.gratingPitch": 10, "volume.patternDepth": 7, "volume.lineWidth": "abc" });
  close(c.pat[2], 1 / 300, 1e-12, "pitch clamped"); assert.equal(c.pat2[2], 0, "a pattern never lies in front of the film"); assert.equal(c.pat[1], 0.22);
  // the sticker: 50 % / −8 % of a 30 mm shorter side → R = 15 mm at 2.4 mm depth
  const sv: Record<string, string | number | boolean | { x: number; y: number }> = Object.fromEntries(EMBOSS_PARAMS.map((p) => [p.id, p.default as never]));
  const out = stickerVolumeValues(sv, 30);
  assert.equal(out["volume.backdrop"], "seal");
  const sp = patternUniformValues(out);
  close(sp.pat[0], 15, 1e-12); close(sp.pat2[2], -2.4, 1e-12);
});

test("A10 stereogram: the card stays optical (uVolRec.x = 0), the sticker opens as a stereogram; views, blend and zone converted and clamped", () => {
  assert.equal(VOLUME_PARAMS.find((p) => p.id === "volume.recording")!.default, "optical");
  assert.equal(EMBOSS_PARAMS.find((p) => p.id === "emboss.holo.recording")!.default, "stereogram");
  const d = recordingUniformValues({});
  assert.equal(d[0], 0); assert.equal(d[1], 20); close(d[2], 0.25, 1e-12); close(d[3], 30 * D2R, 1e-12);
  const v = recordingUniformValues({ "volume.recording": "stereogram", "volume.views": 12.4, "volume.viewBlend": 2, "volume.viewZone": 45 });
  assert.equal(v[0], 1); assert.equal(v[1], 12); assert.equal(v[2], 1); close(v[3], 45 * D2R, 1e-12);
  const sv: Record<string, string | number | boolean | { x: number; y: number }> = Object.fromEntries(EMBOSS_PARAMS.map((p) => [p.id, p.default as never]));
  assert.equal(recordingUniformValues(stickerVolumeValues(sv, 30))[0], 1);
});

test("A12 surface glare: the whole-card material keeps the physical mirror (1), the sticker opens low (0.15) with a longer view cross-fade and a wider slit", () => {
  const g = VOLUME_PARAMS.find((p) => p.id === "volume.glare")!;
  assert.equal(g.default, 1); assert.equal(g.uniform, "uVolGlare");
  const byId = (id: string) => EMBOSS_PARAMS.find((p) => p.id === id)!;
  assert.equal(byId("emboss.holo.glare").default, 0.15);
  assert.equal(byId("emboss.holo.viewBlend").default, 0.5);
  assert.equal(byId("emboss.holo.slit").default, 9);
  const film = (embossDial as unknown as { hologram: { film: Record<string, number[]> } }).hologram.film;
  assert.deepEqual(film["surface glare"], [0.15, 0, 1, 0.01]);
  assert.deepEqual(volumeDial.surface["surface glare"], [1, 0, 1, 0.01], "the A5 node is not mutated");
  const sv: Record<string, string | number | boolean | { x: number; y: number }> = Object.fromEntries(EMBOSS_PARAMS.map((p) => [p.id, p.default as never]));
  assert.equal(stickerVolumeValues(sv, 30)["volume.glare"], 0.15);
});
