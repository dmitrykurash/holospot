#!/usr/bin/env node
// Writes schema/holo.schema.json: every setting of the kit as JSON Schema (draft 2020-12).
//
//   node tools/gen-schema.mjs
//
// Source: src/data/params.json (written by tools/export-data.mjs). The schema has one definition for the scene
// settings and one per material. Each property carries its type, range or options, default and a description (the
// parameter's meaning and unit). Two more definitions describe what `settings` accepts: `settings` (a flat map of
// ids to values) and `copySettings` (what the Copy settings button of holo.spot puts on the clipboard).
//
// A slider is a number with `minimum` and `maximum` (`x-step` is the step of holo.spot's slider, for information).
// A 2D pad is an object `{ x, y }`. An image is a string: one of the built-in values listed in `examples`, or a URL.
// The scene definition holds holo.spot's whole scene panel, so that a Copy settings blob validates. A property the
// kit does not read is marked `"x-kit-ignores": true` and says so at the start of its description. The names of the
// looks (the `entity` of a blob) are read from src/data/looks.json when that file is there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const params = JSON.parse(readFileSync(join(ROOT, "src", "data", "params.json"), "utf8"));
const looksPath = join(ROOT, "src", "data", "looks.json");
const entities = existsSync(looksPath) ? Object.keys(JSON.parse(readFileSync(looksPath, "utf8"))) : null;

// The scene ids the kit reads (src/settings.ts: resolveSettings and sceneStateFrom; src/holo.ts; src/shot.ts). The scene list of
// params.json is holo.spot's whole scene panel; the other ids are accepted, so that a Copy settings blob validates,
// and change nothing in the kit. Keep this list in step with src/settings.ts.
const KIT_READS = [
  /^scene\.(background|bgColor|print)$/,
  /^studio\.preset$/,
  /^studio\.(panel|spotA|spotB|spotC|ambient)\./,
  /^display\.(ev|tone|glare|glareRadius|wideGamut)$/,
  /^grain\./,
  /^bump\./,
  /^dof\./,                                                   // dof.lens: read by shotCamera, not by the renderer
  /^card\./,
  /^object\.(modelSize|modelMapping|structureScale)$/,
];
// Material ids that drive holo.spot's own interface only.
const SITE_ONLY_MATERIAL_IDS = new Set(["emboss.edit"]);
// Selects that the kit also accepts a URL for (src/holo.ts syncAssets: a hologram subject baked with
// tools/bake-hologram.mjs). The pattern is the kit's own test for "this is a URL, not a built-in name".
const ALSO_URL = {
  "volume.subject": { pattern: "^(https?:|data:|blob:|\\.{0,2}/)", note: "Or the URL of a volume baked with tools/bake-hologram.mjs (http(s):, data:, blob:, or a path starting with /, ./ or ../)" },
};
const kitReads = (id, scene) => (scene ? KIT_READS.some((re) => re.test(id)) : !SITE_ONLY_MATERIAL_IDS.has(id));

