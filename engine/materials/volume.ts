// A5 Volume Hologram (addendum A5): a recorded 3D object floating inside the sticker, replayed as a light field. Two
// physically distinct types (`volume.type`): a Denisyuk volume reflection hologram (full parallax, monochrome Bragg colour
// that shifts with the geometry, bright only near the reference/replay geometry, black backing) and an embossed Benton
// rainbow hologram (horizontal parallax only, the vertical tilt sweeps the colour, silver mirror background).
//
// MaterialDef (§6.3): dial literal and ParamSpecs from volume.params.ts; this module adds the shader sources, the CPU
// conversions of the A5.3 parameters and the binding of the subject's signed-distance volume (scene/volumes.ts loads
// it lazily while the material is active; `bindVolumeGrid` puts its texture and grid into the uniforms, then `apply`
// recomputes the pose with the subject's base pose). CPU twin of the replay optics: physics/volume.ts.
import * as THREE from "three";
import type { GratingSummary, MaterialDef, ParamValues, ReliefInputs, TierConfig, TintInputs, Uniforms, Vec2 } from "../types.ts";
import fragmentMain from "../shaders/holo_volume.frag?raw";
import volumeGlsl from "../shaders/volume.glsl?raw";
import { VOLUME_BACKDROPS, VOLUME_PARAMS, VOLUME_TYPES, patternUniformValues, recordingUniformValues, volumeDial } from "./volume.params.ts";
import { DEG, numParam, selectParam, setUniform } from "./build.ts";
import { padDirection, volumeRotation } from "../physics/volume.ts";

const CLEAR_TINT: TintInputs = { type: "clear", edgeNm: 550, widthNm: 50, floor: 1 };
const DEFAULTS: ParamValues = Object.fromEntries(VOLUME_PARAMS.map((p) => [p.id, p.default]));
const FWHM = 2 * Math.sqrt(2 * Math.LN2);

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const seedOf = (v: ParamValues) => Math.max(Math.round(numParam(v, "volume.seed", 7)), 0);

function padOf(v: ParamValues, id: string, d: Vec2): Vec2 {
  const c = v[id];
  const ok = typeof c === "object" && c !== null && "x" in c && "y" in c;
  const x = ok ? Number((c as Vec2).x) : d.x, y = ok ? Number((c as Vec2).y) : d.y;
  return { x: Number.isFinite(x) ? clamp(x, -1, 1) : d.x, y: Number.isFinite(y) ? clamp(y, -1, 1) : d.y };
}

/** The grid of a loaded subject volume (scene/volumes.ts). */
export interface VolumeGrid {
  texture: THREE.Data3DTexture;
  n: [number, number, number];
  bmin: [number, number, number];
  h: number;
  basePitchDeg: number;
  baseYawDeg: number;
}

let placeholder: THREE.Data3DTexture | null = null;
/** 2 × 2 × 2 R16F volume of +1 (empty space), bound while no subject is loaded (uVolLoaded 0 never traces it). */
function placeholderVolume(): THREE.Data3DTexture {
  if (placeholder) return placeholder;
  const t = new THREE.Data3DTexture(new Uint16Array(8).fill(0x3c00), 2, 2, 2);
  t.format = THREE.RedFormat;
  t.type = THREE.HalfFloatType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.name = "volume-placeholder";
  t.needsUpdate = true;
  placeholder = t;
  return t;
}

/** Binds a subject volume (or none) to a volume material's uniforms; call `volume.apply` afterwards (base pose). */
export function bindVolumeGrid(u: Uniforms, g: VolumeGrid | null): void {
  setUniform(u, "uVolSdf", g ? g.texture : placeholderVolume());
  const set3 = (name: string, a: readonly number[]) => {
    const x = u[name]?.value;
    if (x instanceof THREE.Vector3) x.set(a[0], a[1], a[2]); else setUniform(u, name, new THREE.Vector3(a[0], a[1], a[2]));
  };
  set3("uVolGridN", g ? g.n : [2, 2, 2]);
  set3("uVolGridMin", g ? g.bmin : [-0.5, -0.5, -0.5]);
  setUniform(u, "uVolGridH", g ? g.h : 1);
  setUniform(u, "uVolLoaded", g ? 1 : 0);
  const base = u.uVolBase?.value;                                   // CPU-only (not in the program)
  if (base instanceof THREE.Vector2) base.set(g ? g.basePitchDeg : 0, g ? g.baseYawDeg : 0);
  else setUniform(u, "uVolBase", new THREE.Vector2(g ? g.basePitchDeg : 0, g ? g.baseYawDeg : 0));
}

