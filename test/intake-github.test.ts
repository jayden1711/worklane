// INVARIANT: an outsider's intake-labelled issue is labelled `ready` only when trusted or approved; otherwise it
// stays in triage with the reason posted (src/intake/github.ts, src/coordinator/intake.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { GitHubError } from '../src/backlog/github.js';
import type { Issue } from '../src/backlog/types.js';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { NEEDS_INFO_REPLY, statusReply } from '../src/intake/decide.js';
import { GitHubIssuesIntake, INTAKE_LABEL } from '../src/intake/github.js';
import { IntakeConfig } from '../src/intake/report.js';
import { storeRaw } from '../src/intake/store.js';
import { intakeForInstance } from '../src/intake/wire.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DRAFT = { title: 'Totals ignore discounts', body: '**Outcome:** Totals apply discounts.\n**Sources:** the totals code.\n**Constraints:** leave tax handling alone.\n**Deliverable:**\n```done_when\n- command: |\n    npm test -- --grep "discount: applied"\n```\n**Review point:** L1; waits for the owner if it changes pricing rules.\n' };

test('github intake: the label comes from the brand, and the source is off by default', () => {
  assert.equal(INTAKE_LABEL.name, `${BRAND.cli}:intake`);
  const c = IntakeConfig.parse({ version: 1 });
  assert.deepEqual(c.github, { enabled: false, poll_minutes: 5 });
  assert.deepEqual(c.trusted.github, []);
  assert.deepEqual(IntakeConfig.parse({ version: 1, trusted: { github: ['Some-One'] } }).trusted.github, ['some-one'], 'logins compare case-insensitively');
  assert.equal(IntakeConfig.safeParse({ version: 1, github: { poll_minutes: 0 } }).success, false, 'never more than once a minute');
});

function issue(n: number, o: Partial<Issue> = {}): Issue {
  return { number: n, title: `Issue ${n}`, body: 'the total is wrong', labels: [INTAKE_LABEL.name], author: 'outsider', assignees: [], state: 'open', ...o };
}

