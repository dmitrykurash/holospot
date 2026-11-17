// CPU twin of the Gilded Vortex spiral grating (addendum A2.6.1, A2.6.6 vortexElem) and its arm loci (A2.6.2–A2.6.3).
// Pure module (§6.1).
//
// Phase field (grating cycles) about the centre c, polar (r, θ): φ = (r + s_h·r_s·θ)/d₀ — an n_s-start Archimedean
// spiral (n_s = 2π r_s/d₀) with radial pitch d₀ everywhere. Grating vector ∇φ = (r̂ + s_h(r_s/r)θ̂)/d₀: azimuthal
// (radial grooves) at the centre, 45° at r = r_s, radial (concentric grooves) at the rim; local pitch
// d(r) = d₀/√(1 + (r_s/r)²). Coverage bands ξ = (N_b/2π)(θ + s_h·r/max(r_s, 1 mm)) follow the grooves; the coverage is
// 1 − contrast·I with I the box-filtered 50 % duty square wave of ξ over the pixel footprint.
// A light lights order m where ĝ ∥ q: θ = ψ_q − s_h·atan(r_s/r) (mod π), two S-shaped arms through the eye, coloured
// λ_m = d(r)·|q|/m along their length.
import type { Mat3, Vec2, Vec3 } from "../types.ts";
import { CARD_H_MM, CARD_T_MM, CARD_W_MM, cross, dot, normalize, rotate, sub } from "./geometry.ts";
import { cardPointWorld } from "./reference.ts";

export interface VortexInputs {
  pitchNm: number;                 // rim pitch d₀
  swirlMm: number;                 // swirl radius r_s (0 = concentric, CD-like)
  hand: 1 | -1;                    // s_h: +1 counter-clockwise
  centreMm: readonly [number, number];   // spiral centre c in card mm
  bands: number;                   // N_b (0 = no bands)
  contrast: number;                // 1 − w_lo
}

/** Smallest radius used by the field [mm] (as the shader). */
export const VORTEX_R_MIN = 0.02;
/** Lithographic orientation and pitch errors (A2.6.1): 0.1°, 0.2 %. */
export const VORTEX_SIG_THETA = (0.1 * Math.PI) / 180, VORTEX_SIG_FREL = 0.002;
/** Family pitch of the eye (A2.6.6 GratingSummary family 0) [nm]. */
export const VORTEX_EYE_PITCH = 300;

/** The vortex inputs at their defaults (A2.6.7) for a domain (card: centre (31.5, 44) mm). */
export function vortexDefaults(domainMm: readonly [number, number] = [CARD_W_MM, CARD_H_MM]): VortexInputs {
  return { pitchNm: 1250, swirlMm: 15, hand: 1, centreMm: [0.5 * domainMm[0], 0.5 * domainMm[1]], bands: 24, contrast: 0.45 };
}

/** Grating phase φ [cycles] at a card point (θ on the atan2 branch, so φ jumps by n_s across θ = ±π). */
export function vortexPhase(mm: readonly [number, number], s: VortexInputs): number {
  const dx = mm[0] - s.centreMm[0], dy = mm[1] - s.centreMm[1];
  return ((Math.hypot(dx, dy) + s.hand * s.swirlMm * Math.atan2(dy, dx)) * 1e6) / s.pitchNm;
}

/** Square-wave integral P(x) = ½⌊x⌋ + min(fract(x), ½) of the 50 % duty wave [fract(x) < ½]. */
export function squareWaveIntegral(x: number): number {
  const f = Math.floor(x);
  return 0.5 * f + Math.min(x - f, 0.5);
}

/** Box-filtered "on" fraction of the bands at ξ for a box half-width h (in ξ units); a step for h < 1e-4. */
export function bandOnFraction(xi: number, h: number): number {
  if (h < 1e-4) return xi - Math.floor(xi) < 0.5 ? 1 : 0;
  return (squareWaveIntegral(xi + h) - squareWaveIntegral(xi - h)) / (2 * h);
}

/**
 * The spiral element at card point mm (twin of the GLSL vortexElem): unit grating vector ĝ (card plane), 1/pitch
 * [nm⁻¹], the filtered band coverage (σ_px = √(½ tr F.S) [mm] of the pixel footprint; 0 = unfiltered), the band
 * coordinate ξ, and the pixel's orientation and relative pitch spreads (A2.6.6).
 */
export function vortexAt(mm: readonly [number, number], s: VortexInputs, sigmaPxMm = 0):
  { g: Vec2; invD: number; band: number; xi: number; r: number; theta: number; sigTheta: number; sigFrel: number } {
  const dx = mm[0] - s.centreMm[0], dy = mm[1] - s.centreMm[1];
  const rl = Math.hypot(dx, dy), r = Math.max(rl, VORTEX_R_MIN);
  const rh = rl > 1e-9 ? { x: dx / rl, y: dy / rl } : { x: 1, y: 0 };
  const k = (s.hand * s.swirlMm) / r;
  const gx = rh.x - k * rh.y, gy = rh.y + k * rh.x, gl = Math.hypot(gx, gy);
  const invD = Math.sqrt(1 + k * k) / s.pitchNm;
  const rs2 = s.swirlMm * s.swirlMm;
  const gPsi = Math.sqrt(1 / (r * r) + (s.swirlMm / (r * r + rs2)) ** 2);
  const sTh = gPsi * sigmaPxMm, sF = (rs2 / (r * (r * r + rs2))) * sigmaPxMm;
  const theta = Math.atan2(dy, dx), rb = Math.max(s.swirlMm, 1);
  const xi = (s.bands / (2 * Math.PI)) * (theta + (s.hand * r) / rb);
  const gXi = (s.bands / (2 * Math.PI)) * Math.sqrt(1 / (r * r) + 1 / (rb * rb));
  const h = 0.5 * gXi * Math.sqrt(2 * Math.PI) * sigmaPxMm;
  const band = s.bands > 0 ? 1 - s.contrast * bandOnFraction(xi, h) : 1;
  return {
    g: { x: gx / gl, y: gy / gl }, invD, band, xi, r, theta,
    sigTheta: Math.hypot(VORTEX_SIG_THETA, sTh), sigFrel: Math.hypot(VORTEX_SIG_FREL, sF),
  };
}

