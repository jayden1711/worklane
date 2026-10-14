import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { fingerprint } from '../src/corrections.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { MIN_SIGHTINGS } from '../src/gardener.js';
import { learningsView, promoteRefusal, taskNotes, withLearning } from '../src/learnings.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

let id = 0;
const T0 = Date.parse('2026-10-05T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (s: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: at(s), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });

/** A worker attempt on `issue` that ran `secs` and ended with `reason`/`detail`, then what the coordinator recorded. */
const attempt = (issue: number, s: number, secs: number, reason: string, detail: string, then: StoredEvent[] = []) => [
  ev(s, 'run.started', { issue, role: 'worker', model: 'm', worktree: `/w/${issue}`, pid: 1, pgid: 1, attempt: 1 }),
  ev(s + secs, 'run.finished', { issue, role: 'worker', reason, detail }),
  ...then,
];

const noted = (events: StoredEvent[], issue: number, s: number) => [...events, ...taskNotes(events, issue).map((n, i) => ev(s + i, 'learning.noted', n))];

test('a finished task notes each failed run: the stage code can tell and the cause normalized; a success notes nothing', () => {
  const a = attempt(7, 0, 20, 'failed', 'Error: ENOENT /srv/app/build/out.json after 1200ms');
  const notes = taskNotes(a, 7);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0]!.outcome, notes[0]!.stage, notes[0]!.cause, notes[0]!.same_as], ['startup failure', 'environment/harness', 'Error: ENOENT <path> after <time>', null]);
  assert.equal(notes[0]!.fingerprint, fingerprint({ text: `startup failure ${notes[0]!.cause}` }), 'the corrections fingerprint');
  assert.deepEqual(taskNotes(noted(a, 7, 30), 7), [], 'noting the same task again adds nothing');
  const ok = attempt(8, 0, 200, 'succeeded', '', [ev(201, 'change.proposed', { issue: 8, branch: 'b', base: 'a'.repeat(40), head: 'b'.repeat(40), files: ['x'], lines: 1, patch_hash: 'h' })]);
  assert.deepEqual(taskNotes(ok, 8), []);
});

test('the same cause on later tasks points at the first note (same_as) and groups with it; ready from MIN_SIGHTINGS', () => {
  let events: StoredEvent[] = [];
  for (let i = 0; i < MIN_SIGHTINGS; i++) {
    events = [...events, ...attempt(10 + i, i * 1000, 20, 'failed', `Error: ENOENT /srv/app/build/${i}${i}${i}.json`)];
    events = noted(events, 10 + i, i * 1000 + 500);
    const v = learningsView(events);
    assert.equal(v.groups.length, 1);
    assert.equal(v.groups[0]!.ready, i + 1 >= MIN_SIGHTINGS, `seen ${i + 1}`);
  }
  const notes = events.filter((e) => e.type === 'learning.noted').map((e) => e.payload as { key: string; same_as: string | null });
  assert.deepEqual(notes.map((n) => n.same_as), [null, notes[0]!.key, notes[0]!.key]);
  const g = learningsView(events).groups[0]!;
  assert.deepEqual([g.count, g.issues, g.root, g.stages], [3, [10, 11, 12], notes[0]!.key, [{ stage: 'environment/harness', count: 3 }]]);
});

test("a note code couldn't stage takes the weekly judge's label for its run", () => {
  const events = [...attempt(20, 0, 600, 'failed', 'the change broke totals'), ev(700, 'learning.noted', { key: 'k', issue: 20, role: 'worker', attempt: 1, run: 'r1', outcome: 'failed', stage: null, cause: 'the change broke totals', fingerprint: 'f', same_as: null })];
  assert.deepEqual(learningsView(events).groups[0]!.stages, [{ stage: 'unlabelled', count: 1 }]);
  events.push(ev(800, 'run.stage_labeled', { run: 'r1', issue: 20, role: 'worker', instance: 'i', stage: 'wrong files', reason: 'x', by: 'judge' }));
  assert.deepEqual(learningsView(events).groups[0]!.stages, [{ stage: 'wrong files', count: 1 }]);
});

test('a promote must name a ready group not promoted yet, with one short line', () => {
  let events: StoredEvent[] = [];
  for (let i = 0; i < MIN_SIGHTINGS - 1; i++) events = noted([...events, ...attempt(30 + i, i * 1000, 20, 'failed', 'boom')], 30 + i, i * 1000 + 500);
  const fp = learningsView(events).groups[0]!.fingerprint;
  assert.equal(promoteRefusal(learningsView(events), fp, '- x')?.status, 409, 'not seen often enough');
  events = noted([...events, ...attempt(40, 9000, 20, 'failed', 'boom')], 40, 9500);
  const v = learningsView(events);
  assert.equal(promoteRefusal(v, fp, '- x'), null);
  assert.equal(promoteRefusal(v, 'nope', '- x')?.status, 404);
  assert.equal(promoteRefusal(v, fp, 'a\nb')?.status, 400);
  assert.equal(promoteRefusal(v, fp, 'x'.repeat(301))?.status, 400);
  const asked = [...events, ev(9999, 'learning.promote_requested', { fingerprint: fp, line: '- x', by: 'example-owner' })];
  assert.equal(promoteRefusal(learningsView(asked), fp, '- x')?.status, 409, 'once');
  const failed = [...asked, ev(10000, 'learning.promoted', { fingerprint: fp, line: '- x', by: 'example-owner', pr: null, number: null, detail: 'push refused' })];
  assert.equal(promoteRefusal(learningsView(failed), fp, '- x'), null, 'a promote that filed nothing may be asked again');
});

