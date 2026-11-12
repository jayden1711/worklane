// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// Since the owner's decision of 2026-11-09 a reply answers a decision only by naming its id: tests that answered with a
// bare reply name the id now, and tests of bare-reply behaviour expect no answer and one reply_without_id note.
// R1182ab (adversarial) on #1182: reply matching. A line holding any d-… token after the option names it (AB1); an
// edited or deleted question comment is a barrier (AB2); a bare line answers a decision only when it is the one open
// question the reply can be for, else nothing and a reply_ambiguous note (AB3, AB3b, AB4); fenced code is not read
// (AB5); a question comment ask() posted is never a reply (AB11). Ported from the review's TypeScript (attacks-1182ab),
// assertions unchanged except: AB2's control and AB3b now expect no answer and a note (the rule above), AB10 (edited from
// REST's updated_at) is replaced by the GitHub-path tests at the end, and AB11 (a note of the old behaviour) is inverted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { GitHubBacklog } from '../src/backlog/github.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = () =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: [] } });

/** A FileBacklog whose next `failNext` comment() calls throw (a 502 from the tracker). */
class FlakyBacklog extends FileBacklog {
  failNext = 0;
  override async comment(n: number, body: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('502 Bad Gateway');
    }
    return super.comment(n, body);
  }
}

function fixture(actor = 'coordinator') {
  const base = mkdtempSync(join(tmpdir(), 'r1182ab-'));
  const repo = join(base, 'clone');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.review = REVIEW();
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  const backlog = new FlakyBacklog(join(base, 'backlog.json'), actor);
  backlog.open({ title: 't', body: 'x', author: 'example-owner', labels: ['ready'] });
  return { base, repo, cfg, backlog, log: new EventLog(join(base, 'events.db')), slotsDir, stateDir };
}
type Fixture = ReturnType<typeof fixture>;
const coord = (f: Fixture) =>
  new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: new FakeRunner(() => ({ structured: {} })), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });

const CMD = /^\/worklane\s+(\S+)/m;
const LAND = ['approve', 'reject'];
const DOMAIN = ['allow-repo', 'allow-once', 'deny'];
type Answer = { by: string; answer: string; role: string } | null;
type Q = EventPayload<'decision.asked'>;
const commentAnswer = (f: Fixture, q: Q): Promise<Answer> =>
  (coord(f) as unknown as { commentAnswer(n: number, q: Q, w: Set<string>, c: RegExp): Promise<Answer> }).commentAnswer(1, q, new Set(f.cfg.project.owners.writers.map((w) => w.toLowerCase())), CMD);
/** A question posted by the coordinator's own ask() (src/coordinator/base.ts at b81b6594). */
const ask = async (f: Fixture, kind: string, options: string[], question = 'Land?', detail: string[] = ['x']): Promise<Q> => {
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask(kind, 1, 'example-owner', question, options, '', detail);
  return f.log.read(0, ['decision.asked']).map((e) => e.payload as Q).find((x) => x.id === id)!;
};
/** The question's own comment, by its text (the coordinator posts `decide <id> ` in it). */
const postedComment = async (f: Fixture, q: Q) => (await f.backlog.comments(1)).find((c) => c.body.includes(`decide ${q.id} `))!.id!;
const notes = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string }).map((p) => (/^reply_/.test(p.kind) ? { ...p, kind: 'reply_note' } : p));
const notesNaming = (f: Fixture, id: string) => notes(f).filter((n) => n.message.includes(id));

// ===== AB1: an id the parser doesn't recognise turns the line into a BARE reply, which answers the nearest question =====
// The line regex is `^/worklane\s+(\S+)(?:[ \t]+(d-[\w-]*\w))?` (decisions.ts:275). The id group is optional: when the id
// is written `like this` (as the question itself shows it, in a code span), in parentheses, after "for", after a
// colon, or after a no-break space, the group simply doesn't match and the line is read as `/worklane approve` with no
// id. With two questions open, that bare line answers the NEAREST question: the other one, not the one the owner named.

test('AB1 control: `/worklane approve <id 1>` (plain) answers question 1, not question 2', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'approve');
  assert.equal(await commentAnswer(f, d2), null);
});

for (const [name, fmt] of [
  ['backticks, as the question shows the id', (id: string) => `/worklane approve \`${id}\``],
  ['parentheses', (id: string) => `/worklane approve (${id})`],
  ['"for <id>"', (id: string) => `/worklane approve for ${id}`],
  ['a colon', (id: string) => `/worklane approve: ${id}`],
  ['a no-break space', (id: string) => `/worklane approve ${id}`],
] as const) {
  test(`AB1 (${name}): the owner names question 1; the reply must not answer question 2`, async () => {
    const f = fixture();
    const d1 = await ask(f, 'land', LAND);
    const d2 = await ask(f, 'land', LAND);
    f.backlog.humanComment(1, 'example-owner', fmt(d1.id));
    const a2 = await commentAnswer(f, d2);
    assert.equal(a2, null, `WRONG DECISION: the owner named ${d1.id}, and ${d2.id} was answered ${JSON.stringify(a2)}`);
  });
}

