// Feedback routing: CI failures, conflicts and writers' reviews on the harness's own PR go back to the session that
// wrote the change (claude --resume), with a fresh session only when that one is gone. src/coordinator/fix-runs.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { which } from '../src/os/index.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type FakeResult, type RunRequest } from '../src/runner.js';
import { resumeFailed, reviewFeedback } from '../src/review-feedback.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BUG = 'Orders with a zero or negative quantity are counted in totals.\n\n```done_when\n- test: test/price.test.js\n- repro: true\n```\n';
const REPRO = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('ignores non-positive quantities', () => { assert.equal(totalCents([{ cents: 100, qty: -2 }, { cents: 5, qty: 1 }]), 5); });\n`;
const WRITER_SESSION = '3f1c2a4e-1111-4000-8000-00000000c0de';

function commitAll(cwd: string, msg: string) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

/** A "GitHub" remote, the coordinator's clone of the example project, a file backlog and a log; PR mode, fix runs on. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'feedback-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'coordinator-clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'pr';
  cfg.project.required_checks = ['ci'];
  cfg.agents.roles.ci_repair = { enabled: true, model: 'sonnet', max_fixes_per_pr: 2 };
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const machine = { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) };
  return { base, remote, repo, cfg, backlog, log, slotsDir, stateDir: join(base, 'state'), machine };
}

const isFix = (req: RunRequest) => /CI fix run \d|Conflict fix \d|Review fix run \d/.test(req.prompt);

/** A fix that commits a small real change (or, for a conflict, keeps both sides of the conflicted line). */
function fix(req: RunRequest): FakeResult {
  const p = join(req.cwd, 'src', 'price.js');
  if (/Conflict fix \d/.test(req.prompt)) {
    writeFileSync(p, readFileSync(p, 'utf8').replace(/<<<<<<<[\s\S]*?>>>>>>>[^\n]*\n/, '  return items.reduce((sum, { cents, qty }) => sum + (qty > 0 ? cents * qty : 0), 0); // audited\n'));
    commitAll(req.cwd, 'Merge main into the branch, keeping both changes');
    return { structured: { summary: 'kept both sides' }, sessionId: req.resume ?? 'fresh-conflict' };
  }
  writeFileSync(p, `${readFileSync(p, 'utf8')}// fixed after feedback\n`);
  commitAll(req.cwd, 'Address the feedback');
  return { structured: { summary: 'addressed it' }, sessionId: req.resume ?? 'fresh-fix' };
}

/**
 * Scripted agents, claude's way with sessions: the first worker run is session WRITER_SESSION (or `writer`); a run
 * asked to resume a session that isn't in `alive` ends failed at turn 0, as claude does ("No conversation found").
 */
function agents(o: { writer?: string | null; alive?: string[] } = {}) {
  const writer = o.writer === undefined ? WRITER_SESSION : o.writer;
  const alive = new Set(o.alive ?? (writer ? [writer] : []));
  return new FakeRunner((req): FakeResult => {
    if (req.resume && !alive.has(req.resume)) return { reason: 'failed', turns: 0, costUsd: 0, detail: `error_during_execution: No conversation found with session ID: ${req.resume}`, sessionId: req.resume };
    if (req.role === 'evaluator-repro') {
      writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'), REPRO);
      commitAll(req.cwd, 'repro');
      return { structured: { test_path: 'test/repro-qty.test.js', explanation: 'negative qty subtracts' } };
    }
    if (req.role === 'worker' && isFix(req)) return fix(req);
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      commitAll(req.cwd, 'Ignore non-positive quantities in totals');
      return { structured: { summary: 'fixed' }, ...(writer ? { sessionId: writer } : {}) };
    }
    const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)?.[1];
    const files = base ? git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean) : [];
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: files, ...(/both_sides_kept/.test(req.prompt) ? { both_sides_kept: true } : {}) } };
  });
}

/** Runs the task until its PR is open. */
async function openPr(o: Parameters<typeof agents>[0] = {}) {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents(o);
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0, reviewPollMs: 0 });
  await c.tick();
  await c.idle();
  await c.tick();
  const opened = f.log.read(0, ['pr.opened']).at(-1)!.payload as EventPayload<'pr.opened'>;
  const remoteHead = () => git(f.repo, 'ls-remote', 'origin', `refs/heads/${BRAND.cli}/issue-${n}`).split('\t')[0]!;
  const pr = () => f.backlog.prs().find((p) => p.number === opened.number)!;
  const sync = () => f.backlog.setPr(opened.number, { headSha: remoteHead() });
  const finished = (role: string) => f.log.read(0, ['run.finished']).map((e) => e.payload as EventPayload<'run.finished'>).filter((p) => p.role === role);
  const run = async () => {
    await c.tick();
    await c.idle();
  };
  return { f, n, c, runner, opened, pr, sync, finished, run, remoteHead };
}

const failing = (id: number) => [{ name: 'ci', source: 'check_run' as const, status: 'completed', conclusion: 'failure', id }];

test('the session that wrote the change is stored on its run.finished', { skip }, async () => {
  const t = await openPr();
  const worker = t.finished('worker');
  assert.equal(worker.length, 1);
  assert.equal(worker[0]!.session, WRITER_SESSION);
});

