// Thin-lens depth of field (addendum A7.2, A7.3): the CPU twin of the DoF shaders (render/dof.ts, shaders/dof_*).
// Pure module (§6.1): no three, no DOM, erasable syntax only, so `node --test` (tests/dof.test.ts) and tools/check.mjs
// import it.
//
// Camera model. three's PerspectiveCamera with a vertical fov is treated as a lens on a virtual full-frame sensor of
// 36 × 24 mm: f = 12 mm / tan(fov/2) (61.73 mm at 22°). The `lens` control sets fov = 2·atan(12 / f); at its default
// (62 mm) the fov is exactly today's 22° (A7.2), so the default renders are bit-identical.
//
// Circle of confusion. A point at camera-space depth z (along the view axis) with the lens focused at z_f images to a
// blur disc of signed diameter c(z) = A·f·(z − z_f) / (z·(z_f − f)) on the sensor, A = f/N the entrance pupil:
// negative in front of the focus plane (near field), positive behind it (far field), monotone in z. In pixels
// c_px = c / 24 mm × the viewport height in device px; the shaders work with the radius c_px / 2, clamped to the
// tier's maximum radius (TierConfig.dof.maxRadiusPx).
//
// Aperture. The stop is a regular polygon of `blades` curved blades inscribed in the unit circle (the CoC circle):
// blade k is an arc of radius R_b = 1/curvature through two neighbouring vertices (curvature 0 = straight edges,
// 1 = the circle itself), so the aperture is the intersection of n discs. Optical vignetting (cat's eye) clips it
// with the projected rims of the front and rear lens barrels: two unit circles offset by ±b along the radial direction
// of the image point, |b| growing linearly with the field radius — a lemon (vesica) whose long axis is tangential.
// Shapes are compared through their gauge (Minkowski functional) g(d): d lies inside the scaled aperture r·K exactly
// when g(d) ≤ r, and g is positively homogeneous, so one evaluation serves every CoC radius and every colour channel.
//
// Spherical aberration (bokeh rim). The intensity across a bokeh disc is I(t), t = g/r ∈ [0, 1], with mean 1 over the
// disc (∫₀¹ I(t)·2t dt = 1: energy is conserved whatever the profile). An under-corrected lens (rim > 0) has bright
// rims on background bokeh and soft edges on foreground bokeh; the sign flips between the fields.
//
// Longitudinal chromatic aberration (bokeh fringing). R and B focus a distance Δ behind G (the secondary spectrum of an
// achromat): per-channel focus distances z_f + Δ. To first order that shifts the signed CoC of R and B by a constant
// −ε (sensor mm, ε = A·f·Δ / (z_f·(z_f + Δ − f)), nearly independent of depth), so foreground bokeh get magenta rims and
// background bokeh green rims. The shift fades out within 2 px of focus so in-focus pixels stay neutral (A7.3).

/** Virtual sensor (full frame) [mm]. */
export const SENSOR_WIDTH_MM = 36;
export const SENSOR_HEIGHT_MM = 24;
/** The scene camera's vertical fov at the default lens (= scene/camera.ts CAMERA_FOV_DEG). */
export const DEFAULT_FOV_DEG = 22;
/** Default of `dof.lens` [mm]: reproduces the 22° camera exactly (`lensFovDeg`). */
export const DEFAULT_LENS_MM = 62;
/** Range of `dof.lens` [mm]. */
export const LENS_RANGE_MM = { min: 24, max: 200 } as const;
/** Image-side focal shift of R and B behind G at `dof.loca` = 1 [mm] (a strongly under-corrected fast tele). */
export const LOCA_MAX_IMAGE_MM = 0.5;
/** |b| at the frame corner for `dof.catsEye` = 1 (two unit circles offset ±b: the lemon is 0.4 wide at the corner). */
export const CATS_EYE_MAX = 0.6;
/** Largest |b| the shaders' clip-area table covers. */
export const CATS_EYE_TABLE_MAX = 0.6;
/** Number of entries of the clip-area table (uniform array in the shaders). */
export const CLIP_TABLE_SIZE = 32;

/** The f-number series of the aperture select (A7.3 `dof.fstop`): f/0.95, then the third stops f/1 … f/22, as engraved
 *  on lens barrels. The values are the select's option strings (URL `fstop=2.8`). */
