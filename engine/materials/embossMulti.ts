// Addendum A11 stage 2: the multi-element program of the paper card (two or more visible elements; a card with at
// most one keeps the pre-A11 programs untouched, so it renders bit for bit as before).
//
// Approach: the existing shader code reads one element's parameters from uniforms (uLogoXf, uRelief, uFoil, uVol…).
// The multi program keeps that code verbatim and makes those names plain globals, loaded per pixel from uniform
// arrays:
//   uniform vec4 uLogoXf;            →   uniform vec4 ua_uLogoXf[EMB_MAX]; vec4 uLogoXf;
// `embSelect(p)` picks the element of the pixel — the topmost one whose outline contains p (one distance fetch per
// element whose box is in reach), else the nearest one in reach (its puff and cast shadow on the paper), else none —
// and `embLoad(i)` copies its array entries into the globals. Everything after that (relief, parallax, shadows, the
// foil or the hologram) is the single-element code, evaluated once for that element only: the cost per pixel is the
// single-element cost plus the selection.
//   • The two mains (holo_emboss.frag: foil, holo_sticker.frag: hologram sticker) are merged: their identical step 1
//     (geometry and every derivative, in uniform control flow) runs once, then the element is selected and the rest of
//     the matching main runs in a branch.
//   • Logo distance fields: up to MAX_LOGOS textures (uLogoTex0…3, each its own size and mip chain) behind an if-chain.
//   • Hologram subjects: one 3D atlas (scene/volumes.ts buildVolumeAtlas: the subjects stacked along z); each element
//     carries its slab's scale and offset, and volSdf clamps to the slab as clamp-to-edge would.
//   • The card back selects the same way for the reverse impressions.
// Pure string and uniform plumbing (no shader sources imported), so tests/paperDoc.test.ts covers the transformation.
import * as THREE from "three";
import type { Uniforms } from "../types.ts";
import { MAX_ELEMENTS, MAX_LOGOS } from "../app/paperDoc.ts";

export const EMB_MAX = MAX_ELEMENTS;

type GlslType = "int" | "float" | "vec2" | "vec3" | "vec4" | "mat3";
/** The per-element uniforms of the single-element code and their GLSL types. */
export const PER_ELEMENT: Readonly<Record<string, GlslType>> = {
  // emboss.glsl
  uLogoOn: "int", uLogoMap: "vec4", uLogoXf: "vec4", uLogoW: "float", uRelief: "vec4", uRelProfile: "int",
  uLogoShape: "int", uShapeK: "vec4", uShapeT: "vec4", uFilmGrow: "float",
  // foil (holo_emboss.frag), coat.glsl
  uFoilType: "int", uInvD: "float", uGDir: "vec2", uFoil: "vec4", uFoilBump: "float", uSigS: "float", uCoatAlpha: "float",
  // sticker (holo_sticker.frag, volume.glsl)
  uFilmMm: "float", uVolGridN: "vec3", uVolGridMin: "vec3", uVolGridH: "float", uVolLoaded: "int", uVolRotT: "mat3",
  uVolPose: "vec4", uVolRecLight: "vec3", uVolSpeckle: "float", uVolBackdrop: "vec2", uVolType: "int", uVolLambda: "vec4",
  uVolRef: "vec3", uVolSel: "vec2", uVolEff: "float", uVolRec: "vec4", uVolPat: "vec4", uVolPat2: "vec4", uVolGlare: "float",
};
/** Per-element values the multi program adds: the element's box (half width, half height, reach [mm], type 0 foil /
 *  1 sticker), its logo texture slot, the foil tint (the RGB stand-in for gold beside other elements) and the
 *  hologram atlas slab (scale, offset). Globals of the same names are declared with the logo samplers. */
export const PER_ELEMENT_EXTRA: Readonly<Record<string, GlslType>> = {
  uElBox: "vec4", uElSlot: "int", uElTint: "vec3", uVolAtS: "vec3", uVolAtO: "vec3",
};
const ALL: Readonly<Record<string, GlslType>> = { ...PER_ELEMENT, ...PER_ELEMENT_EXTRA };

// ---------------------------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------------------------

const UNIFORM_LINE = /^([ \t]*)uniform[ \t]+((?:highp|mediump|lowp)[ \t]+)?(\w+)[ \t]+([^;]+);/gm;

