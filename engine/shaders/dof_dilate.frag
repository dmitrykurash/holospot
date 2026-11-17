// dof_dilate.frag — A7 pass 3: tile dilation. A tile's gather radius is the largest CoC of any tile whose blur can
// reach it: tile t′ reaches t when its maximum radius is at least the distance between the two tiles' nearest pixels.
//   r = near-field reach, g = far-field reach [full px]; both < 0.5 ⇒ the tile keeps the card pass's pixels exactly.
uniform sampler2D tTile;            // dof_tile output
uniform ivec2 uTiles;               // active tile count
uniform int uReach;                 // search radius in tiles = ceil(max radius / 16)

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  float nearR = 0.0, farR = 0.0;
  for (int j = -8; j <= 8; ++j) {
    if (abs(j) > uReach) continue;
    for (int i = -8; i <= 8; ++i) {
      if (abs(i) > uReach) continue;
      ivec2 q = t + ivec2(i, j);
      if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uTiles))) continue;
      vec2 m = texelFetch(tTile, q, 0).rg;
      // distance between the nearest pixels of the two tiles
      vec2 gap = max(vec2(abs(i), abs(j)) - 1.0, 0.0) * 16.0;
      float dist = length(gap);
      if (m.x >= dist) nearR = max(nearR, m.x);
      if (m.y >= dist) farR = max(farR, m.y);
    }
  }
  gl_FragColor = vec4(nearR, farR, 0.0, 1.0);
}
