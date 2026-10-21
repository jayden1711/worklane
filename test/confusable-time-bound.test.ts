// #763 round 7: the look-alike check's time is bounded, not only its glob-matching steps. Before, each pattern and
// form compared cost almost nothing in steps, so many short paths against many short globs ran for a long time before
// the budget ran out: 12 s for one computeLevel under the engine's own review.yaml (6,000 paths) and 81 s under a
// config of 400 globs (measured by the round-6 adversarial review). Now every comparison, every character walked and
// every form made is charged as it is done. Each case runs in a child process with a timeout, so a regression fails
// here instead of hanging the run. Round 10: the bound is held in budget units (test/confusable-budget-units.test.ts,
// these shapes among them); a wall-clock assertion here failed on CI at 7,460 ms, so these keep only the level and
// the 30-second kill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { ReviewConfig } from '../src/config/schema.js';
import { repoRoot } from './helpers.js';
const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };

/** computeLevel's wall time and level for `count` paths of one shape, under `cfg` and the money list `money`, in a child process. */
function timed(cfg: unknown, money: string, shape: 'short' | 'long', count: number): { ms: number; level: string } {
  const url = (p: string) => pathToFileURL(join(repoRoot, 'dist', 'src', p)).href;
  const script = `const { computeLevel, moneyListEntries } = await import(${JSON.stringify(url('review.js'))});
const { ReviewConfig } = await import(${JSON.stringify(url('config/schema.js'))});
const cfg = ReviewConfig.parse(${JSON.stringify(cfg)});
const files = [];
for (let i = 0; i < ${count}; i++) files.push({ path: ${shape === 'short' ? "`a/é${i.toString(36)}`" : "`docs/${'q'.repeat(450)}${'é'.repeat(450)}${i}.md`"}, added: 1, removed: 0 });
const t = performance.now();
const r = computeLevel({ files, labels: [], moneyPaths: moneyListEntries(${JSON.stringify(money)}), scope: undefined }, cfg);
console.log(JSON.stringify({ ms: performance.now() - t, level: r.level }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `the timing run didn't finish in 30 s (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout.trim()) as { ms: number; level: string };
}

test('#763 round 7: 5,000 short paths outside ASCII against 400 short globs: one computeLevel finishes, held once the budget is spent', () => {
  const globs = Array.from({ length: 400 }, (_, i) => `svc${i}/**`);
  const cfg = ReviewConfig.parse({ version: 1, categories: { crit: globs }, levels: { ...LEVELS, L3_human: { when: ['crit'], over_lines: 100_000_000 } } });
  assert.equal(timed(cfg, '', 'short', 5_000).level, 'L3');
});

test('#763 round 7: 6,000 short paths outside ASCII under the engine\'s own review.yaml: one computeLevel finishes', () => {
  const cfg = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  assert.equal(timed(cfg, '', 'short', 6_000).level, 'L3');
});

test('#763 round 7: 2,000 long paths against 200 money globs that keep the walk alive on every character: finishes, and held', () => {
  const cfg = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
  const money = Array.from({ length: 200 }, (_, j) => `**${'q'.repeat(20)}${j}**`).join('\n');
  assert.equal(timed(cfg, money, 'long', 2_000).level, 'L3');
});
