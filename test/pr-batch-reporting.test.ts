// PR batches in the reports: the projection's batches, the Board's Landing column and cards, the digest, and what a
// viewer sees of them (their status only, src/viewer-events.ts).
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardForViewer, boardView } from '../src/board.js';
import { batchSummaries } from '../src/coordinator/pr-batch.js';
import { digestMarkdown, waitingOnYou } from '../src/digest.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { project } from '../src/projection.js';
import { forViewer, stateForViewer, viewerActivity } from '../src/viewer-events.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const run = (ok: boolean) => ({ id: 'run-1', ok, tiers: [{ tier: 'unit', ok, durationMs: 10, summary: ok ? 'ok' : '2 failing: totals.test.js', logRef: 'log://secret-path/1' }] });

/** #11 and #12 batched: red, bisected (#11 passed in its prefix, #12 the culprit); #13 in a batch being tested now. */
function seed() {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'pbr-')), 'events.db'));
  const step = (p: Partial<EventPayload<'pr_batch.step'>> & Pick<EventPayload<'pr_batch.step'>, 'id' | 'step' | 'prs'>) =>
    log.append('pr_batch.step', { sha: null, base: null, parent: null, tier: null, run: null, detail: '', ...p }, 'c');
  for (const [issue, number, head] of [[1, 11, B], [2, 12, C], [3, 13, D]] as const) {
    log.append('issue.seen', { issue, title: `Task ${issue}`, labels: [], author: 'example-owner', owner: null, actionable: true, why: 'ok' }, 'c');
    log.append('issue.claimed', { issue, instance: 'a', lease: A, base: A, owner: 'example-owner' }, 'c');
    log.append('land.result', { issue, outcome: 'pr_opened', landed: null, detail: '' }, 'c');
    log.append('pr.opened', { issue, number, url: `https://example.test/pr/${number}`, head, draft: false }, 'c');
    log.append('pr.ready', { issue, number, head }, 'c');
    log.append('pr_batch.queued', { issue, number, head }, 'c');
  }
  const p11 = { issue: 1, number: 11, head: B };
  const p12 = { issue: 2, number: 12, head: C };
  const p13 = { issue: 3, number: 13, head: D };
  step({ id: 'batch-1', step: 'built', prs: [p11, p12], sha: A, base: A });
  step({ id: 'batch-1', step: 'red', prs: [p11, p12], sha: A, base: A, run: run(false), tier: 'unit' });
  step({ id: 'batch-2', step: 'built', prs: [p11], sha: A, base: A, parent: 'batch-1' });
  step({ id: 'batch-2', step: 'green', prs: [p11], sha: A, base: A, parent: 'batch-1', run: run(true) });
  step({ id: 'batch-2', step: 'finished', prs: [p11], parent: 'batch-1' });
  step({ id: 'batch-2', step: 'checks_posted', prs: [p11], sha: A });
  step({ id: 'batch-1', step: 'culprit', prs: [p12], tier: 'unit', run: run(false), detail: 'unit: 2 failing: totals.test.js' });
  step({ id: 'batch-1', step: 'finished', prs: [p11, p12] });
  step({ id: 'batch-3', step: 'built', prs: [p13], sha: A, base: A });
  return log;
}

test('summaries: one per batch the queue started, its bisection folded in, with what came of each PR', () => {
  const s = batchSummaries(seed().read());
  assert.deepEqual(
    s.map((b) => [b.id, b.status, b.prs.map((p) => p.number), b.passed, b.culprits]),
    [
      ['batch-1', 'red', [11, 12], [11], [{ number: 12, tier: 'unit' }]],
      ['batch-3', 'testing', [13], [], []],
    ],
  );
  assert.equal(s[0]!.detail, 'passed #11; returned #12 (unit failed)');
});

test("the projection's batches: PR batches beside direct landing's, newest first, with their status", () => {
  const p = project(seed().read());
  assert.deepEqual(
    p.batches.map((b) => [b.id, b.kind, b.outcome, b.prs, b.issues]),
    [
      ['batch-3', 'pr', 'testing', [13], [3]],
      ['batch-1', 'pr', 'red', [11, 12], [1, 2]],
    ],
  );
});

