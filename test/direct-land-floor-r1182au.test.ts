// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182au (final) probes on #1182 at b1466553, ported. AU1: a task-list item naming an issue draws that issue's title,
// which no check reads; a reply now holds no task-list item and no issue or PR reference (#N, owner/repo#N, GH-N, an
// issue or PR link) anywhere (the organizer, 2026-11-11). Assertions as the reviewer wrote them unless marked.
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
  const base = mkdtempSync(join(tmpdir(), 'r1182au-'));
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
// What GitHub's body_text gives for a task list of issue references: the list text with "#N" only (cli-7309.json).
const tasklistText = (id: string, n: number) => `/worklane approve ${id}\ntracked here:\n\n#${n}\n`;
test('AU1 DEFECT: "- [ ] #2" draws issue #2\'s title on the page (here "/worklane reject <id>"); body, readings and body_text all miss it: must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\ntracked here:\n\n- [ ] #2`, (id) => tasklistText(id, 2));
  safe(f, q);
});
test('AU1b DEFECT: the same with the issue URL ("- [x] https://github.com/o/r/issues/2" renders as #2, unfurled): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n- [x] https://github.com/example-org/example-repo/issues/2`, (id) => tasklistText(id, 2));
  safe(f, q);
});
// changed by R1182au/av (no issue or PR reference anywhere; the look-alike scan after punctuation): the control answered; any issue reference now voids (the page can expand one), with one note.
test('AU1 control, changed: the same issue reference outside a task list now voids (reply_markup)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\ntracked in #2`, (id) => `/worklane approve ${id}\ntracked in #2`);
  safe(f, q);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
});
// Plausible plain replies.
test('FV: a short note answers (revise)', async () => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Plan?');
  const c = f.backlog.humanComment(1, OWNER, `/worklane revise ${q.id} keep it smaller, two files at most`);
  f.backlog.setCommentText(1, c, `/worklane revise ${q.id} keep it smaller, two files at most`);
  await handle(f);
  assert.deepEqual(answered(f).filter((a) => a.id === q.id).map((a) => a.answer), ['revise'], JSON.stringify(notes(f)));
});
test('FV: a URL without & and a number on later lines answer', async () => {
  const b = (id: string) => `/worklane approve ${id}\n\nsee https://example.com/runs/42?id=7 for run 42, 3 of 3 green\n`;
  const { f, q } = await landT(b, (id) => b(id).trim());
  safe(f, q); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): a second line (and a URL) voids it now
  const one = await landT((id) => `/worklane approve ${id} run 42, 3 of 3 green`, (id) => `/worklane approve ${id} run 42, 3 of 3 green`);
  answers(one.f, one.q);
});
// The character rule: each character anywhere (inside a word, inside a URL), named with its line.
const CH: [string, string, string][] = [['`', 'a backtick (`)', 'x`y'], ['<', 'a < (HTML)', 'a<b'], ['>', 'a > (HTML or a quote)', 'a>b'], ['$', 'a $ (GitHub math)', 'https://example.com/a$b'], ['&', 'an & (an HTML entity)', 'https://example.com/?a=1&b=2'], ['~', 'a ~ (a fence or strikethrough)', 'https://example.com/~me'], ['![', 'an image (![)', 'wow![x']];
for (const [ch, name, word] of CH) {
  test(`CHAR ${ch}: "${word}" on line 4 voids with one reply_markup naming ${name} on line 4`, async () => {
    const b = (id: string) => `/worklane approve ${id}\nfine\n\nsee ${word} here`;
    const { f, q } = await landT(b, (id) => b(id));
    safe(f, q);
    await handle(f);
    assert.deepEqual(kinds(f), ['reply_note']);
    assert.match(notes(f)[0]!.message, /more than one line/); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): the character is on a second line
  });
}
test('CHAR: CRLF lines count; the first character by position wins', async () => {
  const b = (id: string) => `/worklane approve ${id}\r\n\r\nok ~ then < later`;
  const { f, q } = await landT(b, () => null);
  safe(f, q);
  assert.match(notes(f)[0]!.message, /more than one line/); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line)
});
test('CHAR: a non-reply comment with a backtick gets no note', async () => {
  const b = () => 'run `npm test` first';
  const { f } = await landT(b, () => 'run npm test first');
  assert.deepEqual(kinds(f), []);
});
