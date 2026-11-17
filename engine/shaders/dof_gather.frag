// dof_gather.frag — A7 pass 6 (half resolution, two outputs): scatter-as-gather of the near and far fields.
//
// Each source s spreads its premultiplied radiance over r_s·K (its CoC radius times the aperture), with density
// I(t)/(r_s²·|K|) (the rim profile, mean 1: energy conserved). Pixel x collects every source whose disc reaches it.
// The samples are the aperture itself (lens.ts aperturePattern: a Vogel spiral warped onto the blade polygon, point i
// at k_i with gauge u_i and area weight ω_i), scaled to the gather radius R (the dilated tile maximum) and clipped by
// this pixel's cat's-eye vesica (g_i = max(u_i, vesica gauge) > 1: outside the vignetted pupil). Far-field bokeh are
// the inverted pupil, so the far loop reads x + R·k_i and the near loop x − R·k_i: odd blade counts point opposite
// ways in front of and behind the focus, as in a real lens. Source s at gauge distance d = R·g_i reaches x when
// d ≤ r_s (smoothly over the spiral's local spacing R/(2N·u_i)), and then carries the weight
//   w = I(d/r_s) · min(1, (R/r_s)²·ω_i/Ω),   Ω = N·|K|/|P| (the samples left inside the clipped pupil)
// — the exact kernel times the area the sample stands for, capped at one pixel's worth (a source smaller than the
// sample spacing is caught by the sample that lands on it, typically the centre). R, G and B use their own radius
// (LoCA, chanCoc). Colour is fetched from the mip level whose texel matches the sample spacing (a box prefilter: a
// sparse gather then integrates instead of aliasing), with the footprint's CoC, lowered at depth edges (gatherSample).
//
// Near field (CoC < 0, in front of the focus plane): an unnormalised sum — premultiplied colour and coverage A_n —
// composited over everything behind (composite pass), so blurred foreground spreads over sharp background and over the
// page (A_n is the foreground's blurred coverage).
// Far field (CoC ≥ 0, incl. in focus): normalised by the summed weight of what was reached. A sample behind the centre
// (larger CoC: farther) reaches it only within the centre's own CoC, so a blurred background never smears a sharper
// surface in front of it. The page is behind everything and has no radiance: the uncovered part (1 − α) of every
// sample is page, which adds normalisation weight only, reaching like the centre (the page centre: like R). A blurred
// silhouette thus fades into the page; the page far from any object stays exactly 0.
#define NMAX 64
uniform sampler2D tCol;             // dof_extract colour (premultiplied linear, coverage), mipmapped
uniform sampler2D tCoc;             // CoC [half px]
uniform sampler2D tTile;            // dilated tiles [full px]: r = near reach, g = far reach
uniform ivec2 uHalf;                // active half size
uniform vec2 uHalfAlloc;            // allocated half size (uv = px / uHalfAlloc)
uniform vec4 uPat[NMAX];            // (x, y, u, ω)
uniform int uN;                     // samples per field (TierConfig.dof.samples)
uniform float uMaxLod;
uniform float uRimFar, uRimNear;

layout(location = 0) out highp vec4 oNear;
layout(location = 1) out highp vec4 oFar;

vec2 uvOf(vec2 q) { return clamp(q, vec2(0.5), vec2(uHalf) - 0.5) / uHalfAlloc; }

