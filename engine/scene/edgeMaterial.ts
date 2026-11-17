// Card edge material (spec §5.1, §6.4): card.vert + the library-assembled edge.frag (white plies, dark core, micro-bevel).
// Also the edges of the bent card and the sheets and the rims of the can label; depth test and write (A1.1 item 2).
import * as THREE from "three";
import type { TierConfig, Uniforms } from "../types.ts";
import { assemble } from "../shaders/lib/index.ts";
import cardVert from "../shaders/card.vert?raw";
import edgeFrag from "../shaders/edge.frag?raw";
import paperGlsl from "../shaders/paper.glsl?raw";
import { cardShaderDefines, type CardShaderOptions } from "./backMaterial.ts";

export function buildEdgeMaterial(t: TierConfig, shared: Uniforms, o: CardShaderOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: `CardEdge-${t.tier}`,
    vertexShader: cardVert,
    fragmentShader: assemble(cardShaderDefines(t, o, { CARD_EDGE: 1, PAPER_LAYERS: 1 }), [paperGlsl], edgeFrag),   // A6 paper edge
    uniforms: { ...shared },
    side: THREE.FrontSide, depthTest: true, depthWrite: true, toneMapped: false, blending: THREE.NoBlending,
  });
}
