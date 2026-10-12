// P1 item 8a: deploy events carry no issue number, so deploy.verified never marks a task terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agents, BUG, coordinator, fixture, skip } from './harness.js';

test('deploy: a landed change verified on staging is terminal by its deploy.verified event, which names the issue', { skip }, async () => {
  const f = fixture();
  f.cfg.deploy = { version: 1, environments: [{ name: 'staging', trigger: 'node --version', verify: 'git ls-remote origin refs/heads/main', production: false }] };
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = coordinator(f, agents());
  await c.tick();
  await c.idle();
  await c.tick(); // lands, deploys to staging, verifies, closes the issue
  assert.equal((f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string }).outcome, 'landed');
  const verified = f.log.read(0, ['deploy.verified']).at(-1)?.payload as { issue?: number } | undefined;
  assert.ok(verified, 'deploy.verified recorded');
  assert.equal((await f.backlog.get(n)).state, 'closed', 'closed after the verified deploy');
  const terminal = (c as unknown as { isTerminal(n: number): boolean }).isTerminal(n);
  assert.ok(verified.issue === n && terminal, `deploy.verified names the issue and the task is terminal; got deploy.verified=${JSON.stringify(verified)}, isTerminal(#${n})=${terminal}`);
});
