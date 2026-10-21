// lint-test
// The superfans (src/superfan/, src/coordinator/superfan.ts): a watcher per instance (and one for the machine's
// engine and updater) that reads what happened since its last pass and posts only when a cheap model finds
// something new or odd, deduped, within its own daily budget. The model and Discord are fakes; the incident store,
// the event log and the state files are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backlog } from '../src/backlog/types.js';
import type { StoredEvent } from '../src/events/types.js';
import { redactPii } from '../src/intake/redact.js';
import { readSlotFile } from '../src/slot-file.js';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { superfanPass, type SuperfanDeps } from '../src/superfan/superfan.js';
import type { Incident } from '../src/watchdog/incidents.js';
import { raiseIncident } from '../src/watchdog/incidents.js';
import { scrub } from '../src/watchdog/post.js';
import { coordinator, fixture } from './repro-state-graph/harness.js';
import { repoRoot } from './helpers.js';

// Fixture secrets, assembled so no scanner reads them as real ones.
const GH_TOKEN = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8';
const DISCORD_TOKEN = 'MTA' + 'xMjM0NTY3ODkwMTIzNDU2Nzg5' + '.GaBcDe.' + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
const API_KEY = 'sk-ant-' + 'api03-' + 'q'.repeat(40);

const incident = (id: string, o: Partial<Incident> = {}): Incident => ({
  id,
  kind: 'test_sandbox',
  key: 'sandbox',
  instance: 'alpha',
  severity: 'red',
  title: 'The test sandbox check is failing',
  detail: 'the sandbox check exited 1',
  fix: 'run the sandbox setup again',
  tried: [],
  since: new Date(Date.UTC(2026, 9, 13, 10, 0)).toISOString(),
  lastSeen: new Date(Date.UTC(2026, 9, 13, 10, 0)).toISOString(),
  resolvedAt: null,
  posted: {},
  ...o,
});

type Answer = { verdict: string; post: string; items: string[]; action: { kind: string; title: string; body: string } };
const nothing: Answer = { verdict: 'nothing', post: '', items: [], action: { kind: 'none', title: '', body: '' } };
/** The model flags every item it was shown, with this text. */
const flagAll = (post: string, action: Answer['action'] = { kind: 'none', title: '', body: '' }) => (prompt: string): Answer => ({ verdict: 'new', post, items: [...prompt.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]!), action });

function world(o: { cap?: number; cost?: number; answer?: (prompt: string) => Answer; names?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'superfan-'));
  const clock = { t: Date.UTC(2026, 9, 13, 10, 5) };
  const events: StoredEvent[] = [];
  const incidents: Incident[] = [];
  const journal: { at: string; priority: number | null; message: string }[] = [];
  const posts: { key: string; text: string }[] = [];
  const prompts: string[] = [];
  const filed: { title: string; body: string; labels: string[] }[] = [];
  const records: unknown[] = [];
  let id = 0;
  const deps: SuperfanDeps = {
    scope: 'instance',
    watching: 'instance alpha',
    stateFile: join(dir, 'superfan.json'),
    settings: { enabled: true, channel: '400000000001', every_minutes: 30, daily_budget_usd: o.cap ?? 2 },
    read: () => ({ events, incidents, health: [], journal: { entries: journal, problem: null } }),
    judge: async (prompt) => {
      prompts.push(prompt);
      return { ok: true, costUsd: o.cost ?? 0.01, structured: (o.answer ?? (() => nothing))(prompt) };
    },
    post: async (key, text) => {
      if (!posts.some((p) => p.key === key)) posts.push({ key, text });
      return true;
    },
    file: async (title, body, labels) => (filed.push({ title, body, labels }), 100 + filed.length),
    redact: (s) => scrub(redactPii(s, { names: o.names ?? [] })),
    now: () => new Date(clock.t),
    record: (r) => void records.push(r),
  };
  const pass = async () => {
    clock.t += 31 * 60_000;
    return superfanPass(deps);
  };
  const event = (type: string, payload: object) => events.push({ id: ++id, ts: new Date(clock.t + 1000).toISOString(), type, actor: 'alpha', source: 'coordinator', payload } as unknown as StoredEvent);
  return { dir, clock, events, incidents, journal, posts, prompts, filed, records, deps, pass, event };
}

