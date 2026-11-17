import engine from "../engine/ENGINE.json" with { type: "json" };

export const VERSION = "0.1.0";
/** The commit of the holo.spot source the engine files were copied from. */
export const ENGINE_COMMIT: string = (engine as { sourceCommit: string }).sourceCommit;
