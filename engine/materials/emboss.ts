// A6 Foil Emboss · paper card (addendum A6): the MaterialDef — panel literal and parameter table from emboss.params.ts,
// the fragment main holo_emboss.frag with the extra chunks paper.glsl and emboss.glsl, the uniform conversions, the
// grating summary of the foil (a linear rainbow grating, rings or sparkle cells, or plain silver / gold metal) and the
// relief inputs (paper cockle, no coat).
//
// Physical model in one line: heavy uncoated cotton stock (Oren–Nayar diffuse with a wrapped cosine for its
// translucency, a weak broad GGX sheen, LEAN-filtered tooth, fibres and felt marks, procedural formation) carrying a
// sculpted combination-die emboss 0.45 mm high whose raised surface is hot-stamped with a holographic foil (a 1000 l/mm
// sinusoidal grating, 50 nm deep, in aluminium under a 1.5-index top lacquer) that follows the relief and, partly, the
// paper's tooth; the grating rides on the embossed surface, so the spectrum bends over the shoulders.
//
// The emboss uniforms shared with the card back and edge (logo SDF, relief, paper) are the singletons of
// scene/embossAssets.ts: createUniforms() returns them and apply() writes them; main.ts registers them into the shared
// map and loads the textures (EmbossAssets) while this material is shown.
//
// Addendum A9: the hologram sticker. `emboss.element = hologram` selects the program variant "sticker" (define
// EMB_STICKER; main holo_sticker.frag, the analytic shapes of emboss.glsl and A5's volume.glsl); the foil variant ""
// compiles exactly the pre-A9 program. apply() writes the shape uniforms (shared: the card back's reverse impression
// uses them too) and, through volume.ts applyVolumeUniforms, A5's hologram uniforms from the `emboss.holo.*` values
// (size, depth and backdrop depth converted from % of the sticker's shorter side to mm). main.ts binds the subject's
// volume (scene/volumes.ts) into this material's uniforms while the sticker is shown.
import * as THREE from "three";
import type { GratingSummary, MaterialDef, ParamValues, ReliefInputs, TierConfig, TintInputs, Uniforms } from "../types.ts";
import foilMain from "../shaders/holo_emboss.frag?raw";
import stickerMain from "../shaders/holo_sticker.frag?raw";
import paperGlsl from "../shaders/paper.glsl?raw";
import embossGlsl from "../shaders/emboss.glsl?raw";
import volumeGlsl from "../shaders/volume.glsl?raw";
import {
  ELEMENT_PRESETS, EMBOSS_PARAMS, EMBOSS_PROFILES, FOIL_TYPES, PAPER_STOCKS, STOCK_PRESETS, embossDial, embossElementOf,
  stickerShapeOf, stickerVolumeValues,
} from "./emboss.params.ts";
import type { EmbossProfile, FoilType } from "./emboss.params.ts";
import { DEG, numParam, selectParam, setUniform } from "./build.ts";
import { PLACEMENT_WIDE } from "../ui/logoEditorMath.ts";                   // A14: the flag's stickers
import { embossShared } from "../scene/embossAssets.ts";
import { PAPER_N, PAPER_TILE_MM } from "../scene/paperMaps.ts";
import { reliefUniform, DOME_U0 } from "../physics/emboss.ts";
import { STICKER_DOME_K, rectTorsionMax, shapeGeometry } from "../physics/sticker.ts";
import type { ShapeGeometry } from "../physics/sticker.ts";
import { linearColor } from "../scene/uniforms.ts";
import { applyVolumeUniforms, bindVolumeGrid, createVolumeUniforms, volumePatternDefines } from "./volume.ts";
import type { VolumeGrid } from "./volume.ts";
import type { EmbossShared } from "../scene/embossAssets.ts";
import { docOf, elementValues, primaryValues, visibleElements } from "../app/paperDoc.ts";
import type { DocElement } from "../app/paperDoc.ts";
import { EMB_MAX, buildMultiMain, multiEnv, multiUniforms, transformMulti, writeElement } from "./embossMulti.ts";

