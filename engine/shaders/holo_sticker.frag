// ===== holo_sticker.frag — A9: a volume-hologram sticker laminated on the embossed Foil Emboss paper card =====
// The fragment main of the Foil Emboss material's sticker variant (EMB_STICKER; materials/emboss.ts selects it while
// `emboss.element` is `hologram`; the foil main holo_emboss.frag is untouched). Appended after the shader library and
// the extra chunks paper.glsl, emboss.glsl (with the analytic shapes) and volume.glsl (§6.6 order).
//
// The real product: a photopolymer reflection hologram (A5) on a black backing under a glossy cover film, ≈ 40 µm in
// all, die-cut and laminated onto card stock over a blind-embossed (or debossed) area, so the film follows the relief.
// Skeleton (as holo_emboss.frag; every derivative in step 1, in uniform control flow):
//   1. geometry, footprint, waves, bump map, bow, key-light kernels
//   2. relief: parallax, the relief's signed distance at the visible point (analytic shape or the logo's SDF; the die
//      is the sticker grown by uFilmGrow, the shoulder the film leaves bare — `emboss.filmWall`), the wall slopes over
//      the footprint (Gauss–Hermite nodes across the outline) on the film and on the paper; the film covers the die-cut
//      sticker (dF = d − uFilmGrow ≥ 0, crisp: the footprint is the only blur)
//   3. paper micro-structure (as the foil card); the cover film's frame = the relief surface's local frame + a little of
//      the paper's tooth telegraphing through + the scene's bump-map share; the hologram's recording frame = the relief
//      surface's macro frame turned by the sticker's rotation; its content box is the sticker's own (centre, rotation,
//      size).
//   4. lights: the relief's cast shadow; paper (Oren–Nayar, wrap, sheen; the film step's hairline shadow); film: the
//      cover film's gloss, the black backing (reflection) or the aluminium mirror (rainbow), the replay of each light
//      (π̂′, Bragg / slit wavelength, window, gain: volume.glsl volReplay, A5's maths); A10: a diffractive backdrop
//      pattern's line gratings (volume.glsl volPatLight); the die-cut edge's glint
//   5. environment: paper; film coat, backing / mirror, the environment's replay (reflection)
//   6. the uVolLights largest replays cone-traced through the subject's volume (only inside the patch)
//   7. composition by the film's coverage, dust; debug views, encodeCard.
// The window: the patch outline is the hologram's window — a pixel outside it has no hologram, so whatever of the 3D
// scene lies beyond the edge is cut off with the parallax of its depth (A5's card edges, here the die-cut outline).
//
// Material uniforms (materials/emboss.ts): uFoil.z (paper show-through), uFoilBump (bump-map share on the cover film),
// uFilmMm (film thickness), uSigS (rainbow mirror micro-slope), uCoatAlpha (cover film α), the hologram uniforms of
// volume.glsl (A5's, from the `emboss.holo.*` values); shared: uCardRot, uPrevCardRot, uDebugLight, the paper and
// relief uniforms of paper.glsl and emboss.glsl.

uniform vec4  uFoil;
uniform float uFoilBump;
uniform float uFilmMm;
uniform float uSigS;
uniform mat3  uCardRot, uPrevCardRot;
uniform int   uDebugLight;

varying vec3 vWorldPos; varying vec3 vPrevWorldPos; varying vec2 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB;

#if DEBUG_VIEW == 1 || DEBUG_VIEW == 2 || DEBUG_VIEW == 3 || DEBUG_VIEW == 4 || DEBUG_VIEW == 5 || DEBUG_VIEW == 6 || DEBUG_VIEW == 11 || DEBUG_VIEW == 12
#define HOLO_RAW_VIEW 1
#endif

// Gauss–Hermite nodes and weights of the standard normal (4 nodes; 2: ±1).
const vec4 GH4X = vec4(-2.3344142183, -0.7419637843, 0.7419637843, 2.3344142183);
const vec4 GH4W = vec4(0.0458758548, 0.4541243478, 0.4541243478, 0.0458758548);
const float EDGE_ALPHA = 0.12;          // GGX α of the die-cut edge (a cut through the laminate, rougher than the cover)

