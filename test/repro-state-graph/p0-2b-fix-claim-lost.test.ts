// P0 item 2b: a CI fix or conflict fix run that loses its claim must not retry silently for ever, nor give up on a
// brief collision. It records claim_lost once per PR head, doesn't count it toward the fix cap, and gives up only
// once the claim has been held elsewhere for an hour.
import '../isolate.js';
import { test, type MockTimers } from 'node:test';
import assert from 'node:assert/strict';
import { claim, release } from '../../src/claims.js';
import { approveBoth, conflictOnMain, failing, fixer, git, openPr, resolver, skip, workerWith, type OpenPr } from './harness.js';

/** Another instance holds the issue's claim (for 3 hours); returns a release. */
function holdClaim(t: OpenPr) {
  const lease = { instance: 'bob', run_id: 'held', issue: t.n, expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(), base: git(t.f.repo, 'rev-parse', 'HEAD') };
  const won = claim(lease, { repo: t.f.repo });
  assert.ok(won.won, 'bob holds the claim');
  return () => assert.ok(release(t.n, won.sha, { repo: t.f.repo }), 'bob releases the claim');
}

async function polls(t: OpenPr, count: number) {
  for (let i = 0; i < count; i++) {
    await t.c.tick();
    await t.c.idle();
  }
}

/** Polls with the clock (Date only; timers stay real) moved `ms` ahead. */
async function pollsLater(t: OpenPr, mock: MockTimers, ms: number, count: number) {
  mock.enable({ apis: ['Date'], now: Date.now() + ms });
  try {
    await polls(t, count);
  } finally {
    mock.reset();
  }
}

const outcomesOf = (t: OpenPr, type: 'ci_fix.finished' | 'conflict_fix.finished') => t.f.log.read(0, [type]).map((e) => (e.payload as { outcome: string }).outcome);

async function failingCi() {
  const t = await openPr({ worker: workerWith(fixer) });
  const free = holdClaim(t);
  t.f.backlog.setChecks(t.opened.head, failing(11));
  t.f.backlog.setJobLog(11, 'red\n');
  return { t, free };
}

test('CI fix run: a collision for a few polls, then a free claim: the fix runs and is not given up', { skip }, async () => {
  const { t, free } = await failingCi();
  await polls(t, 4);
  assert.equal(t.f.log.read(0, ['ci_fix.gave_up']).length, 0, 'not given up on a brief collision');
  free();
  await polls(t, 1);
  assert.equal(t.f.log.read(0, ['ci_fix.started']).length, 1, 'the fix runs once the claim is free');
  assert.equal(t.f.log.read(0, ['ci_fix.gave_up']).length, 0, 'and is not given up');
});

test('CI fix run: many polls on one head record one claim_lost', { skip }, async () => {
  const { t } = await failingCi();
  await polls(t, 6);
  assert.deepEqual(outcomesOf(t, 'ci_fix.finished'), ['claim_lost']);
});

test('CI fix run: a claim held elsewhere for over an hour gives up once', { skip }, async (tt) => {
  const { t } = await failingCi();
  await polls(t, 4);
  assert.equal(t.f.log.read(0, ['ci_fix.gave_up']).length, 0, 'not within the hour');
  await pollsLater(t, tt.mock.timers, 61 * 60_000, 4);
  assert.equal(t.f.log.read(0, ['ci_fix.gave_up']).length, 1, 'one give-up after an hour held elsewhere');
  assert.equal(t.f.log.read(0, ['ci_fix.started']).length, 0);
});

test('conflict fix run: one claim_lost per head, no give-up within the hour, one give-up after it', { skip }, async (tt) => {
  const t = await openPr({ worker: workerWith(resolver()), 'evaluator-verdict': approveBoth(true) }, { autoMerge: () => true });
  holdClaim(t);
  conflictOnMain(t);
  await polls(t, 5);
  assert.deepEqual(outcomesOf(t, 'conflict_fix.finished'), ['claim_lost'], 'one claim_lost, no give-up on a brief collision');
  await pollsLater(t, tt.mock.timers, 61 * 60_000, 4);
  assert.deepEqual(outcomesOf(t, 'conflict_fix.finished'), ['claim_lost', 'gave_up'], 'one give-up after an hour held elsewhere');
  assert.equal(t.f.log.read(0, ['conflict_fix.started']).length, 0);
});
