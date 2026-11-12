// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182ar (adversarial) probes on #1182 at f1b095dc, ported. AR1-AR3 (mermaid entity codes, GitHub math \text pieces, an
// image alt built from links) are closed by construction: a decision reply holds no fenced code block, $, image or HTML
// tag anywhere (the organizer, 2026-11-11), so each voids with one reply_markup note naming the construct and its line.
// FV1-FV3 (body_text adds non-ASCII for ASCII markup) are the owner's open question: pinned at today's behaviour (void).
// Assertions as the reviewer wrote them, except the FV cases and the note kinds added. Non-ASCII as \u escapes.
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
  const base = mkdtempSync(join(tmpdir(), 'r1182ar-'));
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
/** A land reply on an L3 decision whose body_text (GitHub's rendering as text) is `text(id, body)`. */
const landT = async (body: (id: string) => string, text: (id: string, body: string) => string | null) => {
  const f = fixture();
  const q = await QL3(f);
  const c = f.backlog.humanComment(1, OWNER, body(q.id));
  f.backlog.setCommentText(1, c, text(q.id, body(q.id)));
  await handle(f);
  return { f, q };
};
/** Blank lines collapsed, as body_text joins paragraphs with one line break. */
const flat = (s: string) => s.replace(/\n{2,}/g, '\n');
/** body_text of a mermaid block: its source as typed (inside pre/code), then the "Loading" placeholder. */
const mermaidText = (b: string) => flat(b.replace(/```mermaid\n([\s\S]*?)```/g, '\n  \n      $1\n    Loading\n'));
/** body_text of markdown images: left out (alt text dropped; the builder's measurement and gh-samples.log). */
const noImages = (b: string) => flat(b.replace(/!\[(?:[^\[\]]|\[[^\]]*\]\([^)]*\))*\]\([^)]*\)/g, ''));
const splitAt = (id: string, i: number) => [id.slice(0, i), id.slice(i)] as const;
const safe = (f: Fixture, q: Q) => {
  assert.equal(answered(f).filter((a) => a.id === q.id).length, 0, 'the decision must stay unanswered');
  assert.equal(queued(f), 0, 'the L3 land must not be queued');
};
const answers = (f: Fixture, q: Q, option = 'approve') => assert.deepEqual(answered(f).filter((a) => a.id === q.id).map((a) => a.answer), [option], JSON.stringify(notes(f)));
const ML = (src: string) => `\n\n\`\`\`mermaid\nflowchart LR\n  ${src}\n\`\`\``;

// AR1: mermaid entity codes. Mermaid turns `#45;` into `&#45;` (encodeEntities/decodeEntities, mermaid 11.17.2 dist), so a
// node label draws any character. The typed text has no `&`, no `/` before the CLI and no contiguous id; body_text holds
// the source as typed.
test('AR1a DEFECT: a mermaid label draws the live id (d#45;1-\u2026): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}${ML(`A["${id.replace('-', '#45;')} is rejected"]`)}`, (_id, b) => mermaidText(b));
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'closed by construction: the markup rule');
});
test('AR1b DEFECT: a mermaid label draws a second command (#47;worklane reject \u2026): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}${ML(`A["#47;worklane reject ${id.replace('-', '#45;')}"]`)}`, (_id, b) => mermaidText(b));
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'closed by construction: the markup rule');
});
test('AR1c DEFECT: a mermaid label draws non-ASCII look-alikes (#8725; #1281;): must void (rule (1) on the page)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}${ML(`A["#8725;worklane reject #1281;${id.slice(1)}"]`)}`, (_id, b) => mermaidText(b));
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'closed by construction: the markup rule');
});
test('AR1 control: the id typed plainly in a mermaid label voids, with a note', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}${ML(`A["${id} is rejected"]`)}`, (_id, b) => mermaidText(b));
  safe(f, q);
  assert.ok(notes(f).length > 0, 'a note says why'); // reply_id_elsewhere at this head; the trial fix voids it earlier, on the block
});

// AR2: GitHub math (math-renderer, MathJax 3, rendered in the browser). `\text{d}\text{-1-\u2026}` draws `d-1-\u2026` (tex.log);
// body_text holds the TeX source (gh-math.log).
test('AR2a DEFECT: inline math draws the live id from \\text pieces: must void', async () => {
  const { f, q } = await landT((id) => { const [a, b] = splitAt(id, 1); return `/worklane approve ${id}\n\nrisk: $\\text{${a}}\\text{${b} is rejected}$`; }, (_id, b) => flat(b));
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'closed by construction: the markup rule');
});
test('AR2b DEFECT: inline math draws a second command: must void', async () => {
  const { f, q } = await landT((id) => { const [a, b] = splitAt(id, 1); return `/worklane approve ${id}\n\n$\\text{/work}\\text{lane reject ${a}}\\text{${b}}$`; }, (_id, b) => flat(b));
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'closed by construction: the markup rule');
});
test('AR2 control: the id in one \\text{} voids, with a note', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n$\\text{${id}}$`, (_id, b) => flat(b));
  safe(f, q);
  assert.ok(notes(f).length > 0, 'a note says why'); // reply_id_elsewhere at this head; the trial fix voids it earlier, on the block
});

