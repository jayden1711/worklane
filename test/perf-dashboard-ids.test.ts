import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';

// WHY (#625): scripts/dev/perf-dashboard.mjs drives the dashboard by data-testid. Nothing in CI runs it, so when the
// sidebar's ids changed (#585's nav groups) it kept clicking rows that were gone and only failed when someone ran it.
// This reads the ids and addresses it uses and holds each to docs/feature-map.md, which test/feature-map.test.ts holds
// to web/src.

interface Map { pages: { id: string; route: string }[]; features: { selector: string }[] }
const fm = (await import(pathToFileURL(join(repoRoot, 'scripts', 'dev', 'feature-map.mjs')).href)) as {
  parseFeatureMap: (md: string) => Map;
  mappedTestIds: (m: Map) => string[];
};
const scriptFile = join(repoRoot, 'scripts', 'dev', 'perf-dashboard.mjs');
const map = fm.parseFeatureMap(readFileSync(join(repoRoot, 'docs', 'feature-map.md'), 'utf8'));
const mapped = new Set(fm.mappedTestIds(map));
const script = readFileSync(scriptFile, 'utf8');

const ID = '(?:page|nav|tab|group)-';

/**
 * The test ids a script uses: a literal `data-testid="x"`, and every string literal shaped like the dashboard's page
 * roots, sidebar rows and tabs (`page-…`, `nav-…`, `tab-…`, `group-…`), which the script passes to the helpers that
 * build `[data-testid="${testid}"]`. `built`: ids made by a template or a `+`, which this can't read, so they are refused.
 */
function scriptTestIds(src: string): { ids: string[]; built: string[] } {
  const ids = new Set<string>();
  for (const m of src.matchAll(/data-testid=\\?"([^"$\\]+)\\?"/g)) ids.add(m[1]!);
  for (const m of src.matchAll(new RegExp(`(['"\`])(${ID}[a-z0-9-]+)\\1`, 'g'))) ids.add(m[2]!);
  const built = [
    ...[...src.matchAll(new RegExp(`\`[^\`]*?\\b${ID}[a-z0-9-]*\\$\\{`, 'g'))].map((m) => m[0]),
    ...[...src.matchAll(new RegExp(`(['"\`])${ID}[a-z0-9-]*\\1\\s*\\+`, 'g'))].map((m) => m[0]),
    ...[...src.matchAll(new RegExp(`\\+\\s*(['"\`])${ID}[a-z0-9-]*\\1`, 'g'))].map((m) => m[0]),
  ];
  return { ids: [...ids].sort(), built };
}

/** The addresses a script switches to: `path: '/x'`, any quote. */
function scriptPaths(src: string): string[] {
  return [...src.matchAll(/\bpath:\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]!);
}

test('perf-dashboard: the readers catch an id or address they could otherwise miss', () => {
  // A templated or concatenated id for a row that no longer exists is refused, not skipped.
  assert.notDeepEqual(scriptTestIds("{ click: `nav-${'board'}` }").built, []);
  assert.notDeepEqual(scriptTestIds("{ click: 'nav-' + name }").built, []);
  assert.notDeepEqual(scriptTestIds("{ click: prefix + 'tab-' }").built, []);
  assert.deepEqual(scriptTestIds("{ click: 'nav-work', root: \"page-board\", t: `tab-prs` }"), { ids: ['nav-work', 'page-board', 'tab-prs'], built: [] });
  // An address in double quotes or backticks is read too.
  assert.deepEqual(scriptPaths(`{ path: "/machine/gone" }, { path: '/a' }, { path: \`/b\` }`), ['/machine/gone', '/a', '/b']);
});

test('perf-dashboard: every data-testid it clicks or waits for is in docs/feature-map.md', () => {
  const { ids, built } = scriptTestIds(script);
  const missing = ids.filter((id) => !mapped.has(id));
  assert.deepEqual(
    { missing, built },
    { missing: [], built: [] },
    `scripts/dev/perf-dashboard.mjs: ids docs/feature-map.md doesn't list: ${missing.join(', ') || 'none'}; ids built from parts (write each as a plain literal so this test can read it): ${built.join(', ') || 'none'}`,
  );
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
  const paths = scriptPaths(script);
  // Not vacuous: the Health step's address is read.
  assert.ok(paths.includes('/machine/health'), `the Health address was read (read: ${paths.join(', ')})`);
  for (const p of paths) assert.ok(routes.has(p), `${p} is a route in docs/feature-map.md`);
});

test('perf-dashboard: its engine processes run on a machine of their own, not the real home or state', async () => {
  // INVARIANT: importing the script must not start a perf run (Chrome, servers): it runs only as a program.
  assert.match(script, /^if \(isMain && argv\[0\] === '--serve'\) \{$/m, 'the --serve branch runs only as a program');
  assert.match(script, /^\} else if \(isMain\) \{\n {2}await main\(\);\n\}$/m, 'main runs only as a program');
  const { devMachine } = (await import(pathToFileURL(scriptFile).href)) as {
    devMachine: (dir: string, env: Record<string, string>, envPrefix: string) => Record<string, string>;
  };
  const p = BRAND.envPrefix;
  const dir = join(repoRoot, 'nowhere', 'machine');
  const real = { PATH: '/usr/bin', HOME: '/home/example', XDG_STATE_HOME: '/home/example/.local/state', [`${p}_STATE_DIR`]: '/real/state', [`${p}_HELD_OUT_DIR`]: '/real/held-out', [`${p}_INSTANCE`]: 'live', [`${p}_BROWSER_TIMEOUT_SCALE`]: '2', AGENT_SLOTS_DIR: '/var/lib/slots', AGENT_SLOTS_CAP: '4' };
  const env = devMachine(dir, real, p);
  const inside = (v: string) => {
    const r = relative(dir, v);
    return !r.startsWith('..') && !isAbsolute(r);
  };
  for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', `${p}_PREFIX`, `${p}_STATE_DIR`, `${p}_HELD_OUT_DIR`, `${p}_MACHINE_INIT_DIR`, 'AGENT_SLOTS_DIR']) {
    assert.ok(env[k] && inside(env[k]), `${k} is inside the run's machine (${env[k]})`);
  }
  // The shell's other engine settings are dropped; the speed-only browser scale and the rest of the shell are kept.
  assert.equal(env[`${p}_INSTANCE`], undefined);
  assert.equal(env.AGENT_SLOTS_CAP, undefined);
  assert.equal(env[`${p}_BROWSER_TIMEOUT_SCALE`], '2');
  assert.equal(env.PATH, '/usr/bin');
  // The demo seeding and every instance's dashboard get that environment.
  assert.match(script, /'demo', join\(work, 'demo'\)\], \{[^}]*env: machine \}/);
  assert.match(script, /fork\([^\n]*env: machine \}\)/);
});
