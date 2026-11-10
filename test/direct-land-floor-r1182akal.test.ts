// R1182ak (final) and R1182al (adversarial) probes on #1182 at 2cf07c16, ported under the owner's decision of 2026-11-10
// (a reply is plain ASCII: any other character anywhere voids it, with one note naming the character and its line; line 1
// also refuses $ and %; curly quotes and en or em dashes read as ' " -). Every case is kept, with its outcome under that
// rule; "changed by the ASCII rule" marks a case whose outcome changed. Fixture copied from attack-1182al.test.ts.
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
const u = (hex: string) => String.fromCodePoint(parseInt(hex, 16));

// ======== R1182ak K1 and R1182al AL2/AL3: a later command with a look-alike slash, letter or combining mark ========
// Under the ASCII rule each of these is non-ASCII except K1d, which the slash-command-naming-an-id rule voids.
const VOID: [string, (id: string) => string, string][] = [
  ['K1a / AL2a division slash U+2215', (id) => `/worklane approve ${id}\n${u('2215')}worklane reject ${id}`, 'reply_not_ascii'],
  ['K1b / AL2b fraction slash U+2044', (id) => `/worklane approve ${id}\n${u('2044')}worklane reject ${id}`, 'reply_not_ascii'],
  ['K1c / AL2c big solidus U+29F8', (id) => `/worklane approve ${id}\n${u('29F8')}worklane reject ${id}`, 'reply_not_ascii'],
  ['K1d a capital I for the l (all ASCII)', (id) => `/worklane approve ${id}\n/workIane reject ${id}`, 'reply_more_than_one'],
  ['K1e same line, division slash', (id) => `/worklane approve ${id} ok ${u('2215')}worklane reject ${id}`, 'reply_not_ascii'],
  ['AL3a U+0332 under the w', (id) => `/worklane approve ${id}\n/w${u('0332')}orklane reject ${id}`, 'reply_not_ascii'],
  ['AL3b U+0331 under every letter', (id) => `/worklane approve ${id}\n/${[...'worklane'].map((x) => x + u('0331')).join('')} reject ${id}`, 'reply_not_ascii'],
  ['AL3 control: o + U+0301', (id) => `/worklane approve ${id}\n/wo${u('0301')}rklane reject ${id}`, 'reply_not_ascii'],
  ['K1 / AL2 control: a full-width slash (was reply_more_than_one through NFKC)', (id) => `/worklane approve ${id}\n${u('FF0F')}worklane reject ${id}`, 'reply_not_ascii'],
];
for (const [name, body, kind] of VOID) {
  test(`${name}: shows approve then a second command, so nothing answers or queues; one ${kind} note`, async () => {
    const { f } = await land(body);
    assert.deepEqual([answered(f).length, queued(f), kinds(f)], [0, 0, [kind]], JSON.stringify(answered(f)));
  });
}
test('K1/AL control: two plain ASCII commands void (reply_more_than_one); the approve alone answers and queues', async () => {
  const a = await land((id) => `/worklane approve ${id}\n/worklane reject ${id}`);
  assert.deepEqual([answered(a.f).length, kinds(a.f)], [0, ['reply_more_than_one']]);
  const b = await land((id) => `/worklane approve ${id}`);
  assert.deepEqual([answered(b.f)[0]?.answer, queued(b.f)], ['approve', 1]);
});

