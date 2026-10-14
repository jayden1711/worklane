// In CI the web-UI tests (a real Chrome against the built dashboard, dist/web) must run, never skip: ci.yml builds
// the UI before each shard's tests and sets CI_REQUIRE_WEB=1 there, which makes a missing UI or Chrome fail the test
// file (test/browser-helpers.ts). Before this, the UI was built after the tests, and every such test reported
// "# SKIP web UI not built" in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { webUiBuilt, webUiSkip } from './browser-helpers.js';
import { repoRoot } from './helpers.js';

type Step = { name?: string; run?: string; if?: string; env?: Record<string, string> };

test('ci.yml: every test shard builds the dashboard UI, unconditionally, before its tests, which run with CI_REQUIRE_WEB=1', () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, { steps?: Step[] }> };
  const shards = Object.entries(wf.jobs).filter(([id]) => id.startsWith('test-shard-'));
  assert.ok(shards.length >= 2, 'found the test shard jobs');
  for (const [id, job] of shards) {
    const steps = job.steps ?? [];
    const tests = steps.findIndex((s) => s.name === "this shard's tests");
    const web = steps.findIndex((s) => /\bnpm run build:web\b/.test(s.run ?? ''));
    assert.ok(tests >= 0, `${id} runs its tests`);
    assert.ok(web >= 0 && web < tests, `${id} builds the dashboard UI before its tests (build:web at step ${web}, the tests at ${tests})`);
    assert.equal(steps[web]?.if, undefined, `${id}: the UI build runs in every shard`);
    assert.equal(String(steps[tests]?.env?.CI_REQUIRE_WEB), '1', `${id}: the tests run with CI_REQUIRE_WEB=1`);
    const node = steps.findIndex((s) => /^npm run build$/.test((s.run ?? '').trim()));
    assert.ok(node >= 0 && node < tests, `${id} builds before its tests`);
  }
});

test('with CI_REQUIRE_WEB=1 an unbuilt UI or a missing Chrome throws; without it they are a skip reason', () => {
  const empty = mkdtempSync(join(tmpdir(), 'web-ui-'));
  const was = process.env.CI_REQUIRE_WEB;
  try {
    delete process.env.CI_REQUIRE_WEB;
    assert.equal(webUiBuilt(join(empty, 'index.html')), false);
    if (process.platform !== 'win32') {
      assert.equal(webUiSkip('/usr/bin/chrome', join(empty, 'index.html')), 'web UI not built (npm run build:web)');
      assert.equal(webUiSkip(null, join(empty, 'index.html')), 'no Chrome or Chromium');
    }
    process.env.CI_REQUIRE_WEB = '1';
    assert.throws(() => webUiBuilt(join(empty, 'index.html')), /CI_REQUIRE_WEB=1, but the web UI is not built/);
    if (process.platform !== 'win32') {
      assert.throws(() => webUiSkip('/usr/bin/chrome', join(empty, 'index.html')), /the web UI is not built/);
      assert.throws(() => webUiSkip(null), /no Chrome or Chromium was found/);
    }
  } finally {
    if (was === undefined) delete process.env.CI_REQUIRE_WEB;
    else process.env.CI_REQUIRE_WEB = was;
    rmSync(empty, { recursive: true, force: true });
  }
});

test('no test file looks at dist/web or skips for an unbuilt UI on its own: they ask test/browser-helpers.ts', () => {
  const own = globSync('test/**/*.ts', { cwd: repoRoot }).map((f) => f.split('\\').join('/')).filter((f) => f !== 'test/browser-helpers.ts' && f !== 'test/web-ui-required.test.ts');
  const offenders = own.filter((f) => {
    const src = readFileSync(join(repoRoot, f), 'utf8');
    return /existsSync\([^)]*'dist',\s*'web'/.test(src) || /existsSync\([^)]*dist\/web/.test(src) || /web UI not built/.test(src);
  });
  assert.deepEqual(offenders, []);
});