export const F_STOPS: readonly string[] = [
  "0.95", "1", "1.1", "1.2", "1.4", "1.6", "1.8", "2", "2.2", "2.5", "2.8", "3.2", "3.5", "4", "4.5", "5", "5.6", "6.3",
  "7.1", "8", "9", "10", "11", "13", "14", "16", "18", "20", "22",
];
export const DEFAULT_F_STOP = "2.8";

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------
// Lens ↔ fov
// ---------------------------------------------------------------------------------------------------------------

/** Focal length [mm] of a vertical fov on the 24 mm sensor: f = 12 / tan(fov/2). 22° → 61.73 mm. */
export function focalLengthMm(fovDeg: number): number {
  return (SENSOR_HEIGHT_MM / 2) / Math.tan((fovDeg * D2R) / 2);
}

/** Vertical fov [deg] of a focal length: 2·atan(12 / f), except exactly 22° at the default 62 mm (A7.2: the default
 *  must reproduce today's camera bit for bit). */
export function lensFovDeg(fMm: number): number {
  if (!(fMm > 0) || fMm === DEFAULT_LENS_MM) return DEFAULT_FOV_DEG;
  return (2 * Math.atan((SENSOR_HEIGHT_MM / 2) / fMm)) / D2R;
}

/** Fitted camera distance at another fov, keeping the object's framing: D·tan(fov₀/2)/tan(fov/2). (scene/camera.ts
 *  fits with the exact angles; this is the small-angle-free scale between two fovs.) */
export function framingScale(fovDeg: number, refFovDeg = DEFAULT_FOV_DEG): number {
  return Math.tan((refFovDeg * D2R) / 2) / Math.tan((fovDeg * D2R) / 2);
}

// ---------------------------------------------------------------------------------------------------------------
// Circle of confusion
// ---------------------------------------------------------------------------------------------------------------

/** Entrance pupil diameter A = f/N [mm]. */
export function apertureMm(fMm: number, n: number): number {
  return fMm / Math.max(n, 1e-3);
}

/** Signed CoC diameter on the sensor [mm] of a point at depth z [m] with the focus at z_f [m]:
 *  c = A·f·(z − z_f) / (z·(z_f − f)); negative in front of the focus plane. z = ∞ → A·f/(z_f − f). */
export function cocMm(zM: number, zfM: number, fMm: number, n: number): number {
  const a = apertureMm(fMm, n), zf = zfM * 1000;
  if (!Number.isFinite(zM)) return (a * fMm) / (zf - fMm);
  const z = zM * 1000;
  return (a * fMm * (z - zf)) / (z * (zf - fMm));
}

/** Sensor mm → device px for a viewport `heightPx` tall (the sensor's 24 mm span the viewport height). */
export function mmToPx(mm: number, heightPx: number): number {
  return (mm / SENSOR_HEIGHT_MM) * heightPx;
}

/** The shaders' CoC factor: radius_px(z) = K·(1 − z_f/z), K = A·f/(z_f − f) / 24 mm × H / 2 [px]. */
export function cocRadiusFactorPx(zfM: number, fMm: number, n: number, heightPx: number): number {
  const zf = zfM * 1000;
  return mmToPx((apertureMm(fMm, n) * fMm) / (zf - fMm), heightPx) / 2;
}

/** Signed CoC radius [px], clamped to ±maxRadiusPx (the tier clamp, A7.2). */
export function cocRadiusPx(zM: number, zfM: number, fMm: number, n: number, heightPx: number, maxRadiusPx = Infinity): number {
  const r = mmToPx(cocMm(zM, zfM, fMm, n), heightPx) / 2;
  return Math.min(Math.max(r, -maxRadiusPx), maxRadiusPx);
}

// ---------------------------------------------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------------------------------------------

export type FocusMode = "object" | "point" | "manual";
export const FOCUS_MODES: readonly FocusMode[] = ["object", "point", "manual"];

export interface FocusInputs {
  /** Camera-space depth [m] of the object's focus point (its centre, including the orbit offset). */
  objectDepthM: number;
  /** Camera-space depth [m] of the picked point, or null (no point: the object's centre is used). */
  pointDepthM: number | null;
  /** `dof.distance` [cm] (manual mode). */
  manualCm: number;
  /** `dof.offset` [mm]: shifts the focus plane along the view axis in the object and point modes. */
  offsetMm: number;
  /** Focal length [mm]: the focus is kept beyond 1.05·f (a thin lens cannot focus closer than f). */
  fMm: number;
}

