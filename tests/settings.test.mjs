// src/settings.ts: how a caller's settings resolve (parameter default ← the look holo.spot ships ← the caller's
// settings), what a look is, and how resolved scene values turn into the state the engine takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOOK_IDS, MATERIAL_PARAMS, SCENE_PARAMS, STUDIO_PRESETS, lookInfo, resolveSettings, sceneStateFrom,
} from "../src/settings.ts";
import { MATERIAL_IDS } from "../engine/types.ts";
import looks from "../src/data/looks.json" with { type: "json" };

const defaultsOf = (params) => Object.fromEntries(params.map((p) => [p.id, p.default]));
const SCENE_DEFAULTS = defaultsOf(SCENE_PARAMS);
const sceneIds = new Set(SCENE_PARAMS.map((p) => p.id));
const materialIds = (m) => new Set(MATERIAL_PARAMS[m].map((p) => p.id));

/** What a look resolves to with no settings: the defaults with the shipped values written over them. */
function shippedOver(look, material) {
  const shipped = looks[look].surfaces[material].values;
  const scene = { ...SCENE_DEFAULTS }, values = defaultsOf(MATERIAL_PARAMS[material]);
  for (const [id, v] of Object.entries(shipped)) {
    if (sceneIds.has(id)) scene[id] = v;
    else if (materialIds(material).has(id)) values[id] = v;
    else assert.fail(`looks.json: ${look}/${material} ships "${id}", which is not a parameter`);
  }
  scene["scene.material"] = material;
  return { scene, values };
}

// ---- parameter defaults ---------------------------------------------------------------------------------------

test("look \"plain\": every parameter at its default, Diffraction Foil unless a material is named", () => {
  const r = resolveSettings({ look: "plain" });
  assert.equal(r.look, "plain");
  assert.equal(r.material, "prism");
  assert.deepEqual(r.scene, { ...SCENE_DEFAULTS, "scene.material": "prism" });
  assert.deepEqual(r.values, defaultsOf(MATERIAL_PARAMS.prism));
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.view, { az: 0, el: 0, zoom: 1, offset: [0, 0, 0] });
  assert.deepEqual(r.pose, { rx: 0, ry: 0, rz: 0, flip: false });
  assert.deepEqual(r.assets, {});
});

test("look \"plain\" on each material: that material's defaults, and scene.material names it", () => {
  for (const m of MATERIAL_IDS) {
    const r = resolveSettings({ look: "plain", material: m });
    assert.equal(r.material, m);
    assert.deepEqual(r.values, defaultsOf(MATERIAL_PARAMS[m]), m);
    assert.deepEqual(r.scene, { ...SCENE_DEFAULTS, "scene.material": m }, m);
    assert.deepEqual(Object.keys(r.scene), SCENE_PARAMS.map((p) => p.id), `${m}: every scene parameter, in table order`);
  }
});

test("resolved values are copies: changing one result does not change the next", () => {
  const a = resolveSettings({ look: "plain" });
  a.scene["studio.panel.dir"].x = 99;
  a.scene["display.ev"] = -9;
  const b = resolveSettings({ look: "plain" });
  assert.deepEqual(b.scene["studio.panel.dir"], SCENE_DEFAULTS["studio.panel.dir"]);
  assert.equal(b.scene["display.ev"], SCENE_DEFAULTS["display.ev"]);
  assert.notEqual(SCENE_DEFAULTS["studio.panel.dir"].x, 99, "the parameter table itself was changed");
});

// ---- a shipped look over the defaults -------------------------------------------------------------------------

test("no look given: holo.spot's 3D object, on the material it opens with", () => {
  const r = resolveSettings({});
  assert.equal(r.look, "object");
  assert.equal(r.material, looks.object.material);
  assert.deepEqual(r.scene, shippedOver("object", r.material).scene);
  assert.deepEqual(r.values, shippedOver("object", r.material).values);
  assert.deepEqual(r.view, looks.object.surfaces[r.material].view);
  assert.deepEqual(r.pose, looks.object.surfaces[r.material].pose);
  assert.deepEqual(r.unknown, []);
});

