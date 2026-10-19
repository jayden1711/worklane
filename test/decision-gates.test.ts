// Who may approve, the same on every surface, and the money paths read from main (#715): a writer's GitHub comment
// doesn't approve a high-risk merge unless review.yaml on main lets writers, `decide` from the CLI is refused to
// anyone but root and the coordinator user, and a change is judged by main's money-path list, never the checkout's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startConfig } from '../src/config/live.js';
import type { ReviewConfig } from '../src/config/schema.js';
import { DEFAULT_REVIEW } from '../src/coordinator/shared.js';
import type { Coordinator } from '../src/coordinator.js';
import { mayAnswerKind } from '../src/dashboard-auth.js';
import * as decide from '../src/decide.js';
import { EventLog } from '../src/events/log.js';
import { PolicyFile, policyViolations } from '../src/instance.js';
import type { EventPayload } from '../src/events/types.js';
import { isRoot } from '../src/os/index.js';
import { FakeRunner } from '../src/runner.js';
import { logPath } from '../src/service.js';
import { engineCli, exampleProject, exampleRoles } from './helpers.js';
import { coordinator, fixture, git, skip, type Fixture } from './repro-state-graph/harness.js';

const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];
const WRITER = 'example-collaborator';
const OWNER = 'example-owner';

/** A person's clone of the fixture's remote: `push` writes files there and pushes them to `branch`. */
function person(f: Fixture) {
  const dir = join(mkdtempSync(join(tmpdir(), 'person-')), 'p');
  git(f.base, 'clone', '-q', f.remote, dir);
  const push = (files: Record<string, string>, branch = 'main') => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    git(dir, 'add', '--', ...Object.keys(files));
    git(dir, ...ident, 'commit', '-q', '-m', `edit ${Object.keys(files).join(', ')}`);
    git(dir, 'push', '-q', 'origin', `HEAD:${branch}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, push };
}

/** A `land` decision on an open issue, its level recorded, as the coordinator asks one. */
function askLand(f: Fixture, kind: EventPayload<'decision.asked'>['kind'] = 'land') {
  const n = f.backlog.open({ title: 'Totals', body: 'b', author: OWNER, labels: [] });
  const id = `d-${kind}-${n}`;
  f.log.append('decision.asked', { id, kind, issue: n, owner: OWNER, question: 'Land it?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'alice');
  f.log.append('review.level_set', { issue: n, head: 'a'.repeat(40), level: 'L3', reasons: ['money-path: src/price.js'] }, 'alice');
  return { n, id };
}

const handleDecisions = (c: Coordinator) => (c as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
const of = <T>(f: Fixture, type: Parameters<Fixture['log']['read']>[1] extends (infer U)[] | undefined ? U : never) => f.log.read(0, [type]).map((e) => e.payload as T);

test('the one rule: a high-risk merge is the owners\' unless review.yaml lets writers; plans stay the owners\'', () => {
  assert.equal(mayAnswerKind('land', 'writer'), false);
  assert.equal(mayAnswerKind('land', 'writer', { land: 'owners' }), false);
  assert.equal(mayAnswerKind('land', 'writer', { land: 'writers' }), true);
  assert.equal(mayAnswerKind('land', 'viewer', { land: 'writers' }), false);
  assert.equal(mayAnswerKind('land', 'owner'), true);
  assert.equal(mayAnswerKind('plan', 'writer', { land: 'writers' }), false, 'the setting is for land only');
  assert.equal(mayAnswerKind('question', 'writer'), true);
});

test("GitHub comment: a writer's /<cli> approve doesn't land a held change when policy says owners only; an owner's does", { skip }, async () => {
  const f = fixture();
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { roleOf: exampleRoles });
  const { n, id } = askLand(f);
  f.backlog.humanComment(n, WRITER, `/${BRAND.cli} approve`);
  await handleDecisions(c);
  assert.equal(of(f, 'land.queued').length, 0, 'a writer approved nothing');
  assert.equal(of(f, 'decision.answered').length, 0);
  // A writer's comment still answers what writers answer (a question), and an owner's approves the merge.
  const q = askLand(f, 'question');
  f.backlog.humanComment(q.n, WRITER, `/${BRAND.cli} approve`);
  f.backlog.humanComment(n, OWNER, `/${BRAND.cli} approve`);
  await handleDecisions(c);
  const answered = of<EventPayload<'decision.answered'>>(f, 'decision.answered');
  assert.deepEqual(answered.map((a) => [a.id, a.by, a.role]), [[id, OWNER, 'owner'], [q.id, WRITER, 'writer']]);
  assert.equal(of<EventPayload<'land.queued'>>(f, 'land.queued')[0]?.issue, n);
});

test('GitHub comment: a listed writer whose repo role is viewer, or whose role lookup fails, answers nothing', { skip }, async () => {
  for (const roleOf of [async () => 'viewer' as const, async () => Promise.reject(new Error('GitHub 502'))]) {
    const f = fixture();
    const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { roleOf });
    const q = askLand(f, 'question');
    const land = askLand(f);
    f.backlog.humanComment(q.n, WRITER, `/${BRAND.cli} approve`);
    f.backlog.humanComment(land.n, OWNER, `/${BRAND.cli} approve`);
    await handleDecisions(c);
    assert.deepEqual(of(f, 'decision.answered'), []);
    assert.deepEqual(of(f, 'land.queued'), []);
  }
});

test("GitHub comment: a held plan is the owners' too, as on the dashboard; review.yaml's approvals: { land: writers } lets a writer land", { skip }, async () => {
  const f = fixture();
  f.cfg.review = { ...(f.cfg.review ?? DEFAULT_REVIEW), approvals: { land: 'writers' } } as ReviewConfig;
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { roleOf: exampleRoles, writersApproveLand: () => true });
  const plan = askLand(f, 'plan');
  f.backlog.humanComment(plan.n, WRITER, `/${BRAND.cli} approve`);
  const land = askLand(f);
  f.backlog.humanComment(land.n, WRITER, `/${BRAND.cli} approve`);
  await handleDecisions(c);
  assert.deepEqual(of<EventPayload<'decision.answered'>>(f, 'decision.answered').map((a) => [a.id, a.by]), [[land.id, WRITER]]);
  assert.equal(of<EventPayload<'land.queued'>>(f, 'land.queued')[0]?.issue, land.n);
});

test('the dashboard and chat path (answerDecision): a writer is refused a high-risk merge unless approvals lets writers', () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'gates-')), 'events.db'));
  for (const id of ['d-1', 'd-2']) log.append('decision.asked', { id, kind: 'land', issue: 1, owner: OWNER, question: 'Land?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'alice');
  const who = { login: WRITER, role: 'writer' as const, via: 'session' as const };
  const no = decide.answerDecision(log, { id: 'd-1', answer: 'approve', who, instance: null, repo: 'example/shop' });
  assert.equal(no.ok, false);
  assert.equal(!no.ok && no.status, 403);
  assert.equal(decide.answerDecision(log, { id: 'd-2', answer: 'approve', who, instance: null, repo: 'example/shop', approvals: { land: 'writers' } }).ok, true);
  log.close();
});

test("who may approve is read from main's review.yaml, never the checkout's working tree", () => {
  const f = fixture();
  const p = person(f);
  const review = join(BRAND.configDir, 'review.yaml');
  writeFileSync(join(f.repo, review), `${readFileSync(join(f.repo, review), 'utf8')}approvals: { land: writers }\n`);
  assert.equal(decide.approvalsAt(f.repo, 'origin/main', true), undefined, 'a hand edit to the checkout changes nothing');
  p.push({ [review]: `${readFileSync(join(p.dir, review), 'utf8')}approvals: { land: writers }\n` });
  git(f.repo, 'fetch', '-q', 'origin');
  assert.deepEqual(decide.approvalsAt(f.repo, 'origin/main', true), { land: 'writers' });
  assert.equal(decide.approvalsAt(f.repo, 'origin/main', false), undefined, "an instance whose root policy doesn't let writers: the owners alone");
  p.push({ [review]: `${readFileSync(join(p.dir, review), 'utf8')}not_a_setting: 1\n` });
  git(f.repo, 'fetch', '-q', 'origin');
  assert.equal(decide.approvalsAt(f.repo, 'origin/main', true), undefined, 'an invalid config on main: the owners alone');
});

test("letting writers approve a high-risk merge needs the instance's policy.yaml too: off by default, read on every approval, and turning it off never refuses the config", { skip }, async () => {
  const cfg = fixture().cfg;
  cfg.project.land_mode = 'pr';
  cfg.review = { ...(cfg.review ?? DEFAULT_REVIEW), approvals: { land: 'writers' } } as ReviewConfig;
  const policy = PolicyFile.parse({ version: 1, budget: { daily_usd: 1_000_000 }, agents: { max_workers: 32 } });
  assert.equal(policy.writers_approve_land, false, 'off unless root turns it on');
  assert.deepEqual(policyViolations(cfg, policy), [], 'the instance still starts: the setting is ignored, not refused');
  // The coordinator reads the policy's switch on every approval: off, a writer's comment approves nothing.
  const f = fixture();
  f.cfg.review = cfg.review;
  let on = true;
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { roleOf: exampleRoles, writersApproveLand: () => on });
  on = false;
  const { n } = askLand(f);
  f.backlog.humanComment(n, WRITER, `/${BRAND.cli} approve`);
  await handleDecisions(c);
  assert.equal(of(f, 'land.queued').length, 0);
  on = true;
  await handleDecisions(c);
  assert.equal(of(f, 'land.queued').length, 1);
  // No switch wired at all (or one that throws): owners only, fail closed.
  for (const writersApproveLand of [undefined, () => { throw new Error('policy.yaml unreadable'); }]) {
    const g = fixture();
    g.cfg.review = cfg.review;
    const d = coordinator(g, new FakeRunner(() => ({ structured: {} })), { roleOf: exampleRoles, ...(writersApproveLand ? { writersApproveLand } : {}) });
    const held = askLand(g);
    g.backlog.humanComment(held.n, WRITER, `/${BRAND.cli} approve`);
    await handleDecisions(d);
    assert.equal(of(g, 'land.queued').length, 0);
  }
});

test('CLI: decide is refused to anyone but root and the coordinator user', () => {
  const me = { user: 'someone', uid: 1234, root: false };
  assert.match(decide.cliDecideRefusal(me, { instance: 'shop', coordinatorUser: 'wl-shop', logUid: null }) ?? '', /only root or shop's coordinator user \(wl-shop\)/);
  assert.equal(decide.cliDecideRefusal({ ...me, user: 'wl-shop' }, { instance: 'shop', coordinatorUser: 'wl-shop', logUid: null }), null);
  assert.equal(decide.cliDecideRefusal({ ...me, root: true }, { instance: 'shop', coordinatorUser: 'wl-shop', logUid: null }), null);
  // A local site: the user whose event log it is.
  assert.match(decide.cliDecideRefusal(me, { instance: null, coordinatorUser: null, logUid: 999 }) ?? '', /only root or the user whose event log it is/);
  assert.equal(decide.cliDecideRefusal(me, { instance: null, coordinatorUser: null, logUid: 1234 }), null);
  assert.match(decide.cliDecideRefusal(me, { instance: null, coordinatorUser: null, logUid: null }) ?? '', /refused|only root/);
});

/** A checkout with one land decision asked in its local event log. */
function localDecision() {
  const { dir } = exampleProject();
  const log = new EventLog(logPath(dir));
  log.append('decision.asked', { id: 'd-cli', kind: 'land', issue: 1, owner: OWNER, question: 'Land?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'alice');
  log.close();
  const answers = () => {
    const l = new EventLog(logPath(dir));
    try {
      return { answered: l.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>), audit: l.read(0, ['dashboard.audit']).map((e) => e.payload as EventPayload<'dashboard.audit'>) };
    } finally {
      l.close();
    }
  };
  return { dir, answers };
}

const cli = (...args: string[]) => spawnSync(process.execPath, [engineCli, ...args], { encoding: 'utf8', timeout: 60_000 });

test("CLI: `decide` from an unprivileged user (not root, not the instance's coordinator user) is refused, and nothing is recorded", { skip: isRoot() && 'runs as root' }, () => {
  const { dir, answers } = localDecision();
  const r = cli('decide', 'd-cli', 'approve', '--instance', 'example', '--root', dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /refused: only root or example's coordinator user/);
  assert.deepEqual(answers().answered, []);
  // The environment can't name another user: who runs it is the OS's word (getpwuid), not USER, LOGNAME or SUDO_USER.
  const spoof = spawnSync(process.execPath, [engineCli, 'decide', 'd-cli', 'approve', '--instance', 'example', '--root', dir], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, USER: 'wl-example', LOGNAME: 'wl-example', SUDO_USER: 'wl-example' } });
  assert.notEqual(spoof.status, 0, spoof.stdout);
  assert.deepEqual(answers().answered, []);
});

test("CLI: `decide` by the user whose event log it is records the instance's owner, the CLI and the OS user", { skip: isRoot() && 'runs as root' }, () => {
  const { dir, answers } = localDecision();
  assert.equal(statSync(logPath(dir)).uid, process.getuid?.());
  // A fake `id` first on PATH, printing another uid, changes nothing: the caller's uid is the kernel's (geteuid).
  const bin = mkdtempSync(join(tmpdir(), 'fake-id-'));
  writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 4242\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [engineCli, 'decide', 'd-cli', 'approve', '--root', dir], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  assert.equal(r.status, 0, r.stderr);
  const got = answers();
  assert.deepEqual(got.answered.map((a) => [a.id, a.by, a.answer, a.role]), [['d-cli', loadConfig(dir).project.owners.default, 'approve', 'owner']]);
  const audit = got.audit.find((a) => a.action === 'decision.answered')!;
  assert.equal(audit.via, 'cli');
  assert.equal(audit.detail.os_user, userInfo().username);
});

/** A PR at `head` waiting on the merge decision, as the PR watch has it (claimed at `base`). */
function prAt(f: Fixture, n: number, base: string, head: string) {
  f.log.append('issue.claimed', { issue: n, instance: 'alice', lease: base, base, owner: OWNER }, 'alice');
  return { number: 7, head: 'pr', headSha: head, state: 'open', title: 't', url: 'u', mergeable: true, mergeableState: 'clean' } as unknown as Parameters<Coordinator['mergeDecisionFor']>[2];
}

test("money paths: a PR that edits the money-path list is judged by main's list, which moved after the clone", { skip }, () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.review = { ...(f.cfg.review ?? DEFAULT_REVIEW), money_path_source: { file: 'money-paths.txt' } } as ReviewConfig;
  const p = person(f);
  p.push({ 'money-paths.txt': '# nothing yet\n' });
  // The coordinator's clone as made at this point: its working tree has the old list, and only refs move after.
  git(f.repo, 'pull', '-q', 'origin', 'main');
  const base = p.push({ 'money-paths.txt': 'src/price.js\n' });
  // The PR drops the file from the list and changes it in the same push.
  git(p.dir, 'checkout', '-q', '-b', 'pr');
  const head = p.push({ 'money-paths.txt': '# nothing\n', 'src/price.js': `${readFileSync(join(p.dir, 'src/price.js'), 'utf8')}// changed\n` }, 'pr');
  git(f.repo, 'fetch', '-q', 'origin');
  assert.equal(readFileSync(join(f.repo, 'money-paths.txt'), 'utf8'), '# nothing yet\n', 'the checkout still has the list from its clone');
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })));
  const d = c.mergeDecisionFor(1, 7, prAt(f, 1, base, head));
  assert.equal(d.auto, false);
  assert.ok(d.reasons.some((r) => /high-risk: money-path \(.*src\/price\.js/.test(r)), d.reasons.join('; '));
  // A PR that edits only the list waits for the owner too: the list file is a money path.
  git(p.dir, 'checkout', '-q', '-b', 'list-only', 'main');
  const only = p.push({ 'money-paths.txt': '# none\n' }, 'list-only');
  git(f.repo, 'fetch', '-q', 'origin');
  const listOnly = c.mergeDecisionFor(2, 7, prAt(f, 2, base, only));
  assert.ok(listOnly.reasons.some((r) => /high-risk: money-path \(money-paths\.txt\)/.test(r)), listOnly.reasons.join('; '));
});

