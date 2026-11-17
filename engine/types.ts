// Shared contracts. Pure module: type-only imports, no runtime dependencies beyond the constant arrays.
import type { DialConfig } from "dialkit/vanilla";
import type { IUniform } from "three";

export type MaterialId = "prism" | "shatter" | "nebula" | "sparkle" | "vortex" | "volume" | "emboss";   // + addendum A2, A5 (Oil Slick removed), A6
export const MATERIAL_IDS: readonly MaterialId[] = ["prism", "shatter", "nebula", "sparkle", "vortex", "volume", "emboss"];
export type Tier = "low" | "medium" | "high";
/** The page: black, white or a chosen colour (`scene.bgColor`); the §5.2 lighting adaptation follows its lightness. */
export type Background = "black" | "white" | "colour";
export type PrintMode = "art" | "window" | "frame" | "none";
export type PointerMode = "tilt" | "light" | "flash";
export type ToneCurve = "neutral" | "agx" | "clamp";
export type SpdId = "equal" | "daylight" | "tungsten" | "led" | "triphosphor";
export const SPD_IDS: readonly SpdId[] = ["equal", "daylight", "tungsten", "led", "triphosphor"]; // = texture layer order
export type TintType = "clear" | "longpass" | "shortpass";
export type DebugView = "off" | "normal" | "q" | "lambda" | "regime" | "nfp" | "print" | "coat" | "foil"
  | "zeroth" | "orders" | "shard" | "sigma" | "reference" | "furnace" | "dof";
// index = DEBUG_VIEW define; addendum A7 `dof` (signed CoC) is a pipeline view: the materials render with DEBUG_VIEW 0
export const DEBUG_VIEWS: readonly DebugView[] = ["off", "normal", "q", "lambda", "regime", "nfp", "print", "coat",
  "foil", "zeroth", "orders", "shard", "sigma", "reference", "furnace", "dof"];
export const RAW_DEBUG_VIEWS: readonly DebugView[] = ["normal", "q", "lambda", "regime", "nfp", "print", "shard", "sigma"];

export interface Vec2 { x: number; y: number }
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]; // row-major
export interface Quat { x: number; y: number; z: number; w: number }

export interface SpringValue { type: "spring"; stiffness?: number; damping?: number; mass?: number; visualDuration?: number; bounce?: number }
export interface EasingValue { type: "easing"; duration: number; ease: [number, number, number, number] }
export type ParamValue = number | boolean | string | Vec2 | SpringValue | EasingValue;
export type ParamKind = "slider" | "toggle" | "select" | "color" | "pad" | "spring" | "image" | "text";   // text: addendum A11 (the paper card's document, never shown as a control)

export interface ParamSpec {
  id: string;                  // stable id and URL key, e.g. "prism.pitch"
  path: string;                // DialKit dot path, e.g. "grating.pitch (nm)"
  kind: ParamKind;
  default: ParamValue;
  min?: number; max?: number; step?: number;     // sliders; pads: applied to both axes
  options?: readonly string[]; // select values
  unit: string;                // "nm", "°", "µm", "mm", "%", "—"
  meaning: string;
  uniform: string | null;      // GLSL uniform driven, or null for CPU-side consumers ("tables", waves, …)
}

export type Uniforms = Record<string, IUniform>;
export type ParamValues = Readonly<Record<string, ParamValue>>;   // keyed by ParamSpec.id

export interface TintInputs { type: TintType; edgeNm: number; widthNm: number; floor: number }
export interface GratingSummary {   // for CPU etaNorm, the material spectral tables and the reference evaluator
  pitchesNm: readonly number[];     // 1 family (M1) or 3 (M2 A/B/C; M3 min / mid / max, mid = harmonic mean)
  depthNm: number;
  nc: number;
  gAzimuthRad: number | null;       // grating-vector azimuth at the centre (M1 linear); null = ĝ ∥ q and orientation means
  recycle: boolean;                 // TIR and internal-Fresnel recycling (false for M3 flakes)
  tint: TintInputs;                 // ρ_M = R_Al·T² (§4.2.3) and the etaNorm round trip (§4.4.1)
  depthsNm?: readonly number[];     // A2.3.1: per-family relief depth, same order as pitchesNm; default depthNm for every family
}
export interface ReliefInputs { seed: number; wavinessDeg: number; orangePeelUm: number }

