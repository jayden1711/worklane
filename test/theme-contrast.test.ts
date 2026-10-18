// Light mode's text is readable on every light background it can sit on (#685): the warm light palette in
// web/src/styles.css, read from the file itself (var() resolved, hex, rgb() and oklch() converted here, no
// dependency), checked against WCAG 2's contrast ratio. The pairs come from the code: every text-* colour class used
// under web/src is a text token, so a new one can't be missed. A text token used anywhere on its own (no fill of its
// own beside it) can sit on any light background, so it must reach 4.5:1 on all of them; a text token beside a tint
// is checked on that tint laid over every light background, hover ones included (the active sidebar row is hover-2,
// and a tool row hovers to it); one only ever used on a fill (text-surface on bg-ink,
// text-white on bg-green) is checked on that fill. No text is drawn in the accent, and placeholder text passes too.
// A control's edge reaches 3:1 (WCAG 1.4.11) on the resting backgrounds, and no field or button draws its own edge
// with the divider colour; dividers don't need 3:1. The focus ring reaches 3:1 on every light background, and no
// focus or selection style draws the accent instead of the ring.
// Every colour class names a theme colour (a typo'd one draws nothing). Dark mode's block is pinned byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const webSrc = join(repoRoot, 'web', 'src');
const css = readFileSync(join(webSrc, 'styles.css'), 'utf8');

/** Every background a text token can sit on in light mode (the issue's list). */
const BACKGROUNDS = ['page', 'surface', 'canvas', 'inset', 'field', 'hover', 'hover-2'];
/** The backgrounds an element rests on (not a hover state): a tint or a control's edge is checked on these. */
const RESTING = ['page', 'surface', 'canvas', 'inset', 'field'];
/** The palette's own colours (the owner's, 2026-10-18), as the light tokens must carry them. */
const PALETTE: Record<string, string> = { page: '#faf9f5', surface: '#e8e6dc', ink: '#141413', line: '#b0aea5', blue: '#d97757' };
/** Shadow tokens whose first ring draws a control's edge: buttons (shadow-btn), fields and pill toggles (shadow-hairline). */
const CONTROL_EDGES = ['shadow-btn', 'shadow-hairline'];
/** A see-through fill over a solid one, where the solid one is set on a parent: bg-surface/20 is only the number chip
 *  on the recommended option, which is the ink primary button (web/src/pages/Decisions.tsx). */
const OVER: Record<string, string> = { 'surface/20': 'ink' };
/** The `.dark` block as on main before #685, which must not change. */
const DARK_SHA256 = '293abeb0d10447234d827924f881cb00f0f2b81c4d001c796323c19df2a160b5';

type Rgba = { r: number; g: number; b: number; a: number };

// ---- CSS: blocks, declarations, var() -------------------------------------------------------------------------------

const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** The innermost block whose selector is exactly `selector` (whitespace ignored): its text from the selector on. */
function blockText(selector: string): string | undefined {
  const want = selector.replace(/\s+/g, '');
  for (const m of css.matchAll(/([^{}]*)\{[^{}]*\}/g)) {
    // The selector starts after the previous declaration or comment (a `;` inside a comment is not a declaration's end).
    const before = m[1] ?? '';
    const commentEnd = before.lastIndexOf('*/');
    const head = before.slice(Math.max(before.lastIndexOf(';') + 1, commentEnd < 0 ? 0 : commentEnd + 2));
    if (noComments(head).replace(/\s+/g, '') !== want) continue;
    const lead = /^(?:\s|\/\*[\s\S]*?\*\/)*/.exec(head)?.[0].length ?? 0;
    return m[0].slice(m[0].length - (head.length - lead) - (m[0].length - (m[1] ?? '').length));
  }
  return undefined;
}

