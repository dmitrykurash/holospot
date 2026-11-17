// ===== holo_volume.frag — A5 Volume Hologram: a recorded 3D object replayed as a light field (addendum A5) =====
// Material main, appended after the shader library and volume.glsl (§6.6 order). The §6.6 front-face skeleton:
//   1. geometry, pixel footprint, relief frames — every derivative is taken here, in uniform control flow (§4.13)
//   2. key-light pixel and motion kernels plus the unresolved relief → ScCard (§4.4.2)
//   3. print and wear
//   4. the film frame: the eye in the film frame (T_f, B_f, N_f) and the surface point in the content box (mm, from the
//      uv-domain centre; nearest periodic image on closed objects)
//   5. lights in hardness order: coat, scratches, paper; per light the hologram replay (volume.glsl): the replayed
//      direction π̂′ and the wavelength — reflection: the Bragg wavelength λ_B (narrow band σ_B, a replay window of
//      half-width σ_w on π̂′ with the gain 1/(2σ_w²) of the concentrated diffraction); rainbow: the slit wavelength λ_c
//      (band σ = λ_c·σ_slit/(ρ_y − π_y0), gain 1/(2σ_slit σ_h)) — then the cone-traced recorded image R(π̂′) at the
//      light's angular size, × η × the band colour (the material tables × the light's SPD); the uVolLights largest
//      replays (lights and the environment) are traced (6b). Rainbow: plus the aluminium mirror (zeroth order, 1 − η of the light).
//      Reflection: plus the black backing. Addendum A10: with a diffractive backdrop pattern, its line gratings' first
//      order per light (volume.glsl volPatLight) on the plane met by the eye ray, masked by the subject.
//   6. environment: coat, paper, rainbow mirror, backing
//   7. dust; 8. debug views, then encodeCard.
// Radiometry: a hologram with efficiency η replays η of the in-band light into its window, distributed over the recorded
// light; per unit of the light's irradiance E: L = (E/π)·η·gain·window·R/F·√(2π)σ·Ĉ(λ, σ), gain 1/(2σ_w²) (energy-
// conserving for small windows), F = VOL_FILL the mean recorded radiance over the window.
// Every term includes the coat transmission of its own directions (§4.4).
//
// Material uniforms (materials/volume.ts): uVolType (0 reflection, 1 rainbow), uVolLambda = (λ_r [nm], σ_B [nm], 0, 0),
// uVolRef (ρ̂, film frame), uVolSel = (σ_w, σ_slit) [rad], uVolEff, uSigS [rad] (rainbow foil micro-slope); the volume,
// pose and image uniforms of volume.glsl; uCoatAlpha (coat.glsl). Shared: uPrevCardRot, uDebugLight, uVolSteps,
// uVolLights, uVolShadowSteps. CPU twin of the replay: physics/volume.ts.

uniform float uSigS;
uniform mat3  uCardRot, uPrevCardRot;
uniform int   uDebugLight;

varying vec3 vWorldPos; varying vec3 vPrevWorldPos; varying vec2 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB;

#if DEBUG_VIEW == 1 || DEBUG_VIEW == 2 || DEBUG_VIEW == 3 || DEBUG_VIEW == 4 || DEBUG_VIEW == 5 || DEBUG_VIEW == 6 || DEBUG_VIEW == 11 || DEBUG_VIEW == 12
#define HOLO_RAW_VIEW 1                 // raw views (§4.14): values in [0, 1], written without encodeCard
#endif

