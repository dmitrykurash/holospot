// dof_coc.frag — A7 pass 1 (full resolution): the signed CoC radius of every pixel [device px] from the resolved
// depth of the card pass. Compiled as LIB.common + dof_common + this file.
//   r = K·(1 − z_f/z), K = A·f/(z_f − f) / 24 mm × H / 2 (lens.ts cocRadiusFactorPx), clamped to ±uMaxR.
// Silhouettes: MSAA resolves depth by picking one sample, so an edge pixel may report the cleared depth (the page) or
// either surface of a self-occlusion edge, and that choice flips as the object moves. Every pixel therefore takes the
// nearest depth of its 3 × 3 neighbourhood: an edge pixel always gets its front surface (whose colour it carries),
// steadily, frame after frame (no halo, no flicker); away from edges this moves the CoC by one pixel of depth slope.
// Pixels whose neighbourhood is all cleared depth are the page: DOF_PAGE (they carry no radiance).
uniform sampler2D tDepth;           // the card pass's resolved depth (DEPTH_COMPONENT24)
uniform ivec2 uSize;                // active size [px]
uniform float uNear, uFar;          // camera planes [m]
uniform float uZf;                  // focus distance [m]
uniform float uCocK;                // K [px]
uniform float uMaxR;                // clamp [px]

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float dmin = 1.0;
  for (int j = -1; j <= 1; ++j)
    for (int i = -1; i <= 1; ++i) {
      ivec2 q = clamp(p + ivec2(i, j), ivec2(0), uSize - 1);
      dmin = min(dmin, texelFetch(tDepth, q, 0).r);
    }
  if (dmin >= 1.0) { gl_FragColor = vec4(DOF_PAGE, 0.0, 0.0, 1.0); return; }
  float zn = 2.0 * dmin - 1.0;
  float z = 2.0 * uFar * uNear / ((uFar + uNear) - zn * (uFar - uNear));     // view distance [m]
  float r = clamp(uCocK * (1.0 - uZf / z), -uMaxR, uMaxR);
  gl_FragColor = vec4(r, 0.0, 0.0, 1.0);
}