/** The declarations of that block. */
function block(selector: string): Map<string, string> | undefined {
  const text = blockText(selector);
  if (text === undefined) return undefined;
  const decls = new Map<string, string>();
  for (const d of noComments(text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'))).split(';')) {
    const i = d.indexOf(':');
    if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return decls;
}

/** Light mode's custom properties: `:root`, the names shared with dark, and anything set for light only. */
function lightTokens(): Map<string, string> {
  const root = block(':root');
  assert.ok(root, 'styles.css has a :root block');
  return new Map([...root, ...(block(':root, .dark') ?? []), ...(block(':root:not(.dark)') ?? [])]);
}

function resolve(value: string, tokens: Map<string, string>, depth = 0): string {
  assert.ok(depth < 20, `var() loop at ${value}`);
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name: string, fallback?: string) => {
    const v = tokens.get(name) ?? fallback;
    assert.ok(v !== undefined, `${name} is not set in light mode`);
    return resolve(v, tokens, depth + 1);
  });
}

// ---- Colour: hex, rgb(), oklch() to sRGB --------------------------------------------------------------------------

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const toGamma = (c: number) => clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const num = (s: string, scale: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s));

/** oklch (L 0..1, C, H degrees) to gamma sRGB 0..1, through OKLab (Björn Ottosson's published matrices). */
function oklch(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function parseColour(raw: string): Rgba {
  const v = raw.trim().toLowerCase();
  if (v === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    const h = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const [r = 0, g = 0, b = 0, a = 255] = (h.match(/../g) ?? []).map((x) => parseInt(x, 16));
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  }
  const m = /^(rgb|oklch)a?\(\s*([^\s,]+)[\s,]+([^\s,]+)[\s,]+([^\s,/)]+)\s*(?:[/,]\s*([^\s)]+))?\s*\)$/.exec(v);
  assert.ok(m, `not a colour this test reads: ${raw}`);
  const [, fn, x = '', y = '', z = '', alpha] = m;
  const a = alpha === undefined ? 1 : num(alpha, 1);
  if (fn === 'rgb') return { r: num(x, 255) / 255, g: num(y, 255) / 255, b: num(z, 255) / 255, a };
  const [r, g, b] = oklch(num(x, 1), num(y, 0.4), parseFloat(z));
  return { r, g, b, a };
}

/** `top` laid over the opaque `under`, as the browser composites (in gamma sRGB). */
const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
const luminance = (c: Rgba) => 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
function contrast(x: Rgba, y: Rgba): number {
  const [a, b] = [luminance(x), luminance(y)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const hexOf = (c: Rgba) => '#' + [c.r, c.g, c.b].map((x) => Math.round(clamp(x) * 255).toString(16).padStart(2, '0')).join('');

// ---- The code: which text and fill classes sit together -------------------------------------------------------------

/** Tailwind's own colours the pages use besides the theme's tokens. */
const BUILT_IN: Record<string, string> = { white: '#fff', black: '#000' };
const THEME = new Set([...(block('@theme inline') ?? new Map()).keys()].filter((k) => k.startsWith('--color-')).map((k) => k.slice('--color-'.length)));
const TAILWIND_PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/;

/** A class split into its variants (`dark:focus:`) and its utility, with `:` inside `[...]` or `(...)` not a split. */
function splitClass(tok: string): [string, string] {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < tok.length; i++) {
    const c = tok[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) cut = i;
  }
  return [tok.slice(0, cut + 1), tok.slice(cut + 1).replace(/^!/, '')];
}

type Use = { kind: 'text' | 'bg'; variant: string; name: string; alpha: number | undefined };
/** A text class where it's used: the classes in its own string, and the fills on the same line in strings that set no
 *  text colour of their own (`cx('... text-white', done ? 'bg-green' : 'bg-red')`). */
type Occurrence = { file: string; line: number; text: Use; literal: Use[]; lineFills: Use[] };

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
}