/** Splits a main's source at `void main() {` into the declarations before it and the body (without the braces). */
function splitMain(src: string): { pre: string; body: string } {
  const k = src.indexOf("void main() {");
  const end = src.lastIndexOf("}");
  if (k < 0 || end < k) throw new Error("embossMulti: main not found");
  return { pre: src.slice(0, k), body: src.slice(k + "void main() {".length, end) };
}
/** Splits a main body at its step-2 marker: step 1 (geometry, derivatives) and the rest. */
function splitStep(body: string): { a: string; b: string } {
  const k = body.indexOf("// ---- 2.");
  if (k < 0) throw new Error("embossMulti: step 2 marker not found");
  const line = body.lastIndexOf("\n", k) + 1;
  return { a: body.slice(0, line), b: body.slice(line) };
}
/** Removes a top-level function definition `… name(…) { … }` (brace matched). */
function removeFunction(src: string, signatureStart: string): string {
  const k = src.indexOf(signatureStart);
  if (k < 0) return src;
  let i = src.indexOf("{", k), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(0, k) + src.slice(i + 1);
}
const namesOf = (decl: string) => decl.split(",").map((n) => n.trim().replace(/\[.*$/, "")).filter(Boolean);

/**
 * The merged main of the multi program from the two single-element mains: the sticker main's declarations, the foil
 * main's without what the sticker main already declares (uniforms, the Gauss–Hermite constants, embKeyKernels), then
 * one main() — the foil main's step 1 (a superset of the sticker's), embSelect, and each main's remaining steps in the
 * branch of its element type. The foil's metal picks up the element tint.
 */
export function buildMultiMain(stickerMain: string, foilMain: string): string {
  const s = splitMain(stickerMain), f = splitMain(foilMain);
  const declared = new Set<string>();
  for (const m of s.pre.matchAll(UNIFORM_LINE)) for (const n of namesOf(m[4])) declared.add(n);
  let preF = f.pre.replace(UNIFORM_LINE, (line, indent: string, prec: string | undefined, type: string, decl: string) => {
    const keep = namesOf(decl).filter((n) => !declared.has(n));
    if (keep.length === namesOf(decl).length) return line;
    return keep.length ? `${indent}uniform ${prec ?? ""}${type} ${keep.join(", ")};` : "";
  });
  preF = preF.replace(/^const vec4 GH4[XW][^\n]*\n/gm, "");
  // the varyings (`in …;`) the sticker main already declares
  const ins = new Set(s.pre.split("\n").map((l) => l.trim()).filter((l) => /^(in|varying)\s/.test(l)));
  preF = preF.split("\n").filter((l) => !ins.has(l.trim())).join("\n");
  preF = removeFunction(preF, "mat2 embKeyKernels(");
  const fa = splitStep(f.body), sb = splitStep(s.body);
  const tinted = fa.b.replace("vec3 Lfoil = Lc + Lz + Lo;", "vec3 Lfoil = Lc + uElTint * (Lz + Lo);");
  if (tinted === fa.b) throw new Error("embossMulti: the foil composition line was not found");
  return `${s.pre}\n${preF}\nvoid main() {\n${fa.a}  embSelect(p0);\n  if (gElType == 1) {\n${sb.b}\n  } else {\n${tinted}\n  }\n}\n`;
}

/** The selection code, inserted before main(): `found` = the per-element names this shader declares. */
function selectionGlsl(found: readonly string[]): string {
  const load = found.map((n) => `  ${n} = ua_${n}[e];`).join("\n");
  return `
// ---- A11: the element of this pixel (materials/embossMulti.ts)
uniform int uElCount;
int gElType;
void embLoad(int e) {
${load}
  gLogoSlot = ua_uElSlot[e]; uElTint = ua_uElTint[e]; uVolAtS = ua_uVolAtS[e]; uVolAtO = ua_uVolAtO[e];
  gElType = int(ua_uElBox[e].w + 0.5);
}
void embSelect(vec2 p) {
  int pick = -1;
  float best = -1e9;
  bool inside = false;
  for (int i = EMB_MAX - 1; i >= 0; --i) {
    if (i >= uElCount) continue;
    vec4 xf = ua_uLogoXf[i], bx = ua_uElBox[i];
    vec2 d = wrapDelta(p - (0.5 * uCardSizeMm + xf.xy));
    vec2 q = abs(vec2(d.x * xf.z + d.y * xf.w, -d.x * xf.w + d.y * xf.z)) - bx.xy;
    if (max(q.x, q.y) > bx.z) continue;
    embLoad(i);
    float dd = logoFetch(p, 0.0).x;
    if (dd > 0.0) { pick = i; inside = true; break; }
    if (dd > best) { best = dd; pick = i; }
  }
  if (pick < 0) {                                                // no element in reach: bare paper
    embLoad(0);
    uLogoOn = 0; uLogoShape = 0; uRelief = vec4(0.0, uRelief.y, 0.0, uRelief.w); gElType = 0;
    return;
  }
  if (!inside) embLoad(pick);
}
`;
}

function logoSamplersGlsl(): string {
  const idx = Array.from({ length: MAX_LOGOS }, (_, k) => k);
  const chain = (call: (k: number) => string) => idx.slice(1).map((k) => `  if (gLogoSlot == ${k}) return ${call(k)};`).join("\n") + `\n  return ${call(0)};`;
  return `uniform sampler2D ${idx.map((k) => `uLogoTex${k}`).join(", ")};
uniform vec4 ua_uElBox[EMB_MAX]; uniform int ua_uElSlot[EMB_MAX]; uniform vec3 ua_uElTint[EMB_MAX];
uniform vec3 ua_uVolAtS[EMB_MAX]; uniform vec3 ua_uVolAtO[EMB_MAX];
int gLogoSlot; vec3 uElTint, uVolAtS, uVolAtO;
vec4 embLogoLod(vec2 uv, float lod) {
${chain((k) => `textureLod(uLogoTex${k}, uv, lod)`)}
}
vec4 embLogoGrad(vec2 uv, vec2 gx, vec2 gy) {
${chain((k) => `textureGrad(uLogoTex${k}, uv, gx, gy)`)}
}`;
}

/**
 * Turns an assembled single-element fragment shader (front: with the merged main; back: back.frag) into the multi
 * program: per-element uniforms become arrays + globals, the logo texture a slot chain, the subject volume an atlas
 * lookup, and the selection code is inserted before main(). The back also gets its embSelect call.
 */
export function transformMulti(src: string, kind: "front" | "back"): string {
  const found: string[] = [];
  let out = src.replace(UNIFORM_LINE, (line, indent: string, prec: string | undefined, type: string, decl: string) => {
    const names = namesOf(decl);
    if (type === "sampler2D" && names.length === 1 && names[0] === "uLogoTex") return logoSamplersGlsl();
    const moved = names.filter((n) => n in PER_ELEMENT);
    if (!moved.length) return line;
    for (const n of moved) {
      if (PER_ELEMENT[n] !== type) throw new Error(`embossMulti: ${n} is declared ${type}, expected ${PER_ELEMENT[n]}`);
      if (found.includes(n)) throw new Error(`embossMulti: ${n} is declared twice`);
      found.push(n);
    }
    const keep = names.filter((n) => !(n in PER_ELEMENT));
    return (keep.length ? `${indent}uniform ${prec ?? ""}${type} ${keep.join(", ")};\n` : "")
      + moved.map((n) => `${indent}uniform ${type} ua_${n}[EMB_MAX]; ${type} ${n};`).join("\n");
  });
  if (!found.includes("uLogoXf") || !out.includes("embLogoLod(vec2")) throw new Error("embossMulti: the emboss chunk was not found");
  out = out.split("textureLod(uLogoTex, ").join("embLogoLod(").split("textureGrad(uLogoTex, ").join("embLogoGrad(");
  if (out.includes("uLogoTex,")) throw new Error("embossMulti: an unconverted logo lookup is left");
  // the subject volume: the element's slab of the atlas, clamped as clamp-to-edge would
  const vol = "return textureLod(uVolSdf, uvw, 0.0).r;";
  if (out.includes(vol)) {
    out = out.replace(vol, "uvw = clamp(uvw, 0.5 / uVolGridN, 1.0 - 0.5 / uVolGridN);\n  return textureLod(uVolSdf, uvw * uVolAtS + uVolAtO, 0.0).r;");
  } else if (kind === "front") throw new Error("embossMulti: the volume lookup was not found");
  const k = out.lastIndexOf("void main()");
  if (k < 0) throw new Error("embossMulti: main not found");
  out = out.slice(0, k) + selectionGlsl(found) + out.slice(k);
  if (kind === "back") {
    const call = "LogoS lg = logoSample(pf, F, false);";
    if (!out.includes(call)) throw new Error("embossMulti: the back's logo sample was not found");
    out = out.replace(call, `embSelect(pf);\n    ${call}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------------------------------------------

function blank(t: GlslType): unknown {
  switch (t) {
    case "int": case "float": return 0;
    case "vec2": return new THREE.Vector2();
    case "vec3": return new THREE.Vector3();
    case "vec4": return new THREE.Vector4();
    case "mat3": return new THREE.Matrix3();
  }
}

let multi: Uniforms | null = null;

/** The multi program's uniform singletons: uElCount (0 while the single-element programs render), one array of
 *  EMB_MAX entries per per-element value (`ua_<name>`), and the logo slots' samplers (set by scene/embossAssets.ts). */
export function multiUniforms(): Uniforms {
  if (multi) return multi;
  const u: Uniforms = { uElCount: { value: 0 } };
  for (const [name, t] of Object.entries(ALL)) u[`ua_${name}`] = { value: Array.from({ length: EMB_MAX }, () => blank(t)) };
  for (let k = 0; k < MAX_LOGOS; k++) u[`uLogoTex${k}`] = { value: null };
  multi = u;
  return u;
}

/** Copies one element's values (`from`: its uniforms by single-element name, plus the PER_ELEMENT_EXTRA values) into
 *  entry `i` of the arrays. */
export function writeElement(i: number, from: Readonly<Record<string, { value: unknown } | undefined>>): void {
  const M = multiUniforms();
  for (const [name, t] of Object.entries(ALL)) {
    const src = from[name]?.value, arr = M[`ua_${name}`].value as unknown[];
    if (src === undefined || src === null) continue;
    if (t === "int" || t === "float") arr[i] = typeof src === "number" ? src : Number(src);
    else (arr[i] as { copy(v: unknown): void }).copy(src);
  }
}

/** What the multi program needs from the app for one element: its logo slot and its subject's slab of the atlas
 *  (scene/embossAssets.ts and main.ts provide them; null = not available: no logo / no volume). */
export interface MultiEnv {
  logo(url: string): { slot: number; on: number; map: THREE.Vector4 } | null;
  volume(subject: string): { grid: unknown; scale: readonly number[]; offset: readonly number[] } | null;
}
export const multiEnv: MultiEnv = { logo: () => null, volume: () => null };
