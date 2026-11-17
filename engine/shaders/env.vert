// env.vert — BackSide box around the CubeCamera at the origin; the fragment shader evaluates the studio radiance for the
// world direction of each cube texel (spec §5.3, R04 §2.5 / §6.4).
varying vec3 vDir;
void main() {
  vDir = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
