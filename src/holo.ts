// Holo: the holographic materials of holo.spot on objects in your own three.js scene.
//
// How the look is kept identical to the site. holo.spot's picture is made by four things together: the material's
// shader, lights that have a real spectrum, the object's real size, and the finishing of the frame (an HDR target,
// glare, tone curve, grain). A three.js scene supplies none of the last three in a form the shaders can use, so the
// kit brings all four and runs the site's own code for each:
//
//   • Every object you apply a material to gets its own small studio, in metres, centred on the object: the same light
//     rig as holo.spot, the same spectral tables, the same per-frame grating normalisation. The object is drawn there
//     with a copy of your camera moved into that space, so it lands on exactly the pixels your scene puts it on.
//   • The frame is finished by the site's pipeline (engine/render/pipeline.ts). When the scene holds only holographic
//     objects, that pipeline draws the whole frame ("replace"). When it holds other things too, your renderer draws
//     them as usual and the holographic layer is composited over them, hidden where your objects are in front ("over").
//
// The shaders assume world units are metres (a hologram's depth is in millimetres), which is why the kit does not
// draw the materials straight into your scene's units.
import * as THREE from "three";
import type {
  Background, GratingSummary, LightSet, Mat3, MaterialDef, MaterialId, ParamValue, ParamValues, Quat, Tier, TierConfig, Uniforms, Vec3,
} from "../engine/types.ts";
import { SPD_IDS } from "../engine/types.ts";
import { MATERIALS, materialOf } from "../engine/materials/registry.ts";
import { buildHoloMaterial } from "../engine/materials/build.ts";
import { bindVolumeGrid } from "../engine/materials/volume.ts";
import type { VolumeGrid } from "../engine/materials/volume.ts";
import { volumeSubjectOf } from "../engine/materials/volume.params.ts";
import { Pipeline } from "../engine/render/pipeline.ts";
import type { DofFrame, OutputOptions } from "../engine/render/pipeline.ts";
import { TIERS, detectTier } from "../engine/render/tier.ts";
import { SpectralTextures } from "../engine/scene/spectralTextures.ts";
import { PRINT_MODE_INDEX, applyWaves, createSharedUniforms, updateFrameUniforms } from "../engine/scene/uniforms.ts";
import { buildBackMaterial } from "../engine/scene/backMaterial.ts";
import { buildEdgeMaterial } from "../engine/scene/edgeMaterial.ts";
import { buildCardGeometry } from "../engine/scene/cardGeometry.ts";
import { renderPrintText } from "../engine/scene/printText.ts";
import { paperThicknessMm } from "../engine/materials/emboss.ts";
import { computeLights, emptyLightSet } from "../engine/scene/lights.ts";
import { StudioEnv, setEnvRotation } from "../engine/scene/studioEnv.ts";
import { buildWaves } from "../engine/scene/relief.ts";
import { BumpMaps, BUMP_MAPS, mapName } from "../engine/scene/bumpMaps.ts";
import { loadVolumeGrid } from "../engine/scene/volumes.ts";
import { etaFrame } from "../engine/physics/grating.ts";
import { envLevels } from "../engine/physics/geometry.ts";
import { FocusPull, focalLengthMm, focusDistanceM } from "../engine/physics/lens.ts";
import { parseCssColor } from "../engine/ui/color.ts";
import { LUMA_SRGB, gamutMapLuma } from "../engine/spectral/cmf.ts";
import { renderErrors, reportRenderError } from "../engine/render/renderer.ts";
import { meshesOf, prepareGeometry } from "./geometry.ts";
import type { Prepared } from "./geometry.ts";
import { Composer } from "./compose.ts";
import { Paper, resolveArtwork } from "./paper.ts";
import {
  STUDIO_PRESETS, backgroundLinear, backgroundTone, exposureMultiplier, hexColour, isCopyBlob, lookInfo, materialPresetWrites, resolveSettings, sceneStateFrom,
} from "./settings.ts";
import { isLegacyElementKey } from "../engine/app/paperDoc.ts";
import type { LookId, Pose, SceneState, SettingsInput, View } from "./settings.ts";

export type Quality = "auto" | "low" | "medium" | "high";
export type Compose = "auto" | "replace" | "over";

export interface HoloOptions {
  /** Rendering quality (holo.spot's Quality control). Default: what the site ships for the first look you apply. */
  quality?: Quality;
  /** Where the kit's asset files live (bump maps, hologram volumes). Default: the `assets/` folder next to `dist/`. */
  assets?: string;
  /** Scene-level settings (lights, exposure, grain, background …): a flat map of ids, or a Copy settings blob. */
  settings?: SettingsInput;
  /** How the frame is put together. `auto`: `replace` when the scene holds only holographic objects, else `over`. */
  compose?: Compose;
  /** What the light rig is fixed to. `camera` (default): the lights travel with your camera, so the object is lit as
   *  on holo.spot from wherever you look. `world`: the rig stands still in your scene, its front toward +z. */
  lights?: "camera" | "world";
  /** The page behind the object: `"black"`, `"white"` or a `#rrggbb` colour. It sets the colour the kit paints in
   *  `replace` mode and how the lighting adapts to its lightness. Default: the look's (white on holo.spot). */
  background?: string;
}

export interface ApplyOptions {
  /** One of prism, shatter, nebula, sparkle, vortex, volume, emboss. Default: the look's own material. */
  material?: MaterialId;
  /** Real-world size of the object's largest side, in millimetres (default 90). The foil's structure has a real size,
   *  so this decides how fine the pattern looks on the object. */
  sizeMm?: number;
  /** Material settings (and scene settings, which go to the whole Holo): a Copy settings blob from holo.spot, or a
   *  flat map such as `{ "nebula.size": 200 }`. */
  settings?: SettingsInput;
  /** Which of holo.spot's shipped looks to start from (default `object`, the site's 3D object). */
  look?: LookId;
  /** Surface mapping: `auto` uses the mesh's UVs when they are usable, else a box projection. */
  mapping?: "auto" | "uv" | "box" | "sphere";
  /** Draw both faces. Default: open surfaces (sheets) yes, closed ones no. */
  doubleSided?: boolean | null;
  /** Density of the structure on the object (default 1; above 1: smaller shards, flakes and bump tiles; below 1:
   *  larger). holo.spot's `structure scale`. */
  structureScale?: number;
  /** Whether this apply() also sets the scene-level settings of the look (lights, exposure, background …). Default:
   *  true for the first object, false for later ones. */
  scene?: boolean;
}

