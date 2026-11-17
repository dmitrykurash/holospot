// dof_sprite.vert — A7 pass 7 (half resolution, instanced): one quad per quarter cell (2 × 2 half texels) of the
// highlight buffer (dof_extract oHi). The cell's excess radiance is summed, its CoC and position are brightness-weighted
// (so a glint drifting across texels moves its bokeh continuously), and the quad covers the bokeh disc: CoC radius of
// the widest channel + 1.5 px. Cells without excess, or barely defocused, emit a degenerate quad (clipped).
// Per channel the density is E_λ / (r_λ²·|K|): the cell's energy spread over its aperture (|K| = π·|P|/π·clip).
// Compiled as LIB.common + dof_common + this file (GLSL 3.00).
uniform sampler2D tHi;              // (E rgb, CoC [half px])
uniform ivec2 uHalf;                // active half size (= the viewport)
uniform int uCellsX;                // cells per row
uniform float uMinR;                // r₀ [half px]

flat out vec3 vE;                   // per-channel density at the disc
flat out vec3 vR;                   // per-channel |CoC| [half px]
flat out vec4 vGeo;                 // centre (xy), signed G CoC, field sign (+1 near, −1 far)
flat out vec2 vB;                   // cat's-eye offset at the centre

void main() {
  int id = gl_InstanceID;
  ivec2 base = 2 * ivec2(id % uCellsX, id / uCellsX);
  vec3 E = vec3(0.0);
  float ys = 0.0, rs = 0.0;
  vec2 cen = vec2(0.0);
  for (int j = 0; j < 2; ++j)
    for (int i = 0; i < 2; ++i) {
      ivec2 q = base + ivec2(i, j);
      if (q.x >= uHalf.x || q.y >= uHalf.y) continue;
      vec4 h = texelFetch(tHi, q, 0);
      float y = max(max3(h.rgb), 0.0);
      E += h.rgb; ys += y; rs += y * h.a; cen += y * (vec2(q) + 0.5);
    }
  if (ys <= 1e-7) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vE = vec3(0.0); vR = vec3(1.0); vGeo = vec4(0.0); vB = vec2(0.0); return; }
  rs /= ys; cen /= ys;
  vec3 rl = max(abs(chanCoc(rs)), vec3(0.5));
  if (abs(rs) < uMinR) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vE = vec3(0.0); vR = vec3(1.0); vGeo = vec4(0.0); vB = vec2(0.0); return; }
  vec2 b = catsB(cen);
  float area = 3.14159265 * uAreaRatio * max(clipArea(length(b)), 0.05);
  vE = E / (rl * rl * area);
  vR = rl;
  vGeo = vec4(cen, rs, rs < 0.0 ? 1.0 : -1.0);
  vB = b;
  float ext = max3(rl) + 1.5;
  vec2 p = cen + position.xy * ext;
  gl_Position = vec4(p / vec2(uHalf) * 2.0 - 1.0, 0.0, 1.0);
}
