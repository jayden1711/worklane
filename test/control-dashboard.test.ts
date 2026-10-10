import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';

const dir = join(repoRoot, 'scripts', 'dev');
const fm = (await import(pathToFileURL(join(dir, 'feature-map.mjs')).href)) as Record<string, (...a: never[]) => unknown>;
const ctl = (await import(pathToFileURL(join(dir, 'control-dashboard.mjs')).href)) as { findChrome: (given?: string) => string | null };
const map = (fm.loadFeatureMap as () => { pages: { id: string; route: string }[] })();

test('batch commands: the short form and JSON give the same command; an unknown op is refused', () => {
  const parse = fm.parseCommand as (l: string) => object | null;
  assert.deepEqual(parse('open decisions'), { op: 'open', page: 'decisions' });
  assert.deepEqual(parse('{"op":"open","page":"decisions"}'), { op: 'open', page: 'decisions' });
  assert.deepEqual(parse('click text:Show answered'), { op: 'click', target: 'text:Show answered' });
  assert.deepEqual(parse('key Meta+k'), { op: 'key', key: 'Meta+k' });
  assert.deepEqual(parse('wait 300'), { op: 'wait', ms: 300 });
  assert.deepEqual(parse('wait testid:prs-page'), { op: 'wait', target: 'testid:prs-page' });
  assert.equal(parse('# a comment'), null);
  assert.equal(parse('   '), null);
  assert.throws(() => parse('drag here'), /unknown op/);
  assert.throws(() => parse('{"op":"rm"}'), /unknown op/);
});

test('pages are found by feature-map id or by path, with their parameters', () => {
  const find = fm.findPage as (m: unknown, w: string) => { page: { id: string }; params: Record<string, string> } | null;
  assert.equal(find(map, 'decisions')?.page.id, 'decisions');
  assert.deepEqual(find(map, '/issues/12'), { page: map.pages.find((p) => p.id === 'issue-detail'), params: { n: '12' } });
  assert.equal(find(map, '/issues?view=board')?.page.id, 'issues');
  assert.equal(find(map, '/')?.page.id, 'overview');
  assert.equal(find(map, '/nowhere'), null);
  const path = fm.pagePath as (p: unknown, params: object) => string;
  assert.equal(path(map.pages.find((p) => p.id === 'issue-detail'), { n: 3 }), '/issues/3');
  assert.throws(() => path(map.pages.find((p) => p.id === 'issue-detail'), {}), /needs n/);
});

test('targets: testid and text shorthands and plain CSS become element lookups', () => {
  const expr = fm.targetExpr as (t: string) => string;
  assert.equal(expr('testid:pr-row'), 'document.querySelector("[data-testid=\\"pr-row\\"]")');
  assert.match(expr('text:Approve'), /innerText\.trim\(\) === "Approve"/);
  assert.equal(expr('main header h1'), 'document.querySelector("main header h1")');
});

test('a baseline makes only new console errors count: ports are ignored, a new path or text is not', () => {
  const key = fm.errorKey as (page: string, e: object) => string;
  const base = (fm.baselineErrors as (s: string) => string[])(`${JSON.stringify({ page: 'overview', errors: [{ kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:5001/api/hub' }] })}\n{"pages":1}\n`);
  assert.ok(base.includes(key('overview', { kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:6002/api/hub' })));
  assert.ok(!base.includes(key('overview', { kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:6002/api/prs' })));
  assert.ok(!base.includes(key('inbox', { kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:5001/api/hub' })));
});

// Needs a built UI (npm run build:web) and a Chrome or Chromium; skipped otherwise.
const chrome = ctl.findChrome(process.env.CHROME);
const built = existsSync(join(repoRoot, 'dist', 'web', 'index.html'));
test('end to end: opens a page in a real headless Chrome, and keeps all its state in its temporary directory', { skip: (!chrome && 'no Chrome or Chromium') || (!built && 'web UI not built') || (process.platform === 'win32' && 'checked on macOS and Linux') }, () => {
  // A state dir the script must not write to: before the fix, the run record for the run page landed here.
  const mine = mkdtempSync(join(tmpdir(), 'not-the-demo-'));
  const r = spawnSync(process.execPath, [join(dir, 'control-dashboard.mjs'), 'open', 'run-detail', ...(process.env.CHROME ? ['--chrome', process.env.CHROME] : [])], {
    encoding: 'utf8',
    env: { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: mine },
    timeout: 120_000,
  });
  const first = JSON.parse(r.stdout.split('\n')[0] ?? '{}') as { page?: string; heading?: string };
  assert.equal(first.page, 'run-detail', `${r.stdout}\n${r.stderr}`);
  assert.match(first.heading ?? '', /run$/);
  assert.deepEqual(readdirSync(mine), [], 'nothing written to the caller\'s state dir');
  void readFileSync;
});
