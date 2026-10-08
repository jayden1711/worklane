import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewConfig } from '../src/config/schema.js';
import type { StoredEvent } from '../src/events/types.js';
import { computeLevel } from '../src/review.js';
import { scorecard } from '../src/scorecard.js';
import { effectiveStage, health, healthyStreak, regressed, relaxedFor } from '../src/trust.js';

let id = 0;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const ev = (hours: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: new Date(T0 + hours * 3_600_000).toISOString(), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });

function doneTask(n: number, startH: number, opts: { verdict?: boolean; usd?: number } = {}): StoredEvent[] {
  return [
    ev(startH, 'issue.seen', { issue: n, title: 't', labels: [], author: 'a', owner: null, actionable: true, why: '' }),
    ev(startH + 0.1, 'issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'o' }),
    ev(startH + 0.2, 'run.finished', { issue: n, role: 'worker', reason: 'succeeded', detail: '' }),
    ev(startH + 0.3, 'check.result', { issue: n, head: 'c'.repeat(40), stage: 'verify', checks: [{ check: 'x', status: 'pass', exitCode: 0 }] }),
    ev(startH + 0.4, 'eval.verdict', { issue: n, head: 'c'.repeat(40), patch_hash: 'h', patch_correct: opts.verdict ?? true, test_correct: true, confidence: 'high', advice: '' }),
    ev(startH + 0.5, 'run.cost', { issue: n, role: 'worker', model: 'm', usd: opts.usd ?? 1, turns: 1 }),
    ev(startH + 1, 'land.result', { issue: n, outcome: 'landed', landed: (n.toString(16) + 'd'.repeat(40)).slice(0, 40), detail: '' }),
    ev(startH + 1, 'issue.released', { issue: n, instance: 'i', why: 'landed' }),
  ];
}

test('scorecard: pass rate, unverified claims, cost, lead time from the log only', () => {
  const events = [...doneTask(1, 1), ...doneTask(2, 2, { verdict: false, usd: 3 })];
  // A worker that said "done" but whose change was rejected is an unverified claim.
  events.push(ev(5, 'run.finished', { issue: 3, role: 'worker', reason: 'succeeded', detail: '' }), ev(5.1, 'change.rejected', { issue: 3, why: 'no changes committed' }));
  const c = scorecard(events, { from: new Date(T0), to: new Date(T0 + 24 * 3_600_000) });
  assert.equal(c.tasksDone, 2);
  assert.equal(c.evaluatorPassRate, 0.5);
  assert.equal(c.unverifiedClaimRate, 0.33);
  assert.equal(c.costPerDoneUsd, 2);
  assert.equal(c.readyToDoneHours, 1);
});

test('scorecard: idle hours (ready work waiting, nothing running) and hours blocked on the owner', () => {
  const events = [
    ev(0, 'coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0, active: 0, ready: 2 }),
    ev(0.1, 'coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0, active: 0, ready: 2 }), // 6 min idle
    ev(0.2, 'coordinator.tick', { instance: 'i', dispatched: 1, reconciled: 0, active: 1, ready: 1 }), // 6 min idle (state at previous tick)
    ev(0.3, 'coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0, active: 0, ready: 0 }), // busy, not idle
    ev(1, 'coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0, active: 0, ready: 0 }), // nothing to do: not idle
    ev(2, 'decision.asked', { id: 'd1', kind: 'land', issue: 1, owner: 'o', question: 'q', options: ['approve'], recommendation: 'approve', receipts: [] }),
    ev(5, 'decision.answered', { id: 'd1', by: 'o', answer: 'approve' }),
    ev(6, 'issue.blocked', { issue: 2, owner: 'o', why: 'x' }),
    ev(8, 'issue.claimed', { issue: 2, instance: 'i', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'o' }),
  ];
  const c = scorecard(events, { from: new Date(T0), to: new Date(T0 + 10 * 3_600_000) });
  assert.equal(c.idleHours, 0.2);
  assert.equal(c.decisionWaitHours, 3);
  assert.equal(c.blockedHours, 2);
});

const trust = { window_days: 7, promote_after_days: 3, min_tasks: 2, min_evaluator_pass_rate: 0.8, max_unverified_claim_rate: 0.1, max_reverts: 0, max_baseline_growth: 0 };

test('health: healthy with enough good work; a breach is a regression, too little work is not', () => {
  const now = new Date(T0 + 48 * 3_600_000);
  const good = [...doneTask(1, 1), ...doneTask(2, 2)];
  assert.equal(health(good, trust, now).healthy, true);
  const few = doneTask(1, 1);
  const h1 = health(few, trust, now);
  assert.equal(h1.healthy, false);
  assert.equal(regressed(h1), false, 'not enough tasks is not a regression');
  const bad = [...doneTask(1, 1), ...doneTask(2, 2, { verdict: false })];
  const h2 = health(bad, trust, now);
  assert.equal(regressed(h2), true);
  assert.match(h2.why.join(), /evaluator pass rate 0.5 < 0.8/);
  const reverted = health(good, trust, now, new Set([(1).toString(16) + 'd'.repeat(39)].map((x) => x.slice(0, 40))));
  assert.equal(regressed(reverted), true, 'a revert of a landed change regresses');
});

test('stages relax only what review.yaml lists for them, and never protected categories', () => {
  const review = ReviewConfig.parse({
    version: 1,
    stages: [{ stage: 2, relax: [{ category: 'app-non-money-large', to: 'L1' }] }],
    levels: {
      L0_auto: { when: ['docs-only'], max_lines: 200 },
      L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
      L2_notify: { when: ['app-non-money-large', 'dependency'] },
      L3_human: { when: ['money-path', 'migration'], over_lines: 800 },
    },
  });
  const big = { files: [{ path: 'web/page.jsx', added: 500, removed: 0 }], labels: [], moneyPaths: [] };
  assert.equal(computeLevel({ ...big, relaxed: relaxedFor(1, review) }, review).level, 'L2', 'stage 1: large UI change is L2');
  const s2 = computeLevel({ ...big, relaxed: relaxedFor(2, review) }, review);
  assert.equal(s2.level, 'L1', 'stage 2 relaxes it to L1');
  assert.ok(s2.reasons.some((r) => /relaxed to L1 by trust stage/.test(r)));
  const money = { files: [{ path: 'server/escrow/a.js', added: 5, removed: 0 }], labels: [], moneyPaths: [/^server\/escrow\//] };
  assert.equal(computeLevel({ ...money, relaxed: { 'money-path': 'L0' } }, review).level, 'L3', 'money path stays L3 whatever a stage says');
  assert.throws(() => ReviewConfig.parse({ ...review, stages: [{ stage: 2, relax: [{ category: 'money-path', to: 'L1' }] }] }), /can never be relaxed/);
});

test('stage history: effective stage follows stage.changed; the healthy streak resets on a change', () => {
  const evs = [ev(1, 'trust.evaluated', { day: 'd1', stage: 1, healthy: true, why: [], card: {} }), ev(2, 'trust.evaluated', { day: 'd2', stage: 1, healthy: true, why: [], card: {} })];
  assert.equal(healthyStreak(evs), 2);
  evs.push(ev(3, 'stage.changed', { from: 1, to: 2, by: 'owner', reason: 'approved' }));
  assert.equal(effectiveStage(evs, 1), 2);
  assert.equal(healthyStreak(evs), 0);
  evs.push(ev(4, 'trust.evaluated', { day: 'd3', stage: 2, healthy: false, why: ['x'], card: {} }));
  assert.equal(healthyStreak(evs), 0);
});
