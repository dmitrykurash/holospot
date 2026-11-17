// The files under engine/ are holo.spot's own, copied byte for byte by tools/sync-engine.mjs, and are never edited
// here: that is what makes holospot's picture match the site's. This test holds the rule: every file listed in
// engine/ENGINE.json is there with the hash recorded at the copy, and nothing else lives under engine/.
//
// If it fails after a deliberate sync, the sync did not finish (run `npm run sync` again). If it fails otherwise,
// an engine file was edited or added by hand: undo that and make the change in the holo.spot source instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "engine");
const manifest = JSON.parse(readFileSync(join(ENGINE, "ENGINE.json"), "utf8"));
/** The hash as tools/sync-engine.mjs writes it: the first 16 hex characters of the file's sha256. */
const hashOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

/** Every file under a folder, as paths relative to engine/ with forward slashes. */
function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(relative(ENGINE, p).replaceAll("\\", "/"));
  }
  return out;
}

test("ENGINE.json lists the copied files, each with a 16-character hash", () => {
  assert.equal(typeof manifest.files, "object");
  const listed = Object.entries(manifest.files);
  assert.ok(listed.length > 0, "ENGINE.json lists no files");
  for (const [file, hash] of listed) {
    assert.match(String(hash), /^[0-9a-f]{16}$/, `${file}: the recorded hash is not 16 hex characters`);
    assert.ok(!file.startsWith("/") && !file.split("/").includes(".."), `${file}: not a path inside engine/`);
  }
  for (const entry of manifest.entries) assert.ok(entry in manifest.files, `entry module ${entry} is not among the copied files`);
});

test("every file listed in ENGINE.json exists and has the recorded hash", () => {
  const missing = [], changed = [];
  for (const [file, hash] of Object.entries(manifest.files)) {
    const p = join(ENGINE, file);
    if (!existsSync(p)) missing.push(file);
    else if (hashOf(p) !== hash) changed.push(`${file} (recorded ${hash}, now ${hashOf(p)})`);
  }
  assert.deepEqual(missing, [], "listed in ENGINE.json but missing from engine/");
  assert.deepEqual(changed, [], "engine files differ from the copy that was synced (engine files are never edited here)");
});

test("nothing lives under engine/ that ENGINE.json does not list", () => {
  const extra = filesUnder(ENGINE).filter((f) => f !== "ENGINE.json" && !(f in manifest.files)).sort();
  assert.deepEqual(extra, [], "files under engine/ that were not copied by tools/sync-engine.mjs");
});