const CLASS = /(?<![\w-])((?:[a-z-]+:)*)(text|bg)-([a-z][a-z0-9-]*)(?:\/(\d+))?(?![\w-])/g;
const offPalette: string[] = [];
function uses(s: string, where: string): Use[] {
  const out: Use[] = [];
  for (const m of s.matchAll(CLASS)) {
    const [all, variant = '', kind, name = '', alpha] = m;
    if (TAILWIND_PALETTE.test(name)) offPalette.push(`${where}: ${all}`);
    if (!THEME.has(name) && !(name in BUILT_IN)) continue;
    out.push({ kind: kind as 'text' | 'bg', variant, name, alpha: alpha === undefined ? undefined : Number(alpha) / 100 });
  }
  return out;
}

function occurrences(): Occurrence[] {
  const out: Occurrence[] = [];
  for (const file of files(webSrc)) {
    const rel = file.slice(repoRoot.length);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const where = `${rel}:${i + 1}`;
      const literals = [...line.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((m) => uses(m[2] ?? '', where));
      const lineFills = literals.filter((l) => !l.some((u) => u.kind === 'text')).flat();
      for (const literal of literals) for (const u of literal) if (u.kind === 'text') out.push({ file: rel, line: i + 1, text: u, literal, lineFills });
    });
  }
  return out;
}

// ---- The pairs ------------------------------------------------------------------------------------------------------

type Pair = { text: string; on: string; ratio: number; need: number; where?: string };

function pairs(): { pairs: Pair[]; textTokens: Set<string>; accentText: string[] } {
  const tokens = lightTokens();
  const colour = (name: string): Rgba => parseColour(BUILT_IN[name] ?? resolve(`var(--${name})`, tokens));
  const occ = occurrences();
  const textTokens = new Set(occ.map((o) => o.text.name));
  // The accent is never a text colour, whatever it sits on (text-blue, or any name for the same colour).
  const accent = hexOf(colour('blue'));
  const accentText = occ.filter((o) => hexOf(colour(o.text.name)) === accent).map((o) => `${o.file}:${o.line}: ${o.text.variant}text-${o.text.name}`);
  const isBase = (u: Use) => BACKGROUNDS.includes(u.name) && u.alpha === undefined;
  const bgs = (o: Occurrence, list: Use[]) => list.filter((u) => u.kind === 'bg' && u.variant === o.text.variant);
  /** The fills (anything but a plain background) this text sits on: in its own string, else beside it on the line. */
  const fillsBeside = (o: Occurrence) => (bgs(o, o.literal).length ? bgs(o, o.literal) : bgs(o, o.lineFills)).filter((u) => !isBase(u));
  const out: Pair[] = [];
  const seen = new Set<string>();
  const add = (p: Pair) => {
    const key = `${p.text}|${p.on}`;
    if (!seen.has(key)) (seen.add(key), out.push(p));
  };
  for (const name of textTokens) {
    const mine = occ.filter((o) => o.text.name === name);
    // On its own somewhere: it can sit on any light background.
    if (mine.some((o) => bgs(o, o.literal).length === 0 && bgs(o, o.lineFills).length === 0))
      for (const bg of BACKGROUNDS) add({ text: name, on: bg, ratio: contrast(colour(name), colour(bg)), need: 4.5 });
    for (const o of mine) {
      const where = `${o.file}:${o.line}`;
      for (const f of bgs(o, o.literal).filter(isBase))
        add({ text: name, on: f.name, ratio: contrast(colour(name), colour(f.name)), need: 4.5, where });
      for (const f of fillsBeside(o)) {
        const fill = colour(f.name);
        if (f.alpha !== undefined) fill.a = f.alpha;
        const label = f.alpha === undefined ? f.name : `${f.name}/${Math.round(f.alpha * 100)}`;
        if (fill.a >= 1) add({ text: name, on: label, ratio: contrast(colour(name), fill), need: 4.5, where });
        else for (const under of OVER[label] ? [OVER[label]] : BACKGROUNDS) add({ text: name, on: `${label} over ${under}`, ratio: contrast(colour(name), over(fill, colour(under))), need: 4.5, where });
      }
    }
  }
  // Text on an accent fill: no component puts text on bg-blue today; whatever does must be dark (primary text).
  add({ text: 'ink', on: 'blue', ratio: contrast(colour('ink'), colour('blue')), need: 4.5 });
  return { pairs: out, textTokens, accentText };
}

