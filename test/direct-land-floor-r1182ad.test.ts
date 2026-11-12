// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182ad (adversarial) probes on #1182 @04a6f66e, ported. The owner's decision (2026-11-09): a reply answers only by
// naming the decision's id, so a bare reply answers nothing and records one reply_without_id note; the tests that used a
// bare reply to answer now name the id, and AD7/AD7b (GraphQL) went with the GraphQL read.
// Originally: reply matching after the R1182aa/ab fixes. Each DEFECT test asserts the safe
// outcome (so it fails at this head); each has a control. FileBacklog plus a stubbed fetch only: no network.
// Copy to dist/test/ of a built clone (tsc compiles test/*.ts; here the .ts is compiled with the clone's tsc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
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

/** A FileBacklog whose next `lostNext` comment() calls POST the comment and then throw (a timeout or 502 after GitHub stored it). */
class LossyBacklog extends FileBacklog {
  lostNext = 0;
  override async comment(n: number, body: string) {
    const id = await super.comment(n, body);
    if (this.lostNext > 0) {
      this.lostNext--;
      throw new Error('The operation was aborted due to timeout');
    }
    return id;
  }
}

function fixture(actor = 'coordinator') {
  const base = mkdtempSync(join(tmpdir(), 'r1182ad-'));
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
  const backlog = new LossyBacklog(join(base, 'backlog.json'), actor);
  backlog.open({ title: 't', body: 'x', author: 'example-owner', labels: ['ready'] });
  backlog.open({ title: 't2', body: 'x', author: 'example-owner', labels: ['ready'] });
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
const commentAnswer = (f: Fixture, q: Q, n = 1): Promise<Answer> =>
  (coord(f) as unknown as { commentAnswer(n: number, q: Q, w: Set<string>, c: RegExp): Promise<Answer> }).commentAnswer(n, q, new Set(f.cfg.project.owners.writers.map((w) => w.toLowerCase())), CMD);
const ask = async (f: Fixture, kind: string, options: string[], question = 'Land?', detail: string[] = ['x'], issue = 1): Promise<Q> => {
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask(kind, issue, 'example-owner', question, options, '', detail);
  return f.log.read(0, ['decision.asked']).map((e) => e.payload as Q).find((x) => x.id === id)!;
};
const lastAsked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as Q).at(-1)!;
const notes = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string }).map((p) => (/^reply_/.test(p.kind) ? { ...p, kind: 'reply_note' } : p));
const handle = (f: Fixture) => (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
const answered = (f: Fixture) => f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
const queued = (f: Fixture) => f.log.read(0, ['land.queued']).length;
const levelL3 = (f: Fixture) => f.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L3', reasons: ['ci-config: held for the owner'] }, 'alice');

// ===== AD1: a question comment that IS on the issue but has no decision.posted is invisible to the ambiguity rule =====
// ask() emits decision.posted only when comment() returns an id. A POST that GitHub stored but whose response was lost
// (timeout, 502 after commit) leaves a visible question with no record; so does every question asked before
// decision.posted existed. bareFor() counts only *posted* decisions, so a bare reply typed for that visible question is
// taken by the posted one: AB4's race again, and this time the land queues.

test('AD1 control (end to end): the worker question is posted normally; land posted while the owner types; nothing queues', async () => {
  const f = fixture();
  await ask(f, 'question', LAND, 'Also drop the legacy table?');
  levelL3(f);
  await ask(f, 'land', LAND, 'Approve landing #1 (L3)?');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve'); // typed for the worker question
  await handle(f);
  assert.equal(queued(f), 0);
  assert.equal(answered(f).length, 0);
});

test('AD1 control 2: the lost-response question alone: a bare reply answers nothing, and says so (held)', async () => {
  const f = fixture();
  f.backlog.lostNext = 1;
  await assert.rejects(ask(f, 'question', LAND, 'Also drop the legacy table?'));
  const d1 = lastAsked(f);
  assert.equal((await f.backlog.comments(1)).length, 1, 'the question comment is on the issue');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  await handle(f);
  assert.equal(answered(f).length, 0);
  assert.ok(notes(f).some((n) => n.kind === 'reply_note' && n.message.includes(d1.id)));
});

test('AD1 (race, end to end): the worker question was posted but its POST response was lost; the land question is posted while the owner types; the land must not queue', async () => {
  const f = fixture();
  f.backlog.lostNext = 1;
  await assert.rejects(ask(f, 'question', LAND, 'Also drop the legacy table?'));
  const d1 = lastAsked(f);
  levelL3(f);
  const d2 = await ask(f, 'land', LAND, 'Approve landing #1 (L3)?');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve'); // typed for the worker question, the only one open when read
  await handle(f);
  const a = answered(f);
  assert.equal(queued(f), 0, `WRONG DECISION: the owner's approve typed for ${d1.id} answered ${a.map((x) => x.id).join(',')} (land ${d2.id}); land.queued x${queued(f)}`);
});

test('AD1b (legacy, end to end): a question asked before decision.posted existed (its text: a bare reply works), then the new land question; the bare reply must not land', async () => {
  const f = fixture();
  // the old ask(): decision.asked, then the old comment text (no ids in the instruction), no decision.posted
  const id2 = 'd-1-0ld0ld2';
  f.log.append('decision.asked', { id: id2, kind: 'question', issue: 1, owner: 'example-owner', question: 'Also drop the legacy table?', options: LAND, recommendation: '', receipts: ['x'] }, 'alice');
  await f.backlog.comment(1, `[worklane] @example-owner decision needed: **Also drop the legacy table?**\n\nOptions: approve / reject.\n\n- x\n\nReply \`/worklane approve\` or \`/worklane reject\` (owner or a writer), or run \`worklane decide ${id2} <option>\`.`);
  levelL3(f);
  const land = await ask(f, 'land', LAND, 'Approve landing #1 (L3)?');
  f.backlog.humanComment(1, 'example-owner', '/worklane approve'); // as the legacy question says
  await handle(f);
  const a = answered(f);
  assert.equal(queued(f), 0, `WRONG DECISION: a bare reply (as the legacy question ${id2} instructs) answered ${a.map((x) => x.id).join(',')} (land ${land.id}); land.queued x${queued(f)}`);
});

// ===== AD2: one line naming two ids answers the first and drops the second with no word =====

test('AD2 control: two lines, one id each, answer neither (one note); one comment each answers both (changed by (b); was both answered)', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id}\n/worklane approve ${d2.id}`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text; a second command voids it).
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal(await commentAnswer(f, d2), null);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id}`);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d2.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'approve');
  assert.equal((await commentAnswer(f, d2))?.answer, 'approve');
});

