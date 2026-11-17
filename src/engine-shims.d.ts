// The engine files import a few types from parts of holo.spot that the kit does not ship. They are typed here so the
// engine compiles unchanged.
declare module "dialkit/vanilla" {
  /** A DialKit panel literal (holo.spot's control panels). The kit reads only the parameter tables next to it. */
  export type DialConfig = Record<string, unknown>;
}
