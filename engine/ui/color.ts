// CSS colour string → linear sRGB (spec §6.4 WP-G, §5.7 ink uniforms, §7.1 colour tests).
// Pure module (§6.1): no three, no DOM, erasable syntax only, so `node --test` runs it with type stripping.
//
// DialKit colour controls return CSS colour strings: hex (3/4/6/8 digits), rgb()/rgba(), hsl()/hsla(), oklch() and
// color(display-p3 …) (DialKit 2.1.0 `parseColor`/`formatColor`, checked in node_modules/dialkit/dist/vanilla).
// URLs may carry the same strings (§6.7). This module accepts those, plus oklab(), color(srgb …) and
// color(srgb-linear …), in both the legacy comma syntax and the modern space syntax with an optional "/ alpha".
//
// The result is LINEAR sRGB (the renderer's working space, D65). Wide-gamut inputs (Display P3, OKLCH) are converted
// exactly and may therefore exceed [0, 1] or go negative (e.g. color(display-p3 1 0 0) → (1.2249, −0.0421, −0.0196));
// consumers that need a reflectance (inks) gamut-map and clamp themselves.
import type { Vec3 } from "../types.ts";

export interface ParsedCssColor { rgb: Vec3; alpha: number }

// ---------------------------------------------------------------------------------------------------------------
// Transfer functions and matrices (CSS Color 4 sample code; D65 throughout, no chromatic adaptation needed)
// ---------------------------------------------------------------------------------------------------------------

/** sRGB / Display P3 EOTF (both use the sRGB transfer curve), extended sign-symmetrically below 0 as in CSS Color 4. */
export function srgbToLinear(v: number): number {
  const a = Math.abs(v);
  return a <= 0.04045 ? v / 12.92 : Math.sign(v) * Math.pow((a + 0.055) / 1.055, 2.4);
}

/** Linear Display P3 → linear sRGB (= XYZ→sRGB · P3→XYZ, CSS Color 4 matrices; row-major). */
const P3_TO_SRGB: readonly number[] = (() => {
  const p3ToXyz = [
    0.4865709486482162, 0.26566769316909306, 0.1982172852343625,
    0.2289745640697488, 0.6917385218365064, 0.079286914093745,
    0.0, 0.04511338185890264, 1.043944368900976,
  ];
  const xyzToSrgb = [
    3.2409699419045226, -1.537383177570094, -0.4986107602930034,
    -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
    0.05563007969699366, -0.20397695888897652, 1.0569715142428786,
  ];
  const m: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += xyzToSrgb[3 * r + k] * p3ToXyz[3 * k + c];
    m.push(s);
  }
  return m;
})();