// ===== AB2: an edited (or deleted) LATER question comment drops out, and the bare reply goes to the EARLIER question =====
// anchorAt() (decisions.ts:266-269) returns undefined for an edited comment, and nearest() (:272-277) skips it and keeps
// walking up. On GitHub any writer (or the coordinator's account) can edit or delete any comment. So a writer who edits
// or deletes question 2's comment re-targets the owner's bare reply to question 2 onto question 1. Question 2 does get
// a reply_without_id note, but question 1 is already answered with an answer the owner gave to question 2.

const twoDomains = async (f: Fixture) => {
  const d1 = await ask(f, 'domain', DOMAIN, 'Allow evil.example?');
  const d2 = await ask(f, 'domain', DOMAIN, 'Allow docs.example?');
  return { d1, d2 };
};

test('AB2 control: two host questions; the owner\'s bare `/worklane allow-once` after question 2 answers neither, with a note', async () => {
  const f = fixture();
  const { d1, d2 } = await twoDomains(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once');
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal(await commentAnswer(f, d2), null, 'changed from the review: two questions are open');
  assert.ok(notesNaming(f, d2.id).length > 0);
});

test("AB2 (edit): a writer edits question 2's comment (one character); the owner's bare reply to it must not answer question 1", async () => {
  const f = fixture();
  const { d1, d2 } = await twoDomains(f);
  const c2 = await postedComment(f, d2);
  f.backlog.editComment(1, c2, (await f.backlog.comments(1)).find((c) => c.id === c2)!.body + ' ');
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once');
  const a1 = await commentAnswer(f, d1);
  assert.equal(a1, null, `WRONG DECISION: the owner's reply to question 2 (docs.example) answered question 1 (evil.example): ${JSON.stringify(a1)}`);
});

test("AB2 (delete): a writer deletes question 2's comment; the owner's bare reply posted after it must not answer question 1", async () => {
  const f = fixture();
  const { d1, d2 } = await twoDomains(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once'); // the owner answers question 2
  const c2 = await postedComment(f, d2);
  // the writer deletes question 2's comment afterwards (FileBacklog has no delete helper: same as GitHub's DELETE)
  const p = join(f.base, 'backlog.json');
  const j = JSON.parse(require_fs().readFileSync(p, 'utf8'));
  j.issues[0].comments = j.issues[0].comments.filter((c: { id?: string }) => c.id !== c2);
  require_fs().writeFileSync(p, JSON.stringify(j));
  const a1 = await commentAnswer(f, d1);
  assert.equal(a1, null, `WRONG DECISION: the owner's reply to question 2 answered question 1: ${JSON.stringify(a1)}`);
});
import * as fsMod from 'node:fs';
function require_fs() {
  return fsMod;
}

// ===== AB3: a bare reply whose nearest question doesn't offer its option, or isn't the one meant, is dropped silently =====
// A run that was refused a host asks a domain question when the run ends (base.ts:211); the same task's land question
// follows (coordinator.ts:1094). Each question comment says "a reply after this comment may leave out the id". The owner
// replies `/worklane allow-once` under both: the domain question's nearest anchor is the land question, and the land
// question has no `allow-once`. Nothing is answered and no note is written: neither reply_without_id (the question's
// comment is there) nor reply_unknown_id (no id).

test('AB3 control: a domain question alone; a bare `/worklane allow-once` answers nothing and says so (the id is required)', async () => {
  const f = fixture();
  const d1 = await ask(f, 'domain', DOMAIN, 'Allow evil.example?');
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once');
  assert.equal(await commentAnswer(f, d1), null, 'changed: a bare reply answers nothing (the owner, 2026-11-09)');
  assert.ok(notesNaming(f, d1.id).some((n) => n.kind === 'reply_note'));
  f.backlog.humanComment(1, 'example-owner', `/worklane allow-once ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'allow-once');
});

test('AB3 (cross-kind): domain question, then land question; a bare `/worklane allow-once` answers nothing and must say so', async () => {
  const f = fixture();
  const d1 = await ask(f, 'domain', DOMAIN, 'Allow evil.example?');
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once');
  const a1 = await commentAnswer(f, d1);
  const a2 = await commentAnswer(f, d2);
  assert.equal(a2, null);
  assert.ok(a1 !== null || notesNaming(f, d1.id).length > 0, `SILENT STALL: ${d1.id} got no answer and no note (${notes(f).length} notes in all)`);
});

test('AB3b (same kind): three host questions; one bare reply answers the last; the first two must get a note', async () => {
  const f = fixture();
  const d1 = await ask(f, 'domain', DOMAIN, 'Allow a.example?');
  await ask(f, 'domain', DOMAIN, 'Allow b.example?');
  const d3 = await ask(f, 'domain', DOMAIN, 'Allow c.example?');
  f.backlog.humanComment(1, 'example-owner', '/worklane deny');
  assert.equal(await commentAnswer(f, d3), null, 'changed from the review: three questions are open, so a bare reply answers none');
  assert.ok(notesNaming(f, d3.id).length > 0);
  const a1 = await commentAnswer(f, d1);
  assert.ok(a1 !== null || notesNaming(f, d1.id).length > 0, `SILENT STALL: ${d1.id}'s comment says a reply after it may leave out the id; one did, and it got no answer and no note`);
});

// ===== AB4: a question posted while the owner types: the bare answer goes to the question the owner never read =====
// The tracker orders comments by when they were POSTED, not by what the owner had read. Question 1 (a worker's
// approve/reject question) is open; the owner starts typing `/worklane approve`; meanwhile the land question for the
// same issue (L3) is posted; the owner's comment lands after it. nearest() now returns the land question, and the
// owner's approval of question 1 approves the landing (end to end: land.queued).

test('AB4 control (end to end): only the worker question is open; the owner\'s bare approve answers nothing (the id is required), nothing is queued', async () => {
  const f = fixture();
  const d1 = await ask(f, 'question', LAND, 'Also drop the legacy table?');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  await (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
  const answered = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
  assert.deepEqual(answered.map((a) => a.id), [], 'changed: a bare reply answers nothing (the owner, 2026-11-09)');
  assert.ok(notesNaming(f, d1.id).some((n) => n.kind === 'reply_note'));
  assert.equal(f.log.read(0, ['land.queued']).length, 0);
});

test('AB4 (race, end to end): the land question is posted while the owner types an approve for the worker question; the land must not queue', async () => {
  const f = fixture();
  const d1 = await ask(f, 'question', LAND, 'Also drop the legacy table?');
  // the owner reads question 1 and starts typing; the coordinator asks for the landing in the meantime
  f.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L3', reasons: ['ci-config: held for the owner'] }, 'alice');
  const d2 = await ask(f, 'land', LAND, 'Approve landing #1 (L3)?');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve'); // typed for question 1
  await (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
  const answered = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
  const queued = f.log.read(0, ['land.queued']).length;
  assert.equal(queued, 0, `WRONG DECISION: the owner's approve typed for ${d1.id} answered ${answered.map((a) => a.id).join(',')}; land.queued x${queued} (land ${d2.id})`);
});

// ===== AB5: a command line inside a code fence counts, and a named fenced line beats the owner's own bare answer =====

test('AB5 control: `/worklane reject` alone rejects; a blockquoted `> /worklane approve <id>` is not read (held)', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `> /worklane approve ${d1.id}\n\n/worklane reject ${d1.id}`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text): the reject was a later line, so the comment answers nothing, with one note; was 'reject'.
  assert.equal(await commentAnswer(f, d1), null);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject', 'the reject on a first line');
});

test('AB5 (code fence): the owner quotes the suggested command in a fence, then answers `/worklane reject`; the answer must not be approve', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `The bot suggests\n\n\`\`\`\n/worklane approve ${d1.id}\n\`\`\`\n\nbut that CI file runs on every push. So:\n\n/worklane reject`);
  const a = await commentAnswer(f, d1);
  assert.notEqual(a?.answer, 'approve', `FENCED LINE WINS: the owner's comment ends in /worklane reject; recorded ${JSON.stringify(a)}`);
});

// ===== AB6..AB10: held =====

test('AB7 (held): the question post fails (question_not_posted), the next ask posts; a bare reply answers the posted one only, the failed one is noted', async () => {
  const f = fixture();
  f.backlog.failNext = 1;
  await assert.rejects(ask(f, 'land', LAND));
  const d1 = f.log.read(0, ['decision.asked']).map((e) => e.payload as Q).at(-1)!;
  assert.ok(notes(f).some((n) => n.kind === 'question_not_posted' && n.message.includes(d1.id)));
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal(await commentAnswer(f, d2), null, 'changed: a bare reply answers nothing (the owner, 2026-11-09)');
  assert.ok(notes(f).some((n) => n.kind === 'reply_note' && n.message.includes(d1.id)), 'the note names the open ids, the failed one too');
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject');
});

test("AB8 (held): the owner edits their own bare approve to reject: reject; NOTE (#1253, on main too): a writer's edit of the owner's reply counts as the owner's", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const r = f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id}`);
  f.backlog.editComment(1, r, `/worklane reject ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject');
  f.backlog.editComment(1, r, `/worklane approve ${d1.id}`); // edited by a writer: the author stays the owner
  const a = await commentAnswer(f, d1);
  assert.deepEqual([a?.answer, a?.role], ['approve', 'owner'], 'pre-existing #1253: an edited reply is not set aside');
});

