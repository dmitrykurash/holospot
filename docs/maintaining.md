# Maintaining the kit

This page is for whoever keeps the kit in step with holo.spot. People and agents who only use the kit do not need it.

## What is copied and what is written here

| Folder | Origin | Rule |
|---|---|---|
| `engine/` | Copied from the holo.spot source, byte for byte | Never edit. `tests/engine-integrity.test.mjs` fails if a file differs from `engine/ENGINE.json` |
| `src/data/` | Exported from the holo.spot source (parameters, shipped looks, lighting presets) | Never edit by hand |
| `assets/` | The site's bump maps, hologram subjects and sample logos | Replace only together with the site's |
| `src/`, `tools/`, `docs/`, `recipes/`, `tests/` | Written for the kit | Normal code |

## After holo.spot changes

Run these from the kit's root, with the path to the holo.spot source checkout:

```
node tools/sync-engine.mjs --from "/path/to/holo-spot-source"        # engine/ and engine/ENGINE.json
node tools/export-data.mjs --from "/path/to/holo-spot-source"        # src/data/*.json
node tools/port-engine-tests.mjs --from "/path/to/holo-spot-source"  # tests/engine/ (the site's own unit tests)
node tools/gen-schema.mjs                                            # schema/holo.schema.json
node tools/gen-presets.mjs                                           # presets/
npm run typecheck && npm run build && npm test
node tools/parity.mjs --from "/path/to/holo-spot-source"             # the kit's picture against the site's
```

Then read what `npm test` says about the docs: `tests/docs.test.mjs` names every page whose tables no longer match the data, and `tests/params-data.test.mjs` every parameter that changed. Update those pages by hand.

If `sync-engine.mjs` reports a new type-only module, add a shim for it next to `src/objects-shim.d.ts`. If the kit stops compiling, the site changed an interface that `src/holo.ts` or `src/paper.ts` calls: both name the site function they mirror in their comments.

## The parity check

`tools/parity.mjs` starts the site's dev server from the source tree, renders each view of `tests/parity-views.json` once with the site and once with the kit in the same headless Chrome, and compares the pictures. A view names a material, a tilt, a quality and settings; `"card": true` compares the kit's card with the site's card, and the other views wrap a model (by default the site's own demo model, read from the source tree and not part of this repository).

The limits are a mean difference of 0.5 and a 99.9th percentile of 6 code values out of 255. Identical code paths give 0; a difference of one code value comes from the frame being finished in a different canvas size or order of passes.

Software rendering takes one to five minutes per view. Use `--only name,name` for a subset, `--size 360x270` for speed, and `--gl native` on a machine with a GPU.

## Releasing

1. `npm run build` and commit `dist/` (people load `dist/holo.js` straight from the repository).
2. Run every recipe through `tools/shot.mjs` and look at the pictures.
3. Tag the commit (`v0.1.0`, `v0.2.0` …) and update the version in the CDN address that `AGENTS.md` and `README.md` show: `https://cdn.jsdelivr.net/gh/dmitrykurash/holospot@<tag>/dist/holo.js`.
