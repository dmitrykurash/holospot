// WP-G colour parsing tests (spec §7.1 "tests/color.test.ts"): CSS colour string → linear sRGB (ui/color.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCssColor, srgbToLinear } from "../../engine/ui/color.ts";

const TOL = 2e-3;

function rgbOf(s: string): readonly [number, number, number] {
  const c = parseCssColor(s);
  assert.ok(c, `${s} should parse`);
  return c.rgb;
}

function near(s: string, want: readonly number[], tol = TOL): void {
  const got = rgbOf(s);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(got[i] - want[i]) <= tol, `${s} channel ${i}: expected ${want[i]} ± ${tol}, got ${got[i]}`);
  }
}

test("§7.1 hex: #ffffff → (1, 1, 1); #808080 → 0.21586; #0b0b10 → (0.00335, 0.00335, 0.00518)", () => {
  near("#ffffff", [1, 1, 1], 1e-9);
  near("#808080", [0.21586, 0.21586, 0.21586], 5e-5);
  near("#0b0b10", [0.00335, 0.00335, 0.00518], 5e-5);
  near("#000", [0, 0, 0], 0);
  near("#FFF", [1, 1, 1], 1e-9);
});

test("§7.1 rgb(): modern and legacy syntax → (1, 0, 0)", () => {
  near("rgb(255 0 0)", [1, 0, 0], 1e-9);
  near("rgb(255, 0, 0)", [1, 0, 0], 1e-9);
  near("rgba(255, 0, 0, 0.5)", [1, 0, 0], 1e-9);
  near("rgb(100% 0% 0%)", [1, 0, 0], 1e-9);
  near("RGB( 255 , 0 , 0 )", [1, 0, 0], 1e-9);
  assert.equal(parseCssColor("rgb(255 0 0 / 50%)")?.alpha, 0.5);
  assert.equal(parseCssColor("rgba(255, 0, 0, 0.25)")?.alpha, 0.25);
  // channels are clamped to the sRGB gamut, as CSS does for rgb()
  near("rgb(300 -20 0)", [1, 0, 0], 1e-9);
});

test("§7.1 hsl(120 100% 50%) → (0, 1, 0); legacy hsl and hue units", () => {
  near("hsl(120 100% 50%)", [0, 1, 0], 1e-9);
  near("hsl(120, 100%, 50%)", [0, 1, 0], 1e-9);
  near("hsla(120deg, 100%, 50%, 0.3)", [0, 1, 0], 1e-9);
  near("hsl(0.5turn 100% 50%)", [0, 1, 1], 1e-9);
  near("hsl(0 0% 50%)", [srgbToLinear(0.5), srgbToLinear(0.5), srgbToLinear(0.5)], 1e-9);
  assert.equal(parseCssColor("hsl(120, 100, 50)"), null, "legacy hsl requires percentages");
});

test("§7.1 color(display-p3 1 0 0) → (1.2249, −0.0421, −0.0196)", () => {
  near("color(display-p3 1 0 0)", [1.2249, -0.0421, -0.0196]);
  near("color(display-p3 1 1 1)", [1, 1, 1], 1e-6);
  // DialKit's own P3 output format (formatColor) parses too
  const c = parseCssColor("color(display-p3 1 0.35 0.15 / 0.5)");
  assert.ok(c && c.alpha === 0.5);
  near("color(srgb 1 0 0)", [1, 0, 0], 1e-9);
  near("color(srgb-linear 0.5 0.25 0)", [0.5, 0.25, 0], 1e-12);
});

test("§7.1 oklch(0.7 0.2 145) → (0.0294, 0.5075, 0.0575)", () => {
  near("oklch(0.7 0.2 145)", [0.0294, 0.5075, 0.0575]);
  near("oklch(70% 50% 145deg)", [0.0294, 0.5075, 0.0575]);
  near("oklch(1 0 0)", [1, 1, 1], 1e-4);
  near("oklab(1 0 0)", [1, 1, 1], 1e-4);
  const c = parseCssColor("oklch(0.7 0.2 145 / 0.8)");
  assert.ok(c && Math.abs(c.alpha - 0.8) < 1e-12);
});

test("§7.1 #ff000080 → alpha 0.502; short hex alpha", () => {
  const c = parseCssColor("#ff000080");
  assert.ok(c);
  assert.ok(Math.abs(c.alpha - 0.502) < 1e-3, `alpha ${c.alpha}`);
  near("#ff000080", [1, 0, 0], 1e-9);
  assert.ok(Math.abs((parseCssColor("#f008")?.alpha ?? 0) - 0x88 / 255) < 1e-12);
  assert.equal(parseCssColor("#ece9e2")?.alpha, 1);
});

test("§7.1 garbage → null", () => {
  for (const s of ["", "   ", "garbage", "#12", "#12345", "#ggg", "rgb(1 2)", "rgb(1, 2 3)", "rgb(1 2 3 4)", "hsl(x 1% 2%)",
    "oklch(0.7 0.2)", "color(rec2020 1 0 0)", "color(display-p3 1 0)", "rgb(1 2 3 / )", "rgb(1, 2, 3 / 0.5)",
    "url(#a)", "12", "#ff0000 extra", "rgb(255 0 0))", "blue"]) {
    assert.equal(parseCssColor(s), null, `"${s}" should not parse`);
  }
});

test("the scene panel's colour defaults parse to the §5.7/§5.1 linear inks", () => {
  // #ece9e2 → (0.8388, 0.8148, 0.7605), #22304a → (0.0160, 0.0296, 0.0685)
  near("#ece9e2", [srgbToLinear(0xec / 255), srgbToLinear(0xe9 / 255), srgbToLinear(0xe2 / 255)], 1e-12);
  near("#22304a", [0.016, 0.0296, 0.0685], 5e-4);
});