export interface CardOptions {
  /** Default: Prism Rainbow; `emboss` gives the paper card with foil logos and hologram stickers. */
  material?: MaterialId;
  /** The card's face in millimetres (default 63 × 88, a trading card). */
  widthMm?: number;
  heightMm?: number;
  /** The length of the card's longer side in your scene's units (default: its real size in metres). */
  size?: number;
  /** As ApplyOptions.settings. */
  settings?: SettingsInput;
  /** Default: `card` (holo.spot's holographic card), or `image` (its paper card) for `emboss`. */
  look?: LookId;
  /** As ApplyOptions.scene. */
  scene?: boolean;
}

export interface RenderOptions {
  /** Frame time in seconds, for offline rendering (seeds the animated grain). Default: the clock. */
  time?: number;
  /** Time since the last frame in seconds, for offline rendering. */
  dt?: number;
  /** true: no motion blur kernel between this frame and the last (a still picture). */
  still?: boolean;
}

const IDENTITY_Q: Quat = { x: 0, y: 0, z: 0, w: 1 };
/** uCornerMm for surfaces whose boundary is not a card outline: far outside every domain (holo.spot's value). */
const NO_OUTLINE_CORNER_MM = 1000;
/** The surface span a bump map tiles over on a model [mm] (holo.spot's MODEL_BUMP_DOMAIN_MM). */
const BUMP_DOMAIN_MM = 100;
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

function inkRgb(css: string): Vec3 | null {
  const c = parseCssColor(css);
  if (!c) return null;
  const m = gamutMapLuma(c.rgb, LUMA_SRGB);
  return [clamp01(m[0]), clamp01(m[1]), clamp01(m[2])];
}

