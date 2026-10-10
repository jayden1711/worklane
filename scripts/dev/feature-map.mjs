// The dashboard's feature map (docs/feature-map.md) as data, and the control
// script's command parsing. No side effects: the tests import this.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAP_FILE = fileURLToPath(new URL('../../docs/feature-map.md', import.meta.url));

const cells = (row) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim().replace(/^`(.*)`$/, '$1'));

/** The rows of the Markdown table under `## <heading>`, as objects keyed by its header cells (lowercased). */
export function table(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return [];
  const rows = [];
  let head = null;
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    if (!l.trim().startsWith('|')) continue;
    if (/^\|\s*-/.test(l.trim())) continue;
    const c = cells(l);
    if (!head) head = c.map((h) => h.toLowerCase());
    else rows.push(Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])));
  }
  return rows;
}

/** Pages: { id, route, file, sidebar, shortcut, ready }. Features: { name, where, how, keys, selector }. */
export function parseFeatureMap(md) {
  const pages = table(md, 'Pages').map((r) => ({ id: r.page, route: r.route, file: r.file, sidebar: r.sidebar === '–' ? null : r.sidebar, shortcut: r.shortcut, ready: r['ready when'] }));
  const features = table(md, 'Features').map((r) => ({ name: r.feature, where: r.where, how: r['how a person reaches it'], keys: r.keys, selector: r.selector }));
  return { pages, features };
}

export function loadFeatureMap(file = MAP_FILE) {
  return parseFeatureMap(readFileSync(file, 'utf8'));
}

/** Every data-testid a map names (in `[data-testid="x"]` selectors). */
export function mappedTestIds(map) {
  const ids = new Set();
  for (const s of [...map.features.map((f) => f.selector), ...map.pages.map((p) => p.ready)]) for (const m of s.matchAll(/data-testid="([^"]+)"/g)) ids.add(m[1]);
  return [...ids];
}

/** A page's path with its parameters filled in: `/issues/<n>` with { n: 3 } is `/issues/3`. */
export function pagePath(page, params = {}) {
  return page.route.replace(/<([a-z]+)>/g, (_, k) => {
    if (params[k] === undefined) throw new Error(`page ${page.id} needs ${k}`);
    return encodeURIComponent(String(params[k]));
  });
}

/** The heading text that says a page has rendered, with its parameters filled in. */
export function readyText(page, params = {}) {
  return page.ready.replace(/<([a-z]+)>/g, (_, k) => String(params[k] ?? ''));
}

/** Find a page by id or by path ("/decisions", "/issues/3"). */
export function findPage(map, which) {
  const byId = map.pages.find((p) => p.id === which);
  if (byId) return { page: byId, params: {} };
  for (const p of map.pages) {
    const names = [];
    const re = new RegExp(`^${p.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<([a-z]+)>/g, (_, k) => (names.push(k), '([^/?#]+)'))}$`);
    const m = which.split(/[?#]/)[0].match(re);
    if (m) return { page: p, params: Object.fromEntries(names.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

/** A console error as a comparable key: page, kind, text and the URL's path (ports differ between runs). */
export function errorKey(page, e) {
  let path = '';
  try {
    path = e.url ? new URL(e.url).pathname : '';
  } catch {
    path = e.url ?? '';
  }
  return `${page}\u0000${e.kind}\u0000${String(e.text).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1')}\u0000${path}`;
}

/** The error keys in an earlier `check` run's output (JSON lines). */
export function baselineErrors(jsonl) {
  const keys = [];
  for (const l of jsonl.split(/\r?\n/)) {
    if (!l.trim().startsWith('{')) continue;
    const r = JSON.parse(l);
    for (const e of r.errors ?? []) keys.push(errorKey(r.page, e));
  }
  return keys;
}

export const OPS = ['open', 'click', 'type', 'key', 'text', 'wait', 'screenshot', 'console', 'trace', 'eval'];

/** One batch command: a JSON object with an `op`, or a short line like `open decisions` / `click text:Approve`. */
export function parseCommand(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('{')) {
    const c = JSON.parse(s);
    if (!OPS.includes(c.op)) throw new Error(`unknown op ${JSON.stringify(c.op)} (one of ${OPS.join(', ')})`);
    return c;
  }
  const [op, ...rest] = s.split(/\s+/);
  const arg = rest.join(' ');
  if (!OPS.includes(op)) throw new Error(`unknown op ${JSON.stringify(op)} (one of ${OPS.join(', ')})`);
  switch (op) {
    case 'open':
      return { op, page: arg };
    case 'click':
    case 'text':
      return { op, ...(arg ? { target: arg } : {}) };
    case 'type':
      return { op, text: arg };
    case 'key':
      return { op, key: arg };
    case 'wait':
      return /^\d+$/.test(arg) ? { op, ms: Number(arg) } : { op, target: arg };
    case 'screenshot':
    case 'trace':
      return { op, file: arg };
    case 'eval':
      return { op, expr: arg };
    default:
      return { op };
  }
}

/** A target as a CSS selector, a `testid:x` shorthand or `text:Label` (a button or link with that text). */
export function targetExpr(target) {
  if (target.startsWith('testid:')) return `document.querySelector(${JSON.stringify(`[data-testid="${target.slice(7)}"]`)})`;
  if (target.startsWith('text:')) {
    const want = JSON.stringify(target.slice(5).trim());
    return `[...document.querySelectorAll('button,a,[role=button],[role=tab],[role=option],[role=menuitem]')].find((e) => e.innerText.trim() === ${want} && e.offsetParent !== null)`;
  }
  return `document.querySelector(${JSON.stringify(target)})`;
}