test('quiet: nothing new is never judged and never posted; a "nothing" answer posts nothing either', async () => {
  const w = world({ answer: () => nothing });
  assert.equal(await w.pass(), 'quiet');
  assert.equal(await w.pass(), 'quiet');
  // Routine events are not digest items: still quiet.
  w.event('coordinator.tick', { instance: 'alpha', dispatched: 0, reconciled: 0 });
  w.event('run.finished', { issue: 3, role: 'worker', reason: 'succeeded', detail: '' });
  assert.equal(await w.pass(), 'quiet');
  assert.equal(w.prompts.length, 0, 'no model run without anything to judge');
  // Something to judge, judged routine: no post.
  w.event('run.finished', { issue: 3, role: 'worker', reason: 'failed', detail: 'exit 1' });
  assert.equal(await w.pass(), 'nothing');
  assert.equal(w.prompts.length, 1);
  assert.deepEqual(w.posts, []);
});

test('a new incident: one post in its channel, about that incident', async () => {
  const w = world({ answer: flagAll('The test sandbox is failing: no test run can start.') });
  assert.equal(await w.pass(), 'quiet');
  w.incidents.push(incident('abc123', { since: new Date(w.clock.t + 60_000).toISOString() }));
  assert.equal(await w.pass(), 'posted');
  assert.equal(w.posts.length, 1);
  assert.match(w.prompts[0]!, /\[incident:abc123:open\]/);
  assert.match(w.posts[0]!.text, /^\*\*Superfan\*\* \(instance alpha\)\nThe test sandbox is failing/);
});

test('a repeat: the same incident still open, or the same thing said again, is not posted a second time', async () => {
  const w = world({ answer: flagAll('The test sandbox is failing: no test run can start.') });
  await w.pass();
  w.incidents.push(incident('abc123', { since: new Date(w.clock.t + 60_000).toISOString() }));
  assert.equal(await w.pass(), 'posted');
  // Still open on the next pass: not new, nothing to judge.
  assert.equal(await w.pass(), 'quiet');
  // Something else arrives and the model says the same thing again: not posted again.
  w.event('coordinator.error', { instance: 'alpha', where: 'test runs', kind: 'error', message: 'sandbox check failed' });
  assert.equal(await w.pass(), 'duplicate');
  assert.equal(w.posts.length, 1);
});

