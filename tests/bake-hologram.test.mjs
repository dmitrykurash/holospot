// tools/bake-hologram.mjs: what it bakes is the shape that went in, holospot's own loader reads its files, and its
// limits are refused with a message that says what is wrong. The grids here are small (--cells 32 or 40), so the
// whole file runs in about a second; the full-size bakes are proved against the shipped subjects by hand (the tool's
// header lists the options that reproduce each one byte for byte).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { bakeGlb, bakeSvg, decodeSdf, encodeSdf, sampleField } from "../tools/bake-hologram.mjs";
import { parseSdf, sdfAt } from "../engine/physics/volume.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "tools", "bake-hologram.mjs");

/** A hand-made binary glTF 2.0 file: one mesh of the given positions and triangle indices. `extra` is merged into
 *  the glTF JSON (to build files the baker must refuse). */
function glb(positions, indices, extra = {}) {
  const pos = Buffer.from(new Float32Array(positions).buffer), idx = Buffer.from(new Uint16Array(indices).buffer);
  const posOffset = Math.ceil(idx.length / 4) * 4;
  const bin = Buffer.alloc(Math.ceil((posOffset + pos.length) / 4) * 4);
  idx.copy(bin, 0); pos.copy(bin, posOffset);
  const gltf = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: idx.length }, { buffer: 0, byteOffset: posOffset, byteLength: pos.length }],
    accessors: [{ bufferView: 0, componentType: 5123, count: indices.length, type: "SCALAR" }, { bufferView: 1, componentType: 5126, count: positions.length / 3, type: "VEC3" }],
    ...extra,
  };
  let json = Buffer.from(JSON.stringify(gltf), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20), binHead = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + json.length + bin.length, 8);
  head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, json, binHead, bin]);
}

/** A closed box with the given centre and half sizes (8 vertices, 12 triangles). */
function boxGlb(centre, half, extra) {
  const positions = [];
  for (let v = 0; v < 8; v++) for (let a = 0; a < 3; a++) positions.push(centre[a] + ((v >> a) & 1 ? half[a] : -half[a]));
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return glb(positions, indices, extra);
}

/** Exact signed distance to an origin-centred box of half sizes b. */
function boxSdf(p, b) {
  const q = [Math.abs(p[0]) - b[0], Math.abs(p[1]) - b[1], Math.abs(p[2]) - b[2]];
  return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0);
}

/** Every voxel of a baked volume against an exact distance function: same sign, and the stored magnitude is the
 *  true one rounded as the format rounds it (nearest half float below 0.02, at most 1/64 short beyond, never above). */
function assertField(vol, exact, label) {
  let inside = 0;
  for (let k = 0; k < vol.nz; k++) for (let j = 0; j < vol.ny; j++) for (let i = 0; i < vol.nx; i++) {
    const p = [vol.bmin[0] + i * vol.h, vol.bmin[1] + j * vol.h, vol.bmin[2] + k * vol.h];
    const want = exact(p), got = sdfAt(vol, p), where = `${label}: voxel (${i},${j},${k})`;
    if (got < 0) inside++;
    assert.equal(Math.sign(got), Math.sign(want), `${where} has the wrong sign (${got} for ${want})`);
    assert.ok(Math.abs(got) <= Math.abs(want) + 2e-5, `${where} overshoots: ${got} for ${want}`);
    assert.ok(Math.abs(got) >= Math.abs(want) * (1 - 1 / 64) - 2e-5, `${where} falls short: ${got} for ${want}`);
  }
  return inside;
}

test("a box model bakes into the box, in a file holospot's loader reads", () => {
  // 4 × 2 × 1, far from the origin: the baker centres it and scales its longest side to 1
  const baked = bakeGlb(boxGlb([10, -7, 3], [2, 1, 0.5]), "box.glb", { cells: 32 });
  assert.equal(baked.triangles, 12);
  assert.deepEqual(baked.grid.n, [38, 22, 14], "cells + 6 on the longest side, ceil(extent · cells) + 6 on the others");
  const { raw, gz } = encodeSdf(baked.grid, baked.values, baked.triangles, [10, 20]);
  const vol = parseSdf(new Uint8Array(gunzipSync(gz)));                  // holospot's loader (engine/physics/volume.ts)
  assert.deepEqual([vol.nx, vol.ny, vol.nz], [38, 22, 14]);
  assert.equal(vol.h, 1 / 32);
  assert.equal(vol.basePitchDeg, 10);
  assert.equal(vol.baseYawDeg, 20);
  assert.equal(vol.triangles, 12);
  assert.deepEqual(vol.bmin, [-18.5 / 32, -10.5 / 32, -6.5 / 32], "the grid is centred on the box");
  const inside = assertField(vol, (p) => boxSdf(p, [0.5, 0.25, 0.125]), "box");
  assert.equal(inside, 32 * 16 * 8, "the voxels inside are exactly the box");
  // the tool's own decoder accepts the file and gives back the same bytes
  const dec = decodeSdf(gz, "box.sdf");
  assert.ok(dec.raw.equals(raw));
  assert.equal(sampleField(dec.field, dec.hdr, 0.1, 0.05, 0.02), sdfAt(vol, [0.1, 0.05, 0.02]));
});

