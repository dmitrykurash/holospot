#!/usr/bin/env node
// Renders a page that uses the kit into a video, frame by frame, in headless Chrome.
//
//   node tools/render-video.mjs --page recipes/video-turntable.html --seconds 6 --fps 30 --size 1280x720 --out out/turntable
//
// The page's contract (see recipes/video-turntable.html):
//   • it calls `holo.expose()`, and
//   • it defines `window.renderFrame = (t) => { … holo.render(scene, camera, { time: t, dt: 1 / fps }); }`, which
//     draws the frame for time t [s] from nothing but t (no clock, no requestAnimationFrame state).
// The tool waits until the page is ready, then for every frame calls renderFrame(t) and saves the canvas as a PNG
// (out/frame-000001.png …). With ffmpeg on the PATH (or FFMPEG_PATH set) it then encodes out/video.mp4 (H.264,
// yuv420p); without it, it prints the ffmpeg command to run.
//
// Options
//   --page <path[?query]> | --url <url>     what to render
//   --seconds S   --fps N (default 30)      length and frame rate        --from S   start time (default 0)
//   --size WxH (default 1280x720)           --dpr N (default 1)
//   --gl native|swiftshader                 `native` uses the GPU and is far faster; `swiftshader` (default) needs none
//   --out <dir>                             output folder (default out/video)
//   --crf N (default 16)                    ffmpeg quality (lower is better)
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve, withPage } from "./shot.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const pageArg = arg("--page"), urlArg = arg("--url");
if (!pageArg && !urlArg) { console.error("usage: node tools/render-video.mjs --page <file> --seconds S [--fps 30] [--size 1280x720] [--out dir]"); process.exit(2); }
const seconds = Number(arg("--seconds", "4")), fps = Number(arg("--fps", "30")), from = Number(arg("--from", "0"));
const [W, H] = arg("--size", "1280x720").split("x").map(Number);
const OUT = resolve(arg("--out", join(ROOT, "out", "video")));
const frames = Math.max(1, Math.round(seconds * fps));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { server, origin } = await serve();
  const o = { width: W, height: H, dpr: Number(arg("--dpr", "1")), frames: 1, timeout: 600000, gl: arg("--gl", "swiftshader") };
  const browser = await launch(o);
  let ok = false;
  try {
    const url = urlArg ?? `${origin}/${pageArg.replace(/^\//, "")}`;
    const entry = await withPage(browser, url, o, async (page, e) => {
      if (!(await page.evaluate(() => typeof window.renderFrame === "function"))) { e.errors.push("the page does not define window.renderFrame(t)"); return; }
      const t0 = Date.now();
      for (let i = 0; i < frames; i++) {
        const t = from + i / fps;
        const data = await page.evaluate(async (time) => {
          await window.renderFrame(time);
          return document.querySelector("canvas").toDataURL("image/png");
        }, t);
        writeFileSync(join(OUT, `frame-${String(i + 1).padStart(6, "0")}.png`), Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
        if (i === 0 || (i + 1) % 10 === 0 || i === frames - 1) {
          const per = (Date.now() - t0) / (i + 1) / 1000;
          console.log(`frame ${i + 1}/${frames}  ${per.toFixed(1)} s per frame, about ${Math.ceil(per * (frames - i - 1))} s left`);
        }
      }
      e.errors.push(...await page.evaluate(() => window.__holo.errors));
    });
    ok = entry.errors.length === 0;
    if (!ok) console.error(entry.errors.concat(entry.console).join("\n"));
  } finally {
    await browser.close();
    server.close();
  }
  if (!ok) process.exit(1);
  const ff = ["-y", "-framerate", String(fps), "-i", join(OUT, "frame-%06d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", arg("--crf", "16"), "-movflags", "+faststart", join(OUT, "video.mp4")];
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ff, { stdio: "ignore" });
  if (r.status === 0) console.log(`video: ${join(OUT, "video.mp4")} (${frames} frames, ${fps} fps)`);
  else console.log(`frames are in ${OUT}. ffmpeg was not found or failed; encode with:\n  ffmpeg ${ff.map((a) => (/[ %]/.test(a) ? `"${a}"` : a)).join(" ")}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(2); });
