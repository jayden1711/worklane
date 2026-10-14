import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { buildModel, modelRouting } from '../src/model-routing.js';
import { judge, mad, median, optimizeDue, OptimizeConfig, pickTarget, readMetric, sample, slowestTests, targetByKey, targets } from '../src/optimize.js';
import { repoRoot } from './helpers.js';

test('median and MAD', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(mad([100, 102, 98, 101, 99]), 1);
  assert.equal(mad([1, 1, 1, 50]), 0, 'one outlier does not move it');
});

test('the rule: better than the baseline by more than 2 x the larger MAD (and 1% of the median)', () => {
  const base = sample([100, 102, 98, 101, 99]);
  assert.equal(judge(base, sample([50, 52, 48, 51, 49]), true).improved, true);
  assert.match(judge(base, sample([100, 102, 98, 101, 99]), true).why, /^no improvement/);
  assert.match(judge(base, sample([105, 107, 103, 106, 104]), true).why, /^no improvement: .*worse/);
  assert.match(judge(base, sample([99, 101, 97, 100, 98]), true).why, /^within the noise/);
  // A wide spread on either side widens the noise.
  assert.equal(judge(base, sample([90, 70, 110, 95, 85]), true).improved, false);
  // A jitter-free benchmark still needs 1%.
  assert.equal(judge(sample([100, 100, 100]), sample([99.5, 99.5, 99.5]), true).improved, false);
  assert.equal(judge(sample([100, 100, 100]), sample([98, 98, 98]), true).improved, true);
  // Higher is better (throughput).
  assert.equal(judge(sample([100, 101, 99]), sample([150, 151, 149]), false).improved, true);
  assert.equal(judge(sample([100, 101, 99]), sample([150, 151, 149]), true).improved, false);
});

test("a run's number: its wall time, or the last match of the pattern", () => {
  assert.equal(readMetric('wall_ms', 'whatever', 1234), 1234);
  const m = { pattern: 'took ([0-9.]+) ms', unit: 'ms' };
  assert.equal(readMetric(m, 'took 5 ms\ntook 7.5 ms\n', 1), 7.5);
  assert.equal(readMetric(m, 'nothing here', 1), null);
});

test('targets: config order, else every benchmark then the slowest test; the least recently tried first', () => {
  const benches = { version: 1 as const, benchmarks: [{ name: 'a', command: 'run a', repeats: 5, metric: 'wall_ms' as const, lower_is_better: true }, { name: 'b', command: 'run b', repeats: 7, metric: { pattern: '(\\d+)', unit: 'ops' }, lower_is_better: false }] };
  const o = OptimizeConfig.parse({ slow_test_command: 'node --test --test-name-pattern {name}' });
  const slow = [{ name: "cart > totals 'big' cart", ms: 900 }];
  const all = targets(o, benches, slow);
  assert.deepEqual(all.map((t) => t.key), ['bench:a', 'bench:b', "test:cart > totals 'big' cart"]);
  assert.equal(all[2]!.command, 'node --test --test-name-pattern cart...totals..big..cart', 'safe unquoted in any shell');
  assert.deepEqual(targets(OptimizeConfig.parse({ targets: ['b'] }), benches, slow).map((t) => t.key), ['bench:b']);
  assert.deepEqual(targets(OptimizeConfig.parse({}), benches, slow).map((t) => t.key), ['bench:a', 'bench:b'], 'no slow_test_command: benchmarks only');
  const tried: Record<string, number> = { 'bench:a': 10, 'bench:b': 5 };
  assert.equal(pickTarget(all, (k) => tried[k] ?? null)!.key, "test:cart > totals 'big' cart", 'never tried first');
  tried["test:cart > totals 'big' cart"] = 20;
  assert.equal(pickTarget(all, (k) => tried[k] ?? null)!.key, 'bench:b', 'then the one tried longest ago');
  assert.equal(targetByKey('bench:b', o, benches)!.repeats, 7);
  assert.equal(targetByKey('bench:gone', o, benches), null);
});

