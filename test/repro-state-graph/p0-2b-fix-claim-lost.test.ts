// P0 item 2b: a CI fix or conflict fix run that loses its claim still counts toward the PR's fix cap
// (today it returns before recording anything, so it is retried on every poll with no cap and no trace).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim } from '../../src/claims.js';
import { approveBoth, conflictOnMain, failing, fixer, git, openPr, resolver, skip, workerWith, type OpenPr } from './harness.js';

/** Another instance holds the issue's claim for the next hour. */
function holdClaim(t: OpenPr) {
  const lease = { instance: 'bob', run_id: 'held', issue: t.n, expires_at: new Date(Date.now() + 3600_000).toISOString(), base: git(t.f.repo, 'rev-parse', 'HEAD') };
  assert.ok(claim(lease, { repo: t.f.repo }).won, 'bob holds the claim');
}

test('CI fix run: losing the claim on every poll still ends in the cap (or a recorded start), not silent retries for ever', { skip }, async () => {
  const t = await openPr({ worker: workerWith(fixer) });
  holdClaim(t);
  t.f.backlog.setChecks(t.opened.head, failing(11));
  t.f.backlog.setJobLog(11, 'red\n');
  for (let i = 0; i < 4; i++) {
    await t.c.tick();
    await t.c.idle();
  }
  const started = t.f.log.read(0, ['ci_fix.started']).length;
  const gaveUp = t.f.log.read(0, ['ci_fix.gave_up']).length;
  assert.ok(gaveUp > 0, `after 4 polls whose fix run lost its claim (max_fixes_per_pr 2), the owner is asked; got ci_fix.started=${started}, ci_fix.gave_up=${gaveUp}, fix prompts run=${t.runner.calls.filter((r) => /CI fix run/.test(r.prompt)).length}`);
});

test('conflict fix run: losing the claim on every poll still ends in the cap, not silent retries for ever', { skip }, async () => {
  const t = await openPr({ worker: workerWith(resolver()), 'evaluator-verdict': approveBoth(true) }, { autoMerge: () => true });
  holdClaim(t);
  conflictOnMain(t);
  for (let i = 0; i < 4; i++) {
    await t.c.tick();
    await t.c.idle();
  }
  const outcomes = t.f.log.read(0, ['conflict_fix.finished']).map((e) => (e.payload as { outcome: string }).outcome);
  const started = t.f.log.read(0, ['conflict_fix.started']).length;
  assert.ok(outcomes.includes('gave_up'), `after 4 polls whose conflict fix lost its claim (max_fixes_per_pr 1), the owner is asked; got conflict_fix.started=${started}, finished outcomes=${JSON.stringify(outcomes)}`);
});
