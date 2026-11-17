// A5 Volume Hologram: DialKit panel literal and parameter table (addendum A5.3). Pure module (§6.1): type-only imports,
// explicit `.ts` extensions, erasable syntax only, so `node --test` and `ui/dialConfig.ts` (checkConsistency) can import
// it without the shader sources.
//
// Panel "Volume Hologram", DialKit id `holo-mat-volume`, persist key `holo:v1:mat-volume`. Every ParamSpec.id is also the
// URL key (§6.7); `uniform` names the GLSL uniform the value drives (conversion in volume.ts `apply`), or null for
// CPU-side consumers (the subject volume loaded by scene/volumes.ts, the relief waves for waviness, orange peel and seed).
//
// Deviations from the A5.3 table (judged on renders, recorded in the addendum's implementation notes):
// - `reference` (−0.25, −0.68) instead of (−0.3, 0.55): the hologram is made for the default studio's compact spot B
//   (2.5°, lower left), so the first-load pose and the default wobble show a crisp image (window ≥ 0.4 over ±14°); the
//   studio's soft 14° × 50° panel then never replays (it would only smear a deep image), spot A adds an orange ghost.
// - `selectivity` is the Gaussian half-width σ of the replay window on the replayed direction π̂′ (H1 aperture + Bragg
//   response; 16° instead of 12°); the window concentrates the diffracted light (gain 1/(2σ²)).
// - efficiency 0.85 (photopolymer reflection holograms reach 70–90 % in their band), bandwidth 30 nm (photopolymer).
import type { DialConfig } from "dialkit/vanilla";
import type { ParamSpec } from "../types.ts";

/** `volume.type`: Denisyuk reflection hologram or embossed Benton rainbow hologram (A5.1). */
export const VOLUME_TYPES = ["reflection", "rainbow"] as const;
export type VolumeType = (typeof VOLUME_TYPES)[number];
/** `volume.subject`: the recorded object (public/holo3d/<subject>.sdf). */
export const VOLUME_SUBJECTS = ["eagle", "chip", "wolf", "globe", "skull", "falcon", "emblem"] as const;
export type VolumeSubject = (typeof VOLUME_SUBJECTS)[number];
/** `volume.backdrop`: the background layer — A5's recorded planes (none, grid, stars), then addendum A10's diffractive
 *  patterns (surface-relief line gratings, each line family with its own grating vector; `uVolBackdrop.x` = index). */
export const VOLUME_BACKDROPS = ["none", "grid", "stars", "seal", "rosette", "spiral", "lattice", "sunburst", "sparkle"] as const;
export type VolumeBackdrop = (typeof VOLUME_BACKDROPS)[number];
/** A10: `volume.recording` — an optical recording of the object (continuous parallax) or a holographic stereogram
 *  (N discrete camera views: the image steps from view to view, ghosting at the boundaries). */
export const VOLUME_RECORDINGS = ["optical", "stereogram"] as const;
export type VolumeRecording = (typeof VOLUME_RECORDINGS)[number];
/** A10: the diffractive patterns among VOLUME_BACKDROPS (index ≥ 3). */
export const VOLUME_PATTERNS: readonly VolumeBackdrop[] = ["seal", "rosette", "spiral", "lattice", "sunburst", "sparkle"];
/** A10: true when the backdrop is one of the diffractive patterns. */
export function isPatternBackdrop(b: string): boolean {
  return (VOLUME_PATTERNS as readonly string[]).includes(b);
}

/** The subject of a volume panel snapshot (`volume.subject`, default eagle). */
export function volumeSubjectOf(values: Readonly<Record<string, unknown>>): VolumeSubject {
  const v = values["volume.subject"];
  return typeof v === "string" && (VOLUME_SUBJECTS as readonly string[]).includes(v) ? (v as VolumeSubject) : "eagle";
}

/** A10: the diffractive pattern's uniform values of a `volume.*` snapshot (volume.ts `applyVolumeUniforms`):
 *  uVolPat = (radius R [mm], line width [fraction of the spacing], 1/Λ [nm⁻¹], strength),
 *  uVolPat2 = (cos θ, sin θ, plane depth [mm] ≤ 0, 0) with θ the pattern rotation. Out-of-range values are clamped. */
