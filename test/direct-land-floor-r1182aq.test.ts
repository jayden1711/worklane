// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182aq (final) probes on #1182 at f1b095dc, ported. AQ2/AQ2b (D1): a reply_not_ascii note that comes only from
// GitHub's rendering names the comment's line of the first emoji shortcode and says it came from the rendering.
// Assertions as the reviewer wrote them unless marked. Non-ASCII as \u escapes.
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

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'r1182al-'));
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
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  backlog.open({ title: 't', body: 'x', author: 'example-owner', labels: ['ready'] });
  backlog.open({ title: 't2', body: 'x', author: 'example-owner', labels: ['ready'] });
  return { base, repo, cfg, backlog, log: new EventLog(join(base, 'events.db')), slotsDir, stateDir };
}
type Fixture = ReturnType<typeof fixture>;
const coord = (f: Fixture) =>
  new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: new FakeRunner(() => ({ structured: {} })), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });

const CMD = /^\/worklane\s+(\S+)/m;
const LAND = ['approve', 'reject'];
const PLAN = ['approve', 'revise', 'reject'];
type Answer = { by: string; answer: string; role: string } | null;
type Q = EventPayload<'decision.asked'>;
const commentAnswer = (f: Fixture, q: Q, n = 1): Promise<Answer> =>
  (coord(f) as unknown as { commentAnswer(n: number, q: Q, w: Set<string>, c: RegExp): Promise<Answer> }).commentAnswer(n, q, new Set(f.cfg.project.owners.writers.map((w) => w.toLowerCase())), CMD);
const ask = async (f: Fixture, kind: string, options: string[], question = 'Land?', issue = 1): Promise<Q> => {
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask(kind, issue, 'example-owner', question, options, '', ['x']);
  return f.log.read(0, ['decision.asked']).map((e) => e.payload as Q).find((x) => x.id === id)!;
};
const notes = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string }).map((p) => (/^reply_/.test(p.kind) ? { ...p, kind: 'reply_note' } : p)).filter((p) => p.kind.startsWith('reply_'));
const handle = (f: Fixture) => (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
const answered = (f: Fixture) => f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
const queued = (f: Fixture) => f.log.read(0, ['land.queued']).length;
const levelL3 = (f: Fixture) => f.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L3', reasons: ['high-risk: ci-config (.gitlab-ci.yml): held for the owner'] }, 'alice');
const OWNER = 'example-owner';
const QL3 = async (f: Fixture) => { levelL3(f); return ask(f, 'land', LAND, 'Approve landing #1 (L3)?'); };
const land = async (body: (id: string) => string) => {
  const f = fixture();
  const q = await QL3(f);
  f.backlog.humanComment(1, OWNER, body(q.id));
  await handle(f);
  return { f, q };
};
const planNote = async (body: (id: string) => string) => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, body(q.id));
  await handle(f);
  return f.log.read(0, ['plan.decided']).map((e) => e.payload as EventPayload<'plan.decided'>);
};


const kinds = (f: Fixture) => notes(f).map((n) => n.kind);
/** The owner's comment, with the tracker's rendering of it (GitHub's body_text) set as given. */
const landWith = async (body: (id: string) => string, text: (id: string) => string | null) => {
  const f = fixture();
  const q = await QL3(f);
  const c = f.backlog.humanComment(1, OWNER, body(q.id));
  f.backlog.setCommentText(1, c, text(q.id));
  await handle(f);
  return { f, q };
};


const firstNote = (f: Fixture) => notes(f)[0]?.message ?? '';

