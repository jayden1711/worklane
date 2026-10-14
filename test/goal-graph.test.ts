// A goal's task graph (src/goal-graph.ts, GET /api/goal-graph): a node per child task with its state, an edge per
// "Depends on" as src/task-graph.ts reads it, cycles flagged without hanging, a cap that says so, and nothing for a
// viewer that the viewer couldn't see before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { writeLive } from '../src/console.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { childBody, type GoalChild } from '../src/goal-split.js';
import { goalGraph, safeUrl, type GoalGraph } from '../src/goal-graph.js';
import { project } from '../src/projection.js';
import { dependsOn } from '../src/task-graph.js';
import { asPerson, exampleProject, exampleRole } from './helpers.js';

const A = 'a'.repeat(40);
const GOAL = 10;
/** The goal's children as the planner filed them: 11 first, 12 and 14 after it, 13 after 12. */
const CHILDREN: { number: number; key: string; title: string; deps: number[] }[] = [
  { number: 11, key: 'schema', title: 'Add the export schema', deps: [] },
  { number: 12, key: 'api', title: 'Serve the export', deps: [11] },
  { number: 13, key: 'ui', title: 'Export button', deps: [12] },
  { number: 14, key: 'docs', title: 'Document exports', deps: [11] },
];
const child = (c: (typeof CHILDREN)[number]): GoalChild => ({ key: c.key, title: c.title, body: `Build ${c.key}.`, done_when: ['command: npm test'], depends_on: [] });
/** Each child's body as filed (goal-split.ts childBody): the "Depends on" lines task-graph.ts reads. */
const BODIES = new Map(CHILDREN.map((c) => [c.number, childBody(child(c), GOAL, c.deps)]));

