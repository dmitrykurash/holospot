// dof_prepare.frag — A7 pass 4 (half resolution, two outputs): each half texel is the 2 × 2 full-resolution block,
// decoded per texel into premultiplied scene-linear radiance (so a 25 %-covered glint keeps its energy: averaging the
// compressed values first would not) and averaged with its coverage; and its CoC [half px] = the nearest (smallest
// signed: the CoC is monotone in depth) of the block's object pixels — a block on a depth edge belongs to its front
// surface, as a silhouette pixel does. It is stored as (CoC·coverage, coverage) (dof_common cocOf): bilinear lookups
// and the mip levels then average the object CoC by coverage, and blocks of page only read as the page's CoC.
uniform sampler2D tHdr;             // the card pass (MSAA resolved)
uniform sampler2D tCoc;             // dof_coc output [full px]
uniform ivec2 uSize;                // active full-resolution size
uniform ivec2 uHalf;                // active half-resolution size

layout(location = 0) out highp vec4 oCol;
layout(location = 1) out highp vec4 oCoc;

void main() {
  ivec2 h = ivec2(gl_FragCoord.xy);
  if (h.x >= uHalf.x || h.y >= uHalf.y) { oCol = vec4(0.0); oCoc = vec4(0.0); return; }
  vec4 s = vec4(0.0);
  float rmin = 1e9;
  for (int j = 0; j < 2; ++j)
    for (int i = 0; i < 2; ++i) {
      ivec2 q = min(2 * h + ivec2(i, j), uSize - 1);
      s += decodeCard(texelFetch(tHdr, q, 0));
      float r = texelFetch(tCoc, q, 0).r;
      if (r < DOF_PAGE * 0.5) rmin = min(rmin, r);
    }
  oCol = 0.25 * s;
  float a = rmin < 1e8 ? max(oCol.a, 1e-3) : 0.0;              // an object block keeps a CoC even at tiny coverage
  oCoc = vec4(rmin < 1e8 ? 0.5 * rmin * a : 0.0, a, 0.0, 1.0);
}
