// A6 Foil Emboss: the shared uniforms of the paper card and the assets behind them (the logo SDF and the paper maps).
//
// The emboss uniforms are module singletons (one IUniform object per name): materials/emboss.ts returns them from
// createUniforms() and writes them in apply(); main.ts registers them into the shared uniform map at start-up (before
// any material is built), so the card back and edge shaders (paper back with the reverse impression, fibrous paper
// edge) read the same objects. `uPaperCard` (1 while Foil Emboss is shown) switches back and edge to paper.
// Addendum A9: the hologram sticker's analytic shape (uLogoShape, uShapeK, uShapeT; emboss.glsl, read only by the
// programs built with EMB_STICKER) is shared too, so the card back shows the sticker's reverse impression.
// EmbossAssets owns the textures: LogoMaps (scene/logo.ts) and PaperMaps (scene/paperMaps.ts), loaded lazily — only
// while the material is shown — and reported to `ready` / busy like the bump map and the volume.
import * as THREE from "three";
import type { ParamValues, Uniforms } from "../types.ts";
import { LogoMaps, logoPlaceholder } from "./logo.ts";
import type { LogoInfo, LogoUniforms } from "./logo.ts";
import { PaperMaps, paperPlaceholder } from "./paperMaps.ts";
import { PrintImage, printPlaceholder } from "./printImage.ts";
import type { PrintUniforms } from "./printImage.ts";
import type { PaperUniforms } from "./paperMaps.ts";
import { LOGO_DEFAULT, PAPER_STOCKS } from "../materials/emboss.params.ts";
import { MAX_LOGOS } from "../app/paperDoc.ts";
import { multiUniforms } from "../materials/embossMulti.ts";

export interface EmbossShared extends LogoUniforms, PaperUniforms, PrintUniforms {
  uLogoXf: { value: THREE.Vector4 };      // (x − 31.5, y − 44) mm, cos θ, sin θ
  uLogoW: { value: number };              // logo width [mm]
  uRelief: { value: THREE.Vector4 };      // H, shoulder s, puff height hp, puff reach λ [mm]
  uRelProfile: { value: number };         // 0 round, 1 bevel, 2 dome, 3 deboss
  uLogoShape: { value: number };          // A9: 0 the logo texture, 1 rounded box, 2 ellipse (hologram-sticker programs only)
  uShapeK: { value: THREE.Vector4 };      // A9: half width, half height, corner radius [mm], dome pillow scale [mm²]
  uShapeT: { value: THREE.Vector4 };      // A9: box torsion A, B [mm], 1/u_max, A along y
  uFilmGrow: { value: number };           // A9: the die's margin around the sticker [mm] (the shoulder the film leaves bare)
  uPaperMap: { value: THREE.Vector4 };    // tile uv per mm, slope per moment unit, height mm per unit, albedo scale
  uPaperRgb: { value: THREE.Color };      // linear albedo
  uPaperBrdf: { value: THREE.Vector4 };   // Oren–Nayar σ [rad], sheen amount, sheen α, translucency
  uPaperPat: { value: THREE.Vector4 };    // stock index, formation contrast, texture strength, seed
  uPaperBump: { value: number };          // 1: the scene's bump map also on the paper
  uPaperCard: { value: number };          // 1: back and edge render as paper (Foil Emboss shown)
  uEmbExposure: { value: number };        // exposure compensation of the paper card (linear multiplier)
}

let shared: EmbossShared | null = null;

/** The emboss uniform singletons (created on first use). */
export function embossShared(): EmbossShared {
  if (shared) return shared;
  shared = {
    uLogoTex: { value: logoPlaceholder() }, uLogoOn: { value: 0 }, uLogoMap: { value: new THREE.Vector4(1.28, 1.28, 1 / 800, 1) },
    uLogoXf: { value: new THREE.Vector4(0, 0, 1, 0) }, uLogoW: { value: 36 },
    uRelief: { value: new THREE.Vector4(0.45, 0.6, 0, 0.6) }, uRelProfile: { value: 0 },
    uLogoShape: { value: 0 }, uFilmGrow: { value: 0.6 }, uShapeK: { value: new THREE.Vector4(15, 15, 2.5, 0.84) }, uShapeT: { value: new THREE.Vector4(15, 15, 1 / 66.3, 0) },
    uPaperMom: { value: paperPlaceholder() }, uPaperAux: { value: paperPlaceholder() }, uPaperOn: { value: 0 },
    uPaperMap: { value: new THREE.Vector4(1 / 10.24, 0, 0, 1) }, uPaperRgb: { value: new THREE.Color(0.88, 0.86, 0.8) },
    uPaperBrdf: { value: new THREE.Vector4(0.5, 0.35, 0.5, 0.35) }, uPaperPat: { value: new THREE.Vector4(0, 0.45, 1, 7) },
    uPaperBump: { value: 0 }, uPaperCard: { value: 0 }, uEmbExposure: { value: Math.pow(2, 0.6) },
    uPrintTex: { value: printPlaceholder() }, uPrintK: { value: new THREE.Vector4(0, 1, 0, 0) },
  };
  return shared;
}

