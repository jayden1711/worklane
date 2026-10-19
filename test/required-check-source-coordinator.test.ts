// #727 through the coordinator: with checks from GitHub, a required check posted under its name by another App (or
// as a commit status) never makes a PR ready, and never counts in the merge flow's judgement of a commit (main after
// a merge, fix-forward, the fast checks, the ruleset hold). It uses only the coordinator's own interfaces, so it runs
// on the code before the change as well, and fails there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommitCheck } from '../src/backlog/types.js';
import { agents, coordinator, fixture, openPr, skip } from './repro-state-graph/harness.js';

const CI_APP = 1111;
const SPOOF_APP = 2222;
const ci = (app: number): CommitCheck => ({ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'success', id: app, app });

test('a PR whose required check is posted by another App is never marked ready; posted by the pinned App it is', { skip }, async () => {
  const t = await openPr({}, { edit: (cfg) => Object.assign(cfg.project, { required_check_sources: { ci: { app_id: CI_APP } } }) });
  // Checks come from GitHub (GitHub's own protection names no App here).
  Object.assign(t.f.backlog, { checkApps: async () => ({}) });
  t.f.backlog.setChecks(t.pr().headSha, [ci(SPOOF_APP), { name: 'ci', source: 'status', status: 'completed', conclusion: 'success' }]);
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['pr.ready']).length, 0, 'not ready on a spoofed check');
  const status = t.f.log.read(0, ['pr.status']).at(-1)?.payload as { checks: { name: string; outcome: string }[] } | undefined;
  assert.deepEqual(status?.checks, [{ name: 'ci', outcome: 'missing' }]);

  t.f.backlog.setChecks(t.pr().headSha, [ci(SPOOF_APP), ci(CI_APP)]);
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['pr.ready']).length, 1, 'ready once the pinned App posts it');
});

test("the merge flow's checks of a commit keep only those from the App GitHub's ruleset requires, and refuse a name nothing pins", async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci', 'lint'];
  Object.assign(f.backlog, { checkApps: async () => ({ ci: CI_APP }) });
  const c = coordinator(f, agents());
  const sha = 'c'.repeat(40);
  const lint: CommitCheck = { name: 'lint', source: 'check_run', status: 'completed', conclusion: 'success', id: 3, app: CI_APP };
  f.backlog.setChecks(sha, [ci(SPOOF_APP), lint]);
  const judged = () => (c as unknown as { headChecksOf(s: string): Promise<CommitCheck[]> }).headChecksOf(sha);
  assert.deepEqual(await judged(), [], 'the spoofed ci, and lint, which nothing pins');
  f.backlog.setChecks(sha, [ci(CI_APP), lint]);
  assert.deepEqual(await judged(), [ci(CI_APP)]);
});
