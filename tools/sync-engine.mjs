#!/usr/bin/env node
// Copies the rendering engine out of the holo.spot source tree, byte for byte.
//
//   node tools/sync-engine.mjs --from "/path/to/holo-spot-source"
//
// The kit never edits the files under engine/. They are the same files that draw holo.spot, which is what makes
// the kit's picture match the site's. This script walks the import graph from the entry modules below, copies every
// module that is imported for its code (type-only imports are left out and typed `any` by src/engine-shims.d.ts),
// and records what it copied in engine/ENGINE.json. Run it again after holo.spot changes, then run the parity check.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fromArg = args.indexOf("--from");
if (fromArg < 0 || !args[fromArg + 1]) { console.error('usage: node tools/sync-engine.mjs --from "<holo.spot source>"'); process.exit(2); }
const FROM = resolve(args[fromArg + 1]);
const SRC = join(FROM, "src");

/** The modules the kit imports from the engine (paths under the source's src/). */
export const ENTRIES = [
  "types.ts",
  "materials/registry.ts", "materials/build.ts", "materials/volume.ts", "materials/emboss.ts",
  "render/pipeline.ts", "render/tier.ts", "render/renderer.ts",
  "scene/spectralTextures.ts", "scene/uniforms.ts", "scene/lights.ts", "scene/studioEnv.ts", "scene/relief.ts",
  "scene/bumpMaps.ts", "scene/volumes.ts", "scene/embossAssets.ts", "scene/models.ts",
  "scene/cardGeometry.ts", "scene/backMaterial.ts", "scene/edgeMaterial.ts", "scene/printText.ts",
  "scene/camera.ts",
  "physics/grating.ts", "physics/geometry.ts", "physics/lens.ts",
];

const IMPORT = /(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/gs;
const value = new Set(), typeOnly = new Set();
function walk(file) {
  if (value.has(file)) return;
  value.add(file);
  typeOnly.delete(file);
  if (!existsSync(join(SRC, file))) throw new Error(`missing in the source: src/${file}`);
  if (!file.endsWith(".ts")) return;
  const text = readFileSync(join(SRC, file), "utf8");
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[2] ?? m[3];
    if (!spec.startsWith(".")) continue;
    const target = normalize(join(dirname(file), spec.split("?")[0])).replaceAll("\\", "/");
    if (m[1]) { if (!value.has(target)) typeOnly.add(target); } else walk(target);
  }
}
for (const e of ENTRIES) walk(e);

const OUT = join(ROOT, "engine");
rmSync(OUT, { recursive: true, force: true });
const files = {};
for (const f of [...value].sort()) {
  const to = join(OUT, f);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(SRC, f), to);
  files[f] = createHash("sha256").update(readFileSync(to)).digest("hex").slice(0, 16);
}
let commit = "unknown", dirty = [];
try {
  commit = execFileSync("git", ["-C", FROM, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const changed = execFileSync("git", ["-C", FROM, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^src\//, ""));
  dirty = changed.filter((f) => value.has(f));
} catch { /* not a git checkout */ }
writeFileSync(join(OUT, "ENGINE.json"), JSON.stringify({
  note: "Copied from the holo.spot source by tools/sync-engine.mjs. Do not edit these files here.",
  sourceCommit: commit, uncommittedInSource: dirty, entries: ENTRIES, typeOnly: [...typeOnly].sort(), files,
}, null, 2) + "\n");
console.log(`engine: ${value.size} files from ${relative(process.cwd(), FROM) || FROM} @ ${commit.slice(0, 7)}${dirty.length ? ` (+${dirty.length} uncommitted)` : ""}`);
console.log(`type-only (not copied): ${[...typeOnly].sort().join(", ")}`);