/** The asset inputs of the panel values: the logo URL and the paper generator's key. */
export function embossAssetInputs(v: ParamValues): { logo: string; print: string; stock: number; fibreAmount: number; fibreScale: number; seed: number } {
  const num = (id: string, d: number) => { const x = v[id]; return typeof x === "number" && Number.isFinite(x) ? x : d; };
  const stock = PAPER_STOCKS.indexOf(v["emboss.stock"] as (typeof PAPER_STOCKS)[number]);
  return {
    logo: typeof v["emboss.logo"] === "string" ? (v["emboss.logo"] as string) : LOGO_DEFAULT,
    print: typeof v["emboss.print"] === "string" ? (v["emboss.print"] as string) : "",
    stock: stock < 0 ? 0 : stock,
    fibreAmount: Math.min(Math.max(num("emboss.fibreAmount", 0.55), 0), 1),
    fibreScale: Math.min(Math.max(num("emboss.fibreScale", 1), 0.5), 2),
    seed: Math.max(Math.round(num("emboss.seed", 7)), 0),
  };
}

/** Owns the logo and paper textures of the shared emboss uniforms. */
export class EmbossAssets {
  readonly u: EmbossShared;
  readonly logo: LogoMaps;
  readonly paper: PaperMaps;
  /** The image card's picture (`emboss.print`). */
  readonly print: PrintImage;
  /** A11: the logo slots of the multi-element program (uLogoTex0…; each its own distance field), created on first use. */
  private readonly slots: { maps: LogoMaps; u: LogoUniforms; url: string }[] = [];
  private readonly renderer: THREE.WebGLRenderer;
  /** Called when a slot's logo was installed or cleared (the app re-applies the elements' uniforms). */
  onSlotChange: (() => void) | null = null;
  private requested = false;

  /** Registers the emboss uniforms into `sharedMap` (call before any material is built). */
  constructor(renderer: THREE.WebGLRenderer, sharedMap: Uniforms) {
    this.u = embossShared();
    this.renderer = renderer;
    const M = multiUniforms();
    for (let k = 0; k < MAX_LOGOS; k++) M[`uLogoTex${k}`].value = logoPlaceholder();
    Object.assign(sharedMap, this.u, M);                       // A11: the card back reads the multi arrays too
    this.logo = new LogoMaps(renderer, this.u);
    this.paper = new PaperMaps(renderer, this.u);
    this.print = new PrintImage(renderer, this.u);
  }

  /** Loads what the values need (no-op when unchanged). `immediate`: no debounce (start-up, frozen views). */
  update(v: ParamValues, immediate: boolean): void {
    const a = embossAssetInputs(v);
    this.requested = true;
    this.logo.setLogo(a.logo);
    this.print.set(a.print);
    this.paper.update({ stock: a.stock, fibreAmount: a.fibreAmount, fibreScale: a.fibreScale, seed: a.seed }, immediate);
  }

  /** A11: the logo artworks of a multi-element card, one slot each (at most MAX_LOGOS; an artwork keeps its slot while
   *  it stays in use, so editing one element never rebuilds another's distance field). Unused slots are cleared. */
  setSlotLogos(urls: readonly string[]): void {
    const want = urls.slice(0, MAX_LOGOS);
    for (const s of this.slots) if (s.url && !want.includes(s.url)) { s.url = ""; s.maps.setLogo(""); }
    for (const url of want) {
      if (this.slots.some((s) => s.url === url)) continue;
      let k = this.slots.findIndex((s) => s.url === "");
      if (k < 0) {
        k = this.slots.length;
        const M = multiUniforms();
        const u: LogoUniforms = { uLogoTex: M[`uLogoTex${k}`] as LogoUniforms["uLogoTex"], uLogoOn: { value: 0 }, uLogoMap: { value: new THREE.Vector4(1.28, 1.28, 1 / 800, 1) } };
        const maps = new LogoMaps(this.renderer, u);
        maps.onChange = () => this.onSlotChange?.();
        this.slots.push({ maps, u, url: "" });
      }
      this.slots[k].url = url;
      this.slots[k].maps.setLogo(url);
    }
  }
  /** A11: the slot holding an artwork (its index, whether it is loaded, its uLogoMap), or null. */
  slotOf(url: string): { slot: number; on: number; map: THREE.Vector4; aspect: number } | null {
    const k = this.slots.findIndex((s) => s.url !== "" && s.url === url);
    if (k < 0) return null;
    const s = this.slots[k];
    return { slot: k, on: s.u.uLogoOn.value, map: s.u.uLogoMap.value, aspect: s.maps.aspect };
  }

  /** Back and edge render as paper while Foil Emboss is shown. */
  setActive(on: boolean): void { this.u.uPaperCard.value = on ? 1 : 0; }

  /** Nothing requested, or the requested logo and paper maps are installed (or failed). */
  get ready(): boolean { return !this.requested || (this.logo.ready && this.paper.ready && this.print.ready && this.slots.every((s) => s.maps.ready)); }
  get gpuBytes(): number { return this.logo.gpuBytes + this.paper.gpuBytes + this.print.gpuBytes + this.slots.reduce((b, s) => b + s.maps.gpuBytes, 0); }
  get logoInfo(): LogoInfo | null { return this.logo.info; }
}
