// ===== volume.glsl — A5 Volume Hologram: replay optics, cone-traced SDF image, recorded shading, speckle, backdrop =====
// Extra chunk of holo_volume.frag (after the shader library). CPU twin of the replay maths: src/physics/volume.ts
// (signs of spec §4.1: ℓ̂, v̂, ρ̂ point away from the surface, the recorded direction π̂ into the sticker).
//
// Light-field reconstruction (A5.1): at a surface point the hologram stores R(π̂), the monochrome radiance of the
// recorded object seen along π̂ under the recording light. A light ℓ̂ and the eye v̂ select the replayed direction
//   π̂′ₜ = ρ̂ₜ − (λ_r/λ)(v̂ₜ + ℓ̂ₜ)   (evanescent for |π̂′ₜ| ≥ 1)
// with λ = the Bragg wavelength (reflection) or the slit wavelength (rainbow). R(π̂′) is found by sphere tracing the
// subject's signed-distance volume along the line X + t·π̂′ through a box anchored to the local film frame (mm; the
// object centre at depth uVolPose.z, parts may come forward of the surface). Depth blur from the light's angular size
// (and the band's dispersion) is cone tracing: the cone radius grows linearly with |t|, the coverage of a near miss is
// smoothstep-like over that radius, the shading is evaluated at the cone's scale.
//
// Uniforms (materials/volume.ts; the volume texture and grid from scene/volumes.ts):
//   uVolSdf      sampler3D  R16F signed distance [object units, longest dimension 1], trilinear, clamp-to-edge
//   uVolGridN    vec3       (nx, ny, nz);  uVolGridMin vec3: centre of voxel 0 [object units];  uVolGridH: voxel size
//   uVolLoaded   int        0 while no volume is bound (the image is empty, the backdrop stays)
//   uVolRotT     mat3       box → object rotation (transpose of R_y(yaw)·R_x(pitch), base pose included)
//   uVolPose     vec4       (centre x, y [mm, from the uv-domain centre], depth [mm], size [mm])
//   uVolRecLight vec3       recording light, object space (unit)
//   uVolSpeckle  float      speckle contrast;  uVolSeed int
//   uVolBackdrop vec2       (0 none / 1 grid / 2 stars / 3–8 the A10 diffractive patterns, depth [mm] of grid / stars)
//   uVolPat, uVolPat2       A10 pattern (end of this file);  uVolRec vec4: A10 stereogram (volTraceRec)
// Trip counts (TierConfig.trips, scene/uniforms.ts): uVolSteps (sphere-tracing steps), uVolLights (lights traced per
// pixel), uVolShadowSteps (soft-shadow steps of the recorded shading; 0 = none).

uniform highp sampler3D uVolSdf;
uniform vec3  uVolGridN, uVolGridMin;
uniform float uVolGridH;
uniform int   uVolLoaded;
uniform mat3  uVolRotT;
uniform vec4  uVolPose;
uniform vec3  uVolRecLight;
uniform float uVolSpeckle;
uniform int   uVolSeed;
uniform vec2  uVolBackdrop;
uniform int   uVolSteps, uVolLights, uVolShadowSteps;
// The replay (materials/volume.ts applyVolumeUniforms): uVolType (0 reflection, 1 rainbow), uVolLambda = (λ_r [nm],
// σ_B [nm], 0, 0), uVolRef (ρ̂, film frame), uVolSel = (σ_w, σ_slit) [rad], uVolEff.
uniform int   uVolType;
uniform vec4  uVolLambda;
uniform vec3  uVolRef;
uniform vec2  uVolSel;
uniform float uVolEff;

const float VOL_N = 1.5;                // emulsion index (reflection)
const float VOL_GRAIN_MM = 0.05;        // subjective speckle grain on the image [mm]
const float VOL_DECORR = 0.011;         // speckle decorrelation angle ≈ λ/grain [rad]
const float VOL_NOISE = 0.004;          // recorded scatter floor (hologram noise) relative to a white object

// ---- Replay optics (physics/volume.ts)
float volCosIn(vec2 t) { return sqrt(max(1.0 - dot(t, t) / (VOL_N * VOL_N), 0.0)); }
// π̂′ for wavelength ratio k = λ_r/λ; w = 0 when evanescent.
vec3 volReplayDir(vec3 rho, vec3 l, vec3 v, float k, out float ok) {
  vec2 t = rho.xy - k * (v.xy + l.xy);
  float t2 = dot(t, t);
  ok = t2 < 0.9999 ? 1.0 : 0.0;
  return vec3(t, -sqrt(max(1.0 - t2, 1e-8)));
}
// Reflection: Bragg wavelength λ_B = λ_r (c_v + c_ℓ)/(c_ρ + c_π(λ_B)) by fixed point (3 steps) and π̂′(λ_B).
vec3 volBragg(vec3 rho, vec3 l, vec3 v, float lamR, out float lam, out float ok) {
  float num = volCosIn(v.xy) + volCosIn(l.xy), cr = volCosIn(rho.xy);
  lam = lamR;
  vec3 pi = volReplayDir(rho, l, v, 1.0, ok);
  for (int i = 0; i < 3; ++i) {
    float cp = ok > 0.0 ? volCosIn(pi.xy) : 0.74535599;          // evanescent start: the grazing cosine √(1 − 1/n²)
    lam = lamR * num / (cr + cp);
    pi = volReplayDir(rho, l, v, lamR / lam, ok);
  }
  if (l.z <= 0.0 || v.z <= 0.0) ok = 0.0;
  return pi;
}
// Rainbow: λ_c = λ_r (v_y + ℓ_y)/(ρ_y − π_y0) and π̂′(λ_c) (reference from above or below: the ratio must be > 0).
vec3 volRainbow(vec3 rho, vec3 l, vec3 v, float lamR, float piY0, out float lam, out float ok) {
  float den = rho.y - piY0, num = v.y + l.y;
  ok = 0.0; lam = 0.0;
  if (abs(den) <= 1e-4 || num / den <= 1e-4 || l.z <= 0.0 || v.z <= 0.0) return vec3(0.0, 0.0, -1.0);
  lam = lamR * num / den;
  return volReplayDir(rho, l, v, lamR / lam, ok);
}

