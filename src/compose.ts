// Composer: puts the finished holographic layer over a frame your renderer has already drawn ("over" mode).
//
// holo.spot's output pass composites the object over a flat page colour and screens the glare onto it, in linear
// light, then encodes for the display:
//     out = a·card + (1 − a)·(1 − (1 − page)·(1 − spill))
// To do the same over an arbitrary picture without changing that pass, the kit runs it twice, once over a black page
// (B) and once over a white one (W). In linear light, per channel, W − B = (1 − a)·(1 − spill): exactly the share of
// the background that survives. So
//     out = B + (W − B)·background
// reproduces the pass's own composite over whatever your renderer drew. The canvas is copied into a texture, the sum
// is formed in linear light and encoded again, and the result replaces the canvas. Pixels the layer does not touch are
// written back unchanged.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = /* glsl */ `
uniform sampler2D tBlack; uniform sampler2D tWhite; uniform sampler2D tCanvas;
varying vec2 vUv;
vec3 decode(vec3 c) { return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045)))); }
vec3 encode(vec3 x) {
  x = clamp(x, 0.0, 1.0);
  return mix(1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, 12.92 * x, vec3(lessThanEqual(x, vec3(0.0031308))));
}
void main() {
  vec4 D = texture2D(tCanvas, vUv);
  vec3 b = texture2D(tBlack, vUv).rgb, w = texture2D(tWhite, vUv).rgb;
  if (all(lessThanEqual(b, vec3(0.0))) && all(greaterThanEqual(w, vec3(1.0)))) { gl_FragColor = D; return; }   // no layer here
  vec3 B = decode(b);
  vec3 keep = clamp(decode(w) - B, 0.0, 1.0);          // what remains of the background, per channel
  float m = max(keep.r, max(keep.g, keep.b));
  gl_FragColor = vec4(encode(B + keep * decode(D.rgb)), 1.0 - m * (1.0 - D.a));
}`;

export class Composer {
  black: THREE.WebGLRenderTarget;
  white: THREE.WebGLRenderTarget;
  private canvas: THREE.FramebufferTexture | null = null;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly size = new THREE.Vector2();

  constructor() {
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.black = rt();
    this.white = rt();
    this.material = new THREE.ShaderMaterial({
      name: "HoloCompose", vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { tBlack: { value: this.black.texture }, tWhite: { value: this.white.texture }, tCanvas: { value: null } },
      depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  resize(w: number, h: number): void {
    if (this.black.width === w && this.black.height === h) return;
    this.black.setSize(w, h);
    this.white.setSize(w, h);
  }

  /** With the canvas bound: copies what your renderer drew, then writes the composite over it. */
  render(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x)), h = Math.max(1, Math.floor(this.size.y));
    if (!this.canvas || this.canvas.image.width !== w || this.canvas.image.height !== h) {
      this.canvas?.dispose();
      this.canvas = new THREE.FramebufferTexture(w, h);
      this.canvas.minFilter = this.canvas.magFilter = THREE.NearestFilter;
      this.material.uniforms.tCanvas.value = this.canvas;
    }
    renderer.copyFramebufferToTexture(this.canvas);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.black.dispose();
    this.white.dispose();
    this.canvas?.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
