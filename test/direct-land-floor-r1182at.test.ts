// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182at (adversarial) probes on #1182 at b015036d, ported. AT1-AT2 are impossible by construction under the character
// rule (no ` < > $ & ~ anywhere); AT3: an emoji shortcode is named only when the rendering's character is a pictograph
// and a :word: of the comment is gone from the rendering. FV4 (<PR 1180>) is the owner's question, pinned at today's
// behaviour. Assertions as the reviewer wrote them unless marked; non-ASCII as \u escapes.
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
  const base = mkdtempSync(join(tmpdir(), 'r1182at-'));
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
const kinds = (f: Fixture) => notes(f).map((n) => n.kind);
/** body_text of a fenced block nested in a container: its source lines as typed, without the container's markers. */
const sourceText = (b: string) => flat(b.replace(/^(?:> ?|- |1\. |\s{2,4})/gm, ''));

// AT1: the fence check (MARKUP[0], /^ {0,3}(?:`{3,}|~{3,})/m) only sees a fence at a line start. A fence in a blockquote
// or a list item is just as much a fence, and GitHub renders mermaid and math fences there (nested.log).
const BQ = (lines: string[]) => lines.map((l) => `> ${l}`).join('\n');
test('AT1a DEFECT: mermaid in a blockquote draws a second command (#47;worklane reject d#45;1-...): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${BQ(['```mermaid', 'flowchart LR', `A["#47;worklane reject ${id.replace('-', '#45;')}"]`, '```'])}`, (_id, b) => sourceText(b));
  safe(f, q);
});
test('AT1b DEFECT: mermaid in a blockquote draws non-ASCII look-alikes (#8725; #1281;): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${BQ(['```mermaid', 'flowchart LR', `A["#8725;worklane reject #1281;${id.slice(1)}"]`, '```'])}`, (_id, b) => sourceText(b));
  safe(f, q);
});
test('AT1c DEFECT: mermaid in a list item (fence left open: it closes with the item) draws the live id: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n- \`\`\`mermaid\n  flowchart LR\n  A["${id.replace('-', '#45;')} is rejected"]`, (_id, b) => sourceText(b));
  safe(f, q);
});
test('AT1d DEFECT: mermaid in a list item, closing fence indented 4 (inside "1.  "), draws the live id: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n1.  \`\`\`mermaid\n    flowchart LR\n    A["${id.replace('-', '#45;')} is rejected"]\n    \`\`\``, (_id, b) => sourceText(b));
  safe(f, q);
});
test('AT1e DEFECT: a math fence in a blockquote draws the live id from \\text pieces: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${BQ(['```math', `\\text{${id.slice(0, 1)}}\\text{${id.slice(1)} is rejected}`, '```'])}`, (_id, b) => sourceText(b));
  safe(f, q);
});
test('AT1 control: the same mermaid block at the top level voids with reply_markup', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n\`\`\`mermaid\nflowchart LR\nA["#47;worklane reject ${id.replace('-', '#45;')}"]\n\`\`\``, (_id, b) => sourceText(b));
  safe(f, q);
  assert.deepEqual(kinds(f), ['reply_note']);
});

// AT2: the tag check (MARKUP[4]) only sees a tag on one line with no < inside. CommonMark raw HTML allows a line break
// inside a tag, and a < inside a quoted attribute value. An attribute value is decoded by the browser's HTML5 parser,
// which also decodes a numeric reference with no semicolon (html5.log); pageNotAscii's ENTITY needs the semicolon, and
// body_text leaves alt and title out. So the page draws a non-ASCII look-alike that nothing checks.
const LOOK = (id: string) => `&#8725worklane reject &#1281${id.slice(1)}`;
test('AT2a DEFECT: an <img> tag over two lines, alt drawn as "\u2215worklane reject \u0501-1-...": must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n<img\nsrc="https://example.invalid/x.png" alt="${LOOK(id)}">`, (id) => `/worklane approve ${id}\n`);
  safe(f, q);
});
test('AT2b DEFECT: an <img> on one line with alt="<", title drawn as the same look-alike: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n<img alt="<" src="https://example.invalid/x.png" title="${LOOK(id)}">`, (id) => `/worklane approve ${id}\n`);
  safe(f, q);
});
test('AT2c DEFECT (no exploit; the rule as stated): a <details> tag over two lines answers; an HTML tag anywhere must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n<details\nopen>more\n\nthe gate is retried once`, (id) => `/worklane approve ${id}\nmore\nthe gate is retried once`);
  safe(f, q);
});
test('AT2 control: the same <img> on one line voids with reply_markup', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n<img src="https://example.invalid/x.png" alt="${LOOK(id)}">`, (id) => `/worklane approve ${id}\n`);
  safe(f, q);
  assert.deepEqual(kinds(f), ['reply_note']);
});
test('HELD (body_text): a tag over two lines joining the id voids (body_text shows it joined)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${id.slice(0, 4)}<b\nid="x">${id.slice(4)} is rejected`, (id) => `/worklane approve ${id}\n${id} is rejected`);
  safe(f, q);
});
test('HELD (body_text): a processing instruction <?x?> joining the id voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${id.slice(0, 4)}<?x?>${id.slice(4)} is rejected`, (id) => `/worklane approve ${id}\n${id} is rejected`);
  safe(f, q);
});
test('HELD (body_text): a declaration <!X> joining the id voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${id.slice(0, 4)}<!X>${id.slice(4)} is rejected`, (id) => `/worklane approve ${id}\n${id} is rejected`);
  safe(f, q);
});