const DEFAULTS: ParamValues = Object.fromEntries(EMBOSS_PARAMS.map((p) => [p.id, p.default]));
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** Gold foil: a yellow-gold dyed lacquer over aluminium (long-pass at 520 nm; the vortex material's 500 nm edge read
 *  lemon-olive on the small, bright foil areas). */
const GOLD_TINT: TintInputs = { type: "longpass", edgeNm: 520, widthNm: 45, floor: 0.2 };
const CLEAR_TINT: TintInputs = { type: "clear", edgeNm: 505, widthNm: 35, floor: 0.06 };
/** Foil grating constants (hot-stamping rainbow foil; the M1 defaults). */
export const FOIL_GRATING = { depthNm: 55, fanDeg: 7, sigThetaDeg: 0.3, sigPitchPct: 0.5, nc: 1.5, roughnessDeg: 0.25 } as const;

const pitchNm = (v: ParamValues) => Math.max(numParam(v, "emboss.pitch", 1000), 1);
const grooveDeg = (v: ParamValues) => numParam(v, "emboss.grooveAngle", 120);
const foilType = (v: ParamValues): FoilType => selectParam(v, "emboss.foil", FOIL_TYPES, "rainbow");
const profileOf = (v: ParamValues): EmbossProfile => selectParam(v, "emboss.profile", EMBOSS_PROFILES, "round");

/** Paper albedo gain for the map's albedo modulation (texture strength), the BRDF and pattern uniforms. */
export function paperUniformValues(v: ParamValues): {
  map: [number, number, number, number]; brdf: [number, number, number, number]; pat: [number, number, number, number];
} {
  const strength = clamp(numParam(v, "emboss.textureStrength", 1), 0, 2);
  const toothMm = clamp(numParam(v, "emboss.tooth", 7), 0, 30) / 1000;
  const hUnit = toothMm * strength;                              // height of one RMS unit [mm]
  const rough = clamp(numParam(v, "emboss.roughness", 0.75), 0.2, 1);
  const stock = Math.max(PAPER_STOCKS.indexOf(selectParam(v, "emboss.stock", PAPER_STOCKS, "cotton")), 0);
  return {
    map: [1 / PAPER_TILE_MM, hUnit * (PAPER_N / PAPER_TILE_MM), hUnit, strength],
    // Oren–Nayar σ 0.25–0.6 rad (14–34°); sheen α 0.35–0.7 (A6.1)
    brdf: [0.25 + 0.35 * rough, clamp(numParam(v, "emboss.sheen", 0.35), 0, 1), 0.35 + 0.35 * rough,
      clamp(numParam(v, "emboss.translucency", 0.35), 0, 1)],
    pat: [stock, clamp(numParam(v, "emboss.formation", 0.45), 0, 1), strength, Math.max(Math.round(numParam(v, "emboss.seed", 7)), 0)],
  };
}

function setVec4(u: Uniforms, name: string, x: number, y: number, z: number, w: number): void {
  const t = u[name]?.value;
  if (t instanceof THREE.Vector4) t.set(x, y, z, w); else setUniform(u, name, new THREE.Vector4(x, y, z, w));
}

/** A9: the sticker's shape geometry of a panel snapshot (svg: the loaded artwork's aspect, from the logo uniforms). */
export function stickerGeometry(values: ParamValues, logoAspectHW = embossShared().uLogoMap.value.w): ShapeGeometry {
  return shapeGeometry(stickerShapeOf(values), clamp(numParam(values, "emboss.width", 36), 1, PLACEMENT_WIDE.width[1]), numParam(values, "emboss.aspect", 1),
    numParam(values, "emboss.cornerRadius", 2.5), logoAspectHW);
}

/** The uniforms of ONE element's snapshot: the shared singletons `S` (logo placement, relief, shape, paper) and the
 *  material's `u` (foil, hologram). */
