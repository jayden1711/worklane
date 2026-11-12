// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182ao (final) and R1182ap (adversarial) probes on #1182 at e6e53103, ported. pageText's one reading of the page became
// every reading (pageReadings: decoded with tags kept, tags dropped then decoded, decoded then tags dropped, alt and
// title text, each reversed), real tags and comments only (HTML5's <!--> included), and rule (1) on the page: an entity
// that decodes outside plain ASCII, an unknown named entity, <bdo or a dir= attribute voids with reply_not_ascii, naming
// its line. Assertions as the reviewers wrote them, except AP4 (the owner's open question; see there). The fixture is
// attack-1182ap.test.ts's; non-ASCII characters are written as \u escapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'r1182ap-'));
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
const SHOWN_AGAIN: [string, (id: string) => string][] = [
  ['AO1a &lrm; inside the id (the page shows the id)', (id) => `/worklane approve ${id}\nreject d&lrm;${id.slice(1)}`],
  ['AO1b &rlm; inside the id', (id) => `/worklane approve ${id}\nreject d&rlm;${id.slice(1)}`],
  ['AO1c &NegativeMediumSpace; inside the id', (id) => `/worklane approve ${id}\nreject d&NegativeMediumSpace;${id.slice(1)}`],
  ['AO1d &NegativeThinSpace; inside the id', (id) => `/worklane approve ${id}\nreject d&NegativeThinSpace;${id.slice(1)}`],
  ['AO2a <d&#45;...> (not a tag: the page shows <id>)', (id) => `/worklane approve ${id}\nreject <d&#45;${id.slice(2)}>`],
  ['AO2b &lt;d&#45;...&gt;', (id) => `/worklane approve ${id}\nreject &lt;d&#45;${id.slice(2)}&gt;`],
  ['AO2c a < then the id, a > on a later line', (id) => `/worklane approve ${id}\nonly if 1 < 2, reject d&#45;${id.slice(2)}\n> quoted`],
  ['AO2d <!--> ends the comment on the page', (id) => `/worklane approve ${id}\n<!--> reject d&#45;${id.slice(2)} -->`],
  ['AO2e img alt (a broken image shows it)', (id) => `/worklane approve ${id}\n<img alt="reject d&#45;${id.slice(2)}" src="x">`],
  ['AO3a look-alike second command, id in angle brackets', (id) => `/worklane approve ${id}\n/workIane reject <d&#45;${id.slice(2)}>`],
  ['AO3b look-alike second command, id with &lrm;', (id) => `/worklane approve ${id}\n/workIane reject d&lrm;${id.slice(1)}`],
];
for (const [name, body] of SHOWN_AGAIN) {
  test(`${name}: answers nothing, nothing queues, one note`, async () => {
    const { f } = await land(body);
    assert.deepEqual([answered(f).length, queued(f), kinds(f).length], [0, 0, 1], JSON.stringify(answered(f)));
  });
}
test('AO control: the slot-only reply answers and queues', async () => {
  const { f } = await land((id) => `/worklane approve ${id}`);
  assert.deepEqual([answered(f)[0]?.answer, queued(f)], ['approve', 1]);
});

const ent = (s: string) => [...s].map((ch) => `&#${ch.codePointAt(0)};`).join('');
const rev = (s: string) => [...s].reverse().join('');
type Case = [string, (id: string) => string];
const mustVoid = (cases: Case[], why: string) => {
  for (const [name, body] of cases) {
    test(`${name}: ${why}, must answer nothing`, async () => {
      const { f } = await land(body);
      assert.equal(answered(f).length, 0, `VOID MISSED: ${JSON.stringify(answered(f))}`);
      assert.equal(queued(f), 0);
    });
  }
};

// ======== AP1 (DEFECT): pageText decodes entities BEFORE it drops tags and comments, so decoded text the page shows
// literally (`&lt;` is text, never a tag) is deleted, and an entity-spelled second command or id goes unseen ========
mustVoid([
  ['AP1a &lt;&#47;worklane reject <id&gt;', (id) => `/worklane approve ${id}\n&lt;&#47;worklane reject ${ent(id)}&gt;`],
  ['AP1b note < &#47;worklane reject <id> >', (id) => `/worklane approve ${id}\nnote < &#47;worklane reject ${ent(id)} >`],
  ['AP1c &lt;!-- &#47;worklane reject <id> --&gt;', (id) => `/worklane approve ${id}\n&lt;!-- &#47;worklane reject ${ent(id)} --&gt;`],
  ['AP1d bare id between a < b and c > d', (id) => `/worklane approve ${id}\nrisk a < b; ${ent(id)} is rejected; c > d`],
  ['AP1e <img alt> shown when the image is broken', (id) => `/worklane approve ${id}\n<img src="https://invalid.invalid/x.png" alt="&#47;worklane reject ${ent(id)}">`],
], 'the page shows a second answer naming the open id');
test('AP1 control: the same second command without the < > voids (reply_more_than_one)', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\n&#47;worklane reject ${ent(id)}`);
  assert.equal(answered(f).length, 0);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'changed by the character rule (R1182as/at, the organizer, 2026-11-11: no backtick, <, >, $, & or ~ anywhere): was reply_more_than_one');
});
test('AP1 control: a bare entity-spelled id without the < > voids (reply_id_elsewhere)', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\nrisk: ${ent(id)} is rejected`);
  assert.equal(answered(f).length, 0);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note'], 'changed by the character rule (R1182as/at, the organizer, 2026-11-11: no backtick, <, >, $, & or ~ anywhere): was reply_id_elsewhere');
});
test('AP1 control, changed: "a < b > c" with nothing hidden now voids (reply_markup; the cost of the character rule)', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\nok if latency < 5ms and > 1ms`);
  assert.deepEqual([answered(f).length, notes(f).map((n) => n.kind)], [0, ['reply_note']], 'changed by the character rule (R1182as/at, the organizer, 2026-11-11: no backtick, <, >, $, & or ~ anywhere): was an answer');
  const words = await land((id) => `/worklane approve ${id} ok if latency is under 5ms and over 1ms`); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): one line
  assert.equal(answered(words.f).length, 1, 'said in words, it answers');
});