// ======== AQ1: an emoji shortcode (measured: GitHub's body_text draws :x: :heart: :tada: :warning: ... as emoji) ========
// changed by the owner's 2026-11-11 decision ("1182 fv: b"): the ASCII rule is on the typed text only, so an emoji GitHub draws from :+1: doesn't void.
// The typed `+` in :+1: is outside the allowlist, so that reply voids on its typed text; a :tada: (letters only) answers.
test('AQ1: `/worklane approve <id> thanks :+1:` voids (a typed +); `thanks :tada:` answers (the owner decided b)', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id} thanks :+1:`, (id) => `/worklane approve ${id} thanks \u{1F44D}`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_note']]);
  assert.match(firstNote(f), /U\+002B on line 1/);
  const t = await landWith((id) => `/worklane approve ${id} thanks :tada:`, (id) => `/worklane approve ${id} thanks \u{1F389}`);
  assert.deepEqual([answered(t.f)[0]?.answer, queued(t.f), kinds(t.f)], ['approve', 1, []]);
});

// ======== AQ2 (D1): the note names the rendering's line, not the comment's (body_text collapses blank lines) ========
// Measured: rails/rails#59548 comment 6680947175, body 'Rebase done!\r\n\r\n(Also, ... :zipper_mouth_face:)',
// body_text 'Rebase done!\n(Also, ... \u{1F910})': the shortcode is on line 3 of the comment, the emoji on line 2 of body_text.
test('AQ2 (D1): a shortcode on line 3 after a blank line: the reply_not_ascii note must name line 3 (the line the owner typed)', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id}\r\n\r\nthanks :tada:`, (id) => `/worklane approve ${id}\nthanks \u{1F389}`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_note']]);
  assert.match(firstNote(f), /more than one line/, 'changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment\'s one line): the second line voids it, whatever the shortcode');
});
test('AQ2b (D1): the same note must say the character came from GitHub\'s rendering (e.g. an emoji shortcode), not only "typed or drawn by an HTML entity or bidi markup"', async () => {
  // changed by the owner's 2026-11-11 decision ("1182 fv: b"): on the one line, a :tada: GitHub draws as an emoji answers.
  const { f } = await landWith((id) => `/worklane approve ${id} thanks :tada:`, (id) => `/worklane approve ${id} thanks \u{1F389}`);
  assert.deepEqual([answered(f)[0]?.answer, kinds(f)], ['approve', []]);
});

// ======== AQ3: plausible real replies with links, code spans, mentions, quotes and a task list, rendered as measured ========
// AQ3, changed by the character rule (R1182as/at, the organizer, 2026-11-11: no backtick, <, >, $, & or ~ anywhere): the quote and the code span now void the reply (it answered); without them it answers.
test('AQ3: a reply with a quote, a mention, a markdown link, a bare URL, a code span and a task list: voids (reply_markup); with only the mention, link, URL and task list, answers and queues', async () => {
  const { f } = await landWith(
    (id) => `/worklane approve ${id} ok to land\n\n> the tests pass on Linux\n\nThanks @example-writer, see [the run](https://github.com/o/r/actions/runs/1) and https://github.com/o/r/pull/2 and \`npm test\`.\n\n- [x] checked the logs`,
    (id) => `/worklane approve ${id} ok to land\nthe tests pass on Linux\nThanks @example-writer, see the run and #2 and npm test.\n\nchecked the logs`,
  );
  assert.deepEqual([answered(f).length, queued(f), kinds(f)], [0, 0, ['reply_note']]);
  const ok = await landWith(
    // changed by R1182au/av (no issue or PR reference anywhere; the look-alike scan after punctuation): the PR link (pull/2) and the task-list item now void; without them the reply answers.
    // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): one line, in the allowed characters (no @, no link).
    (id) => `/worklane approve ${id} ok to land, thanks, checked the logs`,
    (id) => `/worklane approve ${id} ok to land, thanks, checked the logs`,
  );
  assert.deepEqual([answered(ok.f)[0]?.answer, queued(ok.f), kinds(ok.f)], ['approve', 1, []]);
});
test('AQ3b: GitHub "Quote reply" of the question (it holds the id) answers nothing (the owner\'s accepted cost of rule (c))', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id}\n\n> Approve landing #1 (L3)? Reply /worklane approve ${id}`, (id) => `/worklane approve ${id}\nApprove landing #1 (L3)? Reply /worklane approve ${id}`);
  assert.deepEqual([answered(f).length, queued(f)], [0, 0]);
});
test('AQ4: a plan revise with a note on line 1 and a link and mention later: the note is line 1\'s only', async () => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  const c = f.backlog.humanComment(1, OWNER, `/worklane revise ${q.id} split the migration into two steps\n\nsee [this](https://example.invalid/x) @example-writer`);
  f.backlog.setCommentText(1, c, `/worklane revise ${q.id} split the migration into two steps\nsee this @example-writer`);
  await handle(f);
  assert.equal(f.log.read(0, ['plan.decided']).length, 0, 'changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment\'s one line): the second line voids it');
  const c2 = f.backlog.humanComment(1, OWNER, `/worklane revise ${q.id} split the migration into two steps`);
  f.backlog.setCommentText(1, c2, `/worklane revise ${q.id} split the migration into two steps`);
  await handle(f);
  const d = f.log.read(0, ['plan.decided']).map((e) => e.payload as EventPayload<'plan.decided'> & { note?: string });
  assert.equal(d.length, 1);
  assert.match(JSON.stringify(d[0]), /split the migration into two steps/);
  assert.doesNotMatch(JSON.stringify(d[0]), /example\.invalid|example-writer/);
});