export interface LightValues { on: boolean; dir: Vec2; radiance: number; distanceM: number; spd: SpdId }
export interface StudioValues {
  panel: LightValues & { widthDeg: number; lengthDeg: number };
  spotA: LightValues & { sizeDeg: number };
  spotB: LightValues & { sizeDeg: number };
  spotC: LightValues & { sizeDeg: number };
  ambient: { rims: number; fill: number; scrim: number; cameraSide: number; cameraTexture: number; backdrop: number; rotationDeg: number };
  flash: { sizeMm: number; distanceM: number; radiance: number; spd: SpdId };
}
export interface LightSet {          // CPU light geometry for one frame (§4.3.1)
  type: Int32Array;                  // [4] 0 off, 1 sphere, 2 rect
  pos: Float32Array;                 // [4·3] centres, world m
  u: Float32Array; w: Float32Array;  // [4·3] rect half-axes (radial, tangential), world m
  radius: Float32Array;              // [4] sphere radius, m
  rad: Float32Array;                 // [4] radiance
  spd: Int32Array;                   // [4] SPD layer
  rgb: Float32Array;                 // [4·3] SPD colour, luminance 1
  key: number;                       // key-light slot (largest irradiance at the centre) or −1
  order: Int32Array;                 // [4] slots by hardness (spheres first, then radiance), −1 padded
}
export interface MotionSettings {
  pointer: PointerMode; tiltRangeDeg: number; spring: SpringValue | EasingValue;
  pose: Vec2;                        // x = ry, y = rx [deg] (URL key `tilt`)
  hold: boolean; wobble: boolean; wobbleAmpDeg: number; gyro: boolean; gyroGain: number;
  micro?: boolean;                   // idle micro-motion (default on; off with the top-level "auto-move & snap")
  wobbleAxisDeg: number | null;      // from the active MaterialDef
}
export interface FrameInputs {
  timeS: number; dtS: number;
  cardRot: Mat3; prevCardRot: Mat3;
  modelMatrix: readonly number[]; prevModelMatrix: readonly number[];   // 16 each, column-major
  lights: LightSet; prevLightPos: Float32Array;                         // [4·3]
  eta: { ord: Float32Array; mir: Float32Array; env: Float32Array };     // [12·4], [4·4], [4] (§4.4.1)
  viewScale: Vec2;                                                      // sub-viewport scale (§5.5)
}

export interface TierDefines {
  RECT_EXACT: 0 | 1; RECT_LTC: 0 | 1; NB: 0 | 6 | 8; IBL_ORDERS: 0 | 1;
  DISCRETE_LIGHTS: 2 | 4; DISCRETE_LIGHTS_B: 1 | 2; FLAKE_ENV: 0 | 1; WEAR_CELLS: 2 | 3;
}
export interface TierTrips {         // loop trip counts, uploaded as int uniforms (§6.1)
  maxOrder: 2 | 3; ghB: 2 | 4; vorR: 1 | 2; flakeR: 0 | 1; bCells: 2 | 3; bBins: number; bLevels: 1 | 2;
  volSteps: number; volLights: number; volShadow: number;   // A5 Volume Hologram: sphere-tracing steps, lights traced, shadow steps
}
/** Addendum A7 depth of field per tier (render/tier.ts): the CoC radius clamp [device px of the tier's target], the
 *  gather's aperture samples per field (half resolution; the near and far loops use the same pattern) and the
 *  highlight (bokeh sprite) threshold in display-white units after exposure. */
export interface TierDof { maxRadiusPx: number; samples: number; spriteThreshold: number }
export interface TierConfig {
  tier: Tier; dprCap: number; maxRtPixels: number; msaa: 0 | 4; msaaMaxMB: number;   // low: MSAA only if the §5.5 total ≤ msaaMaxMB
  pmremSize: 256 | 512; glareLevels: number; glareStartDiv: 2 | 4; waves: { board: number; coat: number };
  defines: TierDefines; trips: TierTrips;
  dof: TierDof;
}