// ======== AP2 (DEFECT): bidi. The page draws the text right to left; pageText reads it left to right ========
mustVoid([
  ['AP2a <bdo dir="rtl"> reversed second command', (id) => `/worklane approve ${id}\n<bdo dir="rtl">${rev(`/worklane reject ${id}`)}</bdo>`],
  ['AP2b &#x202E; (RLO) reversed second command', (id) => `/worklane approve ${id}\n&#x202E;${rev(`/worklane reject ${id}`)}`],
], 'the page shows `/worklane reject <id>`');
test('AP2 control: <bdo dir="ltr"> forwards voids', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\n<bdo dir="ltr">/worklane reject ${id}</bdo>`);
  assert.equal(answered(f).length, 0);
});

// ======== AP3 (DEFECT, intent of the ASCII rule): ASCII entities draw non-ASCII look-alikes on the page ========
mustVoid([
  ['AP3a &#x2215; and &#x0501; (division slash, Cyrillic komi de)', (id) => `/worklane approve ${id}\n&#x2215;worklane reject &#x0501;${id.slice(1)}`],
  ['AP3b &#xFF0F; and &#xFF44; (fullwidth)', (id) => `/worklane approve ${id}\n&#xFF0F;worklane reject &#xFF44;${id.slice(1)}`],
  ['AP3c &hyphen; (U+2010) for the hyphens', (id) => `/worklane approve ${id}\n/workIane reject ${id.replace(/-/g, '&hyphen;')}`],
], 'the page shows a non-ASCII look-alike of a second command');
test('AP3 control: the same look-alike typed as Unicode voids (reply_not_ascii)', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\n\u2215worklane reject \u0501${id.slice(1)}`);
  assert.equal(answered(f).length, 0);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
});

// ======== HELD: spellings the normalizer produces (each voids at this head) ========
const HELD: Case[] = [
  ['backslash escape', (id) => `/worklane approve ${id}\nreject ${id.replace('-', '\\-')}`],
  ['numeric entity without ;', (id) => `/worklane approve ${id}\nreject &#100${id.slice(1)}`],
  ['nested/unclosed tags', (id) => `/worklane approve ${id}\nreject <b><i>${id.slice(0, 3)}</b>${id.slice(3)}`],
  ['details/summary', (id) => `/worklane approve ${id}\n<details><summary>more</summary>&#47;worklane reject ${ent(id)}</details>`],
  ['link reference definition', (id) => `/worklane approve ${id}\n\n[x]: https://e.x/${id}`],
  ['footnote', (id) => `/worklane approve ${id}\n\n[^${id}]: x`],
  ['code span', (id) => `/worklane approve ${id}\n\`/worklane reject ${id}\``],
  ['fenced block', (id) => `/worklane approve ${id}\n\`\`\`\n/worklane reject ${id}\n\`\`\``],
  ['upper case id', (id) => `/worklane approve ${id}\nreject ${id.toUpperCase()}`],
  ['emphasis inside the id', (id) => `/worklane approve ${id}\nreject ${id.slice(0, 2)}*${id.slice(2, 4)}*${id.slice(4)}`],
  ['<wbr> and &shy; inside the id', (id) => `/worklane approve ${id}\nreject ${id.slice(0, 3)}<wbr>${id.slice(3, 6)}&shy;${id.slice(6)}`],
  ['<!----> inside the id', (id) => `/worklane approve ${id}\nreject ${id.slice(0, 3)}<!---->${id.slice(3)}`],
  ['id again after the slot on line 1 (as in <id>)', (id) => `/worklane approve ${id} as in ${id}`],
];
for (const [name, body] of HELD) {
  test(`held: ${name} voids`, async () => {
    const { f } = await land(body);
    assert.equal(answered(f).length, 0);
  });
}

// ======== AP4 (minor, false void): a note word shaped like d-<word> counts as a second id ========
// The owner's question (MORNING.md), not changed here: ID is unchanged, so today this is refused as two ids. When the owner
// answers, this test changes with the rule.
// changed by the owner's 2026-11-11 decision ("1182 dword: b"): only an open decision's id counts as a second id, so `d-day` is a word.
test('AP4 (the owner decided b): /worklane revise <id> wait until after d-day decides revise, its note kept', async () => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, `/worklane revise ${q.id} wait until after d-day`);
  await handle(f);
  assert.deepEqual(notes(f), []);
  assert.deepEqual(f.log.read(0, ['plan.decided']).map((e) => (e.payload as { note: string }).note), ['wait until after d-day']);
});
test('AP4 control: the same note without the d- word decides revise', async () => {
  const decided = await planNote((id) => `/worklane revise ${id} wait until after launch day`);
  assert.equal(decided.length, 1);
});