// ---- The signed-distance volume
float volSdf(vec3 P) {
  vec3 uvw = (P - uVolGridMin) / (uVolGridH * uVolGridN) + 0.5 / uVolGridN;
  return textureLod(uVolSdf, uvw, 0.0).r;
}
vec3 volNormal(vec3 P, float e) {                               // tetrahedral gradient at scale e
  const vec2 k = vec2(1.0, -1.0);
  vec3 g = k.xyy * volSdf(P + k.xyy * e) + k.yyx * volSdf(P + k.yyx * e)
         + k.yxy * volSdf(P + k.yxy * e) + k.xxx * volSdf(P + k.xxx * e);
  return g * inversesqrt(max(dot(g, g), 1e-20));
}
// Ray–AABB of the grid (object units): returns (t_near, t_far), t_near > t_far for a miss.
vec2 volBox(vec3 o, vec3 d) {
  vec3 bmin = uVolGridMin, bmax = uVolGridMin + (uVolGridN - 1.0) * uVolGridH;
  vec3 inv = 1.0 / mix(d, vec3(1e-7), lessThan(abs(d), vec3(1e-7)));
  vec3 ta = (bmin - o) * inv, tb = (bmax - o) * inv;
  vec3 tn = min(ta, tb), tf = max(ta, tb);
  return vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}

// ---- Recorded shading (monochrome, baked): albedo·(ambient·AO + Lambert·soft shadow), recording light uVolRecLight;
// the hologram exposure is set on the highlights (a face lit at ≈ 50° reaches R ≈ 1, clamped).
float volAO(vec3 P, vec3 n, float s) {
  float occ = 0.0, w = 1.0;
  for (int i = 1; i <= 4; ++i) {
    float h = s * float(i);
    occ += w * max(h - volSdf(P + n * h), 0.0);
    w *= 0.7;
  }
  return clamp(1.0 - 1.6 * occ / s, 0.0, 1.0);
}
float volShadow(vec3 P, vec3 L) {
  vec2 tb = volBox(P, L);
  float res = 1.0, t = 2.0 * uVolGridH;
  for (int i = 0; i < uVolShadowSteps; ++i) {
    if (t > tb.y) break;
    float h = volSdf(P + L * t);
    res = min(res, 6.0 * h / t);
    if (res < 0.02) break;
    t += clamp(h, 0.5 * uVolGridH, 0.08);
  }
  return clamp(res, 0.0, 1.0);
}
float volRecorded(vec3 P, float rObj) {
  float e = max(uVolGridH, rObj);
  vec3 n = volNormal(P, e);
  // A cone trace stops up to one cone radius inside the surface: project the point back onto it (one Newton step along
  // the gradient) before the shadow and AO rays start, else they start inside the object and read black.
  P -= n * volSdf(P);
  float diff = max(dot(n, uVolRecLight), 0.0);
  float sh = (uVolShadowSteps > 0 && diff > 0.0) ? volShadow(P + n * (1.5 * uVolGridH), uVolRecLight) : 1.0;
  float ao = volAO(P, n, max(0.012, 0.5 * e));
  // At the cone's scale the image is an average: shadow and AO detail finer than the cone blur toward their means (and
  // a cone wider than a thin feature would otherwise start their rays inside it).
  float keep = 1.0 / (1.0 + sq(rObj / 0.02));
  sh = mix(0.75, sh, keep);
  ao = mix(0.85, ao, keep);
  return min(1.3 * (0.24 * ao + 0.76 * diff * sh * mix(1.0, ao, 0.4)), 1.0);
}

// ---- Laser speckle: a complex Gaussian field (bilinear blend of hashed complex normals, renormalised, so |A|²/2 is
// exactly exponential with mean 1) on the image plane ⟂ π̂′ in grain units, blended over a lattice of directions of
// pitch VOL_DECORR, so the pattern "boils" as the eye or the light moves.
vec2 volSpkField(vec2 s, uint salt) {
  vec2 i = floor(s), f = s - i;
  ivec2 c = ivec2(i);
  vec2 a00 = gauss2(rnd3(c, salt).xy), a10 = gauss2(rnd3(c + ivec2(1, 0), salt).xy);
  vec2 a01 = gauss2(rnd3(c + ivec2(0, 1), salt).xy), a11 = gauss2(rnd3(c + ivec2(1, 1), salt).xy);
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  return (w.x * a00 + w.y * a10 + w.z * a01 + w.w * a11) * inversesqrt(max(dot(w, w), 1e-6));
}
float volSpeckle(vec3 Pbox, vec3 d) {
  vec3 e1 = cross(vec3(0.0, 1.0, 0.0), d);
  e1 *= inversesqrt(max(dot(e1, e1), 1e-8));
  vec3 e2 = cross(d, e1);
  vec2 s = vec2(dot(Pbox, e1), dot(Pbox, e2)) / VOL_GRAIN_MM;
  vec2 q = d.xy / VOL_DECORR, qi = floor(q), qf = q - qi;
  ivec2 qc = ivec2(qi) + 4096;
  vec2 A = vec2(0.0); float ww = 0.0;
  uint seed = uint(uVolSeed) * 0x27D4EB2Du;
  for (int k = 0; k < 4; ++k) {
    ivec2 o = ivec2(k & 1, k >> 1);
    float w = (o.x == 1 ? qf.x : 1.0 - qf.x) * (o.y == 1 ? qf.y : 1.0 - qf.y);
    uint salt = seed ^ (uint(qc.x + o.x) * 0x9E3779B1u) ^ (uint(qc.y + o.y) * 0x85EBCA77u);
    A += w * volSpkField(s, salt);
    ww += w * w;
  }
  A *= inversesqrt(max(ww, 1e-6));
  return 0.5 * dot(A, A);
}

