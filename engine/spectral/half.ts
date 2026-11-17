// IEEE 754 binary16 conversion for HalfFloatType texture uploads (spec §4.2.3, §6.4). Pure module (§6.1).

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/**
 * Float → IEEE half bits (0–0xFFFF) with round-to-nearest-even, gradual underflow, overflow to ±Inf and NaN kept
 * as a quiet NaN. The value is first rounded to binary32. toHalf(1) = 0x3C00, toHalf(65504) = 0x7BFF,
 * toHalf(−2) = 0xC000.
 */
export function toHalf(f: number): number {
  F32[0] = f;
  const x = U32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant !== 0 ? 0x200 : 0);   // Inf / NaN
  const e = exp - 127 + 15;                                            // rebiased exponent
  if (e >= 0x1f) return sign | 0x7c00;                                 // overflow → ±Inf
  if (e <= 0) {                                                        // half subnormal (or zero)
    if (e < -10) return sign;                                          // below half the smallest subnormal → ±0
    mant |= 0x800000;                                                  // implicit leading 1
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1), halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (h & 1) !== 0)) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1) !== 0)) h++;          // a carry may round up into the exponent (→ Inf)
  return sign | h;
}

/** Element-wise toHalf for texture data (e.g. the RGBA tables of buildCmfLayer). */
export function toHalfArray(a: Float32Array): Uint16Array {
  const out = new Uint16Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = toHalf(a[i]);
  return out;
}

/** Half bits → number (inverse of toHalf; exact). */
export function fromHalf(h: number): number {
  const s = (h & 0x8000) !== 0 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * Math.pow(2, -24);
  if (e === 0x1f) return m !== 0 ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
