// R1182as (final) probes on #1182 at b015036d, ported. AS1-AS3 (a fence in a quote or list item, &#36;/&dollar; math, a
// multi-line tag) are impossible by construction: a decision reply holds none of ` < > $ & ~ anywhere (characters, not
// constructs; the organizer, 2026-11-11). Each voids with one reply_markup note naming the first such character and its
// line. Assertions as the reviewer wrote them unless marked; non-ASCII as \u escapes.
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
  const base = mkdtempSync(join(tmpdir(), 'r1182as-'));
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
const notes = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string }).filter((p) => p.kind.startsWith('reply_'));
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
const markupNotes = (f: Fixture) => notes(f).filter((n) => n.kind === 'reply_markup');

// AS1: a fence is a fence inside a container. markupIn's fence pattern is `^ {0,3}(```|~~~)`, so `> ````, `- ```` and a
// list item's 4-space indent are missed; GitHub renders each as mermaid or math.
test('AS1a DEFECT: a mermaid fence inside a blockquote draws the live id (#45;): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n> \`\`\`mermaid\n> flowchart LR\n>   A["${id.replace('-', '#45;')} is rejected"]\n> \`\`\``, (_id, b) => flat(b.replace(/^> ?/gm, '')) + '\nLoading');
  safe(f, q);
});
test('AS1b DEFECT: a mermaid fence in a "10." list item (content indent 4) draws a second command (#47;worklane reject): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n10. \`\`\`mermaid\n    flowchart LR\n      A["#47;worklane reject ${id.replace('-', '#45;')}"]\n    \`\`\``, (_id, b) => flat(b) + '\nLoading');
  safe(f, q);
});
test('AS1b note: a "- " list-item fence is caught only because its closing fence is at 2 spaces (held, by accident)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n- \`\`\`mermaid\n  flowchart LR\n    A["#47;worklane reject ${id.replace('-', '#45;')}"]\n  \`\`\``, (_id, b) => flat(b) + '\nLoading');
  safe(f, q);
  assert.match(markupNotes(f)[0]?.message ?? '', /a backtick \(`\) on line 3/); // changed by the character rule (R1182as/at): the first refused character, the fence's backtick (was: the fence on line 6)
});
test('AS1c DEFECT: a ```math fence indented 4 spaces under a list item draws the id from \\text pieces: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n10. risk\n\n    \`\`\`math\n    \\text{${id.slice(0, 1)}}\\text{${id.slice(1)} is rejected}\n    \`\`\``, (_id, b) => flat(b));
  safe(f, q);
});
test('AS1 control: the same mermaid fence at the top level voids with reply_markup', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n\`\`\`mermaid\nflowchart LR\n  A["${id.replace('-', '#45;')}"]\n\`\`\``, (_id, b) => flat(b));
  safe(f, q);
  assert.equal(markupNotes(f).length, 1);
});

// AS2: math opened by an entity. `&#36;` and `&dollar;` open GitHub math; markupIn looks for a literal `$` only, and
// pageNotAscii lets ASCII entities through.
test('AS2a DEFECT: &#36;\u2026&#36; math draws the live id from \\text pieces: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nrisk: &#36;\\text{${id.slice(0, 1)}}\\text{${id.slice(1)} is rejected}&#36;`, (id) => `/worklane approve ${id}\nrisk: $\\text{${id.slice(0, 1)}}\\text{${id.slice(1)} is rejected}$`);
  safe(f, q);
});
test('AS2b DEFECT: &dollar;\u2026&dollar; math draws a second command: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n&dollar;\\text{/work}\\text{lane reject ${id.slice(0, 1)}}\\text{${id.slice(1)}}&dollar;`, (id) => `/worklane approve ${id}\n$\\text{/work}\\text{lane reject ${id.slice(0, 1)}}\\text{${id.slice(1)}}$`);
  safe(f, q);
});
test('AS2 control: a typed $ voids with reply_markup on its line', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nrisk: $\\text{x}$`, (id) => `/worklane approve ${id}\nrisk: $\\text{x}$`);
  safe(f, q);
  assert.match(markupNotes(f)[0]?.message ?? '', /a \$ \(GitHub math\) on line 3/);
});

// AS3: an HTML tag across a line break. markupIn's tag pattern stops at a newline, so `<img` + newline + `src=\u2026>` is
// missed; GitHub renders the image (render.log). An image can draw any text; the rule says an image or tag voids.
test('AS3 DEFECT: a multi-line <img> tag renders an image: must void (an image and an HTML tag, both stated)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nsee <img\nsrc="https://example.invalid/x.png"> here`, (id) => `/worklane approve ${id}\nsee  here`);
  safe(f, q);
});
test('AS3 control: the one-line <img> voids with reply_markup', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nsee <img src="https://example.invalid/x.png"> here`, (id) => `/worklane approve ${id}\nsee  here`);
  safe(f, q);
  assert.match(markupNotes(f)[0]?.message ?? '', /a < \(HTML\) on line 3/); // changed by the character rule (R1182as/at): was 'an HTML tag'
});

// NOTE: one reply_markup note naming the first construct and its line.
test('NOTE: the first construct by position is named, with its line (an image on 3 before a $ on 4)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n![a](https://example.invalid/x.png)\ncosts $5`, (id) => `/worklane approve ${id}\ncosts $5`);
  safe(f, q);
  const m = markupNotes(f);
  assert.equal(m.length, 1);
  assert.match(m[0]!.message, /an image \(!\[\) on line 3/);
});
test('NOTE: a fence after CRLF line breaks is named on the right line', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\r\n\r\nok\r\n\`\`\`\r\nx\r\n\`\`\``, (id) => `/worklane approve ${id}\nok\nx`);
  safe(f, q);
  assert.match(markupNotes(f)[0]?.message ?? '', /a backtick \(`\) on line 4/); // changed by the character rule (R1182as/at): was 'a fenced code block'
});
test('NOTE: an HTML comment is named', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nfine <!-- hidden -->`, (id) => `/worklane approve ${id}\nfine `);
  safe(f, q);
  assert.match(markupNotes(f)[0]?.message ?? '', /a < \(HTML\) on line 3/); // changed by the character rule (R1182as/at): was 'an HTML comment'
});
test('NOTE: one note only, even after a second pass', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\ncosts $5`, (id) => `/worklane approve ${id}\ncosts $5`);
  await handle(f);
  safe(f, q);
  assert.equal(markupNotes(f).length, 1);
});
test('COST: a $ anywhere voids (stated): "approve, it saves $5 a month" answers nothing', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nit saves $5 a month`, (id) => `/worklane approve ${id}\nit saves $5 a month`);
  safe(f, q);
});

