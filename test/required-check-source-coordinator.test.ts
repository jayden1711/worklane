// #727 through the coordinator: with checks from GitHub, a required check pinned to its source and posted under its
// name by another App (or as a commit status) never makes a PR ready, never counts in the merge flow's judgement of a
// commit (main after a merge, fix-forward, the fast checks, the ruleset hold), and another App's failing run of it
// still fails it. A check nothing pins is judged by name, exactly as before. It uses only the coordinator's own
// interfaces, so it runs on the code before the change as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommitCheck } from '../src/backlog/types.js';
import { agents, coordinator, fixture, openPr, skip } from './repro-state-graph/harness.js';

const CI_APP = 1111;
const SPOOF_APP = 2222;
const ci = (app: number, conclusion = 'success'): CommitCheck => ({ name: 'ci', source: 'check_run', status: 'completed', conclusion, id: app, app });

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

test('a PR whose pinned check passes but another App\'s same-name run fails is not ready: pinning never turns a fail into a pass', { skip }, async () => {
  const t = await openPr({}, { edit: (cfg) => Object.assign(cfg.project, { required_check_sources: { ci: { app_id: CI_APP } } }) });
  Object.assign(t.f.backlog, { checkApps: async () => ({}) });
  t.f.backlog.setChecks(t.pr().headSha, [ci(SPOOF_APP, 'failure'), ci(CI_APP)]);
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['pr.ready']).length, 0, 'not ready');
  const status = t.f.log.read(0, ['pr.status']).at(-1)?.payload as { checks: { name: string; outcome: string }[] } | undefined;
  assert.deepEqual(status?.checks.map((c) => c.outcome), ['fail']);
});

test('an install with no pins (none in config.yaml, none named by GitHub) judges by name exactly as before: its PR is ready', { skip }, async () => {
  const t = await openPr();
  Object.assign(t.f.backlog, { checkApps: async () => ({}) });
  t.f.backlog.setChecks(t.pr().headSha, [ci(CI_APP)]);
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['pr.ready']).length, 1, 'ready, as on main');
});

test("the merge flow's checks of a commit keep a pinned check only from the App GitHub's ruleset requires, and a name nothing pins as it is", async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci', 'lint'];
  Object.assign(f.backlog, { checkApps: async () => ({ ci: CI_APP }) });
  const c = coordinator(f, agents());
  const sha = 'c'.repeat(40);
  const lint: CommitCheck = { name: 'lint', source: 'check_run', status: 'completed', conclusion: 'success', id: 3, app: SPOOF_APP };
  f.backlog.setChecks(sha, [ci(SPOOF_APP), lint]);
  const judged = () => (c as unknown as { headChecksOf(s: string): Promise<CommitCheck[]> }).headChecksOf(sha);
  assert.deepEqual(await judged(), [lint], 'the spoofed ci is dropped; lint, which nothing pins, is judged by name');
  f.backlog.setChecks(sha, [ci(CI_APP), lint]);
  assert.deepEqual(await judged(), [ci(CI_APP), lint]);
  f.backlog.setChecks(sha, [ci(SPOOF_APP, 'failure'), ci(CI_APP), lint]);
  assert.deepEqual(await judged(), [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'failure' }, lint], "another App's failing ci still fails it (no id: it isn't the pinned run)");
  // Owner rule: listed after the pinned pass, another App's failure still blocks (the check of main after a merge reads these).
  f.backlog.setChecks(sha, [ci(CI_APP), ci(SPOOF_APP, 'failure'), lint]);
  assert.deepEqual(await judged(), [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'failure' }, lint]);
  // Round 8, the owner's decision: an App that isn't Actions has its latest run decide, so its later run supersedes its
  // earlier cancelled or failed ones (round 6 held these, fail closed); a later failure blocks.
  const own = (id: number, conclusion: string): CommitCheck => ({ name: 'ci', source: 'check_run', status: 'completed', conclusion, id, app: CI_APP });
  f.backlog.setChecks(sha, [own(7, 'success'), own(5, 'cancelled'), own(6, 'failure'), lint]);
  assert.deepEqual(await judged(), [own(7, 'success'), lint]);
  f.backlog.setChecks(sha, [own(7, 'failure'), own(6, 'success'), lint]);
  assert.deepEqual(await judged(), [own(7, 'failure'), lint]);
});