// ---- Backdrop (recorded plane at depth uVolBackdrop.y): grid lines or a star field, box-filtered at blur radius b [mm].
float volBand(float d, float hw, float b) { return clamp((min(d + hw, b) - max(d - hw, -b)) / (2.0 * b), 0.0, 1.0); }
float volBackdropAt(vec2 xy, float b) {
  int mode = int(uVolBackdrop.x + 0.5);
  float fade = 1.0 - smoothstep(26.0, 44.0, length(xy));
  if (mode == 1) {
    const float PITCH = 4.0, HW = 0.11;
    vec2 g = xy / PITCH, dl = (g - floor(g + 0.5)) * PITCH;     // signed distance to the nearest line, per axis
    float line = max(volBand(dl.x, HW, b), volBand(dl.y, HW, b));
    return fade * 0.2 * line;
  }
  if (mode == 2) {
    const float CELL = 2.6;
    vec2 cf = xy / CELL;
    ivec2 c0 = ivec2(floor(cf));
    float acc = 0.0;
    for (int j = -1; j <= 1; ++j) for (int i = -1; i <= 1; ++i) {
      ivec2 c = c0 + ivec2(i, j);
      vec3 h = rnd3(c, uint(uVolSeed) ^ 0x57A4F000u);
      if (h.z > 0.55) continue;
      vec3 h2 = rnd3(c, uint(uVolSeed) ^ 0x57A4F100u);
      vec2 ctr = (vec2(c) + 0.2 + 0.6 * h.xy) * CELL;
      float r = mix(0.05, 0.2, h2.x * h2.x), s2 = r * r + b * b;
      acc += (0.35 + 0.65 * h2.y) * (r * r / s2) * exp(-0.5 * dot(xy - ctr, xy - ctr) / s2);
    }
    return fade * min(acc, 1.0);
  }
  return 0.0;
}

// ---- The recorded image along a replayed direction.
struct VolImg {
  float R;      // recorded radiance (object, backdrop and scatter floor; speckle applied) in [0, ~1]
  float cov;    // cone coverage of the object (0 = the ray missed it)
  float tMm;    // ray parameter of the hit [mm] (backdrop: its plane)
};
// o: surface point in the box [mm] (z = 0), d: π̂′ (unit, z < 0), tanA: cone half-angle tangent, rPx: pixel radius
// [mm]. shade = false: coverage only (rainbow side taps), R = cov.
VolImg volTrace(vec3 o, vec3 d, float tanA, float rPx, bool shade) {
  VolImg r; r.R = 0.0; r.cov = 0.0; r.tMm = 0.0;
  float size = max(uVolPose.w, 1e-3);
  vec3 oo = uVolRotT * (o - uVolPose.xyz) / size;
  vec3 dd = uVolRotT * d;
  float covMax = 0.0, tBest = 0.0;
  if (uVolLoaded != 0) {
    vec2 tb = volBox(oo, dd);
    if (tb.x < tb.y) {
      float t = tb.x, r0 = rPx / size;
      for (int i = 0; i < uVolSteps; ++i) {
        float dist = volSdf(oo + dd * t);
        float rc = r0 + abs(t) * tanA;                            // cone radius [object units]
        float c = clamp(0.5 - 0.5 * dist / rc, 0.0, 1.0);
        if (c > covMax) { covMax = c; tBest = t; }
        if (c >= 0.999) break;
        t += max(dist, 0.3 * rc);
        if (t > tb.y) break;
      }
    }
  }
  float tBg = uVolBackdrop.y / min(d.z, -1e-3);                   // backdrop plane z = depth (d.z < 0)
  if (covMax > 0.0 && tBest * size > tBg) covMax = 0.0;           // the object lies behind the backdrop plane
  r.cov = covMax;
  r.tMm = covMax > 0.0 ? tBest * size : tBg;
  if (!shade) { r.R = covMax; return r; }
  float Ro = 0.0;
  if (covMax > 0.0) Ro = volRecorded(oo + dd * tBest, rPx / size + abs(tBest) * tanA);
  float Rb = covMax < 1.0 ? volBackdropAt(o.xy + d.xy * tBg, rPx + tBg * tanA) : 0.0;
  float R = mix(Rb, Ro, covMax);
  // speckle of the recorded image at the visible point (object or backdrop line, not the scatter floor); contrast
  // reduced by the pixel footprint and the source size (incoherent average)
  vec3 Pb = o + d * r.tMm;
  float nAvg = (1.0 + sq(rPx / VOL_GRAIN_MM)) * (1.0 + sq(tanA / (2.0 * VOL_DECORR)));
  float C = uVolSpeckle * inversesqrt(nAvg);
  if (C > 0.003 && R > 0.0) R *= 1.0 + C * (volSpeckle(Pb, d) - 1.0);
  r.R = R + VOL_NOISE;
  return r;
}

