// Paper: the Foil Emboss material's assets (the paper card with foil logos and hologram stickers).
//
// On holo.spot the paper card is one thing on the page, and the engine keeps its uniforms as module singletons (one
// logo distance field, one set of paper maps, one hologram atlas). The kit follows that: every Foil Emboss object of a
// page shares one design. Different foils and several holographic cards are fine; two different paper designs at once
// are not (the second apply's design wins).
import * as THREE from "three";
import type { ParamValue, ParamValues, Uniforms } from "../engine/types.ts";
import { EmbossAssets } from "../engine/scene/embossAssets.ts";
import { multiEnv, multiUniforms } from "../engine/materials/embossMulti.ts";
import { multiAssets } from "../engine/materials/emboss.ts";
import { MAX_SUBJECTS, primaryValues } from "../engine/app/paperDoc.ts";
import { LOGO_DEFAULT, embossElementOf } from "../engine/materials/emboss.params.ts";
import { VOLUME_SUBJECTS } from "../engine/materials/volume.params.ts";
import { bindVolumeGrid } from "../engine/materials/volume.ts";
import type { VolumeGrid } from "../engine/materials/volume.ts";
import { buildVolumeAtlas } from "../engine/scene/volumes.ts";
import type { VolumeAtlas } from "../engine/scene/volumes.ts";
import { setPlacementFace } from "../engine/ui/logoEditorMath.ts";

export interface PaperHost {
  /** The loaded volume of a hologram subject, or null while it loads (asking starts the load). */
  grid(subject: string): VolumeGrid | null;
  /** True once the subject has loaded or failed. */
  gridSettled(subject: string): boolean;
}

/** Where a value's artwork lives: holo.spot's site paths become the kit's asset files; artwork a Copy settings blob
 *  carried ("asset:<name>") becomes a data URL; the site's own shipped artwork (not in the kit) becomes the default logo. */
