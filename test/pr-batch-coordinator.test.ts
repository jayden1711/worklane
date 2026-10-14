// PR-mode batching wired into the coordinator's PR watch and merge policy: a PR ready on its fast check is batched,
// merges only after its batch passes (both checks on its head), and a high-risk one still waits for the owner.
import { addStartGate, clearStartGates, passGate } from '../src/testrun/gate.js';
import { GATE_MODES, guardGate } from './gate-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventPayload } from '../src/events/types.js';
import type { TestRuns, TestRunRequest } from '../src/coordinator/pr-batch.js';
import type { PrTestRuns } from '../src/coordinator/test-runs.js';
import { approve, changeOnMain, lastOf, openPr, passing, skip, type Fixture, type OpenPr } from './repro-state-graph/harness.js';

const full = { name: 'full', source: 'check_run' as const, status: 'completed', conclusion: 'success', id: 2 };

/** A test-run service whose full runs pass (or not) and whose checks land on the PR's head as GitHub would show them. */
function service(ok = true, o: { holdFirst?: boolean; gated?: boolean } = {}) {
  const runs: TestRunRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let backlog: Fixture['backlog'] | null = null;
  const t: TestRuns = {
    async startTestRun(req, opts) {
      // WHY: gated, the run goes through the start gate first, as runTestRun (the only start of a run) does.
      if (o.gated) passGate();
      runs.push(req);
      signals.push(opts?.signal);
      // The first run waits (a slot, the lock, its tiers) until it is cancelled, as src/testrun/ reports a cancel.
      if (o.holdFirst && runs.length === 1) {
        return new Promise((resolve) =>
          opts?.signal?.addEventListener('abort', () => resolve({ id: 'run-1', sha: req.sha, kind: 'full', ok: false, tiers: [{ tier: 'unit', ok: false, durationMs: 0, summary: 'cancelled', logRef: '' }] })),
        );
      }
      const pass = ok || req.prs.length === 0; // the base alone is green
      return { id: `run-${runs.length}`, sha: req.sha, kind: 'full', ok: pass, tiers: [{ tier: 'unit', ok: pass, durationMs: 1, summary: pass ? 'ok' : '3 failing', logRef: 'log://1' }] };
    },
    async postChecks(sha) {
      backlog!.setChecks(sha, [...(await backlog!.checks(sha)), full]);
    },
    checkNames: () => ({ unit: 'full' }),
  };
  return { t, runs, signals, bind: (b: Fixture['backlog']) => (backlog = b) };
}

function batching(cfg: Fixture['cfg'], edit?: (cfg: Fixture['cfg']) => void) {
  cfg.project.required_checks = ['ci', 'full'];
  cfg.tests.land.pr_batch = { enabled: true, max: 8, shards: 1, fast_checks: ['ci'], full_checks: ['full'] };
  edit?.(cfg);
}

async function batched(o: { ok?: boolean; wired?: boolean; edit?: (cfg: Fixture['cfg']) => void; holdFirst?: boolean; prTestRuns?: PrTestRuns; gated?: boolean } = {}) {
  const s = service(o.ok ?? true, { holdFirst: o.holdFirst ?? false, gated: o.gated ?? false });
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true, edit: (cfg) => batching(cfg, o.edit), deps: o.wired === false ? {} : { testRuns: s.t, ...(o.prTestRuns ? { prTestRuns: o.prTestRuns } : {}) } });
  s.bind(t.f.backlog);
  return { t, s };
}

/** The fast check green on the head, then passes until things settle (a batch runs in the background). */
async function fastGreen(t: OpenPr, passes = 3) {
  t.f.backlog.setChecks(t.pr().headSha, passing);
  for (let i = 0; i < passes; i++) {
    await t.c.tick();
    await t.c.idle();
  }
}

test('batching: a PR ready on its fast check is batched, gets the full check on its head, then auto-merges', { skip }, async () => {
  const { t, s } = await batched();
  await fastGreen(t);
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0]!.kind, 'full');
  assert.deepEqual(s.runs[0]!.prs, [t.opened.number]);
  assert.ok((await t.f.backlog.checks(t.opened.head)).some((c) => c.name === 'full'), 'the full check is on the PR head');
  assert.ok(t.pr().merged, 'merged after its batch passed');
  const done = lastOf(t.f.log, 'merge.done') as EventPayload<'merge.done'>;
  assert.equal(done.head, t.opened.head);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 1);
});

test('batching: without the test-run service nothing merges, however green the fast check', { skip }, async () => {
  const { t } = await batched({ wired: false });
  await fastGreen(t, 4);
  assert.ok(!t.pr().merged);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 0);
  assert.equal(t.f.log.read(0, ['pr_batch.queued']).length, 1, 'queued, waiting');
});

