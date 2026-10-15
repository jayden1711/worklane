// WHY (#468): a new person's first issue had no ```done_when block and no `ready` label, and was silently ignored.
// "Your first task" files one the coordinator takes (checked with its own parser first; `ready` created if missing),
// in a checkout only; and the Issues page says why each open issue isn't being worked on, from the coordinator's own
// events and ONE cached listing of the open issues, with a writer's fix where safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { actionable, parseContract, type Backlog, type Issue } from '../src/backlog/types.js';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { firstTaskBody, ignoredIssues } from '../src/first-task.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'first-task-state-'));

test('#468 the first-task body: a test and a command (with an expected output) in a done_when block the coordinator\'s parser takes; bad answers refused', () => {
  const { title, body } = firstTaskBody({ title: 'Add a health endpoint', outcome: 'GET /health answers 200.', done_when: [{ test: 'test/health.test.ts' }, { command: 'npm run build', expect: "it's built" }], context: 'See the ops doc.' });
  assert.equal(title, 'Add a health endpoint');
  const c = parseContract(body);
  assert.ok(c.ok, body);
  assert.deepEqual(c.done_when, [{ test: 'test/health.test.ts' }, { command: "npm run build | grep -qF -- 'it'\\''s built'\n" }]);
  assert.match(body, /^\*\*Outcome:\*\* GET \/health answers 200\.$/m);
  for (const [v, why] of [
    [{ title: '', outcome: 'x', done_when: [{ test: 't' }] }, /title: required/],
    [{ title: 'a\nb', outcome: 'x', done_when: [{ test: 't' }] }, /title: one line/],
    [{ title: 't', outcome: 'x', done_when: [] }, /at least one test or command/],
    [{ title: 't', outcome: 'x', done_when: [{ command: '  ' }] }, /the command is empty/],
    [{ title: 't', outcome: 'x', done_when: [{ nope: 1 }] }, /a test or a command/],
  ] as const) assert.throws(() => firstTaskBody(v as never), why);
});

/** A backlog that counts its reads of the open issues, over a file backlog (the stand-in GitHub). */
function counted(path: string, actor: string) {
  const b = new FileBacklog(path, actor);
  let reads = 0;
  const labels: string[][] = [];
  const backlog: Backlog = Object.assign(Object.create(b) as Backlog, {
    openIssues: async () => (reads++, b.openIssues()),
    ensureLabels: async (l: { name: string; color: string; description: string }[]) => (labels.push(l.map((x) => x.name)), b.ensureLabels(l)),
  });
  return { b, backlog, reads: () => reads, labels };
}

