// #469 follow-up (owner): under No CI, every test_run tier (fast and full) runs on each merge commit on main through
// the test-run service, and main is judged by those results, read only from the event log as on PRs. The post-merge
// check never records main green with nothing checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { EventPayload } from '../src/events/types.js';
import type { TestRunRequest, TestRunResult, TestRuns } from '../src/coordinator/pr-batch.js';
import { FakeRunner } from '../src/runner.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { coordinator, fixture } from './repro-state-graph/harness.js';

const SHA = 'c'.repeat(40);
const tiers = TestRunConfig.parse({ tiers: [{ name: 'unit', command: 'npm test', kind: 'fast' }, { name: 'suite', command: 'npm run all', kind: 'full' }] });

/** The test-run service, standing in: it records each request, and records the run in the log as the real one does. */
function service(f: ReturnType<typeof fixture>, ok: (tier: string) => boolean) {
  const asked: TestRunRequest[] = [];
  let n = 0;
  const t: TestRuns = {
    async startTestRun(req) {
      asked.push(req);
      const id = `main-${++n}`;
      const names = req.tiers ?? [];
      f.log.append('testrun.queued', { id, sha: req.sha, kind: req.kind, prs: req.prs, shard: null }, 'alice');
      const results = names.map((tier) => ({ tier, ok: ok(tier) }));
      f.log.append('testrun.finished', { id, sha: req.sha, kind: req.kind, prs: req.prs, ok: results.every((r) => r.ok), outcome: 'done', results, detail: '' }, 'alice');
      return { id, sha: req.sha, kind: req.kind, ok: results.every((r) => r.ok), outcome: 'done', tiers: results.map((r) => ({ ...r, durationMs: 1, summary: '', logRef: '' })) } as TestRunResult;
    },
    postChecks: async () => {},
    checkNames: () => ({}),
  };
  return { t, asked };
}

function world(o: { ci: 'none' | 'github'; ok?: (tier: string) => boolean; wired?: boolean; required?: string[] }) {
  const f = fixture();
  mkdirSync(f.stateDir, { recursive: true });
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.ci = o.ci;
  f.cfg.project.required_checks = o.required ?? [];
  f.cfg.project.flaky.rerun = false;
  f.cfg.tests.test_run = tiers;
  const s = service(f, o.ok ?? (() => true));
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0, ...(o.wired === false ? {} : { testRuns: s.t }) });
  f.log.append('merge.done', { issue: 1, number: 7, head: 'd'.repeat(40), sha: SHA, url: 'https://github.com/example-org/example-shop/pull/7', title: 'a change' }, 'alice');
  const watch = async () => {
    await (c as unknown as { watchMerges(): Promise<void> }).watchMerges();
    await new Promise((r) => setImmediate(r));
  };
  const results = () => f.log.read(0, ['merge.main_result']).map((e) => e.payload as EventPayload<'merge.main_result'>);
  return { f, c, s, watch, results };
}

test('No CI: a merge commit gets every test_run tier, fast and full, run on it; main is green only once they passed there', async () => {
  const w = world({ ci: 'none' });
  await w.watch();
  assert.deepEqual(w.s.asked.map((r) => [r.sha, r.kind, r.tiers]), [[SHA, 'full', ['unit', 'suite']]], 'one run of every tier, on exactly the merge commit');
  await w.watch();
  assert.deepEqual(w.results().map((r) => [r.sha, r.outcome, r.failed]), [[SHA, 'green', []]]);
  await w.watch();
  assert.equal(w.s.asked.length, 1, 'run once per merge commit');
});

test('No CI: a tier failing on the merge commit turns main red, naming its check', async () => {
  const w = world({ ci: 'none', ok: (t) => t !== 'suite' });
  // What a red main then sets off (fix-forward: coordinator/fix-forward.ts) is its own tests'; here only the verdict.
  const red: string[][] = [];
  (w.c as unknown as { mainWentRed: (m: unknown, failed: string[]) => Promise<void> }).mainWentRed = async (_m, failed) => void red.push(failed);
  await w.watch();
  await w.watch();
  assert.deepEqual(w.results().map((r) => [r.outcome, r.failed]), [['red', ['test-run/suite']]]);
  assert.deepEqual(red, [['test-run/suite']], 'handed on as a red main');
});

test('No CI with the test runs off: nothing runs, and main is never recorded green with nothing checked', async () => {
  const w = world({ ci: 'none', wired: false });
  for (let i = 0; i < 5; i++) await w.watch();
  assert.equal(w.s.asked.length, 0);
  assert.equal(w.results().filter((r) => r.outcome === 'green').length, 0);
});

test('an empty required_checks never records main green with nothing checked (ci: github, the config problem case)', async () => {
  const w = world({ ci: 'github' });
  for (let i = 0; i < 3; i++) await w.watch();
  assert.deepEqual(w.results(), [], 'no result at all: nothing to judge by');
  assert.equal(w.s.asked.length, 0, 'GitHub CI mode starts no test runs on main');
});

test("No CI: fix-forward judges main's commits the same way: every tier's check, from the event log, never GitHub's of the same name", async () => {
  const w = world({ ci: 'none', ok: (t) => t !== 'suite' });
  (w.c as unknown as { mainWentRed: () => Promise<void> }).mainWentRed = async () => {};
  await w.watch();
  const ff = (w.c as unknown as { fixForward: { d: { required(): string[]; checks?(sha: string): Promise<{ name: string; conclusion: string | null }[]> } } }).fixForward;
  assert.deepEqual(ff.d.required(), ['test-run/unit', 'test-run/suite']);
  const checks = await ff.d.checks!(SHA);
  assert.deepEqual(checks.map((c) => [c.name, c.conclusion]), [['test-run/unit', 'success'], ['test-run/suite', 'failure']]);
});