test('batching: while the test sandbox\'s check is failing no batch runs and nothing merges; when it passes, the same coordinator batches and merges', { skip }, async () => {
  // WHY: the service is wired even while the sandbox's check fails (the PRs' "test runs are off" checks go through
  // it), so a batch must wait on the check itself: a refused run is no verdict, and must not be asked for at all.
  const sandbox = { ok: false };
  const prTestRuns = { tick: async () => ({ started: [], cancelled: [] }), idle: async () => undefined, stop: () => undefined, recover: async () => [], listing: () => [], ready: () => sandbox.ok } as unknown as PrTestRuns;
  const { t, s } = await batched({ prTestRuns });
  await fastGreen(t, 4);
  assert.equal(s.runs.length, 0, 'no run was asked of a sandbox whose check is failing');
  assert.ok(!t.pr().merged);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 0);
  assert.equal(t.f.log.read(0, ['pr_batch.queued']).length, 1, 'queued, waiting');
  sandbox.ok = true;
  await fastGreen(t);
  assert.equal(s.runs.length, 1);
  assert.ok(t.pr().merged, 'merged after its batch passed, with no restart');
});

test('batching: a red batch returns the PR with the failing tier; it never merges', { skip }, async () => {
  const { t } = await batched({ ok: false });
  await fastGreen(t);
  assert.ok(!t.pr().merged);
  assert.ok(t.pr().labels.includes('ci-failing'));
  assert.ok(t.pr().comments.some((c) => /`unit` tier failed/.test(c.body)));
  const status = t.f.log.read(0, ['pr.status']).map((e) => e.payload as EventPayload<'pr.status'>).at(-1)!;
  assert.equal(status.ready, false);
  assert.ok(status.reasons.some((r) => /returned from batch/.test(r)));
});

test('batching: nothing merges without both checks, even if the merge step is reached', { skip }, async () => {
  const { t } = await batched({ wired: false });
  t.f.backlog.setChecks(t.pr().headSha, [...passing, full]); // both checks green on GitHub, but no batch ever tested this head
  const w = t.f.log.read(0, ['pr.opened']).at(-1)!.payload as EventPayload<'pr.opened'>;
  await (t.c as unknown as { mergeOrWait(w: unknown, pr: unknown): Promise<void> }).mergeOrWait(w, await t.f.backlog.pullRequest(t.opened.number));
  assert.ok(!t.pr().merged);
  assert.match((lastOf(t.f.log, 'merge.failed') as { why: string }).why, /not merged untested: no passing full run from a batch/);
});

test('batching: a high-risk PR is batched and gets its full check, but never auto-merges: it waits for the owner', { skip }, async () => {
  const { t, s } = await batched({
    edit: (cfg) => {
      cfg.review!.categories = { ...cfg.review!.categories, pricing: ['src/price.js'] };
      cfg.review!.merge.wait_categories = ['pricing'];
    },
  });
  await fastGreen(t);
  assert.equal(s.runs.length, 1);
  assert.ok(!t.pr().merged);
  assert.ok(t.pr().labels.includes('needs-owner'));
  const d = lastOf(t.f.log, 'merge.decided') as EventPayload<'merge.decided'>;
  assert.equal(d.auto, false);
  assert.ok(d.reasons.includes('high-risk: pricing (src/price.js)'));
});

const highRisk = (cfg: Fixture['cfg']) => {
  cfg.review!.categories = { ...cfg.review!.categories, pricing: ['src/price.js'] };
  cfg.review!.merge.wait_categories = ['pricing'];
};
const approveAsOwner = (t: OpenPr) => t.f.backlog.addReview(t.opened.number, { author: 'example-owner', state: 'APPROVED', body: 'ok' });
async function settle(t: OpenPr, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await t.c.tick();
    await t.c.idle();
  }
}

test("batching: an approved high-risk PR merges on the main its batch tested; on a moved main it's tested again first", { skip }, async () => {
  // Main unchanged: the owner's approval merges it, with no second run.
  const same = await batched({ edit: highRisk });
  await fastGreen(same.t);
  assert.ok(!same.t.pr().merged && same.t.pr().labels.includes('needs-owner'));
  approveAsOwner(same.t);
  await settle(same.t, 2);
  assert.ok(same.t.pr().merged, 'merged on approval');
  assert.equal(same.s.runs.length, 1);

  // Main moved after its batch passed: approved, but tested again on the new main before it merges.
  const { t, s } = await batched({ edit: highRisk });
  await fastGreen(t);
  assert.equal(s.runs.length, 1);
  const moved = changeOnMain(t, 'NOTES.md', () => 'someone landed this by hand\n');
  approveAsOwner(t);
  await t.c.tick();
  await t.c.idle();
  assert.ok(!t.pr().merged, 'not merged onto a main its batch never tested');
  assert.ok(t.f.log.read(0, ['pr_batch.step']).some((e) => (e.payload as EventPayload<'pr_batch.step'>).step === 'stale'));
  assert.ok(t.pr().comments.some((c) => /Approved, but not merged yet: main is at/.test(c.body)));
  await settle(t);
  assert.equal(s.runs.length, 2, 'tested again');
  const built = t.f.log.read(0, ['pr_batch.step']).map((e) => e.payload as EventPayload<'pr_batch.step'>).filter((p) => p.step === 'built').at(-1)!;
  assert.equal(built.base, moved, 'on the moved main');
  assert.ok(t.pr().merged, 'then merged');
  assert.equal(t.f.log.read(0, ['merge.done']).length, 1);
});

