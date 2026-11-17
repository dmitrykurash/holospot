#!/usr/bin/env node
// Compares two PNG screenshots pixel by pixel (in headless Chrome, so the kit needs no image library).
//
//   node tools/compare.mjs a.png b.png [--mean 0.5] [--p999 6]
//
// Prints the difference in 8-bit code values (the largest of the three channels per pixel): the mean over the frame,
// the 99.9th percentile, the largest, and the share of pixels that differ at all. Exits 1 when the mean or the
// 99.9th percentile is above its limit. Chrome: see tools/shot.mjs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./shot.mjs";

/** The difference of two PNGs (Buffers) on a page of `browser`. */
export async function diffPngs(browser, a, b) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (x, y) => {
      const load = async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height);
      };
      const A = await load(x), B = await load(y);
      if (A.width !== B.width || A.height !== B.height) return { error: `sizes differ: ${A.width}x${A.height} and ${B.width}x${B.height}` };
      const n = A.width * A.height, hist = new Uint32Array(256);
      let sum = 0, max = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.max(Math.abs(A.data[4 * i] - B.data[4 * i]), Math.abs(A.data[4 * i + 1] - B.data[4 * i + 1]), Math.abs(A.data[4 * i + 2] - B.data[4 * i + 2]));
        hist[d]++; sum += d; if (d > max) max = d;
      }
      let acc = 0, p999 = 0;
      for (let d = 255; d >= 0; d--) { acc += hist[d]; if (acc >= n * 0.001) { p999 = d; break; } }
      return { mean: sum / n, p999, max, differing: (n - hist[0]) / n };
    }, a.toString("base64"), b.toString("base64"));
  } finally {
    await page.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] ?? "").startsWith("--"));
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
  if (files.length !== 2) { console.error("usage: node tools/compare.mjs a.png b.png [--mean 0.5] [--p999 6]"); process.exit(2); }
  const browser = await launch({ gl: "swiftshader", timeout: 60000 });
  let d;
  try { d = await diffPngs(browser, readFileSync(files[0]), readFileSync(files[1])); } finally { await browser.close(); }
  if (d.error) { console.error(d.error); process.exit(1); }
  const ok = d.mean <= arg("--mean", 0.5) && d.p999 <= arg("--p999", 6);
  console.log(`${ok ? "ok  " : "FAIL"} mean ${d.mean.toFixed(3)}  p99.9 ${d.p999}  max ${d.max}  differing ${(100 * d.differing).toFixed(2)} %`);
  process.exit(ok ? 0 : 1);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message || e); process.exit(2); });
