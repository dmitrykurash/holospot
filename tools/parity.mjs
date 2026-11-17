#!/usr/bin/env node
// Parity check: the same model, material, settings, tilt and camera, drawn once by holo.spot's own code and once by
// the kit, compared pixel by pixel.
//
//   node tools/parity.mjs --from "/path/to/holo-spot-source" [--only prism,nebula] [--size 600x450] [--out out/parity]
//
// It starts the site's dev server from that source tree, renders each view of tests/parity-views.json on both sides
// in the same headless Chrome, and reports the difference in 8-bit code values: the mean over the frame, the 99.9th
// percentile and the largest. Identical code paths give 0; the check passes while mean ≤ 0.5 and p99.9 ≤ 6.
// Views with "card": true compare the kit's card with the site's; the others wrap a model, by default the site's own
// demo model, read from the source tree (it is not part of this repository; --model names another site path).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve, withPage } from "./shot.mjs";
import { diffPngs } from "./compare.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = arg("--from");
if (!FROM || !existsSync(join(FROM, "src", "main.ts"))) { console.error('usage: node tools/parity.mjs --from "<holo.spot source>"'); process.exit(2); }
const [W, H] = arg("--size", "600x450").split("x").map(Number);
const OUT = resolve(arg("--out", join(ROOT, "out", "parity")));
const only = arg("--only", "").split(",").filter(Boolean);
const MODEL = arg("--model", "/demo/object.glb");
const params = JSON.parse(readFileSync(join(ROOT, "src", "data", "params.json"), "utf8"));
const specs = new Map([...params.scene, ...Object.values(params.materials).flat()].map((p) => [p.id, p]));
const views = JSON.parse(readFileSync(join(ROOT, "tests", "parity-views.json"), "utf8")).filter((v) => !only.length || only.includes(v.name));

const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const num = (x) => String(Number(Number(x).toFixed(6)));
function siteValue(id, v) {
  const kind = specs.get(id)?.kind;
  if (kind === "toggle") return v ? "1" : "0";
  if (kind === "pad") return `${num(v.x)},${num(v.y)}`;
  return typeof v === "number" ? num(v) : String(v);
}
function siteQuery(v) {
  const q = new URLSearchParams({ ui: "0", freeze: "1", persist: "0", quality: v.quality ?? "low", dpr: "1", t: "0", material: v.material, tilt: (v.tilt ?? [0, 0, 0]).join(",") });
  if (!v.card) q.set("model", MODEL);                    // a card view shows the site's card; the others its model object
  const s = { ...(v.settings ?? {}) };
  if (s["studio.preset"] !== undefined) { q.set("studio", s["studio.preset"]); delete s["studio.preset"]; }
  for (const [id, val] of Object.entries(s)) q.set(id, siteValue(id, val));
  return q.toString();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  const vite = spawn(process.execPath, [join(FROM, "node_modules", "vite", "bin", "vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: FROM, stdio: ["ignore", "pipe", "pipe"] });
  let viteLog = "";
  vite.stdout.on("data", (d) => { viteLog += d; });
  vite.stderr.on("data", (d) => { viteLog += d; });
  const site = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(site)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  const { server, origin } = await serve(ROOT, { "/__site/": join(FROM, "public") });
  const o = { width: W, height: H, dpr: 1, frames: 3, timeout: 420000, gl: arg("--gl", "swiftshader") };
  const browser = await launch(o);
  const report = [];
  let failed = 0;
  try {
    for (const v of views) {
      const shots = {};
      const a = await withPage(browser, `${site}/?${siteQuery(v)}`, o, async (page) => { shots.site = await page.screenshot({ type: "png" }); });
      const kitView = { ...v, model: `/__site${MODEL}` };
      const b = await withPage(browser, `${origin}/tests/pages/parity.html?view=${encodeURIComponent(JSON.stringify(kitView))}`, o, async (page) => { shots.kit = await page.screenshot({ type: "png" }); });
      const entry = { name: v.name, site: { ok: a.ok, errors: [...a.errors, ...a.console], ms: a.ms }, kit: { ok: b.ok, errors: [...b.errors, ...b.console], ms: b.ms } };
      if (shots.site) writeFileSync(join(OUT, `${v.name}-site.png`), shots.site);
      if (shots.kit) writeFileSync(join(OUT, `${v.name}-kit.png`), shots.kit);
      if (shots.site && shots.kit) {
        const diff = await diffPngs(browser, shots.site, shots.kit);
        Object.assign(entry, diff);
      }
      entry.pass = entry.site.ok && entry.kit.ok && entry.mean !== undefined && entry.mean <= 0.5 && entry.p999 <= 6;
      if (!entry.pass) failed++;
      report.push(entry);
      console.log(`${entry.pass ? "ok  " : "FAIL"} ${v.name.padEnd(18)} mean ${entry.mean?.toFixed(3) ?? "-"}  p99.9 ${entry.p999 ?? "-"}  max ${entry.max ?? "-"}  differing ${entry.differing !== undefined ? (100 * entry.differing).toFixed(2) + " %" : "-"}  (site ${(a.ms / 1000).toFixed(0)} s, kit ${(b.ms / 1000).toFixed(0)} s)${entry.error ? "  " + entry.error : ""}`);
      for (const e of [...entry.site.errors.map((x) => `site: ${x}`), ...entry.kit.errors.map((x) => `kit: ${x}`)]) console.log(`     ${e.slice(0, 400)}`);
    }
  } finally {
    await browser.close();
    server.close();
    vite.kill();
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  if (!report.length) console.log(viteLog.slice(-800));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