// ---- A10 holographic stereogram: uVolRec = (0 optical / 1 stereogram, N views, blend, zone half-angle Z [rad]). A
// stereogram is recorded from N discrete camera views across ±Z, so the image at a film point is the nearest view's
// (orthographic) picture: R is looked up along the nearest view direction instead of π̂′ (both axes for reflection,
// horizontal only for rainbow, whose vertical maps to colour; the edge view beyond the zone). The image holds still
// within a view and steps at the boundaries; within blend·(view spacing) of a boundary the neighbouring view is traced
// too and mixed in (a ghosted double image). The recorded backdrops step with it; the A10 diffractive patterns do not
// (surface gratings, not recorded).
uniform vec4 uVolRec;
uniform float uVolGlare;      // A12 surface glare (1 = the physical mirror and cover film)
VolImg volTraceRec(vec3 o, vec3 d, vec3 dv, float tanA, float rPx) {
  // A12: the view is chosen from dv, the replayed direction at the hologram's centre, so the whole image steps at once
  // (felt in time as the card moves) instead of a view boundary sweeping across the surface as a spatial tear; λ, the
  // window and the brightness stay those of the pixel's own continuous replay (volReplay).
  if (uVolRec.x < 0.5) return volTrace(o, d, tanA, rPx, true);
  float N = max(uVolRec.y, 1.0), Z = uVolRec.w, dl = 2.0 * Z / N, hb = 0.5 * uVolRec.z;
  bool both = uVolType == 0;
  vec2 a = vec2(atan(dv.x, -dv.z), atan(dv.y, -dv.z));
  vec2 s = clamp((a + Z) / dl - 0.5, 0.0, N - 1.0);               // view coordinate: centres at 0 … N − 1
  vec2 i0 = floor(s), t = s - i0;
  vec2 w = hb > 0.0 ? smoothstep(vec2(0.5 - hb), vec2(0.5 + hb), t) : step(vec2(0.5), t);   // weight of view i0 + 1
  vec2 ip = i0 + step(vec2(0.5), w);                              // the nearest view
  vec2 amb = min(w, 1.0 - w);                                     // the neighbour's weight per axis
  if (!both) amb.y = 0.0;
  bool ux = amb.x >= amb.y;                                       // ghost along the more ambiguous axis only
  vec2 is = ip + (ux ? vec2(w.x >= 0.5 ? -1.0 : 1.0, 0.0) : vec2(0.0, w.y >= 0.5 ? -1.0 : 1.0));
  float m2 = ux ? amb.x : amb.y;
  vec2 ap = (ip + 0.5) * dl - Z, as2 = (is + 0.5) * dl - Z;
  float ay = atan(d.y, -d.z);                                     // rainbow: the vertical stays the pixel's own (colour axis)
  if (!both) { ap.y = ay; as2.y = ay; }
  VolImg r = volTrace(o, normalize(vec3(tan(ap), -1.0)), tanA, rPx, true);
  if (m2 > 0.02) {
    VolImg r2 = volTrace(o, normalize(vec3(tan(as2), -1.0)), tanA, rPx, true);
    r.R = mix(r.R, r2.R, m2); r.cov = mix(r.cov, r2.cov, m2); r.tMm = mix(r.tMm, r2.tMm, m2);
  }
  return r;
}
// A12: the weight left for the traced replays when more candidates than traces exist — the largest weight that is NOT
// traced (the (n + 1)-th largest; 0 when every candidate is traced). Subtracting it from the traced weights makes the
// choice of which replays are traced continuous across the surface (no seam where two lights swap rank).
float volNextWeight(float w[MAX_LIGHTS + 1], int n) {
  for (int k = 0; k < n; ++k) {
    int best = 0;
    for (int j = 1; j <= MAX_LIGHTS; ++j) if (w[j] > w[best]) best = j;
    w[best] = 0.0;
  }
  float m = 0.0;
  for (int j = 0; j <= MAX_LIGHTS; ++j) m = max(m, w[j]);
  return m;
}

// ---- The replay of one light (addendum A9 moved it here from holo_volume.frag, unchanged, so that the hologram sticker of
// the Foil Emboss material replays with the same maths)
const float VOL_RAINBOW_EFF = 0.3;      // embossed relief: first-order efficiency relative to the volume hologram
const float VOL_SIGMA_H = 0.6;          // rainbow: horizontal viewing-zone σ [rad]
const float VOL_SLIT_D = 330.0;         // rainbow: slit image distance in front of the content centre [mm]
const float VOL_SLIT_H = 23.08;         // rainbow: slit height above the centre, D·tan 4° [mm] (physics/volume.ts)
const float VOL_BACKING = 0.015;        // reflection: black backing, diffuse reflectance
const float VOL_NC = 1.5;               // cover film / lacquer index
// The diffracted power goes only into the recorded light (object + backdrop), not into a uniform field: the image
// radiance scales with 1/(mean recorded radiance over the window). A constant estimate of that mean (object and
// backdrop fill ≈ 40 % of a window at full brightness) stands in for the per-pixel integral.
const float VOL_FILL = 0.4;

float volRAl(float lam) { return 0.889 - 1.25e-4 * (clamp(lam, 380.0, 780.0) - 450.0); }

