// The reference pages repeat facts of the data files: docs/materials/<material>.md and docs/scene-settings.md list
// every parameter with its range or options and default (src/data/params.json), the paper stocks and the lighting
// presets, and the pages and presets/README.md show settings in code. This test compares the pages with the data, so
// a page that went stale after a data sync (`npm run sync`) fails here instead of teaching an agent a wrong id or
// range. To fix a failure, correct the page: the data file wins.
//
// Checked:
//   - each material page has one table row per parameter of that material, and no other row; the row's range or
//     options, default and unit are the data's;
//   - docs/scene-settings.md: the same for the scene ids it lists, and every scene id of the data is either listed
//     there or named in its section "Settings the kit accepts and ignores";
//   - the paper stock table of emboss.md and the lighting preset table of scene-settings.md have the data's values;
//   - in every fenced code block of docs/**/*.md and presets/README.md, each `"id": value` pair names a real
//     parameter and gives it a value of the right type, inside its range or among its options;
//   - a paper card document (`emboss.doc`) shown as JSON holds valid elements;
//   - presets/README.md lists exactly the files of presets/, and each file resolves to the same values as its look
//     and material do with no settings, which is what the README says of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ELEMENT_IDS, MAX_ELEMENTS } from "../engine/app/paperDoc.ts";
import { PLACEMENT_WIDE } from "../engine/ui/logoEditorMath.ts";
import params from "../src/data/params.json" with { type: "json" };
import studioPresets from "../src/data/studio-presets.json" with { type: "json" };
import { isCopyBlob, resolveSettings } from "../src/settings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const MATERIALS = Object.keys(params.materials);
const SCENE = new Map(params.scene.map((p) => [p.id, p]));
const BY_ID = new Map(params.scene.map((p) => [p.id, p]));
for (const m of MATERIALS) for (const p of params.materials[m]) BY_ID.set(p.id, p);
/** The first part of every parameter id: scene, studio, display, …, prism, shatter, … */
const PREFIXES = [...new Set([...BY_ID.keys()].map((id) => id.split(".")[0]))];

// ---- tables -----------------------------------------------------------------------------------------------------------

/** The table rows of a page whose first cell is a parameter-like id in backticks: { id, cells, line }. */
function idRows(text) {
  const out = [];
  text.split("\n").forEach((line, k) => {
    const m = /^\| `([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)` \|/.exec(line);
    if (!m || !PREFIXES.includes(m[1].split(".")[0])) return;
    out.push({ id: m[1], cells: line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()), line: k + 1 });
  });
  return out;
}

