// DialKit config ↔ ParamSpec plumbing (spec §5.8 "Subscriptions", §6.4 WP-G, §7.1 checkConsistency).
// Pure module (§6.1): type-only imports, no three, no DOM, erasable syntax only.
//
// DialKit resolves a panel to a nested snapshot keyed by the config's keys (folders → nested objects, `_collapsed`
// omitted, actions absent). The app works with flat ParamValues keyed by ParamSpec.id; `flattenValues` and
// `nestValues` convert between the two by each ParamSpec's dot path (no DialKit key contains a dot).
import type { DialConfig } from "dialkit/vanilla";
import type { ParamKind, ParamSpec, ParamValue, SpringValue, EasingValue, Vec2 } from "../types.ts";

// ---------------------------------------------------------------------------------------------------------------
// DialKit facts (2.1.0, checked in node_modules/dialkit/dist/vanilla/index.js)
// ---------------------------------------------------------------------------------------------------------------

/** DialKit's label for a config key: camelCase split into words, first letter upper-cased (`formatLabel`). */
export function formatLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim();
}

/** DialKit's step for a slider tuple without one (`inferStep`). */
export function inferStep(min: number, max: number): number {
  const r = max - min;
  return r <= 1 ? 0.01 : r <= 10 ? 0.1 : r <= 100 ? 1 : 10;
}