// The replay of one light (film-frame light l, eye v): π̂′, λ, the weight w (η × window × gain), the colour band
// (amplitude √(2π)σ_amp, colour width σ_col) and the cone tangent (source size + dispersion). ok = 0: nothing replayed.
struct VolReplay { vec3 pi; float lam, w, amp, sigCol, tanA, ok; };
VolReplay volReplay(vec3 l, vec3 v, float rAng, vec2 pb) {
  VolReplay r;
  float ok, lam;
  float tanSrc = tan(min(rAng, 1.2));
  if (uVolType == 0) {
    r.pi = volBragg(uVolRef, l, v, uVolLambda.x, lam, ok);
    float sw = uVolSel.x, th = asin(min(length(r.pi.xy), 1.0));
    r.w = uVolEff * exp(-0.5 * sq(th / sw)) / (2.0 * sw * sw * VOL_FILL);
    float sB = uVolLambda.y * lam / uVolLambda.x;                 // constant relative bandwidth Λ/T
    r.amp = 2.50662827 * sB / volRAl(lam);                        // the tables carry R_Al: a volume hologram has none
    r.sigCol = sB;
    float disp = length(v.xy + l.xy) * sB / max(lam, 1.0);        // |∂π̂′/∂λ|·σ
    r.tanA = sqrt(tanSrc * tanSrc + disp * disp);
  } else {
    float dy = pb.y - VOL_SLIT_H, piY0 = dy * inversesqrt(dy * dy + VOL_SLIT_D * VOL_SLIT_D);
    r.pi = volRainbow(uVolRef, l, v, uVolLambda.x, piY0, lam, ok);
    float sv = uVolSel.y, den = max(abs(uVolRef.y - piY0), 1e-3);
    float sS = lam * sv / den;                                    // slit band σ [nm]
    float sSrc = lam * 0.70710678 * rAng / max(abs(v.y + l.y), 1e-3);   // λ_c spread over the source's height
    float thx = asin(clamp(r.pi.x, -1.0, 1.0));
    r.w = uVolEff * VOL_RAINBOW_EFF * exp(-0.5 * sq(thx / VOL_SIGMA_H)) / (2.0 * sv * VOL_SIGMA_H * VOL_FILL);
    r.amp = 2.50662827 * sS;
    r.sigCol = sqrt(sS * sS + sSrc * sSrc);
    float disp = abs(v.x + l.x) * r.sigCol / max(lam, 1.0);
    r.tanA = sqrt(tanSrc * tanSrc + sv * sv + disp * disp);       // the slit width smears depth vertically
  }
  if (!(lam > 360.0 && lam < 830.0)) ok = 0.0;
  r.lam = lam; r.ok = ok;
  if (ok <= 0.0) r.w = 0.0;
  // A12: no hard cut-offs across the surface — the replay fades toward the evanescent limit, toward grazing light or
  // eye and toward the ends of the visible band (each was a step from full weight to nothing: a visible seam)
  r.w *= (1.0 - smoothstep(0.85, 0.9999, dot(r.pi.xy, r.pi.xy))) * smoothstep(0.0, 0.1, l.z) * smoothstep(0.0, 0.1, v.z)
       * smoothstep(360.0, 390.0, lam) * (1.0 - smoothstep(790.0, 830.0, lam));
  return r;
}

// ===== A10 diffractive backdrop patterns (addendum A10) =====
// The backdrops seal … sparkle (uVolBackdrop.x ≥ 3) are not recorded in the volume hologram: they are surface-relief line
// gratings (metallised, as on real 2D/3D security labels) on a plane at depth uVolPat2.z behind the film, seen along the
// eye ray (parallax) and masked where the subject covers that ray. Every line family carries its own grating vector ĝ
// (its line normal: the grooves run along the lines; crossing families differ, a curved line turns its ĝ along its
// length), so under a light each family is seen only where the first-order grating equation (ℓ̂ + v̂)ₜ = (λ/Λ)·ĝ holds
// within the light's size and the groove fan: it flashes its own colour at its own tilt, and the rainbow rolls along a
// curved line as the card tilts. Colour: elemOrders' first-order lobe (grating.glsl) with the shared tables.
// Patterns are analytic phase fields u(x) whose integer level sets are the lines: coverage = the band |u − round(u)| <
// w/2 box-filtered over the blur radius in phase units (b·|∇u|), fading into the mean coverage w once the spacing nears
// two blur radii (≈ 2 px), so dense line families never alias or moiré.
// Uniforms (volume.params.ts patternUniformValues): uVolPat = (R [mm], line width w [fraction of the spacing],
// 1/Λ [nm⁻¹], strength), uVolPat2 = (cos θ, sin θ, plane depth [mm] ≤ 0, 0). Tier define VOL_PAT_SLOTS (3 / 2).
uniform vec4 uVolPat;
uniform vec4 uVolPat2;
#ifndef VOL_PAT_SLOTS
#define VOL_PAT_SLOTS 3
#endif
const float VOL_PAT_FILL = 0.03;        // faint concentric fill grating between the lines (coverage)
const float VOL_PAT_H = 110.0;          // relief depth [nm]: J₁² near its maximum at 550 nm
const float VOL_PAT_SIGS = 0.0044;      // metal micro-slope σ [rad] (0.25°)
const float VOL_PAT_FAN = 0.1;          // along-groove fan σ [q] (≈ 6°: the lit arc of a curved line)

// Slots: 0 and 1 the (crossing) line families, 2 the concentric layer (ring lines + fill, ĝ radial).
struct VolPat { vec3 m; vec2 g0, g1, g2; vec3 k; };                // coverage, ĝ (pattern frame), pitch multipliers
struct VolPatHit { vec3 m; vec2 g0, g1, g2; vec3 invD; float cov; };   // coverage × strength, ĝ (content frame), 1/Λ, subject coverage along the eye ray