const ticked = (cell) => [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
const unitOf = (p) => (p.unit === "—" ? "" : p.unit);

/** Compares one table row (id | range or options | default | unit | text) with the parameter. */
function checkRow(page, row, p) {
  const where = `${page}:${row.line} ${p.id}`;
  assert.ok(row.cells.length >= 5, `${where}: expected the columns id, range or options, default, unit, text`);
  const [, range, dflt, unit, text] = row.cells;
  if (p.kind === "slider" || p.kind === "pad") {
    const m = /(-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?)/.exec(range);
    assert.ok(m, `${where}: the range should read "<min> to <max>", found "${range}"`);
    assert.deepEqual([Number(m[1]), Number(m[2])], [p.min, p.max], `${where}: range`);
  } else if (p.kind === "select") {
    assert.deepEqual(ticked(range), p.options, `${where}: options`);
  } else if (p.kind === "toggle") {
    assert.deepEqual(ticked(range), ["true", "false"], `${where}: options`);
  } else if (p.kind === "image" && p.options?.length) {
    assert.deepEqual(ticked(range), p.options, `${where}: built-in values`);
  }
  const d = /^`(.*)`$/.exec(dflt);
  assert.ok(d, `${where}: the default should be one value in backticks, found "${dflt}"`);
  let value;
  try { value = JSON.parse(d[1]); } catch { assert.fail(`${where}: the default \`${d[1]}\` is not JSON`); }
  assert.deepEqual(value, p.default, `${where}: default`);
  assert.equal(unit, unitOf(p), `${where}: unit`);
  assert.ok(text.length > 0, `${where}: the row says nothing about what the parameter changes`);
}

for (const material of MATERIALS) {
  test(`docs/materials/${material}.md lists every ${material} parameter once, as the data has it`, () => {
    const page = `docs/materials/${material}.md`, rows = idRows(read(page)).filter((r) => r.id.startsWith(material + "."));
    const want = new Map(params.materials[material].map((p) => [p.id, p]));
    const seen = new Map();
    for (const r of rows) {
      assert.ok(want.has(r.id), `${page}:${r.line}: "${r.id}" is not a parameter of ${material}`);
      assert.ok(!seen.has(r.id), `${page}:${r.line}: "${r.id}" is listed twice (also on line ${seen.get(r.id)})`);
      seen.set(r.id, r.line);
      checkRow(page, r, want.get(r.id));
    }
    const missing = [...want.keys()].filter((id) => !seen.has(id));
    assert.deepEqual(missing, [], `${page}: parameters without a table row`);
  });
}

/** The ids the section "accepts and ignores" names: exact ids, `prefix.*` wildcards, and "`a1` to `a4`" ranges. */
function ignoredSection(text) {
  const at = text.indexOf("## Settings the kit accepts and ignores");
  assert.ok(at >= 0, "docs/scene-settings.md: the section \"Settings the kit accepts and ignores\" is gone");
  const section = text.slice(at);
  const exact = new Set(), prefixes = [];
  for (const m of section.matchAll(/`([A-Za-z.]+?)(\d+)` to `([A-Za-z.]+?)(\d+)`/g)) {
    if (m[1] === m[3]) for (let n = Number(m[2]); n <= Number(m[4]); n++) exact.add(m[1] + n);
  }
  for (const t of ticked(section)) {
    if (t.endsWith(".*")) prefixes.push(t.slice(0, -1));
    else if (SCENE.has(t)) exact.add(t);
  }
  return { exact, covers: (id) => exact.has(id) || prefixes.some((p) => id.startsWith(p)) };
}

test("docs/scene-settings.md: every scene id it lists is real, listed once, and as the data has it", () => {
  const page = "docs/scene-settings.md", text = read(page), rows = idRows(text);
  const seen = new Map();
  for (const r of rows) {
    assert.ok(SCENE.has(r.id), `${page}:${r.line}: "${r.id}" is not a scene parameter`);
    assert.ok(!seen.has(r.id), `${page}:${r.line}: "${r.id}" is listed twice (also on line ${seen.get(r.id)})`);
    seen.set(r.id, r.line);
    checkRow(page, r, SCENE.get(r.id));
  }
  assert.ok(seen.size > 0, `${page}: no parameter rows found`);
});

test("docs/scene-settings.md: every scene id of the data is listed, or named as ignored, and never both", () => {
  const page = "docs/scene-settings.md", text = read(page);
  const listed = new Set(idRows(text).map((r) => r.id)), ignored = ignoredSection(text);
  const nowhere = [...SCENE.keys()].filter((id) => !listed.has(id) && !ignored.covers(id));
  assert.deepEqual(nowhere, [], `${page}: scene ids that are neither in a table nor in "Settings the kit accepts and ignores"`);
  const both = [...ignored.exact].filter((id) => listed.has(id));
  assert.deepEqual(both, [], `${page}: ids that have a table row and are also named as ignored`);
});

// ---- the paper stocks and the lighting presets -------------------------------------------------------------------------

/** The rows of the table whose first cell is one of `names` in backticks, with the header row before them. */
function namedRows(text, names) {
  const lines = text.split("\n"), rows = new Map();
  let header = null;
  lines.forEach((line, k) => {
    const m = /^\| `([A-Za-z]+)` \|/.exec(line);
    if (!m || !names.includes(m[1])) return;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (!rows.size) for (let h = k - 1; h >= 0 && lines[h].startsWith("|"); h--) if (!/^\|[-| ]+\|$/.test(lines[h])) { header = lines[h].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()); break; }
    if (!rows.has(m[1])) rows.set(m[1], { cells, line: k + 1 });
  });
  return { rows, header };
}

