// The shot: holo.spot's framing and tilt for a look, in your scene's units.
//
// A shipped look is more than its material values: the site also poses the object and places the camera. These two
// helpers reproduce that, for callers who want the picture holo.spot opens with rather than their own composition.
import * as THREE from "three";
import { fitDistance } from "../engine/scene/camera.ts";
import { lensFovDeg } from "../engine/physics/lens.ts";
import type { HoloObject } from "./holo.ts";
import type { Pose, View } from "./settings.ts";

/** The tilt holo.spot rests a look at, as a rotation for your object: `mesh.rotation.copy(shotRotation(obj.pose))`. */
export function shotRotation(pose: Pose): THREE.Euler {
  const d = Math.PI / 180;
  return new THREE.Euler(pose.rx * d, (pose.ry + (pose.flip ? 180 : 0)) * d, pose.rz * d, "XYZ");
}

/**
 * Places `camera` where holo.spot places its own for `obj`: the field of view of the look's lens (the scene setting
 * `dof.lens`; 62 mm is 22°), the distance that fits the object in the frame, and the orbit of `view` (default: the
 * look's). Call it after `await obj.ready` and again when the canvas aspect changes.
 */
export function shotCamera(camera: THREE.PerspectiveCamera, obj: HoloObject, o: { aspect: number; view?: View; lensMm?: number } ): void {
  const p = obj.prepared;
  if (!p) throw new Error("holo: shotCamera needs the object to be ready (await obj.ready)");
  const view = o.view ?? obj.view, fov = lensFovDeg(o.lensMm ?? obj._lensMm());
  obj.source.updateWorldMatrix(true, false);
  const s = new THREE.Vector3().setFromMatrixScale(obj.source.matrixWorld);
  const k = (p.sizeLocal * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z))) / (obj.sizeMm * 1e-3);   // scene units per metre
  // the site's framing rule: the 63 × 88 card has its own; other cards fit their face; any other object also keeps its
  // whole bounding sphere in view, whatever its pose
  const card = obj.card;
  const frame = card && card.widthMm === 63 && card.heightMm === 88 ? null
    : { halfM: { x: p.halfM.x, y: p.halfM.y }, boundsRadiusM: p.radiusM, sphere: card === null };
  const d = fitDistance(o.aspect, frame, fov) * view.zoom * k;
  const az = (view.az * Math.PI) / 180, el = (view.el * Math.PI) / 180, c = Math.cos(el);
  // the site moves the object by `offset` [mm] in front of a camera that looks at the centre: here the camera's aim moves
  const centre = p.centerLocal.clone().applyMatrix4(obj.source.matrixWorld);
  const aim = centre.clone().sub(new THREE.Vector3(view.offset[0], view.offset[1], view.offset[2]).multiplyScalar(1e-3 * k));
  camera.fov = fov;
  camera.aspect = o.aspect;
  camera.near = 0.01 * k;
  camera.far = 20 * k;
  camera.position.set(aim.x + d * Math.sin(az) * c, aim.y + d * Math.sin(el), aim.z + d * Math.cos(az) * c);
  camera.up.set(0, 1, 0);
  camera.lookAt(aim);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
