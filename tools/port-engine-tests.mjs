#!/usr/bin/env node
// Ports holo.spot's own unit tests for the modules that live in holospot's engine/.
//
//   node tools/port-engine-tests.mjs --from "/path/to/holo-spot-source" [--dry]
//
// The engine under engine/ is a copy of part of the holo.spot source (tools/sync-engine.mjs). The site tests its
// modules in tests/*.test.ts, importing them from ../src/…. A test is ported only if EVERY module it imports is in
// engine/ (type-only imports count too; Node built-ins and packages holospot itself depends on are fine); nothing is
// copied into holospot to make a test pass. A ported test goes to tests/engine/<name>.test.ts with its paths
// re-pointed and is otherwise unchanged:
//   "../src/…"            → "../../engine/…"         imports, and files read through new URL(…, import.meta.url)
//   "../public/holo3d/…"  → "../../assets/holo3d/…"  the hologram subjects, which holospot ships under assets/
// A test that reads any other file of the site through new URL(…, import.meta.url) is skipped.
//
// Run it after `npm run sync`: tests/engine/*.test.ts is replaced as a whole (do not edit those files by hand), and
// the list of ported and skipped tests is printed with the reason for each skip. --dry prints the list only.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fromArg = args.indexOf("--from");
if (fromArg < 0 || !args[fromArg + 1]) { console.error('usage: node tools/port-engine-tests.mjs --from "<holo.spot source>" [--dry]'); process.exit(2); }
const FROM = resolve(args[fromArg + 1]), DRY = args.includes("--dry");
const SITE_TESTS = join(FROM, "tests"), ENGINE = join(ROOT, "engine"), OUT = join(ROOT, "tests", "engine");
if (!existsSync(SITE_TESTS)) { console.error(`no tests/ folder in ${FROM}`); process.exit(2); }

// import … from "x" / export … from "x" (with or without `type`), import "x", import("x")
const IMPORT = /(?:import|export)\s+(?:type\s+)?[^;'"]*?from\s+(["'])([^"']+)\1|import\s+(["'])([^"']+)\3|import\(\s*(["'])([^"']+)\5\s*\)/gs;
// new URL("x", import.meta.url): a file the test reads from disk
const FILE_URL = /new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const SRC = "../src/", SUBJECTS = "../public/holo3d/";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PACKAGES = new Set(["dependencies", "devDependencies", "peerDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {})));
/** "three/addons/x.js" → "three", "@scope/name/x" → "@scope/name". */
const packageOf = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
/** The part of a path before its first template placeholder (`../src/shaders/${f}` → `../src/shaders/`). */
const fixedPart = (p) => (p.includes("${") ? p.slice(0, p.indexOf("${")) : p);

/** Why a test cannot be ported (a list of reasons; empty = it can). */
function obstacles(text) {
  const why = new Set();
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[2] ?? m[4] ?? m[6];
    if (spec.startsWith("node:") || spec.includes("://")) continue;      // a built-in; a URL inside a test string
    if (spec.startsWith(".") && !spec.startsWith(SRC)) why.add(`imports ${spec} (not a module of the site's src/)`);
    else if (!spec.startsWith(".")) { if (!PACKAGES.has(packageOf(spec))) why.add(`imports the package "${spec}" (not a dependency of holospot)`); }
    else if (!existsSync(join(ENGINE, spec.slice(SRC.length).split("?")[0]))) why.add(`imports src/${spec.slice(SRC.length)} (not in engine/)`);
  }
  for (const m of text.matchAll(FILE_URL)) {
    const p = m[2];
    if (p.startsWith(SRC)) { if (!existsSync(join(ENGINE, fixedPart(p).slice(SRC.length)))) why.add(`reads src/${p.slice(SRC.length)} (not in engine/)`); }
    else if (p.startsWith(SUBJECTS)) { if (!existsSync(join(ROOT, "assets", "holo3d"))) why.add("reads the hologram subjects (assets/holo3d/ is missing)"); }
    else why.add(`reads ${p} (a file of the site that holospot does not have)`);
  }
  return [...why];
}

/** The test with its paths re-pointed at holospot; nothing else changes. */
function port(text) {
  const repoint = (p) => (p.startsWith(SRC) ? `../../engine/${p.slice(SRC.length)}` : p.startsWith(SUBJECTS) ? `../../assets/holo3d/${p.slice(SUBJECTS.length)}` : p);
  const inQuotes = (whole, quote, p) => whole.replace(`${quote}${p}${quote}`, () => `${quote}${repoint(p)}${quote}`);
  return text
    .replace(IMPORT, (whole, q1, p1, q2, p2, q3, p3) => inQuotes(whole, q1 ?? q2 ?? q3, p1 ?? p2 ?? p3))
    .replace(FILE_URL, (whole, quote, p) => inQuotes(whole, quote, p));
}

const ported = [], skipped = [];
for (const name of readdirSync(SITE_TESTS).filter((f) => f.endsWith(".test.ts")).sort()) {
  const text = readFileSync(join(SITE_TESTS, name), "utf8"), why = obstacles(text);
  if (why.length) skipped.push([name, why]); else ported.push([name, port(text)]);
}
if (!DRY) {
  if (existsSync(OUT)) for (const f of readdirSync(OUT)) if (f.endsWith(".test.ts")) rmSync(join(OUT, f));
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of ported) writeFileSync(join(OUT, name), text);
}
console.log(`${DRY ? "would port" : "ported"} ${ported.length} of ${ported.length + skipped.length} tests${DRY ? "" : " to tests/engine/"}:`);
for (const [name] of ported) console.log(`  ${name}`);
console.log(`skipped ${skipped.length}:`);
for (const [name, why] of skipped) console.log(`  ${name}: ${why.join("; ")}`);