export interface MaterialDef {
  id: MaterialId;
  name: string;                     // "Prism Rainbow"
  analog: string;                   // one line, §3
  caption: string;                  // "smooth silver rainbow foil · 1000 l/mm"
  dial: DialConfig;                 // literal from §3, imported from <id>.params.ts
  params: readonly ParamSpec[];     // one per non-action control of `dial`, from <id>.params.ts
  fragmentMain: string;             // ?raw source of holo_<id>.frag
  extraChunks: readonly string[];   // e.g. [glitterGlsl] for nebula
  createUniforms(): Uniforms;       // fresh material uniforms with default values
  apply(values: ParamValues, u: Uniforms): void;
  /** Material-specific defines; `variant` (A9) is `variant(values)` of the program being built ("" without variants). */
  defines(tier: TierConfig, variant?: string): Record<string, string | number>;
  gratingSummary(values: ParamValues): GratingSummary;
  relief(values: ParamValues): ReliefInputs;
  wobbleAxisDeg(values: ParamValues): number | null;            // M1 linear pattern: groove angle; otherwise null
  valueLabel?: string;              // A2.3.1: print-text value (title band, right); default: the caption's "… l/mm" segment, else the pitches
  /** A6 (A9: a list): selects whose choice writes a preset of other values of this panel (`id` = the select's
   *  ParamSpec id; the values per option, keyed by ParamSpec id), applied as `studio.preset` is for the scene panel.
   *  `userOnly` (A9): only a choice in the panel writes it — never URL values (a URL never writes it, nor a view). */
  presets?: readonly MaterialPreset[];
  /** A9: program variants chosen by the panel values (part of the program key; "" = the default program). `variants`
   *  lists them (background compilation); `variant(values)` names the one the values need. */
  variants?: readonly string[];
  variant?(values: ParamValues): string;
  /** A11: rewrites the assembled fragment shader of a variant (the paper card's multi-element program). */
  transformFragment?(src: string, variant: string): string;
  /** A11: likewise the card back's fragment shader while this material's `variant` is shown. */
  cardTransform?(src: string, variant: string): string;
  /** A9: extra defines of the card back and edge programs while this material's `variant` is shown. */
  cardDefines?(variant: string): Record<string, string | number>;
  /** A9: the caption line for these values (default `caption`). */
  captionOf?(values: ParamValues): string;
}
export interface MaterialPreset {
  id: string;
  values: Readonly<Record<string, Readonly<Record<string, ParamValue>>>>;
  userOnly?: boolean;
}

export interface HoloInfo {
  version: string; material: MaterialId; tier: Tier; dpr: number; msaa: number; rtPixels: number; gpuMB: number;
  renderer: string; p3: boolean; compileMs: Partial<Record<MaterialId, number>>; frameMs: number; cardMs: number | null;
  ephemeral: boolean; state: Record<string, string>;
  /** Addendum A7: the depth of field of the last frame (render/dof.ts DofInfo). */
  dof?: Record<string, unknown>;
  /** Render on demand (app/frameGate.ts): animation frames drawn and skipped since the start, the GPU time of the
   *  post passes, and the resolution used in motion (quality auto: the runtime adaptation's; `dpr` is the shown one). */
  drawn?: number; skipped?: number; postMs?: number | null; motionDpr?: number;
  /** Work that needs every frame is pending (compiles, loads, read-backs, a drag); busyWhy: which parts. */
  busy?: boolean;
  busyWhy?: string[];
}
export interface HoloApi {
  ready: boolean;                   // existing harness contract
  frames: number;
  errors: string[];
  info: HoloInfo | null;
  sample(points: ReadonlyArray<readonly [number, number]>): Promise<number[][]>;     // CSS px → RGBA 0–255 of the canvas
  sampleHdr(points: ReadonlyArray<readonly [number, number]>): Promise<number[][]>;  // CSS px → RGBA scene-linear (uncompressed, unpremultiplied; a = coverage)
  screenOf(mm: readonly [number, number]): [number, number] | null;                 // front-face card mm → CSS px (null if not visible)
  cardPointAt(x: number, y: number): { face: "front" | "back" | "edge"; mm: [number, number] } | null;
  // card-only (addendum A1.1 item 6): screenOf, cardPointAt and reference return null while another object is shown
  reference(mm: readonly [number, number], light: number): { q: [number, number]; ci: number; co: number; lambda1: number | null } | null;
  setState(params: Record<string, string>): Promise<void>;  // same keys and formats as the URL; resolves after the next rendered frame
}
declare global { interface Window { __holo?: HoloApi } }
