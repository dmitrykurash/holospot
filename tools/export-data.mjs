#!/usr/bin/env node
// Exports holo.spot's settings as data: every parameter (id, range, default, meaning) and the looks the site ships.
//
//   node tools/export-data.mjs --from "/path/to/holo-spot-source"
//
// Writes src/data/params.json (scene + the seven materials), src/data/looks.json (what each holo.spot entity ships on
// each material, as the difference from the parameter defaults) and src/data/studio-presets.json. The kit resolves a
// look as: parameter default ← shipped look ← your settings, the same order holo.spot uses.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.indexOf("--from");
if (i < 0 || !args[i + 1]) { console.error('usage: node tools/export-data.mjs --from "<holo.spot source>"'); process.exit(2); }
const SRC = join(resolve(args[i + 1]), "src");
const load = (p) => import(pathToFileURL(join(SRC, p)).href);

const { SCENE_PARAMS, STUDIO_PRESETS } = await load("app/sceneParams.ts");
const D = await load("app/entityDefaults.ts");
const { ENTITY_IDS, ENTITIES } = await load("app/entities.ts");
const { MATERIAL_IDS } = await load("types.ts");
const { BUMP_PARAMS } = await load("scene/bumpMaps.ts");
const matParams = {};
for (const m of MATERIAL_IDS) {
  const mod = await load(`materials/${m}.params.ts`);
  const key = Object.keys(mod).find((k) => /_PARAMS$/.test(k) && Array.isArray(mod[k]));
  matParams[m] = mod[key];
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const spec = (p) => ({ id: p.id, kind: p.kind, default: p.default, ...(p.min !== undefined ? { min: p.min, max: p.max, step: p.step } : {}),
  ...(p.options ? { options: [...p.options] } : {}), unit: p.unit, meaning: p.meaning });

const sceneIds = new Set(SCENE_PARAMS.map((p) => p.id));
// selects whose choice also writes other values of the material (as `studio.preset` does for the lights)
const { STOCK_PRESETS } = await load("materials/emboss.params.ts");
const params = {
  scene: SCENE_PARAMS.map(spec),
  bumpIds: BUMP_PARAMS.map((p) => p.id).filter((id) => sceneIds.has(id)),
  materials: Object.fromEntries(MATERIAL_IDS.map((m) => [m, matParams[m].map(spec)])),
  presets: { emboss: { "emboss.stock": STOCK_PRESETS } },
};

const looks = {};
for (const e of ENTITY_IDS) {
  const entry = D.ENTITY_DEFAULTS[e];
  const own = D.entityMaterial(e);
  const surfaces = {};
  for (const m of MATERIAL_IDS) {
    if (!D.materialAllowed(e, m)) continue;
    const values = {};
    for (const p of [...SCENE_PARAMS, ...matParams[m]]) {
      const v = D.shippedDefault(e, p.id, D.ENTITY_DEFAULTS, m);
      if (v !== undefined && !same(v, p.default)) values[p.id] = v;
    }
    surfaces[m] = { values, view: D.shippedView(e, D.ENTITY_DEFAULTS, m), pose: D.shippedPose(e, D.ENTITY_DEFAULTS, m) };
  }
  looks[e] = { title: ENTITIES[e].title, material: own, quality: D.shippedQuality(e), surfaces };
}

const out = join(ROOT, "src", "data");
mkdirSync(out, { recursive: true });
const write = (name, data) => writeFileSync(join(out, name), JSON.stringify(data, null, 1) + "\n");
write("params.json", params);
write("looks.json", looks);
write("studio-presets.json", STUDIO_PRESETS);
console.log(`params: ${params.scene.length} scene + ${Object.values(params.materials).reduce((n, a) => n + a.length, 0)} material; looks: ${Object.keys(looks).join(", ")}`);
for (const [e, l] of Object.entries(looks)) console.log(`  ${e}: own=${l.material} quality=${l.quality} surfaces=${Object.entries(l.surfaces).map(([m, s]) => `${m}(${Object.keys(s.values).length})`).join(" ")}`);