/** The A5.3 conversions of a `volume.*` snapshot into the hologram uniforms (uVolType … uVolBackdrop, uSigS, uCoatAlpha).
 *  Also the A9 sticker's (materials/emboss.ts maps its `emboss.holo.*` values onto `volume.*` ids first), so later A5
 *  changes reach the sticker. */
export function applyVolumeUniforms(values: ParamValues, u: Uniforms): void {
  const type = selectParam(values, "volume.type", VOLUME_TYPES, "reflection");
  setUniform(u, "uVolType", type === "rainbow" ? 1 : 0);
  const lamR = clamp(numParam(values, "volume.colour", 545), 380, 780);
  const bw = clamp(numParam(values, "volume.bandwidth", 30), 1, 200);
  const lam = u.uVolLambda?.value;
  if (lam instanceof THREE.Vector4) lam.set(lamR, bw / FWHM, 0, 0); else setUniform(u, "uVolLambda", new THREE.Vector4(lamR, bw / FWHM, 0, 0));
  const ref = padOf(values, "volume.reference", { x: -0.25, y: -0.68 });
  const rd = padDirection(ref.x, ref.y);
  const rv = u.uVolRef?.value;
  if (rv instanceof THREE.Vector3) rv.set(rd[0], rd[1], rd[2]); else setUniform(u, "uVolRef", new THREE.Vector3(rd[0], rd[1], rd[2]));
  const sel = clamp(numParam(values, "volume.selectivity", 16), 0.5, 60) * DEG;
  const slit = clamp(numParam(values, "volume.slit", 6), 0.2, 40) * DEG / FWHM;      // full width → σ
  const sv = u.uVolSel?.value;
  if (sv instanceof THREE.Vector2) sv.set(sel, slit); else setUniform(u, "uVolSel", new THREE.Vector2(sel, slit));
  setUniform(u, "uVolEff", clamp(numParam(values, "volume.efficiency", 0.85), 0, 1));
  setUniform(u, "uSigS", 0.3 * DEG);                                // embossed foil micro-slope (rainbow mirror)
  setUniform(u, "uCoatAlpha", clamp(numParam(values, "volume.coatAlpha", 0.04), 1e-3, 1));
  setUniform(u, "uVolGlare", clamp(numParam(values, "volume.glare", 1), 0, 1));       // A12 surface glare (1 = physical)

  // pose: R = R_y(yaw)·R_x(pitch) (subject base pose + panel), the box → object rotation is Rᵀ
  const base = u.uVolBase?.value instanceof THREE.Vector2 ? (u.uVolBase.value as THREE.Vector2) : new THREE.Vector2(0, 0);
  const yaw = clamp(numParam(values, "volume.yaw", 0), -360, 360) + base.y;
  const pitch = clamp(numParam(values, "volume.pitch", -10), -180, 180) + base.x;
  const R = volumeRotation(yaw, pitch);
  const rotT = u.uVolRotT?.value;
  // THREE.Matrix3.set takes row-major arguments: the transpose of R row-major is R's columns as rows
  const m = rotT instanceof THREE.Matrix3 ? rotT : new THREE.Matrix3();
  m.set(R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]);
  if (!(rotT instanceof THREE.Matrix3)) setUniform(u, "uVolRotT", m);
  const size = clamp(numParam(values, "volume.size", 44), 1, 400), depth = clamp(numParam(values, "volume.depth", -8), -200, 100);
  const pose = u.uVolPose?.value;
  if (pose instanceof THREE.Vector4) pose.set(0, 0, depth, size); else setUniform(u, "uVolPose", new THREE.Vector4(0, 0, depth, size));
  // recording light: sticker-frame direction → object space (Rᵀ·l)
  const rl = padOf(values, "volume.recLight", { x: -0.5, y: 0.5 });
  const ld = padDirection(rl.x, rl.y);
  const lo = new THREE.Vector3(ld[0], ld[1], ld[2]).applyMatrix3(m).normalize();
  const lv = u.uVolRecLight?.value;
  if (lv instanceof THREE.Vector3) lv.copy(lo); else setUniform(u, "uVolRecLight", lo);
  setUniform(u, "uVolSpeckle", clamp(numParam(values, "volume.speckle", 0.5), 0, 1));
  setUniform(u, "uVolSeed", seedOf(values));
  const bd = VOLUME_BACKDROPS.indexOf(selectParam(values, "volume.backdrop", VOLUME_BACKDROPS, "grid"));
  const bz = clamp(numParam(values, "volume.backdropDepth", -30), -400, -0.5);
  const bv = u.uVolBackdrop?.value;
  if (bv instanceof THREE.Vector2) bv.set(bd, bz); else setUniform(u, "uVolBackdrop", new THREE.Vector2(bd, bz));
  // A10 diffractive pattern (used while the backdrop is one of VOLUME_PATTERNS)
  const pv = patternUniformValues(values);
  const set4 = (name: string, a: readonly number[]) => {
    const x = u[name]?.value;
    if (x instanceof THREE.Vector4) x.set(a[0], a[1], a[2], a[3]); else setUniform(u, name, new THREE.Vector4(a[0], a[1], a[2], a[3]));
  };
  set4("uVolPat", pv.pat);
  set4("uVolPat2", pv.pat2);
  set4("uVolRec", recordingUniformValues(values));                  // A10 stereogram (optical: x = 0)
}

