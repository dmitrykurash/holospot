// src/data/params.json is an export of holo.spot's parameter tables (tools/export-data.mjs). The engine under engine/
// carries the same tables as code, one per material: engine/materials/<id>.params.ts. This test compares the two, so
// a data file that went stale after an engine sync fails here instead of resolving settings against old ids, kinds
// or defaults. To fix a failure: `npm run sync` (it runs the engine copy and the data export together).
//
// The scene-level parameters live in a holo.spot module that is not part of the engine copy (app/sceneParams.ts), so
// they are checked for shape only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MATERIAL_IDS } from "../engine/types.ts";
import params from "../src/data/params.json" with { type: "json" };

/** The engine's parameter table of a material: the exported array whose name ends in _PARAMS. */
async function engineParams(material) {
  const mod = await import(`../engine/materials/${material}.params.ts`);
  const names = Object.keys(mod).filter((k) => /_PARAMS$/.test(k) && Array.isArray(mod[k]));
  assert.equal(names.length, 1, `engine/materials/${material}.params.ts: expected one exported *_PARAMS array, found ${names.join(", ") || "none"}`);
  return mod[names[0]];
}

/** ParamKind of engine/types.ts. */
const KINDS = ["slider", "toggle", "select", "color", "pad", "spring", "image", "text"];

test("params.json has the engine's materials, in the engine's order", () => {
  assert.deepEqual(Object.keys(params.materials), [...MATERIAL_IDS]);
});

for (const material of MATERIAL_IDS) {
  test(`${material}: ids, in order, as engine/materials/${material}.params.ts`, async () => {
    const engine = await engineParams(material);
    assert.deepEqual(params.materials[material].map((p) => p.id), engine.map((p) => p.id));
  });

  test(`${material}: kinds as the engine's`, async () => {
    const engine = new Map((await engineParams(material)).map((p) => [p.id, p]));
    for (const p of params.materials[material]) assert.equal(p.kind, engine.get(p.id)?.kind, `${p.id}: kind`);
  });

  test(`${material}: defaults as the engine's`, async () => {
    const engine = new Map((await engineParams(material)).map((p) => [p.id, p]));
    for (const p of params.materials[material]) assert.deepEqual(p.default, engine.get(p.id)?.default, `${p.id}: default`);
  });

  test(`${material}: ranges and options as the engine's`, async () => {
    const engine = new Map((await engineParams(material)).map((p) => [p.id, p]));
    for (const p of params.materials[material]) {
      const e = engine.get(p.id);
      if (!e) continue;                                    // reported by the ids test
      assert.deepEqual([p.min, p.max, p.step], [e.min, e.max, e.step], `${p.id}: min, max, step`);
      assert.deepEqual(p.options, e.options ? [...e.options] : undefined, `${p.id}: options`);
    }
  });
}

test("every parameter has a known kind, a default of that kind, and an id that occurs once", () => {
  const seen = new Set();
  const all = [...params.scene, ...MATERIAL_IDS.flatMap((m) => params.materials[m])];
  assert.ok(params.scene.length > 0 && all.length > params.scene.length);
  for (const p of all) {
    assert.ok(typeof p.id === "string" && p.id.length > 0, "a parameter without an id");
    assert.ok(!seen.has(p.id), `${p.id}: listed twice`);
    seen.add(p.id);
    assert.ok(KINDS.includes(p.kind), `${p.id}: unknown kind "${p.kind}"`);
    if (p.kind === "slider") {
      assert.equal(typeof p.default, "number", `${p.id}: a slider's default is a number`);
      assert.ok(p.min <= p.default && p.default <= p.max, `${p.id}: default ${p.default} outside ${p.min}…${p.max}`);
    } else if (p.kind === "toggle") assert.equal(typeof p.default, "boolean", `${p.id}: a toggle's default is a boolean`);
    else if (p.kind === "select") assert.ok(p.options.includes(p.default), `${p.id}: default "${p.default}" is not one of its options`);
    else if (p.kind === "pad") assert.ok(typeof p.default.x === "number" && typeof p.default.y === "number", `${p.id}: a pad's default is { x, y }`);
    else if (p.kind === "spring") assert.ok(p.default !== null && typeof p.default === "object", `${p.id}: a spring's default is an object`);
    else assert.equal(typeof p.default, "string", `${p.id}: a ${p.kind}'s default is a string`);
  }
});

test("a material's parameter ids start with its own id, a scene parameter's never do", () => {
  for (const m of MATERIAL_IDS) for (const p of params.materials[m]) assert.ok(p.id.startsWith(`${m}.`), `${p.id} is listed under ${m}`);
  for (const p of params.scene) assert.ok(!MATERIAL_IDS.some((m) => p.id.startsWith(`${m}.`)), `${p.id} is a scene parameter with a material's prefix`);
});

test("scene.material offers exactly the engine's materials", () => {
  const p = params.scene.find((q) => q.id === "scene.material");
  assert.deepEqual(p.options, [...MATERIAL_IDS]);
});