// One gather sample: its prefiltered colour (premultiplied, coverage) and CoC. The footprint of mip level `lod` is
// treated as one source with the footprint's coverage-weighted CoC (so a glint that a sample's footprint catches
// spreads with its own CoC). Where the footprint straddles a depth edge — the sample's own (level 0) object CoC
// differs from the footprint's — the sample falls back to level 0: a blurred background never fetches the colour of a
// sharp surface in front of it through a coarse texel. The page has no CoC (cocOf): page and object mix freely
// (premultiplied colour and coverage are exact there).
vec4 gatherSample(vec2 uv, float lod, out float rs) {
  vec2 c0 = textureLod(tCoc, uv, 0.0).rg;
  vec2 cL = lod > 0.0 ? textureLod(tCoc, uv, lod).rg : c0;
  float r0 = cocOf(c0), rL = cL.y > 1e-4 ? cL.x / cL.y : r0;
  float e = c0.y > 0.02 ? smoothstep(0.5, 1.5, abs(rL - r0) / (0.25 * abs(r0) + 1.0)) : 0.0;
  rs = mix(rL, r0, e);
  return textureLod(tCol, uv, lod * (1.0 - e));
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  if (ip.x >= uHalf.x || ip.y >= uHalf.y) { oNear = vec4(0.0); oFar = vec4(0.0); return; }
  vec2 x = gl_FragCoord.xy;
  vec2 reach = texelFetch(tTile, ip / 8, 0).rg * 0.5;          // tiles of 16 full = 8 half px
  vec4 C0 = texelFetch(tCol, ip, 0);
  float r0 = cocOf(texelFetch(tCoc, ip, 0).rg);
  if (max(reach.x, reach.y) < 0.25) { oNear = vec4(0.0); oFar = C0; return; }
  vec2 b = catsB(x);
  float clip = max(clipArea(length(b)), 0.05);
  bool xNear = r0 < -0.25;
  float ax = clamp(C0.a, 0.0, 1.0);

  // ---------------- far field ----------------
  {
    float R = max(reach.y, 0.5);
    float N = float(uN), omega = N * clip;
    float lod = clamp(log2(R * sqrt(3.14159265 * uAreaRatio * clip / N)), 0.0, uMaxLod);
    float rampK = R / (2.0 * N);
    float rxReach = xNear ? 1e9 : max(r0, 0.0);                // the behind rule's limit
    float rPage = (xNear || ax < 0.02) ? R : max(r0, 0.5);    // the page reaches like the centre
    vec3 wsum = vec3(0.0), csum = vec3(0.0);
    float asum = 0.0;
    // the centre (gauge 0; it stands for half a spiral cell: the first spiral point sits at u = √(½/N)), prefiltered
    // like a ring sample of its own CoC (a nearly sharp centre keeps its detail)
    {
      float rc;
      vec4 Cc = gatherSample(uvOf(x), min(lod, max(log2(max(abs(r0), 0.5) * sqrt(3.14159265 * uAreaRatio * clip / N)), 0.0)), rc);
      if (!xNear) {
        vec3 rl = max(abs(chanCoc(max(r0, 0.0))), vec3(0.5));
        vec3 w = min(vec3(1.0), (R * R) / (rl * rl) * (0.5 / omega)) * rimProfile3(vec3(0.0), uRimFar);
        csum += w * Cc.rgb; asum += w.g * Cc.a; wsum += w * Cc.a;
      }
      wsum += min(1.0, (R * R) / (rPage * rPage) * (0.5 / omega)) * (1.0 - clamp(Cc.a, 0.0, 1.0));
    }
    for (int i = 0; i < NMAX; ++i) {
      if (i >= uN) break;
      vec4 k = uPat[i];
      float g = max(k.z, vesicaGauge(k.xy, b));
      if (g > 1.0) continue;
      float rs;
      vec4 S = gatherSample(uvOf(x + R * k.xy), lod, rs);       // far: the inverted pupil
      float d = R * g, ramp = max(rampK / max(k.z, 0.05), 0.5);
      float sa = clamp(S.a, 0.0, 1.0);
      float mp = clamp((rPage - d) / ramp + 0.5, 0.0, 1.0);
      wsum += mp * min(1.0, (R * R) / (rPage * rPage) * k.w / omega) * (1.0 - sa);
      if (rs < -0.25) continue;                                // near-field samples are the near layer's
      vec3 rl = max(abs(chanCoc(max(rs, 0.0))), vec3(0.5));
      float behind = xNear ? 0.0 : smoothstep(0.0, 1.0, rs - r0);
      vec3 lim = mix(rl, min(rl, vec3(max(rxReach, 0.5))), behind);
      vec3 m = clamp((lim - d) / ramp + 0.5, 0.0, 1.0);
      vec3 w = m * rimProfile3(d / rl, uRimFar) * min(vec3(1.0), (R * R) / (rl * rl) * (k.w / omega));
      csum += w * S.rgb; asum += w.g * sa; wsum += w * sa;
    }
    oFar = wsum.g > 1e-6 ? vec4(csum / max(wsum, vec3(1e-6)), asum / wsum.g) : C0;
  }

  // ---------------- near field ----------------
  vec3 cn = vec3(0.0);
  float an = 0.0;
  if (reach.x >= 0.25) {
    float R = max(reach.x, 0.5);
    float N = float(uN), omega = N * clip;
    float lod = clamp(log2(R * sqrt(3.14159265 * uAreaRatio * clip / N)), 0.0, uMaxLod);
    float rampK = R / (2.0 * N);
    if (xNear) {
      float rc;
      vec4 Cc = gatherSample(uvOf(x), min(lod, max(log2(max(abs(r0), 0.5) * sqrt(3.14159265 * uAreaRatio * clip / N)), 0.0)), rc);
      vec3 rl = max(abs(chanCoc(r0)), vec3(0.5));
      vec3 w = min(vec3(1.0), (R * R) / (rl * rl) * (0.5 / omega)) * rimProfile3(vec3(0.0), uRimNear);
      cn += w * Cc.rgb; an += w.g * clamp(Cc.a, 0.0, 1.0);
    }
    for (int i = 0; i < NMAX; ++i) {
      if (i >= uN) break;
      vec4 k = uPat[i];
      float g = max(k.z, vesicaGauge(k.xy, b));
      if (g > 1.0) continue;
      float rs;
      vec4 S = gatherSample(uvOf(x - R * k.xy), lod, rs);       // near: the upright pupil
      if (rs >= -0.25) continue;
      float d = R * g, ramp = max(rampK / max(k.z, 0.05), 0.5);
      vec3 rl = max(abs(chanCoc(rs)), vec3(0.5));
      vec3 m = clamp((rl - d) / ramp + 0.5, 0.0, 1.0);
      vec3 w = m * rimProfile3(d / rl, uRimNear) * min(vec3(1.0), (R * R) / (rl * rl) * (k.w / omega));
      cn += w * S.rgb; an += w.g * clamp(S.a, 0.0, 1.0);
    }
    if (an > 1.0) { cn /= an; an = 1.0; }
  }
  oNear = vec4(cn, an);
}