// AR3: a markdown image's alt is the plain text of its description, links flattened (render.log: commonmark.js and
// markdown-it give alt="d-1-a1b2c3 \u2026"); the browser draws the alt when the image fails to load. body_text leaves the alt
// out; the alt/title reading only reads `alt=` attributes of HTML tags.
test('AR3a DEFECT: an image description split by a link draws the live id as alt text: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n![${id.slice(0, 4)}[${id.slice(4, 8)}](https://example.invalid/a)${id.slice(8)} is rejected](https://example.invalid/x.png)`, (_id, b) => noImages(b));
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'closed by construction: the markup rule');
});
test('AR3b DEFECT: the same alt draws a second command: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n![/work[lane](https://example.invalid/a) reject ${id.slice(0, 4)}[${id.slice(4, 8)}](https://example.invalid/b)${id.slice(8)}](https://example.invalid/x.png)`, (_id, b) => noImages(b));
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'closed by construction: the markup rule');
});
test('AR3 control: the id typed in an image description voids (as typed)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n![${id} is rejected](https://example.invalid/x.png)`, (_id, b) => noImages(b));
  safe(f, q);
});
test('AR3 control: a link splitting the id in plain text voids through body_text (d-1-a1b2c3 there)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${id.slice(0, 4)}[${id.slice(4, 8)}](https://example.invalid/a)${id.slice(8)} is rejected`, (id) => `/worklane approve ${id}\n${id} is rejected`);
  safe(f, q);
});

// FV: false voids body_text adds to replies that are plain ASCII as typed (rule (1) is about the comment's characters).
// The owner's open question (FV1/FV2, filed by R1182ar): pinned at today's behaviour, a void with one reply_not_ascii note.
test('FV1 (owner question, unchanged): an emoji shortcode (:+1:) is U+1F44D in body_text; today the reply voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nthanks :+1:`, (id) => `/worklane approve ${id}\nthanks \u{1F44D}`);
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
});
test('FV1 control: the same reply without the shortcode answers', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id} thanks`, (id) => `/worklane approve ${id} thanks`); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): one line
  answers(f, q);
});
// The owner's open question (FV1/FV2, filed by R1182ar): pinned at today's behaviour, a void with one reply_not_ascii note.
test('FV2 (owner question, unchanged): a footnote adds "Footnotes" and U+21A9 to body_text; today the reply voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nsee the retry note[^1]\n\n[^1]: the gate is retried once`, (id) => `/worklane approve ${id}\nsee the retry note1\nFootnotes\n\n\nthe gate is retried once \u21A9`);
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
});
// The owner's open question (FV1/FV2, filed by R1182ar): pinned at today's behaviour, a void with one reply_not_ascii note.
test('FV3 (owner question, unchanged): a permalink adds the linked lines to body_text (here a U+2264 in the code); today the reply voids', async () => {
  const url = 'https://github.com/example-org/example-repo/blob/f1b095dc0be339f722254b8ec93a74f32115da2d/src/x.ts#L3';
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nthe bound is here: ${url}`, (id) => `/worklane approve ${id}\nthe bound is here: \n  \n      worklane/src/x.ts\n    \n         Line 3\n      in\n      f1b095d\n    \n           // n \u2264 limit \n`);
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
});

// HELD: body_text does catch these (each voids at this head).
test('HELD: a permalink whose linked lines hold the live id voids (body_text has the snippet)', async () => {
  const url = 'https://github.com/example-org/example-repo/blob/f1b095dc0be339f722254b8ec93a74f32115da2d/notes.md#L1';
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nsee ${url}`, (id) => `/worklane approve ${id}\nsee \n      notes.md\n         Line 1\n           /worklane reject ${id} \n`);
  safe(f, q);
});
test('HELD: a <details> body with a link-split id voids (body_text keeps details text)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n<details><summary>more</summary>\n\n${id.slice(0, 4)}[${id.slice(4, 8)}](https://example.invalid/a)${id.slice(8)} is rejected\n\n</details>`, (id) => `/worklane approve ${id}\nmore\n${id} is rejected`);
  safe(f, q);
});