export function patternUniformValues(values: Readonly<Record<string, unknown>>): { pat: [number, number, number, number]; pat2: [number, number, number, number] } {
  const num = (id: string, d: number) => {
    const v = values[id];
    const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(x) ? x : d;
  };
  const cl = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
  const R = cl(num("volume.patternSize", 28), 0.5, 400);
  const w = cl(num("volume.lineWidth", 0.22), 0.01, 0.9);
  const pitch = cl(num("volume.gratingPitch", 1000), 300, 4000);
  const s = cl(num("volume.patternStrength", 1), 0, 10);
  const th = cl(num("volume.patternRotation", 0), -360, 360) * Math.PI / 180;
  const z = cl(num("volume.patternDepth", -3), -400, 0);
  return { pat: [R, w, 1 / pitch, s], pat2: [Math.cos(th), Math.sin(th), z, 0] };
}

/** A10: the stereogram uniform uVolRec = (0 optical / 1 stereogram, N views, view blend, zone half-angle [rad]). */
export function recordingUniformValues(values: Readonly<Record<string, unknown>>): [number, number, number, number] {
  const num = (id: string, d: number) => {
    const v = values[id];
    const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(x) ? x : d;
  };
  const cl = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
  const st = values["volume.recording"] === "stereogram" ? 1 : 0;
  return [st, Math.round(cl(num("volume.views", 20), 2, 256)), cl(num("volume.viewBlend", 0.25), 0, 1), cl(num("volume.viewZone", 30), 1, 80) * Math.PI / 180];
}

export const volumeDial = {
  type: {
    type: "select",
    options: [
      { value: "reflection", label: "Reflection (volume, full parallax)" },
      { value: "rainbow", label: "Rainbow (embossed, CPU-sticker style)" },
    ],
    default: "reflection",
  },
  subject: {
    type: "select",
    options: [
      { value: "eagle", label: "Eagle" },
      { value: "chip", label: "Processor chip" },
      { value: "wolf", label: "Howling wolf" },
      { value: "globe", label: "Globe with orbit ring" },
      { value: "skull", label: "Screaming skull" },
      { value: "falcon", label: "Falcon head" },
      { value: "emblem", label: "Eagle & globe emblem (SVG)" },
    ],
    default: "eagle",
  },
  image: {
    "size (mm)": [44, 10, 80, 1],
    "depth (mm)": [-8, -40, 15, 0.5],
    "yaw (°)": [0, -180, 180, 1],
    "pitch (°)": [-10, -90, 90, 1],
    "recording light": { type: "pad", x: [-0.5, -1, 1, 0.01], y: [0.5, -1, 1, 0.01], labels: { x: "Direction cosine x", y: "Direction cosine y" } },
    speckle: [0.5, 0, 1, 0.01],
    backdrop: {
      type: "select",
      options: [
        { value: "none", label: "None (dark)" }, { value: "grid", label: "Grid plane" }, { value: "stars", label: "Star field" },
        { value: "seal", label: "Guilloche seal (diffractive)" }, { value: "rosette", label: "Guilloche rosette (diffractive)" },
        { value: "spiral", label: "Spiral vortex (diffractive)" }, { value: "lattice", label: "Diamond lattice (diffractive)" },
        { value: "sunburst", label: "Sunburst (diffractive)" }, { value: "sparkle", label: "Dot-matrix glitter (diffractive)" },
      ],
      default: "grid",
    },
    "backdrop depth (mm)": [-30, -80, -5, 1],
  },
  pattern: {
    _collapsed: true,
    "size (mm)": [28, 5, 80, 0.5],
    "line width": [0.22, 0.05, 0.6, 0.01],
    "grating pitch (nm)": [1000, 600, 1600, 10],
    strength: [1, 0, 3, 0.01],
    "rotation (°)": [0, -180, 180, 1],
    "depth (mm)": [-3, -20, 0, 0.25],
  },
  replay: {
    "colour (nm)": [545, 450, 650, 1],
    "bandwidth (nm)": [30, 4, 60, 1],
    reference: { type: "pad", x: [-0.25, -1, 1, 0.01], y: [-0.68, -1, 1, 0.01], labels: { x: "Direction cosine x", y: "Direction cosine y" } },
    "selectivity (°)": [16, 2, 40, 0.5],
    "slit (°)": [6, 1, 20, 0.5],
    efficiency: [0.85, 0.05, 1, 0.01],
    recording: {
      type: "select",
      options: [{ value: "optical", label: "Optical (continuous)" }, { value: "stereogram", label: "Stereogram (N views, steps)" }],
      default: "optical",
    },
    views: [20, 6, 64, 1],
    "view blend": [0.25, 0, 1, 0.01],
    "view zone (±°)": [30, 5, 60, 1],
  },
  surface: {
    _collapsed: true,
    "waviness (°)": [0.3, 0, 1, 0.01],
    "coat roughness": [0.04, 0.01, 0.5, 0.005],
    "surface glare": [1, 0, 1, 0.01],
    "orange peel (µm)": [0.6, 0, 2, 0.05],
  },
  seed: [7, 1, 999, 1],
  reset: { type: "action", label: "Reset material" },
} satisfies DialConfig;