test("the slowest tests: item 27's recorded durations over the last week, by median", () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ev = (type: string, ts: string, tests: { name: string; ms: number }[]) => ({ type, ts, payload: { tests } });
  const events = [
    ev('testrun.durations', '2026-10-11T00:00:00Z', [{ name: 'a', ms: 100 }, { name: 'b', ms: 300 }]),
    ev('ci.test_durations', '2026-10-12T00:00:00Z', [{ name: 'a', ms: 900 }, { name: 'a', ms: 950 }]),
    ev('testrun.durations', '2026-09-01T00:00:00Z', [{ name: 'old', ms: 99_999 }]),
  ];
  assert.deepEqual(slowestTests(events, now), [{ name: 'a', ms: 900 }, { name: 'b', ms: 300 }]);
});

test('due once a week, on its weekday after its time', () => {
  const o = { weekday: 1, at: '02:00' };
  const mon = new Date(2026, 9, 12, 3, 0);
  assert.equal(mon.getDay(), 1);
  assert.equal(optimizeDue(mon, null, o), true);
  assert.equal(optimizeDue(new Date(2026, 9, 12, 1, 0), null, o), false, 'before its time');
  assert.equal(optimizeDue(new Date(2026, 9, 13, 3, 0), null, o), false, 'another day');
  assert.equal(optimizeDue(mon, new Date(2026, 9, 12, 2, 30).toISOString(), o), false, 'already ran today');
  assert.equal(optimizeDue(mon, new Date(2026, 9, 5, 2, 30).toISOString(), o), true, 'last week');
});

test('an optimization task builds on the strongest model the routing names', () => {
  const r = modelRouting({ roles: { workers: { enabled: true, model: 'sonnet', hard_issues_model: 'opus' } } });
  assert.equal(buildModel(r, ['optimize']).model, 'opus');
  assert.equal(buildModel(r, []).model, 'sonnet');
});

function project(config: (yaml: string) => string, benchmarks: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'optimize-cfg-'));
  cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
  const p = join(dir, BRAND.configDir, 'config.yaml');
  writeFileSync(p, config(readFileSync(p, 'utf8')));
  if (benchmarks !== null) writeFileSync(join(dir, BRAND.configDir, 'benchmarks.yaml'), benchmarks);
  return dir;
}
const errorsOf = (dir: string) => {
  try {
    loadConfig(dir);
    return [];
  } catch (e) {
    return (e as ConfigInvalid).errors.map((x) => `${x.file} ${x.path}: ${x.message}`);
  }
};

test('schema-validated: off by default; every target names a declared benchmark; a pattern needs a capture group', () => {
  const cfg = loadConfig(project((y) => y, null));
  assert.deepEqual([cfg.project.optimize.enabled, cfg.project.optimize.max_prs, cfg.benchmarks], [false, 1, undefined]);
  const ok = project((y) => `${y}optimize: { enabled: true, weekday: 6, budget_usd: 5, max_prs: 1, targets: [checkout] }\n`, 'version: 1\nbenchmarks:\n  - { name: checkout, command: node bench.mjs, metric: { pattern: "took (\\\\d+)" } }\n');
  assert.deepEqual(errorsOf(ok), []);
  assert.equal(loadConfig(ok).benchmarks!.benchmarks[0]!.repeats, 5);
  assert.deepEqual(errorsOf(project((y) => `${y}optimize: { targets: [nope] }\n`, null)), ['config.yaml optimize.targets.0: no benchmark named nope in benchmarks.yaml']);
  assert.deepEqual(errorsOf(project((y) => `${y}optimize: { targets: [slowest_tests] }\n`, null)), ['config.yaml optimize.targets.0: slowest_tests needs optimize.slow_test_command']);
  assert.match(errorsOf(project((y) => `${y}optimize: { weekday: 7, budget: 3 }\n`, null)).join('\n'), /optimize\.weekday[\s\S]*budget/);
  assert.match(errorsOf(project((y) => y, 'version: 1\nbenchmarks:\n  - { name: x, command: y, metric: { pattern: "took \\\\d+" } }\n')).join('\n'), /benchmarks\.yaml benchmarks\.0\.metric/);
});