function applyInto(values: ParamValues, u: Uniforms, S: EmbossShared): void {
  // ---- logo placement and relief (shared)
  // (A14: within the widest placement frame — the largest flag's face; a card's values all lie in its own −12.5 … 75.5 × 0 … 88)
  const x = clamp(numParam(values, "emboss.x", 31.5), PLACEMENT_WIDE.x[0], PLACEMENT_WIDE.x[1]);
  const y = clamp(numParam(values, "emboss.y", 44), PLACEMENT_WIDE.y[0], PLACEMENT_WIDE.y[1]);
  const rot = numParam(values, "emboss.rotation", 0) * DEG;
  S.uLogoXf.value.set(x - 31.5, y - 44, Math.cos(rot), Math.sin(rot));
  S.uLogoW.value = clamp(numParam(values, "emboss.width", 36), 1, PLACEMENT_WIDE.width[1]);   // (A14: up to the largest flag; a card's ≤ 63)
  const prof = profileOf(values);
  const r = reliefUniform({ heightMm: clamp(numParam(values, "emboss.height", 450), 0, 1000) / 1000,
    shoulderMm: clamp(numParam(values, "emboss.shoulder", 0.6), 0.05, 2), profile: prof, puff: clamp(numParam(values, "emboss.puff", 0.4), 0, 1) });
  S.uRelief.value.set(r.H, r.s, r.hp, r.lambda);
  S.uRelProfile.value = EMBOSS_PROFILES.indexOf(prof);
  // ---- paper (shared)
  const pv = paperUniformValues(values);
  S.uPaperMap.value.set(...pv.map);
  S.uPaperBrdf.value.set(...pv.brdf);
  S.uPaperPat.value.set(...pv.pat);
  const col = values["emboss.paperColour"];
  linearColor(typeof col === "string" ? col : "#f3f1ea", S.uPaperRgb.value);
  S.uPaperBump.value = values["emboss.paperBump"] === true ? 1 : 0;
  S.uEmbExposure.value = Math.pow(2, clamp(numParam(values, "emboss.exposure", 0.6), -2, 2));
  S.uPrintK.value.y = clamp(numParam(values, "emboss.printInk", 1), 0, 1);   // .x (on) is set by the app (a loaded picture on the card)
  // ---- foil (material)
  const ft = foilType(values);
  setUniform(u, "uFoilType", FOIL_TYPES.indexOf(ft));
  setUniform(u, "uInvD", 1 / pitchNm(values));
  const a = grooveDeg(values) * DEG;                             // grooves at a ⇒ ĝ = (sin a, −cos a) (§3.1)
  const g = u.uGDir?.value;
  if (g instanceof THREE.Vector2) g.set(Math.sin(a), -Math.cos(a)); else setUniform(u, "uGDir", new THREE.Vector2(Math.sin(a), -Math.cos(a)));
  setUniform(u, "uDepthNm", FOIL_GRATING.depthNm);
  setUniform(u, "uFanQ", FOIL_GRATING.fanDeg * DEG);
  setUniform(u, "uSigTheta", FOIL_GRATING.sigThetaDeg * DEG);
  setUniform(u, "uSigFrel", FOIL_GRATING.sigPitchPct / 100);
  setUniform(u, "uNc", FOIL_GRATING.nc);
  setUniform(u, "uSigS", FOIL_GRATING.roughnessDeg * DEG);
  // gloss 1 → α 0.025 (mirror lacquer), 0 → 0.3 (satin)
  setUniform(u, "uCoatAlpha", 0.3 - 0.275 * clamp(numParam(values, "emboss.gloss", 0.8), 0, 1));
  setVec4(u, "uFoil", clamp(numParam(values, "emboss.foilCoverage", 0.85), 0, 1), clamp(numParam(values, "emboss.edgeBreakup", 0.35), 0, 1),
    clamp(numParam(values, "emboss.showThrough", 0.25), 0, 1), clamp(numParam(values, "emboss.sparkleSize", 160), 20, 2000) / 1000);
  setUniform(u, "uSeed", Math.max(Math.round(numParam(values, "emboss.seed", 7)), 0) >>> 0);
  setUniform(u, "uFoilBump", clamp(numParam(values, "emboss.foilBump", 0.25), 0, 1));
  // ---- A9 hologram sticker (shape uniforms shared with the card back; A5's hologram uniforms, uSigS and uCoatAlpha
  // of this material take the sticker's values only while it is shown)
  if (embossElementOf(values) !== "hologram") { S.uLogoShape.value = 0; return; }
  const sg = stickerGeometry(values, S.uLogoMap.value.w);
  S.uLogoShape.value = sg.kind;
  S.uShapeK.value.set(sg.hw, sg.hh, sg.r, STICKER_DOME_K * DOME_U0);
  S.uShapeT.value.set(Math.min(sg.hw, sg.hh), Math.max(sg.hw, sg.hh), 1 / Math.max(rectTorsionMax(sg.hw, sg.hh), 1e-9), sg.hh < sg.hw ? 1 : 0);
  setUniform(u, "uFilmMm", clamp(numParam(values, "emboss.filmUm", 40), 0, 500) / 1000);
  // the die's margin around the patch: the part of the shoulder the film leaves bare (0 when it runs to the foot)
  S.uFilmGrow.value = r.s * (1 - clamp(numParam(values, "emboss.filmWall", 0), 0, 1));
  applyVolumeUniforms(stickerVolumeValues(values, sg.shortMm), u);
}

