// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182av (adversarial) probes on #1182 at b1466553, ported. AV1: the look-alike second-command scan (SHAPED) now finds
// a slash after any character that isn't a letter, digit, _ or /, not only after a space. Assertions as the reviewer
// wrote them unless marked.
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
  const base = mkdtempSync(join(tmpdir(), 'r1182av-'));
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
const splitAt = (id: string, i: number) => [id.slice(0, i), id.slice(i)] as const;
const safe = (f: Fixture, q: Q) => {
  assert.equal(answered(f).filter((a) => a.id === q.id).length, 0, 'the decision must stay unanswered');
  assert.equal(queued(f), 0, 'the L3 land must not be queued');
};
const answers = (f: Fixture, q: Q, option = 'approve') => assert.deepEqual(answered(f).filter((a) => a.id === q.id).map((a) => a.answer), [option], JSON.stringify(notes(f)));

/** An ASCII look-alike of a decision id: 1 as l (identical to capital I in GitHub's sans-serif), 0 as O. Still id-shaped. */
const look = (id: string) => id.replace(/1/g, 'l').replace(/0/g, 'O');
const kinds = (f: Fixture) => notes(f).map((n) => n.kind);
const same = (_id: string, b: string) => flat(b);

// AV1: SHAPED (src/decision-reply.ts:94) starts with (?<!\S), so a look-alike `/word` command right after a visible
// punctuation mark isn't seen. Rule (c) closes this only for the live id itself (R1182ao); a look-alike id isn't the
// live id, so with a look-alike CLI name AND a look-alike id nothing voids. body_text shows the same punctuation, so the
// rendered scan misses it too. No refused character anywhere; line 1's `,` and `:` are allowed.
test('HELD (line 1 ids): line 1 "ok,/workIane reject d-l-..." voids (two ids on line 1)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id} ok,/workIane reject ${look(id)}`, same);
  safe(f, q);
  assert.deepEqual(kinds(f), ['reply_note'], 'changed by R1182au/av (no issue or PR reference anywhere; the look-alike scan after punctuation): the scan now sees ,/workIane (was reply_several_ids)');
});
test('AV1b DEFECT: line 3 "(/workIane reject d-l-...)": must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n(/workIane reject ${look(id)})`, same);
  safe(f, q);
});
test('AV1c DEFECT: line 3 "Update:/workIane reject d-l-..." (a colon before the slash): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nUpdate:/workIane reject ${look(id)}`, same);
  safe(f, q);
});
test('AV1d DEFECT: line 3 in double quotes, "/workIane reject d-l-...": must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n"/workIane reject ${look(id)}"`, same);
  safe(f, q);
});
test('AV1e DEFECT: a link title (hover) "/workIane reject d-l-..." (body_text drops titles): must void', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nsee [the plan](https://example.invalid/plan "/workIane reject ${look(id)}")`, (id) => `/worklane approve ${id}\nsee the plan`);
  safe(f, q);
});
test('AV1 control: the same look-alike after a space voids (SHAPED), as reply_more_than_one', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nUpdate: /workIane reject ${look(id)}`, same);
  safe(f, q);
  assert.deepEqual(kinds(f), ['reply_note']);
});
test('AV1 control: the real id after "(" voids (rule (c))', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n(/workIane reject ${id})`, same);
  safe(f, q);
  assert.deepEqual(kinds(f), ['reply_note'], 'changed by R1182au/av (no issue or PR reference anywhere; the look-alike scan after punctuation): the scan now sees (/workIane first (was reply_id_elsewhere)');
});
test('AV1 control: the real CLI name after "(" voids (ANYWHERE has no boundary)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n(/worklane reject ${look(id)})`, same);
  safe(f, q);
});
test('AV1 control: the same reply without the look-alike answers', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id} ok, see the plan`, same); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): one line, no parentheses
  answers(f, q);
});

// HELD: markdown without a refused character that changes what the page shows.
test('HELD (body_text): an inline link splitting the live id, "[d-1-ab](url)cdef", voids', async () => {
  const { f, q } = await landT((id) => { const [a, b] = splitAt(id, 6); return `/worklane approve ${id}\n\nsee [${a}](https://example.invalid)${b}`; }, (id) => `/worklane approve ${id}\nsee ${id}`);
  safe(f, q);
});
test('HELD (readings): a backslash before the slash, "\\/workIane reject d-l-...", voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n\\/workIane reject ${look(id)}`, (id) => `/worklane approve ${id}\n/workIane reject ${look(id)}`);
  safe(f, q);
});
test('HELD (readings): emphasis around the look-alike, "*/workIane reject d-l-...*", voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n*/workIane reject ${look(id)}*`, (id) => `/worklane approve ${id}\n/workIane reject ${look(id)}`);
  safe(f, q);
});
test('HELD (body_text): a link whose text is the look-alike, "[/workIane reject d-l-...](url)", voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n[/workIane reject ${look(id)}](https://example.invalid)`, (id) => `/worklane approve ${id}\n/workIane reject ${look(id)}`);
  safe(f, q);
});
test('HELD (body_text): a table cell starting with the look-alike, "|x|/workIane reject d-l-...|", voids (cells on their own lines)', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n|a|b|\n|-|-|\n|x|/workIane reject ${look(id)}|`, (id) => `/worklane approve ${id}\n\na\nb\n\n\nx\n/workIane reject ${look(id)}\n`);
  safe(f, q);
});
test('HELD (body_text): a code permalink whose snippet holds the live id voids', async () => {
  const sha = 'b'.repeat(40);
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\nhttps://github.com/example-org/example-repo/blob/${sha}/notes.txt#L1`, (id) => `/worklane approve ${id}\n\n  \n    \n      worklane/notes.txt\n    \n        Line 1\n      in\n      bbbbbbb\n  \n           ${id} is rejected \n`);
  safe(f, q);
});
test('HELD (body_text): a task list item hiding nothing, "- [ ] /workIane reject d-l-...", voids', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id}\n\n- [ ] /workIane reject ${look(id)}`, (id) => `/worklane approve ${id}\n\n /workIane reject ${look(id)}`);
  safe(f, q);
});
test('RESIDUAL (body_text null; GitHub always sends it with full+json): an inline link splitting the id', async () => {
  // Not a defect on GitHub: github.ts always asks for full+json, and GitHub always returns body_text. Recorded because the
  // readings alone don't see through link syntax, which the head's comments call "extra defence".
  const { f } = await landT((id) => { const [a, b] = splitAt(id, 6); return `/worklane approve ${id}\n\nsee [${a}](https://example.invalid)${b}`; }, () => null);
  console.log('# RESIDUAL null body_text, link split: answered =', JSON.stringify(answered(f).map((a) => a.answer)));
});

