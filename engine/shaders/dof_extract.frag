// dof_extract.frag — A7 pass 5 (half resolution, two outputs): splits highlights off the gather input.
// A bokeh disc of a glint is a crisp, shaped, bright image of the aperture; a sparse gather can only find a one-texel
// source by chance. So every texel brighter than uK × the mean of the ring two texels out from its quarter cell (the
// 20 texels at Chebyshev distance 2 from the 2 × 2 cell: a glint straddling texels lights the ones right next to it,
// which must not count against it) and than the sprite threshold, and visibly defocused, hands its excess radiance
//   E = C · clamp(1 − uK·Y_ring / Y, 0, 1) · smoothstep(T, 2T, Y) · smoothstep(r₀, 2r₀, |r|)    (Y: largest channel)
// to the sprite pass (one aperture-shaped disc per quarter cell, dof_sprite.*) and keeps C − E in the gather: nothing
// is clamped or dimmed, the energy is only routed (gather + sprites = the input). The test is per texel against the
// local level, so dense glitter (a glint every few texels, each far above the mean) becomes a field of overlapping
// discs, as it does through a lens; the gates are smooth, so a glint drifting across texels changes the split
// continuously.
//   oCol = (C − E, coverage) → the gather (mipmapped); oHi = (E, CoC) → the sprites.
uniform sampler2D tCol;             // dof_prepare colour
uniform sampler2D tCoc;             // dof_prepare CoC [half px]
uniform ivec2 uHalf;                // active half size
uniform float uThresh;              // T: scene-linear luminance (sprite threshold / exposure)
uniform float uK;                   // contrast against the ring
uniform float uMinR;                // r₀ [half px]

layout(location = 0) out highp vec4 oCol;
layout(location = 1) out highp vec4 oHi;

// Brightness for the highlight test: the largest channel (a saturated blue or red glint is as much a highlight as a
// white one, though its luminance is small).
float brightAt(ivec2 q) {
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uHalf))) return 0.0;
  return max(max3(texelFetch(tCol, q, 0).rgb), 0.0);
}

void main() {
  ivec2 h = ivec2(gl_FragCoord.xy);
  if (h.x >= uHalf.x || h.y >= uHalf.y) { oCol = vec4(0.0); oHi = vec4(0.0); return; }
  vec4 C = texelFetch(tCol, h, 0);
  float r = cocOf(texelFetch(tCoc, h, 0).rg);
  ivec2 base = (h / 2) * 2;
  float yr = 0.0;
  for (int j = -2; j <= 3; ++j)
    for (int i = -2; i <= 3; ++i) {
      if (i != -2 && i != 3 && j != -2 && j != 3) continue;    // the ring two texels out
      yr += brightAt(base + ivec2(i, j));
    }
  yr *= 1.0 / 20.0;
  float y = max(max3(C.rgb), 0.0);
  float f = y > 0.0 ? clamp(1.0 - uK * yr / y, 0.0, 1.0) : 0.0;
  f *= smoothstep(uThresh, 2.0 * uThresh, y) * smoothstep(uMinR, 2.0 * uMinR, abs(r));
  vec3 E = max(C.rgb, 0.0) * f;
  oCol = vec4(C.rgb - E, C.a);
  oHi = vec4(E, r);
}