test('batching: a commit that lands on main between a green batch and its merge sends the PR back to be tested again', { skip }, async () => {
  const { t, s } = await batched();
  t.f.backlog.setChecks(t.pr().headSha, passing);
  await t.c.tick(); // queued, and its batch runs
  await t.c.idle();
  assert.equal(s.runs.length, 1);
  assert.ok(!t.pr().merged);
  changeOnMain(t, 'NOTES.md', () => 'landed by hand\n');
  await t.c.tick();
  await t.c.idle();
  assert.ok(!t.pr().merged, 'not merged onto the moved main');
  await settle(t);
  assert.equal(s.runs.length, 2, 'tested again on the new main');
  assert.ok(t.pr().merged);
});

test("batching: a push to a PR while its batch runs cancels that run; the batch is abandoned, nobody blamed, and the new head is tested", { skip }, async () => {
  const { t, s } = await batched({ holdFirst: true });
  t.f.backlog.setChecks(t.pr().headSha, passing);
  await t.c.tick(); // queued; its batch's run starts and waits
  for (let i = 0; i < 100 && !s.runs.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.runs.length, 1);
  assert.ok(s.signals[0] && !s.signals[0].aborted);
  // A new head on the PR (a fix pushed): the PR watch sees it and the run in flight is cancelled.
  const moved = 'c'.repeat(40);
  t.f.backlog.setPr(t.opened.number, { headSha: moved });
  await t.c.tick();
  await t.c.idle();
  assert.ok(s.signals[0]!.aborted, 'cancelled');
  const steps = t.f.log.read(0, ['pr_batch.step']).map((e) => (e.payload as EventPayload<'pr_batch.step'>).step);
  assert.ok(steps.includes('abandoned') && steps.includes('dropped'), steps.join());
  assert.ok(!steps.includes('red') && !steps.includes('culprit'), 'nobody blamed');
  assert.ok(!t.pr().merged);
});

for (const mode of GATE_MODES) {
  test(`batching: held at the start gate (${mode}) no batch runs and nothing merges; once there is room the same coordinator batches and merges`, { skip }, async () => {
    const g = guardGate();
    try {
      const { t, s } = await batched({ gated: true });
      g.close(mode);
      await fastGreen(t, 4);
      assert.equal(s.runs.length, 0, 'no batch run while held');
      assert.equal(t.f.log.read(0, ['pr_batch.step']).filter((e) => (e.payload as { step: string }).step === 'abandoned').length, 0, 'no batch built only to be abandoned');
      assert.ok(!t.pr().merged);
      assert.ok(!t.pr().labels.includes('ci-failing'), 'nobody blamed');
      g.open();
      await fastGreen(t);
      assert.equal(s.runs.length, 1);
      assert.ok(t.pr().merged, 'merged after its batch passed, with no restart');
    } finally {
      g.done();
    }
  });
}

test('batching: a batch run refused at its start (the disk filled after the batch was built) is no verdict: abandoned, nobody blamed, and batched again once there is room', { skip }, async () => {
  try {
    const { t, s } = await batched({ gated: true });
    const start = s.t.startTestRun.bind(s.t);
    let first = true;
    s.t.startTestRun = async (req, opts) => {
      // WHY: open while the coordinator looked, shut by the time this run passes the gate.
      if (first) addStartGate('disk', () => 'the disk is full');
      first = false;
      return start(req, opts);
    };
    await fastGreen(t, 2);
    assert.equal(s.runs.length, 0);
    assert.ok(!t.pr().merged);
    assert.ok(!t.pr().labels.includes('ci-failing'), 'nobody blamed');
    assert.ok(t.f.log.read(0, ['pr_batch.step']).some((e) => (e.payload as { step: string; detail?: string }).step === 'abandoned' && /its run was held: the disk is full; batched again, nobody blamed/.test((e.payload as { detail?: string }).detail ?? '')), 'abandoned as held');
    assert.equal(t.f.log.read(0, ['coordinator.error']).filter((e) => (e.payload as { where: string }).where === 'pr-batch').length, 0, 'held is not an error');
    clearStartGates();
    const later = t.f.log.read(0, ['pr_batch.step']).length;
    (t.c as unknown as { prBatch: { nextTryAt: number } }).prBatch.nextTryAt = 0;
    await fastGreen(t);
    assert.ok(t.f.log.read(0, ['pr_batch.step']).length > later);
    assert.equal(s.runs.length, 1);
    assert.ok(t.pr().merged, 'merged once its batch ran');
  } finally {
    clearStartGates();
  }
});