VolPatHit volPatNone() {
  VolPatHit h; h.m = vec3(0.0); h.g0 = vec2(1.0, 0.0); h.g1 = h.g0; h.g2 = h.g0; h.invD = vec3(1e-3); h.cov = 0.0;
  return h;
}
// Line coverage of the integer level sets of a phase u, |∇u| = gl [mm⁻¹], width w spacings, blur radius b [mm].
float volLines(float u, float gl, float w, float b) {
  float bu = max(b * gl, 1e-4);
  return mix(volBand(u - floor(u + 0.5), 0.5 * w, bu), w, smoothstep(0.2, 0.45, bu));
}
// Box-filtered disc of radius rd at distance dist (area kept once the blur exceeds the disc).
float volDot(float dist, float rd, float b) {
  float re = max(rd, b);
  return sq(rd / re) * clamp(0.5 + (re - dist) / (2.0 * b), 0.0, 1.0);
}
void volPatSet(inout VolPat P, int s, float m, vec2 g) {
  if (s == 0) { if (m > P.m.x) { P.m.x = m; P.g0 = g; } }
  else if (s == 1) { if (m > P.m.y) { P.m.y = m; P.g1 = g; } }
  else P.m.z = max(P.m.z, m);
}
// A family (phase u, gradient gr [mm⁻¹]) into slot s, gated by a band mask.
void volPatPut(inout VolPat P, int s, float u, vec2 gr, float w, float b, float gate) {
  float gl = length(gr);
  if (gate <= 0.0 || gl < 1e-6) return;
  volPatSet(P, s, gate * volLines(u, gl, w, b), gr / gl);
}
// The two families of N circles of radius a centred on the circle of radius c (guilloche spirograph): through (r, θ)
// pass the members at azimuths θ ∓ acos X, X = (r² + c² − a²)/(2rc), so u± = N(θ ∓ acos X)/2π; the annulus
// |c − a| ≤ r ≤ c + a. er, et: radial and tangential unit vectors.
void volCircles(inout VolPat P, float r, float th, vec2 er, vec2 et, float c, float a, float N, float w, float b) {
  float X = (r * r + c * c - a * a) / (2.0 * r * c);
  if (abs(X) >= 1.0) return;
  float k = N / TAU, al = acos(X), s = max(sqrt(1.0 - X * X), 1e-4);
  vec2 gT = (k / r) * et, gR = (k * (r * r - c * c + a * a) / (2.0 * r * r * c * s)) * er;
  volPatPut(P, 0, k * (th - al), gT + gR, w, b, 1.0);
  volPatPut(P, 1, k * (th + al), gT - gR, w, b, 1.0);
}
float volAnnulus(float r, float r0, float r1, float b) { return volBand(r - 0.5 * (r0 + r1), 0.5 * (r1 - r0), b); }