test("the Board's Landing column: the running batch first, then the last ones; each card says where its PR stands", () => {
  const events = seed().read();
  const b = boardView({ events, instance: 'a', role: 'owner', canReadDigest: true, live: [], slots: { cap: 2, running: 0 }, now: new Date() });
  assert.deepEqual(
    b.batches.map((x) => [x.id, x.status, x.prs]),
    [
      ['batch-3', 'testing', [13]],
      ['batch-1', 'red', [11, 12]],
    ],
  );
  assert.equal(b.batches[1]!.detail, 'passed #11; returned #12 (unit failed)');
  const card = (n: number) => b.cards.find((c) => c.issue === n)?.batch;
  assert.deepEqual(card(1), { status: 'passed', id: 'batch-2' });
  assert.deepEqual(card(2), { status: 'returned', id: 'batch-1' });
  assert.deepEqual(card(3), { status: 'testing', id: 'batch-3' });

  // A viewer: the status and the PRs only, never what happened in the batch.
  const v = boardForViewer(b) as { batches: Record<string, unknown>[]; cards: Record<string, unknown>[] };
  assert.deepEqual(v.batches[1], { id: 'batch-1', status: 'red', prs: [11, 12], issues: [1, 2], at: b.batches[1]!.at });
  assert.ok(!JSON.stringify(v.batches).includes('returned'));
  assert.deepEqual(v.cards.find((c) => c.issue === 2)!.batch, { status: 'returned', id: 'batch-1' });
});

test('the digest lists the PR batches since the last one, with their status and what came of them', () => {
  // Seeded first: `now` after every seeded event, however slow the machine.
  const events = seed().read();
  const now = new Date(Math.max(...events.map((e) => Date.parse(e.ts))) + 1000);
  const d = waitingOnYou(events, now, { since: new Date(now.getTime() - 3600_000), updates: [] });
  assert.deepEqual(d.batches.map((b) => [b.id, b.status]), [['batch-1', 'red'], ['batch-3', 'testing']]);
  const md = digestMarkdown(d);
  assert.match(md, /\*\*PR batches since yesterday\*\* \(2\)\n- batch-1 red: #11, #12; passed #11; returned #12 \(unit failed\)\n- batch-3 testing: #13\n/);
  // None: no section (a digest without batching reads as before).
  const quiet = waitingOnYou(events, new Date(now.getTime() + 7 * 86_400_000), { since: new Date(now.getTime() + 6 * 86_400_000), updates: [] });
  assert.deepEqual(quiet.batches.map((b) => b.id), ['batch-3'], 'a batch still running is listed until it ends');
});

test('viewers: a PR batch step is its id and step only; the state keeps a batch without its detail or commit', () => {
  const events = seed().read();
  const red = events.find((e) => e.type === 'pr_batch.step' && (e.payload as { step: string }).step === 'culprit')!;
  assert.deepEqual(forViewer(red)!.payload, { id: 'batch-1', step: 'culprit' });
  const queued = events.find((e) => e.type === 'pr_batch.queued')!;
  assert.deepEqual(forViewer(queued)!.payload, { issue: 1, number: 11 });
  const activity = viewerActivity(events).find((a) => a.type === 'pr_batch.step' && a.summary.includes('culprit'))!;
  assert.equal(activity.summary, 'batch-1 culprit');
  const st = stateForViewer({ batches: project(events).batches });
  assert.deepEqual(Object.keys((st.batches as Record<string, unknown>[])[1]!).sort(), ['at', 'id', 'issues', 'kind', 'outcome', 'prs']);
  assert.ok(!JSON.stringify(st).includes('secret-path') && !JSON.stringify(st).includes('totals.test.js'));
});

test('summaries: PRs a green batch could not merge because main moved say so', () => {
  const log = seed();
  const p13 = { issue: 3, number: 13, head: D };
  const step = (step: EventPayload<'pr_batch.step'>['step'], o: Partial<EventPayload<'pr_batch.step'>> = {}) =>
    log.append('pr_batch.step', { id: 'batch-3', step, prs: [p13], sha: null, base: null, parent: null, tier: null, run: null, detail: '', ...o }, 'c');
  step('green', { sha: A, base: A, run: run(true) });
  step('checks_posted', { sha: A });
  step('finished');
  step('stale', { detail: 'main moved' });
  const s = batchSummaries(log.read()).find((b) => b.id === 'batch-3')!;
  assert.equal(s.detail, 'passed #13; main moved before #13 merged: tested again');
});
