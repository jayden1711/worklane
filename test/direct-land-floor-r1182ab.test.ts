// R1182ab (adversarial) on #1182: reply matching. A line holding any d-… token after the option names it (AB1); an
// edited or deleted question comment is a barrier (AB2); a bare line answers a decision only when it is the one open
// question the reply can be for, else nothing and a reply_ambiguous note (AB3, AB3b, AB4); fenced code is not read
// (AB5); a question comment ask() posted is never a reply (AB11). Ported from the review's TypeScript (attacks-1182ab),
// assertions unchanged except: AB2's control and AB3b now expect no answer and a note (the rule above), AB10 (edited from
// REST's updated_at) is replaced by the GitHub-path tests at the end, and AB11 (a note of the old behaviour) is inverted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const postedComment = (f: Fixture, q: Q) => f.log.read(0, ['decision.posted']).map((e) => e.payload as EventPayload<'decision.posted'>).find((p) => p.id === q.id)!.comment;
const notes = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string });
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
  const c2 = postedComment(f, d2);
  f.backlog.editComment(1, c2, (await f.backlog.comments(1)).find((c) => c.id === c2)!.body + ' ');
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once');
  const a1 = await commentAnswer(f, d1);
  assert.equal(a1, null, `WRONG DECISION: the owner's reply to question 2 (docs.example) answered question 1 (evil.example): ${JSON.stringify(a1)}`);
});

