import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { oneChromeAtATime, webUiSkip } from './browser-helpers.js';
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
  assert.equal(find(map, '/')?.page.id, 'board');
  assert.equal(find(map, '/overview')?.page.id, 'overview');
  assert.equal(find(map, '/nowhere'), null);
  const path = fm.pagePath as (p: unknown, params: object) => string;
  assert.equal(path(map.pages.find((p) => p.id === 'issue-detail'), { n: 3 }), '/issues/3');
  assert.throws(() => path(map.pages.find((p) => p.id === 'issue-detail'), {}), /needs n/);
});

test('targets: testid and text shorthands and plain CSS become element lookups', () => {
  const expr = fm.targetExpr as (t: string) => string;
  assert.equal(expr('testid:pr-row'), 'document.querySelector("[data-testid=\\"pr-row\\"]")');
  // The whole text or its first line: buttons often carry a key hint on a second line.
  assert.match(expr('text:Approve'), /t === "Approve" \|\| t\.split\('\\n'\)\[0\]\.trim\(\) === "Approve"/);
  assert.equal(expr('main header h1'), 'document.querySelector("main header h1")');
});

test('a baseline makes only new console errors count: ports are ignored, a new path or text is not', () => {
  const key = fm.errorKey as (page: string, e: object) => string;
  const base = (fm.baselineErrors as (s: string) => string[])(`${JSON.stringify({ page: 'overview', errors: [{ kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:5001/api/hub' }] })}\n{"pages":1}\n`);
  assert.ok(base.includes(key('overview', { kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:6002/api/hub' })));
  assert.ok(!base.includes(key('overview', { kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:6002/api/prs' })));
  assert.ok(!base.includes(key('inbox', { kind: 'network', text: 'Failed: 404', url: 'http://127.0.0.1:5001/api/hub' })));
});

// Needs a built UI (npm run build:web) and a Chrome or Chromium; skipped otherwise, but never in CI (CI_REQUIRE_WEB).
const chrome = ctl.findChrome(process.env.CHROME);
test('end to end: opens a page in a real headless Chrome with PR history, and keeps all its state in its temporary directory', { skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  // A state dir the script must not write to: before the fix, the run record for the run page landed here.
  const mine = mkdtempSync(join(tmpdir(), 'not-the-demo-'));
  const r = spawnSync(process.execPath, [join(dir, 'control-dashboard.mjs'), 'open', 'run-detail', '--with-prs', ...(process.env.CHROME ? ['--chrome', process.env.CHROME] : [])], {
    encoding: 'utf8',
    env: { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: mine },
    timeout: 120_000,
  });
  // The tool's own words when it printed no JSON (it failed before opening the page), not a bare JSON.parse error.
  const line = r.stdout.split('\n')[0] ?? '';
  assert.ok(line.startsWith('{'), `control-dashboard printed no result (exit ${r.status}, signal ${r.signal}${r.error ? `, ${r.error.message}` : ''}):\n${r.stdout}\n${r.stderr}`);
  const first = JSON.parse(line) as { page?: string; heading?: string };
  assert.equal(first.page, 'run-detail', `${r.stdout}\n${r.stderr}`);
  assert.match(first.heading ?? '', /run$/);
  assert.deepEqual(readdirSync(mine), [], 'nothing written to the caller\'s state dir');
  // The PR history matches this engine's event schemas: every event was recorded.
  assert.doesNotMatch(r.stderr, /not recorded/, r.stderr);
  void readFileSync;
});

// On a loaded machine Chrome can take longer than one launch wait to open its DevTools port (main went red with
// "timed out after 20000 ms waiting for Chrome to open its DevTools port" when this script had a fixed wait of its
// own). It starts Chrome as the engine does (src/browser/cdp.ts launchChrome): a stuck start is stopped and Chrome
// is started once more, and that is said.
test('a Chrome that never opens its DevTools port is started once more, as the engine does, and the page still opens', { skip: webUiSkip(chrome) || (process.platform === 'win32' && 'the stand-in browser is a shell script') }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const work = mkdtempSync(join(tmpdir(), 'dash-stuck-chrome-'));
  try {
    // A stand-in that hangs the first time (as Chrome can on a loaded machine), then is the real Chrome.
    const stub = join(work, 'chrome');
    writeFileSync(stub, `#!/bin/sh\nif [ ! -f "${work}/started" ]; then echo $$ > "${work}/started"; exec sleep 600; fi\nexec "${chrome}" "$@"\n`);
    chmodSync(stub, 0o755);
    const r = spawnSync(process.execPath, [join(dir, 'control-dashboard.mjs'), 'open', 'overview', '--chrome', stub], { encoding: 'utf8', timeout: 180_000 });
    const line = r.stdout.split('\n')[0] ?? '';
    assert.ok(line.startsWith('{'), `control-dashboard printed no result (exit ${r.status}, signal ${r.signal}${r.error ? `, ${r.error.message}` : ''}):\n${r.stdout}\n${r.stderr}`);
    assert.equal((JSON.parse(line) as { page?: string }).page, 'overview', `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /control-dashboard: Chrome was started twice: the first never opened its DevTools port \(timed out after \d+ ms/);
    const stuck = Number(readFileSync(join(work, 'started'), 'utf8'));
    assert.throws(() => process.kill(stuck, 0), { code: 'ESRCH' }, 'the stuck first start was stopped');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
