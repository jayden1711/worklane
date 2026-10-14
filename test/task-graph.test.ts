import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGate, dependencyReason, dependsOn, findCycle } from '../src/task-graph.js';
import { FileClaims } from '../src/ownership.js';
import { TaskGraph } from '../src/coordinator/task-graph.js';
import type { EventType, StoredEvent } from '../src/events/types.js';

test('dependsOn: "Depends on" and "Blocked by" lines, lists and any case; code blocks are not read', () => {
  assert.deepEqual(dependsOn('Depends on #12'), [12]);
  assert.deepEqual(dependsOn('depends on: #3, #4 and #5.\nBLOCKED BY #7 & #8, also #9 is unrelated'), [3, 4, 5, 7, 8]);
  assert.deepEqual(dependsOn('Blocked by #4\nDepends on #4'), [4], 'each once');
  assert.deepEqual(dependsOn('See #3. Fixes #10.'), [], 'a mention is not a dependency');
  assert.deepEqual(dependsOn('```\nDepends on #1\n```\nand `Blocked by #2` <!-- Depends on #3 -->'), []);
});

test('findCycle: a cycle through the issue or behind it, a self-dependency; none in a chain', () => {
  const g = (m: Record<number, number[]>) => (n: number) => m[n] ?? [];
  assert.deepEqual(findCycle(1, g({ 1: [2], 2: [1] })), [1, 2]);
  assert.deepEqual(findCycle(1, g({ 1: [2], 2: [3], 3: [2] })), [2, 3], 'a cycle behind it blocks it too');
  assert.deepEqual(findCycle(5, g({ 5: [5] })), [5]);
  assert.equal(findCycle(1, g({ 1: [2, 3], 2: [3], 3: [] })), null);
});

function tracker(issues: Record<number, { state: 'open' | 'closed'; body?: string }>) {
  const reads: number[] = [];
  const get = async (n: number) => {
    reads.push(n);
    const i = issues[n];
    if (!i) throw new Error('not found');
    return { number: n, state: i.state, body: i.body ?? '' };
  };
  return { get, reads, issues };
}

test('dependency gate: open, closed and unreadable dependencies; a closed one is remembered, an open one read again after the TTL', async () => {
  const t = tracker({ 2: { state: 'open' }, 3: { state: 'closed' } });
  let now = 0;
  const gate = new DependencyGate(t.get, () => now, 1000);
  const s = await gate.check({ number: 1, body: 'Depends on #2, #3 and #4' });
  assert.deepEqual(s, { open: [2], unreadable: [4], cycle: null });
  assert.equal(dependencyReason(s), 'waits for #2 to close; could not read #4');
  t.reads.length = 0;
  t.issues[2]!.state = 'closed';
  await gate.check({ number: 1, body: 'Depends on #2, #3' });
  assert.deepEqual(t.reads, [], 'within the TTL: nothing read again');
  now = 1001;
  assert.deepEqual((await gate.check({ number: 1, body: 'Depends on #2, #3' })).open, []);
  assert.deepEqual(t.reads, [2], 'the open one read again; the closed one never');
});

