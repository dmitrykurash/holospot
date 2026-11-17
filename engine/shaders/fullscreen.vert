// fullscreen.vert — the FullScreenQuad triangle (three/addons/postprocessing/Pass.js): positions (−1, 3), (−1, −1),
// (3, −1) already in clip space, uv (0, 2), (0, 0), (2, 0). Used by the glare and output passes (§5.5).
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