test('a CI failure goes back to the writing session: the fix run resumes it, with the log and not the whole brief again', { skip }, async () => {
  const t = await openPr();
  t.f.backlog.setChecks(t.opened.head, failing(11));
  t.f.backlog.setJobLog(11, 'FAILED test/price.test.js - expected 5, got 3\n');
  await t.run();
  const call = t.runner.calls.find((r) => /CI fix run 1/.test(r.prompt));
  assert.ok(call, 'a CI fix run started');
  assert.equal(call.resume, WRITER_SESSION, 'resumed, not a fresh agent');
  assert.match(call.prompt, /expected 5, got 3/);
  assert.doesNotMatch(call.prompt, /Orders with a zero or negative quantity/, 'the session already has the issue');
  const worker = t.runner.calls.find((r) => r.role === 'worker' && !isFix(r))!;
  assert.equal(call.lane, worker.lane, "the same lane, so the same OS user whose home holds the session");
  const fin = t.finished('ci-fix').at(-1)!;
  assert.deepEqual(fin.resume, { outcome: 'resumed', session: WRITER_SESSION, why: '' });
  assert.equal(fin.session, WRITER_SESSION);
  assert.equal((t.f.log.read(0, ['ci_fix.finished']).at(-1)!.payload as { outcome: string }).outcome, 'pushed');
});

test('a merge conflict goes back to the writing session: the conflict fix resumes it', { skip }, async () => {
  const t = await openPr();
  const dir = join(mkdtempSync(join(tmpdir(), 'other-')), 'c');
  git(t.f.base, 'clone', '-q', t.f.remote, dir);
  const p = join(dir, 'src', 'price.js');
  writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty, 0);', 'sum + cents * qty, 0); // audited'));
  git(dir, '-c', 'user.email=o@example.com', '-c', 'user.name=Other', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'Mark the totals line as audited');
  git(dir, 'push', '-q', 'origin', 'main');
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'dirty' });
  await t.run();
  const call = t.runner.calls.find((r) => /Conflict fix 1/.test(r.prompt));
  assert.ok(call, 'a conflict fix run started');
  assert.equal(call.resume, WRITER_SESSION);
  assert.match(call.prompt, /1 hunk\(s\) in 1 file\(s\) conflict/);
  assert.deepEqual(t.finished('conflict-fix').at(-1)!.resume, { outcome: 'resumed', session: WRITER_SESSION, why: '' });
  assert.equal((t.f.log.read(0, ['conflict_fix.finished']).at(-1)!.payload as { outcome: string }).outcome, 'pushed');
});

test("a writer's review on the harness's PR starts a fix run that resumes the writing session, with the review's text and inline comments", { skip }, async () => {
  const t = await openPr();
  t.f.backlog.addReview(t.opened.number, { author: 'example-owner', state: 'CHANGES_REQUESTED', body: 'Please name the guard clause.' });
  const review = t.pr().reviews!.at(-1)!.id;
  t.f.backlog.addReviewComment(t.opened.number, { review, author: 'example-owner', body: 'Extract this into isCountable(qty).', path: 'src/price.js', line: 2 });
  await t.run();
  const call = t.runner.calls.find((r) => /Review fix run 1/.test(r.prompt));
  assert.ok(call, 'a review fix run started');
  assert.equal(call.resume, WRITER_SESSION);
  assert.match(call.prompt, /@example-owner requested changes:\nPlease name the guard clause\./);
  assert.match(call.prompt, /- src\/price\.js:2: Extract this into isCountable\(qty\)\./);
  const started = t.f.log.read(0, ['ci_fix.started']).map((e) => e.payload as EventPayload<'ci_fix.started'>);
  assert.deepEqual(started.map((s) => [s.reviews, s.checks]), [[[review], ['review by @example-owner']]]);
  assert.deepEqual(t.finished('review-fix').at(-1)!.resume, { outcome: 'resumed', session: WRITER_SESSION, why: '' });
  const done = t.f.log.read(0, ['ci_fix.finished']).at(-1)!.payload as { outcome: string; head: string };
  assert.equal(done.outcome, 'pushed');
  assert.equal(t.remoteHead(), done.head);
  assert.ok(t.pr().comments.some((x) => /Review fix run 1 pushed/.test(x.body)));
  // Answered once: the next poll starts nothing for the same review.
  t.sync();
  await t.run();
  assert.equal(t.runner.calls.filter((r) => /Review fix run/.test(r.prompt)).length, 1);
});

