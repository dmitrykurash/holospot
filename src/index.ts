// holospot: the holographic materials of holo.spot for your own three.js scenes.
//
//   import * as THREE from "three";
//   import { Holo } from "holospot";
//
//   const holo = new Holo(renderer);
//   holo.apply(mesh, { material: "nebula", sizeMm: 120 });
//   renderer.setAnimationLoop(() => holo.render(scene, camera));
//
// See AGENTS.md for the whole surface in one page.
export { Holo, HoloObject } from "./holo.ts";
export type { ApplyOptions, CardOptions, Compose, HoloOptions, Quality, RenderOptions } from "./holo.ts";
export { LOOK_IDS, MATERIAL_PARAMS, SCENE_PARAMS, STUDIO_PRESETS, lookInfo, resolveSettings } from "./settings.ts";
export type { CopyBlob, LookId, ParamInfo, Pose, Resolved, SettingsInput, View } from "./settings.ts";
export { MATERIAL_IDS } from "../engine/types.ts";
export type { MaterialId, ParamValue } from "../engine/types.ts";
export { shotCamera, shotRotation } from "./shot.ts";

/** The kit's version and the holo.spot source commit its engine was copied from. */
export { VERSION, ENGINE_COMMIT } from "./version.ts";
