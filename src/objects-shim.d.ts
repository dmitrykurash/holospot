// engine/scene/models.ts imports the type ObjectInfo from ./objects.ts (holo.spot's built-in shapes, not in the kit).
declare module "*/objects.ts" {
  export interface ObjectInfo {
    domainMm: { x: number; y: number };
    printable: boolean; slab: boolean; cardOutline: boolean; wrapU: boolean; wrapV: boolean;
    boundsRadiusM: number; frameHalfM: { x: number; y: number };
    sphereFit?: boolean; bumpDomainMm?: { x: number; y: number };
  }
}