test('AD2 (two ids, one line): `/worklane approve <d1> <d2>`: d2 must be answered or noted, never silently left', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id} ${d2.id}`);
  const a1 = await commentAnswer(f, d1);
  const a2 = await commentAnswer(f, d2);
  const noted = notes(f).filter((n) => n.message.includes(d2.id));
  assert.ok(a2 !== null || noted.length > 0, `STUCK, NO NOTICE: d1=${JSON.stringify(a1)}, d2=null and 0 notes naming ${d2.id}`);
});

test('AD2b (two ids, one line): `/worklane approve (not <d1>) <d2>`: the line must not approve d1', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d2.id}, not ${d1.id}`); // control order: d2 first
  assert.equal((await commentAnswer(f, d1)), null, 'control order holds');
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${d2.id}`);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve (not ${d1.id}) ${d2.id}`);
  const a1 = await commentAnswer(f, d1);
  assert.equal(a1, null, `WRONG DECISION: "approve (not ${d1.id}) ${d2.id}" approved ${d1.id}: ${JSON.stringify(a1)}`);
});

// ===== AD3: lookalikes. Text after the option that isn't `d-` in ASCII lower case leaves the line BARE =====
// The owner names a decision of ANOTHER issue (or a typo'd, upper-case or lookalike id). In ASCII lower case that is
// reply_unknown_id; written `D-`, with U+2010/U+2011, or full-width, the line is bare and answers this issue's land.

test('AD3 control: `/worklane approve d-2-…` (a decision of issue 2) on issue 1: unknown id, the land of issue 1 is not answered', async () => {
  const f = fixture();
  const land = await ask(f, 'land', LAND);
  const other = await ask(f, 'land', LAND, 'Land #2?', ['x'], 2);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${other.id}`);
  assert.equal(await commentAnswer(f, land), null);
  assert.ok(notes(f).some((n) => n.kind === 'reply_note'));
});

for (const [name, fmt] of [
  ['upper-case D-', (id: string) => id.replace(/^d-/, 'D-')],
  ['U+2010 hyphen', (id: string) => id.replace(/^d-/, 'd‐')],
  ['U+2011 no-break hyphen', (id: string) => id.replace(/^d-/, 'd‑')],
  ['full-width d', (id: string) => id.replace(/^d-/, 'ｄ-')],
  ['words, no id', () => 'for #2 please'],
] as const) {
  test(`AD3 (${name}): the owner names issue 2's decision on issue 1; issue 1's land must not be approved`, async () => {
    const f = fixture();
    const land = await ask(f, 'land', LAND);
    const other = await ask(f, 'land', LAND, 'Land #2?', ['x'], 2);
    f.backlog.humanComment(1, 'example-owner', `/worklane approve ${fmt(other.id)}`);
    const a = await commentAnswer(f, land);
    assert.equal(a, null, `WRONG DECISION: "/worklane approve ${fmt(other.id)}" approved ${land.id}: ${JSON.stringify(a)}`);
  });
}

// ===== AD4: fences. A fence is toggled by any ``` or ~~~ line, not by CommonMark's rules =====

test('AD4 control: a ``` fence around a named approve, then a reject: nothing, one note (changed by (b); was reject)', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `The bot suggests\n\n\`\`\`\n/worklane approve ${d1.id}\n\`\`\`\n\n/worklane reject ${d1.id}`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text; a second command voids it).
  assert.equal(await commentAnswer(f, d1), null);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
});

