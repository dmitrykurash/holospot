// Camera fit (spec §5.4; addendum A1.1 item 4, A3.3 item 7): PerspectiveCamera(fov 22° vertical, near 0.01 m, far 20 m)
// at (0, 0, D) looking at the origin. The card: D = max((0.088/0.70)/(2·tan 11°), (0.063/0.80)/(2·tan 11°·aspect)), so it
// fills 70 % of the height or 80 % of the width (0.3234 m at 4:3, 0.4384 m at 390 × 844). Other objects use the same
// rule with their rest-pose half extents (`ObjectInfo.frameHalfM`), never closer than 2.5 bounding radii (so no rotation
// can bring a part near the lens). A user's model (A3) can have any shape and depth, so its fit also keeps the whole
// bounding sphere inside 92 % of the narrower half field of view, whatever the pose (`sphereFit`): a card-like model
// still frames like the card, a cube shows at ≈ 51 % of the height. The object moves, never the camera (R04 §4).
// Addendum A2.3.4: the `camDist` session switch replaces the fitted distance (5th parameter of `fitCamera`).
// Addendum A7.2: the depth-of-field `lens` (mm) sets the fov (physics/lens.ts lensFovDeg; 22° at the default 62 mm) and
// the fitted distance scales with it, so the object keeps its framing (6th parameter of `fitCamera`, 3rd of
// `fitDistance`; calibration views with `camDist` keep 22°).
import type * as THREE from "three";
import type { Vec2 } from "../types.ts";
import { cameraDistance, framingDistance } from "../physics/geometry.ts";

export const CAMERA_FOV_DEG = 22;
export const CAMERA_NEAR = 0.01;
export const CAMERA_FAR = 20;
/** Fraction of the narrower half field of view the bounding sphere may fill (sphere fit). */
export const SPHERE_FIT_FILL = 0.92;

/** The framing of a non-card object: rest-pose half extents and bounding radius [m]; `sphere`: keep the bounding
 *  sphere in view in any pose (A3 models). */
export interface CameraFrame { halfM: Vec2; boundsRadiusM: number; sphere?: boolean }

/** Camera distance for a viewport aspect: the card's (§5.4) without `frame`, else the object's. */
export function fitDistance(aspect: number, frame?: CameraFrame | null, fovDeg: number = CAMERA_FOV_DEG): number {
  if (!frame) return cameraDistance(aspect, fovDeg);
  // A7.2: the 2.5-bounding-radii floor scales with the lens too (a longer lens steps back to keep the framing)
  const floor = 2.5 * frame.boundsRadiusM * (fovDeg === CAMERA_FOV_DEG ? 1 : Math.tan((CAMERA_FOV_DEG * Math.PI) / 360) / Math.tan((fovDeg * Math.PI) / 360));
  const extents = Math.max(framingDistance(aspect, frame.halfM.x, frame.halfM.y, fovDeg), floor);
  if (!frame.sphere) return extents;
  const halfV = (fovDeg * Math.PI) / 360, halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 1e-6));
  return Math.max(extents, frame.boundsRadiusM / Math.sin(SPHERE_FIT_FILL * Math.min(halfV, halfH)));
}

/**
 * Places the camera at (0, 0, D) looking at the object centre: D fitted to the viewport (`fitDistance`), or
 * `distOverrideM` when given (addendum A2.3.4 `camDist`: a physical macro view at a fixed distance, same fov and near
 * plane, the 4th parameter `frame` keeping its meaning).
 */
export function fitCamera(cam: THREE.PerspectiveCamera, cssW: number, cssH: number, frame?: CameraFrame | null,
  distOverrideM?: number | null, fovDeg: number = CAMERA_FOV_DEG): void {
  const aspect = Math.max(cssW, 1) / Math.max(cssH, 1);
  const calib = distOverrideM != null && distOverrideM > 0;
  const fov = calib ? CAMERA_FOV_DEG : fovDeg;              // A7.2: camDist views keep 22°
  cam.fov = fov;
  cam.near = CAMERA_NEAR;
  cam.far = CAMERA_FAR;
  cam.aspect = aspect;
  cam.position.set(0, 0, calib ? (distOverrideM as number) : fitDistance(aspect, frame, fov));
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}
