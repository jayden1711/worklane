import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptiveConfig, decide, evaluateCap, noteLimit, publishSignals, readCapState, type CapState, type Signals } from '../src/cap.js';
import { currentCap } from '../src/slots.js';

const cfg = AdaptiveConfig.parse({});
const T = Date.parse('2026-10-08T12:00:00Z');
const at = (min: number) => new Date(T + min * 60_000);
const iso = (min: number) => at(min).toISOString();
const verdicts = (passes: boolean[]) => passes.map((pass, k) => ({ at: iso(-100 + k), pass }));
const healthy = (over: Partial<Signals> = {}): Signals => ({ instance: 'a', at: iso(0), lastUsageLimitAt: null, prsWaiting: 0, verdicts: verdicts(Array(20).fill(true)), ...over });
const state = (cap: number, changedMin = -120): CapState => ({ cap, floor: 2, ceiling: 8, changedAt: iso(changedMin), reason: 'r', checkedAt: iso(-20), conditions: [] });

test('defaults: start 2 during the transition, floor 2, ceiling 8', () => {
  assert.equal(cfg.start, 2);
  assert.equal(cfg.floor, 2);
  assert.equal(cfg.ceiling, 8);
  assert.equal(decide(cfg, null, [], null, at(0)).cap, 2);
  // Regression: the first evaluation only records the start, even with every condition passing.
  const first = decide(cfg, null, [healthy()], 12, at(0));
  assert.equal(first.cap, 2);
  assert.equal(first.reason, 'start at 2');
});

test('raises by one only when all four conditions pass and the cooldown has passed', () => {
  const up = decide(cfg, state(3), [healthy()], 12, at(0));
  assert.equal(up.cap, 4);
  assert.match(up.reason, /^raised/);
  assert.ok(up.conditions.every((c) => c.state === 'pass'), JSON.stringify(up.conditions));
  assert.equal(decide(cfg, state(3, -30), [healthy()], 12, at(0)).cap, 3, 'changed 30 min ago: cooldown holds');
  assert.equal(decide(cfg, state(8), [healthy()], 12, at(0)).cap, 8, 'never above the ceiling');
});

const breaches: [string, Signals[], number | null, RegExp][] = [
  ['a usage limit in the last 5h', [healthy({ lastUsageLimitAt: iso(-60) })], 12, /usage limit \(hit 1\.0h ago/],
  ['free memory at 8 GB or less', [healthy()], 7.5, /free memory \(7\.5 GB available/],
  ['5 or more PRs waiting', [healthy({ prsWaiting: 3 }), healthy({ instance: 'b', prsWaiting: 2 })], 12, /PRs waiting \(5 waiting on you/],
  ['a falling evaluator pass rate', [healthy({ verdicts: verdicts([...Array(10).fill(true), ...Array(5).fill(true), ...Array(5).fill(false)]) })], 12, /evaluator pass rate \(last 10 50%, previous 10 100%/],
];
for (const [what, signals, mem, why] of breaches) {
  test(`drops by one on ${what}, with the reason, never below the floor`, () => {
    const down = decide(cfg, state(5), signals, mem, at(0));
    assert.equal(down.cap, 4);
    assert.match(down.reason, why);
    assert.equal(decide(cfg, state(2), signals, mem, at(0)).cap, 2, 'the floor holds');
  });
}

test('unknown is neither a raise nor a breach: silent instances, unmeasurable memory, too few verdicts', () => {
  for (const [signals, mem] of [
    [[healthy({ at: iso(-45) })], 12],
    [[healthy()], null],
    [[healthy({ verdicts: verdicts(Array(19).fill(true)) })], 12],
    [[healthy({ prsWaiting: null })], 12],
    [[], 12],
  ] as [Signals[], number | null][]) {
    const s = decide(cfg, state(4), signals, mem, at(0));
    assert.equal(s.cap, 4);
    assert.ok(s.conditions.some((c) => c.state === 'unknown'));
  }
  assert.equal(decide(cfg, state(4), [healthy({ at: iso(-45), lastUsageLimitAt: iso(-10) })], 12, at(0)).cap, 3, 'a known breach still drops');
});

test('evaluation: opt-in, once per interval under a lock, every change logged with its reason, read by slot taking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ max_agents: 4 }));
  assert.equal(evaluateCap(dir, 12, at(0)), null);
  assert.equal(readCapState(dir), null, 'no adaptive config: the fixed cap stays');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ max_agents: 4, adaptive: { start: 2 } }));
  publishSignals(dir, healthy({ at: iso(0) }));
  assert.equal(evaluateCap(dir, 12, at(0)), null, 'the first evaluation records the start');
  assert.equal(currentCap(dir), 2);
  publishSignals(dir, healthy({ at: iso(10) }));
  assert.equal(evaluateCap(dir, 12, at(10)), null, 'within the interval: no evaluation');
  publishSignals(dir, healthy({ at: iso(70) }));
  assert.deepEqual(evaluateCap(dir, 12, at(70)), { from: 2, to: 3, reason: 'raised: no usage limit, memory free, few PRs waiting, pass rate not falling' });
  assert.equal(currentCap(dir), 3);
  noteLimit(dir, at(80));
  publishSignals(dir, healthy({ at: iso(90) }));
  const drop = evaluateCap(dir, 12, at(90));
  assert.equal(drop?.to, 2);
  assert.match(drop!.reason, /usage limit/);
  const log = readFileSync(join(dir, 'cap-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { to: number; reason: string });
  assert.deepEqual(log.map((l) => l.to), [2, 3, 2]);
  assert.match(log[0]!.reason, /start at 2/);
});