for (const [name, body] of [
  ['```` around a quoted ``` block', (id: string) => `I won't do what the README says:\n\n\`\`\`\`md\n\`\`\`\n/worklane approve ${id}\n\`\`\`\n\`\`\`\`\n\n/worklane reject`],
  ['``` closed by ~~~ (CommonMark: ~~~ is content)', (id: string) => `Log:\n\n\`\`\`\n~~~\n/worklane approve ${id}\n\`\`\`\n\n/worklane reject`],
  ['an indented ``` inside a fence (content)', (id: string) => `Log:\n\n\`\`\`\n    \`\`\`\n/worklane approve ${id}\n\`\`\`\n\n/worklane reject`],
  ['an HTML comment (not rendered)', (id: string) => `<!--\n/worklane approve ${id}\n-->\n/worklane reject`],
] as const) {
  test(`AD4 (${name}): rendered as code or hidden, then a bare reject; the answer must not be approve`, async () => {
    const f = fixture();
    const d1 = await ask(f, 'land', LAND);
    f.backlog.humanComment(1, 'example-owner', body(d1.id));
    const a = await commentAnswer(f, d1);
    assert.notEqual(a?.answer, 'approve', `HIDDEN LINE WINS: ${JSON.stringify(a)}`);
  });
}

test('AD4 held: indented code (4 spaces) and an unterminated fence are not read', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `    /worklane approve ${d1.id}\n\n/worklane reject ${d1.id}`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text; a second command voids it): the reject is on line 3, so nothing answers (was 'reject'), and the fenced approve below still answers nothing.
  assert.equal(await commentAnswer(f, d1), null);
  f.backlog.humanComment(1, 'example-owner', `\`\`\`\n/worklane approve ${d1.id}`);
  assert.equal(await commentAnswer(f, d1), null);
});

// ===== AD5: the notes themselves, and the question comment, are never replies =====

test('AD5 held: the reply_ambiguous / reply_without_id note text, posted back by a writer, answers nothing; a recorded question by the owner account answers nothing', async () => {
  const f = fixture('example-owner');
  const d1 = await ask(f, 'land', LAND, 'Land?', ['done.\n/worklane approve']);
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal(await commentAnswer(f, d2), null);
  for (const n of notes(f)) f.backlog.humanComment(1, 'example-owner', n.message);
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal(await commentAnswer(f, d2), null);
});

test('AD5b (lost response, tracker account is the owner): a worker\'s line in an UNRECORDED question comment answers the land as the owner', async () => {
  const f = fixture('example-owner');
  const land = await ask(f, 'land', LAND);
  f.backlog.lostNext = 1;
  await assert.rejects(ask(f, 'question', ['yes', 'no'], 'Continue?', [`done.\n/worklane approve ${land.id}`]));
  const a = await commentAnswer(f, land);
  assert.equal(a, null, `the coordinator's own (unrecorded) question comment answered the land: ${JSON.stringify(a)}`);
});

// ===== AD6: a flood. One writer comment of unknown-id lines: a note each, and a full log scan per line =====

test('AD6 control: a writer comment with one unknown id: one note', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-collaborator', '/worklane x d-9-000000');
  await commentAnswer(f, d1);
  assert.equal(notes(f).filter((n) => n.kind === 'reply_note').length, 1);
});

test('AD6 (flood): one writer comment (< 65536 chars) of unknown-id lines: notes stay bounded and a pass stays fast', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const N = 2700;
  const body = Array.from({ length: N }, (_, i) => `/worklane x d-9-${i.toString(16).padStart(6, '0')}`).join('\n');
  assert.ok(body.length < 65536, String(body.length));
  f.backlog.humanComment(1, 'example-collaborator', body);
  const t0 = performance.now();
  await commentAnswer(f, d1);
  const first = Math.round(performance.now() - t0);
  const t1 = performance.now();
  await commentAnswer(f, d1);
  const second = Math.round(performance.now() - t1);
  const n = notes(f).filter((x) => x.kind === 'reply_note').length;
  console.log(`# AD6: ${N} lines -> ${n} notes; first pass ${first} ms, second pass ${second} ms`);
  assert.ok(n <= 10, `FLOOD: ${n} reply_unknown_id notes from one writer comment (first pass ${first} ms, second ${second} ms)`);
});

