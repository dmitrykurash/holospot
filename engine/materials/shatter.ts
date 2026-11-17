// M2 Gold Shatter (spec §3.2, §4.10): a cracked-ice mosaic of chord-split Voronoi shards, each a buried, tilted linear
// grating of one of three pitch families, under a yellow (long-pass) lacquer on aluminium: warm palette, gold mirror,
// embossed creases on part of the borders.
// MaterialDef (§6.3): the dial literal and ParamSpecs live in the pure shatter.params.ts; this module adds the shader
// source and the CPU conversions of §3.2's "Uniform ← conversion" column.
import * as THREE from "three";
import type { GratingSummary, MaterialDef, ParamValues, ReliefInputs, TintInputs, Uniforms } from "../types.ts";
import fragmentMain from "../shaders/holo_shatter.frag?raw";
import { shatterDial, SHATTER_PARAMS } from "./shatter.params.ts";
import { DEG, numParam, setUniform, tintParam } from "./build.ts";

const DEFAULT_TINT: TintInputs = { type: "longpass", edgeNm: 500, widthNm: 70, floor: 0.25 };
const DEFAULTS: ParamValues = Object.fromEntries(SHATTER_PARAMS.map((p) => [p.id, p.default]));

const pitch = (v: ParamValues, id: string, d: number) => Math.max(numParam(v, id, d), 1);
const pitches = (v: ParamValues): [number, number, number] =>
  [pitch(v, "shatter.pitchA", 1150), pitch(v, "shatter.pitchB", 1080), pitch(v, "shatter.pitchC", 870)];
const orientSteps = (v: ParamValues) => Math.min(Math.max(Math.round(numParam(v, "shatter.orientK", 0)), 0), 64);
const depthNm = (v: ParamValues) => Math.max(numParam(v, "shatter.depth", 95), 0);
const lacquer = (v: ParamValues) => Math.max(numParam(v, "shatter.nc", 1.5), 1.0001);

export const shatter: MaterialDef = {
  id: "shatter",
  name: "Gold Shatter",
  analog: "cracked-ice holofoil under a gold lacquer",
  caption: "fragmented gold cracked-ice foil · 870–1149 l/mm",
  dial: shatterDial,
  params: SHATTER_PARAMS,
  fragmentMain,
  extraChunks: [],

  createUniforms(): Uniforms {
    const u: Uniforms = {
      uShardSize: { value: 2.5 }, uShardJit: { value: 0.9 }, uChords: { value: 1.8 }, uOrientK: { value: 0 },
      uShardTilt: { value: 0 }, uFanQ: { value: 0 }, uInvDSet: { value: new THREE.Vector3(1, 1, 1) },
      uDepthNm: { value: 95 }, uCoverage: { value: 0.7 }, uChirp: { value: 0 },
      uRidgeH: { value: 0 }, uRidgeW: { value: 0.04 }, uCreaseShare: { value: 0.5 },
      uNc: { value: 1.5 }, uSigS: { value: 0 }, uCoatAlpha: { value: 0.05 }, uSeed: { value: 7 },
    };
    shatter.apply(DEFAULTS, u);
    return u;
  },

  apply(values: ParamValues, u: Uniforms): void {
    setUniform(u, "uShardSize", Math.max(numParam(values, "shatter.size", 2.5), 0.05));
    setUniform(u, "uShardJit", Math.min(Math.max(numParam(values, "shatter.jitter", 0.9), 0), 1));
    setUniform(u, "uChords", Math.min(Math.max(numParam(values, "shatter.chords", 1.8), 0), 3));
    setUniform(u, "uOrientK", orientSteps(values));
    setUniform(u, "uShardTilt", Math.tan(Math.min(Math.max(numParam(values, "shatter.tilt", 1), 0), 45) * DEG));   // slope
    setUniform(u, "uFanQ", Math.max(numParam(values, "shatter.fan", 5), 0) * DEG);
    const [a, b, c] = pitches(values);
    const inv = u.uInvDSet?.value;
    if (inv instanceof THREE.Vector3) inv.set(1 / a, 1 / b, 1 / c);
    else setUniform(u, "uInvDSet", new THREE.Vector3(1 / a, 1 / b, 1 / c));
    setUniform(u, "uDepthNm", depthNm(values));
    setUniform(u, "uCoverage", Math.min(Math.max(numParam(values, "shatter.coverage", 0.7), 0), 1));
    setUniform(u, "uChirp", Math.max(numParam(values, "shatter.chirp", 0), 0) / 100);
    setUniform(u, "uRidgeH", numParam(values, "shatter.ridgeH", 0.3) * 1e-3);                   // µm → mm
    setUniform(u, "uRidgeW", Math.max(numParam(values, "shatter.ridgeW", 40), 1e-3) * 1e-3);
    setUniform(u, "uCreaseShare", Math.min(Math.max(numParam(values, "shatter.creaseShare", 50), 0), 100) / 100);
    setUniform(u, "uNc", lacquer(values));
    setUniform(u, "uSigS", Math.max(numParam(values, "shatter.roughness", 0.45), 0) * DEG);
    setUniform(u, "uCoatAlpha", Math.min(Math.max(numParam(values, "shatter.coatAlpha", 0.05), 1e-3), 1));
    setUniform(u, "uSeed", Math.max(Math.round(numParam(values, "shatter.seed", 7)), 0) >>> 0);
  },

  defines(): Record<string, string | number> {
    return {};
  },

  // Three families A/B/C (Elem.fam = family index). Shard orientations are random, so ĝ ∥ q for the orders and the
  // orientation mean for mirrors and environment (§4.4.1) — except with one orientation step, where every shard has
  // θ = π/2 (§6.8: the reference then uses ĝ = +B).
  gratingSummary(values: ParamValues): GratingSummary {
    return {
      pitchesNm: pitches(values),
      depthNm: depthNm(values),
      nc: lacquer(values),
      gAzimuthRad: orientSteps(values) === 1 ? Math.PI / 2 : null,
      recycle: true,
      tint: tintParam(values, "shatter", DEFAULT_TINT),
    };
  },

  relief(values: ParamValues): ReliefInputs {
    return {
      seed: Math.max(Math.round(numParam(values, "shatter.seed", 7)), 0),
      wavinessDeg: Math.max(numParam(values, "shatter.waviness", 0.3), 0),
      orangePeelUm: Math.max(numParam(values, "shatter.orangePeel", 0.6), 0),
    };
  },

  wobbleAxisDeg(): number | null {
    return null;
  },
};