const fmt = (p: Pair) => `text-${p.text} on ${p.on}: ${p.ratio.toFixed(2)}:1, needs ${p.need}:1${p.where ? ` (${p.where})` : ''}`;

// ---- Tests ----------------------------------------------------------------------------------------------------------

test('the light tokens carry the warm light palette', () => {
  const tokens = lightTokens();
  for (const [name, want] of Object.entries(PALETTE)) assert.equal(hexOf(parseColour(resolve(`var(--${name})`, tokens))), want, `--${name}`);
});

test('every text colour used in web/src meets AA on every light background it can sit on', (t) => {
  const { pairs: all, textTokens, accentText } = pairs();
  assert.deepEqual(offPalette, [], 'a Tailwind palette colour is used instead of a theme token');
  for (const core of ['ink', 'ink-2', 'ink-3', 'blue-ink', 'red', 'green', 'orange', 'primary-foreground'])
    assert.ok(textTokens.has(core), `text-${core} is still found in web/src (else the scan is broken)`);
  assert.deepEqual(accentText, [], 'text drawn in the accent (2.96:1 on the page): use text-blue-ink');
  const lowest = new Map<string, Pair>();
  for (const p of all) if (!lowest.has(p.text) || p.ratio < lowest.get(p.text)!.ratio) lowest.set(p.text, p);
  for (const p of lowest.values()) t.diagnostic(`lowest: ${fmt(p)}`);
  const bad = all.filter((p) => p.ratio < p.need);
  assert.deepEqual(bad.map(fmt), [], `${bad.length} of ${all.length} text/background pairs are under AA`);
});

