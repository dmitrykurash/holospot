#!/usr/bin/env node
// After `vite build`: writes dist/holo.d.ts (the public types, from types/holo.d.ts) and prints the bundle's size.
import { copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(join(ROOT, "types", "holo.d.ts"), join(ROOT, "dist", "holo.d.ts"));
console.log(`dist/holo.js ${(statSync(join(ROOT, "dist", "holo.js")).size / 1024).toFixed(0)} KiB, dist/holo.d.ts written`);