// AT3: the rendering note's line is the comment's first `:word:` (src/decision-reply.ts:269), taken as an emoji shortcode
// even when it is a time, and even when the character came from something else (here a footnote's U+21A9).
test('AT3 DEFECT: "10:30:00" is not an emoji shortcode: the note must not name its line as one', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nchecked at 10:30:00\nper the runbook[^1]\n\n[^1]: section 4`, (id) => `/worklane approve ${id}\nchecked at 10:30:00\nper the runbook1\nFootnotes\n\n\nsection 4 \u21A9`);
  safe(f, q); // FV2: voids (owner question, pinned)
  const m = notes(f).map((n) => n.message).join('\n');
  assert.doesNotMatch(m, /on line 3, the line of its first emoji shortcode/, m);
});
test('AT3 control: a real shortcode gives its own line', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nthanks :+1:`, (id) => `/worklane approve ${id}\nthanks \u{1F44D}`);
  safe(f, q);
  assert.match(notes(f)[0]!.message, /more than one line/); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): the second line voids it, whatever the shortcode
});

// FV4: the tag check takes `<word word>` for a tag even when CommonMark doesn't (an attribute name can't start with a
// digit), so GitHub shows it as text (probe-at.log: &lt;PR 1180&gt;).
// FV4 is the owner's question (filed by R1182at): pinned at today's behaviour, a void (a < anywhere).
test('FV4 (owner question, unchanged): "<PR 1180>" voids today (reply_markup: a <)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nsame fix as <PR 1180>`, (id) => `/worklane approve ${id}\nsame fix as <PR 1180>`);
  safe(f, q);
});
test('FV4 control: "<new name>" is a tag (GitHub drops it): voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nrename it to <new name>`, (id) => `/worklane approve ${id}\nrename it to`);
  safe(f, q);
});

// OWNER-RULE: costs the owner accepted ($ anywhere voids; a reply holds no markup). Pinned, not defects.
test('OWNER-RULE: "$40/month" voids (a $ anywhere)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nsaves about $40/month`, (id) => `/worklane approve ${id}\nsaves about $40/month`);
  safe(f, q);
  assert.deepEqual(kinds(f), ['reply_note']);
});

// HELD: other markdown. Each joins or draws only what body_text holds, or what a reading decodes; all void.
test('HELD: a reference link splitting the id voids (body_text)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${id.slice(0, 4)}[${id.slice(4, 8)}][r]${id.slice(8)} is rejected\n\n[r]: https://example.invalid/a`, (id) => `/worklane approve ${id}\n${id} is rejected`);
  safe(f, q);
});
test('HELD: emphasis splitting the id voids (readings drop * and _)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${id.slice(0, 4)}**${id.slice(4, 8)}**${id.slice(8)} is rejected`, (id) => `/worklane approve ${id}\n${id} is rejected`);
  safe(f, q);
});
test('HELD: a link title (hover) with an entity voids (decoded reading)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n[plan](https://example.invalid/a "reject &#100;${id.slice(1)}")`, (id) => `/worklane approve ${id}\nplan`);
  safe(f, q);
});
test('HELD: a link title with a backslash escape voids (readings drop \\)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n[plan](https://example.invalid/a "reject ${id.slice(0, 1)}\\${id.slice(1)}")`, (id) => `/worklane approve ${id}\nplan`);
  safe(f, q);
});
test('HELD: a heading, a list item and a task list item with the id void', async () => {
  for (const pre of ['# ', '- ', '- [ ] ', '> ', '| x | ']) {
    const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${pre}${id} is rejected`, (id) => `/worklane approve ${id}\n${id} is rejected`);
    safe(f, q);
  }
});
// changed by the character rule (R1182as/at): the control's last line was a quote (> quoted: looks fine), which now voids; it is plain text here.
test('HELD control: a plain reply on one line with a note answers', async () => {
  // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): was a multi-line reply that answered; on one line, in the allowed characters, it answers.
  const { f, q } = await landT((id) => `/worklane approve ${id} checked the gate log, see the run: looks fine`, (id) => `/worklane approve ${id} checked the gate log, see the run: looks fine`);
  answers(f, q);
});