// The meanings are holo.spot's own parameter notes. References to its internal documents and file layout mean
// nothing outside that project, so they are taken out; nothing else is reworded.
function tidy(meaning) {
  let s = String(meaning)
    .replace(/ \((?:§[\d.]+|A\d+(?:\.\d+)*)\)/g, "")                 // " (§5.2)", " (A13)"
    .replace(/, §[\d.]+\)/g, ")")                                    // "(× 0.6, §5.2)"
    .replace(/the §[\d.]+ /g, "the ")                                // "the §5.2 lighting adaptation"
    .replace(/\(A\d+(?:\.\d+)*; /g, "(")                             // "(A13.12; off: …)"
    .replace(/ \(A\d+'s [^)]*\)/g, "")                               // " (A5's coat)"
    .replace(/; A\d+'s [^)]*\)/g, ")")                               // "…; A6's fixed 0.12°)"
    .replace(/\((?:app|wall)\/\w+\.ts(?: compact text)?; /g, "(")    // "(app/paperDoc.ts; …"
    .replace(/; (?:app|wall)\/\w+\.ts\)/g, ")")                      // "…; wall/parallax.ts)"
    .replace(/ \(holocloth[^)]*\)/g, "")                             // " (holocloth's grain pass)"
    .replace(/public\/holo3d\//g, "assets/holo3d/");                 // where the kit keeps the hologram subjects
  s = s.replace(/^A\d+(?:\.\d+)*: (.)/, (_, c) => c.toUpperCase());  // "A11: the paper card's …"
  return s;
}
const LEFTOVER = /§|\bA\d+(?:\.\d+)*[:;)']|\w\/\w+\.ts\b|public\//;

const hasUnit = (u) => typeof u === "string" && u !== "" && u !== "—";

function property(p, scene) {
  const meaning = tidy(p.meaning);
  if (LEFTOVER.test(meaning)) console.warn(`gen-schema: ${p.id}: the description still holds an internal reference: ${meaning}`);
  const reads = kitReads(p.id, scene);
  // the description: the meaning, then the unit, then what the kind adds; each part ends with a full stop
  const parts = [meaning];
  if (hasUnit(p.unit)) parts.push(`Unit: ${p.unit}`);
  if (!reads) parts.unshift("Not used by the kit (a holo.spot setting, accepted and ignored)");
  const out = {};
  switch (p.kind) {
    case "slider":
      out.type = "number"; out.minimum = p.min; out.maximum = p.max;
      break;
    case "toggle":
      out.type = "boolean";
      break;
    case "select":
      out.type = "string";
      if (ALSO_URL[p.id]) { out.anyOf = [{ enum: [...p.options] }, { pattern: ALSO_URL[p.id].pattern }]; parts.push(ALSO_URL[p.id].note); }
      else out.enum = [...p.options];
      break;
    case "pad": {
      const axis = { type: "number", minimum: p.min, maximum: p.max };
      out.type = "object"; out.properties = { x: { ...axis }, y: { ...axis } }; out.required = ["x", "y"]; out.additionalProperties = false;
      break;
    }
    case "color":
      out.type = "string"; parts.push("A colour as #rrggbb");
      break;
    case "image":
      out.type = "string";
      if (p.options?.length) { out.examples = [...p.options]; parts.push("One of the built-in values (see examples), a URL or a data URL"); }
      break;
    case "text":
      out.type = "string";
      break;
    default:                                                           // a structured value (the pose spring)
      out.type = typeof p.default === "object" && p.default !== null ? "object" : typeof p.default;
  }
  out.default = p.default;
  out.description = parts.map((t) => (/[.!?]$/.test(t) ? t : `${t}.`)).join(" ");
  if (p.kind === "slider" && p.step !== undefined) out["x-step"] = p.step;
  if (!reads) out["x-kit-ignores"] = true;
  return out;
}

const group = (title, description, list, scene) => ({
  title, description, type: "object",
  properties: Object.fromEntries(list.map((p) => [p.id, property(p, scene)])),
});

const materialIds = Object.keys(params.materials);
const number = { type: "number" };

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "holospot settings",
  description: "What the `settings` option of the kit accepts (Holo, holo.apply, holo.card, holo.setScene, obj.set): a flat map of parameter ids to values, or a Copy settings blob from holo.spot. Generated by tools/gen-schema.mjs from src/data/params.json; do not edit.",
  anyOf: [{ $ref: "#/$defs/copySettings" }, { $ref: "#/$defs/settings" }],
  $defs: {
    settings: {
      title: "Flat settings map",
      description: "Parameter ids to values. Scene ids apply to the whole Holo. Material ids apply to the object's own material; ids of the other materials are ignored.",
      type: "object",
      allOf: [{ $ref: "#/$defs/scene" }, ...materialIds.map((m) => ({ $ref: `#/$defs/${m}` }))],
      unevaluatedProperties: false,
    },
    copySettings: {
      title: "Copy settings blob",
      description: "What the Copy settings button of holo.spot puts on the clipboard, and the shape of the files in presets/. It names its own look (entity) and material.",
      type: "object",
      properties: {
        holoDev: { const: 1 },
        entity: entities ? { type: "string", enum: entities, description: "The kind of object on holo.spot the look was made on." } : { type: "string" },
        material: { type: "string", enum: materialIds },
        values: { $ref: "#/$defs/settings" },
        view: { $ref: "#/$defs/view" },
        pose: { $ref: "#/$defs/pose" },
        assets: { type: "object", additionalProperties: { type: "string" }, description: "SVG artwork by name, for values that read \"asset:<name>\"." },
      },
      required: ["holoDev", "entity", "material", "values"],
      additionalProperties: false,
    },
    view: {
      title: "View",
      description: "How holo.spot frames the look: the camera's orbit around the object in degrees (az, el), the zoom (a factor on the fitted distance) and an offset of the object in millimetres. shotCamera() applies it.",
      type: "object",
      properties: { az: number, el: number, zoom: number, offset: { type: "array", prefixItems: [number, number, number], minItems: 3, maxItems: 3 } },
      required: ["az", "el", "zoom", "offset"],
      additionalProperties: false,
    },
    pose: {
      title: "Pose",
      description: "The tilt holo.spot rests the object at, in degrees about x, y and z; flip shows the back. shotRotation() turns it into a rotation.",
      type: "object",
      properties: { rx: number, ry: number, rz: number, flip: { type: "boolean" } },
      required: ["rx", "ry", "rz", "flip"],
      additionalProperties: false,
    },
    scene: group(
      "Scene settings",
      "Settings shared by every holographic object: lights (studio.*), display.*, grain.*, bump.*, dof.*, card.*, scene.background, scene.bgColor, scene.print. The list is holo.spot's whole scene panel; properties marked x-kit-ignores are accepted and change nothing in the kit.",
      params.scene, true),
    ...Object.fromEntries(materialIds.map((m) => [m, group(`${m} settings`, `Every parameter of the material "${m}".`, params.materials[m], false)])),
  },
};

const outDir = join(ROOT, "schema");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "holo.schema.json"), JSON.stringify(schema, null, 2) + "\n");
const ignored = params.scene.filter((p) => !kitReads(p.id, true)).length;
console.log(`schema/holo.schema.json: scene ${params.scene.length} properties (${params.scene.length - ignored} read by the kit, ${ignored} ignored), ` +
  materialIds.map((m) => `${m} ${params.materials[m].length}`).join(", "));