test('github intake: takes open labelled issues not yet seen, never ready ones or bots, and polls at most every poll_minutes', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gh-intake-'));
  let lists = 0;
  let now = 1_000_000;
  const issues = [issue(3), issue(1, { labels: [INTAKE_LABEL.name, 'ready'] }), issue(2, { author: 'dependabot[bot]' }), issue(4, { body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked' })];
  const src = new GitHubIssuesIntake({ backlog: { list: async (l) => (lists++, l === INTAKE_LABEL.name ? issues : []), comment: async () => {} }, stateDir, config: () => ({ enabled: true, poll_minutes: 5 }), now: () => now });
  const got = await src.take();
  assert.deepEqual(got.map((r) => r.sourceId), ['3', '4']);
  assert.deepEqual(got[0]!.sender, { source: 'github', id: 'outsider' });
  assert.deepEqual(got[0]!.thread, { kind: 'channel', id: '3' });
  assert.doesNotMatch(got[1]!.text, /ghp_abcdef/, 'secrets are out before it is stored');
  assert.deepEqual(await src.take(), [], 'within poll_minutes: nothing');
  assert.equal(lists, 1, 'and no request');
  storeRaw(stateDir, got[0]!);
  now += 5 * 60_000;
  assert.deepEqual((await src.take()).map((r) => r.sourceId), ['4'], 'a seen issue is never taken again');
  assert.equal(lists, 2);
});

test("github intake: a rate limit's retry-after holds the next listing back", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gh-intake-'));
  let lists = 0;
  let now = 0;
  const src = new GitHubIssuesIntake({
    backlog: {
      list: async () => {
        lists++;
        throw new GitHubError(403, 'rate_limited', 'slow down', 3600);
      },
      comment: async () => {},
    },
    stateDir,
    config: () => ({ enabled: true, poll_minutes: 1 }),
    now: () => now,
  });
  await assert.rejects(src.take(), /rate_limited/);
  now += 10 * 60_000;
  assert.deepEqual(await src.take(), []);
  assert.equal(lists, 1, 'not again before the hour is up');
  now = 3600_000;
  await assert.rejects(src.take());
  assert.equal(lists, 2);
});

function setup(o: { triage?: (req: RunRequest) => object; trusted?: string[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'gh-intake-coord-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  const config = IntakeConfig.parse({ version: 1, trusted: { github: o.trusted ?? [] }, github: { enabled: true } });
  const runner = new FakeRunner((req) => ({ structured: (o.triage ?? (() => ({ kind: 'bug', draft: DRAFT })))(req) }));
  let now = Date.parse('2026-10-01T10:00:00.000Z');
  const github = new GitHubIssuesIntake({ backlog, stateDir, config: () => config.github, now: () => now });
  const c = new Coordinator({
    cfg: loadConfig(repo),
    log,
    backlog,
    runner,
    repo,
    instance: 'example',
    stateDir,
    slotsDir,
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => config, sources: [github.source()], pullMs: 0 },
  });
  const tick = () => {
    now += 10 * 60_000;
    return c.checkIntake();
  };
  return { backlog, log, runner, c, tick, stateDir };
}

const payloads = (log: EventLog, type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
const comments = async (b: FileBacklog, n: number) => (await b.comments(n)).map((c) => c.body);

test("github intake: an outsider's issue waits for approval in triage; approve labels that issue ready, files nothing new", async () => {
  const t = setup();
  const n = t.backlog.open({ title: 'Discount ignored', body: 'the total ignores my code', author: 'outsider', labels: [INTAKE_LABEL.name] });
  await t.tick();
  assert.deepEqual((await t.backlog.get(n)).labels, [INTAKE_LABEL.name], 'not ready before anyone approves');
  const [q] = payloads(t.log, 'decision.asked');
  assert.equal(q!.kind, 'intake');
  assert.match((await comments(t.backlog, n)).join('\n'), /maintainer approves this before it is taken on/);
  t.log.append('decision.answered', { id: q!.id as string, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  await t.tick();
  await t.tick();
  assert.deepEqual((await t.backlog.get(n)).labels, [INTAKE_LABEL.name, 'ready', 'bug']);
  const after = await comments(t.backlog, n);
  assert.equal(after.filter((b) => b.includes('**Outcome:** Totals apply discounts.')).length, 1, 'the draft goes on it once');
  assert.equal(after.at(-1), statusReply('filed', false));
  assert.equal((await t.backlog.list('bug')).length, 1, 'no second issue');
  assert.deepEqual(payloads(t.log, 'intake.decided').map((p) => [p.answer, p.issue]), [['approve', n]]);
  assert.equal(t.runner.calls.length, 1, 'triaged once');
});

test('github intake: a rejected issue stays in triage with the reason posted', async () => {
  const t = setup();
  const n = t.backlog.open({ title: 'Discount ignored', body: 'the total ignores my code', author: 'outsider', labels: [INTAKE_LABEL.name] });
  await t.tick();
  const [q] = payloads(t.log, 'decision.asked');
  t.log.append('decision.answered', { id: q!.id as string, by: 'example-owner', answer: 'reject' }, 'example-owner', 'human');
  await t.tick();
  assert.deepEqual((await t.backlog.get(n)).labels, [INTAKE_LABEL.name]);
  assert.match((await comments(t.backlog, n)).at(-1)!, /decided not to take this on/);
});

test("github intake: a trusted login's issue is labelled ready at once", async () => {
  const t = setup({ trusted: ['Outsider'] });
  const n = t.backlog.open({ title: 'Discount ignored', body: 'the total ignores my code', author: 'Outsider', labels: [INTAKE_LABEL.name] });
  await t.tick();
  assert.deepEqual((await t.backlog.get(n)).labels, [INTAKE_LABEL.name, 'ready', 'bug']);
  assert.deepEqual(payloads(t.log, 'decision.asked'), []);
});

test('github intake: needs_info and a dropped report stay in triage, saying why (only the engine reason, never agent text)', async () => {
  const a = setup({ triage: () => ({ kind: 'needs_info' }) });
  const n = a.backlog.open({ title: 'broken', body: 'it is broken', author: 'outsider', labels: [INTAKE_LABEL.name] });
  await a.tick();
  assert.deepEqual(await comments(a.backlog, n), [NEEDS_INFO_REPLY]);
  assert.deepEqual((await a.backlog.get(n)).labels, [INTAKE_LABEL.name]);
  const b = setup({ triage: () => ({ kind: 'visit https://evil.example' }) });
  const m = b.backlog.open({ title: 'broken', body: 'it is broken', author: 'outsider', labels: [INTAKE_LABEL.name] });
  await b.tick();
  const [said] = await comments(b.backlog, m);
  assert.equal(said, 'Not taken on as work automatically (triage not accepted); it stays in triage for a maintainer.');
  assert.deepEqual((await b.backlog.get(m)).labels, [INTAKE_LABEL.name]);
});

test("github intake: the report's own issue is never shown as a duplicate candidate", async () => {
  const t = setup();
  const other = t.backlog.open({ title: 'Checkout total ignores discount', body: 'the checkout total ignores the discount', author: 'example-owner', labels: ['bug'] });
  const n = t.backlog.open({ title: 'Checkout total ignores discount', body: 'the checkout total ignores the discount', author: 'outsider', labels: [INTAKE_LABEL.name, 'bug'] });
  await t.tick();
  const shown = JSON.parse(readFileSync(join(t.runner.calls[0]!.cwd, 'candidates.json'), 'utf8')) as { issue?: number }[];
  assert.ok(shown.some((c) => c.issue === other), 'the other issue is a candidate');
  assert.ok(!shown.some((c) => c.issue === n), 'its own issue is not');
});

test('github intake wiring: on in intake.yaml adds the github source; absent, none', () => {
  const h = mkdtempSync(join(tmpdir(), 'gh-wire-'));
  writeFileSync(join(h, 'intake.yaml'), 'version: 1\ngithub:\n  enabled: true\n', { mode: 0o600 });
  const issues = { list: async () => [], comment: async () => {} };
  const on = intakeForInstance({ home: h, repo: 'example/shop', githubToken: async () => 'unused', stateDir: h, issues, log: () => {} })!;
  assert.deepEqual(on.sources.map((s) => s.name), ['github']);
  writeFileSync(join(h, 'intake.yaml'), 'version: 1\n', { mode: 0o600 });
  const off = intakeForInstance({ home: h, repo: 'example/shop', githubToken: async () => 'unused', stateDir: h, issues, log: () => {} })!;
  assert.deepEqual(off.sources, []);
});