// FV: plausible plain replies must still answer.
const plain: [string, (id: string) => string][] = [
  ['a bare URL', () => 'see https://example.com/a/b?c=d#e for the run'],
  ['an @mention', () => 'thanks @example-owner'],
  ['a #123 ref', () => 'same as #123 and owner/repo#45'],
  ['an email-like word', () => 'ping ops@example.com about it'],
  ['an autolink <https://...>', () => 'see <https://example.com/x>'],
  ['an email autolink', () => 'mail <ops@example.com>'],
  ['a code span', () => 'the `retry` flag stays'],
  ['a less-than comparison', () => 'only if load < 20 and x > 3'],
  ['a link [text](url)', () => 'see [the run](https://example.com/run)'],
  ['a heading, list and quote', () => '## why\n\n- one\n- two\n\n> quoted text'],
  ['a table', () => '| a | b |\n|---|---|\n| 1 | 2 |'],
  ['an exclamation', () => 'great work! [link](https://example.com)'],
  ['a tilde', () => 'about ~5 minutes'],
];
for (const [name, extra] of plain) {
  // changed by the character rule (R1182as/at): the entries holding ` < > $ & ~ (an autolink, an email autolink, a code span, a comparison, a quote, a tilde)
  // answered before; they now void with reply_markup, the rule's stated cost. The rest still answer.
  const refused = /[`<>$&~]|#\d/.test(extra('d-1-x')); // changed by R1182au/av (no issue or PR reference anywhere; the look-alike scan after punctuation): '#123' now voids too
  test(`FV: ${name} ${refused ? 'voids now (reply_markup; was an answer)' : 'answers'}`, async () => {
    const { f, q } = await landT((id) => `/worklane approve ${id}\n\n${extra(id)}`, (id) => `/worklane approve ${id}\n${extra(id).replace(/[`#>|-]/g, '')}`);
    if (refused) {
      safe(f, q);
      assert.deepEqual(markupNotes(f).map((n) => n.kind), ['reply_markup']);
    } else answers(f, q);
  });
}
test('FV minor: an inline ```code``` span at a line start voids (a backtick: changed by the character rule (R1182as/at); the reviewer asked it to answer)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n\`\`\`retry\`\`\` stays on`, (id) => `/worklane approve ${id}\nretry stays on`);
  safe(f, q);
});

// QUESTION (not counted as a defect): a bare user-attachments URL on its own line renders a <video> player, and
// body_text drops the URL (gh/bare-asset.log: mermaid-js/mermaid#8441, #8357). A video frame can draw any text, as an
// image can; the rule voids images only. Pinned at today's behaviour: it answers.
test('AS4 QUESTION: a bare user-attachments video URL answers today (a video can draw any text)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nhttps://github.com/user-attachments/assets/0b5c6f2e-1d1e-4c6e-9b1a-2f3e4d5c6b7a`, (id) => `/worklane approve ${id}\n`);
  answers(f, q);
});