test("docs/materials/emboss.md: the paper stock table has the stocks' values", () => {
  const page = "docs/materials/emboss.md", stocks = params.presets?.emboss?.["emboss.stock"];
  assert.ok(stocks, "src/data/params.json: presets.emboss[\"emboss.stock\"] is missing");
  const names = Object.keys(stocks), { rows, header } = namedRows(read(page), names);
  assert.deepEqual([...rows.keys()], names, `${page}: the stock table should have one row per stock, in the data's order`);
  assert.ok(header, `${page}: the stock table has no header row`);
  // the header names each value column by its id without the "emboss." prefix
  const columns = header.map((h) => { const t = ticked(h)[0]; return t && BY_ID.has(`emboss.${t}`) ? `emboss.${t}` : null; });
  for (const [name, row] of rows) {
    const shown = {};
    row.cells.forEach((cell, k) => { if (columns[k]) shown[columns[k]] = JSON.parse(ticked(cell)[0]); });
    assert.deepEqual(shown, stocks[name], `${page}:${row.line}: the values of the stock "${name}"`);
  }
});

test("docs/scene-settings.md: the lighting preset table has the presets' values", () => {
  const page = "docs/scene-settings.md", names = Object.keys(studioPresets);
  assert.deepEqual(names, SCENE.get("studio.preset").options, "studio-presets.json and the options of studio.preset differ");
  const { rows } = namedRows(read(page), names);
  assert.deepEqual([...rows.keys()], names, `${page}: the preset table should have one row per preset, in the data's order`);
  const LIGHTS = ["panel", "spotA", "spotB", "spotC"], AMBIENT = ["rims", "fill", "scrim", "cameraSide", "cameraTexture"];
  for (const [name, row] of rows) {
    const v = studioPresets[name], where = `${page}:${row.line} preset "${name}"`;
    assert.equal(row.cells.length, 7, `${where}: expected the columns preset, what it is, panel, spot A, spot B, spot C, environment`);
    LIGHTS.forEach((k, n) => {
      const cell = row.cells[2 + n], at = (id) => v[`studio.${k}.${id}`];
      if (at("on") === false) { assert.equal(cell, "off", `${where}: ${k} is off in the data`); return; }
      assert.notEqual(cell, "off", `${where}: ${k} is on in the data`);
      const expect = [];
      if (at("dir")) expect.push(`dir (${at("dir").x}, ${at("dir").y})`);
      if (at("width") !== undefined) expect.push(`${at("width")}° × ${at("length")}°`);
      if (at("size") !== undefined) expect.push(`size ${at("size")}°`);
      if (at("radiance") !== undefined) expect.push(`radiance ${at("radiance")}`);
      if (at("distance") !== undefined) expect.push(`${at("distance")} m`);
      if (at("spd") !== undefined && at("spd") !== "equal") expect.push("`" + at("spd") + "`");
      // a part stands between commas (the direction holds a comma of its own, so the cell is not simply split)
      const has = (part) => (", " + cell + ", ").includes(", " + part + ", ");
      for (const e of expect) assert.ok(has(e), `${where}: the ${k} cell "${cell}" should contain "${e}"`);
    });
    assert.equal(row.cells[6], AMBIENT.map((a) => v[`studio.ambient.${a}`]).join(" / "), `${where}: rims / fill / scrim / cameraSide / cameraTexture`);
    const other = Object.keys(v).filter((id) => !/^studio\.(panel|spotA|spotB|spotC)\.(on|dir|width|length|size|radiance|distance|spd)$/.test(id) && !AMBIENT.some((a) => id === `studio.ambient.${a}`));
    assert.deepEqual(other, [], `${where}: the preset writes ids the table has no column for`);
  }
});

// ---- settings in code blocks -------------------------------------------------------------------------------------------

/** Why `v` is not a valid value of parameter `p`, or null. `wide`: inside a paper card document, where the position
 *  and the width may reach beyond the card (engine/ui/logoEditorMath.ts PLACEMENT_WIDE). */