/** One ParamSpec per non-action control of `volumeDial` (A5.3 table). */
export const VOLUME_PARAMS: readonly ParamSpec[] = [
  { id: "volume.type", path: "type", kind: "select", default: "reflection", options: [...VOLUME_TYPES], unit: "—",
    meaning: "Reflection (Denisyuk volume hologram: full parallax, Bragg colour) or rainbow (embossed Benton: horizontal parallax, vertical colour sweep)", uniform: "uVolType" },
  { id: "volume.subject", path: "subject", kind: "select", default: "eagle", options: [...VOLUME_SUBJECTS], unit: "—",
    meaning: "Recorded object (signed-distance volume public/holo3d/<subject>.sdf)", uniform: null },
  { id: "volume.size", path: "image.size (mm)", kind: "slider", default: 44, min: 10, max: 80, step: 1, unit: "mm",
    meaning: "Size of the recorded object (its longest dimension)", uniform: "uVolPose" },
  { id: "volume.depth", path: "image.depth (mm)", kind: "slider", default: -8, min: -40, max: 15, step: 0.5, unit: "mm",
    meaning: "Depth of the object centre (negative = behind the surface; parts may come forward)", uniform: "uVolPose" },
  { id: "volume.yaw", path: "image.yaw (°)", kind: "slider", default: 0, min: -180, max: 180, step: 1, unit: "°",
    meaning: "Recorded pose: turn about the vertical axis", uniform: "uVolRot" },
  { id: "volume.pitch", path: "image.pitch (°)", kind: "slider", default: -10, min: -90, max: 90, step: 1, unit: "°",
    meaning: "Recorded pose: tip about the horizontal axis (positive: top toward the viewer)", uniform: "uVolRot" },
  { id: "volume.recLight", path: "image.recording light", kind: "pad", default: { x: -0.5, y: 0.5 }, min: -1, max: 1, step: 0.01, unit: "—",
    meaning: "Direction of the recording light (baked shading), direction cosines in the sticker frame", uniform: "uVolRecLight" },
  { id: "volume.speckle", path: "image.speckle", kind: "slider", default: 0.5, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Contrast of the recorded laser speckle", uniform: "uVolSpeckle" },
  { id: "volume.backdrop", path: "image.backdrop", kind: "select", default: "grid", options: [...VOLUME_BACKDROPS], unit: "—",
    meaning: "Background layer: a deep plane recorded behind the object (grid, stars) or a diffractive surface-relief pattern around it (seal … sparkle: each line family is a grating with its own direction, so it flashes its own rainbow colour as the card tilts)", uniform: "uVolBackdrop" },
  { id: "volume.backdropDepth", path: "image.backdrop depth (mm)", kind: "slider", default: -30, min: -80, max: -5, step: 1, unit: "mm",
    meaning: "Depth of the recorded background layer (grid, stars)", uniform: "uVolBackdrop" },
  { id: "volume.patternSize", path: "pattern.size (mm)", kind: "slider", default: 28, min: 5, max: 80, step: 0.5, unit: "mm",
    meaning: "Diffractive pattern: radius of the seal / scale of the pattern, centred on the hologram", uniform: "uVolPat" },
  { id: "volume.lineWidth", path: "pattern.line width", kind: "slider", default: 0.22, min: 0.05, max: 0.6, step: 0.01, unit: "—",
    meaning: "Diffractive pattern: line width as a fraction of the line spacing (lines finer than ≈ 2 px fade to their mean coverage)", uniform: "uVolPat" },
  { id: "volume.gratingPitch", path: "pattern.grating pitch (nm)", kind: "slider", default: 1000, min: 600, max: 1600, step: 10, unit: "nm",
    meaning: "Diffractive pattern: period of the relief grating inside the lines (λ = Λ·|(ℓ̂ + v̂)ₜ·ĝ| in the first order: finer → the colours need steeper light)", uniform: "uVolPat" },
  { id: "volume.patternStrength", path: "pattern.strength", kind: "slider", default: 1, min: 0, max: 3, step: 0.01, unit: "—",
    meaning: "Diffractive pattern: brightness (grating coverage × efficiency gain; 1 = metallised lines at full first-order efficiency)", uniform: "uVolPat" },
  { id: "volume.patternRotation", path: "pattern.rotation (°)", kind: "slider", default: 0, min: -180, max: 180, step: 1, unit: "°",
    meaning: "Diffractive pattern: rotation about the hologram centre", uniform: "uVolPat2" },
  { id: "volume.patternDepth", path: "pattern.depth (mm)", kind: "slider", default: -3, min: -20, max: 0, step: 0.25, unit: "mm",
    meaning: "Diffractive pattern: depth of its plane behind the surface (0 = on the film; shallow, as on real 2D/3D labels)", uniform: "uVolPat2" },
  { id: "volume.colour", path: "replay.colour (nm)", kind: "slider", default: 545, min: 450, max: 650, step: 1, unit: "nm",
    meaning: "Replay wavelength at the reference geometry (reflection: Bragg colour, shrinkage included; rainbow: the straight-on colour)", uniform: "uVolLambda" },
  { id: "volume.bandwidth", path: "replay.bandwidth (nm)", kind: "slider", default: 30, min: 4, max: 60, step: 1, unit: "nm",
    meaning: "Reflection: Bragg bandwidth (FWHM; thicker emulsion → narrower)", uniform: "uVolLambda" },
  { id: "volume.reference", path: "replay.reference", kind: "pad", default: { x: -0.25, y: -0.68 }, min: -1, max: 1, step: 0.01, unit: "—",
    meaning: "Reference (replay) beam direction cosines in the sticker frame: where the light must be for the undistorted image", uniform: "uVolRef" },
  { id: "volume.selectivity", path: "replay.selectivity (°)", kind: "slider", default: 16, min: 2, max: 40, step: 0.5, unit: "°",
    meaning: "Reflection: half-width σ of the replay window on the replayed direction (the image fades as the light leaves the reference or the eye the viewing zone)", uniform: "uVolSel" },
  { id: "volume.slit", path: "replay.slit (°)", kind: "slider", default: 6, min: 1, max: 20, step: 0.5, unit: "°",
    meaning: "Rainbow: vertical slit width (colour purity vs vertical viewing zone)", uniform: "uVolSel" },
  { id: "volume.efficiency", path: "replay.efficiency", kind: "slider", default: 0.85, min: 0.05, max: 1, step: 0.01, unit: "—",
    meaning: "Diffraction efficiency", uniform: "uVolEff" },
  { id: "volume.recording", path: "replay.recording", kind: "select", default: "optical", options: [...VOLUME_RECORDINGS], unit: "—",
    meaning: "Optical recording of the object (continuous parallax) or a holographic stereogram made from N camera views (the 3D image steps from view to view as you move, with a brief double image at the boundaries; diffractive patterns stay continuous)", uniform: "uVolRec" },
  { id: "volume.views", path: "replay.views", kind: "slider", default: 20, min: 6, max: 64, step: 1, unit: "—",
    meaning: "Stereogram: number of recorded views across the viewing zone (per axis; rainbow: horizontal only)", uniform: "uVolRec" },
  { id: "volume.viewBlend", path: "replay.view blend", kind: "slider", default: 0.25, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "Stereogram: width of the cross-fade at a view boundary as a fraction of the view spacing (0 = hard cuts; higher = a longer ghosted double image)", uniform: "uVolRec" },
  { id: "volume.viewZone", path: "replay.view zone (±°)", kind: "slider", default: 30, min: 5, max: 60, step: 1, unit: "°",
    meaning: "Stereogram: half-angle of the zone the views span (beyond it the edge view stays)", uniform: "uVolRec" },
  { id: "volume.waviness", path: "surface.waviness (°)", kind: "slider", default: 0.3, min: 0, max: 1, step: 0.01, unit: "°",
    meaning: "RMS slope of 8–40 mm film waviness", uniform: null },
  { id: "volume.coatAlpha", path: "surface.coat roughness", kind: "slider", default: 0.04, min: 0.01, max: 0.5, step: 0.005, unit: "GGX α",
    meaning: "Roughness of the glossy top film", uniform: "uCoatAlpha" },
  { id: "volume.glare", path: "surface.surface glare", kind: "slider", default: 1, min: 0, max: 1, step: 0.01, unit: "—",
    meaning: "How strongly the surface mirrors the lights: 1 = the physical mirror (rainbow: bare aluminium; both: the cover film's full highlight), lower = the embossed film's zero order is weaker and hazier, the cover film's glint smaller, and the highlight is soft-limited so the image and the pattern stay visible under it", uniform: "uVolGlare" },
  { id: "volume.orangePeel", path: "surface.orange peel (µm)", kind: "slider", default: 0.6, min: 0, max: 2, step: 0.05, unit: "µm",
    meaning: "RMS height of 0.5–5 mm top-film undulation", uniform: null },
  { id: "volume.seed", path: "seed", kind: "slider", default: 7, min: 1, max: 999, step: 1, unit: "—",
    meaning: "Random seed (speckle pattern, wave phases)", uniform: null },
];
