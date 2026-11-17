// ===== print.glsl — procedural print layer: graded white, translucent inks, text, wear whitening (§4.8, §5.7) =====
// printLayer(p, dUv) returns per pixel the white coverage W, the ink double-pass transmittance T2 over foil, the
// as-printed linear reflectance onWhite where ink sits on white (coated, specular excluded: ρ_white = 0.85) and the
// edge-silvering mask. Composition (§4.8): R ≈ (1 − W)·T2·R_foil + W·onWhite (no coat transmission on paper).
// Every element is an SDF with coverage c = clamp(0.5 − sd/aa, 0, 1) (thin strokes: exact box-filtered band
// coverage), aa = 0.75·length(fwidth(p)); each blends (W, T2, onWhite) toward its own values by c, painted back to
// front (background ink, halo, subject, stars, window face, title band, panel, text, border, keyline), which
// realises the table of §5.7; then edge silvering, corner whitening and the paper tooth.
// An opaque ink of as-printed colour C has onWhite = C and T2 = min(C/ρ_white, 1); a translucent ink given by T2
// has onWhite = ρ_white·T2; bare foil is (W 0, T2 1, onWhite ρ_white).
// Uniforms:
//   uPrintMode   int    0 none, 1 frame, 2 window, 3 art
//   uBorderMode  int    0 ink, 1 foil (bare-foil border)
//   uInkBorder, uInkText, uInkPanel, uInkSubject, uInkSubjectRim, uInkGold, uInkSpark   vec3 linear colours (§5.7)
//   uTextTex     sampler2D  text coverage (R), 1024 × 512 at 16 px/mm, mipmapped (scene/printText.ts)
//   uSmokeT2     float  title-band smoke ink T2 (0.30)
//   uEdgeSilver  float  0/1 edge silvering
//   uCornerMm    float  card outline corner radius [mm] (edge silvering, corner whitening)
//   (uCardSizeMm from relief.glsl, uWear from wear.glsl)
//
// Text texture contract (scene/printText.ts): canvas 1024 × 512, 16 px/mm, uploaded with flipY = true. Canvas
// pixel (cx, cy), origin top-left, ↔ card mm (x, y): cx = (x + 0.5)·16; rows 0–255 hold the title band,
// cy = (88 − y)·16 (card y 72–88); rows 256–511 hold the info panel, cy = (36 − y)·16 (card y 4–20). Drawn at
// the art/frame positions (the window mode re-maps them here):
//   title  material name, 600 weight, font size 4.2 mm, left-aligned at x 4.6, textBaseline "middle" at y 81.7
//   value  pitch string ("1000 l/mm"), 600 weight, 3.0 mm, right-aligned at x 58.4, middle at y 81.7
//   info   caption / analog / "procedural holographic card · v1", 500 weight, 2.2 mm, left-aligned at x 7.0,
//          middle at y 15.5 / 12.0 / 8.5
// Window mode: the title is the art title (the name, art x < 42 mm) scaled by 0.6 about (4.6, 81.7) and moved to
// (6.0, 83.2), shown in x 6–36, y 81.6–85.0; the info lines are moved by (−1.0, +18.5) to y 34.0 / 30.5 / 27.0,
// shown in x 6–57, y 25–36. The title name must therefore end before art x = 42 mm, the value start after it.

uniform int   uPrintMode, uBorderMode;
uniform vec3  uInkBorder, uInkText, uInkPanel, uInkSubject, uInkSubjectRim, uInkGold, uInkSpark;
uniform sampler2D uTextTex;
uniform float uSmokeT2, uEdgeSilver, uCornerMm;

struct Print { float W; vec3 T2; vec3 onWhite; float silver; };

const float RHO_WHITE = 0.85;
const vec2  PRINT_UV_PER_MM = vec2(1.0 / 64.0, 1.0 / 32.0);  // text-texture UV per card mm

