# Using the kit with a framework

The kit needs three things from any setup: the scene's `THREE.WebGLRenderer`, the objects to make holographic, and control of the render call. The snippets below show where those are in common setups. They follow each framework's documented API; unlike the pages in `recipes/`, they are not run by this repository's checks, so test them in your project with `tools/shot.mjs --url …`.

## React Three Fiber

R3F renders the scene itself after every frame. A `useFrame` callback with a priority above 0 switches that off and hands the render call to you, which is where `holo.render` goes.

```jsx
import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Holo } from "holospot";

function HoloScene() {
  const { gl, scene, camera } = useThree();
  const mesh = useRef();
  const holo = useRef();

  useEffect(() => {
    holo.current = new Holo(gl, { assets: "/holo/assets/" });       // serve the kit's assets/ folder at this URL
    holo.current.apply(mesh.current, { material: "nebula", sizeMm: 120 });
    return () => holo.current.dispose();
  }, [gl]);

  useFrame((_, dt) => {
    mesh.current.rotation.y += dt * 0.4;
    holo.current?.render(scene, camera);                             // priority 1: R3F no longer renders by itself
  }, 1);

  return (
    <mesh ref={mesh}>
      <torusKnotGeometry args={[1, 0.34, 220, 36]} />
      <meshStandardMaterial />
    </mesh>
  );
}

export default function App() {
  return (
    <Canvas camera={{ fov: 22, position: [0, 0, 9] }} gl={{ antialias: false }}>
      <HoloScene />
    </Canvas>
  );
}
```

Notes:

- Create one `Holo` per canvas, in an effect, and dispose it on unmount.
- Apply materials after the meshes exist (in an effect, or when a loaded model arrives), not during render.
- Do not add `<EffectComposer>` on top: the kit finishes the frame itself.

## A bundler (Vite, webpack, Next.js)

```js
import { Holo } from "holospot";     // or a relative path to dist/holo.js
```

- Install or copy the kit so that `dist/holo.js` is importable, and make `three` resolve to one copy for both your code and the kit (a duplicate three.js breaks `instanceof` checks and wastes memory).
- Serve the kit's `assets/` folder as static files and pass its URL: `new Holo(renderer, { assets: "/holo/assets/" })`. Bundlers do not copy it for you.
- The kit touches `window` and WebGL, so in a server-rendered app create it only in the browser (in an effect, or a component loaded without server rendering).

## Plain three.js without a build step

Use an import map, as every page in `recipes/` does. `AGENTS.md` shows it.
