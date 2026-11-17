// CPU reference evaluator for the grating condition with exact finite-distance light and view (spec §1.3 Q1, §6.4,
// §6.8 `__holo.reference`, §7.1 P8–P10, §7.2 N1–N5). Bow and relief are ignored. Pure module (§6.1).
import type { Mat3, Vec3 } from "../types.ts";
import { CARD_H_MM, CARD_T_MM, CARD_W_MM, add, column, cross, dot, normalize, rotate, sub } from "./geometry.ts";

/** Visible window for the reported first-order wavelength [nm] (§6.4: λ₁ if in 360–830 nm). */
export const LAMBDA1_RANGE = [360, 830] as const;

export interface ReferenceInputs {
  camPos: Vec3;          // camera position, world m
  cardRot: Mat3;         // card local → world rotation (row-major)
  lightPos: Vec3;        // light centre (sphere centre, rect centre or flash position), world m
  pitchNm: number;       // grating period d
  gAzimuthRad: number;   // grating-vector azimuth in the card plane, CCW from card +x (M1: grooveAngle − 90°)
  faceZMm?: number;      // height of the evaluated face above the card mid-plane [mm]; default +T/2 (the rendered front face)
  cardPos?: Vec3;        // card centre, world m (default origin; a flip lift moves it)
}

export interface ReferenceResult {
  q: [number, number];   // ((L+V)·ĝ, (L+V)·t̂), t̂ = n × ĝ
  ci: number;            // n·L
  co: number;            // n·V
  lambda1: number | null;
}

/**
 * World position [m] of a front-face card point given in card mm (origin bottom-left; the front face lies at
 * z = +T/2 = 0.15 mm above the mid-plane, §5.1).
 */
export function cardPointWorld(cardRot: Mat3, mm: readonly [number, number], cardPos: Vec3 = [0, 0, 0],
  faceZMm: number = 0.5 * CARD_T_MM): Vec3 {
  const local: Vec3 = [(mm[0] - 0.5 * CARD_W_MM) / 1000, (mm[1] - 0.5 * CARD_H_MM) / 1000, faceZMm / 1000];
  return add(cardPos, rotate(cardRot, local));
}

/**
 * Grating condition at a front-face card point (§4.1): q = (L+V)ₜ in the element frame (n, ĝ, t̂) of the rotated
 * card; λ₁ = d·|q_g| (order ±1 with the sign of q_g) when it lies in 360–830 nm and both L and V are in front of the
 * face, else null. |q_t| measures how far the point is off the dispersion line (lobe weight exp(−½q_t²/σ_t²)).
 * The point lies on the rendered front face (z = +T/2), which a tilt moves sideways by T/2·sin(tilt): at 16° the
 * coaxial-flash centre reads 551.5 nm instead of the mid-plane value 2d·sin 16° = 551.3 nm (pass faceZMm 0 for it).
 */
export function referenceAt(s: ReferenceInputs, mm: [number, number]): ReferenceResult {
  const X = cardPointWorld(s.cardRot, mm, s.cardPos, s.faceZMm);
  const L = normalize(sub(s.lightPos, X)), V = normalize(sub(s.camPos, X));
  const n = column(s.cardRot, 2);
  const g = rotate(s.cardRot, [Math.cos(s.gAzimuthRad), Math.sin(s.gAzimuthRad), 0]);
  const t = cross(n, g);
  const H: Vec3 = [L[0] + V[0], L[1] + V[1], L[2] + V[2]];
  const q: [number, number] = [dot(H, g), dot(H, t)];
  const ci = dot(n, L), co = dot(n, V);
  const lam = s.pitchNm * Math.abs(q[0]);
  const lambda1 = ci > 0 && co > 0 && lam >= LAMBDA1_RANGE[0] && lam <= LAMBDA1_RANGE[1] ? lam : null;
  return { q, ci, co, lambda1 };
}
