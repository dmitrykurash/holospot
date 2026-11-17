import { defineConfig } from "vite";

// One ES module, dist/holo.js. `three` stays an import (your scene and the kit must share one copy of three.js);
// the four small three.js add-ons the engine uses are bundled in, so a page needs no "three/addons/" mapping for it.
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: false,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "holo.js" },
    // (the engine's GLB loader imports three's loaders lazily; the kit never calls it, so they stay plain imports)
    rollupOptions: { external: ["three", /^three\/addons\/(loaders|libs)\//] },
  },
  server: { host: true },
});