async function dashboard(backlog: () => Backlog) {
  const { dir } = exampleProject();
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const eventsDb = join(stateDir, 'events.db');
  new EventLog(eventsDb).close();
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'ft-slots-')), backlog });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async (path: string, user = 'example-owner') => {
    const r = await fetch(`${base}${path}`, { headers: h(user) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const post = async (path: string, body: unknown, user = 'example-owner') => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: h(user), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { d, get, post, eventsDb };
}

test('#468 Your first task through the page: Review files nothing; File creates ready (when missing) and an issue the coordinator takes as actionable; writers only', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ft-backlog-')), 'backlog.json');
  const c = counted(path, 'example-owner');
  const s = await dashboard(() => c.backlog);
  try {
    const info = await s.get('/api/first-run/first-task');
    assert.equal(info.status, 200);
    assert.equal(info.body.local, true);
    assert.match(info.body.template.body, /```done_when/);
    const values = { title: 'First task', outcome: 'It works.', done_when: [{ command: 'true' }] };
    assert.equal((await s.post('/api/first-run/first-task', { values, confirm: true }, 'someone-else')).status, 403, 'viewers may not');
    const shown = await s.post('/api/first-run/first-task', { values });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.confirmed, false);
    assert.deepEqual(await c.b.openIssues(), [], 'Review files nothing');
    const bad = await s.post('/api/first-run/first-task', { values: { ...values, done_when: [] }, confirm: true });
    assert.equal(bad.status, 400);
    const filed = await s.post('/api/first-run/first-task', { values, confirm: true });
    assert.equal(filed.status, 200, JSON.stringify(filed.body));
    assert.equal(filed.body.labelCreated, true, 'ready created where the repo had none');
    assert.deepEqual(c.labels, [['ready']]);
    const issue = (await c.b.openIssues()).find((i) => i.number === filed.body.number)!;
    assert.deepEqual(issue.labels, ['ready']);
    assert.ok(parseContract(issue.body).ok, 'the coordinator\'s parser takes it');
    const act = await actionable(issue, loadConfig(exampleProject().dir).project.owners.writers, c.b);
    assert.deepEqual(act, { actionable: true, why: 'opened by writer example-owner' }, 'and the coordinator would work on it');
    const again = await s.post('/api/first-run/first-task', { values, confirm: true });
    assert.equal(again.body.labelCreated, false, 'an existing ready label is kept');
  } finally {
    await s.d.close();
  }
});

const open = (n: number, o: Partial<Issue> = {}): Issue => ({ number: n, title: `issue ${n}`, body: '```done_when\n- command: |\n    true\n```', labels: ['ready'], author: 'example-owner', assignees: [], state: 'open', ...o });

test('#468 why an open issue is ignored, from real events: no ready, no or a bad done_when, not a writer\'s, waiting on another, blocked, held; one being worked has none', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'ft-events-')), 'events.db');
  const log = new EventLog(db);
  log.append('issue.seen', { issue: 4, title: 'issue 4', labels: ['ready'], author: 'someone-else', owner: null, actionable: false, why: 'opened by someone-else (not a writer) and no writer added ready' }, 'c');
  log.append('contract.missing', { issue: 3, why: 'no ```done_when block in the issue body', block_hash: 'none' }, 'c');
  log.append('dependency.held', { issue: 5, on: [2], reason: 'Depends on #2' }, 'c');
  log.append('issue.claimed', { issue: 6, instance: 'i', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'example-owner' }, 'c');
  log.append('issue.blocked', { issue: 6, owner: 'example-owner', why: 'the task failed twice' }, 'c');
  log.append('hotspot.held', { issue: 7, by: 8, files: ['package.json'], reason: 'a hotspot file' }, 'c');
  log.append('issue.claimed', { issue: 8, instance: 'i', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'example-owner' }, 'c');
  log.append('governor.hold', { reason: 'the daily budget is spent', load: null, free_disk_pct: null }, 'c');
  const events = log.read(0);
  log.close();
  const list = [open(1, { labels: [] }), open(2), open(3, { body: 'no contract here' }), open(4, { author: 'someone-else' }), open(5), open(6), open(7), open(8), open(9, { body: '```done_when\n- nope: 1\n```' })];
  const got = Object.fromEntries(ignoredIssues(list, events, { repo: 'example-org/example-shop' }).map((i) => [i.issue, i.reasons.map((r) => `${r.kind}${r.fix ? `:${r.fix}` : ''}`)]));
  assert.deepEqual(got, {
    1: ['no-ready:add-ready'],
    2: ['held'],
    3: ['contract:edit'],
    4: ['not-writer:add-ready'],
    5: ['waiting'],
    6: ['blocked'],
    7: ['held'],
    9: ['contract:edit'],
  }, 'issue 8 is being worked: no reason');
  const nine = ignoredIssues([list[8]!], events, { repo: 'o/r' })[0]!;
  assert.match(nine.reasons.find((r) => r.kind === 'contract')!.text, /^done_when invalid:/, "the parser's own message");
});

test('#468 the Issues page\'s list: ONE read of the open issues, kept for everyone; anyone reads the reasons, a writer adds ready (and then it is a writer\'s)', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ft-backlog-')), 'backlog.json');
  const seed = new FileBacklog(path, 'someone-else');
  const n = await seed.createIssue('from an outsider', 'no contract', []);
  const c = counted(path, 'example-owner');
  const s = await dashboard(() => c.backlog);
  try {
    const first = await s.get('/api/issues/ignored', 'someone-else');
    assert.equal(first.status, 200);
    assert.equal(first.body.canFix, false, 'a viewer reads the reasons, no fix');
    assert.deepEqual(first.body.issues[0].reasons.map((r: { kind: string }) => r.kind), ['no-ready', 'contract']);
    const writer = await s.get('/api/issues/ignored', 'example-collaborator');
    assert.equal(writer.body.canFix, true);
    assert.equal(c.reads(), 1, 'one read, kept for everyone');
    assert.equal((await s.post(`/api/issues/${n}/ready`, {}, 'someone-else')).status, 403);
    assert.equal((await s.post(`/api/issues/${n}/ready`, {}, 'example-collaborator')).status, 200);
    assert.deepEqual(await c.b.labelAdders(n, 'ready'), ['example-owner'], "added with this checkout's own login");
    const after = await s.get('/api/issues/ignored', 'example-collaborator');
    assert.equal(c.reads(), 2, 'read again after the fix');
    assert.deepEqual(after.body.issues[0].reasons.map((r: { kind: string }) => r.kind), ['contract'], 'ready now, by a writer: only its contract is left');
  } finally {
    await s.d.close();
  }
});