/** A10: the tier defines of the diffractive pattern (volume.glsl): VOL_PAT_SLOTS grating slots evaluated per light. */
export function volumePatternDefines(tier: TierConfig): Record<string, number> {
  return { VOL_PAT_SLOTS: tier.tier === "high" ? 3 : 2 };
}

/** The subject of a volume panel snapshot (scene/volumes.ts loads `public/holo3d/<subject>.sdf`). */
export { volumeSubjectOf } from "./volume.params.ts";

/** Fresh hologram uniforms (the A5 material's, also the A9 sticker's in the emboss material) with the empty volume
 *  bound; `applyVolumeUniforms` sets their values. */
export function createVolumeUniforms(): Uniforms {
  const u: Uniforms = {
    uVolType: { value: 0 }, uVolLambda: { value: new THREE.Vector4(545, 30 / FWHM, 0, 0) },
    uVolRef: { value: new THREE.Vector3(0, 0, 1) }, uVolSel: { value: new THREE.Vector2(16 * DEG, 6 * DEG / FWHM) },
    uVolEff: { value: 0.85 }, uSigS: { value: 0.3 * DEG }, uCoatAlpha: { value: 0.04 },
    uVolRotT: { value: new THREE.Matrix3() }, uVolPose: { value: new THREE.Vector4(0, 0, -8, 44) },
    uVolRecLight: { value: new THREE.Vector3(0, 0, 1) }, uVolSpeckle: { value: 0.5 }, uVolSeed: { value: 7 },
    uVolBackdrop: { value: new THREE.Vector2(1, -30) }, uVolBase: { value: new THREE.Vector2(0, 0) },
    uVolPat: { value: new THREE.Vector4(28, 0.22, 1e-3, 1) }, uVolPat2: { value: new THREE.Vector4(1, 0, -3, 0) },
    uVolRec: { value: new THREE.Vector4(0, 20, 0.25, 30 * DEG) }, uVolGlare: { value: 1 },
  };
  bindVolumeGrid(u, null);
  return u;
}

export const volume: MaterialDef = {
  id: "volume",
  name: "Volume Hologram",
  analog: "3D image hologram sticker (Denisyuk reflection hologram; embossed rainbow CPU / software authenticity label)",
  caption: "reflection / rainbow hologram · 3D image · 545 nm",
  valueLabel: "3D · 545 nm",
  dial: volumeDial,
  params: VOLUME_PARAMS,
  fragmentMain,
  extraChunks: [volumeGlsl],

  createUniforms(): Uniforms {
    const u = createVolumeUniforms();
    applyVolumeUniforms(DEFAULTS, u);
    return u;
  },

  apply: applyVolumeUniforms,

  // A10: the diffractive pattern's grating slots per light (high: two crossing families + the concentric layer; lower
  // tiers merge the crossing families into the dominant one)
  defines(tier: TierConfig): Record<string, string | number> {
    return volumePatternDefines(tier);
  },

  // No surface grating: one dummy family of depth 0 (etaN ≡ 1) and a clear tint, so the shared tables carry S·R_Al·CMF
  // (the rainbow foil's aluminium; the reflection type divides R_Al out).
  gratingSummary(): GratingSummary {
    return { pitchesNm: [1000], depthNm: 0, nc: 1.5, gAzimuthRad: null, recycle: false, tint: { ...CLEAR_TINT } };
  },

  relief(values: ParamValues): ReliefInputs {
    return {
      seed: seedOf(values),
      wavinessDeg: Math.max(numParam(values, "volume.waviness", 0.3), 0),
      orangePeelUm: Math.max(numParam(values, "volume.orangePeel", 0.6), 0),
    };
  },

  wobbleAxisDeg(): number | null {
    return null;
  },
};
