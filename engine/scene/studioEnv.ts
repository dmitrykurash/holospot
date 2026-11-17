// Procedural studio environment (spec §5.3, §5.2, §4.6; R04 §2.5, §6.4): env.frag on a BackSide box is captured by a
// CubeCamera into `cubeRT` (HalfFloat, no depth, no mips), then `pmrem.fromCubemap(cubeRT.texture, envRT)` prefilters
// it into the reused PMREM cube (r187: a true cube render target with one mip per roughness knot, sampled with
// textureLod on a samplerCube). Regenerate only when a value changes; the caller debounces slider drags (≤ 10 Hz).
import * as THREE from "three";
import type { Quat, Uniforms } from "../types.ts";
import { mulberry32 } from "./relief.ts";
import envVert from "../shaders/env.vert?raw";
import envFrag from "../shaders/env.frag?raw";

export interface StudioEnvValues { rims: number; fill: number; scrim: number; cameraSide: number; cameraTexture: number; behind: number }

/** Fixed seed of the camera-side texture blobs (5 soft blobs, angular σ 12–25°, §5.3). */
export const CAMERA_SIDE_SEED = 0x51ed;

export interface CameraSideBlobs { blobs: THREE.Vector4[]; norm: number }

/** Seeded blobs over the camera-side hemisphere (z > 0) and the hemisphere mean m of 0.5 + 4.5·B (solid-angle
 *  measure), so that f = (0.5 + 4.5·B)/m has mean 1 (the camera-side level stays `camera side`). */
export function cameraSideBlobs(seed = CAMERA_SIDE_SEED): CameraSideBlobs {
  const rnd = mulberry32(seed);
  const blobs: THREE.Vector4[] = [];
  for (let k = 0; k < 5; k++) {
    const z = rnd(), phi = 2 * Math.PI * rnd();                 // uniform on the hemisphere
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    const sigma = (12 + 13 * rnd()) * Math.PI / 180;
    blobs.push(new THREE.Vector4(s * Math.cos(phi), s * Math.sin(phi), z, sigma));
  }
  // m = (1/2π)∫_{z>0} (0.5 + 4.5·B) dω on a stratified (z, φ) grid (uniform in solid angle).
  const NZ = 96, NP = 192;
  let sum = 0;
  for (let i = 0; i < NZ; i++) {
    const z = (i + 0.5) / NZ, s = Math.sqrt(1 - z * z);
    for (let j = 0; j < NP; j++) {
      const phi = (2 * Math.PI * (j + 0.5)) / NP;
      const x = s * Math.cos(phi), y = s * Math.sin(phi);
      let B = 0;
      for (const b of blobs) {
        const a = Math.acos(Math.min(1, Math.max(-1, x * b.x + y * b.y + z * b.z))) / b.w;
        B = Math.max(B, Math.exp(-0.5 * a * a));
      }
      sum += 0.5 + 4.5 * B;
    }
  }
  return { blobs, norm: sum / (NZ * NP) };
}

export class StudioEnv {
  private readonly r: THREE.WebGLRenderer;
  readonly size: 256 | 512;
  private readonly cubeRT: THREE.WebGLCubeRenderTarget;
  private readonly cubeCam: THREE.CubeCamera;
  private readonly scene = new THREE.Scene();
  private readonly material: THREE.ShaderMaterial;
  private readonly box: THREE.Mesh;
  private readonly pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLCubeRenderTarget | null = null;
  private last: StudioEnvValues | null = null;
  /** Milliseconds (CPU wall time, including GPU sync only where the driver blocks) of the last regeneration. */
  lastMs = 0;

  constructor(r: THREE.WebGLRenderer, size: 256 | 512) {
    this.r = r;
    this.size = size;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.cubeRT.texture.name = "studioCapture";
    this.cubeCam = new THREE.CubeCamera(0.05, 10, this.cubeRT);
    const blobs = cameraSideBlobs();
    this.material = new THREE.ShaderMaterial({
      name: "StudioEnv", vertexShader: envVert, fragmentShader: envFrag,
      uniforms: {
        uRims: { value: 3 }, uFill: { value: 0.4 }, uScrim: { value: 0.4 }, uCameraSide: { value: 0.004 },
        uCameraTexture: { value: 1 }, uBehind: { value: 0 },
        uBlobs: { value: blobs.blobs }, uBlobNorm: { value: blobs.norm },
      },
      side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    });
    this.box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.box.frustumCulled = false;
    this.scene.add(this.box);
    this.scene.add(this.cubeCam);
    this.pmrem = new THREE.PMREMGenerator(r);
    this.pmrem.compileCubemapShader();
  }

