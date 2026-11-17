// Material- and SPD-convolved spectral tables on the GPU (spec §4.2.3–4.2.5): two DataArrayTextures (RGBA HalfFloat,
// LinearFilter, no mips, clamp; 512 λ texels × 41 σ rows × 5 SPD layers, 0.84 MB each), the 4-node spectral projection
// per SPD (mat4) and the environment bins for K = 6 and 8. Only built layers exist: layer 0 (`equal`) at construction,
// the others when a light first selects their SPD (`ensureLayer`). A material or tint change rebuilds every built layer,
// the projection and the bins (`setMaterial`; the caller debounces slider drags to ≤ 10 Hz).
//
// (Addendum A5 removed Oil Slick and with it A2.3.3's thin-film Fourier table `film` and its ≈ 30 ms start-up build.)
import * as THREE from "three";
import type { GratingSummary, SpdId, TintInputs } from "../types.ts";
import { SPD_IDS } from "../types.ts";
import { buildBins, buildCmfLayer, buildSpecProj, CMF_TABLE } from "../spectral/tables.ts";
import { materialFactor, spdRgb } from "../spectral/spd.ts";
import { toHalfArray } from "../spectral/half.ts";

export interface SpectralBins { lambda: number[]; W: THREE.Matrix3[]; width: number }

const CLEAR_TINT: TintInputs = { type: "clear", edgeNm: 550, widthNm: 50, floor: 1 };

function makeArrayTexture(data: Uint16Array, name: string, dims: { width: number; rows: number; layers: number } = CMF_TABLE): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, dims.width, dims.rows, dims.layers);
  t.name = name;
  t.format = THREE.RGBAFormat;
  t.type = THREE.HalfFloatType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

function sameTint(a: TintInputs | null, b: TintInputs): boolean {
  if (!a || a.type !== b.type) return false;
  return a.type === "clear" || (a.edgeNm === b.edgeNm && a.widthNm === b.widthNm && a.floor === b.floor);
}
/** The tables' identity: what sameTint compares. */
const tintKey = (t: TintInputs): string => (t.type === "clear" ? "clear" : `${t.type}|${t.edgeNm}|${t.widthNm}|${t.floor}`);

/** R11: a tint's built tables (the half-float layers, the projections, the bins), kept so switching back to a material
 *  copies them instead of computing them again (the same numbers: they depend on the tint and the SPD only). */
interface TintTables {
  layers: Map<number, { conv: Uint16Array; cum: Uint16Array }>;
  specProj: Float32Array[];
  bins: Record<6 | 8, { lambda: Float32Array; width: number; W: Float32Array }>;
}
/** Tints kept (each ≤ 1.7 MB with every SPD layer built: four cover the six foils and the paper). */
const KEPT_TINTS = 4;

export class SpectralTextures {
  readonly conv: THREE.DataArrayTexture;
  readonly cum: THREE.DataArrayTexture;
  readonly specProj: THREE.Matrix4[];
  readonly bins: Record<6 | 8, SpectralBins>;
  readonly spdRgb: THREE.Vector3[];
  /** Incremented on every rebuild of the material tables (uniforms refresh their copies of the bins). */
  version = 0;
  /** Wall time of the last build [ms] (layers, projection and bins). */
  lastBuildMs = 0;
  private readonly built = new Set<number>();
  private tint: TintInputs | null = null;
  private tables: TintTables | null = null;                // R11: the current tint's (also in `kept`)
  private readonly kept = new Map<string, TintTables>();
  private rho: (lambdaNm: number) => number;
  private readonly layerLen: number;

  constructor(s?: GratingSummary) {
    this.layerLen = CMF_TABLE.width * CMF_TABLE.rows * 4;
    const n = this.layerLen * CMF_TABLE.layers;
    this.conv = makeArrayTexture(new Uint16Array(n), "uCmfConv");
    this.cum = makeArrayTexture(new Uint16Array(n), "uCmfCum");
    this.specProj = SPD_IDS.map(() => new THREE.Matrix4());
    this.bins = {
      6: { lambda: new Array<number>(6).fill(0), W: Array.from({ length: 6 }, () => new THREE.Matrix3()), width: 50 },
      8: { lambda: new Array<number>(8).fill(0), W: Array.from({ length: 8 }, () => new THREE.Matrix3()), width: 37.5 },
    };
    this.spdRgb = SPD_IDS.map((id) => { const c = spdRgb(id); return new THREE.Vector3(c[0], c[1], c[2]); });
    this.rho = materialFactor(CLEAR_TINT);
    this.built.add(0);
    this.setMaterial(s ?? { pitchesNm: [1000], depthNm: 50, nc: 1.5, gAzimuthRad: null, recycle: true, tint: CLEAR_TINT });
  }

  /** Active material changed (or its tint values): rebuild the built layers, the projection and the bins.
   *  A summary whose tint equals the current one is a no-op (ρ_M depends on the tint only). */
  setMaterial(s: GratingSummary): void {
    if (sameTint(this.tint, s.tint)) return;
    const t0 = performance.now();
    this.tint = { ...s.tint };
    this.rho = materialFactor(this.tint);
    const key = tintKey(this.tint);
    let tables = this.kept.get(key);
    if (tables) this.kept.delete(key);                    // (re-inserted below: the most recent)
    else {
      tables = {
        layers: new Map(), specProj: SPD_IDS.map((id) => buildSpecProj(id, this.rho)),
        bins: { 6: buildBins(6, this.rho), 8: buildBins(8, this.rho) },
      };
    }
    this.kept.set(key, tables);
    while (this.kept.size > KEPT_TINTS) this.kept.delete(this.kept.keys().next().value as string);
    this.tables = tables;
    for (const layer of this.built) this.buildLayer(layer);
    SPD_IDS.forEach((_, k) => this.specProj[k].fromArray(tables.specProj[k]));
    for (const K of [6, 8] as const) {
      const b = tables.bins[K], dst = this.bins[K];
      for (let j = 0; j < K; j++) { dst.lambda[j] = b.lambda[j]; dst.W[j].fromArray(b.W, 9 * j); }
      dst.width = b.width;
    }
    this.version++;
    this.lastBuildMs = performance.now() - t0;
  }

  /** Builds the table layer of an SPD if a light selects it for the first time. */
  ensureLayer(id: SpdId): void {
    const layer = SPD_IDS.indexOf(id);
    if (layer < 0) return;
    if (this.built.has(layer)) return;
    const t0 = performance.now();
    this.built.add(layer);
    this.buildLayer(layer);
    this.version++;
    this.lastBuildMs = performance.now() - t0;
  }

  isBuilt(id: SpdId): boolean { return this.built.has(SPD_IDS.indexOf(id)); }

  /** Writes an SPD layer of the current tint into the textures (R11: computed once per tint and kept). */
  private buildLayer(layer: number): void {
    let h = this.tables?.layers.get(layer);
    if (!h) {
      const { conv, cum } = buildCmfLayer(SPD_IDS[layer], this.rho);
      h = { conv: toHalfArray(conv), cum: toHalfArray(cum) };
      this.tables?.layers.set(layer, h);
    }
    const off = layer * this.layerLen;
    (this.conv.image.data as Uint16Array).set(h.conv, off);
    (this.cum.image.data as Uint16Array).set(h.cum, off);
    this.conv.addLayerUpdate(layer);
    this.cum.addLayerUpdate(layer);
    this.conv.needsUpdate = true;
    this.cum.needsUpdate = true;
  }

  dispose(): void {
    this.conv.dispose();
    this.cum.dispose();
  }
}
