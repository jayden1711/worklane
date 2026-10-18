import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

// WHY (#625): scripts/dev/perf-dashboard.mjs drives the dashboard by data-testid. Nothing in CI runs it, so when the
// sidebar's ids changed (#585's nav groups) it kept clicking rows that were gone and only failed when someone ran it.
// This reads the ids it uses and holds each to docs/feature-map.md, which test/feature-map.test.ts holds to web/src.

interface Map { pages: { id: string; route: string }[]; features: { selector: string }[] }
const fm = (await import(pathToFileURL(join(repoRoot, 'scripts', 'dev', 'feature-map.mjs')).href)) as {
  parseFeatureMap: (md: string) => Map;
  mappedTestIds: (m: Map) => string[];
};
const map = fm.parseFeatureMap(readFileSync(join(repoRoot, 'docs', 'feature-map.md'), 'utf8'));
const mapped = new Set(fm.mappedTestIds(map));
const script = readFileSync(join(repoRoot, 'scripts', 'dev', 'perf-dashboard.mjs'), 'utf8');

/**
 * The test ids the script uses: a literal `data-testid="x"`, and every string literal shaped like the dashboard's
 * page roots, sidebar rows and tabs (`page-…`, `nav-…`, `tab-…`, `group-…`), which the script passes to the helpers
 * that build `[data-testid="${testid}"]`.
 */
function scriptTestIds(src: string): string[] {
  const ids = new Set<string>();
  for (const m of src.matchAll(/data-testid=\\?"([^"$\\]+)\\?"/g)) ids.add(m[1]!);
  for (const m of src.matchAll(/(['"`])((?:page|nav|tab|group)-[a-z0-9-]+)\1/g)) ids.add(m[2]!);
  return [...ids].sort();
}

test('perf-dashboard: every data-testid it clicks or waits for is in docs/feature-map.md', () => {
  const ids = scriptTestIds(script);
  const missing = ids.filter((id) => !mapped.has(id));
  assert.deepEqual(missing, [], `ids scripts/dev/perf-dashboard.mjs uses that docs/feature-map.md doesn't list: ${missing.join(', ')}`);
  // Not vacuous: the root of every page it measures is read.
  for (const id of ['page-overview', 'page-board', 'page-prs', 'page-health']) assert.ok(ids.includes(id), `the script's ${id} was read (read: ${ids.join(', ')})`);
});

test('perf-dashboard: every selector it builds goes through a test id the test above reads', () => {
  // A `[data-testid="${x}"]` must interpolate the helpers' `testid` parameter, whose callers pass the literals read above.
  const interpolated = [...script.matchAll(/data-testid=\\?"\$\{(\w+)\}\\?"/g)].map((m) => m[1]!);
  assert.ok(interpolated.length > 0, 'the selector helpers were found');
  assert.deepEqual([...new Set(interpolated)], ['testid']);
});

test('perf-dashboard: an address it navigates to is a page route in docs/feature-map.md', () => {
  const routes = new Set(map.pages.map((p) => p.route));
  const paths = [...script.matchAll(/\bpath: '([^']+)'/g)].map((m) => m[1]!);
  for (const p of paths) assert.ok(routes.has(p), `${p} is a route in docs/feature-map.md`);
});