// ======== R1182ak K2 and K3 ========
test('K2: a heart with U+FE0F and a ZWJ emoji void (reply_not_ascii); a tab on line 1 now answers (changed by the ASCII rule; was refused)', async () => {
  for (const b of [(id: string) => `/worklane approve ${id} thanks ${u('2764')}${u('FE0F')}`, (id: string) => `/worklane approve ${id} ${u('1F468')}${u('200D')}${u('1F469')}`]) {
    const { f } = await land(b);
    assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_ascii']]);
  }
  const { f } = await land((id) => `/worklane approve ${id}\tok`);
  assert.equal(answered(f)[0]?.answer, 'approve', 'a tab is ASCII and shows as a space');
});
test('K2 control, changed by the ASCII rule: a non-ASCII note or an emoji now voids (was approve)', async () => {
  for (const b of [(id: string) => `/worklane approve ${id} danke caf${u('00E9')}`, (id: string) => `/worklane approve ${id} looks good ${u('1F44D')}`]) {
    const { f } = await land(b);
    assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_ascii']]);
  }
});
test('K3: a later Cyrillic line voids the reply (reply_not_ascii; was reply_more_than_one)', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\n${u('0421')}${u('043F')}${u('0430')} /${u('0441')}${u('043F')}${u('0430')}${u('0441')}${u('0438')}${u('0431')}${u('043E')}${u('043E')} ${u('0434')}${u('0430')}`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_ascii']]);
});

// ======== R1182ak K4 and R1182al AL4: a revise note struck through with U+0336 ========
test('K4 / AL4: a revise note drawn struck through with U+0336 is not decided (reply_not_ascii)', async () => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, `/worklane revise ${q.id} ${strike('drop the v1 API')} keep v1`);
  await handle(f);
  assert.deepEqual(f.log.read(0, ['plan.decided']), []);
  assert.deepEqual(kinds(f), ['reply_not_ascii']);
});
test('AL4 control: ~~...~~ is refused (reply_unsafe_text)', async () => {
  const d = await planNote((id) => `/worklane revise ${id} ~~drop the v1 API~~ keep v1`);
  assert.equal(d.length, 0);
});

// ======== R1182al AL1: GitHub math hides line-1 text ========
test('AL1a the id only inside $x%...$: refused ($ and %), nothing answers or queues', async () => {
  const { f } = await land((id) => `/worklane approve $x%${id}$`);
  assert.deepEqual([answered(f).length, queued(f), kinds(f)], [0, 0, ['reply_unsafe_text']]);
});
test('AL1b a revise note with $x%...$: not decided, so the hidden words never reach the planner', async () => {
  const d = await planNote((id) => `/worklane revise ${id} keep v1 $x%and drop the v1 tables$`);
  assert.equal(d.length, 0);
});
test('AL1 control: the id in plain text answers and queues', async () => {
  const { f } = await land((id) => `/worklane approve ${id}`);
  assert.deepEqual([answered(f)[0]?.answer, queued(f)], ['approve', 1]);
});

// ======== R1182al AL5: a line of a visible format character ========
test('AL5 a first line holding only U+06DD: voids (reply_not_ascii)', async () => {
  const { f } = await land((id) => `${u('06DD')}\n/worklane approve ${id}`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_ascii']]);
});
test('AL5 control: a first line holding a letter: nothing (reply_not_first_line)', async () => {
  const { f } = await land((id) => `x\n/worklane approve ${id}`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_first_line']]);
});

// ======== R1182al HELD, under the ASCII rule ========
test('HELD: refused or void on line 1 (backtick, < > [ ] ( ) quotes \\ & ! ~ $ %, non-ASCII forms, invisibles, U+2028)', async () => {
  for (const b of [
    (id: string) => `/worklane approve \`${id}\``,
    (id: string) => `/worklane approve ${id} <!-- x -->`,
    (id: string) => `/worklane approve [${id}](x)`,
    (id: string) => `/worklane approve ${id} ${u('FF1C')}b${u('FF1E')}`,
    (id: string) => `/worklane approve ${id} ${u('2474')}`,
    (id: string) => `/worklane approve ${id} ${u('203C')}`,
    (id: string) => `/worklane approve ${id}${u('200B')}`,
    (id: string) => `/worklane approve ${id} ${u('202E')}x`,
    (id: string) => `/worklane approve ${id}${u('2028')}`,
    (id: string) => `/worklane approve ${id}     x\\`,
    (id: string) => `/worklane approve ${id} 50% done`,
  ]) {
    const { f } = await land(b);
    assert.equal(answered(f).length, 0, b('ID'));
  }
});
test('HELD, changed by the ASCII rule: a tab between the command and the option answers (was refused as a control character)', async () => {
  const { f } = await land((id) => `/worklane\tapprove ${id}`);
  assert.equal(answered(f)[0]?.answer, 'approve');
});
test('HELD: indentation: 3 spaces answer; 3 NBSP now void (changed; was approve); 4 spaces, 3 + NBSP or a tab do not', async () => {
  for (const [b, n] of [
    [(id: string) => `   /worklane approve ${id}`, 1],
    [(id: string) => `${u('00A0').repeat(3)}/worklane approve ${id}`, 0],
    [(id: string) => `    /worklane approve ${id}`, 0],
    [(id: string) => `   ${u('00A0')}/worklane approve ${id}`, 0],
    [(id: string) => `\t/worklane approve ${id}`, 0],
  ] as [(id: string) => string, number][]) {
    const { f } = await land(b);
    assert.equal(answered(f).length, n, JSON.stringify(b('ID')));
  }
});
test('HELD, changed by the ASCII rule: blank-looking non-ASCII lines (NBSP, ZWSP, U+3164, U+2800, BOM) before line 1 void; plain blank lines, setext and table lines keep the answer', async () => {
  for (const b of [(id: string) => `${u('00A0')}\n${u('200B')}\n${u('3164')}\n${u('2800')}\n/worklane approve ${id}`, (id: string) => `${u('FEFF')}/worklane approve ${id}`]) {
    const { f } = await land(b);
    assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_ascii']], JSON.stringify(b('ID')));
  }
  for (const b of [(id: string) => ` \n\t\n/worklane approve ${id}`, (id: string) => `/worklane approve ${id}\n===`, (id: string) => `/worklane approve ${id} | x\n-|-`]) {
    const { f } = await land(b);
    assert.equal(answered(f)[0]?.answer, 'approve', JSON.stringify(b('ID')));
  }
});
test('HELD: homoglyphs on line 1 (Cyrillic o, U+2215 slash, Greek alpha, Cyrillic d in the id) answer nothing', async () => {
  for (const b of [(id: string) => `/w${u('043E')}rklane approve ${id}`, (id: string) => `${u('2215')}worklane approve ${id}`, (id: string) => `/worklane ${u('03B1')}pprove ${id}`, (id: string) => `/worklane approve ${id.replace('d', u('0501'))}`]) {
    const { f } = await land(b);
    assert.equal(answered(f).length, 0, JSON.stringify(b('ID')));
  }
});
test('HELD, changed by the ASCII rule: NFKC forms of the command, option or id (full-width, a no-break hyphen) answer nothing (was approve)', async () => {
  const fw = (s: string) => [...s].map((ch) => String.fromCodePoint(ch.codePointAt(0)! + 0xfee0)).join('');
  for (const b of [(id: string) => `${fw('/worklane')} APPROVE ${id.toUpperCase()}`, (id: string) => `/worklane approve ${id.replace(/-/g, u('2011'))}`]) {
    const { f } = await land(b);
    assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_ascii']], JSON.stringify(b('ID')));
  }
});
test('HELD: the revise note is line 1 only, ids removed; a later plain line is not the note', async () => {
  const d = await planNote((id) => `/worklane revise ${id} split the parser\nand also delete the tests`);
  assert.equal(d[0]?.note, 'split the parser');
});
test('HELD: a non-writer, renovate[bot] and a [worklane] comment answer nothing', async () => {
  for (const [who, b] of [['someone-else', (id: string) => `/worklane approve ${id}`], ['renovate[bot]', (id: string) => `/worklane approve ${id}`], [OWNER, (id: string) => `[worklane] /worklane approve ${id}`]] as [string, (id: string) => string][]) {
    const f = fixture();
    const q = await QL3(f);
    f.backlog.humanComment(1, who, b(q.id));
    await handle(f);
    assert.equal(answered(f).length, 0, who);
  }
});
test('HELD: a quote reply of an approve, then the reject on line 3, answers nothing', async () => {
  const { f } = await land((id) => `> /worklane approve ${id}\n\n/worklane reject ${id}`);
  assert.equal(answered(f).length, 0);
});
test('HELD: an edit after the answer changes nothing; an edit before the poll is read as the comment is now', async () => {
  const f = fixture();
  const q = await QL3(f);
  const c = f.backlog.humanComment(1, OWNER, `/worklane approve ${q.id}`);
  await handle(f);
  f.backlog.editComment(1, c, `/worklane reject ${q.id}`);
  await handle(f);
  assert.deepEqual(answered(f).map((a) => a.answer), ['approve']);
  const g = fixture();
  const q2 = await QL3(g);
  const c2 = g.backlog.humanComment(1, OWNER, `/worklane approve ${q2.id}`);
  g.backlog.editComment(1, c2, `/worklane approve ${q2.id}\n/worklane reject ${q2.id}`);
  await handle(g);
  assert.equal(answered(g).length, 0);
});

// ======== The owner's phone characters, end to end ========
test("a phone-typed reply answers: a plain line 1, curly quotes and an en or em dash below it", async () => {
  const { f } = await land((id) => `/worklane approve ${id}\nI${u('2019')}ve read it ${u('2014')} the ${u('201C')}CI${u('201D')} part looks fine ${u('2013')} thanks`);
  assert.deepEqual([answered(f)[0]?.answer, kinds(f)], ['approve', []]);
});
test("line 1 stays strict (the owner): a curly apostrophe in the line-1 note is a ' there, so it is refused", async () => {
  const d = await planNote((id) => `/worklane revise ${id} don${u('2019')}t split it`);
  assert.equal(d.length, 0);
});
test('the note decision: a non-ASCII comment that names neither the command nor an id here gets no note', async () => {
  const { f } = await land(() => `Merci, je regarde demain ${u('00E0')} 9h.`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, []]);
});