/** Focus distance z_f [m] of a focus mode (A7.2). */
export function focusDistanceM(mode: FocusMode, i: FocusInputs): number {
  let z: number;
  if (mode === "manual") z = i.manualCm / 100;
  else {
    const base = mode === "point" && i.pointDepthM !== null && Number.isFinite(i.pointDepthM) ? i.pointDepthM : i.objectDepthM;
    z = base + i.offsetMm / 1000;
  }
  return Math.max(z, (1.05 * i.fMm) / 1000);
}

/**
 * The focus motor (A7.2 "focus pull"): continuous target motion (pose, orbit, offset) is followed directly; a
 * discontinuous change (mode, pick, material or object) eases the error between the shown and the new focus with a
 * critically damped spring (ω = 16 s⁻¹: 95 % settled after 0.3 s). Frozen runs use the exact value.
 */
export class FocusPull {
  /** Angular frequency of the critically damped error [1/s]. */
  static readonly OMEGA = 16;
  private err = 0;
  private vel = 0;
  private shown: number | null = null;

  /** The focus distance to render this frame. `jump`: the target changed discontinuously since the last frame. */
  update(target: number, dtS: number, jump: boolean, frozen: boolean): number {
    if (frozen || this.shown === null || !Number.isFinite(target)) {
      this.err = 0; this.vel = 0;
      this.shown = target;
      return target;
    }
    if (jump) this.err = this.shown - target;      // keep the shown value; the error decays from here
    // exact critically damped step: x(t) = (x0 + (v0 + ω x0)·t)·e^(−ωt)
    const w = FocusPull.OMEGA, t = Math.min(Math.max(dtS, 0), 0.25), e = Math.exp(-w * t);
    const x0 = this.err, v0 = this.vel;
    this.err = (x0 + (v0 + w * x0) * t) * e;
    this.vel = (v0 - w * (v0 + w * x0) * t) * e;
    if (Math.abs(this.err) < 1e-7 && Math.abs(this.vel) < 1e-6) { this.err = 0; this.vel = 0; }
    this.shown = target + this.err;
    return this.shown;
  }

  /** True while an eased pull is in flight. */
  get moving(): boolean { return this.err !== 0 || this.vel !== 0; }
}

// ---------------------------------------------------------------------------------------------------------------
// Longitudinal chromatic aberration
// ---------------------------------------------------------------------------------------------------------------

/** Object-side distance Δ [m] by which R and B focus behind G: the image-side shift loca·0.5 mm times the
 *  longitudinal magnification ((z_f − f)/f)². */
export function locaFocusOffsetM(loca: number, zfM: number, fMm: number): number {
  const zf = zfM * 1000, dv = Math.max(loca, 0) * LOCA_MAX_IMAGE_MM;
  return (dv * ((zf - fMm) / fMm) ** 2) / 1000;
}

/** The constant CoC shift ε of R and B [sensor mm, ≥ 0]: −c(z_f; z_f + Δ) = A·f·Δ / (z_f·(z_f + Δ − f)). R and B have
 *  the signed CoC c_G − ε (faded near focus, `channelCocPx`). */