// seal (reference: a guilloche seal of concentric bands): spirograph core, dotted ring, rope, zig-zag lattice band,
// coin-edge ticks, ring outlines
void volPatSeal(inout VolPat P, float r, float th, vec2 er, vec2 et, float R, float w, float b) {
  float rho = r / R, hw = 0.027 * w * R, ring = 0.0;
  if (rho < 0.51) volCircles(P, r, th, er, et, 0.25 * R, 0.25 * R, 36.0, w, b);   // 36 circles through the centre
  ring = max(ring, volBand(r - 0.515 * R, hw, b));
  if (abs(rho - 0.545) < 0.03) {                                  // 96 dots, ĝ tangential
    float Nd = 96.0, cell = th * Nd / TAU, dth = (cell - floor(cell + 0.5)) * TAU / Nd;
    volPatSet(P, 0, volDot(length(vec2(r - 0.545 * R, r * dth)), 0.0085 * R, b), et);
  }
  ring = max(ring, volBand(r - 0.575 * R, hw, b));
  if (abs(rho - 0.62) < 0.04) {                                   // rope: 64 slanted S-strokes
    float h = 0.03 * R, s = (r - 0.62 * R) / h, k = 64.0 / TAU;
    volPatPut(P, 1, k * th + 1.3 * s + 0.4 * s * s * s, (k / r) * et + ((1.3 + 1.2 * s * s) / h) * er,
              min(2.2 * w, 0.85), b, volAnnulus(r, 0.59 * R, 0.65 * R, b));
  }
  ring = max(ring, max(volBand(r - 0.59 * R, hw, b), volBand(r - 0.65 * R, hw, b)));
  ring = max(ring, max(volBand(r - 0.672 * R, hw, b), volBand(r - 0.688 * R, hw, b)));
  if (rho > 0.69 && rho < 0.85) {                                 // zig-zag lattice band: 48 + 48 crossing strokes
    float k = 48.0 / TAU, hb = 0.14 * R, s = (r - 0.70 * R) / hb;
    float gate = volAnnulus(r, 0.70 * R, 0.84 * R, b);
    vec2 gT = (k / r) * et, gR = (1.0 / hb) * er;
    volPatPut(P, 0, k * th + s, gT + gR, w, b, gate);
    volPatPut(P, 1, k * th - s, gT - gR, w, b, gate);
  }
  ring = max(ring, max(volBand(r - 0.70 * R, hw, b), volBand(r - 0.84 * R, hw, b)));
  if (rho > 0.85 && rho < 1.0) {                                  // coin-edge rim: 120 radial ticks
    float k = 120.0 / TAU;
    volPatPut(P, 0, k * th, (k / r) * et, min(2.0 * w, 0.7), b, volAnnulus(r, 0.865 * R, 0.985 * R, b));
  }
  ring = max(ring, max(volBand(r - 0.855 * R, hw, b), volBand(r - R, 1.6 * hw, b)));
  volPatSet(P, 2, ring, er);
}
// rosette (reference: certificate guilloche): nested spirograph zones, scalloped wavy-ring meshes outside
void volPatRosette(inout VolPat P, float r, float th, vec2 er, vec2 et, float R, float w, float b) {
  float rho = r / R, hw = 0.027 * w * R;
  if (rho < 0.16) volCircles(P, r, th, er, et, 0.08 * R, 0.08 * R, 24.0, w, b);
  else if (rho < 0.36) volCircles(P, r, th, er, et, 0.10 * R, 0.26 * R, 40.0, w, b);
  else if (rho < 0.86) volCircles(P, r, th, er, et, 0.36 * R, 0.50 * R, 72.0, w, b);
  else {
    bool inner = rho < 1.25;
    float s = (inner ? 0.045 : 0.05) * R, A = inner ? 1.6 : 2.2, n = inner ? 12.0 : 24.0, r0 = (inner ? 0.86 : 1.25) * R;
    float sw = A * sin(n * th), cw = A * n * cos(n * th) / r;
    volPatPut(P, 0, (r - r0) / s + sw, er / s + cw * et, w, b, 1.0);
    volPatPut(P, 1, (r - r0) / s - sw, er / s - cw * et, w, b, 1.0);
  }
  float ring = max(volBand(r - 0.16 * R, hw, b), volBand(r - 0.36 * R, hw, b));
  ring = max(ring, max(volBand(r - 0.86 * R, 1.5 * hw, b), volBand(r - 1.25 * R, 1.5 * hw, b)));
  volPatSet(P, 2, ring, er);
}
// spiral (reference: a security-hologram vortex): two crossing logarithmic-spiral families, θ ∓ ln(r/R)/κ
void volPatSpiral(inout VolPat P, float r, float th, vec2 er, vec2 et, float R, float w, float b) {
  float k = 60.0 / TAU, lr = log(r / R);
  volPatPut(P, 0, k * (th - lr / 0.45), (k / r) * (et - er / 0.45), w, b, 1.0);
  volPatPut(P, 1, k * (th + lr / 0.8), (k / r) * (et + er / 0.8), w, b, 1.0);
}
// lattice (reference: a round security sticker's diamond field): two straight families at ±55°, gently bulged (a
// radial lens warp p·f(ρ), f = 1 + β·exp(−ρ²))
void volPatLattice(inout VolPat P, vec2 q, float R, float w, float b) {
  vec2 p = q / R;
  float e = exp(-dot(p, p)), f = 1.0 - 0.22 * e, fr = 0.44 * e, s = 0.075;
  vec2 n0 = vec2(0.57357644, 0.81915204), n1 = vec2(0.57357644, -0.81915204);
  volPatPut(P, 0, f * dot(p, n0) / s, (f * n0 + fr * dot(p, n0) * p) / (s * R), w, b, 1.0);
  volPatPut(P, 1, f * dot(p, n1) / s, (f * n1 + fr * dot(p, n1) * p) / (s * R), w, b, 1.0);
}
// sunburst: 90 rays, 90 short in-between rays, rings
void volPatSunburst(inout VolPat P, float r, float th, vec2 er, vec2 et, float R, float w, float b) {
  float k = 90.0 / TAU;
  volPatPut(P, 0, k * th, (k / r) * et, w, b, 1.0);
  volPatPut(P, 1, k * th + 0.5, (k / r) * et, w, b, volAnnulus(r, 0.3 * R, 0.9 * R, b));
  float s = 0.1 * R;
  volPatPut(P, 2, r / s, er / s, 0.8 * w, b, 1.0);
}
// sparkle: dot-matrix glitter — two layers of random dots, each with a random grating azimuth and pitch
void volPatSparkle(inout VolPat P, vec2 q, float R, float w, float b) {
  for (int l = 0; l < 2; ++l) {
    float cell = (l == 0 ? 0.05 : 0.083) * R;
    ivec2 c = ivec2(floor(q / cell));
    uint salt = uint(uVolSeed) ^ (l == 0 ? 0x5A2C1000u : 0x5A2C2000u);
    vec3 h = rnd3(c, salt);
    if (h.z > (l == 0 ? 0.5 : 0.3)) continue;
    vec3 h2 = rnd3(c, salt ^ 0x00000100u);
    vec2 ctr = (vec2(c) + 0.3 + 0.4 * h.xy) * cell;
    float m = volDot(length(q - ctr), mix(0.12, 0.28, h2.x) * cell * clamp(w / 0.22, 0.4, 1.0), b);
    float a = PI * h2.y;
    volPatSet(P, l, m, vec2(cos(a), sin(a)));
    if (l == 0) P.k.x = mix(0.8, 1.25, h2.z); else P.k.y = mix(0.8, 1.25, h2.z);
  }
}

// The pattern at a film point: o the point in the content box [mm], e the eye in the film frame (z > 0), rPx the pixel
// radius [mm]. The eye ray −e meets the pattern plane; the subject (a coverage-only trace along that ray) masks it.
VolPatHit volPatAt(vec2 o, vec3 e, float rPx) {
  VolPatHit h = volPatNone();
  int mode = int(uVolBackdrop.x + 0.5);
  if (mode < 3 || e.z <= 0.02 || uVolPat.w <= 0.0) return h;
  vec3 d = -e;
  // A12: the subject's coverage is returned, not applied: the mains hide the pattern behind the subject only as far as
  // the subject's image is actually replayed (volPatMask), so a dark subject never punches a black hole
  h.cov = uVolLoaded != 0 ? volTrace(vec3(o, 0.0), d, 0.003, rPx, false).cov : 0.0;
  float t = uVolPat2.z / d.z;
  vec2 xy = o + d.xy * t;
  float b = rPx + 0.002 * t;
  vec2 q = vec2(uVolPat2.x * xy.x + uVolPat2.y * xy.y, -uVolPat2.y * xy.x + uVolPat2.x * xy.y);   // pattern frame
  float R = uVolPat.x, w = uVolPat.y;
  float r = max(length(q), 1e-3);
  vec2 er = q / r, et = vec2(-er.y, er.x);
  float th = atan(q.y, q.x);
  VolPat P; P.m = vec3(0.0); P.g0 = et; P.g1 = et; P.g2 = er; P.k = vec3(1.0, 0.9, 1.15);
  if (mode == 3) volPatSeal(P, r, th, er, et, R, w, b);
  else if (mode == 4) volPatRosette(P, r, th, er, et, R, w, b);
  else if (mode == 5) volPatSpiral(P, r, th, er, et, R, w, b);
  else if (mode == 6) volPatLattice(P, q, R, w, b);
  else if (mode == 7) volPatSunburst(P, r, th, er, et, R, w, b);
  else volPatSparkle(P, q, R, w, b);
  P.m.z = max(P.m.z, VOL_PAT_FILL);
#if VOL_PAT_SLOTS < 3
  if (P.m.y > P.m.x) { P.m.x = P.m.y; P.g0 = P.g1; P.k.x = P.k.y; }  // lower tiers: the dominant crossing family
  P.m.y = 0.0;
#endif
  h.m = P.m * uVolPat.w;
  vec2 cs = uVolPat2.xy;                                          // back to the content frame
  h.g0 = vec2(cs.x * P.g0.x - cs.y * P.g0.y, cs.y * P.g0.x + cs.x * P.g0.y);
  h.g1 = vec2(cs.x * P.g1.x - cs.y * P.g1.y, cs.y * P.g1.x + cs.x * P.g1.y);
  h.g2 = vec2(cs.x * P.g2.x - cs.y * P.g2.y, cs.y * P.g2.x + cs.x * P.g2.y);
  h.invD = uVolPat.z / P.k;
  return h;
}

