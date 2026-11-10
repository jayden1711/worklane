// R1182ac (final) probes on #1182 at 04a6f66e, ported. The owner's decision (2026-11-09): a reply answers only by naming
// the decision's id, so a bare reply answers nothing and records one reply_without_id note; the tests that used a bare
// reply to answer now name the id, and AC4 (GraphQL) went with the GraphQL read.
// Originally: Fixture copied from test/direct-land-floor-r1182aa.test.ts (lines 5-116).
// Each AC test asserts the SAFE outcome, so it fails while the defect is there; each has a control that passes.
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


const handleDecisions = (f: Fixture) => (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
const answeredOf = (f: Fixture, id: string) => f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === id)?.answer ?? null;
const answerOnDashboard = (f: Fixture, id: string, answer: string) => f.log.append('decision.answered', { id, by: 'example-owner', answer, role: 'owner' }, 'example-owner', 'human');

// ===== AC1: "every other UNANSWERED posted decision is below the reply" is judged now, not when the reply was written. =====
// The plan question is open; the land question (L3, ci-config) is posted; the owner's bare `/worklane approve`, typed for
// the plan, lands under both (R1182ab's AB4 race). Correctly ambiguous: nothing answered, a reply_ambiguous note. The
// owner then does what the note says and answers the plan by its id (or on the dashboard). The plan is no longer
// "unanswered", so on the next pass the SAME bare reply now satisfies every condition for the land question and the
// land is queued on an approval the owner gave the plan.
async function ac1(how: 'named' | 'dashboard' | 'none') {
  const f = unit();
  const plan = await ask(f, 'plan');
  f.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L3', reasons: ['high-risk: ci-config (.gitlab-ci.yml)'] }, 'coordinator');
  const land = await ask(f);
  f.backlog.humanComment(1, 'example-owner', 'The plan is fine.\n/worklane approve'); // typed for the plan
  await handleDecisions(f);
  const first = { plan: answeredOf(f, plan.id), land: answeredOf(f, land.id), queued: f.log.read(0, ['land.queued']).length, ambiguous: errors(f).filter((e) => e.kind === 'reply_not_first_line').length }; // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text): the bare line is line 2, so its note is reply_not_first_line (was reply_without_id)
  if (how === 'named') f.backlog.humanComment(1, 'example-owner', `/worklane approve ${plan.id}`);
  if (how === 'dashboard') answerOnDashboard(f, plan.id, 'approve');
  await handleDecisions(f);
  await handleDecisions(f);
  return { first, plan: answeredOf(f, plan.id), land: answeredOf(f, land.id), queued: f.log.read(0, ['land.queued']).length };
}
test('AC1 control: the bare reply under both questions is ambiguous: nothing answered, nothing queued, a note; left alone it stays so', async () => {
  const r = await ac1('none');
  assert.deepEqual(r.first, { plan: null, land: null, queued: 0, ambiguous: 1 });
  assert.equal(r.land, null);
  assert.equal(r.queued, 0);
});
test("AC1 (named): the owner then answers the plan by its id, as the note says; the earlier bare reply must not answer the land", async () => {
  const r = await ac1('named');
  assert.equal(r.plan, 'approve', 'control: the plan is answered by the named reply');
  assert.equal(r.land, null, `RE-TARGETED: the bare approve typed for the plan answered the land (${r.land}); land.queued x${r.queued}`);
  assert.equal(r.queued, 0, `RE-TARGETED: land.queued x${r.queued}`);
});
test("AC1 (dashboard): the owner answers the plan on the dashboard; the earlier bare reply must not answer the land", async () => {
  const r = await ac1('dashboard');
  assert.equal(r.plan, 'approve');
  assert.equal(r.land, null, `RE-TARGETED: land answered ${r.land}; land.queued x${r.queued}`);
  assert.equal(r.queued, 0);
});
// Unit form, with a writer: a 'question' decision (writers may answer) is open, a land question follows, the owner's bare
// approve (for the question) comes after both; a writer then answers the question by id. The owner's bare reply becomes
// the owner's approval of the land.
test('AC1w (unit): a writer answering the other question by id turns the owner\'s ambiguous bare approve into an approval of the land', async () => {
  const f = unit();
  const qq = await ask(f, 'question');
  const land = await ask(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, land), null, 'control: ambiguous while both are open');
  f.backlog.humanComment(1, 'example-collaborator', `/worklane reject ${qq.id}`);
  const a = await commentAnswer(f, qq);
  assert.deepEqual([a?.answer, a?.role], ['reject', 'writer'], 'control: the writer may answer the question');
  f.log.append('decision.answered', { id: qq.id, by: a!.by, answer: a!.answer, role: 'writer' }, 'coordinator');
  const l = await commentAnswer(f, land);
  assert.equal(l, null, `RE-TARGETED by a writer: the owner's bare approve now answers the land ${JSON.stringify(l)}`);
});

// ===== AC2 (minor): fence toggling ignores the fence's length and character (CommonMark closes ```` only with ````+) =====
test('AC2 control: a ``` fence holding an approve, then `/worklane reject`: nothing, one note (changed by (b); was reject)', async () => {
  const f = unit();
  const d = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `Quoting:\n\`\`\`\n/worklane approve ${d.id}\n\`\`\`\n/worklane reject ${d.id}`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text): neither line is the first, so nothing answers (was 'reject'), with one note.
  assert.equal(await commentAnswer(f, d), null);
  assert.deepEqual(errors(f).filter((e) => /^reply_/.test(e.kind)).map((e) => e.kind), ['reply_not_first_line']);
});
test('AC2 (minor): a ```` fence quoting markdown that holds a ``` line flips the reading: the fenced approve counts and the real reject is skipped', async () => {
  const f = unit();
  const d = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `The bot's text, verbatim:\n\`\`\`\`\nRun:\n\`\`\`\n/worklane approve ${d.id}\n\`\`\`\n\`\`\`\`\n/worklane reject`);
  const a = await commentAnswer(f, d);
  // The fenced approve must not be read (the bare reject after it answers nothing: the id is required).
  assert.notEqual(a?.answer, 'approve', `FENCE MISREAD: ${JSON.stringify(a)}`);
});

// ===== AC3 (minor): an id token is matched inside words and case-sensitively =====
test('AC3a (minor): `/worklane approve the add-on` with one open question: a word holding "d-" makes the line name an id', async () => {
  const f = unit();
  const d = await ask(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve the add-on');
  const a = await commentAnswer(f, d);
  // Changed: with the id required this answers nothing; "add-on" is no id, so the note is the without-id one.
  assert.equal(a, null);
  assert.deepEqual(errors(f).map((e) => e.kind), ['reply_without_id'], `"add-on" read as an id: ${JSON.stringify(errors(f))}`);
});
test('AC3b (minor): an id in capitals (`D-1-…`) for ANOTHER decision is read as bare and answers the open one', async () => {
  const f = unit();
  const other = await ask(f, 'question');
  answerOnDashboard(f, other.id, 'approve');
  const d = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${other.id.toUpperCase()}`);
  const a = await commentAnswer(f, d);
  assert.equal(a, null, `an upper-case id for ${other.id} answered ${d.id}: ${JSON.stringify(a)}`);
});

// AC4 (the owner's note in a GraphQL outage) is gone with the GraphQL read itself: with the id required, no edit is read.
