#!/usr/bin/env node
// Writes presets/: the looks holo.spot ships, one settings file per look and material, and presets/README.md.
//
//   node tools/gen-presets.mjs
//
// Source: src/data/looks.json (written by tools/export-data.mjs): for each kind of object on holo.spot (card, object,
// image, cloth, stickers, flag) and each material it can carry, the values the site ships where they differ from the
// parameter defaults, and how the site frames and tilts the object.
//
// Each file has the shape of a Copy settings blob,
//   { "holoDev": 1, "entity": "<look>", "material": "<material>", "values": { … }, "view": { … }, "pose": { … } }
// so it can be passed to the kit as `settings`, unchanged.
//
// Values that point at files of holo.spot which the kit does not ship (a string starting with /defaults/ or /demo/,
// or equal to "upload") are left out. The one such reference inside a value is the logo of a paper card element in
// `emboss.doc`: it is replaced by the built-in /logos/rosette.svg, which is what the kit draws for it anyway.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const looks = JSON.parse(readFileSync(join(ROOT, "src", "data", "looks.json"), "utf8"));
const OUT = join(ROOT, "presets");
const BUILT_IN_LOGO = "/logos/rosette.svg";

const siteFile = (v) => typeof v === "string" && (v.startsWith("/defaults/") || v.startsWith("/demo/") || v === "upload");

/** The paper card's document with every element logo that points at a site file replaced by the built-in logo. */
function cleanDoc(text, note) {
  let doc;
  try { doc = JSON.parse(text); } catch { return text; }
  if (!doc || !Array.isArray(doc.e)) return text;
  let changed = false;
  for (const el of doc.e) {
    if (el && el.p && siteFile(el.p.logo)) { el.p.logo = BUILT_IN_LOGO; changed = true; note.logos++; }
  }
  return changed ? JSON.stringify(doc) : text;
}

function cleanValues(values, note) {
  const out = {};
  for (const [id, v] of Object.entries(values)) {
    if (siteFile(v)) { note.dropped.push(id); continue; }
    out[id] = id === "emboss.doc" && typeof v === "string" && v.trim() !== "" ? cleanDoc(v, note) : v;
  }
  return out;
}

/** One id per line, each value compact: easy to read and to diff. */
function format(blob) {
  const ids = Object.keys(blob.values);
  const lines = ids.map((id, k) => `    ${JSON.stringify(id)}: ${JSON.stringify(blob.values[id])}${k < ids.length - 1 ? "," : ""}`);
  return [
    "{",
    `  "holoDev": 1,`,
    `  "entity": ${JSON.stringify(blob.entity)},`,
    `  "material": ${JSON.stringify(blob.material)},`,
    ids.length ? `  "values": {\n${lines.join("\n")}\n  },` : `  "values": {},`,
    `  "view": ${JSON.stringify(blob.view)},`,
    `  "pose": ${JSON.stringify(blob.pose)}`,
    "}",
    "",
  ].join("\n");
}

/** A material's name on holo.spot, read from its definition in engine/ (the id when it cannot be read). */
function materialName(id) {
  try {
    const m = /^\s*name:\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, "engine", "materials", `${id}.ts`), "utf8"));
    return m ? m[1] : id;
  } catch { return id; }
}

// What each look is on holo.spot, and what of it the kit has.
const LOOK_NOTES = {
  card: "A trading card (63 × 88 mm) covered edge to edge with the foil. In the kit: `holo.card()`.",
  object: "A 3D shape or model wrapped in the foil. In the kit: `holo.apply(mesh)`, whose default look this is.",
  image: "The paper card: heavy paper carrying foil logos and hologram stickers. In the kit: `holo.card({ material: \"emboss\" })`.",
  cloth: "A sheet of cloth floating in gel. The kit has no cloth simulation: the file gives the cloth's material, lights and camera for your own object.",
  stickers: "Die-cut stickers on a wall. The kit has no sticker wall: the file gives the stickers' foil, lights and camera for your own object.",
  flag: "A flag on a pole in the wind. The kit has no flag simulation: the file gives the flag's material, lights and camera for your own object.",
};

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^[a-z]+-[a-z]+\.json$/.test(f)) rmSync(join(OUT, f));   // files of looks that no longer exist

const rows = [];
let dropped = 0, logos = 0;
for (const [entity, look] of Object.entries(looks)) {
  for (const [material, surface] of Object.entries(look.surfaces)) {
    const note = { dropped: [], logos: 0 };
    const blob = { holoDev: 1, entity, material, values: cleanValues(surface.values, note), view: surface.view, pose: surface.pose };
    const file = `${entity}-${material}.json`;
    writeFileSync(join(OUT, file), format(blob));
    dropped += note.dropped.length; logos += note.logos;
    rows.push({ file, entity, material, title: look.title, own: look.material === material, count: Object.keys(blob.values).length, note });
  }
}

