// The coordinator's dependency holds ("Depends on #n") and per-task file ownership (plan files), end to end
// over a real git remote and a file backlog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import type { EventPayload } from '../src/events/types.js';
import { prsView } from '../src/projection.js';
import { waitingOnYou } from '../src/digest.js';
import { commitAll, coordinator, fixture, readAll, skip } from './repro-state-graph/harness.js';

const DONE = '\n\n```done_when\n- test: test/price.test.js\n```\n';
const PLAN = { approach: 'Add the file.', steps: ['Write it'], files: ['src/price.js'], risks: [], design_change: false, decisions: 'nothing recorded on this' };

/** Workers that each add the file their issue names; `gates` holds a worker (by that file) until opened; `order` records finishes. */
function workers(gates: Record<string, Promise<void>> = {}, order: string[] = [], plan: object = PLAN) {
  return new FakeRunner(async (req: RunRequest) => {
    if (req.role === 'planner') return { structured: plan };
    if (req.role === 'plan-reviewer') return { structured: { contradictions: [], summary: 'contradicts nothing recorded' } };
    if (req.role === 'worker') {
      const name = req.prompt.match(/Add (\w+\.js)/)![1]!;
      order.push(`start ${name}`);
      await gates[name];
      writeFileSync(join(req.cwd, 'src', name), `export const x = '${name}';\n`);
      commitAll(req.cwd, `add ${name}`);
      order.push(`end ${name}`);
      return { structured: { summary: 's' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
  });
}

const gate = () => {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

test('depends on: a ready issue waits while its dependency is open, says why, and starts on its own once it closes', { skip }, async () => {
  const f = fixture();
  const a = f.backlog.open({ title: 'The groundwork', body: 'Not ready yet.', author: 'example-owner', labels: [] });
  const b = f.backlog.open({ title: 'Add b.js', body: `Add b.js on top of it. Depends on #${a}.${DONE}`, author: 'example-owner', labels: ['ready'] });
  let now = Date.now();
  const runner = workers();
  const c = coordinator(f, runner, { now: () => new Date(now) });
  await c.tick();
  await c.idle();
  await c.tick();
  await c.idle();
  assert.equal(runner.calls.filter((r) => r.role === 'worker').length, 0, 'not started while #a is open');
  assert.deepEqual(f.log.read(0, ['dependency.held']).map((e) => e.payload), [{ issue: b, on: [a], reason: `waits for #${a} to close` }], 'recorded once');
  const hold = prsView(f.log.read()).holds.find((h) => h.issue === b)!;
  assert.equal(hold.kind, 'dependency');
  assert.equal(hold.reason, `waits for #${a} to close`);
  assert.ok(waitingOnYou(f.log.read()).items.some((i) => i.issue === b && i.detail === `waits for #${a} to close`), 'shown where hotspot holds show');

  await f.backlog.close(a);
  now += 61_000; // past the gate's cache of an open dependency
  await c.tick();
  await c.idle();
  const un = f.log.read(0, ['dependency.unblocked']).map((e) => e.payload as EventPayload<'dependency.unblocked'>);
  assert.deepEqual(un.map((u) => [u.issue, u.on, u.why]), [[b, [a], 'closed']]);
  assert.equal(runner.calls.filter((r) => r.role === 'worker').length, 1, 'started once unblocked');
  assert.ok(prsView(f.log.read()).holds.find((h) => h.issue === b)!.until, 'the hold row ends');
});

test('depends on: a cycle is reported once on each issue in it, and neither starts (no silent wait)', { skip }, async () => {
  const f = fixture();
  const b = f.backlog.open({ title: 'Add b.js', body: `Add b.js. Depends on #2.${DONE}`, author: 'example-owner', labels: ['ready'] });
  const c2 = f.backlog.open({ title: 'Add c.js', body: `Add c.js. Blocked by #${b}.${DONE}`, author: 'example-owner', labels: ['ready'] });
  assert.equal(c2, 2);
  const runner = workers();
  const c = coordinator(f, runner);
  await c.tick();
  await c.idle();
  await c.tick();
  await c.idle();
  assert.equal(runner.calls.filter((r) => r.role === 'worker').length, 0);
  assert.deepEqual(f.log.read(0, ['dependency.cycle']).map((e) => e.payload), [
    { issue: b, cycle: [b, c2] },
    { issue: c2, cycle: [c2, b] },
  ]);
  for (const n of [b, c2]) {
    const said = (await f.backlog.comments(n)).filter((x) => /form a cycle/.test(x.body));
    assert.equal(said.length, 1, `one cycle comment on #${n}`);
  }
  assert.match(String((f.log.read(0, ['dependency.held']).at(-1)!.payload as { reason: string }).reason), /dependency cycle/);
});

test("ownership: a running task's plan files hold a task that would change them, until the first one ends", { skip }, async () => {
  const f = fixture();
  f.cfg.project.hotspots = []; // no hotspots: only the plan's files are owned
  f.cfg.agents.roles.workers!.count = 2;
  const a = f.backlog.open({ title: 'Add a.js', body: `Add a.js and wire it into totals.${DONE}`, author: 'example-owner', labels: ['ready', 'size:M'] });
  const g = gate();
  const order: string[] = [];
  const runner = workers({ 'a.js': g.p }, order);
  const c = coordinator(f, runner);
  await c.tick();
  for (let i = 0; i < 100 && !order.includes('start a.js'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f.log.read(0, ['plan.posted']).length, 'planned');
  const b = f.backlog.open({ title: 'Add b.js', body: `Add b.js and register it in \`src/price.js\`.${DONE}`, author: 'example-owner', labels: ['ready'] });
  await c.tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(f.log.read(0, ['hotspot.held']).map((e) => e.payload), [{ issue: b, by: a, files: ['src/price.js'], reason: `waits for #${a}: both change src/price.js` }]);
  assert.ok(!order.includes('start b.js'));
  g.open();
  await c.idle();
  await c.tick();
  await c.idle();
  assert.deepEqual(order, ['start a.js', 'end a.js', 'start b.js', 'end b.js'], 'b ran only after a ended and released its files');
});

test('ownership: a task whose plan names a file a running task owns waits before building, then builds once it is free', { skip }, async () => {
  const f = fixture();
  f.cfg.project.hotspots = ['src/price.js'];
  f.cfg.agents.roles.workers!.count = 2;
  const a = f.backlog.open({ title: 'Add a.js', body: `Add a.js and register it in src/price.js.${DONE}`, author: 'example-owner', labels: ['ready'] });
  const b = f.backlog.open({ title: 'Add b.js', body: `Add b.js and wire it into totals.${DONE}`, author: 'example-owner', labels: ['ready', 'size:M'] });
  const g = gate();
  const order: string[] = [];
  const c = coordinator(f, workers({ 'a.js': g.p }, order), { ownershipPollMs: 20 });
  await c.tick();
  for (let i = 0; i < 100 && !f.log.read(0, ['hotspot.held']).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(f.log.read(0, ['hotspot.held']).map((e) => e.payload), [{ issue: b, by: a, files: ['src/price.js'], reason: `waits for #${a}: both change src/price.js` }]);
  await c.tick(); // b is running (waiting in-task), not ready: its hold must not be ended as "no longer ready"
  assert.equal(f.log.read(0, ['hotspot.released']).length, 0);
  assert.ok(!order.includes('start b.js'), 'b does not build while a owns src/price.js');
  g.open();
  await c.idle();
  assert.deepEqual(order, ['start a.js', 'end a.js', 'start b.js', 'end b.js']);
  assert.deepEqual(f.log.read(0, ['hotspot.released']).map((e) => [(e.payload as { issue: number }).issue, (e.payload as { started: boolean }).started]), [[b, true]]);
});
