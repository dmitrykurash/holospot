// Print text (spec §5.7): real text rendered with Canvas2D (600 … system-ui, no font assets) into a 1024 × 512 R8
// coverage texture at 16 px/mm covering the title band and the info panel; mipmapped, maximum anisotropy, sampled
// with textureGrad in print.glsl (`uTextTex`). Rendered at start-up and on a material change.
//
// Layout contract (shared with print.glsl `printTextUv`): canvas pixel (cx, cy), origin top-left, ↔ card mm (x, y):
// cx = (x + 0.5)·16; rows 0–255 hold the title band, cy = (88 − y)·16 (card y 72–88); rows 256–511 the info panel,
// cy = (36 − y)·16 (card y 4–20). The texture rows are stored bottom-up (the effect of flipY = true), so texture
// v = 0 is canvas row 511. Text is drawn at the art/frame positions (print.glsl re-maps it for the window mode):
//   title  material name, weight 600, 4.2 mm, left-aligned at x 4.6, baseline "middle" at y 81.7
//   value  pitch, e.g. "1000 l/mm", weight 600, 3.0 mm, right-aligned at x 58.4, middle at y 81.7, fitted to start
//          at x ≥ 42.2 (≤ 16.2 mm wide)
//   info   caption / analog / "procedural holographic card · v1", weight 500, 2.2 mm, left at x 7.0, middle at
//          y 15.5 / 12.0 / 8.5 (each line fitted to end by x 57.5 so the window re-map stays inside its panel)
// The window mode shows the title band's x < 42 mm only (print.glsl): the title is fitted to end by x 41.6 and the
// value to start after 42, so the window title shows the whole name and never a part of the value.
import * as THREE from "three";
import type { MaterialDef, ParamValues } from "../types.ts";

export const PRINT_TEXT = {
  width: 1024, height: 512, pxPerMm: 16,
  title: { x: 4.6, y: 81.7, sizeMm: 4.2, weight: 600 },
  value: { x: 58.4, y: 81.7, sizeMm: 3.0, weight: 600, minX: 42.2 },
  titleMaxX: 41.6,
  info: { x: 7.0, ys: [15.5, 12.0, 8.5] as const, sizeMm: 2.2, weight: 500, maxX: 57.5 },
  footer: "procedural holographic card · v1",
} as const;
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const cxOf = (xMm: number) => (xMm + 0.5) * PRINT_TEXT.pxPerMm;
const cyTitle = (yMm: number) => (88 - yMm) * PRINT_TEXT.pxPerMm;
const cyInfo = (yMm: number) => (36 - yMm) * PRINT_TEXT.pxPerMm;

/** The value label of a material (title band, right): its `valueLabel` when set (addendum A2.3.4, e.g. the Volume
 *  Hologram's "3D · 545 nm"), else the caption's "… l/mm" segment, else the default pitches as lines per mm. */
export function pitchLabel(def: MaterialDef): string {
  if (typeof def.valueLabel === "string") return def.valueLabel.trim();   // "" prints no value
  const seg = def.caption.split("·").map((s) => s.trim()).find((s) => /l\/mm/.test(s));
  if (seg) return seg;
  try {
    const defaults: ParamValues = Object.fromEntries(def.params.map((p) => [p.id, p.default]));
    const p = def.gratingSummary(defaults).pitchesNm.filter((x) => x > 0).map((x) => Math.round(1e6 / x));
    if (!p.length) return "";
    const lo = Math.min(...p), hi = Math.max(...p);
    return lo === hi ? `${lo} l/mm` : `${lo}–${hi} l/mm`;
  } catch {
    return "";
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, sizePx: number, maxWidthPx: number): void {
  let size = sizePx;
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
  const w = ctx.measureText(text).width;
  if (w > maxWidthPx && w > 0) {                     // shrink up to 25 %, then compress horizontally (fillText maxWidth)
    size = Math.max(sizePx * 0.75, sizePx * (maxWidthPx / w));
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
  }
}

/** Renders the text coverage texture of a material (white text on black, red channel = coverage). */
export function renderPrintText(def: MaterialDef): THREE.Texture {
  const { width: W, height: H, pxPerMm: k } = PRINT_TEXT;
  const data = new Uint8Array(W * H);
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = canvas ? (canvas.width = W, canvas.height = H, canvas.getContext("2d", { willReadFrequently: true })) : null;
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";

    // value (right) first, so the title can stop short of it
    const value = pitchLabel(def);
    let valueLeft = cxOf(PRINT_TEXT.value.x);
    if (value) {
      ctx.textAlign = "right";
      const valueMax = (PRINT_TEXT.value.x - PRINT_TEXT.value.minX) * k;
      fitText(ctx, value, PRINT_TEXT.value.weight, PRINT_TEXT.value.sizeMm * k, valueMax);
      const vw = Math.min(ctx.measureText(value).width, valueMax);
      ctx.fillText(value, cxOf(PRINT_TEXT.value.x), cyTitle(PRINT_TEXT.value.y), valueMax);
      valueLeft -= vw;
    }
    ctx.textAlign = "left";
    const titleMax = Math.min(valueLeft - 2 * k, cxOf(PRINT_TEXT.titleMaxX)) - cxOf(PRINT_TEXT.title.x);
    fitText(ctx, def.name, PRINT_TEXT.title.weight, PRINT_TEXT.title.sizeMm * k, titleMax);
    ctx.fillText(def.name, cxOf(PRINT_TEXT.title.x), cyTitle(PRINT_TEXT.title.y), titleMax);

    const lines = [def.caption, def.analog, PRINT_TEXT.footer];
    const infoMax = (PRINT_TEXT.info.maxX - PRINT_TEXT.info.x) * k;
    lines.forEach((line, i) => {
      if (!line) return;
      fitText(ctx, line, PRINT_TEXT.info.weight, PRINT_TEXT.info.sizeMm * k, infoMax);
      ctx.fillText(line, cxOf(PRINT_TEXT.info.x), cyInfo(PRINT_TEXT.info.ys[i]), infoMax);
    });

    // Red channel → coverage, rows bottom-up (texture v = 0 at canvas row H − 1, i.e. flipY = true).
    const img = ctx.getImageData(0, 0, W, H).data;
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4, dst = y * W;
      for (let x = 0; x < W; x++) data[dst + x] = img[src + 4 * x];
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = `printText-${def.id}`;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 16;                               // three clamps to the device maximum
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
