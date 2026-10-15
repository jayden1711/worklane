// The cross-instance leak checks' markers (helpers.ts marksOf): a marker number matches only as a whole number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marksOf, MARKS, PID_LIMIT } from './helpers.js';

const b = MARKS.b;

test("marksOf: a marker number inside a larger number (a byte count) isn't a leak; the number itself, and every text marker, is", () => {
  const leak = marksOf(b);
  assert.doesNotMatch(`{"availableBytes":1${b.pr}4}`, leak, "b's PR inside a byte count");
  assert.doesNotMatch(`{"n":3${b.issue}}`, leak, "b's issue inside a larger number");
  for (const hit of [`#${b.pr}`, `"pr":${b.pr},`, `issue ${b.issue}`, `${b.issue + 1}`, `[${b.issue + 2}]`, 'tr-beta-1', 'beta-proj', 'wl-beta@host', 'Beta-only']) assert.match(hit, leak, hit);
});

test('exampleProject repos run no background git maintenance or auto-gc, so tree walks never race a vanishing lock file', async () => {
  const { exampleProject } = await import('./helpers.js');
  const { execFileSync } = await import('node:child_process');
  const { dir } = exampleProject();
  const get = (k: string) => execFileSync('git', ['config', '--get', k], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(get('maintenance.auto'), 'false');
  assert.equal(get('gc.auto'), '0');
});

test('marksOf: no marker number can be a pid, so a page that shows a pid never reads as another instance\'s item', () => {
  // On CI the test process's pid (shown on the Agents page as "pid N") once equalled a marker (8170), and b's own page
  // read as a's. Every pid is at most PID_LIMIT; a marker at or below it is refused.
  for (const m of [MARKS.a, MARKS.b]) for (const n of [m.issue, m.issue + 1, m.issue + 2, m.pr]) assert.ok(n > PID_LIMIT, `${n} could be a pid`);
  for (const pid of [1, 8170, 9201, process.pid, PID_LIMIT]) {
    assert.doesNotMatch(`pid ${pid} · started now`, marksOf(MARKS.a), `pid ${pid} as a's item`);
    assert.doesNotMatch(`pid ${pid} · started now`, marksOf(MARKS.b), `pid ${pid} as b's item`);
  }
  assert.throws(() => marksOf({ ...MARKS.a, pr: 8170 }), /could be a pid/);
});