// FALSE-VOID probes: plain replies, none with a refused character, that should answer.
// changed by R1182au/av (no issue or PR reference anywhere; the look-alike scan after punctuation): '#1180' and the PR link now void; the reviewer expected an answer.
test('PLAIN, changed: a PR URL and #1180 now void (reply_markup); a mention alone answers', async () => {
  const { f, q } = await landT((id) => `/worklane approve ${id} per #1180\n\nsame as https://github.com/example-org/example-repo/pull/1180, thanks @example-owner!`, (id) => `/worklane approve ${id} per #1180\nsame as #1180, thanks @example-owner!`);
  safe(f, q);
  assert.deepEqual(kinds(f), ['reply_note']);
  // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): a mention (an @) and a second line now void too.
  const m = await landT((id) => `/worklane approve ${id}\n\nthanks @example-owner!`, (id) => `/worklane approve ${id}\nthanks @example-owner!`);
  safe(m.f, m.q);
});
test('PLAIN: phone capitals, a trailing full stop and a signature answer', async () => {
  // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): the signature on later lines voids it now; on one line the capitals and the full stop answer.
  const two = await landT((id) => `/Worklane Approve ${id.toUpperCase()}.\n\nLooks right to me.\n-- J`, (id) => `/Worklane Approve ${id.toUpperCase()}.\nLooks right to me.\n-- J`);
  safe(two.f, two.q);
  const { f, q } = await landT((id) => `/Worklane Approve ${id.toUpperCase()}. Looks right to me.`, (id) => `/Worklane Approve ${id.toUpperCase()}. Looks right to me.`);
  answers(f, q);
});
test('PLAIN: a revise note with a path and a ratio answers, its note kept', async () => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Plan?');
  const c = f.backlog.humanComment(1, OWNER, `/worklane revise ${q.id} split src/a.ts and src/b.ts, 2/3 of the tests first`);
  f.backlog.setCommentText(1, c, `/worklane revise ${q.id} split src/a.ts and src/b.ts, 2/3 of the tests first`);
  await handle(f);
  assert.deepEqual(answered(f).map((a) => a.answer), [], 'changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment\'s one line): a / in the note is outside the allowlist (was revise)');
});
test('PLAIN: a CRLF reply (a Windows browser) answers', async () => {
  const two = await landT((id) => `/worklane approve ${id}\r\n\r\nok\r\n`, (id) => `/worklane approve ${id}\nok`);
  safe(two.f, two.q); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): a second line voids it (was an answer)
  const { f, q } = await landT((id) => `/worklane approve ${id} ok\r\n`, (id) => `/worklane approve ${id} ok`);
  answers(f, q);
});