export function resolveArtwork(v: Record<string, ParamValue>, assetBase: string, blobAssets: Readonly<Record<string, string>>): Record<string, ParamValue> {
  const out = { ...v };
  const dataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const one = (s: string): string => {
    if (s.startsWith("asset:")) { const svg = blobAssets[s.slice(6)]; return svg ? dataUrl(svg) : assetBase + LOGO_DEFAULT.replace(/^\//, ""); }
    if (s.startsWith("/logos/")) return assetBase + s.slice(1);
    if (s.startsWith("/defaults/") || s === "upload") return assetBase + LOGO_DEFAULT.replace(/^\//, "");
    return s;
  };
  if (typeof out["emboss.logo"] === "string") out["emboss.logo"] = one(out["emboss.logo"]);
  if (typeof out["emboss.print"] === "string" && (out["emboss.print"] === "upload" || out["emboss.print"].startsWith("/demo/"))) out["emboss.print"] = "";
  const doc = out["emboss.doc"];
  if (typeof doc === "string" && doc.trim() !== "") {
    try {
      const d = JSON.parse(doc) as { e?: { p?: Record<string, unknown> }[] };
      if (!d || typeof d !== "object" || !Array.isArray(d.e)) throw new Error("not a document");
      // an element that names no logo gets the default one from the kit's assets (the engine's default is a site path)
      for (const el of d.e ?? []) {
        el.p ??= {};
        el.p.logo = one(typeof el.p.logo === "string" ? el.p.logo : LOGO_DEFAULT);
      }
      out["emboss.doc"] = JSON.stringify(d);
    } catch { /* not a document: the engine falls back to the single element */ }
  }
  return out;
}

export class Paper {
  readonly assets: EmbossAssets;
  private readonly host: PaperHost;
  private atlas: VolumeAtlas | null = null;
  private atlasKey = "";
  private multiKey = "";
  private multiSeen: object | null = null;
  private stickerBound: VolumeGrid | null | undefined = undefined;
  /** Set when a logo slot finished loading: the owner re-applies the material's values. */
  dirty = false;

  constructor(renderer: THREE.WebGLRenderer, firstMap: Uniforms, host: PaperHost) {
    this.host = host;
    this.assets = new EmbossAssets(renderer, firstMap);
    this.assets.onSlotChange = () => { this.dirty = true; };
    multiEnv.logo = (url) => this.assets.slotOf(url);
    multiEnv.volume = (subject) => {
      const g = (VOLUME_SUBJECTS as readonly string[]).includes(subject) ? this.host.grid(subject) : null;
      const slab = g && this.atlas ? this.atlas.slabs.get(g) : undefined;
      return g && slab ? { grid: g, scale: slab.scale, offset: slab.offset } : null;
    };
  }

  /** The paper card's uniforms into an object's shared map (the card back and edge read them); `paper`: this object's
   *  back and edge are paper. */
  register(map: Uniforms, matU: Uniforms, paper: boolean): void {
    Object.assign(map, this.assets.u, multiUniforms());
    const own = { value: paper ? 1 : 0 };
    map.uPaperCard = own;
    if ("uPaperCard" in matU) matU.uPaperCard = own;
  }

  private subjects(values: ParamValues): string[] {
    return multiAssets(values).subjects.slice(0, MAX_SUBJECTS);
  }
  private stickerSubject(values: ParamValues): string | null {
    if (this.subjects(values).length) return null;                 // a multi-element card uses the atlas
    const v = primaryValues(values);
    return embossElementOf(v) === "hologram" ? String(v["emboss.holo.subject"]) : null;
  }

  /** Once per frame for the shown paper object (holo.spot's syncEmboss, syncMulti and the sticker part of syncVolume):
   *  loads what its values need and binds it. `apply` re-applies the material's values to its uniforms. */
  sync(values: ParamValues, matU: Uniforms, faceMm: { x: number; y: number }, apply: () => void): void {
    setPlacementFace(faceMm);
    this.assets.update(primaryValues(values), true);
    this.assets.u.uPrintK.value.x = this.assets.print.loaded ? 1 : 0;
    if (this.dirty) { this.dirty = false; apply(); }
    // several elements: their logo slots, and their subjects' volumes in one atlas
    const a = multiAssets(values);
    const key = a === this.multiSeen ? this.multiKey : JSON.stringify(a);
    this.multiSeen = a;
    const subjects = this.subjects(values);
    if (key !== this.multiKey) {
      this.multiKey = key;
      this.assets.setSlotLogos(a.logos);
      if (!subjects.length && this.atlas) this.stickerBound = undefined;
      apply();
    }
    if (subjects.length) {
      const loaded = subjects.map((s) => this.host.grid(s)).filter((g): g is VolumeGrid => g !== null);
      const ak = subjects.filter((s) => this.host.grid(s)).join(",");
      if (ak !== this.atlasKey || !this.atlas) {
        this.atlasKey = ak;
        const old = this.atlas;
        this.atlas = buildVolumeAtlas(loaded);
        old?.texture.dispose();
        this.stickerBound = undefined;
      }
      if (matU.uVolSdf.value !== this.atlas.texture) { matU.uVolSdf.value = this.atlas.texture; apply(); }
      return;
    }
    // one hologram sticker: its own volume
    const st = this.stickerSubject(values);
    if (st !== null) {
      const g = this.host.grid(st);
      if (this.stickerBound !== g) { bindVolumeGrid(matU, g); apply(); this.stickerBound = g; }
    }
  }

  /** Everything the values need is loaded (or failed) and bound. */
  settled(values: ParamValues): boolean {
    if (!this.assets.ready) return false;
    const subjects = this.subjects(values);
    if (subjects.length) return subjects.every((s) => this.host.gridSettled(s)) && this.atlasKey === subjects.filter((s) => this.host.grid(s)).join(",");
    const st = this.stickerSubject(values);
    return st === null || (this.host.gridSettled(st) && this.stickerBound === this.host.grid(st));
  }

  dispose(): void {
    this.atlas?.texture.dispose();
    multiEnv.logo = () => null;
    multiEnv.volume = () => null;
  }
}