test('a session that is gone: the fix falls back to a fresh run with the whole brief, and records that it did', { skip }, async () => {
  const t = await openPr({ alive: [] });
  t.f.backlog.setChecks(t.opened.head, failing(12));
  t.f.backlog.setJobLog(12, 'FAILED test/price.test.js\n');
  await t.run();
  const calls = t.runner.calls.filter((r) => /CI fix run 1/.test(r.prompt));
  assert.deepEqual(calls.map((r) => r.resume ?? null), [WRITER_SESSION, null], 'tried the session, then a fresh run');
  assert.match(calls[1]!.prompt, /Orders with a zero or negative quantity/, 'the fresh run gets the issue');
  const fin = t.finished('ci-fix');
  assert.equal(fin.length, 2);
  assert.match(fin[0]!.detail, /resuming session .* failed: .*No conversation found/);
  assert.equal(fin[1]!.resume!.outcome, 'fresh');
  assert.equal(fin[1]!.resume!.session, WRITER_SESSION);
  assert.match(fin[1]!.resume!.why, /resuming it failed: .*No conversation found/);
  assert.equal(fin[1]!.session, 'fresh-fix', 'the new session is the one a later fix resumes');
  assert.equal((t.f.log.read(0, ['ci_fix.finished']).at(-1)!.payload as { outcome: string }).outcome, 'pushed');
  // No session stored at all: fresh, and said so.
  const u = await openPr({ writer: null });
  u.f.backlog.setChecks(u.opened.head, failing(13));
  u.f.backlog.setJobLog(13, 'FAILED\n');
  await u.run();
  assert.deepEqual(u.runner.calls.filter((r) => /CI fix run 1/.test(r.prompt)).map((r) => r.resume ?? null), [null]);
  assert.deepEqual(u.finished('ci-fix').at(-1)!.resume, { outcome: 'fresh', session: null, why: 'no session stored for this issue' });
});

test('reviews share the per-PR fix cap with CI fixes: past it, the owner is told once and nothing runs', { skip }, async () => {
  const t = await openPr();
  t.f.backlog.setChecks(t.opened.head, failing(14));
  t.f.backlog.setJobLog(14, 'FAILED\n');
  await t.run(); // CI fix 1
  t.sync();
  t.f.backlog.setChecks(t.pr().headSha, []);
  t.f.backlog.addReview(t.opened.number, { author: 'example-collaborator', state: 'COMMENTED', body: 'Add a comment on why.' });
  await t.run(); // review fix 2: the cap (2) is reached
  t.sync();
  t.f.backlog.addReview(t.opened.number, { author: 'example-owner', state: 'CHANGES_REQUESTED', body: 'One more thing.' });
  await t.run();
  await t.run();
  assert.equal(t.f.log.read(0, ['ci_fix.started']).length, 2, 'two fix runs, not three');
  assert.equal(t.runner.calls.filter((r) => /Review fix run/.test(r.prompt)).length, 1);
  const declined = t.f.log.read(0, ['review_fix.declined']).map((e) => e.payload as EventPayload<'review_fix.declined'>);
  assert.equal(declined.length, 1, 'told once');
  assert.match(declined[0]!.reason, /2 fix run\(s\) already, the limit/);
  assert.equal(t.pr().comments.filter((x) => /no fix pushed for them: 2 fix run/.test(x.body)).length, 1);
  assert.ok(t.pr().labels.includes('needs-owner'));
});

test("a person's PR is never touched: a writer's review on it starts nothing and gets no comment", { skip }, async () => {
  const t = await openPr();
  const theirs = await t.f.backlog.openPr('someone/feature', 'main', 'Their change', 'by a person', { headSha: t.opened.head });
  t.f.backlog.addReview(theirs.number, { author: 'example-owner', state: 'CHANGES_REQUESTED', body: 'Please split this.' });
  const before = t.runner.calls.length;
  await t.run();
  assert.equal(t.runner.calls.length, before, 'no run');
  assert.deepEqual(t.f.backlog.prs().find((p) => p.number === theirs.number)!.comments, []);
  assert.equal(t.f.log.read(0, ['review_fix.declined', 'ci_fix.started']).length, 0);
});

test('which reviews start a fix: a writer requesting changes or commenting; never an approval, a non-writer, or the harness itself', () => {
  const r = (id: number, author: string, state: string, body: string) => ({ id, author, state, body, at: '2026-10-13T00:00:00Z' });
  const got = reviewFeedback({
    reviews: [r(1, 'Example-Owner', 'CHANGES_REQUESTED', 'fix x'), r(2, 'example-owner', 'APPROVED', 'nit: y'), r(3, 'stranger', 'CHANGES_REQUESTED', 'z'), r(4, 'example-owner', 'COMMENTED', ''), r(5, 'example-owner', 'COMMENTED', `[${BRAND.cli}] ours`), r(6, 'example-owner', 'COMMENTED', ''), r(7, 'example-owner', 'CHANGES_REQUESTED', 'done before')],
    comments: [{ id: 9, review: 6, author: 'example-owner', body: 'rename', path: 'a.js', line: 3, at: '' }],
    writers: ['example-owner'],
    handled: new Set([7]),
  });
  assert.deepEqual(got.map((x) => x.id), [1, 6]);
  assert.deepEqual(got[1]!.comments, [{ path: 'a.js', line: 3, body: 'rename' }]);
  assert.equal(resumeFailed({ reason: 'failed', turns: 0, detail: 'No conversation found', costUsd: 0, model: 'm' }), true);
  assert.equal(resumeFailed({ reason: 'failed', turns: 4, detail: 'x', costUsd: 0, model: 'm' }), false, 'a resumed run that worked and then failed is not retried fresh');
});