// ---- A11 stage 2: several elements ------------------------------------------------------------------------------

const isGrating = (v: ParamValues) => { const ft = foilType(v); return ft !== "silver" && ft !== "gold"; };
/** The visible elements of a panel snapshot. */
const visibleOf = (values: ParamValues): DocElement[] => visibleElements(docOf(values));
/** Gold beside other elements: the spectral tables stay clear (they hold one tint for the whole card), and the gold
 *  foil's metal is multiplied by this RGB stand-in for its long-pass lacquer (linear sRGB). A card whose every element
 *  is gold foil keeps the exact spectral tint. */
const GOLD_RGB: readonly [number, number, number] = [1.0, 0.76, 0.24];
const allGold = (values: ParamValues, vis: readonly DocElement[]) =>
  vis.length > 0 && vis.every((e) => e.type === "foil" && foilType(elementValues(values, e)) === "gold");
/** The element needs the logo's distance field (a foil logo, or a sticker cut to the logo's outline). */
const needsLogo = (v: ParamValues) => embossElementOf(v) !== "hologram" || stickerShapeOf(v) === "svg";
const logoUrlOf = (v: ParamValues) => { const l = v["emboss.logo"]; return typeof l === "string" ? l.trim() : ""; };

/** The logo artworks (in slot order, distinct) and hologram subjects the visible elements of a multi-element card
 *  need; both empty while at most one element is visible (the single-element path loads its own). */
export function multiAssets(values: ParamValues): { logos: string[]; subjects: string[] } {
  const hit = multiCache.get(values);
  if (hit) return hit;
  const vis = visibleOf(values), logos: string[] = [], subjects: string[] = [];
  const out = { logos, subjects };
  multiCache.set(values, out);
  if (vis.length < 2) return out;
  for (const e of vis) {
    const v = elementValues(values, e);
    if (needsLogo(v)) { const l = logoUrlOf(v); if (l && !(l.length <= 8 && l.toLowerCase() === "none") && !logos.includes(l)) logos.push(l); }
    if (e.type === "hologram") { const s = String(v["emboss.holo.subject"]); if (!subjects.includes(s)) subjects.push(s); }
  }
  return out;
}
/** Per values snapshot (the panel hands out a new object on every edit; main.ts asks every frame, and the logos are
 *  data URLs: nothing here may be recomputed or serialised per frame). */
const multiCache = new WeakMap<object, { logos: string[]; subjects: string[] }>();

interface Scratch { S: EmbossShared; u: Uniforms }
const scratches: Scratch[] = [];
/** Private uniform objects of element `i`: its own placement / relief / shape / logo-map values (the paper ones are
 *  the shared singletons) and its own foil and hologram uniforms; applyInto fills them, writeElement copies them. */
