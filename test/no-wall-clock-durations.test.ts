// WHY (#582): a test that measures elapsed time as Date.now() minus a start reads the wall clock, which an NTP step
// moves (back about 2.5 s every 30 s on one machine): the wait comes out shorter or longer than it was, and the test
// fails or passes on the clock, not the code. Elapsed time is measured with performance.now() (monotonic) or a clock
// the code under test is given. The ones already in test/ are allowed by file, each count exact, so a sweep lowers it
// here and no file can gain one back; a file with none may never get one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { repoRoot } from './helpers.js';

/** The wall-clock durations each test file had when this check came in (#582), by file; only ever lowered. */
const ALLOWED: Record<string, number> = {
  'test/add-project-requests.test.ts': 1,
  'test/auto-config.test.ts': 1,
  'test/avatars.test.ts': 1,
  'test/browser-helpers.ts': 1,
  'test/browser-run.test.ts': 1,
  'test/ci-batch.test.ts': 2,
  'test/ci-runner-setup.test.ts': 1,
  'test/claude-account-script.test.ts': 1,
  'test/cli-agents.test.ts': 1,
  'test/github-app.test.ts': 2,
  'test/instance-records.test.ts': 1,
  'test/intake-exactly-once.test.ts': 1,
  'test/intake.test.ts': 1,
  'test/isolate.test.ts': 4,
  'test/locks.test.ts': 1,
  'test/login-start-lock.test.ts': 2,
  'test/machine-helper.test.ts': 1,
  'test/machine-no-shift.test.ts': 2,
  'test/no-late-shift.test.ts': 6,
  'test/offline-chrome.test.ts': 1,
  'test/plugin-approval.test.ts': 1,
  'test/post-edit-hook.test.ts': 1,
  'test/push-gate-hook.test.ts': 2,
  'test/quiet-sqlite.test.ts': 1,
  'test/shutdown.test.ts': 1,
  'test/siri-routes.test.ts': 1,
  'test/testrun-pr-batch.test.ts': 2,
  'test/trust.test.ts': 1,
  'test/update-drain.test.ts': 8,
  'test/updater-setup.test.ts': 5,
  'test/web-render.test.ts': 8,
};

/** Date.now(), then a minus: whatever the spacing, never `--` (a decrement isn't a duration). */
const DURATION = /Date\.now\(\)\s*-(?!-)/g;

/** Every source file under test/, as a path from the repo root with forward slashes. */
function testSources(dir = join(repoRoot, 'test')): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...testSources(p));
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(e.name)) out.push(relative(repoRoot, p).split(sep).join('/'));
  }
  return out;
}

const count = (text: string) => (text.match(DURATION) ?? []).length;

test('the pattern counts a wall-clock duration, however spaced, and nothing else', () => {
  // Built at run time, so this file has none of its own.
  const now = ['Date', 'now()'].join('.');
  assert.equal(count(`const ms = ${now} - t0;`), 1);
  assert.equal(count(`if (${now}-start > 5_000) {}`), 1);
  assert.equal(count(`${now} - a + ${now} - b`), 2);
  assert.equal(count(`const t0 = ${now}; const ms = performance.now() - t1; at: ${now} + 1; n = ${now}--`), 0);
});

test('no test file measures a new duration on the wall clock (Date.now() minus a start): performance.now() or an injected clock instead', () => {
  const found = new Map(testSources().map((f) => [f, count(readFileSync(join(repoRoot, f), 'utf8'))] as const));
  const over = [...found].filter(([f, n]) => n > (ALLOWED[f] ?? 0)).map(([f, n]) => `${f}: ${n}, allowed ${ALLOWED[f] ?? 0}`);
  assert.deepEqual(over, [], 'elapsed time read off the wall clock, which an NTP step moves: use performance.now() or a clock the code is given (#582)');
  // A file that has fewer now: its allowance comes down with it, so none can come back unseen.
  const under = Object.entries(ALLOWED).filter(([f, n]) => (found.get(f) ?? 0) < n).map(([f, n]) => `${f}: ${found.get(f) ?? 0}, allowed ${n}`);
  assert.deepEqual(under, [], 'fewer wall-clock durations than allowed: lower (or remove) the allowance in test/no-wall-clock-durations.test.ts');
});