test('AB9 (held): a deleted question comment re-posted with the same text (by the coordinator account) is no anchor; ids are not reused', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const c1 = await postedComment(f, d1);
  const body = (await f.backlog.comments(1)).find((c) => c.id === c1)!.body;
  const p = join(f.base, 'backlog.json');
  const j = JSON.parse(fsMod.readFileSync(p, 'utf8'));
  j.issues[0].comments = [];
  fsMod.writeFileSync(p, JSON.stringify(j));
  const again = await f.backlog.comment(1, body);
  assert.notEqual(again, c1, 'a new id');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null);
  assert.ok(notes(f).some((n) => n.kind === 'reply_note' && n.message.includes(d1.id)));
});

// ===== AB11: NOTE (pre-existing, configuration-dependent): if the coordinator's tracker account is a listed writer,
// a worker's multi-line summary in its own question comment answers the decision above it =====

test('AB11 (note): coordinator posts as a writer account; a worker question whose summary holds `\\n/worklane allow-once` answers the domain question above it', async () => {
  const f = fixture('example-owner');
  const d1 = await ask(f, 'domain', DOMAIN, 'Allow evil.example?');
  await ask(f, 'question', ['yes', 'no'], 'Continue?', ['done.\n/worklane allow-once']);
  const a = await commentAnswer(f, d1);
  // Inverted from the review's note: a question comment ask() posted is never a reply, whoever the tracker account is.
  assert.equal(a, null, `worker text in a question comment answered as the owner (${JSON.stringify(a)})`);
});