test("every shipped look on every material it ships: the shipped values over the defaults, the rest untouched", () => {
  let checked = 0;
  for (const look of LOOK_IDS) {
    if (look === "plain") continue;
    for (const m of Object.keys(looks[look].surfaces)) {
      const r = resolveSettings({ look, material: m }), want = shippedOver(look, m);
      assert.equal(r.look, look);
      assert.equal(r.material, m);
      assert.deepEqual(r.scene, want.scene, `${look}/${m} scene`);
      assert.deepEqual(r.values, want.values, `${look}/${m} values`);
      assert.deepEqual(r.view, looks[look].surfaces[m].view, `${look}/${m} view`);
      assert.deepEqual(r.pose, looks[look].surfaces[m].pose, `${look}/${m} pose`);
      assert.deepEqual(r.unknown, [], `${look}/${m}`);
      checked++;
    }
  }
  assert.ok(checked >= 6, "looks.json ships no looks");
});

test("a shipped look really differs from the defaults (the 3D object on Diffraction Foil)", () => {
  const shipped = looks.object.surfaces.prism.values;
  const r = resolveSettings({ look: "object", material: "prism" });
  assert.equal(r.values["prism.pitch"], shipped["prism.pitch"]);
  assert.notEqual(shipped["prism.pitch"], defaultsOf(MATERIAL_PARAMS.prism)["prism.pitch"]);
  assert.equal(r.scene["display.ev"], shipped["display.ev"]);
  assert.notEqual(shipped["display.ev"], SCENE_DEFAULTS["display.ev"]);
  // a parameter the look does not ship keeps its default
  const untouched = MATERIAL_PARAMS.prism.find((p) => !(p.id in shipped));
  assert.deepEqual(r.values[untouched.id], untouched.default);
});

test("a look on a material holo.spot does not ship it on falls back to the 3D object's, then the cloth's", () => {
  // the image card ships Foil Emboss only: on Diffraction Foil it takes the 3D object's shipped values
  assert.ok(!("prism" in looks.image.surfaces) && "prism" in looks.object.surfaces);
  const a = resolveSettings({ look: "image", material: "prism" });
  assert.equal(a.look, "image");
  assert.deepEqual(a.values, shippedOver("object", "prism").values);
  assert.deepEqual(a.view, looks.object.surfaces.prism.view);
  // the card and the 3D object do not ship Foil Emboss: the card on it takes the cloth's
  assert.ok(!("emboss" in looks.card.surfaces) && !("emboss" in looks.object.surfaces) && "emboss" in looks.cloth.surfaces);
  const b = resolveSettings({ look: "card", material: "emboss" });
  assert.deepEqual(b.values, shippedOver("cloth", "emboss").values);
  assert.deepEqual(b.scene, shippedOver("cloth", "emboss").scene);
});

// ---- the caller's settings over the look ----------------------------------------------------------------------

test("a flat settings map goes over the shipped look", () => {
  const base = resolveSettings({ look: "object", material: "prism" });
  const r = resolveSettings({ look: "object", material: "prism", settings: { "prism.pitch": 1234, "display.ev": 1.5, "studio.panel.dir": { x: 0.1, y: 0.2 } } });
  assert.equal(r.values["prism.pitch"], 1234);
  assert.equal(r.scene["display.ev"], 1.5);
  assert.deepEqual(r.scene["studio.panel.dir"], { x: 0.1, y: 0.2 });
  assert.deepEqual(r.unknown, []);
  // everything else is the shipped look
  assert.deepEqual({ ...r.values, "prism.pitch": base.values["prism.pitch"] }, base.values);
  assert.deepEqual({ ...r.scene, "display.ev": base.scene["display.ev"], "studio.panel.dir": base.scene["studio.panel.dir"] }, base.scene);
  assert.deepEqual(r.view, base.view);
  assert.deepEqual(r.pose, base.pose);
});