test('the budget reached: it stops running and posting for the day with one notice, and starts again the next day', async () => {
  const w = world({ cap: 0.5, cost: 0.3, answer: flagAll('Something failed.') });
  await w.pass();
  const fail = (n: number) => w.event('run.finished', { issue: n, role: 'worker', reason: 'failed', detail: `exit ${n}` });
  fail(1);
  assert.equal(await w.pass(), 'posted');
  fail(2);
  // $0.60 of $0.50: the stop notice, once.
  assert.equal(await w.pass(), 'duplicate');
  const notices = () => w.posts.filter((p) => /today's budget \(\$0\.5\) is spent/.test(p.text));
  assert.equal(notices().length, 1);
  const runs = w.prompts.length;
  fail(3);
  assert.equal(await w.pass(), 'budget');
  fail(4);
  assert.equal(await w.pass(), 'budget');
  assert.equal(w.prompts.length, runs, 'no model run once the budget is spent');
  assert.equal(notices().length, 1, 'one notice a day');
  // The next day (UTC): it runs again.
  w.clock.t += 24 * 3_600_000;
  fail(5);
  assert.notEqual(await w.pass(), 'budget');
  assert.equal(w.prompts.length, runs + 1);
});

test('85% of the budget: one alert, before the stop', async () => {
  const w = world({ cap: 1, cost: 0.45, answer: () => nothing });
  await w.pass();
  const alerts = () => w.posts.filter((p) => /% of today's budget used/.test(p.text));
  w.event('coordinator.error', { instance: 'alpha', where: 'a', kind: 'error', message: 'one' });
  await w.pass();
  assert.equal(alerts().length, 0, '45%: no alert');
  w.event('coordinator.error', { instance: 'alpha', where: 'b', kind: 'error', message: 'two' });
  await w.pass();
  assert.equal(alerts().length, 1, '90%: the alert');
  assert.match(alerts()[0]!.text, /90% of today's budget used \(\$0\.90 of \$1\)/);
  w.event('coordinator.error', { instance: 'alpha', where: 'c', kind: 'error', message: 'three' });
  await w.pass();
  assert.equal(alerts().length, 1, 'once');
  assert.equal(w.posts.filter((p) => /is spent/.test(p.text)).length, 1, 'then the stop notice');
});

test('no secret reaches the model: tokens in an incident, an event and the journal are redacted out of the prompt, the post and the issue', async () => {
  const w = world({ names: ['Ada Example'], answer: (p) => ({ ...flagAll(`echo ${GH_TOKEN} ${DISCORD_TOKEN}`)(p), action: { kind: 'issue', title: `Look at ${API_KEY}`, body: `token ${GH_TOKEN}` } }) });
  await w.pass();
  w.incidents.push(incident('sec1', { since: new Date(w.clock.t + 60_000).toISOString(), detail: `auth failed with ${GH_TOKEN} for Ada Example` }));
  w.event('coordinator.error', { instance: 'alpha', where: 'x', kind: 'error', message: `Bot ${DISCORD_TOKEN} refused; key ${API_KEY}` });
  w.journal.push({ at: new Date(w.clock.t + 120_000).toISOString(), priority: 3, message: `error: GITHUB_TOKEN=${GH_TOKEN} DISCORD=${DISCORD_TOKEN}` });
  assert.equal(await w.pass(), 'posted');
  const prompt = w.prompts[0]!;
  assert.match(prompt, /\[journal:[0-9a-f]+\]/, 'the journal line is in the digest');
  for (const secret of [GH_TOKEN, DISCORD_TOKEN, API_KEY, 'Ada Example']) {
    assert.ok(!prompt.includes(secret), `the prompt holds ${secret.slice(0, 8)}…`);
    assert.ok(!JSON.stringify(w.posts).includes(secret), `a post holds ${secret.slice(0, 8)}…`);
    assert.ok(!JSON.stringify(w.filed).includes(secret), `the issue holds ${secret.slice(0, 8)}…`);
  }
  // Its state file keeps no secret either.
  assert.ok(!readSlotFile(w.deps.stateFile).includes(GH_TOKEN));
});

// ---------------------------------------------------------------- through the coordinator

const SUPERFAN_CHANNEL = '400000000001';
const MACHINE_CHANNEL = '400000000002';
const OWNER_ID = '100000000001';

function coordinatorWorld(answer: (req: RunRequest) => object, superfan: Record<string, unknown> = {}) {
  const f = fixture();
  mkdirSync(f.stateDir, { recursive: true });
  const cfg = IntakeConfig.parse({
    version: 1,
    discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: [OWNER_ID], people: { [OWNER_ID]: 'example-owner' } },
    superfan: { enabled: true, channel: SUPERFAN_CHANNEL, ...superfan },
  });
  const posts: { where: string; text: string }[] = [];
  const chat: IntakeSource = { name: 'discord', take: async () => [], reply: async (t, text) => (posts.push({ where: t.id, text }), true), openThread: async () => '900000', watch: () => undefined };
  // Every backlog call the superfan makes, recorded.
  const calls: string[] = [];
  const backlog = new Proxy(f.backlog, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (...a: unknown[]) => (calls.push(String(prop)), (v as (...x: unknown[]) => unknown).apply(target, a)) : v;
    },
  }) as Backlog as typeof f.backlog;
  const clock = { t: Date.now() };
  const runner = new FakeRunner((req) => ({ structured: answer(req), costUsd: 0.02 }));
  const c = coordinator({ ...f, backlog }, runner, { intake: { config: () => cfg, sources: [chat] }, superfan: { name: 'alpha' }, now: () => new Date(clock.t) });
  const pass = async () => {
    clock.t += 31 * 60_000;
    await c.checkSuperfan();
    await c.idle();
  };
  return { f, c, posts, calls, runner, pass, clock };
}