test("a control's edge is 3:1 on every resting light background", () => {
  const tokens = lightTokens();
  const failing: string[] = [];
  for (const shadow of CONTROL_EDGES) {
    const edge = /^0 0 0 1px (#[0-9a-f]+|\w+\([^)]*\)|\w+)/i.exec(resolve(`var(--${shadow})`, tokens))?.[1];
    assert.ok(edge, `--${shadow} starts with a 1px ring`);
    for (const bg of RESTING) {
      const r = contrast(parseColour(edge), parseColour(resolve(`var(--${bg})`, tokens)));
      if (r < 3) failing.push(`--${shadow} (${edge}) on ${bg}: ${r.toFixed(2)}:1, needs 3:1`);
    }
  }
  assert.deepEqual(failing, [], 'a control edge is under WCAG 1.4.11');
});

test('the focus ring is 3:1 on every light background', () => {
  // Focus can land on a hovered or active row, so hover backgrounds count too.
  const tokens = lightTokens();
  const ring = parseColour(resolve('var(--ring)', tokens));
  const failing = BACKGROUNDS.map((bg) => ({ bg, r: contrast(ring, parseColour(resolve(`var(--${bg})`, tokens))) }))
    .filter(({ r }) => r < 3)
    .map(({ bg, r }) => `--ring (${hexOf(ring)}) on ${bg}: ${r.toFixed(2)}:1, needs 3:1`);
  assert.deepEqual(failing, [], 'the focus ring is under WCAG 1.4.11');
});

test('placeholder text is AA on every light background a field can have', () => {
  // Tailwind's preflight draws a placeholder in the field's own text colour at 50% (color-mix with transparent), under
  // AA for an ink or ink-2 field. Light mode sets its own placeholder colour in a light-only base rule instead.
  const tokens = lightTokens();
  const own = block(':root:not(.dark) ::placeholder')?.get('color');
  const colours: [string, Rgba][] = own
    ? [[own, parseColour(resolve(own, tokens))]]
    : ['ink', 'ink-2'].map((n) => [`text-${n} at 50% (Tailwind's default)`, { ...parseColour(resolve(`var(--${n})`, tokens)), a: 0.5 }]);
  const failing: string[] = [];
  for (const bg of BACKGROUNDS) {
    const under = parseColour(resolve(`var(--${bg})`, tokens));
    for (const [label, c] of colours) {
      const r = contrast(over(c, under), under);
      if (r < 4.5) failing.push(`placeholder ${label} on ${bg}: ${r.toFixed(2)}:1, needs 4.5:1`);
    }
  }
  assert.deepEqual(failing, [], 'placeholder text is under AA');
});

/** Focus and selection rings that still draw the accent, in files other open PRs hold; each goes once that PR lands. */
const RING_OWED: Record<string, string> = {
  'web/src/components/FirstTask.tsx:8': 'focus:shadow-[0_0_0_1px_var(--blue)]: after #664 / #633 merge',
  'web/src/pages/Board.tsx:268': 'focus:shadow-[0_0_0_1px_var(--blue)]: after #664 / #633 merge',
  'web/src/pages/Decisions.tsx:304': 'ring-blue (the selected decision): switched in #664',
};

test('focus and selection rings use the ring token, not the accent', () => {
  // The accent is 2.96:1 on the page and 2.50:1 on a card; --ring is the light-mode ring that reaches 3:1. In dark mode
  // --ring is the accent, so a switch to it changes nothing there.
  const accent = /(?:^|-)blue(?:\/\d+)?$|var\(--blue\)/;
  const found = new Map<string, string>();
  for (const file of files(webSrc)) {
    const rel = file.slice(repoRoot.length);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const tok of line.match(/[^\s"'`]+/g) ?? []) {
        const [, variants = '', utility = ''] = /^((?:[\w-]+:)*)(.*)$/.exec(tok) ?? [];
        const focus = /focus/.test(variants);
        const ring = /^ring-blue(?:\/\d+)?$/.test(utility);
        if ((focus && accent.test(utility)) || ring) found.set(`${rel}:${i + 1}`, tok);
      }
    });
  }
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g))
    if (/focus/.test(m[1] ?? '') && /var\(--blue\)/.test(m[2] ?? '')) found.set(`web/src/styles.css: ${(m[1] ?? '').trim()}`, 'var(--blue)');
  for (const [where, why] of Object.entries(RING_OWED)) {
    assert.ok(found.has(where), `${where} no longer draws the accent: drop it from RING_OWED (${why})`);
    found.delete(where);
  }
  assert.deepEqual([...found].map(([where, tok]) => `${where}: ${tok}`), [], 'a focus or selection ring draws the accent: use var(--ring) / ring-ring');
});

/** Each native control's opening tag in web/src (`<input`, `<select`, `<textarea`, `<button` up to its `>`), with the
 *  file and the line each of its lines is on. */
function controlTags(): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const file of files(webSrc)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<(input|select|textarea|button)(?![\w-])/g)) {
      let i = m.index + m[0].length;
      let depth = 0;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (depth === 0 && (c === '"' || c === "'")) i = src.indexOf(c, i + 1);
        else if (depth === 0 && c === '>') break;
      }
      const first = src.slice(0, m.index).split('\n').length;
      src.slice(m.index, i + 1).split('\n').forEach((text, k) => out.push({ file: file.slice(repoRoot.length), line: first + k, text }));
    }
  }
  return out;
}

test("a field's or button's own edge class is the control edge, not the divider", () => {
  // `border-line` is a divider (2.11:1 on the page, 1.78:1 on a card); a control's edge is `border-line-strong`.
  // Dark mode keeps its own edge (`dark:border-line`), so a dark: variant is not light mode's edge.
  // Any other `border-line…` (a typo such as `dark:border-linebg-surface`) matches no rule, so it draws nothing.
  const found = new Set<string>();
  for (const tag of controlTags())
    for (const m of tag.text.matchAll(/(?<![\w-])((?:[\w-]+:)*)border-line[\w-]*/g)) {
      const utility = m[0].slice((m[1] ?? '').length);
      if (utility !== 'border-line' && utility !== 'border-line-strong') found.add(`${tag.file}:${tag.line}: ${m[0]} (not a class)`);
      else if (utility === 'border-line' && !m[1]?.split(':').includes('dark')) found.add(`${tag.file}:${tag.line}: ${m[0]}`);
    }
  assert.ok(controlTags().length > 50, 'the control scan finds the native controls (else it is broken)');
  assert.deepEqual([...found], [], 'a control draws its edge with the divider colour: use border-line-strong');
});