function scratch(i: number): Scratch {
  if (scratches[i]) return scratches[i];
  const S: EmbossShared = {
    ...embossShared(),
    uLogoOn: { value: 0 }, uLogoMap: { value: new THREE.Vector4(1.28, 1.28, 1 / 800, 1) },
    uLogoXf: { value: new THREE.Vector4(0, 0, 1, 0) }, uLogoW: { value: 36 }, uRelief: { value: new THREE.Vector4() }, uRelProfile: { value: 0 },
    uLogoShape: { value: 0 }, uFilmGrow: { value: 0 }, uShapeK: { value: new THREE.Vector4() }, uShapeT: { value: new THREE.Vector4() },
  };
  const u: Uniforms = { ...materialUniforms(), ...createVolumeUniforms() };
  u.uSigS = { value: 0.004 }; u.uCoatAlpha = { value: 0.08 };
  return (scratches[i] = { S, u });
}

function applyMulti(values: ParamValues, vis: readonly DocElement[]): void {
  const gold = allGold(values, vis);
  vis.slice(0, EMB_MAX).forEach((el, i) => {
    const v = elementValues(values, el), sc = scratch(i);
    const logo = needsLogo(v) ? multiEnv.logo(logoUrlOf(v)) : null;
    sc.S.uLogoOn.value = logo ? logo.on : 0;
    if (logo) sc.S.uLogoMap.value.copy(logo.map);
    const holo = el.type === "hologram";
    const vol = holo ? multiEnv.volume(String(v["emboss.holo.subject"])) : null;
    bindVolumeGrid(sc.u, vol ? (vol.grid as VolumeGrid) : null);
    sc.S.uFilmGrow.value = 0;                                    // (a foil element: applyInto leaves it)
    applyInto(v, sc.u, sc.S);
    // the element's box in its own frame: the die (the sticker grown by the bare shoulder) or the artwork's box
    const w = sc.S.uLogoW.value, k = sc.S.uShapeK.value, shape = sc.S.uLogoShape.value > 0;
    const hw = shape ? k.x + sc.S.uFilmGrow.value : 0.5 * w, hh = shape ? k.y + sc.S.uFilmGrow.value : 0.5 * w * sc.S.uLogoMap.value.w;
    const r = sc.S.uRelief.value, reach = r.y + 2.2 * r.w + 8;   // shoulder + puff + the longest cast shadow
    const tint = !holo && !gold && foilType(v) === "gold" ? GOLD_RGB : [1, 1, 1];
    writeElement(i, {
      ...sc.S, ...sc.u,
      uElBox: { value: new THREE.Vector4(hw, hh, reach, holo ? 1 : 0) }, uElSlot: { value: logo ? logo.slot : 0 },
      uElTint: { value: new THREE.Vector3(tint[0], tint[1], tint[2]) },
      uVolAtS: { value: new THREE.Vector3(...(vol ? vol.scale : [0, 0, 0])) }, uVolAtO: { value: new THREE.Vector3(...(vol ? vol.offset : [0, 0, 0])) },
    });
  });
}

/** MaterialDef.apply: at most one visible element → exactly the pre-A11 uniforms of that element (or of none); two or
 *  more → the card-level uniforms from the first, then every element into the multi program's arrays. */
function apply(values: ParamValues, u: Uniforms): void {
  const vis = visibleOf(values), M = multiUniforms();
  applyInto(primaryValues(values), u, embossShared());
  if (vis.length < 2) { M.uElCount.value = 0; return; }
  applyMulti(values, vis);
  M.uElCount.value = Math.min(vis.length, EMB_MAX);
}

/** The foil uniforms of the material (fresh objects). */
function materialUniforms(): Uniforms {
  return {
    uFoilType: { value: 0 }, uInvD: { value: 1e-3 }, uGDir: { value: new THREE.Vector2(0.866, 0.5) }, uDepthNm: { value: 55 },
    uFanQ: { value: 0.12 }, uSigTheta: { value: 0.005 }, uSigFrel: { value: 0.005 }, uNc: { value: 1.5 }, uSigS: { value: 0.004 },
    uCoatAlpha: { value: 0.08 }, uFoil: { value: new THREE.Vector4(0.85, 0.35, 0.25, 0.16) }, uSeed: { value: 7 },
    uFoilBump: { value: 0.25 }, uFilmMm: { value: 0.04 },
  };
}

