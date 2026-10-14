// A failed staging deploy names its issue and releases the task, so relabelling the issue `ready` requeues it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agents, BUG, coordinator, fixture, skip } from './repro-state-graph/harness.js';

test('deploy: a failed staging deploy is recorded against its issue, and relabelling the issue ready requeues it', { skip }, async () => {
  const f = fixture();
  // The trigger fails at once: no waiting on the verify polls.
  f.cfg.deploy = { version: 1, environments: [{ name: 'staging', trigger: 'node -e "process.exit(1)"', verify: 'git ls-remote origin refs/heads/main', production: false }] };
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = coordinator(f, agents());
  await c.tick();
  await c.idle();
  await c.tick(); // lands, the deploy trigger fails
  const failed = f.log.read(0, ['deploy.failed']).at(-1)?.payload as { issue?: number } | undefined;
  assert.equal(failed?.issue, n, 'deploy.failed names the issue');
  assert.ok((await f.backlog.get(n)).labels.includes('blocked'), 'blocked, not closed');
  assert.equal((await f.backlog.get(n)).state, 'open');
  assert.ok((c as unknown as { isTerminal(n: number): boolean }).isTerminal(n), 'the task is terminal');
  const claims = () => f.log.read(0, ['issue.claimed']).filter((e) => (e.payload as { issue: number }).issue === n).length;
  const before = claims();
  await f.backlog.removeLabel(n, 'blocked');
  await f.backlog.addLabels(n, ['ready']);
  await c.tick();
  await c.idle();
  // (What the requeued task then does is beside the point: the fake agents have already landed their change.)
  assert.equal(claims(), before + 1, 'relabelled ready, the task is claimed again');
});