// First order (m = ±1: the sign whose λ is real) of the pattern's slots under light g — elemOrders' lobe (§4.4.3) for
// m = 1: λ* = Λ·|q_g| conditional on q_t, the along-groove Gaussian in q_t (light footprint + kernels + fan + micro-
// slope), J₁² of the relief VOL_PAT_H, the shared tables (S·R_Al·CMF of the light's SPD), × each slot's coverage.
// Vp: refracted view (VOL_NC); n: film normal; X0, Y0: the content frame's axes (world); Sc: kernels in (T, B).
vec3 volPatLight(GLight g, vec3 Vp, vec3 n, vec3 X0, vec3 Y0, VolPatHit h, mat2 Sc, vec3 T, vec3 B, float Tc) {
  if (g.A <= 0.0) return vec3(0.0);
  vec3 Lp = refractIn(g.L, n, VOL_NC);
  float ciIn = dot(n, Lp), coIn = dot(n, Vp);
  if (ciIn <= 0.0 || coIn <= 0.0) return vec3(0.0);
  vec3 H = VOL_NC * (Lp + Vp);
  float iso2 = sq(dot(H, n) * VOL_PAT_SIGS);
  mat2 S = Sc + g.S;
  vec3 acc = vec3(0.0);
  for (int s = 0; s < 3; ++s) {
#if VOL_PAT_SLOTS < 3
    if (s == 1) continue;
#endif
    float m = s == 0 ? h.m.x : s == 1 ? h.m.y : h.m.z;
    if (m < 1e-4) continue;
    vec2 gc = s == 0 ? h.g0 : s == 1 ? h.g1 : h.g2;
    vec3 gv = gc.x * X0 + gc.y * Y0;
    gv = normalize(gv - n * dot(gv, n));
    vec3 t = cross(n, gv);
    float qg = dot(H, gv), qt = dot(H, t);
    mat2 R = mat2(dot(T, gv), dot(T, t), dot(B, gv), dot(B, t));
    mat2 Sx = R * S * transpose(R);
    float sgg = max(Sx[0][0] + iso2, 1e-10), stt = max(Sx[1][1] + iso2 + VOL_PAT_FAN * VOL_PAT_FAN, 1e-10), sgt = Sx[0][1];
    float qgc = qg - (sgt / stt) * qt, sgc = sqrt(max(sgg - sgt * sgt / stt, 1e-10));
    float d = 1.0 / (s == 0 ? h.invD.x : s == 1 ? h.invD.y : h.invD.z);
    float lam = d * abs(qgc), sigL = clamp(d * sgc, 0.5, 512.0);
    if (lam + 3.0 * sigL < 360.0 || lam - 3.0 * sigL > 830.0) continue;
    float n1 = exp(-0.5 * qt * qt / stt) * inversesqrt(TAU * stt);
    acc += m * n1 * d * lobeColour(1, lam, sigL, VOL_PAT_H, VOL_NC, ciIn, coIn, vec4(1.0), g.spd);
  }
  return g.rad * g.A * Tc * acc;
}

// A12: the pattern behind the subject — hidden by the subject's coverage along the eye ray only where its replayed image
// is there (image luminance against the pattern's): Lpat·(1 − cov·a), a = L_img/(L_img + ½L_pat).
vec3 volPatMask(vec3 Lpat, vec3 Limg, float cov) {
  float li = dot(Limg, LUMA_SRGB), lp = dot(Lpat, LUMA_SRGB);
  return Lpat * (1.0 - cov * li / (li + 0.5 * lp + 1e-5));
}
// A12 surface glare g = uVolGlare: the zero order's share (embossed relief: weaker, hazier mirror), the cover film's
// glint and the soft limit of the mirrored highlight relative to a white diffuser's radiance under the same light.
float volGlareMirror() { return mix(0.08, 1.0, uVolGlare); }
float volGlareCoat() { return mix(0.3, 1.0, uVolGlare); }
float volGlareSigS(float sigS) { return mix(0.05, sigS, uVolGlare); }
float volGlareLimit(vec3 Lspec, vec3 Ewhite) {
  if (uVolGlare >= 0.999) return 1.0;
  float cap = dot(Ewhite, LUMA_SRGB) / PI * (0.02 + 2.5 * uVolGlare) / (1.0 - uVolGlare);
  return 1.0 / (1.0 + dot(Lspec, LUMA_SRGB) / max(cap, 1e-6));
}