// AD7 and AD7b (GraphQL's lastEditedAt) are gone with the GraphQL read itself: with the id required, no edit is read.

test('AD6b (flood hides the notice): a writer comment of 60 unknown-id lines pushes the owner\'s reply_ambiguous note off the dashboard', async () => {
  const { project } = await import('../src/projection.js');
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve');
  const shown = () => {
    const p = project(f.log.read(0)) as unknown as { errors: { kind: string; message: string }[]; earlierErrors: { kind: string; message: string }[] };
    return [...p.errors, ...p.earlierErrors].filter((e) => /^reply_/.test(e.kind)).length; // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line)
  };
  // control: with no flood the note is shown
  assert.equal(await commentAnswer(f, d2), null);
  assert.ok(shown() > 0, 'control: the reply_ambiguous note is on the dashboard');
  f.backlog.humanComment(1, 'example-collaborator', Array.from({ length: 60 }, (_, i) => `/worklane x d-9-${i.toString(16).padStart(6, '0')}`).join('\n'));
  await commentAnswer(f, d1);
  assert.ok(shown() > 0, `NOTICE GONE: the owner's reply to ${d2.id} answered nothing, and its reply_ambiguous note is no longer shown`);
});

// ===== Not the reviews': the owner's rule end to end (2026-11-09: a reply answers only by naming the decision's id) =====
test("IDS1: the decision's own id in capitals answers it; with a Unicode dash or in full-width forms nothing, with a note (changed by the ASCII rule); never another decision", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  const d2 = await ask(f, 'land', LAND, 'Land the other?');
  const fullWidth = (s: string) => [...s].map((ch) => (/[a-z0-9]/.test(ch) ? String.fromCodePoint(ch.codePointAt(0)! + 0xfee0) : ch)).join('');
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id.toUpperCase().replace(/-/g, '\u2011')}`);
  f.backlog.humanComment(1, 'example-owner', `/worklane reject ${fullWidth(d2.id)}`);
  // changed by the ASCII rule (the owner, 2026-11-10: a reply is plain ASCII; curly quotes and en or em dashes read as ' " -): both answered before (approve, reject); now neither, one note each naming the character.
  assert.equal(await commentAnswer(f, d1), null, 'capitals and no-break hyphens');
  assert.equal(await commentAnswer(f, d2), null, 'full-width letters and digits');
  assert.deepEqual(notes(f).filter((n) => n.kind.startsWith('reply_')).map((n) => n.kind), ['reply_note', 'reply_note']);
  assert.match(notes(f)[0]!.message, /U\+2011 on line 1/);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id.toUpperCase()}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'approve', 'capitals alone');
});

test("IDS2: a line naming a decision with an option it doesn't offer answers nothing and says so once", async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `/worklane aprove ${d1.id}`);
  assert.equal(await commentAnswer(f, d1), null);
  assert.equal(await commentAnswer(f, d1), null);
  const n = notes(f).filter((x) => x.kind === 'reply_note');
  assert.equal(n.length, 1, JSON.stringify(notes(f)));
  assert.match(n[0]!.message, /aprove.*approve, reject/);
});

test("IDS3: a comment starting with `[worklane]` (the coordinator's own) is never a reply, even by the owner's account (R1182ad 7)", async () => {
  const f = fixture('example-owner');
  const d1 = await ask(f, 'land', LAND);
  // A comment the coordinator posted as the owner's account (local mode posts with the owner's gh login), quoting a command.
  f.backlog.humanComment(1, 'example-owner', `[worklane] summary of the worker's run:\n/worklane approve ${d1.id}`);
  assert.equal(await commentAnswer(f, d1), null);
  assert.deepEqual(notes(f).filter((n) => n.kind.startsWith('reply_')), [], 'and no note for it');
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${d1.id}`);
  assert.equal((await commentAnswer(f, d1))?.answer, 'approve', 'control: the owner\'s own reply answers');
});

test('IDS4: one note per reply, whatever its lines; a second pass writes none (R1182ad 5)', async () => {
  const f = fixture();
  const d1 = await ask(f, 'land', LAND);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve\n/worklane approve d-1-0badid\n/worklane approve ${d1.id} d-1-ffffff\n/worklane aprove ${d1.id}`);
  await commentAnswer(f, d1);
  await commentAnswer(f, d1);
  const n = notes(f).filter((x) => x.kind.startsWith('reply_'));
  assert.equal(n.length, 1, JSON.stringify(n));
  assert.equal(n[0]!.kind, 'reply_note', 'the gravest problem is the one named'); // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text; a second command voids it): four commands (was reply_several_ids)
});