/** What may follow a colour utility's prefix besides a colour: Tailwind's other utilities on the same prefix. */
const NOT_A_COLOUR: Record<string, RegExp> = {
  text: /^(xs|sm|base|lg|[2-9]?xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/,
  bg: /^(none|fixed|local|scroll|auto|cover|contain|center|top|bottom|left|right|(left|right)-(top|bottom)|repeat(-x|-y|-round|-space)?|no-repeat|(clip|origin|blend|linear|radial|conic|gradient)(-.+)?)$/,
  border: /^(\d+|[xytrblse](-\d+)?|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing(-.+)?)$/,
  divide: /^([xy](-\d+|-reverse)?|solid|dashed|dotted|double|none)$/,
  ring: /^(\d+|inset)$/,
  'ring-offset': /^\d+$/,
  outline: /^(none|hidden|solid|dashed|dotted|double|\d+|offset-\d+)$/,
  decoration: /^(solid|double|dotted|dashed|wavy|auto|from-font|clone|slice|\d+)$/,
  fill: /^none$/,
  stroke: /^(none|\d+)$/,
  caret: /^auto$/,
};
const COLOUR_UTILITY = /^-?(text|bg|border(?:-[xytrblse])?|divide|ring(?:-offset)?|outline|decoration|fill|stroke|caret)-(.+?)(?:\/(?:\d+|\[[^\]]*\]))?$/;

test('every colour class in web/src names a theme colour, and every var() names a custom property', () => {
  // A class whose colour isn't a theme colour matches no rule and draws nothing: `dark:border-linebg-surface` (a missing
  // space) dropped both `dark:border-line` and `bg-surface` from five fields, and every other check here passed.
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const bad: string[] = [];
  let seen = 0;
  for (const file of files(webSrc)) {
    const rel = file.slice(repoRoot.length);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const lit of line.matchAll(/(['"`])((?:(?!\1).)*)\1/g))
        // A quote or brace ends a class even inside a "literal" that an apostrophe in JSX text opened (`hub's`).
        for (const tok of (lit[2] ?? '').split(/[\s"'`{}]+/)) {
          for (const v of tok.matchAll(/var\((--[\w-]+)/g)) if (!defined.has(v[1])) bad.push(`${rel}:${i + 1}: ${tok} (${v[1]} is not set in styles.css)`);
          const m = COLOUR_UTILITY.exec(splitClass(tok)[1]);
          if (!m) continue;
          const [, prefix = '', name = ''] = m;
          seen++;
          if (name.startsWith('[') || name.startsWith('(')) continue; // arbitrary: its var()s are checked above
          if (THEME.has(name) || name in BUILT_IN || /^(transparent|current|inherit)$/.test(name)) continue;
          if (NOT_A_COLOUR[prefix.replace(/^border-[xytrblse]$/, 'border')]?.test(name)) continue;
          bad.push(`${rel}:${i + 1}: ${tok}`);
        }
    });
  }
  assert.ok(seen > 500, `the scan finds the colour classes (${seen}; else it is broken)`);
  assert.deepEqual(bad, [], 'a colour class or var() that names no theme colour or custom property');
});

test('dark mode is unchanged', () => {
  const dark = blockText('.dark');
  assert.ok(dark, 'styles.css has a .dark block');
  assert.equal(createHash('sha256').update(dark).digest('hex'), DARK_SHA256);
});