type Node = unknown;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** `v` is an object whose `type` is `type` (a plain boolean, not a type predicate: a false result must not narrow). */
function typed(v: unknown, type: string): boolean {
  return isObj(v) && v.type === type;
}
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla|oklch|color)\(/i;

/** The kind of a DialKit config node: a ParamKind, "action", "folder", "text" or "unknown". */
export function controlKind(node: Node): ParamKind | "action" | "folder" | "text" | "unknown" {
  if (Array.isArray(node)) return node.length <= 4 && typeof node[0] === "number" ? "slider" : "unknown";
  if (typeof node === "number") return "slider";
  if (typeof node === "boolean") return "toggle";
  if (typeof node === "string") return HEX.test(node.trim()) || COLOR_FN.test(node.trim()) ? "color" : "text";
  if (!isObj(node)) return "unknown";
  if (typed(node, "spring") || typed(node, "easing")) return "spring";
  if (typed(node, "action")) return "action";
  if (typed(node, "select")) return Array.isArray(node.options) ? "select" : "unknown";
  if (typed(node, "color")) return "color";
  if (typed(node, "image")) return "image";
  if (typed(node, "pad")) return "pad";
  if (typed(node, "text")) return "text";
  if (typeof node.type === "string") return "unknown";
  return "folder";
}

/** Every control of a config (folders walked, `_collapsed` skipped), with its dot path and DialKit key. */
export function listControls(dial: DialConfig): { path: string; key: string; node: Node; kind: ReturnType<typeof controlKind> }[] {
  const out: { path: string; key: string; node: Node; kind: ReturnType<typeof controlKind> }[] = [];
  const walk = (cfg: Record<string, unknown>, prefix: string) => {
    for (const [key, node] of Object.entries(cfg)) {
      if (key === "_collapsed") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const kind = controlKind(node);
      out.push({ path, key, node, kind });
      if (kind === "folder") walk(node as Record<string, unknown>, path);
    }
  };
  walk(dial as Record<string, unknown>, "");
  return out;
}

/** The config node at a dot path, or undefined. */
export function nodeAt(dial: DialConfig, path: string): Node {
  let cur: unknown = dial;
  for (const k of path.split(".")) {
    if (!isObj(cur) || k === "_collapsed" || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** The value at a dot path of a nested object, or undefined. */
export function valueAt(values: unknown, path: string): unknown {
  let cur: unknown = values;
  for (const k of path.split(".")) {
    if (!isObj(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

function isVec2(v: unknown): v is Vec2 {
  return isObj(v) && typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y);
}
function isTransition(v: unknown): v is SpringValue | EasingValue {
  return isObj(v) && (v.type === "spring" || (v.type === "easing" && Array.isArray(v.ease)));
}
function clone(v: ParamValue): ParamValue {
  if (typeof v !== "object" || v === null) return v;
  if ("ease" in v && Array.isArray(v.ease)) return { ...v, ease: [...v.ease] as [number, number, number, number] };
  return { ...v } as ParamValue;
}

/** A value of the right shape for a ParamSpec's kind, or undefined. */
export function sanitizeValue(spec: ParamSpec, v: unknown): ParamValue | undefined {
  switch (spec.kind) {
    case "slider": return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "toggle": return typeof v === "boolean" ? v : undefined;
    case "select": return typeof v === "string" && (!spec.options || spec.options.includes(v)) ? v : undefined;
    case "color": return typeof v === "string" ? v : undefined;
    case "pad": return isVec2(v) ? { x: v.x, y: v.y } : undefined;
    case "spring": return isTransition(v) ? clone(v as ParamValue) : undefined;
    case "image": return typeof v === "string" ? v : undefined;     // a path, a data URL (upload) or "" (none)
    case "text": return typeof v === "string" ? v : undefined;      // A11: free text (the paper card's document)
    default: return undefined;
  }
}

/**
 * Flattens a nested DialKit snapshot into `{ [ParamSpec.id]: value }` (spec §5.8). A missing or malformed value
 * falls back to the ParamSpec default, so consumers always receive every id with the right shape.
 */
export function flattenValues(dial: DialConfig, values: unknown, params: readonly ParamSpec[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of params) {
    const v = nodeAt(dial, p.path) === undefined ? undefined : sanitizeValue(p, valueAt(values, p.path));
    out[p.id] = v !== undefined ? v : clone(p.default);
  }
  return out;
}

/** Nests flat values (keyed by ParamSpec.id) by their DialKit paths, for `kit.setValues` (unknown ids are skipped). */
export function nestValues(params: readonly ParamSpec[], flat: Readonly<Record<string, ParamValue>>): Record<string, unknown> {
  const byId = new Map(params.map((p) => [p.id, p]));
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(flat)) {
    const p = byId.get(id);
    if (!p || value === undefined) continue;
    const keys = p.path.split(".");
    let cur = out;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!isObj(cur[k])) cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[keys[keys.length - 1]] = clone(value);
  }
  return out;
}

/** Deep equality of two ParamValues (numbers exactly, pads by axis, transitions by every field). */
export function sameValue(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = (a as unknown as Record<string, unknown>)[k], y = (b as unknown as Record<string, unknown>)[k];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((e, i) => e !== y[i])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** Ids whose value differs between two flat snapshots. */
export function changedIds(prev: Readonly<Record<string, ParamValue>> | null, next: Readonly<Record<string, ParamValue>>): string[] {
  if (!prev) return Object.keys(next);
  return Object.keys(next).filter((k) => !sameValue(prev[k], next[k]));
}

// ---------------------------------------------------------------------------------------------------------------
// Consistency of a dial literal and its ParamSpec table (§7.1)
// ---------------------------------------------------------------------------------------------------------------

const EPS = 1e-9;
const onGrid = (v: number, min: number, step: number) => {
  const k = (v - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
};

function sliderRange(node: Node): { def: number; min: number; max: number; step: number } | null {
  if (Array.isArray(node)) {
    const [def, min, max, step] = node as number[];
    return { def, min, max, step: step ?? inferStep(min, max) };
  }
  if (typeof node === "number") {           // DialKit's inferRange for bare numbers
    const v = node;
    if (v >= 0 && v <= 1) return { def: v, min: 0, max: 1, step: 0.01 };
    if (v >= 0 && v <= 10) return { def: v, min: 0, max: v * 3 || 10, step: 0.1 };
    if (v >= 0 && v <= 100) return { def: v, min: 0, max: v * 3 || 100, step: 1 };
    if (v >= 0) return { def: v, min: 0, max: v * 3 || 1000, step: 10 };
    return { def: v, min: v * 3, max: -v * 3, step: 1 };
  }
  return null;
}

function padAxis(a: unknown): { def: number; min: number; max: number; step: number } {
  const [def, min, max, step] = (Array.isArray(a) ? a : [0, -1, 1, 0.01]) as number[];
  return { def, min, max, step: step ?? (max - min) / 200 };
}

function optionValues(node: Record<string, unknown>): string[] {
  return (node.options as unknown[]).map((o) => (typeof o === "string" ? o : String((o as { value: unknown }).value)));
}

const same = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Checks a dial literal against its ParamSpec table (spec §7.1): every ParamSpec.path exists in the literal with the
 * same kind, default, min, max, step and options; every non-action control has a ParamSpec; ids (and paths) are
 * unique; every default lies within its range and on its step grid; no formatted label contains "( ". Returns one
 * message per problem (empty = consistent).
 */
export function checkConsistency(dial: DialConfig, params: readonly ParamSpec[]): string[] {
  const msgs: string[] = [];
  const controls = listControls(dial);
  const byPath = new Map(controls.map((c) => [c.path, c]));

  for (const c of controls) {
    const label = c.kind === "action" ? String((c.node as Record<string, unknown>).label ?? formatLabel(c.key)) : formatLabel(c.key);
    if (label.includes("( ")) msgs.push(`${c.path}: formatted label "${label}" contains "( "`);
    if (c.kind === "unknown") msgs.push(`${c.path}: unsupported control (${c.kind})`);
  }

  const ids = new Set<string>(), paths = new Set<string>();
  for (const p of params) {
    if (ids.has(p.id)) msgs.push(`${p.id}: duplicate ParamSpec id`);
    ids.add(p.id);
    if (paths.has(p.path)) msgs.push(`${p.id}: duplicate DialKit path "${p.path}"`);
    paths.add(p.path);

    const c = byPath.get(p.path);
    if (!c) { msgs.push(`${p.id}: path "${p.path}" is not in the literal`); continue; }
    if (c.kind === "action" || c.kind === "folder") { msgs.push(`${p.id}: path "${p.path}" is a ${c.kind}, not a control`); continue; }
    if (c.kind !== p.kind) { msgs.push(`${p.id}: kind ${p.kind} but the literal is a ${c.kind}`); continue; }
    const node = c.node;

    switch (p.kind) {
      case "slider": {
        const r = sliderRange(node);
        if (!r) { msgs.push(`${p.id}: unreadable slider`); break; }
        if (typeof p.default !== "number" || !same(p.default, r.def)) msgs.push(`${p.id}: default ${String(p.default)} ≠ literal ${r.def}`);
        if (!same(p.min, r.min)) msgs.push(`${p.id}: min ${p.min} ≠ literal ${r.min}`);
        if (!same(p.max, r.max)) msgs.push(`${p.id}: max ${p.max} ≠ literal ${r.max}`);
        if (!same(p.step, r.step)) msgs.push(`${p.id}: step ${p.step} ≠ literal ${r.step}`);
        if (!(r.step > 0) || !(r.max > r.min)) msgs.push(`${p.id}: degenerate range [${r.min}, ${r.max}] step ${r.step}`);
        if (r.def < r.min - EPS || r.def > r.max + EPS) msgs.push(`${p.id}: default ${r.def} outside [${r.min}, ${r.max}]`);
        else if (r.step > 0 && !onGrid(r.def, r.min, r.step)) msgs.push(`${p.id}: default ${r.def} is not on the step grid ${r.min} + k·${r.step}`);
        break;
      }
      case "pad": {
        const n = node as Record<string, unknown>;
        const ax = padAxis(n.x), ay = padAxis(n.y);
        const d = p.default as Vec2;
        if (!isVec2(d) || !same(d.x, ax.def) || !same(d.y, ay.def)) msgs.push(`${p.id}: default ${JSON.stringify(d)} ≠ literal (${ax.def}, ${ay.def})`);
        for (const [name, a] of [["x", ax], ["y", ay]] as const) {
          if (!same(p.min, a.min)) msgs.push(`${p.id}: min ${p.min} ≠ literal ${name} min ${a.min}`);
          if (!same(p.max, a.max)) msgs.push(`${p.id}: max ${p.max} ≠ literal ${name} max ${a.max}`);
          if (!same(p.step, a.step)) msgs.push(`${p.id}: step ${p.step} ≠ literal ${name} step ${a.step}`);
          if (a.def < a.min - EPS || a.def > a.max + EPS) msgs.push(`${p.id}: ${name} default ${a.def} outside [${a.min}, ${a.max}]`);
          else if (a.step > 0 && !onGrid(a.def, a.min, a.step)) msgs.push(`${p.id}: ${name} default ${a.def} is not on the step grid`);
        }
        break;
      }
      case "select": {
        const n = node as Record<string, unknown>;
        const opts = optionValues(n);
        const def = typeof n.default === "string" ? n.default : (opts[0] ?? "");
        if (p.default !== def) msgs.push(`${p.id}: default ${String(p.default)} ≠ literal ${def}`);
        const po = p.options ? [...p.options] : [];
        if (po.length !== opts.length || po.some((o, i) => o !== opts[i])) msgs.push(`${p.id}: options [${po.join(", ")}] ≠ literal [${opts.join(", ")}]`);
        if (!opts.includes(def)) msgs.push(`${p.id}: default ${def} is not an option`);
        break;
      }
      case "toggle":
        if (p.default !== node) msgs.push(`${p.id}: default ${String(p.default)} ≠ literal ${String(node)}`);
        break;
      case "color": {
        const def = typeof node === "string" ? node : (node as Record<string, unknown>).default;
        if (p.default !== def) msgs.push(`${p.id}: default ${String(p.default)} ≠ literal ${String(def)}`);
        break;
      }
      case "image": {
        // DialKit: default = config default ?? first option ?? "" (upload-only); options are URLs or { value, label }
        const n = node as Record<string, unknown>;
        const opts = Array.isArray(n.options) ? optionValues(n) : [];
        const def = typeof n.default === "string" ? n.default : (opts[0] ?? "");
        if (p.default !== def) msgs.push(`${p.id}: default ${String(p.default)} ≠ literal ${def}`);
        const po = p.options ? [...p.options] : [];
        if (po.length !== opts.length || po.some((o, i) => o !== opts[i])) msgs.push(`${p.id}: options [${po.join(", ")}] ≠ literal [${opts.join(", ")}]`);
        if (n.options !== undefined && !Array.isArray(n.options)) msgs.push(`${p.id}: image options must be an array`);
        break;
      }
      case "text": {
        const def = typeof node === "string" ? node : ((node as Record<string, unknown>).default ?? "");
        if (p.default !== def) msgs.push(`${p.id}: default ${String(p.default)} ≠ literal ${String(def)}`);
        break;
      }
      case "spring":
        if (!sameValue(p.default, node as ParamValue)) msgs.push(`${p.id}: default ${JSON.stringify(p.default)} ≠ literal ${JSON.stringify(node)}`);
        break;
    }
  }

  for (const c of controls) {
    if (c.kind === "folder" || c.kind === "action") continue;
    if (!params.some((p) => p.path === c.path)) msgs.push(`${c.path}: control has no ParamSpec`);
  }
  return msgs;
}