// §4.4.2 key-light kernels (as holo_emboss.frag). Takes derivatives: call from the top of main().
mat2 embKeyKernels(vec3 X, vec3 V, vec3 T, vec3 B, vec3 Nf, float snK, out vec2 qK) {
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

// The die-cut edge's glint. The cut through the laminate is a quarter round of radius rE (the film thickness) along
// the outline: seen from above it occupies d ∈ [0, rE], its normal tilting from the cover's (ψ = 0) to the outward
// cut (ψ = π/2), so for most light positions some part of it mirrors the light into the eye — the thin bright line a
// real sticker's edge shows. Per unit edge length, a GGX lobe integrated along the arc gives ∫D dψ = α²/(2(α² + φ²)^1.5)
// (φ: the half vector's tilt out of the arc's plane), at the arc position d* = rE(1 − sin ψ*) of the best-aligned
// normal; the pixel sees it with the footprint's density across the edge (sd, plus the lobe's own width on the arc):
//   L = (rE / (z·v)) · φ_σ(d* − d_px) · ∫D dψ · F(h·l) / 4 · E⊥        (E⊥: the light's irradiance ⟂ to its direction)
// z: the paper's macro normal at the foot of the relief (there the relief is flat), o: outward ⟂ the outline.
vec3 filmEdgeGlint(GLight g, vec3 V, vec3 z, vec3 o, float dPx, float sd, float rE) {
  if (g.A <= 0.0 || rE <= 0.0) return vec3(0.0);
  vec3 H = normalize(g.L + V);
  float hz = dot(H, z), ho = dot(H, o);
  if (ho <= 0.0 || hz < -0.05) return vec3(0.0);                 // the half vector must tilt outward, above the cut
  float psi = atan(ho, max(hz, 0.0));
  vec3 nE = cos(psi) * z + sin(psi) * o;
  if (dot(nE, g.L) <= 0.0 || dot(nE, V) <= 0.0) return vec3(0.0);
  float ht = clamp(dot(H, cross(z, o)), -1.0, 1.0), phi = asin(ht);
  float a2 = EDGE_ALPHA * EDGE_ALPHA + 0.25 * g.rAng * g.rAng;
  float lobe = a2 / (2.0 * pow(a2 + phi * phi, 1.5));
  float dStar = rE * (1.0 - sin(psi));
  float s2 = sd * sd + sq(rE * cos(psi)) * a2;
  float pdf = 0.39894228 * inversesqrt(s2) * exp(-0.5 * sq(dStar - dPx) / s2);
  float ePerp = g.rad * g.A / max(dot(z, g.L), 0.02);
  float fade = smoothstep(0.12, 0.35, psi);                     // ψ → 0 is the cover film's face (its own gloss)
  return fade * (rE / max(dot(z, V), 0.1)) * pdf * lobe * fresnelDiel(max(dot(H, g.L), 0.0), 1.5) * 0.25 * ePerp * g.rgb;
}

void main() {
  // ---- 1. Geometry (uniform control flow: every derivative is taken here)
  vec3 X = vWorldPos, V = normalize(cameraPosition - X);
  vec3 T = normalize(vT), B = normalize(vB), N = normalize(vN);
  vec2 p0 = vUv * uCardSizeMm;
  gPrint = printTint(vUv, dFdx(vUv), dFdy(vUv));            // the image card's print (1 = bare paper)
  Footprint F = footprintOf(p0);
  vec2 sB; mat2 SgB;
  wavesSlope(uWaveBoard, p0, F, sB, SgB);                       // paper cockle (+ the scene's foil-layer emboss)
  vec2 sM; mat2 SgM;
  bumpSlope(p0, F, sM, SgM);                                    // the scene's bump map: on the cover film (paper: optional)
  sB += bowSlope(p0);
  float snK = keySn(X, V, N);
  mat3 fM = frameFromSlope(T, B, N, sB);                        // macro frame of the sheet (bow, cockle)
  vec2 qK;
  mat2 Skey = embKeyKernels(X, V, T, B, fM[2], snK, qK);
  Wear wr = wearAt(p0, F);
#if DEBUG_VIEW == 14
  wr.alphaAdd = 0.0; wr.gloss = 1.0; wr.mottle = 1.0; wr.dust = 0.0;
#endif
  float burnish = wr.alphaAdd / 0.12;                          // wear × smudge mask: burnished paper, smudged film

  // ---- 2. Relief: the visible point (parallax), the sticker outline, wall slopes over the footprint, film coverage
  vec3 Vt = vec3(dot(V, fM[0]), dot(V, fM[1]), dot(V, fM[2]));
  float lodL = logoLod(F);
  float hHit;
  vec2 p = reliefParallax(p0, Vt, lodL, hHit);
  bool dome = uRelProfile == 2;
  LogoS lg = logoSample(p, F, dome);
  vec3 prof = reliefProfile(lg.d, lg.u);                         // (h, ∂h/∂d, ∂h/∂u)
  float gl = length(lg.g);
  vec2 n1 = gl > 1e-5 ? lg.g / gl : vec2(1.0, 0.0);              // inward ⟂ the outline (card frame)
  float texelMm = uLogoShape > 0 ? 0.0 : uLogoMap.z * uLogoW;
  float sd = sqrt(sq(sigmaAlong(F, n1)) + sq(0.3 * texelMm));  // footprint across the outline [mm]
  // lg.d is the relief's distance (the die: the sticker grown by uFilmGrow); dF the film's own (the die-cut sticker)
  float dF = lg.d - uFilmGrow;
  // Gauss–Hermite nodes across the outline: the wall slope's mean and variance on the film (dF ≥ 0) and on the paper
  float wFi = 0.0, mF = 0.0, qF = 0.0, mP = 0.0, qP = 0.0;
  for (int k = 0; k < 4; ++k) {
    if (k >= uGhB) break;
    float x = uGhB >= 4 ? GH4X[k] : (k == 0 ? -1.0 : 1.0);
    float w = uGhB >= 4 ? GH4W[k] : 0.5;
    float dk = lg.d + sd * x;
    float sl = reliefProfile(dk, lg.u).y * gl;
    float ck = gaussCdf((dk - uFilmGrow) / max(0.35 * sd, 1e-5));
    wFi += w * ck; mF += w * ck * sl; qF += w * ck * sl * sl;
    mP += w * (1.0 - ck) * sl; qP += w * (1.0 - ck) * sl * sl;
  }
  float wPa = 1.0 - wFi;
  float sF = mF / max(wFi, 1e-6), vF = max(qF / max(wFi, 1e-6) - sF * sF, 0.0);
  float sP = mP / max(wPa, 1e-6), vP = max(qP / max(wPa, 1e-6) - sP * sP, 0.0);
  if (wFi < 1e-4) { sF = prof.y * gl; vF = 0.0; }
  if (wPa < 1e-4) { sP = prof.y * gl; vP = 0.0; }
  vec2 sDome = prof.z * lg.gu;
  mat2 nn = outerProduct(n1, n1);
  // the die-cut film: crisp at the outline (only the footprint blurs it)
  float C = EMB_OFF ? 0.0 : gaussCdf(dF / max(sd, 1e-6));

  // ---- 3. Paper micro-structure; the frames of the paper and the film; the sticker (recording) frame
  Paper P = paperAt(p, F);
  vec2 sRelP = sP * n1 + sDome, sRelF = sF * n1 + sDome;
  float cal = EMB_OFF ? 1.0 : 1.0 - 0.35 * smoothstep(-uRelief.w, 0.0, lg.d);   // the die calenders the paper it presses
  vec2 sPap = sB + sRelP + cal * P.s;
  mat2 SPap = SgB + vP * nn + (cal * cal) * P.S;
  if (uPaperBump == 1) { sPap += sM; SPap += SgM; }
  mat3 fPm = frameFromSlope(T, B, N, sB + sRelP);               // paper macro frame (light summaries)
  mat3 fPn = frameFromSlope(T, B, N, sPap);                     // paper micro frame (shading)
  // the film follows the relief; its cover is smoother than the paper: the tooth telegraphs through at half the
  // show-through (as under the foil), plus the scene's bump-map share (scratches on the cover)
  float show = 0.5 * uFoil.z;
  vec2 sFilm = sB + sRelF + show * P.s + uFoilBump * sM;
  mat2 SFilm = SgB + vF * nn + (show * show) * P.S + (uFoilBump * uFoilBump) * SgM;
  mat3 fS = frameFromSlope(T, B, N, sFilm);
  mat2 ScFilm = Skey + snK * snK * SFilm;
  float sig2S = SFilm[0][0] + SFilm[1][1], sig2P = SPap[0][0] + SPap[1][1];
  float alphaS = uCoatAlpha + wr.alphaAdd;
  float albP = P.a * (1.0 - 0.06 * burnish), sheenP = 1.0 + 0.8 * burnish;
  float hP = prof.x;
  float ao = reliefAO(lg.d, hP);
  float aoF = mix(1.0, ao, 0.6);
  Paper Pc = P;                                                 // the paper as shaded (calendered)
  Pc.s *= cal; Pc.S *= cal * cal; Pc.hl *= cal;
  // The hologram's recording frame: the relief surface's macro frame (the photopolymer lies on its flat carrier and the
  // adhesive fills the paper's tooth: the tooth and the cover's scratches only reach the cover film's gloss), turned by
  // the sticker's rotation (its x along the element's width); the content box is the sticker's own (mm from its
  // centre, along its axes).
  mat3 fR = frameFromSlope(T, B, N, sB + sRelF);
  vec3 tS = uLogoXf.z * fR[0] + uLogoXf.w * fR[1], bS = -uLogoXf.w * fR[0] + uLogoXf.z * fR[1];
  mat3 fH = mat3(tS, bS, fR[2]);
  vec3 vH = V * fH;                                             // (V·tS, V·bS, V·n)
  vec2 pb = logoLocal(p);
  float rPx = 1.25 * F.sMaj;                                    // pixel radius [mm] (σ → box half-width)
  Elem e;                                                       // the rainbow hologram's flat aluminium (zeroth order)
  e.n = fS[2]; e.g = fS[0]; e.invD = 1e-3; e.hNm = 0.0; e.nc = VOL_NC; e.sigS = volGlareSigS(uSigS); e.tauF = 0.0; e.fanQ = 0.0;
  e.sigTheta = 0.0; e.sigFrel = 0.0; e.iso2 = 0.0; e.w = 0.0; e.fam = 0.0;
  vec3 Vp = refractIn(V, fS[2], VOL_NC);
  float rainbow = uVolType == 1 ? 1.0 : 0.0;
  float mirF = (1.0 - uVolEff * VOL_RAINBOW_EFF) * volGlareMirror();   // aluminium left for the zeroth order (A12: × surface glare)
  float kCoat = volGlareCoat();
  // A10: the diffractive backdrop pattern seen along the eye ray, masked by the subject (inside the patch only)
  VolPatHit ph = volPatNone();
  if (!EMB_OFF && dF > -4.0 * sd) ph = volPatAt(pb, vH, rPx);
  bool pat = ph.m.x + ph.m.y + ph.m.z > 0.0;
  // the die-cut edge: the outward horizontal direction and the film step's reach on the paper
  vec3 oE = -normalize(n1.x * fR[0] + n1.y * fR[1]);
  oE = normalize(oE - fR[2] * dot(oE, fR[2]));
  float rE = uFilmMm;
  bool nearEdge = !EMB_OFF && abs(dF) < 4.0 * sd + 2.0 * rE + 0.05;

#ifdef HOLO_RAW_VIEW
  vec3 raw = vec3(0.0);
#if DEBUG_VIEW == 1
  vec3 nS = normalize(mix(fPn[2], fS[2], C));
  raw = vec3(dot(nS, T), dot(nS, B), dot(nS, N)) * 0.5 + 0.5;    // shading normal, macro frame
#elif DEBUG_VIEW == 2
  raw = vec3(0.5 * (qK + 1.0), 0.0);
#elif DEBUG_VIEW == 3 || DEBUG_VIEW == 11 || DEBUG_VIEW == 12
  GLight gd = lightSummary(uDebugLight, X, V, fR[0], fR[1], fR[2]);
  if (gd.A > 0.0 && C > 0.5) {
    vec3 ld = gd.L * fH;
    VolReplay rd = volReplay(ld, vH, gd.rAng, pb);
#if DEBUG_VIEW == 3
    // `lambda`: replayed wavelength (350 + 500·R) and the replay window (G), inside the sticker
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
  raw = vec3(C, clamp(0.5 + 0.25 * P.hn, 0.0, 1.0), clamp(hP / max(reliefTop(), 1e-4), 0.0, 1.0));   // (film, tooth, height)
#endif
  gl_FragColor = vec4(clamp(raw, 0.0, 1.0), 1.0);
  return;
#endif

  // ---- 4. Lights in hardness order
  vec3 Lpap = vec3(0.0), Lc = vec3(0.0), Lz = vec3(0.0), Lo = vec3(0.0), Lb = vec3(0.0), Lg = vec3(0.0), Ed = vec3(0.0);
  // replay candidates (the lights, then the environment at slot MAX_LIGHTS), traced in step 6 (as holo_volume.frag)
  vec3 cPi[MAX_LIGHTS + 1]; vec4 cPar[MAX_LIGHTS + 1];            // π̂′; (tan α, λ, band amplitude, σ_col)
  vec3 cPiC[MAX_LIGHTS + 1];                                      // A12: π̂′ at the sticker's centre (the stereogram's view)
  vec3 Lpat = vec3(0.0);                                          // A10 pattern, before the subject's mask (A12)
  bool stereo = uVolRec.x > 0.5;
  vec3 Xc = X - 1e-3 * (pb.x * tS + pb.y * bS);                   // the sticker's centre (world)
  vec3 vHc = normalize(cameraPosition - Xc) * fH;
  float cW[MAX_LIGHTS + 1]; int cSpd[MAX_LIGHTS + 1];             // radiance weight per unit R·Ĉ; SPD layer
  for (int j = 0; j <= MAX_LIGHTS; ++j) { cPi[j] = vec3(0.0, 0.0, -1.0); cPiC[j] = cPi[j]; cPar[j] = vec4(0.0); cW[j] = 0.0; cSpd[j] = 0; }
  // the film step's hairline shadow and contact occlusion on the paper beside the cut (outside: d < 0); the paper's
  // share of the footprint is 1 − C = Φ(−d/sd)
  float paperShare = max(1.0 - C, 1e-4);
#if DEBUG_VIEW != 14
  for (int k = 0; k < MAX_LIGHTS; ++k) {
    int i = uLightOrder[k];
    if (i < 0) break;
    // the relief's cast shadow (light centre, macro frame; penumbra from the light's angular size)
    vec3 dL = uLightPos[i] - X;
    float dist = max(length(dL), 1e-4);
    vec3 Lw = dL / dist;
    vec3 Lt = vec3(dot(Lw, fM[0]), dot(Lw, fM[1]), dot(Lw, fM[2]));
    float rA = uLightType[i] == 1 ? uLightRadius[i] / dist : sqrt(length(uLightU[i]) * length(uLightW[i])) / dist;
    float vis = reliefShadow(p, hP, Lt, rA, lodL);
    bool lit = false;
    if (nearEdge) {                                               // the die-cut edge's glint (relief frame at the edge)
      GLight ge = lightSummary(i, X, V, fR[0], fR[1], fR[2]);
      Lg += vis * filmEdgeGlint(ge, V, fR[2], oE, dF, sd, rE);
    }
    if (C < 0.9999) {
      GLight gp = lightSummary(i, X, V, fPm[0], fPm[1], fPm[2]);
      if (gp.A > 0.0) {
        // the step of height rE at the outline shadows the paper out to w = rE·tan(zenith) toward the light's far side
        float stepVis = 1.0;
        if (nearEdge) {
          float toward = dot(Lt.xy, n1);                           // > 0: the light lies over the sticker
          float wS = rE * max(toward, 0.0) / max(Lt.z, 0.05);
          float band = gaussCdf(-dF / sd) - gaussCdf((-wS - dF) / sd);
          stepVis = clamp(1.0 - band / paperShare, 0.0, 1.0);
        }
        Lpap += paperDirect(gp, X, V, fPm[2], fPn[2], Pc, sig2P, vis * stepVis, albP, sheenP);
        Ed += gp.rad * gp.A * gp.rgb;
        lit = true;
      }
    }
    if (C > 1e-4) {
      GLight g = lightSummary(i, X, V, fS[0], fS[1], fS[2]);    // the cover film's frame (gloss, transmission, mirror)
      if (g.A <= 0.0) continue;
      vec3 E = g.rad * g.A * g.rgb;
      if (!lit) Ed += E;
      float Ti = coatT(fS[2], g.L, V);
      // the hologram's replay of this light (A5: volume.glsl volReplay), traced in step 6
      vec3 l = g.L * fH;
      VolReplay r = volReplay(l, vH, g.rAng, pb);
      cPi[k] = r.pi; cPar[k] = vec4(r.tanA, r.lam, r.amp, r.sigCol);
      cW[k] = vis * r.w * g.rad * g.A * Ti * wr.mottle / PI; cSpd[k] = g.spd;
      cPiC[k] = stereo ? volReplay(normalize(uLightPos[i] - Xc) * fH, vHc, g.rAng, vec2(0.0)).pi : r.pi;
      // A10: the pattern's line gratings, first order (≤ DISCRETE_LIGHTS lights)
      if (pat && k < DISCRETE_LIGHTS) Lpat += vis * wr.mottle * volPatLight(g, Vp, fS[2], tS, bS, ph, ScFilm, fS[0], fS[1], Ti);
      if (rainbow > 0.5) {
        // zeroth order: the rainbow hologram's aluminium mirror (spheres analytic, rects LTC on the higher tiers)
        vec3 Lp = refractIn(g.L, fS[2], VOL_NC);
        vec3 mir = mirF * specProject(vec4(1.0), g.spd);
#if RECT_LTC
        if (g.type == 2) Lz += vis * elemMirrorRect(g, X, V, e, ScFilm, fS[0], fS[1], fS[2], 1.0, Ti, mir);
        else Lz += vis * elemMirror(g, Lp, Vp, e, ScFilm, fS[0], fS[1], Ti, mir);
#else
        Lz += vis * elemMirror(g, Lp, Vp, e, ScFilm, fS[0], fS[1], Ti, mir);
#endif
      } else {
        Lb += vis * Ti * VOL_BACKING * E / PI;                     // black backing under the clear photopolymer
      }
      Lc += kCoat * vis * coatDirect(g, X, V, fS[2], alphaS, wr.gloss, sig2S);
      if (k < DISCRETE_LIGHTS) Lc += vis * scratchLobe(g, V, fS, p, F, ScFilm);
    }
  }
#endif

  // ---- 5. Environment
  vec3 Ee = envIrradiance(fPm[2]);
  if (C < 0.9999) {
    // contact occlusion of the paper at the foot of the film step (a strip ≈ one step height wide, a quarter hidden)
    float aoStep = 1.0;
    if (nearEdge) aoStep = 1.0 - 0.25 * clamp((gaussCdf(-dF / sd) - gaussCdf((-rE - dF) / sd)) / paperShare, 0.0, 1.0);
    Lpap += paperEnv(V, fPn[2], sig2P, ao * aoStep, albP, sheenP);
  }
  if (C > 1e-4) {
    Lc += aoF * coatEnv(V, fS[2], sqrt(sq(alphaS) + sig2S), wr.gloss);
    if (rainbow > 0.5) Lz += aoF * envMirror(V, Vp, e, fS[2], ScFilm, mirF * specProject(vec4(1.0), 0));
    else Lb += aoF * (1.0 - fresnelDiel(max(dot(fS[2], V), 0.0), 1.5)) * 0.9 * VOL_BACKING * Ee / PI;
#if DEBUG_VIEW != 14
    // the environment's replay (reflection type; A5): room light from around the reference direction, strongly blurred
    if (rainbow < 0.5) {
      vec3 refW = normalize(fH * uVolRef);
      float Le = dot(envRadiance(refW, 0.5), LUMA_SRGB);
      VolReplay r = volReplay(uVolRef, vH, uVolSel.x, pb);
      cPi[MAX_LIGHTS] = r.pi; cPar[MAX_LIGHTS] = vec4(r.tanA, r.lam, r.amp, r.sigCol);
      cPiC[MAX_LIGHTS] = stereo ? volReplay(uVolRef, vHc, uVolSel.x, vec2(0.0)).pi : r.pi;
      cW[MAX_LIGHTS] = aoF * Le * uVolRef.z * r.w * 2.0 * uVolSel.x * uVolSel.x * coatT(fS[2], refW, V) * wr.mottle;
    }
    // ---- 6. Cone-trace the largest replays (≤ uVolLights; below 2 % of the largest skipped) — inside the patch only
    float wMax = 0.0;
    for (int j = 0; j <= MAX_LIGHTS; ++j) wMax = max(wMax, cW[j]);
    float wNext = volNextWeight(cW, uVolLights);                 // A12: continuous choice of the traced replays
    for (int n = 0; n < uVolLights; ++n) {
      int best = -1;
      float bw = max(1e-6, 0.02 * wMax);
      for (int j = 0; j <= MAX_LIGHTS; ++j) if (cW[j] > bw) { bw = cW[j]; best = j; }
      if (best < 0) break;
      VolImg im = volTraceRec(vec3(pb, 0.0), cPi[best], cPiC[best], cPar[best].x, rPx);   // A10: stereogram views
      Lo += (cW[best] - wNext) * im.R * cPar[best].z * cmfConv(cPar[best].y, cPar[best].w, cSpd[best]);
      cW[best] = 0.0;
    }
    if (pat) Lo += volPatMask(Lpat, Lo, ph.cov);                  // A12: the pattern, hidden only behind a replayed subject
#endif
  }

  // ---- 7. Composition (film coverage), the edge's glint, dust
  float kGl = volGlareLimit(Lc + Lz, Ed + Ee);                    // A12: the mirrored highlight never whites the film out
  Lc *= kGl; Lz *= kGl;
  vec3 Lfilm = Lc + Lz + Lo + Lb;
  vec3 L = mix(mix(Lpap, Lfilm, C) + Lg, dustRadiance(Ed + Ee, V, fM[2]), wr.dust);

  // ---- Debug views (§4.14)
#if DEBUG_VIEW == 7
  L = (1.0 - wr.dust) * (C * Lc + Lg);                         // the cover film's gloss, scratches and the edge's glint
#elif DEBUG_VIEW == 8
  L = (1.0 - wr.dust) * mix(Lpap, Lz + Lo + Lb, C);             // paper + hologram without the cover's reflection
#elif DEBUG_VIEW == 9
  L = (1.0 - wr.dust) * C * (Lz + Lb);                          // zeroth order (rainbow mirror) / backing
#elif DEBUG_VIEW == 10 || DEBUG_VIEW == 13
  L = (1.0 - wr.dust) * C * Lo;                                 // the replayed image
#endif
  L *= uEmbExposure;                                            // exposed for the paper (material setting)
#ifdef HOLO_LDR
  L = gamutMapLuma(L, LUMA_SRGB);
#endif
  gl_FragColor = encodeCard(L);
}