export function locaShiftMm(loca: number, zfM: number, fMm: number, n: number): number {
  const d = locaFocusOffsetM(loca, zfM, fMm);
  return -cocMm(zfM, zfM + d, fMm, n);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Fade of the LoCA shift near focus: 0 below a 0.5 px CoC radius, 1 from 2 px (in-focus pixels stay neutral). */
export function locaFade(gRadiusPx: number): number {
  return smoothstep(0.5, 2, Math.abs(gRadiusPx));
}

/** Per-channel signed CoC radii [px] (R, G, B) from the G radius and the shift ε [px] (as the shaders do): R = B =
 *  G − ε·fade(|G|), keeping G's sign and at least half its magnitude. */
export function channelCocPx(gRadiusPx: number, shiftPx: number): [number, number, number] {
  const g = gRadiusPx;
  let rb = g - shiftPx * locaFade(g);
  if (g > 0) rb = Math.max(rb, 0.5 * g);
  else if (g < 0) rb = Math.min(rb, 0.5 * g);
  else rb = 0;
  return [rb, g, rb];
}

// ---------------------------------------------------------------------------------------------------------------
// Aperture shape
// ---------------------------------------------------------------------------------------------------------------

export interface ApertureShape {
  /** 0 = circular, else 5–11 blades. */
  blades: number;
  /** 0 = straight-edged polygon … 1 = circle. */
  curvature: number;
  /** Rotation of the polygon [deg] (0: a vertex points up). */
  angleDeg: number;
}

/** Derived blade constants (the shaders' uniforms): C = cos(π/n), the arc centre offset d_c along each edge normal
 *  (≤ 0), q = R_b² − d_c², the angle of the first edge normal; `round` for the circle. */
export interface BladeConstants { n: number; round: boolean; straight: boolean; c: number; dc: number; q: number; normal0: number }

export function bladeConstants(s: ApertureShape): BladeConstants {
  const n = Math.round(s.blades);
  const curv = Math.min(Math.max(s.curvature, 0), 1);
  if (n < 3 || curv >= 1 - 1e-6) return { n, round: true, straight: false, c: 1, dc: 0, q: 1, normal0: 0 };
  const c = Math.cos(Math.PI / n), sn = Math.sin(Math.PI / n);
  // vertex 0 at 90° + angle; edge normals halfway between vertices
  const normal0 = (90 + s.angleDeg) * D2R + Math.PI / n;
  if (curv < 1e-4) return { n, round: false, straight: true, c, dc: -Infinity, q: Infinity, normal0 };
  const rb = 1 / curv;
  const dc = c - Math.sqrt(rb * rb - sn * sn);
  return { n, round: false, straight: false, c, dc, q: 1 - 2 * dc * c, normal0 };
}

/** Boundary radius ρ(θ) of the (unclipped) aperture in direction θ [rad]; vertices lie on the unit circle. */
export function bladeRho(k: BladeConstants, theta: number): number {
  if (k.round) return 1;
  const sector = (2 * Math.PI) / k.n;
  let phi = (theta - k.normal0) % sector;
  if (phi < 0) phi += sector;
  if (phi > sector / 2) phi -= sector;                     // |φ| ≤ π/n from the nearest edge normal
  const cp = Math.cos(phi);
  if (k.straight) return k.c / cp;
  // ray from the centre to the arc of radius R_b centred at d_c·n̂: t² − 2t·d_c·cosφ − q = 0, positive root (stable form)
  const dcp = k.dc * cp;
  return k.q / (Math.sqrt(dcp * dcp + k.q) - dcp);
}

/** Gauge of the cat's-eye vesica D(b, 1) ∩ D(−b, 1) at d: (√((d·b)² + |d|²(1 − |b|²)) + |d·b|) / (1 − |b|²). */
export function vesicaGauge(dx: number, dy: number, bx: number, by: number): number {
  const bb = bx * bx + by * by;
  if (bb <= 0) return Math.hypot(dx, dy);
  const db = Math.abs(dx * bx + dy * by), dd = dx * dx + dy * dy, s = 1 - bb;
  return (Math.sqrt(db * db + dd * s) + db) / s;
}

/** Gauge of the aperture K = (curved polygon) ∩ (vesica) at d: d ∈ r·K ⇔ g(d) ≤ r. */
export function apertureGauge(k: BladeConstants, bx: number, by: number, dx: number, dy: number): number {
  const len = Math.hypot(dx, dy);
  if (len === 0) return 0;
  return Math.max(len / bladeRho(k, Math.atan2(dy, dx)), vesicaGauge(dx, dy, bx, by));
}

/** Cat's-eye offset b for an image point at NDC (x, y) of a viewport with `aspect` = width/height: along the radial
 *  direction (the vesica's long axis is then tangential), |b| = catsEye·0.6·(field radius / corner radius). */
export function catsEyeOffset(catsEye: number, ndcX: number, ndcY: number, aspect: number): [number, number] {
  const k = (Math.max(catsEye, 0) * CATS_EYE_MAX) / Math.hypot(aspect, 1);
  return [ndcX * aspect * k, ndcY * k];
}

/** Rim profile of a bokeh disc at t = g/r ∈ [0, 1] for a signed strength s ∈ [−1, 1]: s ≥ 0 bright rim
 *  1 + s(3t⁴ − 1), s < 0 soft edge 1 + s(2t² − 1); ∫₀¹ I·2t dt = 1 and I ≥ 0 for every s. */
export function rimProfile(t: number, s: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return s >= 0 ? 1 + s * (3 * x ** 4 - 1) : 1 + s * (2 * x * x - 1);
}

/** The signed rim strength of a field: background (far) bokeh +rim, foreground (near) −rim (A7.3). */
export function fieldRim(rim: number, far: boolean): number {
  return far ? rim : -rim;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** The gather's aperture pattern (A7.4 "sample the aperture shape itself"): a Vogel spiral of n points in the unit
 *  disc warped radially onto the aperture polygon, so the points are spread uniformly over the polygon itself.
 *  Each point: (x, y) in aperture units, u = its gauge in the unclipped polygon (= its spiral radius √((i + ½)/n)) and
 *  ω = the relative area it represents (ρ(θ)², normalised to mean 1). `areaRatio` = |P|/π. */
export function aperturePattern(shape: ApertureShape, n: number): { pts: Float32Array; areaRatio: number } {
  const k = bladeConstants(shape), pts = new Float32Array(4 * n);
  let s2 = 0;
  const rho: number[] = [];
  for (let i = 0; i < n; i++) {
    const th = i * GOLDEN + 0.5;
    const r = bladeRho(k, th);
    rho.push(r);
    s2 += r * r;
  }
  const mean = s2 / n;
  for (let i = 0; i < n; i++) {
    const th = i * GOLDEN + 0.5, u = Math.sqrt((i + 0.5) / n), r = rho[i];
    pts[4 * i] = u * r * Math.cos(th);
    pts[4 * i + 1] = u * r * Math.sin(th);
    pts[4 * i + 2] = u;
    pts[4 * i + 3] = (r * r) / mean;
  }
  return { pts, areaRatio: polygonAreaRatio(k) };
}

/** |P|/π of the curved polygon (exact for straight blades and the circle; numerical quadrature otherwise). */
export function polygonAreaRatio(k: BladeConstants): number {
  if (k.round) return 1;
  const m = 2048;
  let s = 0;
  for (let i = 0; i < m; i++) {
    const r = bladeRho(k, k.normal0 + ((i + 0.5) / m) * 2 * Math.PI);
    s += r * r;
  }
  return s / m;                                           // (½∫ρ² dθ)/π = mean(ρ²)
}

/** Fraction of the aperture area left by the cat's-eye clip, |P ∩ V(b)|/|P|, for |b| = j·max/(size − 1)
 *  (orientation-averaged over 8 directions; a 4096-point pattern). The shaders interpolate it for the energy
 *  normalisation of every bokeh. Monotone non-increasing in |b| (the vesicas are nested). */
export function clipAreaTable(shape: ApertureShape, size = CLIP_TABLE_SIZE, bMax = CATS_EYE_TABLE_MAX): Float32Array {
  const { pts } = aperturePattern(shape, 4096);
  const out = new Float32Array(size);
  let total = 0;
  for (let i = 0; i < 4096; i++) total += pts[4 * i + 3];
  for (let j = 0; j < size; j++) {
    const b = (j / (size - 1)) * bMax;
    let acc = 0;
    for (let d = 0; d < 8; d++) {
      const a = (d / 8) * Math.PI, bx = b * Math.cos(a), by = b * Math.sin(a);
      let s = 0;
      for (let i = 0; i < 4096; i++) if (vesicaGauge(pts[4 * i], pts[4 * i + 1], bx, by) <= 1) s += pts[4 * i + 3];
      acc += s / total;
    }
    out[j] = j > 0 ? Math.min(acc / 8, out[j - 1]) : acc / 8;
  }
  return out;
}

/** The table value at |b| (linear interpolation, as the shaders). */
export function clipAreaAt(table: ArrayLike<number>, b: number, bMax = CATS_EYE_TABLE_MAX): number {
  const n = table.length, x = Math.min(Math.max(b / bMax, 0), 1) * (n - 1), i = Math.min(Math.floor(x), n - 2), f = x - i;
  return table[i] * (1 - f) + table[i + 1] * f;
}