function createUniforms(): Uniforms {
  const u: Uniforms = {
    ...embossShared(),
    ...multiUniforms(),                                           // A11: the multi-element program's arrays (shared singletons)
    ...materialUniforms(),
    ...createVolumeUniforms(),                                    // A9: the sticker's hologram (A5's uniforms)
  };
  // the foil's values of the names both use (uSigS, uCoatAlpha), as before A9
  u.uSigS = { value: 0.004 }; u.uCoatAlpha = { value: 0.08 };
  apply(DEFAULTS, u);
  return u;
}

/** A9: the sticker variant's main and chunks, selected by the define EMB_STICKER (the foil main is unchanged). */
const SINGLE_MAIN = `#ifdef EMB_STICKER\n${stickerMain}\n#else\n${foilMain}\n#endif\n`;
/** A11: the multi-element variant's main (both mains merged, materials/embossMulti.ts); transformFragment swaps it in
 *  for the single-element mains, so the single-element programs' source is exactly the pre-A11 one. */
const MULTI_MAIN = buildMultiMain(stickerMain, foilMain);
const FRAGMENT_MAIN = SINGLE_MAIN;
const STICKER_CHUNK = `#ifdef EMB_STICKER\n${volumeGlsl}\n#endif\n`;
/** A9: the hologram sticker's grating summary (A5's: no surface grating, a clear tint). */
const STICKER_SUMMARY: GratingSummary = { pitchesNm: [1000], depthNm: 0, nc: 1.5, gAzimuthRad: null, recycle: false, tint: CLEAR_TINT };

