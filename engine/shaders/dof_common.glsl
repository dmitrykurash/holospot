// dof_common.glsl — shared by the depth-of-field passes (addendum A7; CPU twin src/physics/lens.ts, driver
// src/render/dof.ts). Compiled after LIB.common (ENC_S, max3, sanitize, LUMA_SRGB, sq).
//
// Units: every pass works in its own pixels (full or half resolution); CoC values are signed radii (negative = near
// field, in front of the focus plane). The aperture K is the curved-blade polygon (vertices on the unit circle)
// intersected with the cat's-eye vesica D(b, 1) ∩ D(−b, 1); shapes are tested through the gauge g (d ∈ r·K ⇔ g(d) ≤ r).

const float DOF_PAGE = 1024.0;      // full-resolution CoC of page pixels (no coverage in the 3 × 3 neighbourhood)

uniform int uBladeN;                // < 3: a circular stop
uniform int uBladeStraight;         // 1: straight blades (curvature 0)
uniform float uBladeC;              // cos(π/n)
uniform float uBladeDc;             // centre offset of each blade arc along its edge normal (≤ 0)
uniform float uBladeQ;              // R_b² − d_c²
uniform float uBladeNormal0;        // angle of the first edge normal [rad]
uniform vec2 uCatsCentre;           // optical centre [px of this pass]
uniform float uCatsScale;           // |b| per px of field radius (catsEye·0.6 / (corner radius in px))
uniform vec4 uClip[8];             // |P ∩ V(b)| / |P| at |b| = j·0.6/31, j = 4·i + component (lens.ts clipAreaTable)
uniform float uAreaRatio;           // |P| / π
uniform float uLocaPx;              // CoC shift ε of R and B [px of this pass]
uniform vec2 uLocaFade;             // fade of ε: (0.5, 2) full px in this pass's px
uniform float uPageH;               // the page's CoC at infinity [half px]

// The half-resolution CoC texture stores (CoC·coverage, coverage), so its bilinear lookups and its mip levels average
// the object CoC weighted by coverage (the page, which has no CoC of its own, never dilutes it). Page only: uPageH.
float cocOf(vec2 v) { return v.y > 1e-4 ? v.x / v.y : uPageH; }

// Boundary radius of the unclipped aperture in the direction of d (vertices on the unit circle).
float bladeRho(vec2 d) {
  if (uBladeN < 3) return 1.0;
  float sector = TAU / float(uBladeN);
  float th = atan(d.y, d.x) - uBladeNormal0;
  float phi = th - sector * floor(th / sector + 0.5);          // |φ| ≤ π/n from the nearest edge normal
  float cp = cos(phi);
  if (uBladeStraight == 1) return uBladeC / cp;
  float dcp = uBladeDc * cp;
  return uBladeQ / (sqrt(dcp * dcp + uBladeQ) - dcp);           // stable positive root of t² − 2t·d_c·cosφ − q = 0
}

// Gauge of the vesica D(b, 1) ∩ D(−b, 1) (the circle when b = 0).
float vesicaGauge(vec2 d, vec2 b) {
  float s = 1.0 - dot(b, b), db = abs(dot(d, b));
  return (sqrt(db * db + dot(d, d) * s) + db) / s;
}

// Gauge of the aperture K at d.
float apertureGauge(vec2 d, vec2 b) {
  float l = length(d);
  if (l <= 0.0) return 0.0;
  return max(l / bladeRho(d), vesicaGauge(d, b));
}

// Cat's-eye offset b of an image point [px of this pass]: radial, |b| ∝ the field radius.
vec2 catsB(vec2 px) { return (px - uCatsCentre) * uCatsScale; }

// |K| / |P| for a cat's-eye offset of length lb.
float clipArea(float lb) {
  float x = clamp(lb / 0.6, 0.0, 1.0) * 31.0;
  int i = min(int(x), 30);
  float f = x - float(i);
  float a = uClip[i >> 2][i & 3], b = uClip[(i + 1) >> 2][(i + 1) & 3];
  return mix(a, b, f);
}

// Rim profile (spherical aberration): mean 1 over the disc, s ≥ 0 bright rim, s < 0 soft edge (lens.ts rimProfile).
vec3 rimProfile3(vec3 t, float s) {
  t = clamp(t, 0.0, 1.0);
  vec3 t2 = t * t;
  return s >= 0.0 ? 1.0 + s * (3.0 * t2 * t2 - 1.0) : 1.0 + s * (2.0 * t2 - 1.0);
}

// Per-channel signed CoC (R, G, B) from G (lens.ts channelCocPx): R = B = G − ε·fade(|G|), same sign, ≥ ½|G|.
vec3 chanCoc(float g) {
  float rb = g - uLocaPx * smoothstep(uLocaFade.x, uLocaFade.y, abs(g));
  rb = g > 0.0 ? max(rb, 0.5 * g) : min(rb, 0.5 * g);
  return vec3(rb, g, rb);
}

// The card target's texel → premultiplied scene-linear radiance and coverage (as glare_down.frag: decoded per texel,
// clamped per channel to ±1e4 and in luminance to [0, 1e4] — the only firefly control, far above any glint).
vec4 decodeCard(vec4 P) {
  float a = clamp(P.a, 0.0, 1.0);
  if (a <= 1e-5) return vec4(0.0);
  vec3 cu = P.rgb / a;
  vec3 c = cu / (ENC_S * max(1.0 - max(max3(cu), 0.0), 1e-4));
  c = clamp(sanitize(c), vec3(-1.0e4), vec3(1.0e4));
  float Y = dot(c, LUMA_SRGB);
  c *= Y > 1.0e4 ? 1.0e4 / Y : (Y < 0.0 ? 0.0 : 1.0);
  return vec4(c * a, a);
}
