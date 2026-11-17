// edge.frag — the 0.3 mm board edge (spec §5.1; R04 §1.1–1.2). Assembled after the shader library (§6.6).
//   plies     white, albedo 0.80, around a dark glue core |v − ½| < 0.07 with albedo (0.04, 0.05, 0.07); the core is
//             box-filtered over the pixel footprint in v (fwidth), so when the edge is narrower than a pixel the
//             albedo tends to the coverage-weighted mean (≈0.70)
//   bevel     in the outer 20 % of the thickness the normal tilts toward ±(face normal) by up to 30°:
//             n = normalize(N + B·sign(v − ½)·tan 30°·smoothstep(0.3, 0.5, |v − ½|))
//   specular  matte GGX α = 0.6, F0 0.04
// v = z/T + ½ (0 at the back face, 1 at the front); B (edge bitangent) points toward the front face.
// Raw debug views (uDebugRaw = 1) write raw black (§4.14).
// Addendum A6 (uPaperCard = 1, Foil Emboss shown; chunk paper.glsl): the cut edge of the heavy cotton stock — the
// paper's colour, darkened 8 % by the cut's shadowed fibres, with fibre streaks along the cut and a matte surface
// (no glue core, a softly crushed front edge).
uniform int uDebugRaw;
varying vec3 vWorldPos; varying vec3 vPrevWorldPos; varying vec2 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB;

const float EDGE_ALPHA = 0.6;
const vec3  EDGE_PLY  = vec3(0.80);
const vec3  EDGE_CORE = vec3(0.04, 0.05, 0.07);
const float EDGE_CORE_HALF = 0.07;
const float EDGE_TAN30 = 0.57735027;

void main() {
  vec3 X = vWorldPos, V = normalize(cameraPosition - X);
  vec3 T = normalize(vT), B = normalize(vB), N = normalize(vN);
  float v = clamp(vUv.y, 0.0, 1.0);
  float fv = fwidth(vUv.y);                                    // derivatives in uniform control flow (§4.13)
  float fuEdge = fwidth(vUv.x);                                // A6 paper edge: footprint along the cut
  if (uDebugRaw == 1) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Box filter of the pixel footprint [v − fv/2, v + fv/2] ∩ [0, 1] against the core band.
  float w = max(fv, 1e-5);
  float lo = clamp(v - 0.5 * w, 0.0, 1.0), hi = clamp(v + 0.5 * w, 0.0, 1.0);
  float core = clamp((min(hi, 0.5 + EDGE_CORE_HALF) - max(lo, 0.5 - EDGE_CORE_HALF)) / max(hi - lo, 1e-6), 0.0, 1.0);
  vec3 albedo = mix(EDGE_PLY, EDGE_CORE, core);
  float alpha = EDGE_ALPHA, gloss = 1.0;
  if (uPaperCard == 1) {
    // fibre streaks: noise stretched along the cut (u runs along the outline), faded below 2 px
    float perim = 2.0 * (uCardSizeMm.x + uCardSizeMm.y);
    float fu = fuEdge * perim;                                 // mm per pixel along the cut
    vec2 q = vec2(vUv.x * perim, v * 0.8);
    float n = 0.6 * smoothstep(1.0, 2.5, 0.25 / max(fu, 1e-5)) * paperNoise(vec2(q.x, q.y * 6.0), 0.25, 0xED9E0000u)
            + 0.4 * smoothstep(1.0, 2.5, 0.08 / max(fu, 1e-5)) * paperNoise(vec2(q.x, q.y * 9.0), 0.08, 0xED9F0000u);
    albedo = uPaperRgb * (0.92 + 0.07 * n);
    alpha = 0.75; gloss = 0.4;
  }

  float tilt = sign(v - 0.5) * EDGE_TAN30 * smoothstep(0.3, 0.5, abs(v - 0.5));
  mat3 fr = frameFromSlope(T, B, N, vec2(0.0, -tilt));         // n = normalize(N + tilt·B)
  vec3 n = fr[2];

  vec3 L = vec3(0.0);
  for (int k = 0; k < MAX_LIGHTS; ++k) {
    int i = uLightOrder[k];
    if (i < 0) break;
    GLight g = lightSummary(i, X, V, fr[0], fr[1], n);
    if (g.A <= 0.0) continue;
    L += albedo * (g.rad * g.A / PI) * g.rgb + coatDirect(g, X, V, n, alpha, gloss, 0.0);
  }
  L += albedo * envIrradiance(n) / PI + coatEnv(V, n, alpha, gloss);
  if (uPaperCard == 1) L *= uEmbExposure;                      // A6: the paper card's exposure compensation
#ifdef HOLO_LDR
  L = gamutMapLuma(L, LUMA_SRGB);
#endif
  gl_FragColor = encodeCard(L);
}