test('the line goes under AGENTS.md "## Learnings", made when missing, and never twice', () => {
  assert.equal(withLearning(null, '- a'), '## Learnings\n\n- a\n');
  assert.equal(withLearning('# Agents\n\nBe brief.\n', '- a'), '# Agents\n\nBe brief.\n\n## Learnings\n\n- a\n');
  assert.equal(withLearning('# Agents\n\n## Learnings\n\n- a\n\n## Other\n\nx\n', '- b'), '# Agents\n\n## Learnings\n\n- a\n- b\n\n## Other\n\nx\n');
  assert.equal(withLearning('## Learnings\n', '- b'), '## Learnings\n\n- b\n');
  assert.equal(withLearning('## Learnings\n\n- a\n', '- a'), null);
});

test('dashboard: owners and writers read the learnings; only an owner promotes, once, and it is audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learnings-dash-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  for (let i = 0; i < MIN_SIGHTINGS; i++) {
    const evs = attempt(50 + i, i * 1000, 20, 'failed', 'boom');
    for (const e of evs) log.append(e.type as 'run.started', e.payload as never, 'c');
    for (const n of taskNotes(log.read(), 50 + i)) log.append('learning.noted', n, 'c');
  }
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), pollMs: 50 });
  const base = d.url.split('/?')[0]!;
  const req = (path: string, who: string, body?: object) =>
    fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(who) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await req('/api/learnings', 'someone-else')).status, 403, "not a viewer's");
    const w = (await (await req('/api/learnings', 'example-collaborator')).json()) as { groups: { fingerprint: string; count: number; ready: boolean }[]; canPromote: boolean };
    assert.deepEqual([w.groups.map((g) => [g.count, g.ready]), w.canPromote], [[[MIN_SIGHTINGS, true]], false]);
    const fp = w.groups[0]!.fingerprint;
    assert.equal((await req('/api/learnings/promote', 'example-collaborator', { fingerprint: fp, line: '- x' })).status, 403, 'a writer may not promote');
    assert.equal((await req('/api/learnings/promote', 'example-owner', { fingerprint: fp, line: '- x\n- y' })).status, 400);
    assert.equal((await req('/api/learnings/promote', 'example-owner', { fingerprint: fp, line: ' - check the build dir first ' })).status, 200);
    assert.equal((await req('/api/learnings/promote', 'example-owner', { fingerprint: fp, line: '- again' })).status, 409);
    assert.deepEqual(log.read(0, ['learning.promote_requested']).map((e) => e.payload), [{ fingerprint: fp, line: '- check the build dir first', by: 'example-owner' }]);
    assert.ok(log.read(0, ['dashboard.audit']).some((e) => (e.payload as { action: string }).action === 'learning.promoted'));
  } finally {
    await d.close();
    log.close();
  }
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(worker: (req: RunRequest) => object = () => ({ structured: { summary: 's' } })) {
  const base = mkdtempSync(join(tmpdir(), 'learnings-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, 'AGENTS.md'), '# Agents\n\nKeep changes small.\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const runner = new FakeRunner((req) => (req.role === 'worker' ? worker(req) : { structured: {} }));
  const c = new Coordinator({ cfg: loadConfig(repo), log, backlog, runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  return { c, log, backlog, remote };
}

test('a task that ends leaves its notes, from the coordinator itself', async () => {
  const t = fixture(() => ({ reason: 'failed', detail: 'Error: ENOENT /srv/app/build/out.json' }));
  const n = t.backlog.open({ title: 'Fix totals', body: 'Totals.\n\n```done_when\n- command: node --version\n```\n', author: 'example-owner', labels: ['ready'] });
  await t.c.tick();
  await t.c.idle();
  const notes = t.log.read(0, ['learning.noted']).map((e) => e.payload as { issue: number; stage: string | null; cause: string });
  assert.ok(notes.length >= 1, 'noted when the task ended');
  assert.ok(notes.every((x) => x.issue === n && x.cause === 'Error: ENOENT <path>'));
});

test("an owner's promote becomes one PR adding the line to AGENTS.md, labelled review:L3; main is untouched", async () => {
  const t = fixture();
  const mainBefore = git(t.remote, 'rev-parse', 'main');
  t.log.append('learning.promote_requested', { fingerprint: 'abc123', line: '- check the build dir first', by: 'example-owner' }, 'example-owner', 'human');
  await t.c.promoteLearnings();
  const done = t.log.read(0, ['learning.promoted']).map((e) => e.payload as { pr: string | null; number: number | null; detail: string });
  assert.equal(done.length, 1);
  assert.ok(done[0]!.pr, done[0]!.detail);
  const branch = `${BRAND.cli}/learning-abc123`;
  assert.equal(git(t.remote, 'show', `${branch}:AGENTS.md`), '# Agents\n\nKeep changes small.\n\n## Learnings\n\n- check the build dir first');
  assert.equal(git(t.remote, 'rev-parse', 'main'), mainBefore, 'never written in place');
  const pr = t.backlog.prs().find((p) => p.head === branch)!;
  assert.ok(pr, 'a pull request');
  assert.ok((await t.backlog.get(done[0]!.number!)).labels.includes('review:L3'));
  await t.c.promoteLearnings();
  assert.equal(t.log.read(0, ['learning.promoted']).length, 1, 'acted on once');
});