test("AB2 (delete): a writer deletes question 2's comment; the owner's bare reply posted after it must not answer question 1", async () => {
  const f = fixture();
  const { d1, d2 } = await twoDomains(f);
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once'); // the owner answers question 2
  const c2 = postedComment(f, d2);
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

test('AB3 control: a domain question alone; a bare `/worklane allow-once` answers it', async () => {
  const f = fixture();
  const d1 = await ask(f, 'domain', DOMAIN, 'Allow evil.example?');
  f.backlog.humanComment(1, 'example-owner', '/worklane allow-once');
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

test('AB4 control (end to end): only the worker question is open; the owner\'s bare approve answers it, nothing is queued', async () => {
  const f = fixture();
  const d1 = await ask(f, 'question', LAND, 'Also drop the legacy table?');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  await (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
  const answered = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
  assert.deepEqual(answered.map((a) => a.id), [d1.id]);
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
  f.backlog.humanComment(1, 'example-owner', `> /worklane approve ${d1.id}\n\n/worklane reject`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject');
});

test('AB5 (code fence): the owner quotes the suggested command in a fence, then answers `/worklane reject`; the answer must not be approve', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `The bot suggests\n\n\`\`\`\n/worklane approve ${d1.id}\n\`\`\`\n\nbut that CI file runs on every push. So:\n\n/worklane reject`);
  const a = await commentAnswer(f, d1);
  assert.notEqual(a?.answer, 'approve', `FENCED LINE WINS: the owner's comment ends in /worklane reject; recorded ${JSON.stringify(a)}`);
});

// ===== AB6..AB10: held =====

test('AB6 (held): forging decision.posted needs write access to the event log, which already lets one write decision.answered', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  // control: a forged answer is taken as is (the log is the record of truth); a forged anchor adds nothing to that.
  f.log.append('decision.answered', { id: d1.id, by: 'example-owner', answer: 'approve', role: 'owner' }, 'mallory');
  assert.equal(f.log.read(0, ['decision.answered']).length, 1);
  // a decision.posted naming a reporter's comment: a bare reply after it answers d2, which is no more than the line above
  const d2 = await ask(f, 'land', LAND);
  const forged = f.backlog.humanComment(1, 'rita-reporter', 'me too');
  f.log.append('decision.posted', { id: d2.id, issue: 1, comment: forged }, 'mallory');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal((await commentAnswer(f, d2))?.answer, 'approve');
  // no writable path other than the log itself was found: no import, restore or replay command appends events (see review)
});

test('AB7 (held): the question post fails (question_not_posted), the next ask posts; a bare reply answers the posted one only, the failed one is noted', async () => {
  const f = fixture();
  f.backlog.failNext = 1;
  await assert.rejects(ask(f, 'land', LAND));
  const d1 = f.log.read(0, ['decision.asked']).map((e) => e.payload as Q).at(-1)!;
  assert.ok(notes(f).some((n) => n.kind === 'question_not_posted' && n.message.includes(d1.id)));
  assert.equal(f.log.read(0, ['decision.posted']).length, 0);
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal((await commentAnswer(f, d2))?.answer, 'approve');
  assert.ok(notes(f).some((n) => n.kind === 'reply_without_id' && n.message.includes(d1.id)), 'the failed one says why');
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject');
});

test("AB8 (held): the owner edits their own bare approve to reject: reject; NOTE (#1253, on main too): a writer's edit of the owner's reply counts as the owner's", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const r = f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  f.backlog.editComment(1, r, '/worklane reject');
  assert.equal((await commentAnswer(f, d1))?.answer, 'reject');
  f.backlog.editComment(1, r, `/worklane approve ${d1.id}`); // edited by a writer: the author stays the owner
  const a = await commentAnswer(f, d1);
  assert.deepEqual([a?.answer, a?.role], ['approve', 'owner'], 'pre-existing #1253: an edited reply is not set aside');
});

test('AB9 (held): a deleted question comment re-posted with the same text (by the coordinator account) is no anchor; ids are not reused', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const c1 = postedComment(f, d1);
  const body = (await f.backlog.comments(1)).find((c) => c.id === c1)!.body;
  const p = join(f.base, 'backlog.json');
  const j = JSON.parse(fsMod.readFileSync(p, 'utf8'));
  j.issues[0].comments = [];
  fsMod.writeFileSync(p, JSON.stringify(j));
  const again = await f.backlog.comment(1, body);
  assert.notEqual(again, c1, 'a new id');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null);
  assert.ok(notes(f).some((n) => n.kind === 'reply_without_id' && n.message.includes(d1.id)));
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

// ===== R1182aa (6): GitHub's "edited" is GraphQL's lastEditedAt, never REST's updated_at (which a hide moves too) =====
function ghStub(rest: unknown[], gql: (body: { query: string; variables: Record<string, unknown> }) => unknown) {
  const calls: string[] = [];
  const fetchStub = (async (url: string, init?: { method?: string; body?: string }) => {
    assert.ok(String(url).startsWith('http://stub.invalid/'), 'never the real API');
    const path = String(url).slice('http://stub.invalid'.length);
    calls.push(`${init?.method ?? 'GET'} ${path.split('?')[0]}`);
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/graphql') return json(gql(JSON.parse(String(init?.body))));
    if ((init?.method ?? 'GET') === 'POST') return json({ id: 3541234567, user: { login: 'wl[bot]' }, body: 'x' });
    return json(rest);
  }) as unknown as typeof fetch;
  return { gh: new GitHubBacklog('example/repo', () => 'x', fetchStub, 'http://stub.invalid'), calls };
}
const REST = [
  // 11: never edited; 12: hidden by a moderator (updated_at moved, no edit); 13: edited; 14: not in GraphQL's answer.
  { id: 11, user: { login: 'wl[bot]' }, body: 'q', created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z' },
  { id: 12, user: { login: 'wl[bot]' }, body: 'q', created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T11:00:00Z' },
  { id: 13, user: { login: 'wl[bot]' }, body: 'q', created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T11:00:00Z' },
  { id: 14, user: { login: 'wl[bot]' }, body: 'q', created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z' },
];
const NODES = [{ databaseId: 11, lastEditedAt: null }, { databaseId: 12, lastEditedAt: null }, { databaseId: 13, lastEditedAt: '2026-11-09T11:00:00Z' }];

test("GitHub path (not the review's): comment() returns the POST's id; comments(n, { edits }) reads edits from GraphQL's lastEditedAt, so a hide is no edit", async () => {
  const seen: { asked?: { query: string; variables: Record<string, unknown> } } = {};
  const { gh, calls } = ghStub(REST, (b) => ((seen.asked = b), { data: { repository: { issueOrPullRequest: { comments: { nodes: NODES } } } } }));
  assert.equal(await gh.comment(7, 'hello'), '3541234567');
  const got = await gh.comments(7, { edits: true });
  assert.deepEqual(got.map((c) => [c.id, c.edited]), [['11', false], ['12', false], ['13', true], ['14', true]], 'hidden is not edited; edited is; one GraphQL did not list reads as edited');
  const asked = seen.asked;
  assert.ok(asked && /lastEditedAt/.test(asked.query) && asked.variables.n === 7 && asked.variables.owner === 'example' && asked.variables.name === 'repo', JSON.stringify(asked));
  // Without `edits`, no GraphQL call and no `edited` field (every other caller is as before).
  calls.length = 0;
  const plain = await gh.comments(7);
  assert.ok(plain.every((c) => !('edited' in c)));
  assert.deepEqual(calls, ['GET /repos/example/repo/issues/7/comments']);
});

test("GitHub path (not the review's): GraphQL errors or no answer: every comment reads as edited (fails closed)", async () => {
  for (const answer of [{ errors: [{ message: 'boom' }] }, { data: { repository: null } }, { data: { repository: { issueOrPullRequest: null } } }]) {
    const { gh } = ghStub(REST, () => answer);
    assert.deepEqual((await gh.comments(7, { edits: true })).map((c) => c.edited), [true, true, true, true], JSON.stringify(answer));
  }
});

// ===== Not the review's: the barrier and gone checks on their own (an answered question can't be told apart by the open set) =====
const deleteById = (f: Fixture, id: string) => {
  const p = join(f.base, 'backlog.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  for (const i of j.issues) if (i.number === 1) i.comments = i.comments.filter((c: { id?: string }) => c.id !== id);
  writeFileSync(p, JSON.stringify(j));
};
const answerOnDashboard = (f: Fixture, q: Q, answer: string) => f.log.append('decision.answered', { id: q.id, by: 'example-owner', answer, role: 'owner' }, 'example-owner', 'human');

test("Bar1 (not the review's): a question answered on the dashboard sits between question 1 and a bare reply: the reply (likely for it) answers nothing", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND, 'Land the other?');
  answerOnDashboard(f, d2, 'reject');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null, "a recorded question comment between them is a barrier, answered or not");
  assert.ok(notesNaming(f, d1.id).some((n) => n.kind === 'reply_ambiguous'));
});

test("Bar2 (not the review's): a later question, answered, whose comment is gone: a bare reply after question 1 answers nothing (where it was can't be known)", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND, 'Land the other?');
  answerOnDashboard(f, d2, 'reject');
  deleteById(f, postedComment(f, d2));
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null);
  // Control: with question 2's comment still there and below the reply, the bare reply answers question 1.
  const g = fixture();
  const e1 = await ask(g, 'land', LAND);
  g.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const e2 = await ask(g, 'land', LAND, 'Land the other?');
  answerOnDashboard(g, e2, 'reject');
  assert.equal((await commentAnswer(g, e1))?.answer, 'approve', 'control: the one open question above the reply');
});

test("Q text (not the review's): the question says a reply without the id counts only while it is the only open question", async () => {
  const f = fixture();
  await ask(f, 'land', LAND);
  const body = (await f.backlog.comments(1)).map((c) => c.body).find((b) => b.includes('decision needed'))!;
  assert.match(body, /a reply without the id counts only while this is the only open question on the issue/);
  assert.doesNotMatch(body, /may leave out the id/);
});

test("AB1b (not the review's): an id in backticks, parentheses or after a word names its decision, so it answers with two questions open; an unknown one there is never read as bare", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND, 'Land the other?');
  f.backlog.humanComment(1, 'example-owner', `/worklane approve for \`${d1.id}\``);
  f.backlog.humanComment(1, 'example-owner', `/worklane reject (${d2.id})`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'approve', 'named in backticks after a word');
  assert.equal((await commentAnswer(f, d2))?.answer, 'reject', 'named in parentheses');
  // One open question; the reply names (in parentheses) an id no decision has: no answer, and a note, never bare.
  const g = fixture();
  const e = await ask(g, 'land', LAND);
  g.backlog.humanComment(1, 'example-owner', '/worklane approve (d-1-0badid)');
  assert.equal(await commentAnswer(g, e), null, 'a line naming an unknown id answers nothing');
  assert.ok(notes(g).some((n) => n.kind === 'reply_unknown_id' && n.message.includes('d-1-0badid')), JSON.stringify(notes(g)));
});