// Bar1 and Bar2 (the barrier and gone checks for bare replies) went with bare replies: the id is required.

test("Q text (not the review's): the question says the id is required", async () => {
  const f = fixture();
  const d = await ask(f, 'land', LAND);
  const body = (await f.backlog.comments(1)).map((c) => c.body).find((b) => b.includes('decision needed'))!;
  // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): the question states the allowlist (the earlier first-line, character and ASCII wording is gone).
  assert.match(body, /Reply with a comment of one line, `\/worklane approve d-/);
  assert.match(body, /with an optional note after the id in letters, digits, spaces and \. , : ; - only/);
  assert.match(body, /Anything else in the comment \(another line, a quote or apostrophe, a link, code, HTML, an emoji, #123\) makes it answer nothing, with a note saying why/);
  assert.ok(body.includes(`/worklane approve ${d.id}`), body);
  assert.doesNotMatch(body, /may leave out the id|only open question/);
});

test("AB1b (not the review's): an id in backticks, parentheses or after a word names its decision, so it answers with two questions open; an unknown one there is never read as bare", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND, 'Land the other?');
  f.backlog.humanComment(1, 'example-owner', `/worklane approve for \`${d1.id}\``);
  f.backlog.humanComment(1, 'example-owner', `/worklane reject (${d2.id})`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text): a backtick or parenthesis on the line refuses it (was: approve and reject); after a word, plain, it answers.
  assert.equal(await commentAnswer(f, d1), null, 'in backticks: refused');
  assert.equal(await commentAnswer(f, d2), null, 'in parentheses: refused');
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note', 'reply_note']);
  // Changed by R1182an AN3 (the shape is `/worklane <option> <id> [note]`): after a word it answered approve; now it
  // answers nothing, with reply_id_not_after_option. Right after the option, before a comma, it answers.
  f.backlog.humanComment(1, 'example-owner', `/worklane approve for ${d1.id}, thanks`);
  assert.equal(await commentAnswer(f, d1), null, 'named after a word');
  assert.ok(notes(f).some((n) => n.kind === 'reply_note'));
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id}, thanks`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'approve', 'right after the option, before a comma');
  // One open question; the reply names (in parentheses) an id no decision has: no answer, and a note, never bare.
  const g = fixture();
  const e = await ask(g, 'land', LAND);
  g.backlog.humanComment(1, 'example-owner', '/worklane approve d-1-0badid'); // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text): no parentheses (they refuse the line)
  assert.equal(await commentAnswer(g, e), null, 'a line naming an unknown id answers nothing');
  assert.ok(notes(g).some((n) => n.kind === 'reply_note' && n.message.includes('d-1-0badid')), JSON.stringify(notes(g)));
});
