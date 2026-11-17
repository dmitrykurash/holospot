#!/usr/bin/env node
// Screenshots of pages that use the kit, in headless Chrome. This is how an agent looks at what it made.
//
//   node tools/shot.mjs --page recipes/card.html --out out
//   node tools/shot.mjs --page "tests/pages/basic.html?material=prism" --name prism --size 900x700
//   node tools/shot.mjs --url http://localhost:5173/ --name my-site
//
// The page must call `holo.expose()`: the tool waits for `window.__holo.ready`, fails on any entry in
// `window.__holo.errors` or any console error, and writes one PNG per page plus out/report.json.
//
// Options
//   --page <path[?query]>   a file of this repository, served by a small local server (repeatable)
//   --url <url>             any URL instead (repeatable)
//   --name <name>           file name of the PNG for the page or URL just before it (default: from the path)
//   --size WxH              viewport in CSS px (default 900x700)        --dpr N   device pixel ratio (default 1)
//   --frames N              frames the page must have drawn (default 3) --timeout ms   per page (default 240000)
//   --gl swiftshader|native software WebGL (default: works without a GPU, slow) or the machine's GPU
//   --out <dir>             output folder (default out)
//
// Chrome: set CHROME_PATH to a Chrome, Chromium or chrome-headless-shell binary (CHROME_LIBS: an extra shared-library
// folder, if it needs one). Requests for three.js on the jsDelivr CDN are answered from node_modules, so the recipes
// render without a network.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".sdf": "application/octet-stream", ".wasm": "application/wasm" };

export function parseArgs(argv) {
  const o = { targets: [], width: 900, height: 700, dpr: 1, frames: 3, timeout: 240000, gl: "swiftshader", out: join(ROOT, "out") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--page") { o.targets.push({ page: v }); i++; }
    else if (a === "--url") { o.targets.push({ url: v }); i++; }
    else if (a === "--name") { if (o.targets.length) o.targets[o.targets.length - 1].name = v; i++; }
    else if (a === "--size") { const [w, h] = v.split("x").map(Number); o.width = w; o.height = h; i++; }
    else if (a === "--dpr") { o.dpr = Number(v); i++; }
    else if (a === "--frames") { o.frames = Number(v); i++; }
    else if (a === "--timeout") { o.timeout = Number(v); i++; }
    else if (a === "--gl") { o.gl = v; i++; }
    else if (a === "--out") { o.out = resolve(v); i++; }
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export function findChrome() {
  const env = process.env.CHROME_PATH || process.env.HOLO_CHROME;
  if (env) return env;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** A static server for the repository (and nothing above it); `mounts` maps URL prefixes to other folders. */
export function serve(root = ROOT, mounts = {}) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const mount = Object.keys(mounts).find((m) => path.startsWith(m));
    const base = mount ? mounts[mount] : root;
    let file = normalize(join(base, mount ? path.slice(mount.length) : path));
    if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

export async function launch(o) {
  const chrome = findChrome();
  if (!chrome || !existsSync(chrome)) throw new Error("no Chrome found: set CHROME_PATH to a Chrome, Chromium or chrome-headless-shell binary");
  const { default: puppeteer } = await import("puppeteer-core");
  const args = o.gl === "native"
    ? ["--no-sandbox", "--ignore-gpu-blocklist", "--enable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"]
    : ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-watchdog", "--hide-scrollbars", "--force-color-profile=srgb"];
  const libs = process.env.CHROME_LIBS || process.env.HOLO_CHROME_LIBS;
  return puppeteer.launch({
    executablePath: chrome, headless: /headless-shell/.test(chrome) ? "shell" : true, args, protocolTimeout: o.timeout + 60000,
    env: { ...process.env, ...(libs ? { LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}) },
  });
}

/** Opens one page, waits for the kit, and hands the page to `use`. Returns the report entry. */
export async function withPage(browser, url, o, use) {
  const entry = { url, ok: false, errors: [], console: [] };
  const page = await browser.newPage();
  await page.setViewport({ width: o.width, height: o.height, deviceScaleFactor: o.dpr });
  page.on("console", (m) => { if (m.type() === "error") entry.console.push(m.text()); });
  page.on("pageerror", (e) => entry.errors.push(`pageerror: ${e.message}`));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const m = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.+)$/.exec(req.url());
    const local = m ? join(ROOT, "node_modules", "three", m[1].split("?")[0]) : null;
    if (local && existsSync(local)) req.respond({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: readFileSync(local) });
    else req.continue();
  });
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "load", timeout: o.timeout });
    await page.waitForFunction((n) => !!window.__holo && window.__holo.ready === true && window.__holo.frames >= n, { timeout: o.timeout, polling: 250 }, o.frames);
    entry.errors.push(...await page.evaluate(() => window.__holo.errors));
    entry.info = await page.evaluate(() => window.__holo.info ?? null);
    if (use) await use(page, entry);
    entry.ok = entry.errors.length === 0 && entry.console.length === 0;
  } catch (e) {
    entry.errors.push(String(e && e.message || e));
    try { entry.errors.push(...await page.evaluate(() => (window.__holo ? window.__holo.errors : ["window.__holo is missing: call holo.expose()"]))); } catch { /* page gone */ }
  }
  entry.ms = Date.now() - t0;
  await page.close();
  return entry;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.targets.length) throw new Error("nothing to shoot: pass --page <file> or --url <url>");
  mkdirSync(o.out, { recursive: true });
  const { server, origin } = await serve();
  const browser = await launch(o);
  const report = [];
  try {
    for (const t of o.targets) {
      const url = t.url ?? `${origin}/${t.page.replace(/^\//, "")}`;
      const name = t.name ?? (t.page ?? t.url).split("?")[0].split("/").pop().replace(/\.html?$/, "") ?? "page";
      const file = join(o.out, `${name}.png`);
      const entry = await withPage(browser, url, o, async (page) => { await page.screenshot({ path: file, type: "png" }); });
      entry.name = name; entry.file = file;
      report.push(entry);
      console.log(`${entry.ok ? "ok  " : "FAIL"} ${name}  ${(entry.ms / 1000).toFixed(1)} s${entry.ok ? "" : "\n     " + [...entry.errors, ...entry.console].join("\n     ")}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(o.out, "report.json"), JSON.stringify(report, null, 2));
  process.exit(report.every((e) => e.ok) ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message || e); process.exit(2); });