test("--rotate turns the model into the object frame before it is measured", () => {
  // the same box turned a quarter about y: its long side now runs along z
  const turned = bakeGlb(boxGlb([0, 0, 0], [2, 1, 0.5]), "box.glb", { cells: 32, rotate: [0, 90, 0] });
  assert.deepEqual(turned.grid.n, [14, 22, 38]);
  const vol = parseSdf(new Uint8Array(gunzipSync(encodeSdf(turned.grid, turned.values, turned.triangles).gz)));
  assertField(vol, (p) => boxSdf(p, [0.125, 0.25, 0.5]), "turned box");
});

test("the same input gives the same bytes, and the gzip header carries no time and no platform", () => {
  const bake = () => { const b = bakeGlb(boxGlb([1, 2, 3], [1, 1, 1]), "cube.glb", { cells: 32 }); return encodeSdf(b.grid, b.values, b.triangles, [0, 15]).gz; };
  const a = bake(), b = bake();
  assert.ok(a.equals(b));
  assert.deepEqual([...a.subarray(0, 4)], [0x1f, 0x8b, 8, 0], "gzip, deflate, no flags (no file name)");
  assert.equal(a.readUInt32LE(4), 0, "no modification time");
  assert.equal(a[9], 3, "the OS byte is pinned");
});

test("a logo bakes into its extruded shape", () => {
  // a 100 × 50 rectangle, depth 0.2 of its longest side, sharp edges: a box of half sizes 0.5 × 0.25 × 0.1
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path d="M100 50h100v50H100z"/></svg>`;
  const baked = bakeSvg(svg, "rect.svg", { cells: 40, depth: 0.2, bevel: 0 });
  assert.equal(baked.triangles, 0);
  assert.deepEqual(baked.grid.n, [46, 26, 14]);
  const vol = parseSdf(new Uint8Array(gunzipSync(encodeSdf(baked.grid, baked.values, 0).gz)));
  assert.equal(vol.h, Math.fround(1 / 40));
  const sharp = assertField(vol, (p) => boxSdf(p, [0.5, 0.25, 0.1]), "extruded rectangle");
  assert.equal(sharp, 40 * 20 * 8);
  // a chamfer cuts the edges of both faces and nothing else
  const bevelled = bakeSvg(svg, "rect.svg", { cells: 40, depth: 0.2, bevel: 0.05 });
  const bvol = parseSdf(new Uint8Array(gunzipSync(encodeSdf(bevelled.grid, bevelled.values, 0).gz)));
  const at = (v, p) => sdfAt(v, p);
  assert.ok(at(bvol, [0.4875, 0, 0.0875]) > 0 && at(vol, [0.4875, 0, 0.0875]) < 0, "the edge of the face is cut");
  assert.equal(at(bvol, [0, 0, 0]), at(vol, [0, 0, 0]), "the middle is untouched");
  assert.ok(at(bvol, [0.4875, 0, 0]) < 0, "the side wall remains");
});

test("a logo with a hole: the fill rule decides what is inside", () => {
  const ring = "M0 0h100v100H0z M30 30h40v40H30z";                        // both squares drawn the same way round
  const hole = (rule) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path ${rule ? `fill-rule="${rule}" ` : ""}d="${ring}"/></svg>`;
    const b = bakeSvg(svg, "ring.svg", { cells: 40 });
    return sdfAt(parseSdf(new Uint8Array(gunzipSync(encodeSdf(b.grid, b.values, 0).gz))), [0, 0, 0]);
  };
  assert.ok(hole("evenodd") > 0, "evenodd: the inner square is a hole");
  assert.ok(hole(null) < 0, "nonzero (the default): the same winding fills it");
});

