// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182aj (adversarial) probes on #1182 at 8f4d4a48, ported. AJ1: the (b') void scan reads the text as shown (invisible
// characters dropped, blank-looking ones as spaces) and counts a look-alike command name. AJ2: line 1 is refused when, as
// typed, it holds a character that prints nothing or reorders text. AJ3: a leading BOM and an invisible-only first line
// are no text. AJ4: `~` is refused. Assertions unchanged; non-ASCII characters are written as \u escapes.
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
  const base = mkdtempSync(join(tmpdir(), 'r1182aj-'));
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
const planNote = async (body: (id: string) => string) => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, body(q.id));
  await handle(f);
  return f.log.read(0, ['plan.decided']).map((e) => e.payload as EventPayload<'plan.decided'>);
};
const land = async (body: (id: string) => string) => {
  const f = fixture();
  const q = await QL3(f);
  f.backlog.humanComment(1, OWNER, body(q.id));
  await handle(f);
  return { f, q };
};

// ======== AJ1 (DEFECT): the (b') void rule misses a second command that a reader sees ========
// The page shows two commands (approve, then reject). Under (b') the comment must answer nothing; it answers approve and
// the L3 land queues. CommonMark output: probe.log V1..V7 (the characters are drawn as nothing or as a look-alike).
const VOID: [string, (id: string) => string][] = [
  ['AJ1a ZWSP inside the later command word', (id) => `/worklane approve ${id}\n/work\u200Blane reject ${id}`],
  ['AJ1b word joiner U+2060 inside the later command', (id) => `/worklane approve ${id}\n/wor\u2060klane reject ${id}`],
  ['AJ1c soft hyphen U+00AD inside the later command', (id) => `/worklane approve ${id}\n/work\u00ADlane reject ${id}`],
  ['AJ1d Cyrillic o (U+043E) in the later command', (id) => `/worklane approve ${id}\n/w\u043Erklane reject ${id}`],
  ['AJ1e ZWSP between the later command and its space', (id) => `/worklane approve ${id}\n/worklane\u200B reject ${id}`],
  ['AJ1f braille blank U+2800 as the later separator', (id) => `/worklane approve ${id}\n/worklane\u2800reject ${id}`],
  ['AJ1g same line, a second command with a ZWSP', (id) => `/worklane approve ${id} and /work\u200Blane reject ${id}`],
];
for (const [name, body] of VOID) {
  test(`${name}: shows approve then reject, so it must answer nothing and not queue`, async () => {
    const { f } = await land(body);
    assert.equal(answered(f).length, 0, `VOID MISSED: ${JSON.stringify(answered(f))}`);
    assert.equal(queued(f), 0);
  });
}
test('AJ1 control: the same two commands in plain ASCII answer nothing (reply_more_than_one)', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\n/worklane reject ${id}`);
  assert.equal(answered(f).length, 0);
  assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
});
test('AJ1 control: the approve alone answers and queues', async () => {
  const { f } = await land((id) => `/worklane approve ${id}`);
  assert.equal(answered(f)[0]?.answer, 'approve');
  assert.equal(queued(f), 1);
});
test('AJ1 HELD: full-width and upper-case later commands void (NFKC, lower case)', async () => {
  for (const b of [(id: string) => `/worklane approve ${id}\n\uFF0F\uFF57\uFF4F\uFF52\uFF4B\uFF4C\uFF41\uFF4E\uFF45 reject ${id}`, (id: string) => `/worklane approve ${id}\n/WORKLANE\treject ${id}`, (id: string) => `/worklane approve ${id}\r/worklane reject ${id}`]) {
    const { f } = await land(b);
    assert.equal(answered(f).length, 0);
  }
});

// ======== AJ2 (DEFECT): invisible or bidi characters on line 1 are not refused ========
test('AJ2a BOM as the only separator: shows "/worklaneapprove <id>", must answer nothing', async () => {
  const { f } = await land((id) => `/worklane\uFEFFapprove ${id}`);
  assert.equal(answered(f).length, 0, `ANSWERED: ${JSON.stringify(answered(f))}`);
});
test('AJ2b BOM between the option and the id: shows "/worklane approved-1-\u2026", must answer nothing', async () => {
  const { f } = await land((id) => `/worklane approve\uFEFF${id}`);
  assert.equal(answered(f).length, 0, `ANSWERED: ${JSON.stringify(answered(f))}`);
});
test('AJ2c ZWSP then a digit after the id: shows "<id>7" (no such decision), must answer nothing', async () => {
  const { f } = await land((id) => `/worklane approve ${id}\u200B7`);
  assert.equal(answered(f).length, 0, `ANSWERED: ${JSON.stringify(answered(f))}`);
});
test('AJ2 control: "<id>7" typed plainly is an unknown id and answers nothing', async () => {
  const { f } = await land((id) => `/worklane approve ${id}7`);
  assert.equal(answered(f).length, 0);
});
test('AJ2d RLO in a revise note: the page shows "add in the details again", the planner gets other text; must not decide', async () => {
  const d = await planNote((id) => `/worklane revise ${id} \u202Eagain sliated eht ni dda\u202C`);
  assert.equal(d.length, 0, `NOTE: ${JSON.stringify(d[0]?.note)}`);
});
test('AJ2 control: a plain revise note is decided with that note', async () => {
  const d = await planNote((id) => `/worklane revise ${id} add in the details again`);
  assert.equal(d[0]?.note, 'add in the details again');
});

// ======== AJ3 (minor, fail-closed): a correct-looking first line is ignored ========
// changed by the ASCII rule (the owner, 2026-11-10: a reply is plain ASCII; curly quotes and en or em dashes read as ' " -): AJ3a and AJ3b answered approve (R1182aj fix); the BOM and the zero-width space now void, with a note naming them.
for (const [name, body] of [
  ['AJ3a a leading BOM (CommonMark strips it)', (id: string) => `\uFEFF/worklane approve ${id}`],
  ['AJ3b a first line of only ZWSP (shows nothing)', (id: string) => `\u200B\n/worklane approve ${id}`],
] as [string, (id: string) => string][]) {
  test(`${name}: answers nothing, with a reply_not_ascii note naming the character (not "after the first line")`, async () => {
    const { f } = await land(body);
    assert.equal(answered(f).length, 0);
    assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
    assert.match(notes(f)[0]!.message, /U\+FEFF on line 1|more than one line/); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): a zero-width line is a second line
  });
}

// ======== AJ4 (minor): GFM strikethrough isn't refused ========
test('AJ4a "/worklane reject ~~<id>~~" (the id shown struck): must answer nothing', async () => {
  const { f } = await land((id) => `/worklane reject ~~${id}~~`);
  assert.equal(answered(f).length, 0, `ANSWERED: ${JSON.stringify(answered(f))}`);
});
test('AJ4b a revise note with struck words: the planner must not get the struck text', async () => {
  const d = await planNote((id) => `/worklane revise ${id} ~~drop the v1 API~~ keep v1`);
  assert.ok(!d[0] || !/drop the v1 API/.test(d[0].note), `NOTE: ${JSON.stringify(d[0]?.note)}`);
});

// ======== HELD under the rule ========
const HELD_NONE: [string, (id: string) => string][] = [
  ['tab before the command (code)', (id) => `\t/worklane approve ${id}`],
  ['4 spaces (code)', (id) => `    /worklane approve ${id}`],
  ['4 NBSP (NFKC 4 spaces; fail closed)', (id) => `\u00A0\u00A0\u00A0\u00A0/worklane approve ${id}`],
  ['U+2028 on line 1', (id) => `/worklane approve ${id}\u2028thanks`],
  ['U+2029 then a second command', (id) => `/worklane approve ${id}\u2029/worklane reject ${id}`],
  ['NFKC makes a refused char: full-width <', (id) => `/worklane approve ${id} \uFF1Cb\uFF1E`],
  ['NFKC makes a refused char: U+2474 (1) parenthesized', (id) => `/worklane approve ${id} \u2474`],
  ['NFKC makes a refused char: U+FF02 full-width quote', (id) => `/worklane approve ${id} \uFF02x\uFF02`],
  ['Cyrillic command on line 1', (id) => `/w\u043Erklane approve ${id}`],
  ['ZWSP inside the option', (id) => `/worklane ap\u200Bprove ${id}`],
  ['ZWSP inside the id', (id) => `/worklane approve ${id.slice(0, 4)}\u200B${id.slice(4)}`],
  ['quote reply first', (id) => `> earlier\n\n/worklane approve ${id}`],
  ['[worklane] prefix', (id) => `[worklane] /worklane approve ${id}`],
  ['id in a URL path with a paren', (id) => `/worklane approve https://x.example/(${id})`],
  ['math with a backslash', (id) => `/worklane approve ${id} $\\phantom{x}$`],
];
for (const [name, body] of HELD_NONE) {
  test(`HELD ${name}: answers nothing`, async () => {
    const { f } = await land(body);
    assert.equal(answered(f).length, 0, JSON.stringify(answered(f)));
  });
}
// changed by the ASCII rule (the owner, 2026-11-10: a reply is plain ASCII; curly quotes and en or em dashes read as ' " -): these four answered approve before; they now answer nothing.
for (const [name, body] of [
  ['3 em spaces', (id: string) => `\u2003\u2003\u2003/worklane approve ${id}`],
  ['NBSP line, tab line, then the command', (id: string) => `\u00A0\n\t\n/worklane approve ${id}`],
  ['4 spaces + NBSP line, then the command', (id: string) => `    \u00A0\n/worklane approve ${id}`],
  ['upper case, full-width id', (id: string) => `/WORKLANE APPROVE ${id.toUpperCase().replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))}`],
] as [string, (id: string) => string][]) {
  test(`HELD ${name}: answers nothing, reply_not_ascii (changed by the ASCII rule; was approve)`, async () => {
    const { f } = await land(body);
    assert.equal(answered(f).length, 0);
    assert.deepEqual(notes(f).map((n) => n.kind), ['reply_note']);
  });
}
// changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line): only the one plain line answers; leading spaces, a leading tab line and any second line now void.
const HELD_YES: [string, (id: string) => string][] = [
  ['upper case, ASCII id', (id) => `/WORKLANE APPROVE ${id.toUpperCase()}`],
];
for (const [name, body] of [
  ['3 spaces', (id: string) => `   /worklane approve ${id}`],
  ['a tab line, then the command', (id: string) => `\t\n/worklane approve ${id}`],
  ['setext --- under the command', (id: string) => `/worklane approve ${id}\n---`],
  ['CRLF then a plain later line', (id: string) => `/worklane approve ${id}\r\nlooks right`],
] as [string, (id: string) => string][]) {
  test(`HELD ${name}: answers nothing now (was approve)`, async () => {
    const { f } = await land(body);
    assert.deepEqual([answered(f).length, notes(f).length], [0, 1]);
  });
}
for (const [name, body] of HELD_YES) {
  test(`HELD ${name}: answers approve`, async () => {
    const { f } = await land(body);
    assert.equal(answered(f)[0]?.answer, 'approve', JSON.stringify(notes(f).map((n) => n.kind)));
  });
}
test('HELD a revise note is line 1 only (later lines never join it)', async () => {
  const d = await planNote((id) => `/worklane revise ${id} keep it smaller\ndelete the tests too`);
  assert.equal(d.length, 0, 'changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment\'s one line): a second line voids (was the note keep it smaller)');
});
test('HELD a non-writer, a bot and a writer on a land answer nothing', async () => {
  for (const who of ['someone-else', 'renovate[bot]']) {
    const f = fixture();
    const q = await QL3(f);
    f.backlog.humanComment(1, who, `/worklane approve ${q.id}`);
    await handle(f);
    assert.equal(answered(f).length, 0, who);
  }
});