  /** PMREM cube texture (`uEnv`). Before the first `update` it is null. */
  get texture(): THREE.Texture { return (this.envRT?.texture ?? null) as THREE.Texture; }
  /** `uEnvMaxLod` = mip count − 1 (6 for 512, 5 for 256). */
  get maxLod(): number { return this.envRT ? this.envRT.texture.mipmaps.length - 1 : 0; }
  get ready(): boolean { return this.envRT !== null; }

  /** True when `e` differs from the values of the current cube (or no cube exists yet). */
  changed(e: StudioEnvValues): boolean {
    const l = this.last;
    return !this.envRT || !l || l.rims !== e.rims || l.fill !== e.fill || l.scrim !== e.scrim || l.cameraSide !== e.cameraSide
      || l.cameraTexture !== e.cameraTexture || l.behind !== e.behind;
  }

  /** Debounced regeneration for the frame loop (§5.3): call every frame with the current values (after the §5.2
   *  background adaptation, e.g. physics/geometry.ts `envLevels`); regenerates at most every `minIntervalMs` while
   *  they keep changing, immediately when `immediate` (freeze=1) or on the first call. Returns true if it regenerated. */
  updateDebounced(e: StudioEnvValues, nowMs: number, immediate = false, minIntervalMs = 100): boolean {
    if (!this.changed(e)) return false;
    if (!immediate && this.envRT && nowMs - this.lastRegen < minIntervalMs) return false;
    this.update(e);
    this.lastRegen = nowMs;
    return true;
  }
  private lastRegen = -Infinity;

  /** Regenerates the capture and the PMREM if any value changed (or on the first call). */
  update(e: StudioEnvValues): void {
    if (!this.changed(e)) return;
    const t0 = performance.now();
    const u = this.material.uniforms;
    u.uRims.value = e.rims; u.uFill.value = e.fill; u.uScrim.value = e.scrim;
    u.uCameraSide.value = e.cameraSide; u.uCameraTexture.value = e.cameraTexture; u.uBehind.value = e.behind;

    const r = this.r;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;                                         // the BackSide box covers every texel
    this.cubeCam.update(r, this.scene);
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    this.envRT.texture.name = "studioPMREM";
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    this.last = { ...e };
    this.lastMs = performance.now() - t0;
  }

  /** Writes `uEnv`, `uEnvMaxLod` and `uEnvIntensity` into the shared uniforms. */
  apply(u: Uniforms, intensity = 1): void {
    if (u.uEnv) u.uEnv.value = this.envRT ? this.envRT.texture : null;
    if (u.uEnvMaxLod) u.uEnvMaxLod.value = this.maxLod;
    if (u.uEnvIntensity) u.uEnvIntensity.value = intensity;
  }

  dispose(): void {
    this.cubeRT.dispose();
    this.envRT?.dispose();
    this.envRT = null;
    this.pmrem.dispose();
    this.material.dispose();
    this.box.geometry.dispose();
  }
}

const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _rz = new THREE.Matrix4();

/** `uEnvRot` = R_z(−rotation)·mat3(conj(Q_L)) (§6.5): world direction → environment lookup direction, so the
 *  environment turns by `rotation (°)` about +Z and stays world-locked with the lights under the gyro. */
export function envRotation(rotationDeg: number, QL: Quat, out = new THREE.Matrix3()): THREE.Matrix3 {
  _q.set(QL.x, QL.y, QL.z, QL.w).normalize().invert();          // conj(Q_L)
  _m4.makeRotationFromQuaternion(_q);
  _rz.makeRotationZ((-rotationDeg * Math.PI) / 180);
  _rz.multiply(_m4);
  return out.setFromMatrix4(_rz);
}

/** Sets `uEnvRot` in the shared uniforms (call per frame when the gyro is active, or when the rotation changes). */
export function setEnvRotation(u: Uniforms, rotationDeg: number, QL: Quat): void {
  const m = u.uEnvRot?.value;
  if (m instanceof THREE.Matrix3) envRotation(rotationDeg, QL, m);
}
