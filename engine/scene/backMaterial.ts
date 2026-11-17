// Card back material (spec §5.1, §6.4): card.vert + the library-assembled back.frag, shared uniforms spread in
// (IUniform identity kept), depth test and write (addendum A1.1 item 2: back faces of the non-convex objects, e.g. the
// inside of the can label, are occluded by their fronts), back-face culled, no tone mapping. Also the back of the bent
// card and of the sheets; for objects without the card outline main.ts sets uCornerMm so that the inset rule vanishes.
import * as THREE from "three";
import type { TierConfig, Uniforms } from "../types.ts";
import { assemble } from "../shaders/lib/index.ts";
import cardVert from "../shaders/card.vert?raw";
import backFrag from "../shaders/back.frag?raw";
import paperGlsl from "../shaders/paper.glsl?raw";
import embossGlsl from "../shaders/emboss.glsl?raw";

export interface CardShaderOptions { ldr?: boolean }

/** The define set of the non-material card shaders: the tier defines plus NSPD, MAX_LIGHTS and DEBUG_VIEW 0 (back and
 *  edge read `uDebugRaw` instead of DEBUG_VIEW, §4.14). `HOLO_LDR` gamut-maps before encodeCard (LDR fallback, §5.5). */
export function cardShaderDefines(t: TierConfig, o: CardShaderOptions = {}, extra: Record<string, string | number> = {}): Record<string, string | number> {
  return { ...t.defines, NSPD: 5, MAX_LIGHTS: 4, DEBUG_VIEW: 0, ...(o.ldr ? { HOLO_LDR: 1 } : {}), ...extra };
}

/** `extra` (A9): the active material's MaterialDef.cardDefines — EMB_STICKER: the paper back's reverse impression of the
 *  hologram sticker's analytic shapes (emboss.glsl); without it the program is exactly the pre-A9 one. */
export function buildBackMaterial(t: TierConfig, shared: Uniforms, o: CardShaderOptions = {}, extra: Record<string, string | number> = {},
  transform: (src: string) => string = (src) => src): THREE.ShaderMaterial {
  const variant = Object.keys(extra).length ? `-${Object.keys(extra).join("-").toLowerCase()}` : "";
  return new THREE.ShaderMaterial({
    name: `CardBack-${t.tier}${variant}`,
    vertexShader: cardVert,
    // A6: the paper back (uPaperCard) uses the paper and relief chunks; no parallax or cast shadows on the back
    fragmentShader: transform(assemble(cardShaderDefines(t, o, { CARD_BACK: 1, PAPER_LAYERS: 1, EMB_POM_STEPS: 0, EMB_SHADOW_STEPS: 0, ...extra }),
      [paperGlsl, embossGlsl], backFrag)),
    uniforms: { ...shared },
    side: THREE.FrontSide, depthTest: true, depthWrite: true, toneMapped: false, blending: THREE.NoBlending,
  });
}
