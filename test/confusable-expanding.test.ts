// #763 round 8: characters whose forms grow. An Arabic ligature becomes 18 characters in each form, and each later
// form re-read the grown string, while the forms were charged by the path's length: one computeLevel took 16 to 24 s
// (measured by the round-7 delta check). Now each pass is charged by what it reads and makes, the skeleton stops at
// the cap, and the plain skeleton comes first. A long run of combining marks (sorting it grows faster than its
// length) isn't compared at all. Each run is in a child process with a timeout. Round 10: the bound is held in budget
// units (test/confusable-budget-units.test.ts, the ligature shapes among them), not by a wall-clock assertion here.
//
// WHY the ligature is written as itself, with a name: no committed file holds a code point number; the first test
// checks it is the character its name says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { ReviewConfig } from '../src/config/schema.js';
import { computeLevel, type ChangeFile } from '../src/review.js';
import { repoRoot } from './helpers.js';

/** The Arabic ligature sallallahou alayhe wasallam: one character, 18 in its compatibility form. */
const LIGATURE = 'ﷺ';
const engine = () => ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));

test('#763 round 8: the ligature here is one Arabic character that is 18 characters in its compatibility form', () => {
  assert.ok(LIGATURE.length === 1 && /^\p{Script=Arabic}$/u.test(LIGATURE) && LIGATURE.normalize('NFKC').length === 18);
});

/** computeLevel's wall time and level for `count` paths of `per` ligatures each, under `cfg`, in a child process. */
function timed(cfg: unknown, per: number, count: number): { ms: number; level: string } {
  const url = (p: string) => pathToFileURL(join(repoRoot, 'dist', 'src', p)).href;
  const script = `const { computeLevel } = await import(${JSON.stringify(url('review.js'))});
const { ReviewConfig } = await import(${JSON.stringify(url('config/schema.js'))});
const cfg = ReviewConfig.parse(${JSON.stringify(cfg)});
const files = [];
for (let i = 0; i < ${count}; i++) files.push({ path: 'a/' + ${JSON.stringify(LIGATURE)}.repeat(${per}) + i.toString(36), added: 1, removed: 0 });
const t = performance.now();
const r = computeLevel({ files, labels: [], moneyPaths: [], scope: undefined }, cfg);
console.log(JSON.stringify({ ms: performance.now() - t, level: r.level }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `the timing run didn't finish in 30 s (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout.trim()) as { ms: number; level: string };
}

test('#763 round 8: 5,000 paths of 1,000 ligatures under the engine\'s review.yaml: one computeLevel finishes, and held', () => {
  assert.equal(timed(engine(), 1_000, 5_000).level, 'L3');
});

test('#763 round 8: 5,000 paths of 220 ligatures (forms just under the cap) against 400 short globs: finishes, held once the budget is spent', () => {
  const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
  const cfg = ReviewConfig.parse({ version: 1, categories: { crit: Array.from({ length: 400 }, (_, i) => `svc${i}/**`) }, levels: { ...LEVELS, L3_human: { when: ['crit'], over_lines: 100_000_000 } } });
  assert.equal(timed(cfg, 220, 5_000).level, 'L3');
});

test('#763 round 8: a path with a run of more than 30 combining marks isn\'t compared: it is held, naming why', () => {
  const marks = 'é'.normalize('NFD').slice(1).repeat(31);
  const path = `docs/note${marks}.md`;
  const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
  const level = computeLevel({ files, labels: [], moneyPaths: [], scope: undefined }, engine());
  assert.equal(level.level, 'L3');
  assert.ok(level.reasons.some((r) => r.includes('not compared: it has a run of more than 30 combining marks')), level.reasons.join('\n'));
  // Thirty marks are compared as usual: a visible accent keeps normal review.
  const thirty = `docs/note${'é'.normalize('NFD').slice(1).repeat(30)}.md`;
  assert.equal(computeLevel({ files: [{ path: thirty, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, engine()).level, 'L0');
});