// Text-texture UV derivatives for printLayer: call at the top of main() in uniform control flow (§4.13).
vec4 printUvDerivs(vec2 p) { return vec4(dFdx(p) * PRINT_UV_PER_MM, dFdy(p) * PRINT_UV_PER_MM); }
// Text-texture UV of a point of the art/frame text layout (card mm).
vec2 printTextUv(vec2 pa) { return vec2(pa.x + 0.5, pa.y < 46.0 ? pa.y - 4.0 : pa.y - 56.0) * PRINT_UV_PER_MM; }

// ---- SDF helpers (card mm)
float printSdBox(vec2 p, vec2 c, vec2 b, float r) {           // rounded box centred c, half-size b, radius r
  vec2 q = abs(p - c) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float printSdRect(vec2 p, vec2 lo, vec2 hi, float r) { return printSdBox(p, 0.5 * (lo + hi), 0.5 * (hi - lo), r); }
float printCov(float sd, float aa) { return clamp(0.5 - sd / aa, 0.0, 1.0); }
// Box-filtered coverage of a band of half-width h around a centre line at signed distance d (thin strokes).
float printBand(float d, float h, float aa) { return clamp((min(d + h, 0.5 * aa) - max(d - h, -0.5 * aa)) / aa, 0.0, 1.0); }
// Ellipse (semi-axes ab, centred) distance estimate f/|∇f| with f = |q/ab| − 1 (accurate near the curve).
float printSdEllipse(vec2 q, vec2 ab) {
  float k = length(q / ab);
  vec2 gq = q / (ab * ab * max(k, 1e-6));
  return (k - 1.0) / max(length(gq), 1e-6);
}
// 4-point star (Quilez sdStar with n = 4), tip radius r, sharpness m ∈ [2, 4] (tips on ±x and ±y).
float printSdStar4(vec2 p, float r, float m) {
  const float an = 0.78539816;                                 // π/4
  float en = PI / m;
  vec2 acs = vec2(cos(an), sin(an)), ecs = vec2(cos(en), sin(en));
  p.x = abs(p.x);
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}
// Value noise in [−1, 1] (C1, hashed integer lattice).
float printVNoise(vec2 x, uint salt) {
  vec2 i = floor(x), f = fract(x), u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = rnd3(c, salt).x, b = rnd3(c + ivec2(1, 0), salt).x;
  float e = rnd3(c + ivec2(0, 1), salt).x, d = rnd3(c + ivec2(1, 1), salt).x;
  return 2.0 * mix(mix(a, b, u.x), mix(e, d, u.x), u.y) - 1.0;
}

// Blend the print state toward an element's (W, T2, onWhite) by coverage c.
void printOver(inout Print pr, float c, float W, vec3 T2, vec3 onWhite) {
  pr.W = mix(pr.W, W, c); pr.T2 = mix(pr.T2, T2, c); pr.onWhite = mix(pr.onWhite, onWhite, c);
}
void printInk(inout Print pr, float c, float W, vec3 ink) { printOver(pr, c, W, min(ink / RHO_WHITE, vec3(1.0)), ink); }
void printTint(inout Print pr, float c, vec3 T2) { printOver(pr, c, 0.0, T2, RHO_WHITE * T2); }

// Art contents (subject, halo, sparkle stars, background ink), clipped to coverage `clip` (art area or window).
void printArt(inout Print pr, vec2 p, float aa, float clip) {
  // background ink: translucent gradient over the foil
  printTint(pr, clip, mix(vec3(0.70, 0.78, 0.95), vec3(0.95, 0.80, 0.70), smoothstep(22.0, 76.0, p.y)));
  // halo: graded white underprint, W = 0.7·(1 − smoothstep(0, 6 mm, distance outside the disc)), no ink
  const vec2 PC = vec2(24.0, 54.0); const float PR = 8.0;
  float dc = length(p - PC);
  printOver(pr, clip * (1.0 - smoothstep(0.0, 6.0, max(dc - PR, 0.0))), 0.7, vec3(1.0), vec3(RHO_WHITE));
  // planet disc, opaque ink over white, with a 1.2 mm lighter rim
  float cDisc = clip * printCov(dc - PR, aa);
  printInk(pr, cDisc, 1.0, mix(uInkSubject, uInkSubjectRim, printCov((PR - 1.2) - dc, aa)));
  // ring: ellipse 14 × 4 mm rotated −20°, stroke 1.1 mm; the far (upper) half is hidden behind the disc
  vec2 d = p - PC; const float CR = 0.93969262, SR = 0.34202014;   // cos/sin 20°
  vec2 q = vec2(CR * d.x - SR * d.y, SR * d.x + CR * d.y);           // rotate by +20° into the ring frame
  float cRing = clip * printBand(printSdEllipse(q, vec2(14.0, 4.0)), 0.55, aa);
  cRing *= 1.0 - cDisc * smoothstep(-aa, aa, q.y);
  printInk(pr, cRing, 1.0, uInkGold);
  // sparkle stars
  float sd = printSdStar4(p - vec2(45.0, 68.0), 2.5, 3.3);
  sd = min(sd, printSdStar4(p - vec2(50.0, 46.0), 1.8, 3.3));
  sd = min(sd, printSdStar4(p - vec2(13.0, 73.0), 1.4, 3.3));
  printInk(pr, clip * printCov(sd, aa), 1.0, uInkSpark);
}

// Text coverage from the text texture. pa: point in the art text layout; s: layout scale (gradients / s).
float printText(vec2 pa, vec4 dUv, float s) {
  return textureGrad(uTextTex, printTextUv(pa), dUv.xy / s, dUv.zw / s).r;
}

Print printLayer(vec2 pMm, vec4 dUv) {
  vec2 p = pMm;
  vec2 dpx = dUv.xy / PRINT_UV_PER_MM, dpy = dUv.zw / PRINT_UV_PER_MM;   // = dFdx(p), dFdy(p)
  float aa = 0.75 * max(length(abs(dpx) + abs(dpy)), 1e-4);
  float pxMm = max(sqrt(abs(dpx.x * dpy.y - dpx.y * dpy.x)), 1e-5);     // pixel size on the card [mm]

  Print pr; pr.W = 0.0; pr.T2 = vec3(1.0); pr.onWhite = vec3(RHO_WHITE); pr.silver = 0.0;
  int mode = uPrintMode;

  const vec2 BC = vec2(31.5, 44.0), BH = vec2(28.9, 41.4);           // inner border box, radius 1.2
  float sdIn = printSdBox(p, BC, BH, 1.2);

  if (mode == 3) {                                                    // art: full-art holo card
    printArt(pr, p, aa, printCov(sdIn, aa));
  } else if (mode == 2) {                                             // window: opaque face with an art window
    float sdWin = printSdRect(p, vec2(6.0, 40.0), vec2(57.0, 80.0), 0.8);
    printArt(pr, p, aa, printCov(sdWin, aa));
    printInk(pr, printCov(max(sdIn, -sdWin), aa), 1.0, uInkPanel);   // face: inside the border, outside the window
  }
  if (mode == 3 || mode == 1) {                                       // art and frame: title band, info panel, text
    float sdTB = printSdRect(p, vec2(2.6, 78.0), vec2(60.4, 85.4), 0.0);
    printTint(pr, printCov(sdTB, aa), vec3(uSmokeT2));                // smoke: dark metallic band that still glints
    float sdIP = printSdRect(p, vec2(5.0, 5.5), vec2(58.0, 19.5), 1.5);
    printInk(pr, printCov(sdIP, aa), 0.8, uInkPanel);                 // graded white underprint 0.8
    if (sdTB < aa) printInk(pr, printText(p, dUv, 1.0), 1.0, uInkText);
    if (sdIP < aa) printInk(pr, printText(p, dUv, 1.0), 1.0, uInkText);
  } else if (mode == 2) {
    vec2 pa = (p - vec2(6.0, 83.2)) / 0.6 + vec2(4.6, 81.7);        // window title ← art title, name only (x < 42)
    if (p.x > 5.5 && p.x < 36.5 && p.y > 81.6 && p.y < 85.0 && pa.x < 42.0)
      printInk(pr, printText(pa, dUv, 0.6), 1.0, uInkText);
    if (p.x > 5.5 && p.x < 57.5 && p.y > 25.0 && p.y < 36.0)
      printInk(pr, printText(p + vec2(1.0, -18.5), dUv, 1.0), 1.0, uInkText);
  }
  if (mode >= 1) {                                                     // border: ink, or bare foil
    float cB = printCov(-sdIn, aa);
    if (uBorderMode == 0) printInk(pr, cB, 1.0, uInkBorder); else printOver(pr, cB, 0.0, vec3(1.0), vec3(RHO_WHITE));
  }
  if (mode == 3) printInk(pr, printBand(sdIn, 0.15, aa), 1.0, uInkText);   // keyline printed over the inner border edge

  // Distance inside the card outline [mm] (edge silvering, corner whitening).
  vec2 half_ = 0.5 * uCardSizeMm;
  float din = -printSdBox(p, half_, half_, uCornerMm);

  // Edge silvering (card setting): within 0.08 mm of the outline W and ink fade out, so the foil shows as a thin
  // metallic line (R04 §1.2); the 0.04–0.12 mm ramp widens to the pixel so the line keeps its area when sub-pixel.
  if (uEdgeSilver > 0.5) {
    float w = max(0.04, 0.5 * aa);
    pr.silver = 1.0 - smoothstep(0.08 - w, 0.08 + w, din);
    pr.W *= 1.0 - pr.silver;
    pr.T2 = mix(pr.T2, vec3(1.0), pr.silver);
  }

  // Wear 5, corner whitening (§4.16): on two corners chosen by the card seed, within 4 mm of the corner apex along
  // the outline and up to 0.6·w_r mm inward, W → 1 and onWhite → the board white (worn ink and foil; it also
  // removes the silvered edge there).
  if (uWear > 0.0) {
    vec3 h = rnd3(ivec2(5, 7), WEAR_SEED ^ 0xC0C00000u);
    int k1 = int(h.x * 4.0), k2 = (k1 + 1 + int(h.y * 3.0)) & 3;
    for (int k = 0; k < 4; ++k) {
      if (k != k1 && k != k2) continue;
      vec2 sgn = vec2((k == 1 || k == 2) ? 1.0 : -1.0, (k >= 2) ? 1.0 : -1.0);    // 0 BL, 1 BR, 2 TR, 3 TL
      vec2 apex = half_ + sgn * (half_ - vec2(uCornerMm)) + sgn * (0.70710678 * uCornerMm);
      float s = length(p - apex);
      if (s > 4.5) continue;
      float depth = 0.6 * uWear * (1.0 - smoothstep(0.5, 4.0, s))
                  * (0.55 + 0.45 * printVNoise(vec2(s * 2.5, float(k)), WEAR_SEED ^ 0xC0C10000u));
      float cw = depth > 0.0 ? printCov(din - depth, aa) : 0.0;
      printOver(pr, cw, 1.0, vec3(1.0), vec3(RHO_WHITE));
    }
  }

  // Paper tooth: onWhite × (1 + 0.015·n), n = two value-noise octaves (0.5 and 2 mm cells, |n| ≤ 1), each faded
  // to 0 where its cell is smaller than 2 px, so the border is not a vector fill.
  float n = 0.5 * smoothstep(2.0, 4.0, 2.0 / pxMm) * printVNoise(p / 2.0, 0x7007A000u)
          + 0.5 * smoothstep(2.0, 4.0, 0.5 / pxMm) * printVNoise(p / 0.5, 0x7007B000u);
  pr.onWhite *= 1.0 + 0.015 * n;
  return pr;
}
