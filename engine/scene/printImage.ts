// The image card: the user's picture printed on the paper card (Foil Emboss `emboss.print`).
//
// PrintImage loads the image value (a data URL from the upload, or a same-origin path) into an sRGB texture with
// mipmaps and anisotropic filtering for `uPrintTex` (shaders/paper.glsl printTint), and reports the picture's aspect,
// which sets the card's size (main.ts cardFaceMm). `preparePrintImage` turns a chosen file into the stored value: the
// picture scaled to at most PRINT_MAX_PX on its long side and re-encoded (WebP, else PNG / JPEG), so it fits the panel's
// local storage and saved versions.
import * as THREE from "three";

/** Longest side of the stored picture [px]: 1600 px over the card's 88 mm ≈ 460 dpi. */
export const PRINT_MAX_PX = 1600;
/** The card's long side for a printed image [mm] (the trading card's height). */
export const PRINT_CARD_LONG_MM = 88;
/** The card's aspect (width / height) is kept within this range (very long panoramas become a 4 : 1 strip). */
export const PRINT_ASPECT_RANGE = [0.25, 4] as const;

/** The card face [mm] of a picture of aspect width / height: the long side PRINT_CARD_LONG_MM. */
export function printCardMm(aspectWH: number): { x: number; y: number } {
  const a = Math.min(Math.max(Number.isFinite(aspectWH) && aspectWH > 0 ? aspectWH : 1, PRINT_ASPECT_RANGE[0]), PRINT_ASPECT_RANGE[1]);
  const L = PRINT_CARD_LONG_MM;
  return a >= 1 ? { x: L, y: Math.round((L / a) * 100) / 100 } : { x: Math.round(L * a * 100) / 100, y: L };
}

let white: THREE.DataTexture | null = null;
/** 1 × 1 white placeholder (no print). */
export function printPlaceholder(): THREE.DataTexture {
  if (white) return white;
  white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  white.needsUpdate = true;
  return white;
}

export interface PrintUniforms { uPrintTex: { value: THREE.Texture }; uPrintK: { value: THREE.Vector4 } }

export class PrintImage {
  private url = "";
  /** The last value passed to `set`, as given: the same string again returns at once (called every frame). */
  private raw: string | null = null;
  private tex: THREE.Texture | null = null;
  private aspectWH = 1;
  private loading = false;
  private seq = 0;
  /** Error of the last load (null when it loaded or nothing is set). */
  error: string | null = null;
  /** Called when a picture was installed or cleared (the card's size may change). */
  onChange: (() => void) | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly u: PrintUniforms;

  constructor(renderer: THREE.WebGLRenderer, u: PrintUniforms) {
    this.renderer = renderer;
    this.u = u;
    u.uPrintTex.value = printPlaceholder();
  }

  /** A picture is installed. */
  get loaded(): boolean { return this.tex !== null; }
  /** Width / height of the installed picture (1 when none). */
  get aspect(): number { return this.tex ? this.aspectWH : 1; }
  get ready(): boolean { return !this.loading; }
  get gpuBytes(): number {
    const img = this.tex?.image as { width?: number; height?: number } | undefined;
    return img?.width && img.height ? Math.round(img.width * img.height * 4 * 4 / 3) : 0;
  }

  /** Shows the picture of `url` ("" or "none": no print). No-op when unchanged. */
  set(url: string): void {
    if (url === this.raw) return;                              // (an uploaded picture is a data URL of up to ~1 MB)
    this.raw = url;
    const t = url.trim();
    const v = t.length <= 8 && t.toLowerCase() === "none" ? "" : t;
    if (v === this.url) return;
    this.url = v;
    const seq = ++this.seq;
    if (!v) { this.install(null, 1); this.loading = false; return; }
    this.loading = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (seq !== this.seq) return;
      this.loading = false;
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { this.fail("the image is empty"); return; }
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      t.needsUpdate = true;
      this.error = null;
      this.install(t, w / h);
    };
    img.onerror = () => { if (seq === this.seq) { this.loading = false; this.fail("the image could not be read"); } };
    img.src = v;
  }

  private fail(msg: string): void {
    this.error = msg;
    this.install(null, 1);
  }

  private install(t: THREE.Texture | null, aspect: number): void {
    const old = this.tex;
    this.tex = t;
    this.aspectWH = aspect;
    this.u.uPrintTex.value = t ?? printPlaceholder();
    if (old && old !== t) old.dispose();
    this.onChange?.();
  }
}

/** The stored value of a chosen picture: scaled to ≤ `maxPx` on its long side (the image card's PRINT_MAX_PX; the
 *  flag's is smaller, A14), WebP (alpha kept) where the browser encodes it, else PNG (with transparency) or JPEG.
 *  Rejects files that are not decodable images. */
export async function preparePrintImage(file: Blob, maxPx = PRINT_MAX_PX): Promise<string> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("choose a PNG, JPEG, WebP or GIF image"); }
  const k = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  if (!g) { bmp.close(); throw new Error("no 2D canvas"); }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const webp = c.toDataURL("image/webp", 0.9);
  if (webp.startsWith("data:image/webp")) return webp;
  let alpha = false;
  const d = g.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { alpha = true; break; }
  return alpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.9);
}
