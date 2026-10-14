// P0 item 3b: a landing that ends in error or rejected leaves a comment on the issue, an event, and the claim released.
import '../isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimRef } from '../../src/claims.js';
import { agents, BUG, coordinator, fixture, git, skip, type Fixture } from './harness.js';

/** Build the task until it is queued for landing, without landing it. */
async function queued() {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = coordinator(f, agents());
  (c as unknown as { landing: boolean }).landing = true;
  await c.tick();
  await c.idle();
  (c as unknown as { landing: boolean }).landing = false;
  assert.equal(f.log.read(0, ['land.queued']).length, 1);
  return { f, n, c };
}

async function assertHandled(f: Fixture, n: number, outcome: string) {
  const r = f.log.read(0, ['land.result']).at(-1)?.payload as { outcome: string; detail: string } | undefined;
  assert.equal(r?.outcome, outcome, `land.result ${outcome} (got ${JSON.stringify(r)})`);
  const after = (await f.backlog.comments(n)).map((x) => x.body).filter((b) => /land/i.test(b) && !/Claimed by/.test(b));
  const released = f.log.read(0, ['issue.released', 'issue.blocked']).some((e) => (e.payload as { issue: number }).issue === n);
  const claimHeld = git(f.repo, 'ls-remote', 'origin', claimRef(n)) !== '';
  assert.ok(after.length > 0 && released && !claimHeld, `a land ${outcome} is told on the issue and its claim released; got landing comments=${after.length}, issue.blocked/released=${released}, claim ref still held=${claimHeld}`);
}

test('land error: a failing pre-land step is reported on the issue and the claim released', { skip }, async () => {
  const { f, n, c } = await queued();
  f.cfg.tests.land.pre = ['node -e "process.exit(3)"'];
  await c.tick();
  await assertHandled(f, n, 'error');
});

test('land error: a land worktree whose setup fails is reported on the issue and the claim released', { skip }, async () => {
  const { f, n, c } = await queued();
  // The coordinator holds this array: a setup step added now fails only the land worktree's setup.
  f.cfg.tests.worktree.setup.push('node -e "process.exit(4)"');
  await c.tick();
  await assertHandled(f, n, 'error');
});

test('land rejected: a secret found by the scan at landing is reported on the issue and the claim released', { skip }, async () => {
  const { f, n, c } = await queued();
  // A pre-land step that writes a credential-shaped string (the push-gate test's sample), committed by the coordinator.
  const script = join(f.base, 'write-key.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync('config.js', 'const key = "AKIA${'Z'.repeat(4)}Q7W2E9R4T6Y8";\\nconst secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";\\n');\n`);
  f.cfg.tests.land.pre = [`node "${script}"`];
  await c.tick();
  await assertHandled(f, n, 'rejected');
});
