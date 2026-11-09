// R1182aa (final) on #1182: a bare reply never redirected. An edited or deleted question comment is a barrier, never
// skipped to reach an older question (AA1, AA2, AA1e). Ported from the review's TypeScript (attacks-1182aa), assertions
// unchanged except: AA1's control now expects no answer and a reply_ambiguous note (two questions are open, R1182ab's
// rule), and AA4 (edited from REST's updated_at) is replaced by the GitHub-path test in direct-land-floor-r1182ab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { questionLines } from '../src/coordinator/landing.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = () =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: [] } });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'r1182z-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = REVIEW();
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { base, remote, repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir };
}
type Fixture = ReturnType<typeof fixture>;
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';
const CI = 'test: { script: [echo ok] }\n';
const runner = (extra: Record<string, string>) =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      for (const [f, body] of Object.entries(extra)) {
        mkdirSync(dirname(join(req.cwd, f)), { recursive: true });
        writeFileSync(join(req.cwd, f), body);
      }
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['src/price.js', ...Object.keys(extra)], design_change: false } };
  });
const coord = (f: Fixture, extra: Record<string, string> = {}) =>
  new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(extra), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
async function cycle(f: Fixture, extra: Record<string, string> = {}) {
  const c = coord(f, extra);
  await c.tick();
  await c.idle();
}
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');
const blobOnMain = (f: Fixture, p: string) => {
  try {
    return git(f.base, '--git-dir', f.remote, 'cat-file', '-p', `main:${p}`);
  } catch {
    return null;
  }
};
const errors = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string });
/** Edit a comment in place, as GitHub does: same author, same place, same created_at; the body changes, and it reads as edited. */
async function editComment(f: Fixture, n: number, match: (b: string) => boolean, body: (b: string) => string) {
  const hits = (await f.backlog.comments(n)).filter((c) => match(c.body));
  assert.equal(hits.length, 1, 'control: exactly one comment edited');
  f.backlog.editComment(n, hits[0]!.id!, body(hits[0]!.body));
}
const deleteComment = (f: Fixture, n: number, match: (b: string) => boolean) => {
  const p = join(f.base, 'backlog.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  for (const i of j.issues) if (i.number === n) i.comments = i.comments.filter((c: { body: string }) => !match(c.body));
  writeFileSync(p, JSON.stringify(j));
};

const OPTS = ['approve', 'reject'];
const CMD = /^\/worklane\s+(\S+)/m;
type Answer = { by: string; answer: string; role: string } | null;
const commentAnswer = (f: Fixture, q: EventPayload<'decision.asked'>): Promise<Answer> =>
  (coord(f) as unknown as { commentAnswer(n: number, q: EventPayload<'decision.asked'>, w: Set<string>, c: RegExp): Promise<Answer> }).commentAnswer(1, q, new Set(f.cfg.project.owners.writers.map((w) => w.toLowerCase())), CMD);
/** A question exactly as ask() posts it (src/coordinator/base.ts at 48dacc40), through the coordinator itself. */
const ask = async (f: Fixture, kind = 'land') => {
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask(kind, 1, 'example-owner', 'Land?', OPTS, 'reject', ['x']);
  return f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).find((x) => x.id === id)!;
};
const unit = () => {
  const f = fixture();
  f.backlog.open({ title: 't', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  return f;
};

// ===== Z1: the question's anchor is found by text in ANY comment, by anyone, edited or not =====
// commentAnswer takes the first comment whose body contains `decide <id> ` as the question's own comment
// (decisions.ts:253). Anyone who wrote an earlier comment on the issue (a reporter, a fork contributor, a bot) can edit
// it, keeping its place, to hold `decide <new id> ` (hidden in an HTML comment, it doesn't even render). The owner's
// older bare approval then sits "after the question" and answers the new question.

// ===== AA1: an edited (or minimized: GitHub moves updated_at) newer question comment is skipped by nearest(), so the
// owner's bare reply meant for it answers an OLDER pending question instead =====
test('AA1 control: two pending questions; the owner\'s bare approve after question 2 answers neither, and says which ids to use', async () => {
  const f = unit();
  const d1 = await ask(f);
  const d2 = await ask(f, 'plan');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal(await commentAnswer(f, d2), null, 'changed from the review: two questions are open, so a bare reply answers neither');
  const n = errors(f).filter((e) => e.kind === 'reply_ambiguous');
  assert.ok(n.length >= 1 && n.every((e) => e.message.includes(d1.id) && e.message.includes(d2.id)), JSON.stringify(n));
});

test("AA1: a writer edits question 2's comment (any edit; on GitHub a hide/minimize moves updated_at too): the owner's bare approve meant for question 2 answers the land question 1", async () => {
  const f = unit();
  const d1 = await ask(f);
  const d2 = await ask(f, 'plan');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  await editComment(f, 1, (b) => b.includes(`decide ${d2.id} `), (b) => b + '\n');
  const a1 = await commentAnswer(f, d1);
  assert.equal(a1, null, `REDIRECTED: the owner's reply to question 2 answers question 1 (${JSON.stringify(a1)})`);
});

test("AA2: question 2's comment is deleted (a writer may delete any comment): the owner's bare approve meant for it answers the land question 1", async () => {
  const f = unit();
  const d1 = await ask(f);
  const d2 = await ask(f, 'plan');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  deleteComment(f, 1, (b) => b.includes(`decide ${d2.id} `));
  const a1 = await commentAnswer(f, d1);
  assert.equal(a1, null, `REDIRECTED: the owner's reply to question 2 answers question 1 (${JSON.stringify(a1)})`);
});

// ===== AA3: back-compat: a decision with no decision.posted (asked before this PR, or a backlog with no ids) =====
class NoIdBacklog extends FileBacklog {
  // A backlog that gives no comment id: the empty string, which ask() records nothing for.
  override async comment(n: number, body: string): Promise<string> {
    await super.comment(n, body);
    return '';
  }
}
test('AA3 (held): a question with no decision.posted: a bare reply answers nothing and is noted once; a reply naming the id answers', async () => {
  const f = unit();
  const nb = new NoIdBacklog(join(f.base, 'backlog.json'), 'coordinator');
  const g = { ...f, backlog: nb } as Fixture;
  const d = await ask(g);
  assert.equal(g.log.read(0, ['decision.posted']).length, 0, 'control: nothing recorded');
  nb.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(g, d), null);
  assert.equal(await commentAnswer(g, d), null);
  assert.equal(errors(g).filter((e) => e.kind === 'reply_without_id').length, 1);
  nb.humanComment(1, 'example-owner', `/worklane approve ${d.id}`);
  assert.equal((await commentAnswer(g, d))?.answer, 'approve');
});

test('AA3b (held): a legacy question (no decision.posted) above a new one: a bare reply answers only the new one', async () => {
  const f = unit();
  const nb = new NoIdBacklog(join(f.base, 'backlog.json'), 'coordinator');
  const old = await ask({ ...f, backlog: nb } as Fixture);
  const d2 = await ask(f, 'plan');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, old), null);
  assert.equal((await commentAnswer(f, d2))?.answer, 'approve');
});