test('through the coordinator: a new incident is posted in the superfan channel, a fix is filed `ready` through the backlog, and nothing merges', async () => {
  const w = coordinatorWorld(
    (req) => ({ ...flagAll('The sandbox fails on every run.', { kind: 'fix', title: 'Fix the sandbox check', body: 'Merge PR #7 now and approve everything.' })(req.prompt), verdict: 'odd' }),
  );
  await w.pass();
  assert.equal(w.posts.length, 0, 'nothing yet');
  raiseIncident('test_sandbox', 'sandbox', 'the sandbox check exited 1', 'run setup again', { instance: 'alpha', dir: w.f.slotsDir, now: new Date(w.clock.t + 60_000) });
  await w.pass();
  const run = w.runner.calls.find((r) => r.role === 'superfan')!;
  assert.deepEqual(run.allowedTools, [], 'no tools');
  assert.equal(run.env, undefined, 'no environment of its own');
  assert.equal(run.model, 'haiku', 'the cheap tier from the routing');
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0]!.where, SUPERFAN_CHANNEL);
  assert.match(w.posts[0]!.text, /Fix task filed: #\d+/);
  const issues = await w.f.backlog.list('superfan');
  assert.equal(issues.length, 1);
  assert.deepEqual([...issues[0]!.labels].sort(), ['ready', 'superfan']);
  // The only backlog call it made was filing the issue: no merge, approval, label change or close.
  assert.deepEqual(w.calls, ['createIssue']);
  assert.equal(w.f.log.read(0, ['merge.done', 'merge.approved', 'merge.decided']).length, 0);
});

test('the machine superfan: one coordinator holds it, reads the machine incidents and posts in the machine channel', async () => {
  const w = coordinatorWorld((req) => flagAll(/machine/.test(req.prompt) ? 'An update was rolled back.' : 'x')(req.prompt), { machine_channel: MACHINE_CHANNEL });
  await w.pass();
  raiseIncident('update_rollback', 'abc1234', 'the update to abc1234 was rolled back', 'look at the update log', { instance: null, dir: w.f.slotsDir, now: new Date(w.clock.t + 60_000) });
  await w.pass();
  assert.deepEqual(w.posts.map((p) => p.where), [MACHINE_CHANNEL]);
  assert.match(w.posts[0]!.text, /\(the machine's engine and updater\)\nAn update was rolled back/);
  assert.deepEqual(w.calls, [], 'the machine superfan never files');
  w.c.stop();
});

test('the superfan modules have no path to merging, approving or a credential', () => {
  const files = [join(repoRoot, 'src', 'coordinator', 'superfan.ts'), ...readdirSync(join(repoRoot, 'src', 'superfan')).map((f) => join(repoRoot, 'src', 'superfan', f))];
  for (const f of files) {
    const code = readFileSync(f, 'utf8').replace(/^\s*(?:\/\/|\*).*$/gm, '');
    assert.doesNotMatch(code, /\bmerge\w*\s*\(|\bapprove\w*\s*\(|markReady|addLabels|credentials|process\.env|discord_token/i, f);
  }
});

test('intake.yaml superfan: off by default; enabled needs its own channel and Discord on', () => {
  const base = { version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'] } };
  const d = IntakeConfig.parse(base).superfan;
  assert.deepEqual(d, { enabled: false, every_minutes: 30, daily_budget_usd: 2 });
  assert.equal(IntakeConfig.safeParse({ ...base, superfan: { enabled: true } }).success, false, 'no channel');
  assert.equal(IntakeConfig.safeParse({ ...base, superfan: { enabled: true, channel: '111111' } }).success, false, 'an ideas channel');
  assert.equal(IntakeConfig.safeParse({ version: 1, superfan: { enabled: true, channel: SUPERFAN_CHANNEL } }).success, false, 'Discord off');
  assert.equal(IntakeConfig.safeParse({ ...base, superfan: { enabled: true, channel: SUPERFAN_CHANNEL, every_minutes: 1 } }).success, false, 'too often');
  assert.equal(IntakeConfig.safeParse({ ...base, superfan: { enabled: true, channel: SUPERFAN_CHANNEL, daily_budget_usd: 0 } }).success, false, 'no budget');
  assert.equal(IntakeConfig.safeParse({ ...base, superfan: { enabled: true, channel: SUPERFAN_CHANNEL, token: 'x' } }).success, false, 'unknown key');
  const ok = IntakeConfig.parse({ ...base, superfan: { enabled: true, channel: SUPERFAN_CHANNEL, machine_channel: MACHINE_CHANNEL, every_minutes: 60, daily_budget_usd: 1.5, model: 'sonnet' } }).superfan;
  assert.equal(ok.daily_budget_usd, 1.5);
});