function mat3RowMajor(m: THREE.Matrix4): Mat3 {
  const e = m.elements;
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

/** One object carrying a holographic material: its studio (uniforms, tables, lights) and its metre-space stand-in. */
export class HoloObject {
  readonly source: THREE.Object3D;
  readonly material: MaterialId;
  readonly look: LookId;
  /** How holo.spot frames and tilts this look: use them to reproduce the site's shot (see docs/api.md). */
  readonly view: View;
  readonly pose: Pose;
  /** @internal */ readonly def: MaterialDef;
  /** @internal */ values: Record<string, ParamValue>;
  /** @internal */ readonly shared: Uniforms;
  /** @internal */ readonly matU: Uniforms;
  /** @internal */ readonly tex: SpectralTextures;
  /** @internal */ readonly bumps: BumpMaps;
  /** @internal */ summary: GratingSummary;
  /** @internal */ prepared: Prepared | null = null;
  /** @internal */ readonly scene = new THREE.Scene();
  /** @internal */ mesh: THREE.Mesh | null = null;
  /** @internal */ holoMaterial: THREE.ShaderMaterial | null = null;
  /** @internal */ variant = "";
  /** @internal */ readonly lights: LightSet = emptyLightSet();
  /** @internal */ readonly prevLightPos = new Float32Array(12);
  /** @internal */ readonly model = new THREE.Matrix4();
  /** @internal */ readonly prevModel = new THREE.Matrix4();
  /** @internal */ started = false;
  /** @internal */ camera: THREE.Camera | null = null;
  /** @internal */ unitsPerMetre = 1;
  /** @internal */ readonly centerWorld = new THREE.Vector3();
  /** @internal */ sizeMm: number;
  /** @internal */ structureScale: number;
  /** @internal */ sources: THREE.Mesh[] = [];
  /** @internal */ volumeUrl: string | null = null;
  /** @internal */ volumeGrid: VolumeGrid | null = null;
  /** @internal */ card: { widthMm: number; heightMm: number } | null = null;
  /** @internal */ backMaterial: THREE.ShaderMaterial | null = null;
  /** @internal */ edgeMaterial: THREE.ShaderMaterial | null = null;
  /** @internal */ blobAssets: Readonly<Record<string, string>> = {};
  /** @internal */ pending: Promise<void> = Promise.resolve();
  /** @internal */ failed: Error | null = null;
  /** Resolves when the object is ready to draw (geometry built, program compiled, maps loaded). */
  ready: Promise<void> = Promise.resolve();
  private readonly holo: Holo;

  /** @internal */
  constructor(holo: Holo, source: THREE.Object3D, o: { material: MaterialId; look: LookId; values: Record<string, ParamValue>; view: View; pose: Pose; sizeMm: number; structureScale: number }) {
    this.holo = holo;
    this.source = source;
    this.material = o.material;
    this.look = o.look;
    this.view = o.view;
    this.pose = o.pose;
    this.def = materialOf(o.material);
    this.values = o.values;
    this.sizeMm = o.sizeMm;
    this.structureScale = o.structureScale;
    this.summary = this.def.gratingSummary(this.values);
    this.tex = new SpectralTextures(this.summary);
    this.shared = createSharedUniforms(this.tex);
    this.matU = this.def.createUniforms();
    this.def.apply(this.values, this.matU);
    this.bumps = new BumpMaps(holo.renderer, this.shared);
    this.scene.matrixWorldAutoUpdate = true;
  }

  /** Changes material settings: `{ "prism.pitch": 1200 }`. Ids of other materials and unknown ids are ignored. */
  set(values: Readonly<Record<string, ParamValue>>): void {
    // a preset select among them (the paper stock) writes its values first, then the ids given win
    const next = { ...this.values, ...materialPresetWrites(this.material, values) };
    let changed = false;
    for (const [id, v] of Object.entries(values)) if (id in next && v !== undefined) { next[id] = v; changed = true; }
    if (!changed) return;
    if (this.material === "emboss" && !("emboss.doc" in values) && Object.keys(values).some(isLegacyElementKey)) next["emboss.doc"] = "";
    this.values = this.material === "emboss" ? this.holo._artwork(next, this.blobAssets) : next;
    this.holo._valuesChanged(this);
  }

  /** The current value of every parameter of this object's material. */
  get settings(): Readonly<Record<string, ParamValue>> { return this.values; }

  /** Stops drawing this object holographically and shows the original again. */
  remove(): void { this.holo.remove(this.source); }

  /** @internal The lens of the current scene settings [mm] (`dof.lens`): it sets holo.spot's field of view. */
  _lensMm(): number { const v = this.holo.scene["dof.lens"]; return typeof v === "number" && v > 0 ? v : 62; }
}

interface SavedState {
  autoClear: boolean; toneMapping: THREE.ToneMapping; outputColorSpace: string; target: THREE.WebGLRenderTarget | null;
  clearColor: THREE.Color; clearAlpha: number;
}

export class Holo {
  readonly renderer: THREE.WebGLRenderer;
  /** The seven materials: id → name, one-line description and caption. */
  static readonly materials: Readonly<Record<MaterialId, { name: string; analog: string; caption: string }>> =
    Object.fromEntries(Object.values(MATERIALS).map((d) => [d.id, { name: d.name, analog: d.analog, caption: d.caption }])) as Record<MaterialId, { name: string; analog: string; caption: string }>;

  private readonly objects = new Map<THREE.Object3D, HoloObject>();
  private readonly assets: string;
  private readonly composeMode: Compose;
  private readonly anchor: "camera" | "world";
  private qualityOpt: Quality | undefined;
  private tier: TierConfig | null = null;
  private pipeline: Pipeline | null = null;
  private env: StudioEnv | null = null;
  private composer: Composer | null = null;
  private sceneValues: Record<string, ParamValue>;
  private state: SceneState;
  /** Scene ids the caller set through the constructor or setScene: they stay when a look's scene is adopted. */
  private readonly explicit: Record<string, ParamValue> = {};
  private backgroundOpt: string | undefined;
  private readonly marker = new THREE.Object3D();
  private readonly compileRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  private readonly compileCam = new THREE.PerspectiveCamera();
  private readonly depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  private readonly volumes = new Map<string, Promise<VolumeGrid>>();
  /** Hologram subjects by name: the grid, or null once a load failed. */
  private readonly grids = new Map<string, VolumeGrid | null>();
  private paper: Paper | null = null;
  private readonly pull = new FocusPull();
  private readonly size = new THREE.Vector2();
  private lastW = 0; private lastH = 0; private lastDpr = 0;
  private lastTime: number | null = null;
  private frameCount = 0;
  private warned = new Set<string>();
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, options: HoloOptions = {}) {
    if (!renderer || !(renderer as unknown as { isWebGLRenderer?: boolean }).isWebGLRenderer) throw new Error("holo: pass a THREE.WebGLRenderer (the materials are WebGL 2 shaders; WebGPURenderer is not supported)");
    if (!renderer.capabilities.isWebGL2) throw new Error("holo: WebGL 2 is required");
    this.renderer = renderer;
    this.assets = (options.assets ?? new URL(/* @vite-ignore */ "../assets/", import.meta.url).href).replace(/\/?$/, "/");
    this.composeMode = options.compose ?? "auto";
    this.anchor = options.lights ?? "camera";
    this.qualityOpt = options.quality;
    this.backgroundOpt = options.background;
    const r = resolveSettings({ settings: options.settings ?? null });
    this.sceneValues = r.scene;
    Object.assign(this.explicit, this.givenScene(options.settings));
    this.state = sceneStateFrom(this.sceneValues);
    this.warnUnknown(r.unknown);
    // shader compile and link errors are collected in `errors` (unless the caller has a hook of their own)
    renderer.debug.onShaderError ??= (gl, program, vs, fs) => {
      const log = (sh: WebGLShader) => (gl.getShaderInfoLog(sh) ?? "").trim();
      reportRenderError(`[shader] ${(gl.getProgramInfoLog(program) ?? "").trim()} ${log(vs)} ${log(fs)}`.trim());
    };
  }

  // ---- the public surface ------------------------------------------------------------------------------------------

  /**
   * Makes an object holographic. `target` is a Mesh or a Group from your scene; every mesh under it becomes one
   * object with one material. The original stays in your scene (its transform is followed every frame) and is hidden
   * while the kit draws. Returns at once; `await obj.ready` (or `holo.ready()`) before a screenshot.
   */
  apply(target: THREE.Object3D, options: ApplyOptions = {}): HoloObject {
    return this.applyTo(target, options, null);
  }

  /**
   * A holographic card: a mesh to add to your scene and move like any other. With `material: "emboss"` it is the paper
   * card, whose settings place foil logos and hologram stickers on it (docs/materials/emboss.md).
   */
  card(options: CardOptions = {}): THREE.Mesh {
    const w = options.widthMm ?? 63, h = options.heightMm ?? 88;
    const k = (options.size ?? Math.max(w, h) * 1e-3) / Math.max(w, h);            // scene units per millimetre
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w * k, h * k, 0.5 * k), new THREE.MeshBasicMaterial({ color: 0xd8d8d8 }));
    mesh.name = "holo-card";
    this.applyTo(mesh, { material: options.material ?? (options.settings ? undefined : "prism"), settings: options.settings, scene: options.scene,
      look: options.look ?? (options.material === "emboss" ? "image" : options.settings && "holoDev" in options.settings ? undefined : "card"), sizeMm: Math.max(w, h) },
      { widthMm: w, heightMm: h });
    return mesh;
  }

  private applyTo(target: THREE.Object3D, options: ApplyOptions, card: { widthMm: number; heightMm: number } | null): HoloObject {
    if (this.disposed) throw new Error("holo: disposed");
    this.remove(target);
    const look = options.look ?? (options.material === "emboss" && !(options.settings && "holoDev" in options.settings) ? "image" : undefined);
    const r = resolveSettings({ material: options.material, look, settings: options.settings ?? null });
    if (r.material === "emboss") r.values = resolveArtwork(r.values, this.assets, r.assets);
    this.warnUnknown(r.unknown);
    if (r.material === "emboss" && this.meansOneElement(options.settings)) r.values["emboss.doc"] = "";
    // the first object brings its look's lights, exposure, grain and background, as opening that entity on holo.spot
    // does; what the caller set on the Holo itself stays, and what this call's settings name wins
    const given = this.givenScene(options.settings);
    if (options.scene ?? this.objects.size === 0) this.sceneValues = { ...r.scene, ...this.explicit, ...given };
    else Object.assign(this.sceneValues, given);
    this.sceneChanged();
    this.ensureEngine(r.look);
    const o = sceneStateFrom(r.scene).object;
    const obj = new HoloObject(this, target, {
      material: r.material, look: r.look, values: r.values, view: r.view, pose: r.pose,
      sizeMm: options.sizeMm ?? o.modelSizeMm, structureScale: options.structureScale ?? o.structureScale,
    });
    obj.card = card;
    obj.blobAssets = r.assets;
    this.objects.set(target, obj);
    obj.sources = meshesOf(target);
    obj.pending = obj.ready = this.build(obj, {
      mapping: options.mapping ?? o.modelMapping,
      doubleSided: options.doubleSided === undefined ? null : options.doubleSided,
    }).catch((e: unknown) => {
      obj.failed = e instanceof Error ? e : new Error(String(e));
      console.error(`holo: could not apply ${r.material}:`, obj.failed);
      throw obj.failed;
    });
    obj.ready.catch(() => {});
    return obj;
  }

  /** Stops drawing `target` holographically. */
  remove(target: THREE.Object3D): void {
    const obj = this.objects.get(target);
    if (!obj) return;
    this.objects.delete(target);
    obj.holoMaterial?.dispose();
    obj.backMaterial?.dispose();
    obj.edgeMaterial?.dispose();
    obj.prepared?.geometry.dispose();
    obj.bumps.dispose();
    obj.tex.dispose();
  }

  /** The HoloObject of `target`, if a material was applied to it. */
  get(target: THREE.Object3D): HoloObject | null { return this.objects.get(target) ?? null; }

  /** Changes scene-level settings (lights, exposure, tone curve, glare, grain, bump map, depth of field, background):
   *  a flat map such as `{ "display.ev": 0.8, "studio.preset": "softbox" }`, or a Copy settings blob. */
  setScene(settings: SettingsInput): void {
    if (!settings) return;
    this.warnUnknown(resolveSettings({ settings, look: "plain", material: isCopyBlob(settings) ? undefined : "prism" }).unknown);
    const given = this.givenScene(settings);
    Object.assign(this.explicit, given);
    Object.assign(this.sceneValues, given);
    this.sceneChanged();
  }

  /** The current value of every scene-level parameter. */
  get scene(): Readonly<Record<string, ParamValue>> { return this.sceneValues; }

  /** Resolves when every applied object is ready to draw. Rejects if one failed. */
  async ready(): Promise<void> {
    for (;;) {
      const all = [...this.objects.values()];
      await Promise.all(all.map((o) => o.ready));
      if (all.every((o) => this.settled(o)) && all.length === this.objects.size) break;
      await new Promise((res) => setTimeout(res, 30));
    }
  }

  /** Shader compile errors and other render errors collected so far (empty when all is well). */
  get errors(): readonly string[] { return renderErrors; }

  /**
   * Draws the frame: call it instead of `renderer.render(scene, camera)`.
   * Objects that are not ready yet are skipped (their originals show meanwhile).
   */
  render(scene: THREE.Scene, camera: THREE.Camera, options: RenderOptions = {}): void {
    if (this.disposed) return;
    const r = this.renderer;
    const live = [...this.objects.values()].filter((o) => o.mesh && o.holoMaterial && !o.failed);
    if (!this.pipeline || !this.tier || !this.env || live.length === 0) { r.render(scene, camera); return; }
    const pipeline = this.pipeline, tier = this.tier;

    // the canvas: the pipeline owns the drawing buffer's resolution (it may lower the pixel ratio to the tier's cap)
    r.getSize(this.size);
    const dpr = r.getPixelRatio();
    if (this.size.x !== this.lastW || this.size.y !== this.lastH) { pipeline.resize(this.size.x, this.size.y); this.lastW = this.size.x; this.lastH = this.size.y; this.lastDpr = 0; }
    if (dpr !== this.lastDpr) { pipeline.setDpr(dpr); this.lastDpr = r.getPixelRatio(); }

    const now = options.time ?? performance.now() / 1000;
    const dt = options.dt ?? (this.lastTime === null ? 0 : Math.max(now - this.lastTime, 0));
    this.lastTime = now;
    const still = options.still === true;

    scene.updateMatrixWorld();
    if (camera.parent === null) camera.updateMatrixWorld();
    const s = this.state, bg = this.backgroundOf(scene), tone = backgroundTone(bg.kind, bg.hex);
    const camQ = new THREE.Quaternion(), camP = new THREE.Vector3(), camS = new THREE.Vector3();
    camera.matrixWorld.decompose(camP, camQ, camS);
    const lightRot: Quat = this.anchor === "camera" ? { x: camQ.x, y: camQ.y, z: camQ.z, w: camQ.w } : IDENTITY_Q;

    const saved = this.save();
    // the studio environment: one for every object (same lights), regenerated when its levels change
    this.env.updateDebounced(envLevels(s.studio.ambient, tone), now * 1000, true);

    let dofRef: { obj: HoloObject; cam: THREE.Camera } | null = null;
    for (const obj of live) {
      if (obj.material === "emboss" && this.paper) this.paper.sync(obj.values, obj.matU, this.faceOf(obj), () => obj.def.apply(obj.values, obj.matU));
      this.placeObject(obj, camera, camP, camQ);
      const cam = obj.camera as THREE.Camera;
      const cp: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
      computeLights(s.studio, { mode: "tilt", pad: { x: 0, y: 0 } }, bg.kind, lightRot, cp, obj.lights);
      for (let i = 0; i < 4; i++) if (obj.lights.type[i] !== 0) obj.tex.ensureLayer(SPD_IDS[obj.lights.spd[i]] ?? "equal");
      if (!obj.started || still) { obj.prevLightPos.set(obj.lights.pos); obj.prevModel.copy(obj.model); }
      const cardRot = mat3RowMajor(obj.model), prevCardRot = mat3RowMajor(obj.prevModel);
      const eta = etaFrame(obj.summary, obj.lights, cardRot, cp, [0, 0, 0]);
      this.env.apply(obj.shared);
      setEnvRotation(obj.shared, s.studio.ambient.rotationDeg, lightRot);
      updateFrameUniforms(obj.shared, {
        timeS: now, dtS: dt, cardRot, prevCardRot,
        modelMatrix: obj.model.elements, prevModelMatrix: obj.prevModel.elements,
        lights: obj.lights, prevLightPos: obj.prevLightPos, eta, viewScale: pipeline.viewScale,
      }, tier);
      dofRef ??= { obj, cam };
    }

    const mode = this.modeFor(scene, live);
    const out: OutputOptions = {
      exposure: exposureMultiplier(s.display.ev, tone), tone: s.display.tone, p3: s.display.wideGamut && mode === "replace",
      background: bg.kind, backgroundRgb: backgroundLinear(bg.kind, bg.hex),
      glare: s.display.glare, glareRadiusPx: s.display.glareRadiusPx, raw: false,
      grain: s.grain.on && s.grain.amount > 0
        ? { amount: s.grain.amount, sizePx: s.grain.sizePx, animated: s.grain.animated, rgb: s.grain.colour === "rgb", onBackground: s.grain.onBackground && mode === "replace" }
        : null,
      timeS: now,
      dof: dofRef ? this.dofFrame(dofRef.obj, dofRef.cam, dt, still, exposureMultiplier(s.display.ev, tone), bg.kind, mode) : null,
    };

    const hidden: THREE.Mesh[] = [];
    const hide = () => { for (const o of live) for (const m of o.sources) if (m.visible) { m.visible = false; hidden.push(m); } };
    const show = () => { for (const m of hidden) m.visible = true; hidden.length = 0; };
    const realRender = r.render.bind(r), realTarget = r.setRenderTarget.bind(r);
    const drawLayer = () => {
      if (mode === "over") {
        // what is in front of a holographic object hides it: your scene's depth first, without colour
        const bgWas = scene.background, ovWas = scene.overrideMaterial;
        scene.background = null; scene.overrideMaterial = this.depthOnly;
        hide();
        realRender(scene, camera);
        show();
        scene.background = bgWas; scene.overrideMaterial = ovWas;
      }
      for (const o of live) realRender(o.scene, o.camera as THREE.Camera);
    };
    try {
      if (mode === "over") {
        // your renderer draws everything else, exactly as it would without the kit
        hide();
        r.render(scene, camera);
        show();
      }
      r.autoClear = false;
      r.toneMapping = THREE.NoToneMapping;
      r.render = ((sc: THREE.Object3D, cam: THREE.Camera) => { if (sc === this.marker) drawLayer(); else realRender(sc, cam); }) as typeof r.render;
      if (mode === "replace") {
        pipeline.render(this.marker, camera, out);
      } else {
        this.composer ??= new Composer();
        const c = this.composer, vp = pipeline.viewport;
        c.resize(vp.width, vp.height);
        // the finished layer twice, over black and over white: their difference is its coverage
        r.setRenderTarget = ((t: THREE.WebGLRenderTarget | null, ...rest: number[]) => realTarget(t ?? c.black, ...rest)) as typeof r.setRenderTarget;
        pipeline.render(this.marker, camera, { ...out, background: "black", backgroundRgb: [0, 0, 0] });
        r.setRenderTarget = ((t: THREE.WebGLRenderTarget | null, ...rest: number[]) => realTarget(t ?? c.white, ...rest)) as typeof r.setRenderTarget;
        pipeline.render(this.marker, camera, { ...out, background: "white", backgroundRgb: [1, 1, 1], reuse: true });
        r.setRenderTarget = realTarget;
        r.setRenderTarget(null);
        c.render(r);
      }
    } finally {
      show();
      r.render = realRender;
      r.setRenderTarget = realTarget;
      // in `replace` mode the canvas is the kit's: the pipeline may have switched it to Display P3, and it stays so
      this.restore(saved, mode === "replace");
    }
    for (const obj of live) { obj.prevLightPos.set(obj.lights.pos); obj.prevModel.copy(obj.model); obj.started = true; }
    this.frameCount++;
  }

  /** Frames drawn by the kit so far. */
  get frames(): number { return this.frameCount; }

  /**
   * For automated checks (tools/shot.mjs, your own Playwright run): puts `{ ready, frames, errors }` on
   * `window.__holo`. `ready` turns true once every applied object has been drawn at least once with its maps loaded;
   * `errors` lists shader errors and failed applies.
   */
  expose(name = "__holo"): void {
    const self = this;
    let settledAt = -1;
    (globalThis as Record<string, unknown>)[name] = {
      get ready(): boolean {
        const all = [...self.objects.values()];
        const ok = all.length > 0 && all.every((o) => (o.mesh !== null && self.settled(o)) || o.failed !== null);
        if (!ok) { settledAt = -1; return false; }
        if (settledAt < 0) settledAt = self.frameCount;
        return self.frameCount > settledAt;
      },
      get frames(): number { return self.frameCount; },
      get errors(): string[] { return [...renderErrors, ...[...self.objects.values()].filter((o) => o.failed).map((o) => `[apply] ${o.material}: ${o.failed?.message}`)]; },
      get info(): unknown { return self.info; },
    };
  }

  /** Read-outs for checks: quality, HDR path, pixel ratio, the compose mode of the last frame. */
  get info(): { quality: Tier | null; hdr: boolean; dpr: number; objects: number; gpuMB: number } {
    return { quality: this.tier?.tier ?? null, hdr: this.pipeline?.hdr ?? false, dpr: this.pipeline?.dpr ?? 0, objects: this.objects.size, gpuMB: this.pipeline?.gpuMB ?? 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    for (const t of [...this.objects.keys()]) this.remove(t);
    this.pipeline?.dispose();
    this.env?.dispose();
    this.composer?.dispose();
    this.paper?.dispose();
    this.compileRT.dispose();
    this.depthOnly.dispose();
    this.disposed = true;
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private warnUnknown(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.warned.has(id)) continue;
      this.warned.add(id);
      console.warn(`holo: "${id}" is not a setting of the scene or of this material (see docs/materials/ and schema/holo.schema.json)`);
    }
  }

  /** The scene-level writes a settings input asks for: the values of a `studio.preset` it names, then the scene ids
   *  it gives. Nothing of a look, so the rest of the current scene stays as it is. */
  private givenScene(settings: SettingsInput): Record<string, ParamValue> {
    const given = isCopyBlob(settings) ? settings.values : (settings as Readonly<Record<string, ParamValue>> | null | undefined) ?? {};
    const out: Record<string, ParamValue> = {};
    const preset = given["studio.preset"];
    if (typeof preset === "string" && STUDIO_PRESETS[preset]) for (const [id, v] of Object.entries(STUDIO_PRESETS[preset])) if (id in this.sceneValues) out[id] = v;
    for (const [id, v] of Object.entries(given)) if (id in this.sceneValues && v !== undefined) out[id] = v;
    return out;
  }

  /** A flat settings map that sets one of the paper card's single-element values (`emboss.x`, `emboss.logo` …) without
   *  an `emboss.doc` means that single element, as on holo.spot: the look's own multi-element document steps aside. */
  private meansOneElement(settings: SettingsInput): boolean {
    if (!settings || isCopyBlob(settings)) return false;
    return !("emboss.doc" in settings) && Object.keys(settings).some(isLegacyElementKey);
  }

  private sceneChanged(): void {
    this.state = sceneStateFrom(this.sceneValues);
    for (const obj of this.objects.values()) this.applySceneUniforms(obj);
  }

  private ensureEngine(look: LookId): void {
    if (this.pipeline) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const q = this.qualityOpt ?? lookInfo(look).quality;
    const tierId: Tier = q === "auto" ? detectTier(gl) : q;
    this.tier = TIERS[tierId];
    const saved = this.save();
    this.pipeline = new Pipeline(this.renderer, this.tier, {});
    this.env = new StudioEnv(this.renderer, this.tier.pmremSize);
    this.restore(saved);
  }

  private async build(obj: HoloObject, o: { mapping: "auto" | "uv" | "box" | "sphere"; doubleSided: boolean | null }): Promise<void> {
    const pipeline = this.pipeline as Pipeline, tier = this.tier as TierConfig;
    const prepared = obj.card ? this.prepareCard(obj) : await prepareGeometry(obj.source, { sizeMm: obj.sizeMm, mapping: o.mapping, doubleSided: o.doubleSided, structureScale: obj.structureScale });
    if (this.objects.get(obj.source) !== obj) { prepared.geometry.dispose(); return; }
    obj.prepared = prepared;
    if (obj.card || obj.material === "emboss") {
      // the paper card's uniforms: the card back and edge read them whatever the front shows
      this.paper ??= new Paper(this.renderer, obj.shared, { grid: (s) => this.grid(s), gridSettled: (s) => this.grids.has(s) });
      this.paper.register(obj.shared, obj.matU, obj.material === "emboss");
    }
    this.applySceneUniforms(obj);
    await this.syncAssets(obj);
    if (obj.material === "emboss" && this.paper) this.paper.sync(obj.values, obj.matU, this.faceOf(obj), () => obj.def.apply(obj.values, obj.matU));
    obj.variant = obj.def.variant ? obj.def.variant(obj.values) : "";
    const material = buildHoloMaterial(obj.def, tier, obj.shared, obj.matU, 0, { ldr: !pipeline.hdr, variant: obj.variant });
    let materials: THREE.Material | THREE.Material[] = material;
    if (obj.card) {
      const be = this.backEdge(obj);
      obj.backMaterial = be.back; obj.edgeMaterial = be.edge;
      materials = [material, be.back, be.edge];
    }
    const mesh = new THREE.Mesh(prepared.geometry, materials);
    mesh.frustumCulled = false;
    obj.scene.add(mesh);
    // compile before the first draw, with a render target bound: three keys programs by the output colour space,
    // which inside the HDR target is the linear working space
    const r = this.renderer, was = r.getRenderTarget();
    r.setRenderTarget(this.compileRT);
    const done = r.compileAsync(obj.scene, this.compileCam);
    r.setRenderTarget(was);
    await done;
    if (this.objects.get(obj.source) !== obj) { material.dispose(); prepared.geometry.dispose(); return; }
    obj.holoMaterial = material;
    obj.mesh = mesh;
  }

  /** A hologram subject's volume by name; null while it loads (asking starts the load) and after a failed load. */
  private grid(subject: string): VolumeGrid | null {
    const hit = this.grids.get(subject);
    if (hit !== undefined) return hit;
    const url = `${this.assets}holo3d/${subject}.sdf`;
    if (!this.volumes.has(url)) {
      const load = loadVolumeGrid(url);
      this.volumes.set(url, load);
      load.then((g) => { this.grids.set(subject, g); }, (e: unknown) => { this.grids.set(subject, null); console.error(`holo: could not load the hologram subject ${url}:`, e); });
    }
    return null;
  }

  /** The face the paper card's elements are placed on [mm]: the card's own, else holo.spot's 63 × 88. */
  private faceOf(obj: HoloObject): { x: number; y: number } {
    return obj.card ? { x: obj.card.widthMm, y: obj.card.heightMm } : { x: 63, y: 88 };
  }

  /** Every file the object needs is loaded (or failed) and bound. */
  private settled(obj: HoloObject): boolean {
    if (!obj.bumps.ready) return false;
    if (obj.material === "volume" && obj.volumeGrid === null) return false;
    if (obj.material === "emboss" && this.paper && !this.paper.settled(obj.values)) return false;
    return true;
  }

  /** The card in metres: holo.spot's card geometry (front, back and edge groups). */
  private prepareCard(obj: HoloObject): Prepared {
    const card = obj.card as { widthMm: number; heightMm: number }, c = this.state.card;
    const w = card.widthMm, h = card.heightMm, t = obj.material === "emboss" ? paperThicknessMm(obj.values) : c.thicknessMm;
    const geometry = buildCardGeometry({ widthM: w / 1000, heightM: h / 1000, thicknessM: t / 1000, cornerM: c.cornerMm / 1000, arcSegments: 12 });
    const box = new THREE.Box3().setFromObject(obj.source, true);
    const local = (obj.source as THREE.Mesh).geometry;
    local.computeBoundingBox();
    const size = local.boundingBox ? local.boundingBox.getSize(new THREE.Vector3()) : box.getSize(new THREE.Vector3());
    return {
      geometry, centerLocal: new THREE.Vector3(), sizeLocal: Math.max(size.x, size.y),
      halfM: new THREE.Vector3(w / 2000, h / 2000, t / 2000), radiusM: Math.hypot(w, h) / 2000,
      domainMm: { x: w, y: h }, mapping: "card", doubleSided: false, triangles: (geometry.index?.count ?? 0) / 3, note: null,
    };
  }

  /** The card's back and edge programs (paper while the front is Foil Emboss, whose stickers leave their reverse
   *  impression on the back). */
  private backEdge(obj: HoloObject): { back: THREE.ShaderMaterial; edge: THREE.ShaderMaterial } {
    const tier = this.tier as TierConfig, ldr = !(this.pipeline as Pipeline).hdr, def = obj.def, variant = obj.variant;
    const extra = def.cardDefines ? def.cardDefines(variant) : {};
    const tf = def.cardTransform;
    return {
      back: buildBackMaterial(tier, obj.shared, { ldr }, extra, tf ? (src) => tf(src, variant) : undefined),
      edge: buildEdgeMaterial(tier, obj.shared, { ldr }),
    };
  }

  /** Per-object uniforms that follow the scene settings and the object's surface (holo.spot's applySceneUniforms,
   *  rebuildWaves and updateBumps). */
  private applySceneUniforms(obj: HoloObject): void {
    const p = obj.prepared;
    if (!p) return;
    const c = this.state.card, u = obj.shared, tier = this.tier as TierConfig, card = obj.card !== null;
    (u.uCardSizeMm.value as THREE.Vector2).set(p.domainMm.x, p.domainMm.y);
    (u.uWrapMm.value as THREE.Vector2).set(0, 0);
    u.uBowMm.value = card ? c.bowMm : 0;
    u.uBowAxis.value = c.bowAxis === "along" ? 1 : 0;
    u.uCornerMm.value = card ? c.cornerMm : NO_OUTLINE_CORNER_MM;
    u.uPrintMode.value = card ? PRINT_MODE_INDEX[this.state.print] : 0;
    if (card && this.state.print !== "none" && !u.uTextTex.value) u.uTextTex.value = renderPrintText(obj.def);
    u.uBorderMode.value = c.border === "foil" ? 1 : 0;
    u.uEdgeSilver.value = card && c.edgeSilver ? 1 : 0;
    u.uWear.value = c.wear;
    u.uOcc.value = 0;
    const border = inkRgb(c.borderColor), back = inkRgb(c.backColor);
    if (border) (u.uInkBorder.value as THREE.Color).setRGB(border[0], border[1], border[2]);
    if (back) (u.uBackColor.value as THREE.Color).setRGB(back[0], back[1], back[2]);
    applyWaves(u, buildWaves(obj.def.relief(obj.values), { emboss: c.emboss, pitchMm: c.embossPitchMm, heightUm: c.embossHeightUm, layer: c.embossLayer }, tier.waves));
    // the bump map tiles over the card's face, or over a fixed 100 mm of surface on any other object
    const b = this.state.bump, dom = card ? p.domainMm : { x: BUMP_DOMAIN_MM, y: BUMP_DOMAIN_MM };
    obj.bumps.update({ map: this.assetUrl(b.map), strength: b.strength, tiling: b.tiling, layer: b.layer, invert: b.invert }, dom, { u: false, v: false });
  }

  /** A built-in bump map ("scratches", "/bumps/scratches.jpg") → its file in the kit's assets; anything else as given. */
  private assetUrl(map: string): string {
    const s = map.trim();
    if (s === "" || s.toLowerCase() === "none") return "";
    const named = BUMP_MAPS.find((m) => m.value === s || mapName(m.value) === s.toLowerCase());
    return named ? this.assets + named.value.replace(/^\//, "") : s;
  }

  /** @internal */
  _artwork(values: Record<string, ParamValue>, blobAssets: Readonly<Record<string, string>>): Record<string, ParamValue> {
    return resolveArtwork(values, this.assets, blobAssets);
  }

  /** A changed material value: uniforms, the spectral tables when the tint changed, the relief, and a new program when
   *  the value selects another shader variant. */
  /** @internal */
  _valuesChanged(obj: HoloObject): void {
    const before = obj.summary.tint;
    obj.summary = obj.def.gratingSummary(obj.values);
    const t = obj.summary.tint;
    if (t.type !== before.type || t.edgeNm !== before.edgeNm || t.widthNm !== before.widthNm || t.floor !== before.floor) obj.tex.setMaterial(obj.summary);
    obj.def.apply(obj.values, obj.matU);
    this.applySceneUniforms(obj);
    void this.syncAssets(obj).then(() => obj.def.apply(obj.values, obj.matU));
    const variant = obj.def.variant ? obj.def.variant(obj.values) : "";
    if (variant !== obj.variant && obj.mesh && this.pipeline && this.tier) {
      obj.variant = variant;
      const m = buildHoloMaterial(obj.def, this.tier, obj.shared, obj.matU, 0, { ldr: !this.pipeline.hdr, variant });
      obj.holoMaterial?.dispose();
      obj.holoMaterial = m;
      if (obj.card) {
        const be = this.backEdge(obj);
        obj.backMaterial?.dispose(); obj.edgeMaterial?.dispose();
        obj.backMaterial = be.back; obj.edgeMaterial = be.edge;
        obj.mesh.material = [m, be.back, be.edge];
      } else obj.mesh.material = m;
    }
  }

  /** The files a material needs beyond its shader: the Volume Hologram's subject. */
  private async syncAssets(obj: HoloObject): Promise<void> {
    if (obj.material !== "volume") return;
    const subject = volumeSubjectOf(obj.values);
    const custom = obj.values["volume.subject"];
    const url = typeof custom === "string" && /^(https?:|data:|blob:|\.{0,2}\/)/.test(custom) ? custom : `${this.assets}holo3d/${subject}.sdf`;
    if (obj.volumeUrl === url) return;
    obj.volumeUrl = url;
    let load = this.volumes.get(url);
    if (!load) { load = loadVolumeGrid(url); this.volumes.set(url, load); }
    try {
      const grid = await load;
      if (obj.volumeUrl !== url) return;
      obj.volumeGrid = grid;
      bindVolumeGrid(obj.matU, grid);
      obj.def.apply(obj.values, obj.matU);
    } catch (e) {
      this.volumes.delete(url);
      console.error(`holo: could not load the hologram subject ${url}:`, e);
    }
  }

  /** The object's place in its metre studio, and your camera moved there. */
  private placeObject(obj: HoloObject, camera: THREE.Camera, camP: THREE.Vector3, camQ: THREE.Quaternion): void {
    const p = obj.prepared as Prepared, src = obj.source;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
    src.matrixWorld.decompose(pos, quat, scale);
    const sWorld = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    if (Math.abs(scale.x - scale.y) > 1e-4 * sWorld || Math.abs(scale.y - scale.z) > 1e-4 * sWorld) this.warnOnce("scale", "holo: an object has a non-uniform scale; it is drawn with a uniform one (bake the scale into the geometry to keep its shape)");
    obj.centerWorld.copy(p.centerLocal).applyMatrix4(src.matrixWorld);
    const k = (p.sizeLocal * sWorld) / (obj.sizeMm * 1e-3);          // scene units per metre
    obj.unitsPerMetre = k;
    obj.model.makeRotationFromQuaternion(quat);
    const mesh = obj.mesh as THREE.Mesh;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(obj.model);
    mesh.matrixWorldNeedsUpdate = true;

    const persp = camera as THREE.PerspectiveCamera, ortho = camera as THREE.OrthographicCamera;
    let cam = obj.camera;
    if (persp.isPerspectiveCamera) {
      if (!cam || !(cam as THREE.PerspectiveCamera).isPerspectiveCamera) cam = obj.camera = new THREE.PerspectiveCamera();
      const c = cam as THREE.PerspectiveCamera;
      c.fov = persp.fov; c.aspect = persp.aspect; c.zoom = persp.zoom; c.near = persp.near / k; c.far = persp.far / k;
      c.filmGauge = persp.filmGauge; c.filmOffset = persp.filmOffset; c.view = persp.view ? { ...persp.view } : null;
      c.updateProjectionMatrix();
    } else if (ortho.isOrthographicCamera) {
      if (!cam || !(cam as THREE.OrthographicCamera).isOrthographicCamera) cam = obj.camera = new THREE.OrthographicCamera();
      const c = cam as THREE.OrthographicCamera;
      c.left = ortho.left / k; c.right = ortho.right / k; c.top = ortho.top / k; c.bottom = ortho.bottom / k;
      c.zoom = ortho.zoom; c.near = ortho.near / k; c.far = ortho.far / k; c.view = ortho.view ? { ...ortho.view } : null;
      c.updateProjectionMatrix();
    } else throw new Error("holo: the camera must be a PerspectiveCamera or an OrthographicCamera");
    cam.position.copy(camP).sub(obj.centerWorld).divideScalar(k);
    cam.quaternion.copy(camQ);
    cam.updateMatrixWorld(true);
  }

  /** The depth of field of this frame (holo.spot's DofControl.frame), focused on the first object. */
  private dofFrame(obj: HoloObject, cam: THREE.Camera, dt: number, still: boolean, exposure: number, bg: Background, mode: Compose): DofFrame | null {
    const d = this.state.dof, persp = cam as THREE.PerspectiveCamera;
    if (!d.on || !persp.isPerspectiveCamera || mode !== "replace") return null;
    const p = obj.prepared as Prepared;
    const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
    const depthOf = (w: THREE.Vector3) => -w.clone().applyMatrix4(inv).z;
    const objectDepthM = depthOf(new THREE.Vector3());
    const q = new THREE.Quaternion().setFromRotationMatrix(obj.model);
    const pointDepthM = d.focus === "point" ? depthOf(new THREE.Vector3(d.point.x * p.halfM.x, d.point.y * p.halfM.y, d.point.z * p.radiusM).applyQuaternion(q)) : null;
    const fMm = focalLengthMm(persp.fov);
    const target = focusDistanceM(d.focus, { objectDepthM, pointDepthM, manualCm: d.distanceCm, offsetMm: d.offsetMm, fMm });
    const zfM = this.pull.update(target, dt, false, still || dt === 0);
    return {
      zfM, fMm, fNumber: d.fNumber, near: persp.near, far: persp.far,
      blades: d.blades, bladeCurve: d.bladeCurve, bladeAngleDeg: d.bladeAngleDeg, catsEye: d.catsEye, rim: d.rim, loca: d.loca,
      exposure, blackPage: bg === "black", debug: false,
    };
  }

  /** The page behind the object: the `background` option, else the look's; a plain colour as `scene.background` wins
   *  when nothing was said. */
  private backgroundOf(scene: THREE.Scene): { kind: Background; hex: string } {
    const opt = this.backgroundOpt;
    if (opt === "black" || opt === "white") return { kind: opt, hex: opt === "white" ? "#ffffff" : "#000000" };
    if (typeof opt === "string") return { kind: "colour", hex: hexColour(opt, "#000000") };
    const sb = scene.background as THREE.Color | null;
    if (sb && sb.isColor) return { kind: "colour", hex: `#${sb.getHexString(THREE.SRGBColorSpace)}` };
    return { kind: this.state.background, hex: this.state.bgColor };
  }

  private modeFor(scene: THREE.Scene, live: readonly HoloObject[]): "replace" | "over" {
    if (this.composeMode !== "auto") return this.composeMode;
    const bgTex = scene.background !== null && !(scene.background as THREE.Color).isColor;
    if (bgTex) return "over";
    const mine = new Set<THREE.Object3D>();
    for (const o of live) for (const m of o.sources) mine.add(m);
    let others = false;
    scene.traverseVisible((o) => {
      if (others || mine.has(o)) return;
      const any = o as THREE.Mesh & THREE.Line & THREE.Points & THREE.Sprite;
      if (any.isMesh || any.isLine || any.isPoints || any.isSprite) others = true;
    });
    if (others) return "over";
    const gl = this.renderer.getContext();
    const transparent = (gl.getContextAttributes()?.alpha ?? false) && this.renderer.getClearAlpha() < 1 && scene.background === null && this.backgroundOpt === undefined;
    return transparent ? "over" : "replace";
  }

  private warnOnce(key: string, text: string): void {
    if (this.warned.has(`!${key}`)) return;
    this.warned.add(`!${key}`);
    console.warn(text);
  }

  private save(): SavedState {
    const r = this.renderer;
    return { autoClear: r.autoClear, toneMapping: r.toneMapping, outputColorSpace: r.outputColorSpace, target: r.getRenderTarget(), clearColor: r.getClearColor(new THREE.Color()), clearAlpha: r.getClearAlpha() };
  }
  private restore(s: SavedState, keepColorSpace = false): void {
    const r = this.renderer;
    r.autoClear = s.autoClear; r.toneMapping = s.toneMapping;
    if (!keepColorSpace) r.outputColorSpace = s.outputColorSpace as THREE.ColorSpace;
    r.setRenderTarget(s.target); r.setClearColor(s.clearColor, s.clearAlpha);
  }
}
