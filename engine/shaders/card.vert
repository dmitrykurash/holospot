// card.vert — shared by every card material (front, back, edge); spec §6.6, verbatim.
// World-space position, the previous frame's position (motion kernel, §4.4.2), uv and the model-rotated frame.
// The Holo cloth adds `aOcc`, its fold shadow (scene/cloth.ts); `uOcc` is 1 only while the cloth is shown, so other
// geometries (which have no such attribute) always get vOcc = 0.
attribute vec4 tangent;
attribute float aOcc;
uniform mat4 uPrevModelMatrix;
uniform float uOcc;
varying vec3 vWorldPos; varying vec3 vPrevWorldPos; varying vec2 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB;
varying float vOcc;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz; vPrevWorldPos = (uPrevModelMatrix * vec4(position, 1.0)).xyz; vUv = uv;
  mat3 m = mat3(modelMatrix);
  vN = normalize(m * normal); vT = normalize(m * tangent.xyz); vB = cross(vN, vT) * tangent.w;
  vOcc = uOcc > 0.5 ? clamp(aOcc, 0.0, 0.95) : 0.0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