test("models beyond the limits are refused, and the message says why", () => {
  const box = (extra) => () => bakeGlb(boxGlb([0, 0, 0], [1, 1, 1], extra), "model.glb", { cells: 32 });
  assert.throws(() => bakeGlb(Buffer.from("o cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), "model.glb"), /model\.glb: not a GLB/);
  assert.throws(() => bakeGlb(Buffer.from('{"asset":{"version":"2.0"},"buffers":[{"uri":"model.bin"}]}'), "model.glb"), /not a GLB/, "a text glTF");
  assert.throws(box({ extensionsUsed: ["KHR_draco_mesh_compression"] }), /KHR_draco_mesh_compression; compressed meshes are not supported/);
  assert.throws(box({ extensionsUsed: ["EXT_meshopt_compression"] }), /EXT_meshopt_compression; compressed meshes are not supported/);
  assert.throws(box({ extensionsRequired: ["KHR_texture_basisu"] }), /requires unsupported extension "KHR_texture_basisu"/);
  assert.throws(box({ buffers: [{ byteLength: 144, uri: "model.bin" }] }), /no external or data-URI buffers/);
  assert.throws(box({ buffers: [{ byteLength: 144, uri: "data:application/octet-stream;base64,AAAA" }] }), /no external or data-URI buffers/);
  assert.throws(box({ meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0, mode: 1 }] }] }), /triangles only/);
  assert.throws(box({ nodes: [] , scenes: [{ nodes: [] }] }), /no triangles in the default scene/);
  // a model without any size cannot be scaled to fit
  assert.throws(() => bakeGlb(glb([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2]), "dot.glb"), /dot\.glb: the model has no size/);
  // a file that lies about its sizes is caught before anything is read out of bounds
  const lying = boxGlb([0, 0, 0], [1, 1, 1], { accessors: [{ bufferView: 0, componentType: 5123, count: 36, type: "SCALAR" }, { bufferView: 1, componentType: 5126, count: 9000, type: "VEC3" }] });
  assert.throws(() => bakeGlb(lying, "lying.glb"), /POSITION accessor runs past its bufferView/);
});

test("logos beyond the limits are refused, and the message says why", () => {
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  assert.throws(() => bakeSvg(svg(`<rect width="10" height="10"/>`), "logo.svg"), /logo\.svg: no <path> elements/);
  assert.throws(() => bakeSvg(svg(`<path d="M0 0A5 5 0 0 1 10 10z"/>`), "logo.svg"), /logo\.svg: svg path: arcs \(A\) are not supported/);
  assert.throws(() => bakeSvg(svg(`<g transform="scale(2)"><path d="M0 0h10v10z"/></g>`), "logo.svg"), /logo\.svg: transforms are not supported/);
  assert.throws(() => bakeSvg(svg(`<path fill-rule="evenodd" d="M0 0h10v10z"/><path d="M20 0h10v10z"/>`), "logo.svg"), /mixed fill rules/);
  assert.throws(() => bakeSvg(svg(`<path d='M0 0h10v10z'/>`), "logo.svg"), /no outline found/);
  assert.throws(() => bakeSvg(svg(`<path d="M5 5"/>`), "logo.svg"), /no outline found/);
});

test("a grid holospot's loader would refuse is refused before it is baked", () => {
  const square = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10H0z"/></svg>`;
  assert.throws(() => bakeSvg(square, "square.svg", { cells: 320, depth: 0.5 }), /more than holospot loads \(192³ = 7077888\); lower --cells or --depth/);
  assert.throws(() => bakeGlb(boxGlb([0, 0, 0], [1, 1, 1]), "cube.glb", { cells: 200 }), /more than holospot loads/);
});