export const emboss: MaterialDef = {
  id: "emboss",
  name: "Foil Emboss",
  analog: "sculpted foil embossing on heavy cotton stock (combination die)",
  caption: "holographic foil, sculpted emboss · cotton paper",
  dial: embossDial,
  params: EMBOSS_PARAMS,
  fragmentMain: FRAGMENT_MAIN,
  extraChunks: [paperGlsl, embossGlsl, STICKER_CHUNK],
  createUniforms,
  apply,
  // A9: the program variant of the element (foil "" = the pre-A9 program, "sticker" = the hologram sticker)
  // A11: "multi" (two or more visible elements) is built on demand, not in the background list
  variants: ["", "sticker"],
  variant(values: ParamValues): string {
    const vis = visibleOf(values);
    if (vis.length >= 2) return "multi";
    return vis.length === 1 && vis[0].type === "hologram" ? "sticker" : "";
  },
  transformFragment(src: string, variant: string): string {
    if (variant !== "multi") return src;
    if (!src.endsWith(SINGLE_MAIN)) throw new Error("emboss: the fragment main was not found");
    return transformMulti(src.slice(0, src.length - SINGLE_MAIN.length) + MULTI_MAIN, "front");
  },
  cardTransform(src: string, variant: string): string {
    return variant === "multi" ? transformMulti(src, "back") : src;
  },
  // Parallax and shadow steps, paper lookups: full on high, lighter on medium, minimal on low (phones).
  defines(tier: TierConfig, variant = ""): Record<string, string | number> {
    const t = tier.tier;
    return {
      EMB_POM_STEPS: t === "high" ? 16 : t === "medium" ? 10 : 6,
      EMB_SHADOW_STEPS: t === "high" ? 12 : t === "medium" ? 8 : 5,
      PAPER_LAYERS: t === "low" ? 1 : 2,
      ...(variant === "sticker" ? { EMB_STICKER: 1, ...volumePatternDefines(tier) } : {}),   // A10: the diffractive pattern's slots
      ...(variant === "multi" ? { EMB_STICKER: 1, EMB_MULTI: 1, EMB_MAX, ...volumePatternDefines(tier) } : {}),
    };
  },
  // A9: the card back of the sticker variant shows the reverse impression of its analytic shapes
  cardDefines(variant: string): Record<string, string | number> {
    return variant === "sticker" ? { EMB_STICKER: 1 } : variant === "multi" ? { EMB_STICKER: 1, EMB_MULTI: 1, EMB_MAX } : {};
  },
  // One family; the linear rainbow reports its grating-vector azimuth, rings and sparkle cells null (ĝ ∥ q for the
  // orders, orientation means for mirrors and environment); gold foil is the dyed lacquer's long-pass filter.
  // A9: the hologram sticker has no surface grating (A5's summary: depth 0, clear).
  gratingSummary(all: ParamValues): GratingSummary {
    const vis = visibleOf(all);
    if (vis.length >= 2) {
      // A11: one summary for the whole card (the tables and etaNorm are per material): the first grating foil's pitch
      // (and its azimuth when every grating foil is a rainbow at that angle), clear unless every element is gold foil
      const foils = vis.filter((e) => e.type === "foil").map((e) => elementValues(all, e)), gr = foils.filter(isGrating);
      if (!foils.length) return { ...STICKER_SUMMARY, tint: { ...CLEAR_TINT } };
      const g0 = gr[0];
      const same = g0 !== undefined && gr.every((v) => foilType(v) === "rainbow" && grooveDeg(v) === grooveDeg(g0));
      return {
        pitchesNm: [g0 ? pitchNm(g0) : 1000], depthNm: g0 ? FOIL_GRATING.depthNm : 0, nc: FOIL_GRATING.nc,
        gAzimuthRad: same && g0 ? (grooveDeg(g0) - 90) * DEG : null, recycle: true, tint: allGold(all, vis) ? GOLD_TINT : CLEAR_TINT,
      };
    }
    const values = primaryValues(all);
    if (embossElementOf(values) === "hologram") return { ...STICKER_SUMMARY, tint: { ...CLEAR_TINT } };
    const ft = foilType(values);
    return {
      pitchesNm: [pitchNm(values)],
      depthNm: ft === "silver" || ft === "gold" ? 0 : FOIL_GRATING.depthNm,
      nc: FOIL_GRATING.nc,
      gAzimuthRad: ft === "rainbow" ? (grooveDeg(values) - 90) * DEG : null,
      recycle: true,
      tint: ft === "gold" ? GOLD_TINT : CLEAR_TINT,
    };
  },
  // Paper cockle only: a faint waviness (`emboss.waviness`, default 0.12°; A9 made A6's constant a control, so the
  // numeric checks can switch it off as they do the other materials' waviness), no orange peel (uncoated stock).
  relief(values: ParamValues): ReliefInputs {
    return { seed: Math.max(Math.round(numParam(values, "emboss.seed", 7)), 0), wavinessDeg: clamp(numParam(values, "emboss.waviness", 0.12), 0, 1), orangePeelUm: 0 };
  },
  wobbleAxisDeg(all: ParamValues): number | null {
    const values = primaryValues(all);
    if (visibleOf(all).length >= 2 || embossElementOf(values) === "hologram") return null;    // A9: the sticker has no grating (as A5)
    return foilType(values) === "rainbow" ? grooveDeg(values) : null;
  },
  valueLabel: "cotton · foil",
  // A9: the caption names the element shown
  captionOf(all: ParamValues): string {
    const n = visibleOf(all).length, values = primaryValues(all);
    if (n >= 2) return `${n} elements: foil logos and hologram stickers · cotton paper`;
    return embossElementOf(values) === "hologram" ? "volume-hologram sticker, 3D image, sculpted emboss · cotton paper" : emboss.caption;
  },
  // A6.1: selecting a paper stock writes its preset of the paper dials; A9.2: switching the element to the hologram
  // sticker in the panel writes the default sticker once (never from a URL, a saved version or a view)
  presets: [
    { id: "emboss.stock", values: STOCK_PRESETS },
    { id: "emboss.element", values: ELEMENT_PRESETS, userOnly: true },
  ],
};

/** The card thickness of the paper stock [mm] (main.ts rebuilds the card with it while Foil Emboss is shown). */
export function paperThicknessMm(values: ParamValues): number {
  return clamp(numParam(values, "emboss.thickness", 0.8), 0.3, 1.2);
}
