import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { buildReport } from '../src/reports.js';
import { STAGES, stageOf, throughput, throughputMarkdown } from '../src/throughput.js';
import { repoRoot } from './helpers.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const h = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
let id = 0;
const ev = (type: string, payload: object, ts: string): StoredEvent => ({ id: ++id, ts, type, payload, instance: 'i', source: 'coordinator' }) as unknown as StoredEvent;
const sha = 'a'.repeat(40);

/** A week: three PRs merged three ways (one recorded twice), one merged before the week; costs in every stage but gardener; waits. */
function week(): StoredEvent[] {
  return [
    // Before the week: merged, and costs that don't count.
    ev('merge.done', { issue: 1, number: 11, head: sha, sha, url: 'u', title: 't' }, h(24 * 9)),
    ev('run.cost', { issue: 1, role: 'worker', model: 'm', usd: 50, turns: 1 }, h(24 * 9)),
    // Issue 2: a worker run, then a retry; evaluated at L0; auto-merged (merge.done and pr.closed both: one merge).
    ev('review.level_set', { issue: 2, head: sha, level: 'L0', reasons: [] }, h(100)),
    ev('run.started', { issue: 2, role: 'worker', model: 'm', worktree: 'w', pid: 1, pgid: 1, attempt: 1 }, h(100)),
    ev('run.cost', { issue: 2, role: 'worker', model: 'm', usd: 2, turns: 1 }, h(99)),
    ev('run.started', { issue: 2, role: 'worker', model: 'm', worktree: 'w', pid: 1, pgid: 1, attempt: 2 }, h(98)),
    ev('run.cost', { issue: 2, role: 'worker', model: 'm', usd: 3, turns: 1 }, h(97)),
    ev('run.cost', { issue: 2, role: 'evaluator-verdict', model: 'm', usd: 1.5, turns: 1 }, h(96)),
    ev('merge.done', { issue: 2, number: 12, head: sha, sha, url: 'u', title: 't' }, h(90)),
    ev('pr.closed', { issue: 2, number: 12, merged: true }, h(90)),
    // Issue 3: planned, researched, a CI fix, evaluated; left to the owner, who merged it 10 hours later.
    ev('run.cost', { issue: 3, role: 'planner', model: 'm', usd: 0.5, turns: 1 }, h(80)),
    ev('run.cost', { issue: 3, role: 'researcher', model: 'm', usd: 0.25, turns: 1 }, h(79)),
    ev('run.cost', { issue: 3, role: 'ci-fix', model: 'm', usd: 1, turns: 1 }, h(78)),
    ev('run.cost', { issue: 3, role: 'evaluator-repro', model: 'm', usd: 0.5, turns: 1 }, h(77)),
    ev('merge.decided', { issue: 3, number: 13, head: sha, auto: false, reasons: ['touches a high-risk area'] }, h(70)),
    ev('pr.closed', { issue: 3, number: 13, merged: true }, h(60)),
    // Issue 4: landed directly.
    ev('land.result', { issue: 4, outcome: 'landed', landed: sha, detail: '' }, h(30)),
    // Chat and intake, not tied to an issue.
    ev('run.cost', { issue: null, role: 'chat', model: 'm', usd: 0.75, turns: 1 }, h(20)),
    ev('run.cost', { issue: null, role: 'intake', model: 'm', usd: 0.5, turns: 1 }, h(19)),
    // The owner was asked twice: one answered after 4 hours, one still open; a hotspot hold that ended on its own.
    ev('decision.asked', { id: 'd1', kind: 'question', issue: 3, owner: 'o', question: 'Which rounding mode?', options: [], recommendation: '', receipts: [] }, h(50)),
    ev('decision.answered', { id: 'd1', by: 'o', answer: 'half-up' }, h(46)),
    ev('decision.asked', { id: 'd2', kind: 'land', issue: 4, owner: 'o', question: 'Land?', options: [], recommendation: '', receipts: [] }, h(10)),
    ev('hotspot.held', { issue: 5, by: 2, files: ['src/totals.js'], reason: 'r' }, h(40)),
    ev('hotspot.released', { issue: 5, waited_ms: 7_200_000, files: ['src/totals.js'], started: true }, h(38)),
  ];
}

test('every role has a stage; a worker\'s later attempts and fix runs are retries', () => {
  assert.deepEqual([stageOf('worker'), stageOf('worker', 2), stageOf('evaluator-verdict'), stageOf('evaluator-repro'), stageOf('investigator'), stageOf('planner'), stageOf('researcher'), stageOf('intake'), stageOf('chat'), stageOf('ci-fix'), stageOf('conflict-fix'), stageOf('skill-eval')], ['worker', 'retries', 'evaluator', 'evaluator', 'evaluator', 'plan', 'research', 'intake', 'chat', 'retries', 'retries', 'other']);
});

