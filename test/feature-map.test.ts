import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

interface Page { id: string; route: string; file: string; sidebar: string | null; shortcut: string; ready: string }
interface Map { pages: Page[]; features: { name: string; selector: string }[] }
const fm = (await import(pathToFileURL(join(repoRoot, 'scripts', 'dev', 'feature-map.mjs')).href)) as {
  parseFeatureMap: (md: string) => Map;
  mappedTestIds: (m: Map) => string[];
};

const web = join(repoRoot, 'web', 'src');
const app = readFileSync(join(web, 'App.tsx'), 'utf8');
const map = fm.parseFeatureMap(readFileSync(join(repoRoot, 'docs', 'feature-map.md'), 'utf8'));
const norm = (route: string) => route.replace(/<[a-z]+>/g, '<>');

/** The routes App.tsx dispatches on: `path === '/x'`, `path.startsWith('/x')`, a `xMatch` regex, and the fallback `/`. */
function codeRoutes(src: string): string[] {
  const out = new Set<string>(['/']);
  const regexes = new Map<string, string>();
  for (const m of src.matchAll(/const (\w+Match) = path\.match\(\/\^(.+?)\/\);/g)) {
    regexes.set(m[1]!, m[2]!.replace(/\$$/, '').replace(/\\\//g, '/').replace(/\([^)]*\)/g, '<>'));
  }
  for (const m of src.matchAll(/if \(([^)]*?(?:\([^)]*\))?[^)]*)\) page = </g)) {
    const cond = m[1]!;
    const eq = cond.match(/path === '([^']+)'/) ?? cond.match(/path\.startsWith\('([^']+)'\)/);
    if (eq) out.add(eq[1]!);
    else if (regexes.has(cond.trim())) out.add(regexes.get(cond.trim())!);
    // Not about the path (e.g. the loading state): not a route.
    else if (!/\bpath\b|Match\b/.test(cond)) continue;
    else throw new Error(`a route condition the feature-map test can't read: ${cond}`);
  }
  return [...out];
}

/** Sidebar rows: { to, label, chord } from the NAV list. */
function navRows(src: string) {
  return [...src.matchAll(/\{ to: '([^']+)', label: '([^']+)', icon: \w+, chord: '([^']+)'[^}]*\}/g)].map((m) => ({ to: m[1]!, label: m[2]!, chord: m[3]! }));
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
}

/**
 * Every test id the UI sets: data-testid="x", the components' testId / dataTestId props, and testId fields
 * in lists like NAV. A template's fixed prefix ("pr-" of `pr-${n}`) is not an id of its own.
 */
function codeTestIds(): string[] {
  const ids = new Set<string>();
  for (const f of files(web)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:data-testid|dataTestId|testid|testId)(?:=\{?|:\s*)["'`]([^"'`$]+)/g)) if (!m[1]!.endsWith('-')) ids.add(m[1]!);
  }
  return [...ids];
}

test('every route the dashboard serves is in the feature map, and every mapped route exists', () => {
  const code = codeRoutes(app).sort();
  const mapped = map.pages.map((p) => norm(p.route)).sort();
  assert.deepEqual(code.filter((r) => !mapped.includes(r)), [], 'routes missing from docs/feature-map.md');
  assert.deepEqual(mapped.filter((r) => !code.includes(r)), [], 'routes in docs/feature-map.md the dashboard no longer serves');
});

test('every page file is in the feature map, and every mapped file exists', () => {
  const pages = readdirSync(join(web, 'pages')).filter((f) => f.endsWith('.tsx')).map((f) => `web/src/pages/${f}`);
  const mapped = map.pages.map((p) => p.file);
  assert.deepEqual(pages.filter((f) => !mapped.includes(f)), [], 'page files missing from the map');
  for (const f of mapped) assert.ok(existsSync(join(repoRoot, f)), `${f} is in the map but doesn't exist`);
});

test('the sidebar rows and their g shortcuts match the feature map', () => {
  const nav = navRows(app);
  // Every row of the NAV list was read: a row in a shape the reader doesn't know would otherwise be skipped.
  const listed = app.slice(app.indexOf('const NAV'), app.indexOf('];', app.indexOf('const NAV'))).match(/\{ to: '/g) ?? [];
  assert.ok(nav.length >= 10, 'the NAV list was found');
  assert.equal(nav.length, listed.length, 'every NAV row was read');
  for (const n of nav) {
    const p = map.pages.find((x) => x.route === n.to);
    assert.ok(p, `sidebar row ${n.label} (${n.to}) is not a mapped page`);
    assert.equal(p.sidebar, n.label, `${n.to}: sidebar label`);
    assert.equal(p.shortcut, `g ${n.chord}`, `${n.to}: shortcut`);
  }
  for (const p of map.pages.filter((x) => x.sidebar)) assert.ok(nav.some((n) => n.to === p.route), `${p.id} claims a sidebar row the dashboard doesn't have`);
});

test('every data-testid the UI sets is in the feature map, and every mapped test id is set somewhere', () => {
  const code = codeTestIds();
  const mapped = fm.mappedTestIds(map);
  const text = readFileSync(join(repoRoot, 'docs', 'feature-map.md'), 'utf8');
  assert.deepEqual(code.filter((id) => !text.includes(id)), [], 'test ids missing from docs/feature-map.md');
  assert.deepEqual(mapped.filter((id) => !code.some((c) => id === c || id.startsWith(c))), [], 'mapped test ids no longer in web/src');
});

test('the route reader catches a page added without a map entry', () => {
  const added = app.replace("else if (path === '/logs') page = <LogsPage />;", "else if (path === '/logs') page = <LogsPage />;\n  else if (path === '/new-page') page = <LogsPage />;");
  assert.notEqual(added, app, 'the fixture edit applied');
  assert.ok(codeRoutes(added).includes('/new-page'));
  assert.ok(!map.pages.some((p) => p.route === '/new-page'));
  assert.throws(() => codeRoutes(`${app}\n  else if (path.endsWith('/x')) page = <X />;`), /can't read/);
});
