// dof_tile.frag — A7 pass 2: per 16 × 16-pixel tile, the largest near-field and far-field CoC radius [full px] of the
// pixels that carry an object (page pixels never scatter: they have no radiance and no coverage).
//   r = max(−CoC) over near pixels, g = max(CoC) over far pixels.
uniform sampler2D tCoc;             // dof_coc output
uniform ivec2 uSize;                // active full-resolution size

void main() {
  ivec2 t0 = ivec2(gl_FragCoord.xy) * 16;
  float nearR = 0.0, farR = 0.0;
  for (int j = 0; j < 16; ++j) {
    for (int i = 0; i < 16; ++i) {
      ivec2 q = t0 + ivec2(i, j);
      if (q.x >= uSize.x || q.y >= uSize.y) continue;
      float r = texelFetch(tCoc, q, 0).r;
      if (r >= DOF_PAGE * 0.5) continue;
      nearR = max(nearR, -r);
      farR = max(farR, r);
    }
  }
  gl_FragColor = vec4(nearR, farR, 0.0, 1.0);
}