// ======== AQ5: an empty body_text can't loosen anything ========
test('AQ5: body_text "" (empty string): a good reply answers; an entity-spelt id elsewhere still voids', async () => {
  const ok = await landWith((id) => `/worklane approve ${id}`, () => '');
  assert.equal(answered(ok.f)[0]?.answer, 'approve');
  // changed by the character rule (R1182as/at, the organizer, 2026-11-11: no backtick, <, >, $, & or ~ anywhere): an entity now voids first (reply_markup), so the readings are tested with an emphasis-split id instead.
  const bad = await landWith((id) => `/worklane approve ${id}\nreject *d*${id.slice(1)}`, () => '');
  assert.deepEqual([answered(bad.f).length, kinds(bad.f)], [0, ['reply_note']]);
});

// ======== AQ6: the slot allowance is a count (HELD: no known GitHub rendering drops line 1's id) ========
test('AQ6 HELD: a rendering without the slot id but with the id once elsewhere answers (count-based allowance)', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id} ok`, (id) => `/worklane approve\nok ${id}`); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): one typed line
  assert.equal(answered(f)[0]?.answer, 'approve');
});

// ======== AQ7: the FileBacklog double ========
test('AQ7: FileBacklog: the coordinator\'s own comment has no text; setCommentText on an unknown id is a no-op; editComment on one throws; text set after an edit is read', async () => {
  const f = fixture();
  await f.backlog.comment(1, 'hello');
  assert.equal((await f.backlog.comments(1))[0]!.text, undefined);
  f.backlog.setCommentText(1, 'nope', 'x');
  assert.throws(() => f.backlog.editComment(1, 'nope', 'x'));
  const q = await QL3(f);
  const c = f.backlog.humanComment(1, OWNER, `/worklane approve ${q.id}`);
  f.backlog.editComment(1, c, `/worklane approve ${q.id}`);
  f.backlog.setCommentText(1, c, `/worklane approve ${q.id}\n${q.id}`);
  await handle(f);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_note']]);
  const ids = (await f.backlog.comments(1)).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'comment ids are unique');
});

// ======== AQ8: GitHubBacklog mapping of body_text ========
test('AQ8: GitHubBacklog: body_text "" stays "", missing or null is null, a numeric id becomes a string', async () => {
  const fx = (async () => new Response(JSON.stringify([
    { id: 11, user: { login: OWNER }, body: 'a', body_text: '' },
    { id: 12, user: { login: OWNER }, body: 'b', body_text: null },
    { id: 13, user: null, body: null },
  ]), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const list = await new GitHubBacklog('o/r', () => 't', fx).comments(1);
  assert.deepEqual(list.map((c) => [c.id, c.author, c.body, c.text]), [['11', OWNER, 'a', ''], ['12', OWNER, 'b', null], ['13', '', '', null]]);
});
