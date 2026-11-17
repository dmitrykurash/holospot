// back.frag — matte, non-holo card back (spec §5.1). Assembled after the shader library (§6.6), so it uses the same
// lights (lightSummary, LTC), coat (coatDirect) and environment (envIrradiance, coatEnv) as the front.
//   diffuse  uBackColor (linear, as-printed SCE reflectance: no coat transmission on the paper term, §4.8)
//   rule     an inset rule 0.5 mm wide, centred 2.6 mm inside the outline, in the same colour × 1.25
//   coat     matte GGX α = 0.35, F0 0.04 (exact n = 1.5 dielectric Fresnel)
//   relief   the bow only, with the negated slope (§4.9); no foil, no print, no wear
// Raw debug views (uDebugRaw = 1) write raw black (§4.14).
// Addendum A6 (uPaperCard = 1, Foil Emboss shown; chunks paper.glsl and emboss.glsl): the back is the same uncoated
// paper (micro-structure, Oren–Nayar, sheen; no coat, no rule) carrying the reverse impression of the embossed logo —
// a softened deboss of 0.55× the front's relief at the mirrored position (front x = W − x).
uniform vec3 uBackColor;
uniform int uDebugRaw;
varying vec3 vWorldPos; varying vec3 vPrevWorldPos; varying vec2 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB;

const float BACK_COAT_ALPHA = 0.35;
const float BACK_RULE_INSET = 2.6;     // centre line of the rule inside the outline [mm]
const float BACK_RULE_HALF  = 0.25;    // half width [mm]

float backSdBox(vec2 p, vec2 c, vec2 b, float r) {            // rounded box centred c, half-size b, radius r
  vec2 q = abs(p - c) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
// Box-filtered coverage of a band of half-width h around a centre line at signed distance d (pixel width aa).
float backBand(float d, float h, float aa) {
  return clamp((min(d + h, 0.5 * aa) - max(d - h, -0.5 * aa)) / aa, 0.0, 1.0);
}

void main() {
  // Geometry; all derivatives here, in uniform control flow (§4.13).
  vec3 X = vWorldPos, V = normalize(cameraPosition - X);
  vec3 T = normalize(vT), B = normalize(vB), N = normalize(vN);
  vec2 p = vUv * uCardSizeMm;                                  // back-face mm, origin bottom-left seen from the back
  vec2 dpx = dFdx(p), dpy = dFdy(p);
  float aa = 0.75 * max(length(abs(dpx) + abs(dpy)), 1e-4);
  Footprint F = footprintOf(p);
  if (uDebugRaw == 1) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  if (uPaperCard == 1) {
    // A6: paper back with the reverse impression of the logo (front point pf = (W − x, y))
    vec2 pf = vec2(uCardSizeMm.x - p.x, p.y);
    LogoS lg = logoSample(pf, F, false);
    vec3 pr = reliefProfile(lg.d, lg.u);
    const float BACK_IMPRESSION = 0.55;
    vec2 sRel = BACK_IMPRESSION * pr.y * vec2(lg.g.x, -lg.g.y);  // h_back(p) = −0.55·h_front(W − x, y)
    vec2 sMac = -bowSlope(p) + sRel;
    Paper P = paperAt(p, F);
    mat3 fm = frameFromSlope(T, B, N, sMac), fn = frameFromSlope(T, B, N, sMac + P.s);
    float sig2 = P.S[0][0] + P.S[1][1];
    float ao = mix(1.0, reliefAO(lg.d, pr.x), 0.5);
    vec3 Lp = vec3(0.0);
    for (int k = 0; k < MAX_LIGHTS; ++k) {
      int i = uLightOrder[k];
      if (i < 0) break;
      GLight g = lightSummary(i, X, V, fm[0], fm[1], fm[2]);
      if (g.A <= 0.0) continue;
      Lp += paperDirect(g, X, V, fm[2], fn[2], P, sig2, 1.0, P.a, 1.0);
    }
    Lp += paperEnv(V, fn[2], sig2, ao, P.a, 1.0);
    Lp *= uEmbExposure;
#ifdef HOLO_LDR
    Lp = gamutMapLuma(Lp, LUMA_SRGB);
#endif
    gl_FragColor = encodeCard(Lp);
    return;
  }

  mat3 fr = frameFromSlope(T, B, N, -bowSlope(p));
  vec3 n = fr[2];

  vec2 h = 0.5 * uCardSizeMm;
  float sdOutline = backSdBox(p, h, h, uCornerMm);             // < 0 inside the card
  float rule = backBand(sdOutline + BACK_RULE_INSET, BACK_RULE_HALF, aa);
  vec3 albedo = uBackColor * (1.0 + 0.25 * rule);

  vec3 L = vec3(0.0);
  for (int k = 0; k < MAX_LIGHTS; ++k) {
    int i = uLightOrder[k];
    if (i < 0) break;
    GLight g = lightSummary(i, X, V, fr[0], fr[1], n);
    if (g.A <= 0.0) continue;
    L += albedo * (g.rad * g.A / PI) * g.rgb + coatDirect(g, X, V, n, BACK_COAT_ALPHA, 1.0, 0.0);
  }
  L += albedo * envIrradiance(n) / PI + coatEnv(V, n, BACK_COAT_ALPHA, 1.0);
#ifdef HOLO_LDR
  L = gamutMapLuma(L, LUMA_SRGB);                              // LDR fallback: encodeCard must fit [0, 1) (§5.5)
#endif
  gl_FragColor = encodeCard(L);
}
