// Shader library (WP-B, spec §6.6): the GLSL chunks as raw strings and the fixed-order assembler.
//
// assemble() emits, in this order (§6.6): `#define` lines (tier defines, material, NSPD 5, MAX_LIGHTS 4,
// DEBUG_VIEW, …) → common → spectral → ltc → lights → relief → coat → wear → grating → ibl → print → extra chunks
// (e.g. glitter.glsl) → the material's main. Our own chunks are never resolved through #include at run time.
// The result is a ShaderMaterial fragment shader (three prepends `#version 300 es` and the precision block).
import common from "./common.glsl?raw";
import spectral from "./spectral.glsl?raw";
import ltc from "./ltc.glsl?raw";
import lights from "./lights.glsl?raw";
import relief from "./relief.glsl?raw";
import coat from "./coat.glsl?raw";
import wear from "./wear.glsl?raw";
import grating from "./grating.glsl?raw";
import ibl from "./ibl.glsl?raw";
import print from "./print.glsl?raw";

export const LIB: Readonly<{
  common: string; spectral: string; ltc: string; lights: string; relief: string;
  coat: string; wear: string; grating: string; ibl: string; print: string;
}> = Object.freeze({ common, spectral, ltc, lights, relief, coat, wear, grating, ibl, print });

/** Chunk order of §6.6; also the order of LIB's keys. */
export const LIB_ORDER = ["common", "spectral", "ltc", "lights", "relief", "coat", "wear", "grating", "ibl", "print"] as const;

const DEFINE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Concatenate `#define`s, the library chunks in the fixed order, the extra chunks and the material main.
 * Define values are written verbatim (numbers as given; strings unchanged), one `#define NAME VALUE` per entry,
 * in insertion order. Throws on an invalid define name or a value containing a line break.
 */
export function assemble(defines: Readonly<Record<string, string | number>>, extraChunks: readonly string[], main: string): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(defines)) {
    if (!DEFINE_NAME.test(name)) throw new Error(`assemble: invalid define name "${name}"`);
    const v = typeof value === "number" ? formatNumber(value) : value;
    if (/[\r\n]/.test(v)) throw new Error(`assemble: define ${name} has a multi-line value`);
    lines.push(`#define ${name} ${v}`);
  }
  // CARD_PROGRAM: every assembled program is a card program (vertex shader card.vert, so the varyings it writes exist)
  const parts = [lines.join("\n"), "#define CARD_PROGRAM 1", ...LIB_ORDER.map((k) => LIB[k]), ...extraChunks, main];
  return parts.join("\n");
}

// Integers print as GLSL int literals (they size arrays and enter `#if`), other numbers as float literals.
function formatNumber(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`assemble: non-finite define value ${x}`);
  return String(x);
}