test('dependency gate: a cycle among open issues is found, through issues read from the tracker', async () => {
  const t = tracker({ 2: { state: 'open', body: 'Blocked by #3' }, 3: { state: 'open', body: 'Depends on #1' } });
  const gate = new DependencyGate(t.get);
  gate.seed([{ number: 1, state: 'open', body: 'Depends on #2' }]);
  const s = await gate.check({ number: 1, body: 'Depends on #2' });
  assert.deepEqual(s.cycle, [1, 2, 3]);
  assert.match(dependencyReason(s), /dependency cycle #1 -> #2 -> #3 -> #1/);
  // A closed link breaks it.
  t.issues[3]!.state = 'closed';
  const gate2 = new DependencyGate(t.get);
  assert.equal((await gate2.check({ number: 1, body: 'Depends on #2' })).cycle, null);
});

test('file claims: a clash names the owner and the shared files; a task never clashes with itself; release frees them', () => {
  const c = new FileClaims();
  c.set(1, ['./src/a.ts', 'package-lock.json']);
  assert.deepEqual(c.clash(2, ['src/a.ts', 'src/b.ts']), { issue: 2, by: 1, files: ['src/a.ts'] });
  assert.equal(c.clash(1, ['src/a.ts']), null);
  c.release(1);
  assert.equal(c.clash(2, ['src/a.ts']), null);
});

test('file claims: a wait cycle is found from each member; a chain is not a cycle', () => {
  const c = new FileClaims();
  c.wait(1, 2);
  c.wait(2, 3);
  assert.equal(c.cycle(1), null);
  c.wait(3, 1);
  assert.deepEqual(c.cycle(1), [1, 2, 3]);
  assert.deepEqual(c.cycle(3), [3, 1, 2]);
});

test('file claims: a claim with no live task is dropped and returned for the report', () => {
  const c = new FileClaims();
  c.set(1, ['src/a.ts']);
  c.set(2, ['src/b.ts']);
  assert.deepEqual(c.dropStale((n) => n === 2), [{ issue: 1, files: ['src/a.ts'] }]);
  assert.equal(c.clash(3, ['src/a.ts']), null);
  assert.ok(c.clash(3, ['src/b.ts']));
});

/** A TaskGraph over an in-memory log. */
function graph(pollMs = 5) {
  const log: StoredEvent[] = [];
  let id = 0;
  const g = new TaskGraph({
    backlog: { get: async () => Promise.reject(new Error('unused')), comment: async () => {} },
    emit: (type, payload) => log.push({ id: ++id, ts: new Date().toISOString(), type, payload, instance: 'c' } as unknown as StoredEvent),
    read: (types: EventType[]) => log.filter((e) => types.includes(e.type)),
    pollMs,
  });
  return { g, log };
}

const hooks = (live: (n: number) => boolean = () => true) => ({ live, halted: () => {}, onHold: () => {}, onFree: () => {} });

test('ownership: a task waits for the owner of its plan files and owns them once the owner ends', { timeout: 10_000 }, async () => {
  const { g } = graph();
  g.claims.set(1, ['src/a.ts']);
  let owned = false;
  const p = g.own(2, ['src/a.ts', 'src/b.ts'], hooks()).then(() => (owned = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(owned, false, 'still waiting');
  g.claims.release(1);
  await p;
  assert.deepEqual(g.claims.files(2), ['src/a.ts', 'src/b.ts']);
});

test('ownership: two running tasks waiting on each other are reported, and the lower issue goes ahead (no hang)', { timeout: 10_000 }, async () => {
  const { g, log } = graph();
  g.claims.set(1, ['src/a.ts']);
  g.claims.set(2, ['src/b.ts']);
  const two = g.own(2, ['src/a.ts'], hooks());
  await new Promise((r) => setTimeout(r, 15));
  await g.own(1, ['src/b.ts'], hooks());
  const dl = log.filter((e) => e.type === 'ownership.deadlock').map((e) => e.payload);
  assert.deepEqual(dl, [{ issue: 1, cycle: [1, 2], files: ['src/b.ts'], proceeds: 1 }]);
  g.claims.release(1);
  await two;
  assert.deepEqual(g.claims.files(2), ['src/a.ts', 'src/b.ts']);
});

test('ownership: a claim whose task is gone is dropped and reported instead of being waited on', { timeout: 10_000 }, async () => {
  const { g, log } = graph();
  g.claims.set(7, ['src/a.ts']);
  await g.own(2, ['src/a.ts'], hooks((n) => n !== 7));
  assert.deepEqual(log.filter((e) => e.type === 'ownership.stale').map((e) => e.payload), [{ issue: 7, files: ['src/a.ts'] }]);
  assert.deepEqual(g.claims.files(2), ['src/a.ts']);
});

test('ownership: a stop ends the wait (the halt check throws) and leaves no wait edge behind', { timeout: 10_000 }, async () => {
  const { g } = graph();
  g.claims.set(1, ['src/a.ts']);
  await assert.rejects(g.own(2, ['src/a.ts'], { ...hooks(), halted: () => { throw new Error('halted'); } }), /halted/);
  assert.equal(g.claims.cycle(2), null);
  assert.deepEqual(g.claims.files(2), [], 'nothing owned');
});