function invalid(p, v, wide = false) {
  switch (p.kind) {
    case "slider": {
      if (typeof v !== "number" || !Number.isFinite(v)) return `a number is expected, found ${JSON.stringify(v)}`;
      const key = { "emboss.x": "x", "emboss.y": "y", "emboss.width": "width" }[p.id];
      const [lo, hi] = wide && key ? PLACEMENT_WIDE[key] : [p.min, p.max];
      return v < lo || v > hi ? `${v} is outside ${lo} to ${hi}` : null;
    }
    case "toggle": return typeof v === "boolean" ? null : `true or false is expected, found ${JSON.stringify(v)}`;
    case "select":
      if (typeof v !== "string") return `a string is expected, found ${JSON.stringify(v)}`;
      // the kit's own test for "a URL of a baked volume" (src/holo.ts syncAssets)
      if (p.id === "volume.subject" && /^(https?:|data:|blob:|\.{0,2}\/)/.test(v)) return null;
      return p.options.includes(v) ? null : `"${v}" is not one of ${p.options.join(", ")}`;
    case "pad":
      if (!v || typeof v !== "object" || typeof v.x !== "number" || typeof v.y !== "number" || Object.keys(v).length !== 2) return `{ x, y } is expected, found ${JSON.stringify(v)}`;
      return [v.x, v.y].every((n) => n >= p.min && n <= p.max) ? null : `${JSON.stringify(v)} is outside ${p.min} to ${p.max}`;
    case "color": return typeof v === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? null : `a colour as #rrggbb is expected, found ${JSON.stringify(v)}`;
    case "image": case "text": return typeof v === "string" ? null : `a string is expected, found ${JSON.stringify(v)}`;
    default: return v && typeof v === "object" ? null : `an object is expected, found ${JSON.stringify(v)}`;
  }
}

/** Why a paper card document is not valid (engine/app/paperDoc.ts decodeDoc drops what is wrong; a page must not
 *  show it), or null. */
function invalidDoc(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.e)) return "a document is { \"v\": 1, \"e\": [ … ] }";
  if (doc.v !== 1) return `"v" should be 1`;
  if (doc.e.length > MAX_ELEMENTS) return `${doc.e.length} elements, at most ${MAX_ELEMENTS} are drawn`;
  const ids = new Set();
  for (const el of doc.e) {
    if (!el || typeof el !== "object") return "an element should be an object";
    if (typeof el.i !== "string" || !/^[a-z0-9]{1,12}$/i.test(el.i)) return `element id ${JSON.stringify(el.i)}: 1 to 12 letters or digits`;
    if (ids.has(el.i)) return `element id "${el.i}" is used twice`;
    ids.add(el.i);
    if (el.t !== "f" && el.t !== "h") return `element "${el.i}": "t" should be "f" or "h"`;
    if ("n" in el && (typeof el.n !== "string" || el.n.length > 40)) return `element "${el.i}": "n" should be a string of at most 40 characters`;
    if ("h" in el && el.h !== 1) return `element "${el.i}": "h" should be 1 or left out`;
    for (const [key, v] of Object.entries(el.p ?? {})) {
      const id = `emboss.${key}`;
      if (!ELEMENT_IDS.has(id)) return `element "${el.i}": "${key}" is not a setting of an element`;
      const why = invalid(BY_ID.get(id), v, true);
      if (why) return `element "${el.i}": "${key}": ${why}`;
    }
  }
  return null;
}

/** Reads the literal that starts at `at` in `src`: a JSON or JavaScript string, number, boolean or flat object.
 *  Returns { value } or null when what follows is not a literal (an expression such as JSON.stringify(doc)). */