// §4.4.2 card-frame kernels of the key light (as holo_prism.frag). Takes derivatives: call from the top of main().
mat2 keyKernels(vec3 X, vec3 V, vec3 T, vec3 B, vec3 Nf, float snK, out vec2 qK) {
  bool key = uKeyLight >= 0 && uKeyLight < MAX_LIGHTS;
  int ki = clamp(uKeyLight, 0, MAX_LIGHTS - 1);
  vec3 Lk = key ? normalize(uLightPos[ki] - X) : reflect(-V, Nf);
  qK = vec2(dot(Lk + V, T), dot(Lk + V, B));
  vec2 w = fwidth(qK);
  float cap = 0.09 * snK * snK;
  mat2 S = mat2(min(w.x * w.x / TAU, cap), 0.0, 0.0, min(w.y * w.y / TAU, cap));
  if (key) {
    mat3 Rrel = uPrevCardRot * transpose(uCardRot);
    vec3 Hp = normalize(uPrevLightPos[ki] - vPrevWorldPos) + normalize(cameraPosition - vPrevWorldPos);
    vec2 dq = qK - vec2(dot(Hp, Rrel * T), dot(Hp, Rrel * B));
    float l = length(dq);
    if (l > 0.2) dq *= 0.2 / l;
    S += outerProduct(dq, dq) / 12.0;
  }
  return S;
}

