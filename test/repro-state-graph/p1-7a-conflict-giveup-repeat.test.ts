// P1 item 7a: once the conflict fix cap is reached, the owner is asked once, not again on every move of main.
import '../isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveBoth, changeOnMain, conflictOnMain, openPr, resolver, skip, workerWith } from './harness.js';

test('conflict fix give-up: two later moves of main do not post the same give-up comment again', { skip }, async () => {
  const t = await openPr({ worker: workerWith(resolver()), 'evaluator-verdict': approveBoth(true) }, { autoMerge: () => true });
  conflictOnMain(t);
  // The one allowed conflict fix run was used (cut off by a restart): the cap (default 1) is reached.
  t.f.log.append('conflict_fix.started', { issue: t.n, number: t.opened.number, head: t.opened.head, base_sha: t.opened.head, strategy: 'merge', attempt: 1, lease: t.opened.head }, 'test');
  await t.c.recover();
  await t.c.tick();
  await t.c.idle();
  const asks = () => t.pr().comments.filter((x) => /this PR conflicts with its base/.test(x.body)).map((x) => x.body.replace(/`[0-9a-f]{8}`/g, '`<sha>`'));
  assert.equal(asks().length, 1, 'asked once at the cap');
  // Main moves twice more (unrelated files); the PR still conflicts, and nothing about the PR or the cap changed.
  for (const file of ['README.md', 'NOTES.md']) {
    changeOnMain(t, file, (s) => `${s}\nanother change on main\n`);
    await t.c.tick();
    await t.c.idle();
  }
  const all = asks();
  assert.equal(all.length, 1, `the give-up comment is posted once, not on every move of main; got ${all.length}: ${JSON.stringify([...new Set(all)])}`);
});