const table = rows.map((r) => {
  const what = `${r.title} in ${materialName(r.material)}${r.own ? " (what this look opens with on holo.spot)" : ""}`;
  const left = [...r.note.dropped.map((id) => `\`${id}\` left out`), ...(r.note.logos ? ["logo in `emboss.doc` replaced by the built-in rosette"] : [])].join("; ");
  return `| \`${r.file}\` | ${what} | ${r.count} | ${left} |`;
});
const entities = Object.keys(looks);
const readme = `# Presets: the looks holo.spot ships

Each file here is one look of [holo.spot](https://www.holo.spot): a kind of object (the look) in one material, with the
lights, exposure, grain, background and camera the site opens it with. The files are generated by
\`tools/gen-presets.mjs\` from \`src/data/looks.json\`. Do not edit them by hand; copy one and change the copy.

## How to use one

A preset has the shape of a Copy settings blob from holo.spot, so it is passed as \`settings\`, unchanged:

\`\`\`js
import * as THREE from "three";
import { Holo, shotCamera, shotRotation } from "holospot";
import preset from "holospot/presets/object-nebula.json" with { type: "json" };   // in a bundler

const holo = new Holo(renderer);
const obj = holo.apply(mesh, { settings: preset, scene: true });   // scene: true: its lights, exposure and background too, even when it is not the first object
await obj.ready;
mesh.rotation.copy(shotRotation(obj.pose));                         // optional: the tilt holo.spot rests it at
shotCamera(camera, obj, { aspect: innerWidth / innerHeight });     // optional: holo.spot's framing and lens
renderer.setAnimationLoop(() => holo.render(scene, camera));
\`\`\`

There are two ways to load a file:

- In a bundled project, import it from the package, as above. The package exposes \`holospot/presets/<file>.json\`.
- In a page without a build step, fetch it from wherever you serve the folder:

\`\`\`js
const preset = await (await fetch("./presets/object-nebula.json")).json();
\`\`\`

What a file holds:

- The file names its own look (\`entity\`) and \`material\`, so neither has to be passed.
- \`values\` holds only what differs from the parameter defaults: scene ids (\`studio.*\`, \`display.*\`, \`dof.*\`, …)
  and the material's own ids. To change a value, copy the file's content and edit \`values\`, or call
  \`obj.set({ … })\` and \`holo.setScene({ … })\` afterwards.
- \`view\` and \`pose\` are how the site frames and tilts the object. The kit does not move your camera or object
  by itself; \`shotCamera\` and \`shotRotation\` apply them when you want the same shot. \`shotCamera\` also sets
  the camera's field of view from the preset's lens (\`dof.lens\`).
- A preset is exactly what \`look\` and \`material\` resolve to with no settings:
  \`holo.apply(mesh, { look: "object", material: "nebula" })\` gives the same picture as \`object-nebula.json\`.
  The files exist so the values can be read, compared and edited.
- Some values are settings of holo.spot's own scenes (\`scene.object\`, \`object.flag*\`, \`motion.*\`, …). The kit
  accepts and ignores them.

## What is left out

Values that point at files of holo.spot which the kit does not ship are left out of the presets: any string that
starts with \`/defaults/\` or \`/demo/\`, or equals \`upload\`. In these files that is the site's own logo artwork on
the paper card:

- the top-level \`emboss.logo\` is left out, so the parameter default (the built-in rosette) applies;
- inside \`emboss.doc\` (the paper card's list of elements) the logo element points at the built-in
  \`/logos/rosette.svg\` instead.

So the paper card presets show the built-in rosette where holo.spot shows its own mark. Everything else is as on the site.

## The files

${entities.map((e) => `- \`${e}\` (${looks[e].title}): ${LOOK_NOTES[e] ?? ""}`).join("\n")}

| File | What it is on holo.spot | Values | Left out or replaced |
|---|---|---|---|
${table.join("\n")}
`;
writeFileSync(join(OUT, "README.md"), readme);

console.log(`presets/: ${rows.length} files (${entities.map((e) => `${e} ${Object.keys(looks[e].surfaces).length}`).join(", ")}), README.md`);
console.log(`left out: ${dropped} value(s) that point at holo.spot files; ${logos} logo(s) inside emboss.doc replaced by ${BUILT_IN_LOGO}`);
for (const r of rows) if (r.note.dropped.length || r.note.logos) console.log(`  ${r.file}: ${[...r.note.dropped, ...(r.note.logos ? [`emboss.doc logo ×${r.note.logos}`] : [])].join(", ")}`);
