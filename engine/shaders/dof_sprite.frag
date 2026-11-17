// dof_sprite.frag — A7 pass 7: the bokeh disc of one highlight cell, evaluated exactly per pixel: the aperture gauge
// (blades, curvature, rotation, cat's-eye vesica; the far field sees the inverted pupil), one radius per channel
// (LoCA rims), the rim profile of its field, a one-pixel anti-aliased edge. Additive (ONE, ONE).
// A far-field disc is hidden where a sharper surface lies in front of it (the gather's behind rule: it reaches a
// nearer, in-focus or far pixel only within that pixel's own CoC) and dimmed by the near layer's coverage (1 − A_n):
// it then sits behind the blurred foreground. Near-field discs are in front of everything.
uniform sampler2D tCoc;             // CoC [half px]
uniform sampler2D tNear;            // the gather's near layer (A_n in alpha)
uniform float uRimFar, uRimNear;

flat in vec3 vE;
flat in vec3 vR;
flat in vec4 vGeo;
flat in vec2 vB;

layout(location = 0) out highp vec4 oS;

void main() {
  vec2 d = gl_FragCoord.xy - vGeo.xy;
  bool far = vGeo.w < 0.0;
  float g = apertureGauge(far ? -d : d, vB);
  vec3 t = g / vR;
  vec3 m = clamp((1.0 - t) * vR + 0.5, 0.0, 1.0);             // ≈ one-pixel edge
  if (max3(m) <= 0.0) discard;
  vec3 v = vE * m * rimProfile3(t, far ? uRimFar : uRimNear);
  if (far) {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    float rx = cocOf(texelFetch(tCoc, ip, 0).rg);
    if (rx >= -0.25 && rx < vGeo.z - 1.0) v *= clamp(max(rx, 0.0) - g + 0.5, 0.0, 1.0);
    v *= 1.0 - clamp(texelFetch(tNear, ip, 0).a, 0.0, 1.0);
  }
  oS = vec4(v, 0.0);
}