test('throughput: merges per day and week, cost per merged PR by stage (gardener at zero), where PRs waited for the owner, the top three costs with a tuning each', () => {
  const t = throughput(week(), { now: NOW });
  // Merges: issues 2, 3, 4 this week (issue 2 recorded twice counts once); issue 1 was before.
  assert.equal(t.merged.total, 3);
  assert.equal(t.merged.perDay.length, 14);
  assert.equal(t.merged.perDay.reduce((s, d) => s + d.merged, 0), 4, 'the 14 days include issue 1 too');
  assert.equal(t.merged.perWeek.length, 8);
  assert.equal(t.merged.perWeek.at(-1)!.week, '2026-10-12', 'weeks start on Monday');
  // Cost: 10.0 this week over 3 merged PRs; every stage present, gardener at zero.
  assert.equal(t.cost.totalUsd, 10);
  assert.equal(t.cost.perMergedPrUsd, 3.33);
  assert.deepEqual(t.cost.byStage.map((s) => s.stage), [...STAGES]);
  const usd = Object.fromEntries(t.cost.byStage.map((s) => [s.stage, s.usd]));
  assert.deepEqual(usd, { worker: 2, evaluator: 2, plan: 0.5, research: 0.25, intake: 0.5, gardener: 0, chat: 0.75, retries: 4, other: 0 });
  assert.equal(t.cost.evaluatorOnL0Usd, 1.5, 'the verdict on issue 2, which was L0');
  // Waits: the owner's (decisions by kind, the merge left to them), longest first; the hold, not the owner's, last.
  assert.deepEqual(t.waits.map((w) => [w.kind, w.owner, w.count, w.open]), [
    ['merge', true, 1, 0],
    ['decision:land', true, 1, 1],
    ['decision:question', true, 1, 0],
    ['hotspot', false, 1, 0],
  ]);
  const merge = t.waits.find((w) => w.kind === 'merge')!;
  assert.deepEqual([merge.medianHours, merge.reasons], [10, [{ reason: 'touches a high-risk area', count: 1 }]]);
  assert.equal(t.waits.find((w) => w.kind === 'decision:land')!.medianHours, 10, 'still open: waiting until now');
  assert.deepEqual(t.waits.find((w) => w.kind === 'decision:question')!.reasons, [{ reason: 'Which rounding mode?', count: 1 }]);
  // The top three: retries (40%), then worker and evaluator (2.0 each), each with its rule's tuning.
  assert.deepEqual(t.top.map((x) => x.stage), ['retries', 'worker', 'evaluator']);
  assert.match(t.top[0]!.suggestion, /^Retries are 40% of the spend: look at why first attempts fail/);
  assert.match(t.top[1]!.suggestion, /^Worker runs cost \$0\.67 per merged PR: split size:L issues/);
  assert.match(t.top[2]!.suggestion, /^75% of evaluator spend is on L0 PRs: tiered evaluation/);
});

test('with nothing merged: no per-PR figures, costs still shown; no waits; the top costs only from what was spent', () => {
  const t = throughput([ev('run.cost', { issue: null, role: 'chat', model: 'm', usd: 1, turns: 1 }, h(1))], { now: NOW });
  assert.equal(t.merged.total, 0);
  assert.equal(t.cost.perMergedPrUsd, null);
  assert.equal(t.cost.byStage.find((s) => s.stage === 'chat')!.perMergedPrUsd, null);
  assert.deepEqual(t.waits, []);
  assert.deepEqual(t.top.map((x) => x.stage), ['chat']);
  assert.match(t.top[0]!.suggestion, /^Chat cost \$1\.00: answer from a summary/);
});

test('the report preview carries the same numbers; the report posted to GitHub never does, weekly or not', () => {
  const md = throughputMarkdown(throughput(week(), { now: NOW })).join('\n');
  assert.match(md, /Merged PRs: 3/);
  assert.match(md, /Cost per merged PR: ~\$3\.33 \(~\$10 in all\)/);
  assert.match(md, /Waited for you: merging a PR the harness left to you 1× \(median 10 h\)/);
  assert.match(md, /Cost 1: retries, ~\$4\.00 \(40%\)\. Retries are 40%/);
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  const at = { since: new Date(NOW.getTime() - 86_400_000), now: NOW, slot: '18:00' };
  // What the coordinator posts: buildReport as it calls it, without the preview's throughput option.
  for (const weekly of [true, false]) assert.doesNotMatch(buildReport(week(), cfg, { ...at, weekly }).markdown, /Throughput/, `posted, weekly: ${weekly}`);
  // The dashboard's preview asks for it.
  for (const weekly of [true, false]) assert.match(buildReport(week(), cfg, { ...at, weekly, throughput: true }).markdown, /\*\*Throughput, last 7 days\*\*[\s\S]*Merged PRs: 3/, `preview, weekly: ${weekly}`);
});