// ===== AA1e: AA1 through handleDecisions: the land is queued on an approval the owner gave the plan question =====
const handleDecisions = (f: Fixture) => (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
async function aa1e(edit: boolean) {
  const f = unit();
  const land = await ask(f);
  f.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L3', reasons: ['high-risk: ci-config (.gitlab-ci.yml)'] }, 'coordinator');
  const plan = await ask(f, 'plan');
  f.backlog.humanComment(1, 'example-owner', 'The plan is fine.\n/worklane approve');
  if (edit) await editComment(f, 1, (b) => b.includes(`decide ${plan.id} `), (b) => b.replace('decision needed', 'decision needed (typo fixed)'));
  await handleDecisions(f);
  const answered = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
  return { landAnswer: answered.find((x) => x.id === land.id)?.answer ?? null, queued: f.log.read(0, ['land.queued']).length };
}
test('AA1e control (handleDecisions): the owner approves the plan bare; the land question stays unanswered, nothing queued', async () => {
  const r = await aa1e(false);
  assert.equal(r.landAnswer, null);
  assert.equal(r.queued, 0);
});
test("AA1e (handleDecisions): a writer (who may not answer land) edits the plan question's comment; the owner's plan approval answers the land question and queues the land", async () => {
  const r = await aa1e(true);
  assert.equal(r.landAnswer, null, `REDIRECTED: land answered ${r.landAnswer}, land.queued x${r.queued}`);
  assert.equal(r.queued, 0, `REDIRECTED: land.queued x${r.queued}`);
});