test("the decoder names what is wrong with a damaged file", () => {
  const b = bakeGlb(boxGlb([0, 0, 0], [1, 1, 1]), "cube.glb", { cells: 16 });
  const { raw } = encodeSdf(b.grid, b.values, b.triangles);
  const damaged = (change) => { const r = Buffer.from(raw); change(r); return gzipSync(r); };
  assert.throws(() => decodeSdf(Buffer.from("not a subject"), "x.sdf"), /x\.sdf: not a gzip file/);
  assert.throws(() => decodeSdf(damaged((r) => r.write("HSDX", 0, "ascii")), "x.sdf"), /bad magic/);
  assert.throws(() => decodeSdf(damaged((r) => r.writeUInt32LE(2, 4)), "x.sdf"), /format version 2/);
  assert.throws(() => decodeSdf(damaged((r) => r.writeUInt32LE(7, 44)), "x.sdf"), /encoding 7/);
  assert.throws(() => decodeSdf(damaged((r) => r.writeUInt32LE(23, 8)), "x.sdf"), /payload|dims|centred/);
  assert.throws(() => decodeSdf(damaged((r) => r.writeFloatLE(400, 40)), "x.sdf"), /default pose/);
  assert.throws(() => decodeSdf(gzipSync(raw.subarray(0, raw.length - 2)), "x.sdf"), /payload/);
  assert.throws(() => decodeSdf(damaged((r) => r.writeUInt16LE(0x7c00, 64 + 2 * 5000)), "x.sdf"), /voxel 5000 holds Infinity/);
  assert.throws(() => decodeSdf(damaged((r) => r.writeUInt16LE(0xbc00, 64)), "x.sdf"), /border voxel \(0,0,0\) is not outside/);
});

test("every subject holospot ships is valid for the decoder and for holospot's loader, and both read the same", () => {
  const dir = join(ROOT, "assets", "holo3d");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sdf")).sort();
  assert.ok(files.length >= 7, `expected the seven shipped subjects, found ${files.length}`);
  for (const f of files) {
    const bytes = readFileSync(join(dir, f));
    const dec = decodeSdf(bytes, f), vol = parseSdf(new Uint8Array(gunzipSync(bytes)));
    assert.deepEqual(dec.hdr.n, [vol.nx, vol.ny, vol.nz], f);
    assert.deepEqual([dec.hdr.h, dec.hdr.basePitchDeg, dec.hdr.baseYawDeg, dec.hdr.triangles], [vol.h, vol.basePitchDeg, vol.baseYawDeg, vol.triangles], f);
    assert.ok(dec.field.some((v) => v < 0), `${f}: no voxel is inside the subject`);
  }
});

test("the command line: bake, --verify, and a wrong call", () => {
  mkdirSync(join(ROOT, ".cache"), { recursive: true });                  // git-ignored; the test cleans up after itself
  const dir = mkdtempSync(join(ROOT, ".cache", "test-bake-"));
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  try {
    const model = join(dir, "box.glb"), out = join(dir, "sub", "box.sdf");
    writeFileSync(model, boxGlb([0, 0, 0], [2, 1, 0.5]));
    const bake = run("--in", model, "--out", out, "--cells", "32", "--yaw", "15", "--pitch=-5", "--verify");
    assert.equal(bake.status, 0, bake.stderr);
    assert.match(bake.stdout, /grid 38 × 22 × 14 = 11704 voxels/);
    assert.match(bake.stdout, /default pose: pitch -5°, yaw 15°/);
    assert.match(bake.stdout, /"volume\.subject"/, "says how to use the file");
    const vol = parseSdf(new Uint8Array(gunzipSync(readFileSync(out))));
    assert.deepEqual([vol.nx, vol.ny, vol.nz, vol.basePitchDeg, vol.baseYawDeg], [38, 22, 14, -5, 15]);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["box.sdf"], "no temporary file is left beside the output");

    const verify = run("--verify", out);
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /valid/);
    assert.match(verify.stdout, /12 triangles/);

    writeFileSync(join(dir, "broken.sdf"), readFileSync(out).subarray(0, 200));
    const broken = run("--verify", join(dir, "broken.sdf"));
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /broken\.sdf: not a gzip file/);

    const wrong = run("--in", join(dir, "model.obj"), "--out", out);
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /GLB only \(binary glTF 2\.0/);
    assert.match(wrong.stderr, /filled <path> elements only/);
    assert.equal(run("--in", model).status, 2, "--out is required");
    assert.equal(run("--in", model, "--out", out, "--depth", "0.1").status, 2, "--depth is for logos");
    assert.equal(run("--in", model, "--out", out, "--yaw", "east").status, 2);
    assert.equal(run("--help").status, 0);

    writeFileSync(join(dir, "draco.glb"), boxGlb([0, 0, 0], [1, 1, 1], { extensionsUsed: ["KHR_draco_mesh_compression"] }));
    const draco = run("--in", join(dir, "draco.glb"), "--out", join(dir, "draco.sdf"));
    assert.equal(draco.status, 1);
    assert.match(draco.stderr, /draco\.glb: uses KHR_draco_mesh_compression/);
    assert.match(draco.stderr, /no Draco, no Meshopt, no external or data-URI buffers/);
    assert.ok(!readdirSync(dir).includes("draco.sdf"), "nothing is written when the bake fails");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