function literal(src, at) {
  const rest = src.slice(at);
  let m;
  if ((m = /^"(?:[^"\\\n]|\\.)*"/.exec(rest))) return { value: JSON.parse(m[0]) };
  if ((m = /^'((?:[^'\\\n]|\\.)*)'/.exec(rest))) return { value: m[1].replace(/\\(.)/g, "$1") };
  if ((m = /^-?\d+(?:\.\d+)?(?![\w.])/.exec(rest))) return { value: Number(m[0]) };
  if ((m = /^(true|false)\b/.exec(rest))) return { value: m[1] === "true" };
  if ((m = /^\{[^{}]*\}/.exec(rest))) {
    try { return { value: JSON.parse(m[0].replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')) }; } catch { return null; }
  }
  return null;
}

const FENCE = /^```[^\n]*\n([\s\S]*?)^```/gm;
const PAIR = new RegExp(`"((?:${PREFIXES.join("|")})\\.[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*)"\\s*:\\s*`, "g");

function markdownFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []);
}
const PAGES = [...markdownFiles("docs"), join("presets", "README.md")].map((f) => relative(ROOT, join(ROOT, f)).split("\\").join("/")).sort();

for (const page of PAGES) {
  test(`${page}: settings in code blocks name real ids with valid values`, () => {
    const text = read(page);
    for (const block of text.matchAll(FENCE)) {
      const code = block[1], line = text.slice(0, block.index).split("\n").length;
      for (const m of code.matchAll(PAIR)) {
        const id = m[1], where = `${page}: code block at line ${line}: "${id}"`;
        const p = BY_ID.get(id);
        assert.ok(p, `${where} is not a parameter`);
        const lit = literal(code, m.index + m[0].length);
        if (!lit) continue;                                           // an expression: only the id can be checked
        const why = invalid(p, lit.value);
        assert.ok(!why, `${where}: ${why}`);
        if (id === "emboss.doc" && lit.value.trim() !== "") {
          let doc;
          try { doc = JSON.parse(lit.value); } catch { assert.fail(`${where}: the document is not JSON`); }
          const whyDoc = invalidDoc(doc);
          assert.ok(!whyDoc, `${where}: ${whyDoc}`);
        }
      }
      // a paper card document shown on its own, as JSON
      let json;
      try { json = JSON.parse(code); } catch { json = null; }
      if (json && typeof json === "object" && Array.isArray(json.e)) {
        const whyDoc = invalidDoc(json);
        assert.ok(!whyDoc, `${page}: the document in the code block at line ${line}: ${whyDoc}`);
      }
    }
  });
}

// ---- the preset files --------------------------------------------------------------------------------------------------

const presetFiles = () => readdirSync(join(ROOT, "presets")).filter((f) => f.endsWith(".json")).sort();

test("presets/README.md lists exactly the files of presets/", () => {
  const listed = [...read("presets/README.md").matchAll(/^\| `([a-z]+-[a-z]+\.json)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, presetFiles(), "presets/README.md: run `node tools/gen-presets.mjs`");
});

test("each preset file resolves to what its look and material resolve to", () => {
  // the site's own logo artwork is not in the kit: the kit draws its default logo for it (src/paper.ts resolveArtwork)
  const sameLogo = (o) => JSON.parse(JSON.stringify(o).replace(/\/defaults\/[a-z]+\/[0-9a-z]+\.svg/g, "/logos/rosette.svg"));
  for (const file of presetFiles()) {
    const blob = JSON.parse(read(`presets/${file}`)), where = `presets/${file}`;
    assert.ok(isCopyBlob(blob), `${where}: not a Copy settings blob`);
    assert.equal(file, `${blob.entity}-${blob.material}.json`, `${where}: the file name should be <entity>-<material>.json`);
    for (const [id, v] of Object.entries(blob.values)) {
      assert.ok(!(typeof v === "string" && (v.startsWith("/defaults/") || v.startsWith("/demo/") || v === "upload")), `${where}: "${id}" points at a file of holo.spot`);
    }
    const fromFile = resolveSettings({ settings: blob }), fromLook = resolveSettings({ look: blob.entity, material: blob.material });
    assert.deepEqual(fromFile.unknown, [], `${where}: ids that are not parameters`);
    assert.deepEqual(sameLogo(fromFile.scene), sameLogo(fromLook.scene), `${where}: scene values`);
    assert.deepEqual(sameLogo(fromFile.values), sameLogo(fromLook.values), `${where}: material values`);
    assert.deepEqual(fromFile.view, fromLook.view, `${where}: view`);
    assert.deepEqual(fromFile.pose, fromLook.pose, `${where}: pose`);
  }
});