/** A log with the goal, its split, each child seen, a landed child, a PR on 12 and a claim on 13. */
function seed(o: { cycle?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-graph-'));
  const eventsDb = join(dir, 'events.db');
  const log = new EventLog(eventsDb);
  const seen = (issue: number, title: string, labels: string[] = []) => log.append('issue.seen', { issue, title, labels, author: 'example-owner', owner: null, actionable: true, why: 'ok' }, 'c');
  seen(GOAL, 'Exports', ['type:goal', 'goal:split']);
  for (const c of CHILDREN) seen(c.number, c.title);
  // The split's depends_on is what the coordinator read back from each filed body (src/task-graph.ts dependsOn).
  log.append('goal.split', { issue: GOAL, summary: 'SPLIT-SUMMARY-PRIVATE', children: CHILDREN.map((c) => ({ number: c.number, key: c.key, depends_on: dependsOn(BODIES.get(c.number)!), body_hash: 'h' })) }, 'c');
  log.append('issue.claimed', { issue: 11, instance: 'a', lease: A, base: A, owner: 'example-owner' }, 'c');
  log.append('land.result', { issue: 11, outcome: 'landed', landed: A, detail: '' }, 'c');
  log.append('issue.claimed', { issue: 12, instance: 'a', lease: A, base: A, owner: 'example-owner' }, 'c');
  log.append('pr.opened', { issue: 12, number: 120, url: 'https://example.test/pr/120', head: A, draft: false }, 'c');
  log.append('issue.claimed', { issue: 13, instance: 'a', lease: A, base: A, owner: 'example-owner' }, 'c');
  // An owner edited #12 to wait on #13 too: the dispatch loop found the cycle (src/coordinator/task-graph.ts).
  if (o.cycle) log.append('dependency.cycle', { issue: 13, cycle: [13, 12] }, 'c');
  writeLive(dir, [{ run: 'run-13-live', issue: 13, role: 'worker', model: 'sonnet', startedAt: new Date().toISOString(), pending: [] }]);
  return { dir, eventsDb, log };
}

const edgesOf = (g: GoalGraph) => g.edges.map((e) => `${e.from}>${e.to}`).sort();

test('the graph: a node per child with the state the dashboard shows, an edge per "Depends on" as task-graph.ts reads it, in columns', () => {
  const s = seed();
  const events = s.log.read(0);
  const g = goalGraph({ events, goal: GOAL, runOf: (n) => (n === 13 ? 'run-13' : null) });
  assert.equal(g.split, true);
  assert.deepEqual(g.nodes.map((n) => n.issue).sort(), [11, 12, 13, 14]);
  const want = CHILDREN.flatMap((c) => dependsOn(BODIES.get(c.number)!).map((d) => `${d}>${c.number}`)).sort();
  assert.deepEqual(want, ['11>12', '11>14', '12>13'], 'the fixture: task-graph.ts reads these from the filed bodies');
  assert.deepEqual(edgesOf(g), want);
  const status = new Map(project(events).tasks.map((t) => [t.issue, t.status]));
  for (const n of g.nodes) assert.equal(n.status, status.get(n.issue), `#${n.issue} in the state the dashboard shows`);
  assert.equal(g.nodes.find((n) => n.issue === 11)!.status, 'landed');
  assert.deepEqual(Object.fromEntries(g.nodes.map((n) => [n.issue, n.layer])), { 11: 0, 12: 1, 13: 2, 14: 1 });
  assert.deepEqual(g.nodes.find((n) => n.issue === 12)!.pr, { number: 120, url: 'https://example.test/pr/120' });
  assert.equal(g.nodes.find((n) => n.issue === 13)!.run, 'run-13');
  assert.deepEqual(g.cycles, []);
  assert.equal(goalGraph({ events, goal: GOAL }).nodes.find((n) => n.issue === 13)!.run, null, 'no run without runOf');
});

test('a cycle is flagged (its nodes and edges, once) and the graph still comes back', { timeout: 10_000 }, () => {
  const g = goalGraph({ events: seed({ cycle: true }).log.read(0), goal: GOAL });
  assert.deepEqual(g.cycles, [[12, 13]]);
  assert.deepEqual(g.nodes.filter((n) => n.cycle).map((n) => n.issue).sort(), [12, 13]);
  assert.deepEqual(g.edges.filter((e) => e.cycle).map((e) => `${e.from}>${e.to}`).sort(), ['12>13', '13>12']);
  assert.equal(g.nodes.length, 4);

  // A ring of 400 tasks, each depending on the next, the last on the first, and on every other: still bounded.
  const n = 400;
  const children = Array.from({ length: n }, (_, i) => ({ number: 1000 + i, key: `k${i}`, depends_on: [1000 + ((i + 1) % n), 1000 + ((i + 2) % n)], body_hash: 'h' }));
  const ring = [{ id: 1, ts: new Date().toISOString(), type: 'goal.split', actor: 'c', payload: { issue: 9, summary: '', children } }] as unknown as StoredEvent[];
  const t0 = Date.now();
  const big = goalGraph({ events: ring, goal: 9 });
  assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
  assert.ok(big.cycles.length >= 1);
  assert.equal(big.total, n);
  assert.equal(big.capped, true, 'a large graph is capped, and says so');
  assert.equal(big.nodes.length, 60);
  for (const e of big.edges) assert.ok(big.nodes.some((x) => x.issue === e.from) && big.nodes.some((x) => x.issue === e.to), 'no edge to a node left out');
});

test('no split recorded, or one with no tasks: an empty graph, not an error', () => {
  const events = seed().log.read(0);
  assert.deepEqual(goalGraph({ events, goal: 99 }), { goal: 99, split: false, nodes: [], edges: [], cycles: [], total: 0, capped: false });
  const none = [{ id: 1, ts: new Date().toISOString(), type: 'goal.split', actor: 'c', payload: { issue: 5, summary: '', children: [] } }] as unknown as StoredEvent[];
  assert.deepEqual(goalGraph({ events: none, goal: 5 }), { goal: 5, split: true, nodes: [], edges: [], cycles: [], total: 0, capped: false });
});

test('a PR link is the recorded https URL only, never javascript: or anything else', () => {
  assert.equal(safeUrl('https://example.test/pr/1'), 'https://example.test/pr/1');
  for (const bad of ['javascript:alert(1)', 'http://example.test/pr/1', 'data:text/html,x', '/pr/1', '', 3]) assert.equal(safeUrl(bad), null, String(bad));
});

test('GET /api/goal-graph: the graph for the owner and a writer (with run links); a viewer sees no goal it could not before; no role, no token, refused', async () => {
  const s = seed();
  const { dir: root } = exampleProject();
  const roleOf = async (login: string) => (login === 'stranger' ? null : exampleRole(login));
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: s.eventsDb, stateDir: s.dir, user: 'example-owner', roleOf, slotsDir: join(s.dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (login: string | null, path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...(login ? asPerson(login) : {}) } });
  try {
    for (const login of ['example-owner', 'example-collaborator']) {
      const r = await get(login, `/api/goal-graph?issue=${GOAL}`);
      assert.equal(r.status, 200, login);
      const g = (await r.json()) as GoalGraph;
      assert.deepEqual(g, goalGraph({ events: s.log.read(0), goal: GOAL, runOf: (n) => (n === 13 ? 'run-13-live' : null) }), `${login}: the graph from the log, with the live run`);
      assert.deepEqual(edgesOf(g), ['11>12', '11>14', '12>13']);
    }

    // A viewer's events don't carry the split (viewer-events.ts), so the graph shows nothing of it: not the
    // children, not the summary, not a run.
    const raw = await (await get('someone-else', `/api/goal-graph?issue=${GOAL}`)).text();
    assert.deepEqual(JSON.parse(raw), { goal: GOAL, split: false, nodes: [], edges: [], cycles: [], total: 0, capped: false });
    assert.doesNotMatch(raw, /SPLIT-SUMMARY-PRIVATE|run-13|schema/);

    assert.equal((await get('stranger', `/api/goal-graph?issue=${GOAL}`)).status, 403, 'no role on the repo');
    assert.equal((await fetch(`${base}/api/goal-graph?issue=${GOAL}`)).status, 401, 'no token');
    assert.equal((await get('example-owner', '/api/goal-graph?issue=x')).status, 400);
    assert.equal((await fetch(`${base}/api/goal-graph?issue=${GOAL}`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, ...asPerson('example-owner') } })).status, 404, 'read-only: no write route');
  } finally {
    await d.close();
  }
});