test("a flat settings map goes over the plain defaults too, and an undefined value is skipped", () => {
  const r = resolveSettings({ look: "plain", material: "nebula", settings: { "nebula.size": 320, "nebula.shape": undefined, "grain.on": false } });
  assert.equal(r.values["nebula.size"], 320);
  assert.equal(r.values["nebula.shape"], defaultsOf(MATERIAL_PARAMS.nebula)["nebula.shape"]);
  assert.equal(r.scene["grain.on"], false);
  assert.deepEqual(r.unknown, []);
});

test("null and missing settings change nothing", () => {
  const base = resolveSettings({ look: "card" });
  assert.deepEqual(resolveSettings({ look: "card", settings: null }), base);
  assert.deepEqual(resolveSettings({ look: "card", settings: undefined }), base);
  assert.deepEqual(resolveSettings({ look: "card", settings: {} }), base);
});

test("scene.material always names the resolved material, whatever the settings say", () => {
  const r = resolveSettings({ look: "plain", material: "vortex", settings: { "scene.material": "prism" } });
  assert.equal(r.material, "vortex");
  assert.equal(r.scene["scene.material"], "vortex");
  assert.deepEqual(r.unknown, []);
});

// ---- a Copy settings blob -------------------------------------------------------------------------------------

test("a Copy settings blob brings its entity and its material", () => {
  const blob = { holoDev: 1, entity: "object", material: "prism", values: { "prism.pitch": 900, "display.ev": 1.1 } };
  const r = resolveSettings({ settings: blob });
  assert.equal(r.look, "object");
  assert.equal(r.material, "prism");
  assert.equal(r.values["prism.pitch"], 900);
  assert.equal(r.scene["display.ev"], 1.1);
  // under the blob's values: what holo.spot ships for that entity on that material
  const base = resolveSettings({ look: "object", material: "prism" });
  assert.deepEqual({ ...r.values, "prism.pitch": base.values["prism.pitch"] }, base.values);
  assert.deepEqual({ ...r.scene, "display.ev": base.scene["display.ev"] }, base.scene);
  assert.deepEqual(r.view, base.view);
  assert.deepEqual(r.pose, base.pose);
  assert.deepEqual(r.assets, {});
  assert.deepEqual(r.unknown, []);
});

test("a blob of another entity resolves over that entity's look", () => {
  const r = resolveSettings({ settings: { holoDev: 1, entity: "card", material: "volume", values: {} } });
  assert.equal(r.look, "card");
  assert.equal(r.material, "volume");
  assert.deepEqual(r.values, shippedOver("card", "volume").values);
  assert.deepEqual(r.scene, shippedOver("card", "volume").scene);
});

