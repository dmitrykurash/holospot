// dof_composite.frag — A7 pass 8 (full resolution): the output of the DoF stage, in the card target's format
// (premultiplied, ENC_S-compressed, coverage in alpha), read by the glare and the output pass in its place.
//   • Tiles whose dilated near and far reach are both < 0.5 px are copied texel for texel (in-focus areas keep the
//     card pass's pixels exactly), and so is every pixel nothing reaches.
//   • Far/in-focus pixels blend from their own sharp pixel to the half-resolution far layer over a CoC radius of
//     0.5 → 2 px (full-resolution sharpness where the blur is small, the gather where it is large); the far layer is
//     upsampled bilaterally (the 4 nearest half texels weighted by the similarity of their CoC, saturated at 6 px), so
//     a sharp edge never borrows a blurred neighbour's value while blurred areas stay smooth. Near-field pixels blend
//     their own pixel into the near layer likewise; |r| < 0.5 px counts as in focus on either side.
//   • out = N + S + (1 − A_n)·F: the near layer over the far layer, the bokeh sprites (S, near ones on top, far ones
//     already × (1 − A_n)) added as light.
//   • Coverage: A_n + (1 − A_n)·a_F, lifted on the black page to a′ = max(a, max3(C)·exposure/0.5): the output pass
//     composites a·T(C/a) over the page, which cannot show light where a ≈ 0 (a defocused glint spreads its light over
//     the page while its coverage spreads thin); with the lift C/a′ stays in the tone curve's linear range, so
//     a′·T(C/a′) ≈ C — the bokeh disc shows on the black page as the light it is. Pixels with the card's normal
//     brightness are unchanged (C/a ≤ 0.5/exposure). On white, light added to the page saturates to white anyway (no
//     lift, the page stays exact).
//   • Debug view `dof`: the signed CoC, raw (the output pass bypasses tone mapping): far = orange, near = blue, in
//     focus = black, intensity √(|r|/uMaxR) (decode r = (max(R, B)/255)²·uMaxR); the page dimmed at its CoC at infinity;
//     a legend bar at the bottom left spans −uMaxR … +uMaxR with ticks every 8 px of radius.
uniform sampler2D tHdr;             // the card pass
uniform sampler2D tCocF;            // full-resolution CoC [px]
uniform sampler2D tTile;            // dilated tiles [px]: r = near reach, g = far reach
uniform sampler2D tNear, tFar;      // gather layers (half)
uniform sampler2D tCocH;            // half-resolution (CoC·coverage, coverage) [half px] (cocOf)
uniform sampler2D tSpr;             // bokeh sprites (half)
uniform ivec2 uSize;                // active size
uniform ivec2 uHalf;                // active half size
uniform vec2 uHalfAlloc;            // allocated half size
uniform float uSmall;               // 2 px: end of the sharp → gathered blend
uniform float uLift;                // exposure / 0.5 on the black page, 0 on white
uniform int uDebug;
uniform float uMaxR;                // CoC clamp [px] (debug scale)
uniform float uPageR;               // the page's CoC [px] (debug)

vec4 encodeOut(vec3 c, float a) {
  if (a <= 1e-5) return vec4(0.0);
  vec3 cu = c / a;
  float m = max(max3(cu), 0.0) * ENC_S;
  return vec4(cu * ENC_S / (1.0 + m) * a, a);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(tHdr, p, 0);
  float r = texelFetch(tCocF, p, 0).r;
  bool page = r >= DOF_PAGE * 0.5;
  if (uDebug == 1) {
    float rr = page ? uPageR : r;
    // legend (bottom left, 256 × 14 px): CoC radius −max … +max, white ticks every 8 px of radius and at 0
    vec2 lp = gl_FragCoord.xy - vec2(12.0, 12.0);
    bool legend = lp.x >= 0.0 && lp.x < 257.0 && lp.y >= 0.0 && lp.y < 14.0;
    if (legend) rr = (floor(lp.x) - 128.0) / 128.0 * uMaxR;
    float m = sqrt(clamp(abs(rr) / uMaxR, 0.0, 1.0)) * (page && !legend ? 0.3 : 1.0);
    vec3 col = rr >= 0.0 ? vec3(1.0, 0.55, 0.1) : vec3(0.1, 0.45, 1.0);
    if (legend && lp.y < 5.0 && mod(abs(rr) + 0.25, 8.0) < uMaxR / 128.0) col = vec3(1.0), m = 1.0;
    gl_FragColor = vec4(col * m, 1.0);
    return;
  }
  vec2 reach = texelFetch(tTile, p / 16, 0).rg;
  if (max(reach.x, reach.y) < 0.5) { gl_FragColor = P; return; }

  vec2 uvH = (vec2(p) + 0.5) * 0.5 / uHalfAlloc;
  vec4 Nl = textureLod(tNear, uvH, 0.0);
  vec3 S = textureLod(tSpr, uvH, 0.0).rgb;
  float rf = page ? 0.0 : r;
  float rb = page ? uPageR : r;                                // page pixels prefer page texels (no halo at a sharp edge)

  // the far layer, upsampled bilaterally
  vec2 hp = (vec2(p) + 0.5) * 0.5 - 0.5;
  ivec2 h0 = ivec2(floor(hp));
  vec2 f = hp - vec2(h0);
  vec4 F = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; ++j)
    for (int i = 0; i < 2; ++i) {
      ivec2 q = clamp(h0 + ivec2(i, j), ivec2(0), uHalf - 1);
      float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      float rq = 2.0 * cocOf(texelFetch(tCocH, q, 0).rg);
      // discriminate sharp from blurred texels only: two blurred values (|r| ≥ 6 px) are both smooth
      float w = wb / (1.0 + 2.0 * abs(clamp(rq, -6.0, 6.0) - clamp(rb, -6.0, 6.0))) + 1e-5 * wb;
      F += w * texelFetch(tFar, q, 0);
      wsum += w;
    }
  F /= max(wsum, 1e-8);

  vec4 orig = decodeCard(P);
  vec4 Nn = Nl, Ff = F;
  bool changed = any(greaterThan(S, vec3(0.0)));
  if (rf >= -0.5) {                                             // in focus (|r| < 0.5 px either side) or far
    float t = page ? 1.0 : smoothstep(0.5, uSmall, rf);
    Ff = mix(orig, F, t);
    changed = changed || t > 0.0 || Nl.a > 0.0 || any(greaterThan(abs(Nl.rgb), vec3(0.0)));
  } else {
    float t = smoothstep(0.5, uSmall, -rf);
    Nn = mix(orig, Nl, t);
    changed = changed || t > 0.0 || (orig.a < 1.0 && F.a > 0.0);
  }
  if (!changed) { gl_FragColor = P; return; }
  float an = clamp(Nn.a, 0.0, 1.0);
  vec3 c = Nn.rgb + S + (1.0 - an) * Ff.rgb;
  float a = an + (1.0 - an) * clamp(Ff.a, 0.0, 1.0);
  a = clamp(max(a, max3(c) * uLift), 0.0, 1.0);
  gl_FragColor = encodeOut(c, a);
}