/** Local pitch d(r) = d₀/√(1 + (r_s/r)²) [nm]. */
export function vortexPitch(rMm: number, s: Pick<VortexInputs, "pitchNm" | "swirlMm">): number {
  const r = Math.max(rMm, VORTEX_R_MIN);
  return s.pitchNm / Math.sqrt(1 + (s.swirlMm / r) ** 2);
}

/** Eye radius for a light of tangential |q| (A2.6.1): no visible orders where d(r)·|q| < 380 nm, r_eye = r_s/√((d₀|q|/380)² − 1). */
export function eyeRadius(qMag: number, s: Pick<VortexInputs, "pitchNm" | "swirlMm">, lambdaNm = 380): number {
  const x = (s.pitchNm * qMag) / lambdaNm;
  return x > 1 ? s.swirlMm / Math.sqrt(x * x - 1) : Infinity;
}

/** etaN family coordinate (A2.6.6): 0 for 1/d ≥ 1/300, 1 at 1/(0.7·d₀), 2 at 1/d₀, piecewise linear in 1/d. */
export function vortexFamily(invD: number, pitchNm: number): number {
  const f0 = 1 / VORTEX_EYE_PITCH, f1 = 1 / (0.7 * pitchNm), f2 = 1 / pitchNm;
  if (invD >= f0) return 0;
  if (invD >= f1) return (f0 - invD) / (f0 - f1);
  return 1 + Math.min(Math.max((f1 - invD) / (f1 - f2), 0), 1);
}

export interface ArmPoint {
  r: number;                 // radius [mm]
  thetaDeg: number;          // polar angle about the centre [deg], in [0, 360)
  mm: [number, number];      // card point
  lambda1: number;           // first-order wavelength d(r)·|q_g| [nm]
  lambda2: number;           // second order, λ₁/2 [nm]
  psiQDeg: number;           // azimuth of q at the point [deg]
}

/**
 * Arm loci of a point light (A2.6.2): for each radius, the polar angles where ĝ ∥ q (q = (L + V)ₜ at the point,
 * exact finite-distance light and camera, the card face at z = +T/2 of the posed card), found by a 0.25° scan of the
 * sign of q·t̂ and bisection. Points outside the domain [0, W] × [0, H] are dropped. Two arms per radius at most.
 */
export function armPoints(lightPos: Vec3, camPos: Vec3, s: VortexInputs, radii: readonly number[],
  o: { cardRot?: Mat3; domainMm?: readonly [number, number] } = {}): ArmPoint[] {
  const R: Mat3 = o.cardRot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const dom = o.domainMm ?? [CARD_W_MM, CARD_H_MM];
  const n = rotate(R, [0, 0, 1]);
  const at = (r: number, th: number) => {
    const mm: [number, number] = [s.centreMm[0] + r * Math.cos(th), s.centreMm[1] + r * Math.sin(th)];
    const X = cardPointWorld(R, mm, [0, 0, 0], 0.5 * CARD_T_MM);
    const L = normalize(sub(lightPos, X)), V = normalize(sub(camPos, X));
    const H: Vec3 = [L[0] + V[0], L[1] + V[1], L[2] + V[2]];
    const e = vortexAt(mm, s);
    const g = normalize(rotate(R, [e.g.x, e.g.y, 0]));
    const t = cross(n, g);
    const qg = dot(H, g), qt = dot(H, t);
    const T = rotate(R, [1, 0, 0]), B = rotate(R, [0, 1, 0]);
    return { mm, qg, qt, invD: e.invD, psi: Math.atan2(dot(H, B), dot(H, T)) };
  };
  const out: ArmPoint[] = [];
  const step = (0.25 * Math.PI) / 180;
  for (const r of radii) {
    let prev = at(r, 0), thPrev = 0;
    for (let k = 1; k <= 1440; k++) {
      const th = k * step, cur = at(r, th);
      if (Math.sign(cur.qt) !== Math.sign(prev.qt) && prev.qt !== 0) {
        let a = thPrev, b = th, fa = prev.qt;
        for (let it = 0; it < 50; it++) {
          const m = 0.5 * (a + b), fm = at(r, m).qt;
          if (Math.sign(fm) === Math.sign(fa)) { a = m; fa = fm; } else b = m;
        }
        const thr = 0.5 * (a + b), p = at(r, thr);
        const inside = p.mm[0] >= 0 && p.mm[0] <= dom[0] && p.mm[1] >= 0 && p.mm[1] <= dom[1];
        if (inside) {
          const l1 = Math.abs(p.qg) / p.invD;
          out.push({ r, thetaDeg: ((thr * 180) / Math.PI) % 360, mm: p.mm, lambda1: l1, lambda2: l1 / 2, psiQDeg: (p.psi * 180) / Math.PI });
        }
      }
      prev = cur; thPrev = th;
    }
  }
  return out;
}
