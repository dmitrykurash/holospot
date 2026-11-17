// Renderer creation and capabilities (spec §1.4, §5.5, §6.1, §6.4, §6.8).
// WebGLRenderer({ antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true,
// preserveDrawingBuffer: false, powerPreference: "high-performance" }), NoToneMapping. The canvas has no depth buffer;
// the only one is the HDR target's (render/pipeline.ts, addendum A1.1).
import * as THREE from "three";
import WebGL from "three/addons/capabilities/WebGL.js";
import { DisplayP3ColorSpace } from "three/addons/math/ColorSpaces.js";
import { rendererString } from "./tier.ts";

export interface RendererCaps {
  webgl2: boolean;
  colorBufferFloat: boolean;       // EXT_color_buffer_float: HalfFloat HDR target; else the LDR fallback (§5.5)
  rgba16fSamples: number;          // max MSAA samples of an RGBA16F renderbuffer (getInternalformatParameter)
  p3Available: boolean;            // (color-gamut: p3) and a display-p3 drawing buffer
  timerQuery: boolean;             // EXT_disjoint_timer_query_webgl2 (card-pass GPU time)
  parallelCompile: boolean;        // KHR_parallel_shader_compile (background compiles, §6.4)
  rendererString: string;
}
export interface RendererHooks {
  onContextLost?(): void;          // e.g. caption "reloading…"
  onContextRestored?(): void;      // default: reload the page (DialKit values persist; URL views reproduce)
}

/** Errors raised by the renderer (shader compile/link, context loss) before or after `window.__holo` exists.
 *  WP-G's holoApi should start `__holo.errors` with these entries; later ones are pushed to both. */
export const renderErrors: string[] = [];

export function reportRenderError(msg: string): void {
  renderErrors.push(msg);
  const holo = typeof window !== "undefined" ? window.__holo : undefined;
  if (holo && Array.isArray(holo.errors) && holo.errors !== renderErrors && !holo.errors.includes(msg)) holo.errors.push(msg);
  console.error(msg);
}

function excerpt(source: string, log: string): string {
  const m = /ERROR: \d+:(\d+)/.exec(log);
  if (!m) return "";
  const line = parseInt(m[1], 10), lines = source.split("\n");
  const from = Math.max(line - 4, 0), to = Math.min(line + 3, lines.length);
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(`${i + 1 === line ? ">" : " "} ${i + 1}: ${lines[i]}`);
  return out.join("\n");
}

const clean = (s: string | null) => (s || "").replace(/\0/g, "").trim();

function shaderReport(gl: WebGL2RenderingContext, program: WebGLProgram, vs: WebGLShader, fs: WebGLShader): string {
  const parts: string[] = ["[shader] program failed to link"];
  const plog = clean(gl.getProgramInfoLog(program));
  if (plog) parts.push(`program: ${plog}`);
  for (const [name, sh] of [["vertex", vs], ["fragment", fs]] as const) {
    const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    const log = clean(gl.getShaderInfoLog(sh));
    if (ok && !log) continue;
    parts.push(`${name}: ${log || "(no log)"}`);
    const ex = excerpt(gl.getShaderSource(sh) || "", log);
    if (ex) parts.push(ex);
  }
  return parts.join("\n");
}

/** Creates the renderer; throws `Error("WebGL 2 required")` when no WebGL 2 context can be created (the caller shows
 *  that caption and stops, §1.4). Installs `debug.onShaderError` → `__holo.errors` and the context-loss handlers. */
export function createRenderer(canvas: HTMLCanvasElement, hooks: RendererHooks = {}): { renderer: THREE.WebGLRenderer; caps: RendererCaps } {
  if (typeof WebGL2RenderingContext === "undefined") throw new Error("WebGL 2 required");
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: "high-performance",
    });
  } catch {
    throw new Error("WebGL 2 required");
  }
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;                       // the pipeline clears its targets explicitly (§5.5)
  renderer.setClearColor(0x000000, 0);
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vs, fs) =>
    reportRenderError(shaderReport(gl as WebGL2RenderingContext, program, vs, fs));

  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = renderer.extensions;
  const colorBufferFloat = ext.has("EXT_color_buffer_float");
  let rgba16fSamples = 0;
  if (colorBufferFloat) {
    try {
      const s = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null;
      if (s && s.length) rgba16fSamples = Math.max(...Array.from(s));
    } catch { rgba16fSamples = 0; }
  }
  let p3Available = false;
  try {
    p3Available = typeof matchMedia === "function" && matchMedia("(color-gamut: p3)").matches
      && WebGL.isColorSpaceAvailable(DisplayP3ColorSpace);
  } catch { p3Available = false; }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    reportRenderError("[webgl] context lost");
    hooks.onContextLost?.();
  }, false);
  canvas.addEventListener("webglcontextrestored", () => {
    if (hooks.onContextRestored) hooks.onContextRestored();
    else location.reload();
  }, false);

  return {
    renderer,
    caps: {
      webgl2: true, colorBufferFloat, rgba16fSamples, p3Available,
      timerQuery: ext.has("EXT_disjoint_timer_query_webgl2"),
      parallelCompile: ext.has("KHR_parallel_shader_compile"),
      rendererString: rendererString(gl),
    },
  };
}