void main() {
  // ---- 1. Geometry (uniform control flow: every derivative is taken here, incl. the text-texture UV gradients)
  vec3 X = vWorldPos, V = normalize(cameraPosition - X);
  vec3 T = normalize(vT), B = normalize(vB), N = normalize(vN);
  vec2 p = vUv * uCardSizeMm;
  Footprint F = footprintOf(p);
  vec4 dUv = printUvDerivs(p);
  vec2 sB, sC; mat2 SgB, SgC;
  wavesSlope(uWaveBoard, p, F, sB, SgB);
  wavesSlope(uWaveCoat, p, F, sC, SgC);
  vec2 sM; mat2 SgM;
  bumpSlope(p, F, sM, SgM);
  if (uBumpMode == 2) { sC += sM; SgC += SgM; } else { sB += sM; SgB += SgM; }
  sB += bowSlope(p);
  float snK = keySn(X, V, N);
  mat3 fF = frameFromSlope(T, B, N, sB - (1.0 / snK) * sC);       // film frame (hologram layer under the coat)
  mat3 fC = frameFromSlope(T, B, N, sB + sC);                     // coat frame

  // ---- 2. Key-light kernels + unresolved relief
  vec2 qK;
  mat2 ScCard = keyKernels(X, V, T, B, fF[2], snK, qK) + snK * snK * SgB + SgC;
  float sig2 = SgB[0][0] + SgB[1][1] + SgC[0][0] + SgC[1][1];

  // ---- 3. Print and wear
  Print pr = printLayer(p, dUv);
  Wear wr = wearAt(p, F);
#if DEBUG_VIEW == 14
  pr.W = 0.0; pr.T2 = vec3(1.0); pr.onWhite = vec3(0.85); pr.silver = 0.0;
  wr.alphaAdd = 0.0; wr.gloss = 1.0; wr.mottle = 1.0; wr.dust = 0.0;
#endif

  // ---- 4. Film frame, eye, content box
  vec3 vF = vec3(dot(V, fF[0]), dot(V, fF[1]), dot(V, fF[2]));
  vec2 pb = wrapDelta(p - 0.5 * uCardSizeMm);                     // [mm] from the content centre
  float rPx = 1.25 * F.sMaj;                                      // pixel radius [mm] (σ → box half-width)
  Elem e;                                                         // the rainbow foil's flat aluminium (zeroth order)
  e.n = fF[2]; e.g = fF[0]; e.invD = 1e-3; e.hNm = 0.0; e.nc = VOL_NC; e.sigS = volGlareSigS(uSigS); e.tauF = 0.0; e.fanQ = 0.0;
  e.sigTheta = 0.0; e.sigFrel = 0.0; e.iso2 = 0.0; e.w = 0.0; e.fam = 0.0;
  vec3 Vp = refractIn(V, fF[2], VOL_NC);
  float rainbow = uVolType == 1 ? 1.0 : 0.0;
  float mirF = (1.0 - uVolEff * VOL_RAINBOW_EFF) * volGlareMirror();     // aluminium left for the zeroth order (A12: × surface glare)
  float kCoat = volGlareCoat();
  // A10: the diffractive backdrop pattern seen along the eye ray, masked by the subject (empty for A5's backdrops)
  VolPatHit ph = volPatAt(pb, vF, rPx);
  bool pat = ph.m.x + ph.m.y + ph.m.z > 0.0;

#ifdef HOLO_RAW_VIEW
  vec3 raw = vec3(0.0);
#if DEBUG_VIEW == 1
  raw = vec3(dot(fF[2], T), dot(fF[2], B), dot(fF[2], N)) * 0.5 + 0.5;
#elif DEBUG_VIEW == 2
  raw = vec3(0.5 * (qK + 1.0), 0.0);
#elif DEBUG_VIEW == 3 || DEBUG_VIEW == 11 || DEBUG_VIEW == 12
  GLight gd = lightSummary(uDebugLight, X, V, fF[0], fF[1], fF[2]);
  if (gd.A > 0.0) {
    vec3 ld = vec3(dot(gd.L, fF[0]), dot(gd.L, fF[1]), dot(gd.L, fF[2]));
    VolReplay rd = volReplay(ld, vF, gd.rAng, pb);
#if DEBUG_VIEW == 3
    // `lambda`: replayed wavelength (350 + 500·R) and the replay window (G)
    if (rd.ok > 0.0) raw = vec3((rd.lam - 350.0) / 500.0, rainbow > 0.5 ? exp(-0.5 * sq(asin(clamp(rd.pi.x, -1.0, 1.0)) / VOL_SIGMA_H))
      : exp(-0.5 * sq(asin(min(length(rd.pi.xy), 1.0)) / uVolSel.x)), 0.25);
#else
    if (rd.ok > 0.0) {
      VolImg im = volTrace(vec3(pb, 0.0), rd.pi, rd.tanA, rPx, true);
#if DEBUG_VIEW == 11
      raw = vec3(im.R);                                           // `shard`: the recorded image along π̂′
#else
      raw = vec3(im.cov, clamp(-im.tMm / 60.0, 0.0, 1.0), clamp(rd.tanA * 5.0, 0.0, 1.0));   // `sigma`: coverage, depth, cone
#endif
    }
#endif
  }
#elif DEBUG_VIEW == 6
  raw = vec3(pr.W, (pr.T2.r + pr.T2.g + pr.T2.b) / 3.0, pr.silver);
#endif
  gl_FragColor = vec4(clamp(raw, 0.0, 1.0), 1.0);
  return;
#endif

  // ---- 5. Lights in hardness order
  vec3 Lc = vec3(0.0), Lpap = vec3(0.0), Lz = vec3(0.0), Lo = vec3(0.0), Lb = vec3(0.0), Ed = vec3(0.0);
  // Replay candidates (the lights, then the environment at slot MAX_LIGHTS): the replays are collected first and only
  // the uVolLights largest expected contributions are cone-traced (step 6b), so a dim ghost never takes the trace of the
  // main image on the lower tiers.
  vec3 cPi[MAX_LIGHTS + 1]; vec4 cPar[MAX_LIGHTS + 1];            // π̂′; (tan α, λ, band amplitude, σ_col)
  vec3 cPiC[MAX_LIGHTS + 1];                                      // A12: π̂′ at the hologram's centre (the stereogram's view)
  vec3 Lpat = vec3(0.0);                                          // A10 pattern, before the subject's mask (A12)
  bool stereo = uVolRec.x > 0.5;
  vec3 Xc = X - 1e-3 * (pb.x * fF[0] + pb.y * fF[1]);             // the content centre (world)
  vec3 Vc = normalize(cameraPosition - Xc);
  vec3 vFc = vec3(dot(Vc, fF[0]), dot(Vc, fF[1]), dot(Vc, fF[2]));
  float cW[MAX_LIGHTS + 1]; int cSpd[MAX_LIGHTS + 1];             // radiance weight per unit R·Ĉ; SPD layer
  for (int j = 0; j <= MAX_LIGHTS; ++j) { cPi[j] = vec3(0.0, 0.0, -1.0); cPiC[j] = cPi[j]; cPar[j] = vec4(0.0); cW[j] = 0.0; cSpd[j] = 0; }
#if DEBUG_VIEW != 14
  for (int k = 0; k < MAX_LIGHTS; ++k) {
    int i = uLightOrder[k];
    if (i < 0) break;
    GLight g = lightSummary(i, X, V, fF[0], fF[1], fF[2]);
    if (g.A <= 0.0) continue;
    float Ti = coatT(fC[2], g.L, V);
    vec3 E = g.rad * g.A * g.rgb;
    // hologram replay
    vec3 l = vec3(dot(g.L, fF[0]), dot(g.L, fF[1]), dot(g.L, fF[2]));
    VolReplay r = volReplay(l, vF, g.rAng, pb);
    cPi[k] = r.pi; cPar[k] = vec4(r.tanA, r.lam, r.amp, r.sigCol);
    cW[k] = r.w * g.rad * g.A * Ti * wr.mottle / PI; cSpd[k] = g.spd;
    cPiC[k] = r.pi;
    if (stereo) {
      vec3 Lcw = normalize(uLightPos[i] - Xc);
      cPiC[k] = volReplay(vec3(dot(Lcw, fF[0]), dot(Lcw, fF[1]), dot(Lcw, fF[2])), vFc, g.rAng, vec2(0.0)).pi;
    }
    // A10: the pattern's line gratings, first order (≤ DISCRETE_LIGHTS lights)
    if (pat && k < DISCRETE_LIGHTS) Lpat += wr.mottle * volPatLight(g, Vp, fF[2], fF[0], fF[1], ph, ScCard, fF[0], fF[1], Ti);
    // zeroth order: the rainbow's aluminium mirror (spheres analytic, rects LTC on the higher tiers)
    if (rainbow > 0.5) {
      vec3 Lp = refractIn(g.L, fF[2], VOL_NC);
      vec3 mir = mirF * specProject(vec4(1.0), g.spd);
#if RECT_LTC
      if (g.type == 2) Lz += elemMirrorRect(g, X, V, e, ScCard, fF[0], fF[1], fF[2], 1.0, Ti, mir);
      else Lz += elemMirror(g, Lp, Vp, e, ScCard, fF[0], fF[1], Ti, mir);
#else
      Lz += elemMirror(g, Lp, Vp, e, ScCard, fF[0], fF[1], Ti, mir);
#endif
    } else {
      Lb += Ti * VOL_BACKING * E / PI;                            // black backing under the clear emulsion
    }
    Lc += kCoat * coatDirect(g, X, V, fC[2], uCoatAlpha + wr.alphaAdd, wr.gloss, sig2);
    if (k < DISCRETE_LIGHTS) Lc += scratchLobe(g, V, fC, p, F, ScCard);
    Lpap += pr.W * pr.onWhite * E / PI;
    Ed += E;
  }
#endif

  // ---- 6. Environment
  vec3 Ee = envIrradiance(fC[2]);
  Lc += coatEnv(V, fC[2], sqrt(sq(uCoatAlpha + wr.alphaAdd) + sig2), wr.gloss);
  Lpap += pr.W * pr.onWhite * Ee / PI;
  if (rainbow > 0.5) Lz += envMirror(V, Vp, e, fF[2], ScCard, mirF * specProject(vec4(1.0), 0));
  else Lb += (1.0 - fresnelDiel(max(dot(fC[2], V), 0.0), 1.5)) * 0.9 * VOL_BACKING * Ee / PI;
  // Environment replay: room light from around the reference direction replays the image too, each direction displaced,
  // so the sum is a strongly blurred image. The light directions whose replay lands in the window span Ω ≈ 2πσ_w², so
  // per unit environment radiance L_env(ρ̂): L = L_env·c_ρ·η·window·R·band (the window gain cancels Ω/π); one cone
  // trace of half-angle ≈ σ_w (a candidate like the lights). Reflection type only: a rainbow hologram spreads diffuse
  // light over all slit wavelengths, a faint whitish smear the mirror outshines.
#if DEBUG_VIEW != 14
  if (rainbow < 0.5) {
    vec3 refW = normalize(uVolRef.x * fF[0] + uVolRef.y * fF[1] + uVolRef.z * fF[2]);
    float Le = dot(envRadiance(refW, 0.5), LUMA_SRGB);
    VolReplay r = volReplay(uVolRef, vF, uVolSel.x, pb);
    cPi[MAX_LIGHTS] = r.pi; cPar[MAX_LIGHTS] = vec4(r.tanA, r.lam, r.amp, r.sigCol);
    cPiC[MAX_LIGHTS] = stereo ? volReplay(uVolRef, vFc, uVolSel.x, vec2(0.0)).pi : r.pi;
    cW[MAX_LIGHTS] = Le * uVolRef.z * r.w * 2.0 * uVolSel.x * uVolSel.x * coatT(fC[2], refW, V) * wr.mottle;
  }
  // ---- 6b. Cone-trace the largest replays (≤ uVolLights; contributions below 2 % of the largest are skipped)
  float wMax = 0.0;
  for (int j = 0; j <= MAX_LIGHTS; ++j) wMax = max(wMax, cW[j]);
  float wNext = volNextWeight(cW, uVolLights);                   // A12: continuous choice of the traced replays
  for (int n = 0; n < uVolLights; ++n) {
    int best = -1;
    float bw = max(1e-6, 0.02 * wMax);
    for (int j = 0; j <= MAX_LIGHTS; ++j) if (cW[j] > bw) { bw = cW[j]; best = j; }
    if (best < 0) break;
    VolImg im = volTraceRec(vec3(pb, 0.0), cPi[best], cPiC[best], cPar[best].x, rPx);   // A10: stereogram views
    Lo += (cW[best] - wNext) * im.R * cPar[best].z * cmfConv(cPar[best].y, cPar[best].w, cSpd[best]);
    cW[best] = 0.0;
  }
  if (pat) Lo += volPatMask(Lpat, Lo, ph.cov);                    // A12: the pattern, hidden only behind a replayed subject
#endif

  // ---- 7. Composition (§4.8) and dust
  vec3 tint = (1.0 - pr.W) * pr.T2;
  float kGl = volGlareLimit(Lc + tint * Lz, Ed + Ee);             // A12: the mirrored highlight never whites the film out
  Lc *= kGl; Lz *= kGl;
  vec3 L = mix(Lc + Lpap + tint * (Lz + Lo + Lb), dustRadiance(Ed + Ee, V, fC[2]), wr.dust);

  // ---- 8. Debug views (§4.14)
#if DEBUG_VIEW == 7
  L = (1.0 - wr.dust) * Lc;                                       // coat (gloss, smudges, scratches)
#elif DEBUG_VIEW == 8
  L = (1.0 - wr.dust) * (Lpap + tint * (Lz + Lo + Lb));           // hologram + print, no coat reflection
#elif DEBUG_VIEW == 9
  L = (1.0 - wr.dust) * tint * (Lz + Lb);                         // zeroth order (rainbow mirror) / backing
#elif DEBUG_VIEW == 10 || DEBUG_VIEW == 13
  L = (1.0 - wr.dust) * tint * Lo;                                // the replayed image
#endif
#ifdef HOLO_LDR
  L = gamutMapLuma(L, LUMA_SRGB);
#endif
  gl_FragColor = encodeCard(L);
}
