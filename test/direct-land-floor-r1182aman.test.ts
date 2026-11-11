// R1182am (final) and R1182an (adversarial) probes on #1182 at a9c9170d, ported: AN3 (the id right after the option),
// AM3 and AN4 (the notes name the rule's characters), AN5 (a reply_not_ascii note only for a live id). Assertions as the
// reviewers wrote them, with the note kind for AN3 added. The (b') void-scan cases (AM1, AM2, AN1, AN2) are below, under
// the owner's rule (c) of 2026-11-10: each now expects reply_id_elsewhere, and the AM path control changed (it voids).
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
const planNote = async (body: (id: string) => string) => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, body(q.id));
  await handle(f);
  return f.log.read(0, ['plan.decided']).map((e) => e.payload as EventPayload<'plan.decided'>);
};
const strike = (s: string) => [...s].map((x) => x + '\u0336').join('');
const under = (s: string) => [...s].map((x) => x + '\u0331').join('');


const kinds = (f: Fixture) => notes(f).map((n) => n.kind);

// ======== R1182an AN3: the shape is `/worklane <option> <id> [note]`; an id later on line 1 doesn't answer ========
test('AN3a "/worklane approve not yet: <id> needs tests" answers nothing (reply_id_not_after_option)', async () => {
  const { f } = await land((id) => `/worklane approve not yet: ${id} needs tests`);
  assert.deepEqual([answered(f).length, queued(f), kinds(f)], [0, 0, ['reply_id_not_after_option']]);
});
test('AN3b "/worklane revise keep v1 <id> tables": not decided', async () => {
  const d = await planNote((id) => `/worklane revise keep v1 ${id} tables`);
  assert.equal(d.length, 0);
});
test('AN3 control: "/worklane approve <id> needs tests" and "<id>, thanks" answer and queue', async () => {
  for (const b of [(id: string) => `/worklane approve ${id} needs tests`, (id: string) => `/worklane approve ${id}, thanks`, (id: string) => `/worklane approve ${id}`]) {
    const { f } = await land(b);
    assert.deepEqual([answered(f)[0]?.answer, queued(f)], ['approve', 1], b('ID'));
  }
});
test('AN3 held: the id before the option keeps its note (reply_unknown_option, R1182ae AE3)', async () => {
  const { f } = await land((id) => `/worklane ${id} approve`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_unknown_option']]);
});

// ======== R1182am AM3 and R1182an AN4: the notes name the rule's characters ========
test('AM3 / AN4a: a $ or % on line 1 is refused, and the reply_unsafe_text note names $ and % (not invisible characters)', async () => {
  for (const b of [(id: string) => `/worklane approve ${id} 50% done`, (id: string) => `/worklane approve ${id} costs $5`]) {
    const { f } = await land(b);
    const n = notes(f);
    assert.deepEqual([answered(f).length, n.map((x) => x.kind)], [0, ['reply_unsafe_text']]);
    assert.match(n[0]!.message, /\$/);
    assert.match(n[0]!.message, /%/);
    assert.doesNotMatch(n[0]!.message, /prints nothing or reorders text/);
  }
});
test("AN4b: a curly apostrophe on line 1 is refused, and the note says a curly one counts as a quote", async () => {
  const { f } = await land((id) => `/worklane approve ${id} don\u2019t wait`);
  const n = notes(f);
  assert.deepEqual([answered(f).length, n.map((x) => x.kind)], [0, ['reply_unsafe_text']]);
  assert.ok(n[0]!.message.includes("'"), n[0]!.message);
  assert.match(n[0]!.message, /a curly quote or apostrophe counts as a quote/);
});
test('the reply_not_ascii note says the first line takes no quotes', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\nmerci, \u00E0 demain`);
  const n = notes(f);
  assert.deepEqual(n.map((x) => x.kind), ['reply_not_ascii']);
  assert.match(n[0]!.message, /U\+00E0 on line 2/);
  assert.match(n[0]!.message, /though the first line takes no quotes/);
});

// ======== R1182an AN5: a reply_not_ascii note only for a live id ========
test('AN5: a non-ASCII comment naming an already-answered id (no /worklane) gets no note', async () => {
  const f = fixture();
  const q1 = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, `/worklane approve ${q1.id}`);
  await handle(f);
  await ask(f, 'plan', PLAN, 'Approve the second plan for #1?');
  f.backlog.humanComment(1, OWNER, `ya aprob\u00E9 ${q1.id} ayer`);
  await handle(f);
  assert.deepEqual(kinds(f), []);
});
test('AN5 control: the same comment naming the open id gets one reply_not_ascii note', async () => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, `ya aprob\u00E9 ${q.id} ayer`);
  await handle(f);
  await handle(f);
  assert.deepEqual(kinds(f), ['reply_not_ascii']);
  assert.match(notes(f)[0]!.message, /U\+00E9 on line 1/);
});

// ======== R1182am AM1/AM2 and R1182an AN1/AN2: a second command the page shows, through entities, HTML or emphasis ========
// Rule (c) (the owner, 2026-11-10): an open decision's id anywhere outside line 1's id slot, as typed or as the page
// shows it, voids the comment. Each probe names the same id again, so each voids with reply_id_elsewhere.
const ELSEWHERE: [string, (id: string) => string][] = [
  ['AM1a italic */workIane reject <id>*', (id) => `/worklane approve ${id}\n*/workIane reject ${id}*`],
  ['AM1b bold **/workIane reject <id>**', (id) => `/worklane approve ${id}\n**/workIane reject ${id}**`],
  ['AM1c a code span', (id) => `/worklane approve ${id}\n\`/workIane reject ${id}\``],
  ['AM1d in parentheses', (id) => `/worklane approve ${id}\n(/workIane reject ${id})`],
  ['AM1e on line 1 after a comma', (id) => `/worklane approve ${id} ok,/workIane reject ${id}`],
  ['AM2a &#47;worklane', (id) => `/worklane approve ${id}\n&#47;worklane reject ${id}`],
  ['AM2b /wor&#108;lane', (id) => `/worklane approve ${id}\n/wor&#108;lane reject ${id}`],
  ['AM2c /work<b></b>lane', (id) => `/worklane approve ${id}\n/work<b></b>lane reject ${id}`],
  ['AM2d /work**lane**', (id) => `/worklane approve ${id}\n/work**lane** reject ${id}`],
  ['AM2e /work**lane** on line 1 itself', (id) => `/worklane approve ${id} and /work**lane** reject ${id}`],
  ['AM2f /worklane&#32;reject', (id) => `/worklane approve ${id}\n/worklane&#32;reject ${id}`],
  ['AN1a &nbsp; between cli and option', (id) => `/worklane approve ${id}\n/worklane&nbsp;reject ${id}`],
  ['AN1c &sol; for the slash', (id) => `/worklane approve ${id}\n&sol;worklane reject ${id}`],
  ['AN1e &#108; for the l', (id) => `/worklane approve ${id}\n/work&#108;ane reject ${id}`],
  ['AN1f <!----> inside the word', (id) => `/worklane approve ${id}\n/work<!---->lane reject ${id}`],
  ['AN1h &shy; inside the word', (id) => `/worklane approve ${id}\n/work&shy;lane reject ${id}`],
  ['AN1i *l* inside the word', (id) => `/worklane approve ${id}\n/work*l*ane reject ${id}`],
  ['AN1j /**worklane**', (id) => `/worklane approve ${id}\n/**worklane** reject ${id}`],
  ['AN1k on line 1: /work*l*ane reject <same id>', (id) => `/worklane approve ${id} /work*l*ane reject ${id}`],
  ['AN2a *.../workIane...*', (id) => `/worklane approve ${id}\n*/workIane reject ${id}*`],
  ['AN2b >/workIane (no space)', (id) => `/worklane approve ${id}\n>/workIane reject ${id}`],
  ['AN2c a table cell', (id) => `/worklane approve ${id}\n\n|a|\n|-|\n|/workIane reject ${id}|`],
  ['AN2d _/w0rklane..._ (zero for o)', (id) => `/worklane approve ${id}\n_/w0rklane reject ${id}_`],
  ['the id spelt with entities: &#100;-', (id) => `/worklane approve ${id}\nreject &#100;${id.slice(1)} instead`],
  ['the id spelt with a tag inside: <b>d</b>-', (id) => `/worklane approve ${id}\nreject <b>d</b>${id.slice(1)}`],
  ['the id spelt with emphasis inside: *d*-', (id) => `/worklane approve ${id}\nreject *d*${id.slice(1)}`],
  ['the id spelt with a hex entity and &ndash;', (id) => `/worklane approve ${id}\nreject &#x64;&ndash;${id.slice(2)}`],
];
// The note names the most specific reason: reply_more_than_one where the second-command scan (extra defence) also sees a
// command, reply_id_elsewhere otherwise. Where no command shape is left to see (the id spelt with markup, no slash),
// only rule (c) holds, and the note must be reply_id_elsewhere.
for (const [name, body] of ELSEWHERE) {
  test(`${name}: the open id appears again, so nothing answers or queues; one note`, async () => {
    const { f } = await land(body);
    assert.deepEqual([answered(f).length, queued(f), kinds(f).length], [0, 0, 1], JSON.stringify(answered(f)));
    const want = /^the id spelt/.test(name) ? ['reply_id_elsewhere'] : ['reply_id_elsewhere', 'reply_more_than_one'];
    assert.ok(want.includes(kinds(f)[0]!), `${kinds(f)[0]} not in ${want}`);
  });
}
test('the owner\'s accepted cost: "approve <id>, as in <id>\'s plan" answers nothing, and the note says so', async () => {
  const { f } = await land((id) => `/worklane approve ${id}, as in ${id} plan`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_id_elsewhere']]);
  assert.match(notes(f)[0]!.message, /even "approve <id>, as in <id>'s plan" answers nothing/);
});
test('controls: the id only in line 1 slot answers; a different, answered (not open) id elsewhere still answers', async () => {
  const a = await land((id) => `/worklane approve ${id} needs tests`);
  assert.deepEqual([answered(a.f)[0]?.answer, queued(a.f)], ['approve', 1]);
  const f = fixture();
  const old = await ask(f, 'land', LAND, 'Earlier?');
  f.log.append('decision.answered', { id: old.id, by: OWNER, answer: 'reject', role: 'owner' }, OWNER, 'human');
  const q = await QL3(f);
  f.backlog.humanComment(1, OWNER, `/worklane approve ${q.id}\nunlike ${old.id}, this one is fine`);
  assert.equal((await commentAnswer(f, q))?.answer, 'approve');
  assert.deepEqual(kinds(f), []);
});
test('AM control, changed by rule (c): a path naming the open id on line 2 now voids (was approve); without the id it answers; a leading tab is code', async () => {
  const p = await land((id) => `/worklane approve ${id}\nsee src/x.ts and ${id}`);
  assert.deepEqual([answered(p.f).length, kinds(p.f)], [0, ['reply_id_elsewhere']]);
  for (const body of [(id: string) => `/worklane approve ${id}`, (id: string) => `/worklane\tapprove\t${id}`, (id: string) => `/worklane approve ${id}\nsee src/x.ts`]) {
    const { f } = await land(body);
    assert.deepEqual(answered(f).map((a) => a.answer), ['approve']);
  }
  const { f } = await land((id) => `\t/worklane approve ${id}`);
  assert.equal(answered(f).length, 0);
});
test('AN1/AN2 controls: a plain second /worklane line voids; so does "> /workIane reject <id>"', async () => {
  for (const b of [(id: string) => `/worklane approve ${id}\n/worklane reject ${id}`, (id: string) => `/worklane approve ${id}\n> /workIane reject ${id}`]) {
    const { f } = await land(b);
    assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_more_than_one']]);
  }
});
test("extra defence: a second command naming another, unknown id still voids (reply_more_than_one), through entities too", async () => {
  for (const b of [(id: string) => `/worklane approve ${id}\n/worklane reject d-9-ffffff`, (id: string) => `/worklane approve ${id}\n&#47;worklane reject d-9-ffffff`]) {
    const { f } = await land(b);
    assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_more_than_one']], b('ID'));
  }
});