test("a blob's view, pose and assets come back as given", () => {
  const view = { az: 12, el: -3, zoom: 1.4, offset: [1, 2, 3] }, pose = { rx: 5, ry: -6, rz: 7, flip: true };
  const assets = { logo: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" };
  const r = resolveSettings({ settings: { holoDev: 1, entity: "object", material: "prism", values: {}, view, pose, assets } });
  assert.deepEqual(r.view, view);
  assert.deepEqual(r.pose, pose);
  assert.deepEqual(r.assets, assets);
});

test("material and look given beside a blob win over the blob's", () => {
  const blob = { holoDev: 1, entity: "object", material: "prism", values: { "prism.pitch": 900, "vortex.swirl": 3 } };
  const r = resolveSettings({ material: "vortex", look: "card", settings: blob });
  assert.equal(r.look, "card");
  assert.equal(r.material, "vortex");
  assert.equal(r.values["vortex.swirl"], 3);
  assert.ok(!("prism.pitch" in r.values), "a value of the blob's own material is dropped on another material");
  assert.deepEqual(r.unknown, []);
});

test("a blob whose entity holospot does not know resolves over the 3D object", () => {
  const r = resolveSettings({ settings: { holoDev: 1, entity: "hovercraft", material: "prism", values: {} } });
  assert.equal(r.look, "object");
  assert.deepEqual(r.values, shippedOver("object", "prism").values);
});

test("only { holoDev: 1, values: {…} } is a blob: anything else is read as a flat map", () => {
  // no holoDev marker: `entity`, `material` and `values` are just three ids that are not parameters
  const r = resolveSettings({ look: "plain", settings: { entity: "card", material: "volume", values: { "prism.pitch": 900 } } });
  assert.equal(r.material, "prism");
  assert.equal(r.values["prism.pitch"], defaultsOf(MATERIAL_PARAMS.prism)["prism.pitch"]);
  assert.deepEqual(r.unknown, ["entity", "material", "values"]);
});

// ---- studio.preset --------------------------------------------------------------------------------------------

test("studio.preset writes that preset's light values", () => {
  for (const [name, preset] of Object.entries(STUDIO_PRESETS)) {
    const r = resolveSettings({ look: "plain", settings: { "studio.preset": name } });
    assert.equal(r.scene["studio.preset"], name);
    for (const [id, v] of Object.entries(preset)) assert.deepEqual(r.scene[id], v, `${name}: ${id}`);
    // and nothing else: every other scene value is its default
    const rest = { ...r.scene };
    for (const id of [...Object.keys(preset), "studio.preset"]) rest[id] = SCENE_DEFAULTS[id];
    assert.deepEqual(rest, { ...SCENE_DEFAULTS, "scene.material": "prism" }, name);
    assert.deepEqual(r.unknown, [], name);
  }
});

test("studio.preset: light values given alongside win, whichever comes first in the settings", () => {
  const spot = STUDIO_PRESETS.spot;
  assert.equal(spot["studio.panel.on"], false);
  assert.notEqual(spot["studio.spotA.radiance"], 50);
  const after = resolveSettings({ look: "plain", settings: { "studio.preset": "spot", "studio.spotA.radiance": 50, "studio.panel.on": true } });
  const before = resolveSettings({ look: "plain", settings: { "studio.spotA.radiance": 50, "studio.panel.on": true, "studio.preset": "spot" } });
  for (const r of [after, before]) {
    assert.equal(r.scene["studio.spotA.radiance"], 50);
    assert.equal(r.scene["studio.panel.on"], true);
    assert.deepEqual(r.scene["studio.spotA.dir"], spot["studio.spotA.dir"], "the preset's other values still apply");
    assert.equal(r.scene["studio.spotB.on"], spot["studio.spotB.on"]);
  }
  assert.deepEqual(after.scene, before.scene);
});

test("studio.preset goes over a shipped look's lights and leaves what the preset does not name", () => {
  const shipped = looks.object.surfaces.prism.values, dark = STUDIO_PRESETS.dark;
  assert.equal(shipped["studio.spotC.on"], true);
  assert.ok(!("studio.spotA.size" in dark) && "studio.spotA.size" in shipped);
  const r = resolveSettings({ look: "object", material: "prism", settings: { "studio.preset": "dark" } });
  assert.equal(r.scene["studio.spotC.on"], false);
  assert.equal(r.scene["studio.ambient.rims"], dark["studio.ambient.rims"]);
  assert.equal(r.scene["studio.spotA.size"], shipped["studio.spotA.size"]);
});

test("studio.preset in a Copy settings blob works the same way", () => {
  const r = resolveSettings({ settings: { holoDev: 1, entity: "object", material: "prism", values: { "studio.preset": "softbox", "studio.panel.width": 22 } } });
  assert.equal(r.scene["studio.panel.width"], 22);
  assert.equal(r.scene["studio.panel.length"], STUDIO_PRESETS.softbox["studio.panel.length"]);
  assert.equal(r.scene["studio.spotA.on"], false);
});

test("a preset name that does not exist changes no light", () => {
  for (const name of ["moonlight", "constructor", "__proto__", "toString"]) {
    const r = resolveSettings({ look: "plain", settings: { "studio.preset": name } });
    assert.deepEqual({ ...r.scene, "studio.preset": SCENE_DEFAULTS["studio.preset"] }, { ...SCENE_DEFAULTS, "scene.material": "prism" }, name);
    assert.deepEqual(r.unknown, [], name);
  }
});

// ---- ids that are not parameters ------------------------------------------------------------------------------

test("ids that are no parameter at all are reported in `unknown`, in the order given", () => {
  const r = resolveSettings({ look: "plain", settings: { "prism.nope": 1, "prism.pitch": 800, bogus: true, "studio.spotZ.on": false } });
  assert.deepEqual(r.unknown, ["prism.nope", "bogus", "studio.spotZ.on"]);
  assert.equal(r.values["prism.pitch"], 800);
  assert.ok(!("prism.nope" in r.values) && !("bogus" in r.scene) && !("bogus" in r.values));
});

test("unknown ids in a Copy settings blob are reported too", () => {
  const r = resolveSettings({ settings: { holoDev: 1, entity: "object", material: "prism", values: { "prism.pitch": 800, "wall.sticker": 3 } } });
  assert.deepEqual(r.unknown, ["wall.sticker"]);
});

test("ids of another material are ignored silently", () => {
  const r = resolveSettings({ look: "plain", material: "prism", settings: { "nebula.size": 300, "volume.subject": "wolf", "prism.pitch": 800 } });
  assert.deepEqual(r.unknown, []);
  assert.ok(!("nebula.size" in r.values) && !("volume.subject" in r.values));
  assert.ok(!("nebula.size" in r.scene) && !("volume.subject" in r.scene));
  assert.deepEqual(r.values, { ...defaultsOf(MATERIAL_PARAMS.prism), "prism.pitch": 800 });
});

test("an unknown material throws and names the materials there are", () => {
  assert.throws(() => resolveSettings({ material: "chrome" }), (e) => e instanceof Error && e.message.includes("unknown material \"chrome\"") && MATERIAL_IDS.every((m) => e.message.includes(m)));
  assert.throws(() => resolveSettings({ settings: { holoDev: 1, entity: "object", material: "oilslick", values: {} } }), /unknown material "oilslick"/);
  assert.throws(() => resolveSettings({ look: "plain", material: "" }), /unknown material/);
  assert.throws(() => resolveSettings({ look: "plain", material: "Prism" }), /unknown material/, "ids are case-sensitive");
  assert.throws(() => resolveSettings({ look: "plain", material: "toString" }), /unknown material/);
});

// ---- lookInfo -------------------------------------------------------------------------------------------------

test("lookInfo: plain is the parameter defaults on any material", () => {
  assert.deepEqual(lookInfo("plain"), { title: "Parameter defaults", material: "prism", quality: "medium", materials: [...MATERIAL_IDS] });
});

test("lookInfo: each shipped look's title, opening material, quality and materials", () => {
  for (const look of LOOK_IDS) {
    if (look === "plain") continue;
    const info = lookInfo(look);
    assert.equal(info.title, looks[look].title);
    assert.equal(info.material, looks[look].material);
    assert.equal(info.quality, looks[look].quality);
    assert.ok(["low", "medium", "high"].includes(info.quality), `${look}: quality ${info.quality}`);
    assert.deepEqual(info.materials, Object.keys(looks[look].surfaces));
    assert.ok(info.materials.includes(info.material), `${look} opens with ${info.material}, which it does not ship`);
    assert.ok(info.materials.every((m) => MATERIAL_IDS.includes(m)), `${look}: a material that does not exist`);
    assert.equal(resolveSettings({ look }).material, info.material, `${look}: resolveSettings opens with another material`);
  }
});

test("LOOK_IDS: holo.spot's entities, then plain; looks.json has exactly the entities", () => {
  assert.deepEqual([...LOOK_IDS], [...Object.keys(looks), "plain"]);
});

// ---- sceneStateFrom -------------------------------------------------------------------------------------------

test("sceneStateFrom: the parameter defaults give holo.spot's default scene", () => {
  const s = sceneStateFrom(resolveSettings({ look: "plain" }).scene);
  assert.equal(s.background, SCENE_DEFAULTS["scene.background"]);
  assert.equal(s.bgColor, SCENE_DEFAULTS["scene.bgColor"]);
  assert.equal(s.print, SCENE_DEFAULTS["scene.print"]);
  assert.equal(s.display.ev, SCENE_DEFAULTS["display.ev"]);
  assert.equal(s.display.tone, SCENE_DEFAULTS["display.tone"]);
  assert.equal(s.grain.amount, SCENE_DEFAULTS["grain.amount"]);
  assert.equal(s.studio.panel.on, SCENE_DEFAULTS["studio.panel.on"]);
  assert.deepEqual(s.studio.panel.dir, SCENE_DEFAULTS["studio.panel.dir"]);
  assert.equal(s.studio.panel.widthDeg, SCENE_DEFAULTS["studio.panel.width"]);
  assert.equal(s.studio.spotA.radiance, SCENE_DEFAULTS["studio.spotA.radiance"]);
  assert.equal(s.studio.spotB.distanceM, SCENE_DEFAULTS["studio.spotB.distance"]);
  assert.equal(s.studio.spotC.on, SCENE_DEFAULTS["studio.spotC.on"]);
  assert.equal(s.card.thicknessMm, SCENE_DEFAULTS["card.thickness"]);
  assert.equal(s.bump.strength, SCENE_DEFAULTS["bump.strength"]);
  assert.equal(s.object.modelSizeMm, SCENE_DEFAULTS["object.modelSize"]);
  assert.equal(s.dof.on, SCENE_DEFAULTS["dof.on"]);
  assert.equal(s.dof.fNumber, Number(SCENE_DEFAULTS["dof.fstop"]));
  assert.equal(s.dof.blades, Number(SCENE_DEFAULTS["dof.blades"]));
  assert.equal(s.dof.lensMm, SCENE_DEFAULTS["dof.lens"]);
});

test("sceneStateFrom: its built-in fallbacks are the parameter defaults, except that a missing bump.map means no map", () => {
  const bare = sceneStateFrom({}), fromDefaults = sceneStateFrom(resolveSettings({ look: "plain" }).scene);
  // as holo.spot's own appStateFrom (app/state.ts): the parameter's default is a scratch map, no value at all is no map
  assert.equal(bare.bump.map, "");
  assert.equal(fromDefaults.bump.map, SCENE_DEFAULTS["bump.map"]);
  assert.deepEqual({ ...bare, bump: { ...bare.bump, map: fromDefaults.bump.map } }, fromDefaults);
});

test("sceneStateFrom: a shipped look and the caller's settings reach the state", () => {
  const r = resolveSettings({ look: "object", material: "prism", settings: { "display.ev": 1.5, "scene.background": "black", "dof.fstop": "8" } });
  const s = sceneStateFrom(r.scene), shipped = looks.object.surfaces.prism.values;
  assert.equal(s.display.ev, 1.5);
  assert.equal(s.background, "black");
  assert.equal(s.dof.fNumber, 8);
  assert.equal(s.dof.on, shipped["dof.on"]);
  assert.equal(s.dof.focus, shipped["dof.focus"]);
  assert.deepEqual(s.dof.point, { ...shipped["dof.point"], z: shipped["dof.pointZ"] });
  assert.equal(s.studio.spotC.on, shipped["studio.spotC.on"]);
  assert.deepEqual(s.studio.spotC.dir, shipped["studio.spotC.dir"]);
  assert.equal(s.studio.ambient.rotationDeg, shipped["studio.ambient.rotation"]);
});

test("sceneStateFrom: a studio preset reaches the lights", () => {
  const s = sceneStateFrom(resolveSettings({ look: "plain", settings: { "studio.preset": "desk" } }).scene), desk = STUDIO_PRESETS.desk;
  assert.equal(s.studio.panel.spd, desk["studio.panel.spd"]);
  assert.equal(s.studio.panel.lengthDeg, desk["studio.panel.length"]);
  assert.deepEqual(s.studio.spotA.dir, desk["studio.spotA.dir"]);
  assert.equal(s.studio.spotA.sizeDeg, desk["studio.spotA.size"]);
  assert.equal(s.studio.spotA.spd, desk["studio.spotA.spd"]);
  assert.equal(s.studio.spotB.on, false);
  assert.equal(s.studio.ambient.fill, desk["studio.ambient.fill"]);
});

test("sceneStateFrom: out-of-range numbers are clamped", () => {
  const s = sceneStateFrom({
    "grain.amount": 5, "grain.size": 0, "dof.distance": 1, "dof.offset": 500, "dof.lens": 10, "dof.rim": -4, "dof.catsEye": 3,
    "object.modelSize": 1000, "object.structureScale": 0, "display.glare": -1, "display.glareRadius": 0, "card.embossPitch": 0,
    "card.embossHeight": -2, "card.wear": 7, "bump.strength": -1, "bump.tiling": 0, "studio.spotA.radiance": -10, "studio.spotA.distance": 0,
    "studio.flash.radiance": -1,
  });
  assert.equal(s.grain.amount, 0.6);
  assert.equal(s.grain.sizePx, 1);
  assert.equal(s.dof.distanceCm, 5);
  assert.equal(s.dof.offsetMm, 50);
  assert.equal(s.dof.lensMm, 24);
  assert.equal(s.dof.rim, -1);
  assert.equal(s.dof.catsEye, 1);
  assert.equal(s.object.modelSizeMm, 400);
  assert.equal(s.object.structureScale, 0.25);
  assert.equal(s.display.glare, 0);
  assert.equal(s.display.glareRadiusPx, 0.5);
  assert.equal(s.card.embossPitchMm, 0.01);
  assert.equal(s.card.embossHeightUm, 0);
  assert.equal(s.card.wear, 1);
  assert.equal(s.bump.strength, 0);
  assert.equal(s.bump.tiling, 0.01);
  assert.equal(s.studio.spotA.radiance, 0);
  assert.equal(s.studio.spotA.distanceM, 0.05);
  assert.equal(s.studio.flash.radiance, 0);
});

test("sceneStateFrom: values of the wrong type or outside a select's options fall back to the default", () => {
  const d = sceneStateFrom({});
  const s = sceneStateFrom({
    "display.ev": "bright", "display.tone": "filmic", "display.wideGamut": "yes", "scene.background": "purple", "scene.print": "poster",
    "studio.panel.dir": { x: "left", y: 0 }, "studio.panel.spd": "neon", "studio.spotA.on": 1, "grain.colour": "sepia", "dof.fstop": "3",
    "dof.focus": "auto", "dof.blades": "4", "dof.point": "centre", "card.emboss": "dots", "bump.layer": "paper", "bump.map": 7,
    "object.modelMapping": "planar", "object.doubleSided": "no", "grain.amount": NaN, "dof.distance": Infinity,
  });
  assert.deepEqual(s, d);
});

test("sceneStateFrom: the page colour is a #rrggbb hex, lower case; anything else is the default", () => {
  assert.equal(sceneStateFrom({ "scene.bgColor": "#ABC" }).bgColor, "#aabbcc");
  assert.equal(sceneStateFrom({ "scene.bgColor": " #12EF56 " }).bgColor, "#12ef56");
  for (const bad of ["red", "#12345", "#gggggg", "rgb(1,2,3)", 0x123456, null]) {
    assert.equal(sceneStateFrom({ "scene.bgColor": bad }).bgColor, SCENE_DEFAULTS["scene.bgColor"], String(bad));
  }
});

test("sceneStateFrom: select values that are numbers on the engine side (f-stop, blades) are converted", () => {
  const s = sceneStateFrom({ "dof.fstop": "0.95", "dof.blades": "0" });
  assert.equal(s.dof.fNumber, 0.95);
  assert.equal(s.dof.blades, 0);
});