function mul3(m: readonly number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** OKLab → linear sRGB (Björn Ottosson's reference matrices, as used by CSS Color 4). */
export function oklabToLinearSrgb(L: number, a: number, b: number): Vec3 {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** HSL (h in degrees, s and l in [0, 1]) → gamma-encoded sRGB in [0, 1] (CSS Color 4 `hslToRgb`). */
function hslToSrgb(h: number, s: number, l: number): Vec3 {
  const hue = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------------------------

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

interface Token { value: number; unit: "" | "%" | "deg" | "rad" | "grad" | "turn"; none: boolean }

/** One CSS numeric component: number, percentage, angle, or `none` (CSS Color 4, treated as 0). */
function token(s: string): Token | null {
  const t = s.trim().toLowerCase();
  if (t === "none") return { value: 0, unit: "", none: true };
  const m = NUM.exec(t);
  if (!m) return null;
  const unit = t.slice(m[0].length);
  if (unit !== "" && unit !== "%" && unit !== "deg" && unit !== "rad" && unit !== "grad" && unit !== "turn") return null;
  const value = Number(m[0]);
  return Number.isFinite(value) ? { value, unit, none: false } : null;
}

/** A plain number or a percentage scaled so that 100 % = `pct100`. Angles are rejected. */
function scalar(t: Token | null, pct100: number): number | null {
  if (!t) return null;
  if (t.unit === "") return t.value;
  if (t.unit === "%") return (t.value / 100) * pct100;
  return null;
}

/** A hue in degrees: bare numbers are degrees; deg / rad / grad / turn units. */
function hue(t: Token | null): number | null {
  if (!t) return null;
  switch (t.unit) {
    case "": case "deg": return t.value;
    case "rad": return (t.value * 180) / Math.PI;
    case "grad": return t.value * 0.9;
    case "turn": return t.value * 360;
    default: return null;
  }
}

/** Alpha: number or percentage, clamped to [0, 1]; absent = 1. */
function alphaOf(s: string | undefined): number | null {
  if (s === undefined) return 1;
  const a = scalar(token(s), 1);
  return a === null ? null : Math.min(Math.max(a, 0), 1);
}

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/**
 * Splits a function body into its three components and an optional alpha.
 * Legacy syntax: "a, b, c[, alpha]" (only for rgb/rgba/hsl/hsla). Modern: "a b c[ / alpha]".
 */
function components(body: string, allowLegacy: boolean): { c: string[]; alpha: string | undefined; legacy: boolean } | null {
  const b = body.trim();
  if (b.includes(",")) {
    if (!allowLegacy || b.includes("/")) return null;
    const parts = b.split(",").map((x) => x.trim());
    if ((parts.length !== 3 && parts.length !== 4) || parts.some((p) => p === "" || /\s/.test(p))) return null;
    return { c: parts.slice(0, 3), alpha: parts[3], legacy: true };
  }
  const slash = b.split("/");
  if (slash.length > 2) return null;
  const c = slash[0].trim().split(/\s+/).filter((x) => x !== "");
  if (c.length !== 3) return null;
  const alpha = slash.length === 2 ? slash[1].trim() : undefined;
  if (alpha !== undefined && (alpha === "" || /\s/.test(alpha))) return null;
  return { c, alpha, legacy: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Parsers per syntax
// ---------------------------------------------------------------------------------------------------------------

function parseHex(t: string): ParsedCssColor | null {
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(t)) return null;
  let h = t.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const bytes = (h.match(/../g) as string[]).map((x) => parseInt(x, 16) / 255);
  return { rgb: [srgbToLinear(bytes[0]), srgbToLinear(bytes[1]), srgbToLinear(bytes[2])], alpha: bytes.length === 4 ? bytes[3] : 1 };
}

function parseRgb(body: string): ParsedCssColor | null {
  const p = components(body, true);
  if (!p) return null;
  const toks = p.c.map(token);
  if (toks.some((t) => !t || (t.unit !== "" && t.unit !== "%"))) return null;
  // Legacy syntax: all three channels are numbers or all are percentages (CSS Color 3).
  if (p.legacy && !(toks.every((t) => t!.unit === "%") || toks.every((t) => t!.unit === ""))) return null;
  const enc = toks.map((t) => clamp01(t!.unit === "%" ? t!.value / 100 : t!.value / 255));
  const alpha = alphaOf(p.alpha);
  if (alpha === null) return null;
  return { rgb: [srgbToLinear(enc[0]), srgbToLinear(enc[1]), srgbToLinear(enc[2])], alpha };
}

function parseHsl(body: string): ParsedCssColor | null {
  const p = components(body, true);
  if (!p) return null;
  const h = hue(token(p.c[0]));
  const st = token(p.c[1]), lt = token(p.c[2]);
  if (h === null || !st || !lt) return null;
  // Legacy syntax requires percentages; the modern syntax also accepts bare numbers (CSS Color 4: 100 = 100 %).
  if (p.legacy && (st.unit !== "%" || lt.unit !== "%")) return null;
  if ((st.unit !== "%" && st.unit !== "") || (lt.unit !== "%" && lt.unit !== "")) return null;
  const s = clamp01(st.value / 100), l = clamp01(lt.value / 100);
  const enc = hslToSrgb(h, s, l);
  const alpha = alphaOf(p.alpha);
  if (alpha === null) return null;
  return { rgb: [srgbToLinear(enc[0]), srgbToLinear(enc[1]), srgbToLinear(enc[2])], alpha };
}

function parseOklch(body: string): ParsedCssColor | null {
  const p = components(body, false);
  if (!p) return null;
  const L = scalar(token(p.c[0]), 1), C = scalar(token(p.c[1]), 0.4), H = hue(token(p.c[2]));
  if (L === null || C === null || H === null) return null;
  const alpha = alphaOf(p.alpha);
  if (alpha === null) return null;
  const c = Math.max(C, 0), hr = (H * Math.PI) / 180;
  return { rgb: oklabToLinearSrgb(Math.max(L, 0), c * Math.cos(hr), c * Math.sin(hr)), alpha };
}

function parseOklab(body: string): ParsedCssColor | null {
  const p = components(body, false);
  if (!p) return null;
  const L = scalar(token(p.c[0]), 1), a = scalar(token(p.c[1]), 0.4), b = scalar(token(p.c[2]), 0.4);
  if (L === null || a === null || b === null) return null;
  const alpha = alphaOf(p.alpha);
  if (alpha === null) return null;
  return { rgb: oklabToLinearSrgb(Math.max(L, 0), a, b), alpha };
}

/** color(<space> r g b [/ a]) for display-p3, srgb and srgb-linear; channels are numbers (1 = full) or percentages. */
function parseColorFn(body: string): ParsedCssColor | null {
  const m = /^\s*([a-z0-9-]+)\s+(.*)$/.exec(body);
  if (!m) return null;
  const space = m[1];
  if (space !== "display-p3" && space !== "srgb" && space !== "srgb-linear") return null;
  const p = components(m[2], false);
  if (!p) return null;
  const ch = p.c.map((s) => scalar(token(s), 1));
  if (ch.some((x) => x === null)) return null;
  const alpha = alphaOf(p.alpha);
  if (alpha === null) return null;
  const v = ch as number[];
  if (space === "srgb-linear") return { rgb: [v[0], v[1], v[2]], alpha };
  const lin: Vec3 = [srgbToLinear(v[0]), srgbToLinear(v[1]), srgbToLinear(v[2])];
  return { rgb: space === "srgb" ? lin : mul3(P3_TO_SRGB, lin), alpha };
}

const NAMED: Readonly<Record<string, ParsedCssColor>> = {
  transparent: { rgb: [0, 0, 0], alpha: 0 },
  black: { rgb: [0, 0, 0], alpha: 1 },
  white: { rgb: [1, 1, 1], alpha: 1 },
};

/**
 * Parses a CSS colour string into linear sRGB and alpha (spec §6.4). Returns null for anything it cannot parse.
 * P3 and OKLCH inputs may exceed [0, 1]; hex, rgb() and hsl() inputs are within [0, 1].
 */
export function parseCssColor(s: string): ParsedCssColor | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  if (t === "") return null;
  if (t.startsWith("#")) return parseHex(t);
  const named = NAMED[t];
  if (named) return { rgb: [named.rgb[0], named.rgb[1], named.rgb[2]], alpha: named.alpha };
  const m = /^([a-z-]+)\(([^()]*)\)$/.exec(t);
  if (!m) return null;
  switch (m[1]) {
    case "rgb": case "rgba": return parseRgb(m[2]);
    case "hsl": case "hsla": return parseHsl(m[2]);
    case "oklch": return parseOklch(m[2]);
    case "oklab": return parseOklab(m[2]);
    case "color": return parseColorFn(m[2]);
    default: return null;
  }
}