test("config at start: main's config invalid, the checkout's committed one runs, never a hand edit to its working tree", { skip }, () => {
  const f = fixture();
  const p = person(f);
  const file = join(BRAND.configDir, 'config.yaml');
  const committed = loadConfig(f.repo).project.required_checks;
  p.push({ [file]: `${readFileSync(join(p.dir, file), 'utf8')}not_a_setting: true\n` });
  git(f.repo, 'fetch', '-q', 'origin');
  const local = join(f.repo, file);
  writeFileSync(local, `${readFileSync(local, 'utf8').replace(/^required_checks:.*\n/m, '')}required_checks: [hand-edited]\n`);
  const start = startConfig({ repo: f.repo, remote: 'origin', fallback: loadConfig(f.repo) });
  assert.match(start.note ?? '', /is invalid, started with the checkout's/);
  assert.deepEqual(start.cfg.project.required_checks, committed);
});

test("config at start: no config on main at all, the checkout's committed one runs, never a hand edit to its working tree", { skip }, () => {
  const f = fixture();
  const p = person(f);
  const file = join(BRAND.configDir, 'config.yaml');
  const committed = loadConfig(f.repo).project.required_checks;
  git(p.dir, 'rm', '-q', '-r', '--', BRAND.configDir);
  git(p.dir, ...ident, 'commit', '-q', '-m', 'drop the config');
  git(p.dir, 'push', '-q', 'origin', 'HEAD:main');
  git(f.repo, 'fetch', '-q', 'origin');
  const local = join(f.repo, file);
  writeFileSync(local, `${readFileSync(local, 'utf8').replace(/^required_checks:.*\n/m, '')}required_checks: [hand-edited]\n`);
  const start = startConfig({ repo: f.repo, remote: 'origin', fallback: loadConfig(f.repo) });
  assert.match(start.note ?? '', /no \S+ at origin\/main: started with the checkout's/);
  assert.deepEqual(start.cfg.project.required_checks, committed);
});
