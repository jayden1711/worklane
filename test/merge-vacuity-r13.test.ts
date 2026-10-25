// #784 round 13 (the round-12 second review M1-M5b, final check D0-D2, C1, R3s). Round 12's moved-code pairing is
// taken out: a dead copy of an edited line's old text in another app file made the whole edited line count (M1, M1b,
// M1c, D1, D2), and a replacement whose new line another file lost was judged as a removal (C1). These must-holds keep
// that route closed. Code moved, edited, re-wrapped or reordered out of git's own pairing (M3, M4b, M5b, R3s) read as
// added code again at round 13, so an untested change merged. #1014 pairs moved code only to take measure away (a file
// counts only where it counts both with and without the pairing): each holds, with M4b1, M5c and A6 (round 13's last
// reviews), and the must-holds above still hold. #1014's reviews add P1-P5 and E1-E7 (where a moved statement starts
// and ends, and its name), and FH1, FH2: a unit paired by name it can't place reads as added code, never holds the PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

function commit(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'step');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A ready PR over the example project with a real remote at its base, decided after its coverage run. */
async function decided(before: Record<string, string>, after: Record<string, string>, rm: string[] = []) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  for (const p of rm) git(dir, 'rm', '-q', p);
  const head = commit(dir, after);
  const bare = join(dir, '..', 'origin.git');
  git(join(dir, '..'), 'init', '-q', '--bare', bare);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '--force', 'origin', `${base}:refs/heads/main`);
  git(dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  cfg.review.merge.max_lines = 10_000;
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  const first = c.mergeDecisionFor(7, 9, p);
  if (first.vacuityRun) await c.vacuityRun(w, p, first.vacuityRun);
  return c.mergeDecisionFor(7, 9, p);
}

const H = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const calls = (file: string, name: string, call: string, want: string) => `${H}import { ${name} } from '../src/${file}';\ntest('${name}', () => { assert.deepEqual(${call}, ${want}); });\n`;
const ranNone = (app: string) => `design: vacuity: its tests (test/x.test.js) ran none of the app code it changes (${app})`;
const hold = (app: string) => [false, [ranNone(app)]];

// ---- D0-D2 (final check): an untaken `|| deny(b)` added to a tested line; a dead copy of the old line elsewhere

const D_A = 'export function f(a, b) {\n  return ok(a);\n}\nfunction ok(a) {\n  return true;\n}\nfunction deny(b) {\n  return false;\n}\n';
const D_A_HEAD = D_A.replace('  return ok(a);\n', '  return ok(a) || deny(b);\n');
const DECOY = 'export function unused(a) {\n  return ok(a);\n}\n';
const D_T = calls('a.js', 'f', 'f(1, 2)', 'true');

test('control: D0: the untaken `|| deny(b)` added alone holds', async () => {
  const d = await decided({ 'src/a.js': D_A }, { 'src/a.js': D_A_HEAD, 'test/x.test.js': D_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js'));
});

test('must hold: D1: D0 plus a copy of the old line in an uncalled function of a new app file', async () => {
  const d = await decided({ 'src/a.js': D_A }, { 'src/a.js': D_A_HEAD, 'src/b.js': DECOY, 'test/x.test.js': D_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js'));
});

test('must hold: D2: D0 plus the same copy added to an existing app file', async () => {
  const d = await decided({ 'src/a.js': D_A, 'src/b.js': 'export const k = 1;\n' }, { 'src/a.js': D_A_HEAD, 'src/b.js': `export const k = 1;\n${DECOY}`, 'test/x.test.js': D_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js'));
});

// ---- M1, M1b, M1c (second review): the same trick on an untaken arm and a guard condition

const PICK = "export function pick(u) {\n  const r = u.admin ? safe(u) : other(u);\n  return r;\n}\nfunction safe(u) {\n  return 'safe';\n}\nfunction unsafe(u) {\n  return 'unsafe';\n}\nfunction other(u) {\n  return 'other';\n}\n";
const PICK_HEAD = PICK.replace('? safe(u)', '? unsafe(u)');
const PICK_T = calls('a.js', 'pick', 'pick({ admin: false })', "'other'");

test('control: M1: the untested arm edited in place alone holds', async () => {
  const d = await decided({ 'src/a.js': PICK }, { 'src/a.js': PICK_HEAD, 'test/x.test.js': PICK_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js'));
});

test('must hold: M1: the same edit plus a dead copy of the old line in another app file', async () => {
  const copy = "export function legacy(u) {\n  const r = u.admin ? safe(u) : other(u);\n  return r;\n}\n";
  const d = await decided({ 'src/a.js': PICK }, { 'src/a.js': PICK_HEAD, 'src/c.js': copy, 'test/x.test.js': PICK_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

test('must hold: M1b: the old line inside a template literal in another app file', async () => {
  const doc = 'export const NOTE = `\n  const r = u.admin ? safe(u) : other(u);\n`;\n';
  const d = await decided({ 'src/a.js': PICK }, { 'src/a.js': PICK_HEAD, 'src/c.js': doc, 'test/x.test.js': PICK_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

const GATE = "export function open(u) {\n  if (!u.admin || u.locked) throw new Error('denied');\n  return 'open';\n}\n";
const GATE_HEAD = GATE.replace(' || u.locked', '');
const GATE_T = calls('a.js', 'open', 'open({ admin: true })', "'open'");

test('control: M1c: a guard condition dropped alone holds (a removal across `||` never counts)', async () => {
  const d = await decided({ 'src/a.js': GATE }, { 'src/a.js': GATE_HEAD, 'test/x.test.js': GATE_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js'));
});

test('must hold: M1c: the guard condition dropped plus a dead copy of the old line elsewhere', async () => {
  const copy = "export function old(u) {\n  if (!u.admin || u.locked) throw new Error('denied');\n}\n";
  const d = await decided({ 'src/a.js': GATE }, { 'src/a.js': GATE_HEAD, 'src/c.js': copy, 'test/x.test.js': GATE_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

// ---- C1 (final check): a replacement whose new line another file lost is not judged as a removal

const C_A = 'export function f(u) {\n  check(u);\n  return 1;\n}\nfunction check(u) {}\n';
const C_B = 'export function b1() {\n  return 2;\n}\nfunction noop() {}\n';

test('must hold: C1: a line replaced by one another app file removed (as at round 11)', async () => {
  const d = await decided({ 'src/a.js': C_A, 'src/b.js': C_B }, { 'src/a.js': C_A.replace('  check(u);\n', '  function noop() {}\n'), 'src/b.js': 'export function b1() {\n  return 2;\n}\n', 'test/x.test.js': calls('a.js', 'f', 'f({})', '1') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js'));
});

// ---- M3: a function split out to a new file with a line edited inside (only the edit counts)

const G = "export function f(x) {\n  return x + 1;\n}\nexport function g(u) {\n  return u.admin ? grant(u) : deny(u);\n}\nfunction grant(u) {\n  return 'all';\n}\nfunction grantAll(u) {\n  return 'everything';\n}\nfunction deny(u) {\n  return 'none';\n}\nfunction denyAll(u) {\n  return 'nothing';\n}\n";
const G_A = 'export function f(x) {\n  return x + 1;\n}\n';
const G_C = G.replace(G_A, '');

test('must hold: M3: g moved to a new file with its untaken arm edited; the test takes the other arm', async () => {
  const d = await decided({ 'src/a.js': G }, { 'src/a.js': G_A, 'src/c.js': G_C.replace('? grant(u)', '? grantAll(u)'), 'test/x.test.js': calls('c.js', 'g', 'g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

test('control: M3: the same move with the arm the test takes edited merges', async () => {
  const d = await decided({ 'src/a.js': G }, { 'src/a.js': G_A, 'src/c.js': G_C.replace(': deny(u)', ': denyAll(u)'), 'test/x.test.js': calls('c.js', 'g', 'g({ admin: false })', "'nothing'") });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- M4b: a move within one file that git shows as a removal and an addition

const BIG = Array.from({ length: 30 }, (_, i) => `export function z${i}(x) {\n  return x + ${i};\n}\n`).join('');
const MG = 'export function g(u) {\n  const a = u.id * 2;\n  return a + 3;\n}\n';
const MH = "export function h(u) {\n  return u.admin ? 'all' : 'none';\n}\n";
const MG_T = calls('w.js', 'g', 'g({ id: 1 })', '5');

test('must hold: M4b: tested g moved past a 30-function block, an untested arm edited in h', async () => {
  const d = await decided({ 'src/w.js': MG + BIG + MH }, { 'src/w.js': BIG + MG + MH.replace("'all'", "'everything'"), 'test/x.test.js': MG_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/w.js'));
});

test('control: M4b: the same move with a tested edit inside g merges', async () => {
  const d = await decided({ 'src/w.js': MG + BIG + MH }, { 'src/w.js': BIG + MG.replace('a + 3', 'a + 4') + MH, 'test/x.test.js': calls('w.js', 'g', 'g({ id: 1 })', '6') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

const SIX = 'export function k(x) {\n  const a = x + 1;\n  const b = a * 2;\n  const c = b - 3;\n  return c;\n}\n';

test('must hold: M4b1: tested g moved past one 6-line function, an untested arm edited in h', async () => {
  const d = await decided({ 'src/w.js': MG + SIX + MH }, { 'src/w.js': SIX + MG + MH.replace("'all'", "'everything'"), 'test/x.test.js': MG_T });
  assert.deepEqual([d.auto, d.reasons], hold('src/w.js'));
});

test('control: M4b1: the same move with the edited arm tested merges', async () => {
  const t = `${H}import { g, h } from '../src/w.js';\ntest('g', () => { assert.equal(g({ id: 1 }), 5); assert.equal(h({ admin: true }), 'everything'); });\n`;
  const d = await decided({ 'src/w.js': MG + SIX + MH }, { 'src/w.js': SIX + MG + MH.replace("'all'", "'everything'"), 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- M5b, R3s: moved code re-wrapped into short lines

const S = "export function g(u) {\n  return combine(alpha(u), beta(u));\n}\nexport function h(u) {\n  return u.admin ? 'all' : 'none';\n}\nexport function combine(a, b) {\n  return a + b;\n}\nexport function alpha(u) {\n  return 1;\n}\nexport function beta(u) {\n  return 2;\n}\n";
const S_G = "export function g(u) {\n  return combine(alpha(u), beta(u));\n}\n";

test('must hold: M5b: tested g moved to a new file with its call re-wrapped one argument a line, an untested arm edited in h', async () => {
  const sC = "import { combine, alpha, beta } from './s.js';\nexport function g(u) {\n  return combine(\n    alpha(u),\n    beta(u),\n  );\n}\n";
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': S.replace(S_G, '').replace("'all'", "'everything'"), 'src/c.js': sC, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

test('control: M5b: the same re-wrapped move with a tested argument changed merges', async () => {
  const sC = "import { combine, alpha, beta } from './s.js';\nexport function g(u) {\n  return combine(\n    alpha(u),\n    beta(u) + 1,\n  );\n}\n";
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': S.replace(S_G, ''), 'src/c.js': sC, 'test/x.test.js': calls('c.js', 'g', 'g({})', '4') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- M5c, A6 (round 13's last reviews): a tested function moved unchanged, next to an untested edit

const S_C = `import { combine, alpha, beta } from './s.js';\n${S_G}`;

test('must hold: M5c: tested g moved unchanged to a new file, an untested arm edited in h', async () => {
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': S.replace(S_G, '').replace("'all'", "'everything'"), 'src/c.js': S_C, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

test('control: M5c: the same move with the edited arm tested merges', async () => {
  const t = `${H}import { g } from '../src/c.js';\nimport { h } from '../src/s.js';\ntest('g', () => { assert.equal(g({}), 3); assert.equal(h({ admin: true }), 'everything'); });\n`;
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': S.replace(S_G, '').replace("'all'", "'everything'"), 'src/c.js': S_C, 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

const A6_K = 'export const k = 1;\n';

test('must hold: A6: tested g moved into an existing app file, an untested arm edited in h where it came from', async () => {
  const d = await decided({ 'src/a.js': MG + MH, 'src/b.js': A6_K }, { 'src/a.js': MH.replace("'all'", "'everything'"), 'src/b.js': A6_K + MG, 'test/x.test.js': calls('b.js', 'g', 'g({ id: 1 })', '5') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js'));
});

test('control: A6: the same move with a tested edit inside g merges', async () => {
  const d = await decided({ 'src/a.js': MG + MH, 'src/b.js': A6_K }, { 'src/a.js': MH.replace("'all'", "'everything'"), 'src/b.js': A6_K + MG.replace('a + 3', 'a + 4'), 'test/x.test.js': calls('b.js', 'g', 'g({ id: 1 })', '6') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

const M_BASE = "export function f(x) {\n  return x + 1;\n}\nexport function g(u) {\n  if (u.guest) {\n    throw new Error('denied');\n  }\n  return 'ok';\n}\nexport function h(x) {\n  return x * 2;\n}\n";
const M_A = 'export function f(x) {\n  return x + 1;\n}\n';

test('must hold: R3s: g (guard removed) and h moved to a new file, h re-wrapped into short pieces', async () => {
  const wrapped = "export function g(u) {\n  return 'ok';\n}\nexport function h(x) {\n  return (\n    x *\n    2\n  );\n}\n";
  const d = await decided({ 'src/a.js': M_BASE }, { 'src/a.js': M_A, 'src/c.js': wrapped, 'test/x.test.js': calls('c.js', 'h', 'h(2)', '4') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

test('control: R3s: the same re-wrapped move with a tested factor changed merges', async () => {
  const wrapped = "export function g(u) {\n  return 'ok';\n}\nexport function h(x) {\n  return (\n    x *\n    3\n  );\n}\n";
  const d = await decided({ 'src/a.js': M_BASE }, { 'src/a.js': M_A, 'src/c.js': wrapped, 'test/x.test.js': calls('c.js', 'h', 'h(2)', '6') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- P1 (#1014's adversarial review): a division inside brackets never turns the pairing off for the rest of a file

const HALF = 'export function half(u) {\n  return Math.round(u / 2);\n}\n';

test('must hold: P1a: M5c with a division inside a call above g in the file g left', async () => {
  const d = await decided({ 'src/s.js': HALF + S }, { 'src/s.js': (HALF + S).replace(S_G, '').replace("'all'", "'everything'"), 'src/c.js': S_C, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

test('must hold: P1b: M5c with a division inside a call above g in the file g moved to', async () => {
  const c = `import { combine, alpha, beta } from './s.js';\n${HALF}${S_G}`;
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': S.replace(S_G, '').replace("'all'", "'everything'"), 'src/c.js': c, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

test('control: P1: the same with a multiplication holds', async () => {
  const times = HALF.replace('u / 2', 'u * 2');
  const d = await decided({ 'src/s.js': times + S }, { 'src/s.js': (times + S).replace(S_G, '').replace("'all'", "'everything'"), 'src/c.js': S_C, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

// ---- P2, FH1, FH2: a unit paired by name that can't be placed is measured as added code; the others keep their pairing

const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('');
const BIG_G = `export function g(u) {\n${lines(297, (i) => `  const v${i} = u.a${i} + ${i};\n`)}  return u;\n}\n`;
const P_H = 'export function h(x) {\n  return x * 2;\n}\n';

test('must hold: P2: a 300-line g moved and rewritten untested into 280 lines, beside a tested unchanged h', async () => {
  const rewritten = `export function g(u) {\n${lines(277, (i) => `  const w${i} = u.b${i} * ${i};\n`)}  return u;\n}\n`;
  const d = await decided({ 'src/a.js': M_A + BIG_G + P_H }, { 'src/a.js': M_A, 'src/c.js': rewritten + P_H, 'test/x.test.js': calls('c.js', 'h', 'h(2)', '4') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

test('must hold: P2x: a tested 300-line g moved re-wrapped two statements a line, a comment on each (too large to align, its code the same), an untested arm edited in h', async () => {
  const body = lines(297, (i) => `  const v${i} = u.a${i} + ${i};${i % 2 ? ` // pair ${i}\n` : ' '}`);
  const d = await decided({ 'src/a.js': M_A + BIG_G + MH }, { 'src/a.js': M_A + MH.replace("'all'", "'everything'"), 'src/c.js': `export function g(u) {\n${body}\n  return u;\n}\n`, 'test/x.test.js': calls('c.js', 'g', 'g({}).a0', 'undefined') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

const RUN = (swap: (i: number) => string | null) => `export function run(u) {\n${lines(148, (i) => swap(i) ?? `  u.a${i} = u.b${i} + ${i};\n`)}  return u;\n}\n`;

test('must merge: FH1: a tested 150-line run moved to a new file, two of its lines replaced by unrelated ones', async () => {
  const head = RUN((i) => (i === 5 ? '  globalThis.flag = [1, 2, 3].length;\n' : i === 140 ? "  u.z = typeof u === 'object';\n" : null));
  const d = await decided({ 'src/a.js': M_A + RUN(() => null) }, { 'src/a.js': M_A, 'src/c.js': head, 'test/x.test.js': calls('c.js', 'run', 'run({}).z', 'true') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('must merge: FH2: a different same-named 120-line main added and tested, the old one deleted with its file', async () => {
  const old = `export function main(u) {\n${lines(118, (i) => `  const v${i} = u.a${i} + ${i};\n`)}  return u;\n}\n`;
  const next = `export function main(u) {\n  let total = 0;\n${lines(96, (i) => `  total += Math.max(u, ${i}) % 7;\n`)}  return total;\n}\n`;
  const d = await decided({ 'src/old.js': old, 'src/keep.js': A6_K }, { 'src/new.js': next, 'test/x.test.js': calls('new.js', 'main', 'main(1)', '284') }, ['src/old.js']);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('control: P2: the same move with a small untested rewrite of g holds as ran none', async () => {
  const d = await decided({ 'src/a.js': M_A + BIG_G + P_H }, { 'src/a.js': M_A, 'src/c.js': BIG_G.replace('u.a5 + 5', 'u.a5 + 6') + P_H, 'test/x.test.js': calls('c.js', 'h', 'h(2)', '4') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

// ---- P3m, P3d, P5: a file counts only where it counts both with and without the pairing, in app code and through dist/

const PG = "export function g(u) {\n  if (u.admin) {\n    return 'all';\n  }\n  return 'none';\n}\n";
const PG_HEAD = "export function g(u) { // c1\n  if (u.admin) { // c2\n    return 'everything'; // c3\n  } // c4\n  return 'none'; // c5\n} // c6\n";
const BG = "export function g(u) {\n  if (u.admin) {\n    return 'everything';\n  }\n  return 'nothing';\n}\n";
const map = (file: string, src: string, n: number) => JSON.stringify({ version: 3, file, sources: [src], names: [], mappings: ['AAAA', ...Array.from({ length: n - 1 }, () => 'AACA')].join(';') });
const fromDist = (file: string, name: string, call: string, want: string) => `${H}import { ${name} } from '../dist/${file}';\ntest('${name}', () => { assert.deepEqual(${call}, ${want}); });\n`;

test('must hold: P3m: g edited in place on every line (an untaken arm), a closer same-named g removed from b.js: only the pairing counts it', async () => {
  const d = await decided({ 'src/a.js': PG, 'src/b.js': A6_K + BG }, { 'src/a.js': PG_HEAD, 'src/b.js': A6_K, 'test/x.test.js': calls('a.js', 'g', 'g({})', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js'));
});

test('must hold: P3d: P3m through dist/ with an identity map', async () => {
  const before = { 'src/a.js': PG, 'src/b.js': A6_K + BG, 'dist/a.js': PG, 'dist/a.js.map': map('a.js', '../src/a.js', 6) };
  const d = await decided(before, { 'src/a.js': PG_HEAD, 'src/b.js': A6_K, 'dist/a.js': PG_HEAD, 'test/x.test.js': fromDist('a.js', 'g', 'g({})', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js'));
});

test('must hold: P5: R3 through dist/ with an identity map', async () => {
  const c = "export function g(u) {\n  return 'ok';\n}\n" + P_H;
  const d = await decided({ 'src/a.js': M_BASE }, { 'src/a.js': M_A, 'src/c.js': c, 'dist/c.js': c, 'dist/c.js.map': map('c.js', '../src/c.js', 6), 'test/x.test.js': fromDist('c.js', 'h', 'h(2)', '4') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

// ---- E1-E6 (#1014's third reviews): M5c's move, with a unit running to its statement's end, a `}` git keeps between
// a unit and the code written in its place, CommonJS and TypeScript names, and a `/` the first reading misreads

const S_T = S.replace(S_G, '');
const IMP = "import { combine, alpha, beta } from './s.js';\n";
const editH = (s: string) => s.replace("'all'", "'everything'");
const moveG = async (from: string, to: string) => {
  const d = await decided({ 'src/s.js': from + S_T }, { 'src/s.js': editH(S_T), 'src/c.js': IMP + to, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  return [d.auto, d.reasons];
};

test('must hold: E1: an arrow g moved with its body wrapped onto the next line', async () => {
  assert.deepEqual(await moveG('export const g = (u) => combine(alpha(u), beta(u));\n', 'export const g = (u) =>\n  combine(alpha(u), beta(u));\n'), hold('src/c.js, src/s.js'));
});

test('control: E1: the same arrow moved unwrapped holds', async () => {
  const g = 'export const g = (u) => combine(alpha(u), beta(u));\n';
  assert.deepEqual(await moveG(g, g), hold('src/c.js, src/s.js'));
});

test('must hold: E1b: an arrow g whose sum goes on past a line-ending `+`, moved and wrapped again', async () => {
  assert.deepEqual(await moveG('export const g = (u) => alpha(u) +\n  beta(u);\n', 'export const g = (u) =>\n  alpha(u) +\n  beta(u);\n'), hold('src/c.js, src/s.js'));
});

test('must hold: E1f: a function expression g moved with it wrapped onto the line after `=`', async () => {
  const f = (gap: string) => `export const g =${gap}function (u) {\n  return combine(alpha(u), beta(u));\n};\n`;
  assert.deepEqual(await moveG(f(' '), f('\n  ')), hold('src/c.js, src/s.js'));
});

test('must hold: E1s: M5c into a file written without semicolons (g starts after an import with none)', async () => {
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': editH(S_T), 'src/c.js': IMP.replace(';', '') + S_G, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

const S_Q = 'export function q(u) {\n  return u.admin ? beta(u) : alpha(u);\n}\n';

test('must hold: E2: g moved to a new file, an untested q written where it was (git keeps their shared `}`)', async () => {
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': S_Q + S_T, 'src/c.js': IMP + S_G, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

test('control: E2: the same with q added after h holds', async () => {
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': S_T + S_Q, 'src/c.js': IMP + S_G, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/c.js, src/s.js'));
});

test('must hold: E2d: g moved into an existing file over a function it removes (their shared `}`), an untested arm edited in h', async () => {
  const old = 'export function old(u) {\n  return 0;\n}\n';
  const d = await decided({ 'src/s.js': S, 'src/b.js': IMP + old }, { 'src/s.js': editH(S_T), 'src/b.js': IMP + S_G, 'test/x.test.js': calls('b.js', 'g', 'g({})', '3') });
  assert.deepEqual([d.auto, d.reasons], hold('src/b.js, src/s.js'));
});

const ARMS = G.replace(G_A, '').replace(/export function g[^}]*\}\n/, '');
const G_EDIT = (g: string) => g.replace('? grant(u)', '? grantAll(u)');
const cjs = (head: string) => `${head} = function (u) {\n  return u.admin ? grant(u) : deny(u);\n};\n${ARMS.replaceAll('export function', 'function')}`;
// A module whose named exports Node can't see from its text (the unbalanced one below), imported whole.
const viaDefault = `${H}import m from '../src/c.cjs';\ntest('g', () => { assert.deepEqual(m.g({ admin: false }), 'none'); });\n`;

test('must hold: E3: M3 in CommonJS, `exports.g =` moved with its untaken arm edited', async () => {
  const d = await decided({ 'src/a.cjs': cjs('exports.g') }, { 'src/a.cjs': '', 'src/c.cjs': G_EDIT(cjs('exports.g')), 'test/x.test.js': calls('c.cjs', 'g', 'g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/c.cjs'));
});

test('must hold: E3m: M3 in CommonJS, `module.exports.g =` moved with its untaken arm edited', async () => {
  const d = await decided({ 'src/a.cjs': cjs('module.exports.g') }, { 'src/a.cjs': '', 'src/c.cjs': G_EDIT(cjs('module.exports.g')), 'test/x.test.js': calls('c.cjs', 'g', 'g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/c.cjs'));
});

test('must hold: E3a: M3 in TypeScript, an `export abstract class` moved with its untaken arm edited', async () => {
  const b = 'export abstract class B {\n  static g(u: { admin: boolean }) {\n    return u.admin ? grant(u) : deny(u);\n  }\n}\n';
  const d = await decided({ 'src/a.ts': G_A + b + ARMS }, { 'src/a.ts': G_A, 'src/c.ts': G_EDIT(b + ARMS), 'test/x.test.js': calls('c.ts', 'B', 'B.g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.ts, src/c.ts'));
});

test('must hold: E3n: M3 in TypeScript through dist/, an `export namespace` moved with its untaken branch edited', async () => {
  const ns = (v: string) => `export namespace N {\n  export function g(u) {\n    if (u.admin) {\n      return '${v}';\n    }\n    return 'none';\n  }\n}\n`;
  const js = "export var N = {};\nN.g = function g(u) {\n    if (u.admin) {\n      return 'everything';\n    }\n    return 'none';\n  };\nvoid 0;\n";
  const d = await decided({ 'src/a.ts': G_A + ns('all') }, { 'src/a.ts': G_A, 'src/c.ts': ns('everything'), 'dist/c.js': js, 'dist/c.js.map': map('c.js', '../src/c.ts', 8), 'test/x.test.js': fromDist('c.js', 'N', 'N.g({})', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.ts, src/c.ts'));
});

test('must hold: E4 (BP1): M5c with a regular expression holding `(` right after an `if` condition above g in the file g moved to', async () => {
  assert.deepEqual(await moveG(S_G, 'export function paren(s) {\n  if (s) /\\(/.test(s);\n  return s;\n}\n' + S_G), hold('src/c.js, src/s.js'));
});

test('must hold: E4b: E4 with a division inside a call in the same function (no reading of codeLines balances it)', async () => {
  assert.deepEqual(await moveG(S_G, 'export function paren(s) {\n  if (s) /\\(/.test(s);\n  return Math.round(s / 2);\n}\n' + S_G), hold('src/c.js, src/s.js'));
});

test('must hold: E5: M5c with a division after a postfix `++` inside a call above g in the file g moved to', async () => {
  assert.deepEqual(await moveG(S_G, 'export function mid(n) {\n  let i = n;\n  return Math.floor(i++ / 2);\n}\n' + S_G), hold('src/c.js, src/s.js'));
});

test('must hold: E7: M5c with a regular expression after `export default` (a `/` the statement reading takes for a division) above g in the file g moved to', async () => {
  assert.deepEqual(await moveG(S_G, 'export default /\\)/;\n' + S_G), hold('src/c.js, src/s.js'));
});

test('control: E6: M5c with a template holding a division, an object and a `(` in its text above g holds', async () => {
  assert.deepEqual(await moveG(S_G, 'export function fmt(a) {\n  return `${Math.round(a / 2)} of ${ {k: 1}.k } (`;\n}\n' + S_G), hold('src/c.js, src/s.js'));
});

test('must hold: E8: M5c with a division right after a function expression inside a call above g (no reading balances the file; g starts on its `export`)', async () => {
  assert.deepEqual(await moveG(S_G, 'export const n = Math.round(function () { return 4; } / 2);\n' + S_G), hold('src/c.js, src/s.js'));
});

test('limit: in a file no reading balances only `export` and `import` lines start statements: E3 with a division right after a function expression above `exports.g =`', { todo: 'neither reading reads this `/` as a division, so `exports.g =` starts no statement and g reads as added code, as before #1014' }, async () => {
  const head = 'exports.n = Math.round(function () { return 4; } / 2);\n' + G_EDIT(cjs('exports.g'));
  const d = await decided({ 'src/a.cjs': cjs('exports.g') }, { 'src/a.cjs': '', 'src/c.cjs': head, 'test/x.test.js': viaDefault });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/c.cjs'));
});

test('control: the same file balanced (no division) holds', async () => {
  const head = 'exports.n = Math.round(function () { return 4; }() * 2);\n' + G_EDIT(cjs('exports.g'));
  const d = await decided({ 'src/a.cjs': cjs('exports.g') }, { 'src/a.cjs': '', 'src/c.cjs': head, 'test/x.test.js': viaDefault });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/c.cjs'));
});

// ---- Z-*, X* (#1014's fourth reviews): what git already paired is never paired again, only formatting is no change,
// statements start on keywords no expression goes on with, and a same-named unit never takes another's source

const into = async (file: string, text: string) => {
  const d = await decided({ 'src/s.js': S }, { 'src/s.js': editH(S_T), [`src/${file}`]: text, 'test/x.test.js': calls(file, 'g', 'g({})', '3') });
  return [d.auto, d.reasons];
};
const ONE = "export const isOpen = (s) => s.open;\nexport const total = (a, b, c) => a * b + c;\n";
const merges = async (before: Record<string, string>, after: Record<string, string>) => {
  const d = await decided(before, after);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
};

test('must merge: Z-F1: g moved to a new file with a tested precedence fix (parentheses only)', async () => {
  await merges({ 'src/a.js': G_A + 'export function g(a, b, c) {\n  return a * b + c;\n}\n' }, { 'src/a.js': G_A, 'src/c.js': 'export function g(a, b, c) {\n  return a * (b + c);\n}\n', 'test/x.test.js': calls('c.js', 'g', 'g(2, 3, 4)', '14') });
});

test('must merge: Z-F1b: g moved with a tested `!` precedence fix (parentheses only)', async () => {
  await merges({ 'src/a.js': G_A + 'export function g(x) {\n  return !x instanceof Array;\n}\n' }, { 'src/a.js': G_A, 'src/c.js': 'export function g(x) {\n  return !(x instanceof Array);\n}\n', 'test/x.test.js': calls('c.js', 'g', 'g(1)', 'true') });
});

test('must merge: Z-F6: in place, a tested fix calling what a one-line arrow returned', async () => {
  await merges({ 'src/o.js': ONE }, { 'src/o.js': ONE.replace('s.open;', 's.open();'), 'test/x.test.js': calls('o.js', 'isOpen', 'isOpen({ open: () => true })', 'true') });
});

test('must merge: Z-F7: in place, a tested precedence fix in a one-line arrow', async () => {
  await merges({ 'src/o.js': ONE }, { 'src/o.js': ONE.replace('a * b + c', 'a * (b + c)'), 'test/x.test.js': calls('o.js', 'total', 'total(2, 3, 4)', '14') });
});

test('control: Z-F8: in place, a tested real edit in a one-line arrow merges', async () => {
  await merges({ 'src/o.js': ONE }, { 'src/o.js': ONE.replace('a * b + c', 'a * b - c'), 'test/x.test.js': calls('o.js', 'total', 'total(2, 3, 4)', '2') });
});

test('must merge: Z-F9: in place, a tested call fix in a one-line `exports.x =` arrow', async () => {
  const one = 'exports.isOpen = (s) => s.open;\n';
  await merges({ 'src/o.cjs': one }, { 'src/o.cjs': one.replace('s.open;', 's.open();'), 'test/x.test.js': calls('o.cjs', 'isOpen', 'isOpen({ open: () => true })', 'true') });
});

test('must merge: Z-F10: in place, a tested call fix in a one-line function declaration', async () => {
  const one = 'export function ready(s) { return s.ok; }\n';
  await merges({ 'src/o.js': one }, { 'src/o.js': one.replace('s.ok;', 's.ok();'), 'test/x.test.js': calls('o.js', 'ready', 'ready({ ok: () => 1 })', '1') });
});

test('must merge: Z-F11: in place, a semicolon added to a tested one-line function (git measures it; never paired with its own old line)', async () => {
  const one = 'export function ready(s) { return s.ok }\n';
  await merges({ 'src/o.js': one }, { 'src/o.js': one.replace('s.ok }', 's.ok; }'), 'test/x.test.js': calls('o.js', 'ready', 'ready({ ok: 1 })', '1') });
});

// ---- #1014's fifth reviews: a statement git paired in place pairs with nothing else, and only the parenthesis
// positions quiet names are formatting
const PAD = 'export function pad1(x) {\n  return x;\n}\nexport function pad2(x) {\n  return x;\n}\n';

test('must merge: G1: a tested one-line edit in place, the PR deleting a file that held the new line', async () => {
  const d = await decided({ 'src/a.js': PAD + 'export const g = (x) => x + 1;\n', 'src/b.js': 'export const g = (x) => x + 2;\n' }, { 'src/a.js': PAD + 'export const g = (x) => x + 2;\n', 'test/x.test.js': calls('a.js', 'g', 'g(1)', '3') }, ['src/b.js']);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('must merge: G1b: G1 with the other file kept and only its copy removed', async () => {
  const q = PAD.replaceAll('pad', 'q');
  await merges({ 'src/a.js': PAD + 'export const g = (x) => x + 1;\n', 'src/b.js': q + 'export const g = (x) => x + 2;\n' }, { 'src/a.js': PAD + 'export const g = (x) => x + 2;\n', 'src/b.js': q, 'test/x.test.js': calls('a.js', 'g', 'g(1)', '3') });
});

test('control: G1c: a 3-line function rewritten in place, the PR deleting a file that held the new version, merges', async () => {
  const newG = 'export function g(x) {\n  const z = x - 1;\n  return z * 3;\n}\n';
  const d = await decided({ 'src/a.js': PAD + 'export function g(x) {\n  const y = x + 1;\n  return y * 2;\n}\n', 'src/b.js': newG }, { 'src/a.js': PAD + newG, 'test/x.test.js': calls('a.js', 'g', 'g(2)', '3') }, ['src/b.js']);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

const D1_A = (f: string) => `${f}\nexport const h = 0;\n`;

test('must merge: D1: a tested one-line edit in place to the text of a copy the PR removes from another file', async () => {
  await merges({ 'src/a.js': D1_A('export const f = (x) => x + 1;'), 'src/b.js': 'export const f = (x) => x + 2;\nexport const k = 0;\n' }, { 'src/a.js': D1_A('export const f = (x) => x + 2;'), 'src/b.js': 'export const k = 0;\n', 'test/x.test.js': calls('a.js', 'f', 'f(1)', '3') });
});

test('must merge: D1d: D1 with the other file deleted', async () => {
  const d = await decided({ 'src/a.js': D1_A('export const f = (x) => x + 1;'), 'src/b.js': 'export const f = (x) => x + 2;\n' }, { 'src/a.js': D1_A('export const f = (x) => x + 2;'), 'test/x.test.js': calls('a.js', 'f', 'f(1)', '3') }, ['src/b.js']);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('control: D1m: D1 with f on three lines merges', async () => {
  const f = (b: string) => `export function f(x) {\n  return ${b};\n}\nexport const h = 0;\n`;
  await merges({ 'src/a.js': f('x + 1'), 'src/b.js': 'export function f(x) {\n  return x * 3;\n}\nexport const k = 0;\n' }, { 'src/a.js': f('x * 3'), 'src/b.js': 'export const k = 0;\n', 'test/x.test.js': calls('a.js', 'f', 'f(1)', '3') });
});

test('must merge: U1: D1 with an unnamed one-line statement', async () => {
  const t = `${H}import '../src/a.js';\ntest('f', () => { assert.equal(globalThis.f(1), 3); });\n`;
  await merges({ 'src/a.js': 'export const h = 0;\nglobalThis.f = (x) => x + 1;\n', 'src/b.js': 'globalThis.f = (x) => x + 2;\nexport const k = 0;\n' }, { 'src/a.js': 'export const h = 0;\nglobalThis.f = (x) => x + 2;\n', 'src/b.js': 'export const k = 0;\n', 'test/x.test.js': t });
});

// ---- #1014's sixth review: a unit git paired with a same-named statement it keeps little of took that one's place
const STALE = "export const k = 1;\nexport function g() {\n  return 'stale';\n}\n";
const intoStale = async (stale: string) => {
  const d = await decided({ 'src/s.js': S, 'src/c.js': stale }, { 'src/s.js': editH(S_T), 'src/c.js': IMP + 'export const k = 1;\n' + S_G, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
  return [d.auto, d.reasons];
};

test('must hold: N5: M5c with g moved into a file over a stale same-named g there', async () => {
  assert.deepEqual(await intoStale(STALE), hold('src/c.js, src/s.js'));
});

test('control: N5x: the same over a stale differently named function holds', async () => {
  assert.deepEqual(await intoStale(STALE.replace('function g()', 'function old()')), hold('src/c.js, src/s.js'));
});

test('must hold: N6: N5 over a one-line stale g (the removals git measured inside the moved g go with it)', async () => {
  assert.deepEqual(await intoStale("export const k = 1;\nexport const g = () => 'stale';\n"), hold('src/c.js, src/s.js'));
});

// ---- #1014's seventh review: a pair too large to align is not one edited in place, and no other pair spends its cells
const N5_FILES = (stale: string, moved: string) => [{ 'src/s.js': S.replace(S_G, moved), 'src/c.js': stale }, { 'src/s.js': editH(S_T), 'src/c.js': IMP + 'export const k = 1;\n' + moved, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') }] as const;
const n5With = async (before: Record<string, string>, after: Record<string, string>, stale = STALE, moved = S_G) => {
  const [b, a] = N5_FILES(stale, moved);
  const d = await decided({ ...b, ...before }, { ...a, ...after });
  return [d.auto, d.reasons];
};
const BUILD = (p: string) => `const defaults = {};\nexport function build(${p}) {\n` + Array.from({ length: 200 }, (_, i) => `  ${p}.field${i} = ${p}.field${i} ?? defaults.field${i};\n`).join('') + `  return ${p};\n}\n`;
const ROWS = (q: string, wrap: boolean) => `export const TABLE = ${wrap ? 'Object.freeze([' : '['}\n` + Array.from({ length: 120 }, (_, i) => `  [${q}alpha-beta-gamma-${i}${q}, ${q}delta-epsilon-zeta-${i}${q}],\n`).join('') + (wrap ? ']);\n' : '];\n');
const TABLES = (d: number, n = 10) => Array.from({ length: n }, (_, t) => `export const T${t} = [${Array.from({ length: 500 }, (_, i) => (i * 7 + t + (i === 3 ? d : 0)) % 1000).join(', ')}];\nexport const sep${t} = ${t};\n`).join('');

test('must hold: BUDf: N5 with a 200-line function edited in place on every line in a file that sorts first', async () => {
  assert.deepEqual(await n5With({ 'src/a.js': BUILD('o') }, { 'src/a.js': BUILD('options') }), hold('src/a.js, src/c.js, src/s.js'));
});

test('must hold: BUD120: N5 with a 120-row table re-quoted and wrapped in place in a file that sorts first', async () => {
  assert.deepEqual(await n5With({ 'src/a.js': ROWS("'", false) }, { 'src/a.js': ROWS('"', true) }), hold('src/a.js, src/c.js, src/s.js'));
});

test('control: BUDz: BUD120 with the table in a file that sorts after the moved g holds', async () => {
  assert.deepEqual(await n5With({ 'src/z.js': ROWS("'", false) }, { 'src/z.js': ROWS('"', true) }), hold('src/c.js, src/s.js, src/z.js'));
});

test('must hold: B3: N5 with ten ~1,950-character one-line tables edited in place in a file that sorts first', async () => {
  assert.deepEqual(await n5With({ 'src/a.js': TABLES(0) }, { 'src/a.js': TABLES(1) }), hold('src/a.js, src/c.js, src/s.js'));
});

test('control: B3c: B3 with three tables holds', async () => {
  assert.deepEqual(await n5With({ 'src/a.js': TABLES(0, 3) }, { 'src/a.js': TABLES(1, 3) }), hold('src/a.js, src/c.js, src/s.js'));
});

const G110 = 'export function g(u) {\n' + Array.from({ length: 110 }, (_, i) => `  const v${i} = alpha(u) + ${i} * beta(u);\n`).join('') + '  return combine(alpha(u), beta(u));\n}\n';
const STALE_W = 'export const k = 1;\nexport function g(w) {\n' + Array.from({ length: 110 }, (_, i) => `  const v${i} = gamma(w) - ${i} / beta(w);\n`).join('') + '  return combine(alpha(w), alpha(w));\n}\n';

test('must hold: BL1wb: N5 with a 110-line g moved over a 110-line stale g(w) too large to align with it', async () => {
  assert.deepEqual(await n5With({}, {}, STALE_W, G110), hold('src/c.js, src/s.js'));
});

test('must merge: D1p: D1 with a 200-line function edited in place in a file that sorts first (each pair aligns on its own)', async () => {
  await merges({ 'src/0.js': BUILD('o'), 'src/a.js': D1_A('export const f = (x) => x + 1;'), 'src/b.js': 'export const f = (x) => x + 2;\nexport const k = 0;\n' }, { 'src/0.js': BUILD('options'), 'src/a.js': D1_A('export const f = (x) => x + 2;'), 'src/b.js': 'export const k = 0;\n', 'test/x.test.js': calls('a.js', 'f', 'f(1)', '3') });
});

test('must merge: BIGIN: a tested 110-line function edited in place on its first and last lines', async () => {
  const f = (a: string) => 'export function f(u) {\n' + Array.from({ length: 110 }, (_, i) => `  u.k${i} = u.k${i} ${i === 0 || i === 109 ? a : '-'} ${i};\n`).join('') + '  return u;\n}\nexport const z = 0;\n';
  await merges({ 'src/a.js': f('+') }, { 'src/a.js': f('*'), 'test/x.test.js': calls('a.js', 'f', 'f({ k0: 1 }).k0 > -1', 'true') });
});

test('limit: N5u: N5 over a stale g with the same first line', { todo: 'git keeps `export function g(u) {`, so the moved g is never wholly added and is measured as git measured it: it merges, as at d76d96f0 and on main #1014' }, async () => {
  assert.deepEqual(await intoStale(STALE.replace('function g()', 'function g(u)')), hold('src/c.js, src/s.js'));
});

test('limit: a statement rewritten in place past EDITED_IN_PLACE to the text of a copy the PR removes elsewhere', { todo: 'it keeps too little of its old text to count as edited in place, so it pairs with the copy as moved from there and holds, as at d76d96f0; main merges it #1014' }, async () => {
  await merges({ 'src/a.js': D1_A('export const f = (x) => x + 1;'), 'src/b.js': 'export const f = (x) => Math.max(x, 0) * 2;\nexport const k = 0;\n' }, { 'src/a.js': D1_A('export const f = (x) => Math.max(x, 0) * 2;'), 'src/b.js': 'export const k = 0;\n', 'test/x.test.js': calls('a.js', 'f', 'f(1)', '2') });
});

const W1_BASE = "export const g = (u) => u.id * 2 + 3;\nexport const h = (u) => u.admin ? 'all' : 'none';\nexport const z = 0;\n";
test('limit: W1: g moved below h in its file and re-formatted, an untested arm edited in h', { todo: 'git pairs g with its own old text in place, so it is measured as git measured it: its formatting counts and a test that runs it merges the PR, as on main #1014' }, async () => {
  const d = await decided({ 'src/w.js': W1_BASE }, { 'src/w.js': "export const h = (u) => u.admin ? 'everything' : 'none';\nexport const g = u => u.id * 2 + 3\nexport const z = 0;\n", 'test/x.test.js': calls('w.js', 'g', 'g({ id: 1 })', '5') });
  assert.deepEqual([d.auto, d.reasons], hold('src/w.js'));
});

test('limit: W2: W1 with one-line functions, g re-wrapped onto three lines', { todo: 'as W1 #1014' }, async () => {
  const base = "export function g(u) { return u.id * 2 + 3; }\nexport function h(u) { return u.admin ? 'all' : 'none'; }\nexport const z = 0;\n";
  const head = "export function h(u) { return u.admin ? 'everything' : 'none'; }\nexport function g(u) {\n  return u.id * 2 + 3;\n}\nexport const z = 0;\n";
  const d = await decided({ 'src/w.js': base }, { 'src/w.js': head, 'test/x.test.js': calls('w.js', 'g', 'g({ id: 1 })', '5') });
  assert.deepEqual([d.auto, d.reasons], hold('src/w.js'));
});

for (const [id, call, want] of [
  ['PQ2', 'g({ a: 0, b: false })', '2'],
  ['PQ3', 'g({ a: null, b: true })', '1'],
] as const) {
  test(`must merge: ${id}: g moved with a tested \`u.a ?? (u.b ? 1 : 2)\` written \`u.a ?? u.b ? 1 : 2\` (a lower-precedence \`?:\` after \`??\`)`, async () => {
    const g = (b: string) => (id === 'PQ2' ? `export function g(u) {\n  const v = ${b};\n  return v;\n}\n` : `export function g(u) {\n  return ${b};\n}\n`);
    await merges({ 'src/s.js': PAD + g('u.a ?? (u.b ? 1 : 2)') }, { 'src/s.js': PAD, 'src/c.js': g('u.a ?? u.b ? 1 : 2'), 'test/x.test.js': calls('c.js', 'g', call, want) });
  });
}

test('must merge: G2: g moved with a tested `(a + b) * c` precedence fix after `return`', async () => {
  await merges({ 'src/a.js': PAD + 'export function g(a, b, c) {\n  return a + b * c;\n}\n' }, { 'src/a.js': PAD, 'src/c.js': 'export function g(a, b, c) {\n  return (a + b) * c;\n}\n', 'test/x.test.js': calls('c.js', 'g', 'g(1, 2, 3)', '9') });
});

test('must merge: G2e: G2 after `=`', async () => {
  const g = (v: string) => `export function g(a, b, c) {\n  const v = ${v};\n  return v;\n}\n`;
  await merges({ 'src/a.js': PAD + g('a + b * c') }, { 'src/a.js': PAD, 'src/c.js': g('(a + b) * c'), 'test/x.test.js': calls('c.js', 'g', 'g(1, 2, 3)', '9') });
});

test('must merge: G5: g moved with a tested `=> { a: 1 }` to `=> ({ a: 1 })` fix', async () => {
  await merges({ 'src/a.js': PAD + 'export const g = () => { a: 1 };\n' }, { 'src/a.js': PAD, 'src/c.js': 'export const g = () => ({ a: 1 });\n', 'test/x.test.js': calls('c.js', 'g', 'g().a', '1') });
});

test('must merge: B16b: g moved with a tested `(x) => ({ x })` to `(x) => { x }` change', async () => {
  const g = (b: string) => `export function g(u) {\n  return ${b}(combine(alpha(u), beta(u)));\n}\n`;
  const d = await decided({ 'src/s.js': S.replace(S_G, g('((x) => ({ x }))')) }, { 'src/s.js': S_T, 'src/c.js': IMP + g('((x) => { x })'), 'test/x.test.js': calls('c.js', 'g', 'g({})', 'undefined') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

for (const [id, from, to] of [
  ['Q-Pq', 'u.a ?? (combine(alpha(u), beta(u)))', 'u.a ?? combine(alpha(u), beta(u))'],
  ['Q-Pc', 'u.a ? 1 : (combine(alpha(u), beta(u)))', 'u.a ? 1 : combine(alpha(u), beta(u))'],
] as const) {
  test(`must hold: ${id}: M5c with g moved and \`${from}\` written \`${to}\` (parentheses after \`${id === 'Q-Pq' ? '??' : ':'}\` are formatting)`, async () => {
    const g = (b: string) => `export function g(u) {\n  return ${b};\n}\n`;
    assert.deepEqual(await moveG(g(from), g(to)), hold('src/c.js, src/s.js'));
  });
}

test('must hold: Z-T3: M3 with a column-0 `export` line in a template inside g (a template never starts a statement)', async () => {
  const g = (v: string) => `export function g(u) {\n  if (u.never) return \`\nexport \${u.${v}}\n\`;\n  return combine(alpha(u), beta(u));\n}\n`;
  assert.deepEqual(await moveG(g('a'), g('b')), hold('src/c.js, src/s.js'));
});

for (const [id, line] of [
  ['X2', 'export type T = Array<number>\n'],
  ['X2b', 'export type T = Map<string, number>\n'],
  ['X3', 'const k = globalThis.process!\n'],
  ['Z-A1', 'export type Pair = Array<number>\n'],
  ['Z-A2', 'export const env = globalThis.process!\n'],
] as const) {
  test(`must hold: ${id}: M5c into TypeScript written without semicolons, \`${line.trim()}\` above g`, async () => {
    assert.deepEqual(await into('c.ts', IMP.replace(';', '') + line + S_G), hold('src/c.ts, src/s.js'));
  });
}

test('control: Z-A1c: the same alias ending in `;` holds', async () => {
  assert.deepEqual(await into('c.ts', IMP + 'export type Pair = Array<number>;\n' + S_G), hold('src/c.ts, src/s.js'));
});

test('must hold: Z-A3: JavaScript without semicolons, a line ending in postfix `++` above moved g', async () => {
  assert.deepEqual(await into('c.js', IMP.replace(';', '') + 'let n = 0\nn++\n' + S_G), hold('src/c.js, src/s.js'));
});

test('must hold: Z-A3c: E3 with a line ending in postfix `++` above `exports.g =` (a postfix `++` ends the code before)', async () => {
  const d = await decided({ 'src/a.cjs': cjs('exports.g') }, { 'src/a.cjs': '', 'src/c.cjs': 'let n = 0\nn++\n' + G_EDIT(cjs('exports.g')), 'test/x.test.js': calls('c.cjs', 'g', 'g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/c.cjs'));
});

test('must hold: Z-A4: a numeric literal ending in a dot above moved g', async () => {
  assert.deepEqual(await into('c.js', IMP + 'export const scale = 2.\n' + S_G), hold('src/c.js, src/s.js'));
});

test('must hold: Z-A4c: E3 with `const g =` after a line ending in a numeric literal\'s dot (a `const` always starts a statement)', async () => {
  const exp = (names: string) => `module.exports = { ${names} };\n`;
  const d = await decided({ 'src/a.cjs': cjs('const g') + exp('g') }, { 'src/a.cjs': '', 'src/c.cjs': 'const scale = 2.\n' + G_EDIT(cjs('const g')) + exp('g, scale'), 'test/x.test.js': calls('c.cjs', 'g', 'g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/c.cjs'));
});

test('must hold: E4c: E4b in CommonJS (no `export` to start g: only the reading that takes a `/` after an `if` condition for a regex balances)', async () => {
  const head = 'function paren(s) {\n  if (s) /\\(/.test(s);\n  return Math.round(s / 2);\n}\n' + G_EDIT(cjs('exports.g'));
  const d = await decided({ 'src/a.cjs': cjs('exports.g') }, { 'src/a.cjs': '', 'src/c.cjs': head, 'test/x.test.js': calls('c.cjs', 'g', 'g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/c.cjs'));
});

test('must hold: Q-S: M5c with g moved into a file written without semicolons and its own dropped', async () => {
  assert.deepEqual(await moveG(S_G, S_G.replace(';\n', '\n')), hold('src/c.js, src/s.js'));
});

test('must hold: Q-S2: M5c with g moved out of a file written without semicolons and given one', async () => {
  assert.deepEqual(await moveG(S_G.replace(';\n', '\n'), S_G), hold('src/c.js, src/s.js'));
});

test('must hold: Q-C: M5c with g moved and its call wrapped one argument a line, a trailing comma added', async () => {
  const wrapped = (comma: string) => `export function g(u) {\n  return combine(\n    alpha(u),\n    beta(u)${comma}\n  );\n}\n`;
  assert.deepEqual(await moveG(wrapped(''), wrapped(',')), hold('src/c.js, src/s.js'));
});

test('must hold: Q-P: an arrow g moved with the parentheses around its one parameter dropped', async () => {
  assert.deepEqual(await moveG('export const g = (u) => combine(alpha(u), beta(u));\n', 'export const g = u => combine(alpha(u), beta(u));\n'), hold('src/c.js, src/s.js'));
});

test('must hold: Z-B1: the statement reading unbalanced, the every-`/`-a-regex reading balanced but wrong around moved g', async () => {
  assert.deepEqual(await into('c.js', IMP + 'export default /\\)/;\nexport const half = Math.round(7 / 2);\n' + S_G + 'export const q = (8 / (4 / 2));\n'), hold('src/c.js, src/s.js'));
});

test('control: Z-B1c: the same without the default regex holds', async () => {
  assert.deepEqual(await into('c.js', IMP + 'export const half = Math.round(7 / 2);\n' + S_G + 'export const q = (8 / (4 / 2));\n'), hold('src/c.js, src/s.js'));
});

test('must hold: Z-B2: `of` used as a name before a division above moved g', async () => {
  assert.deepEqual(await into('c.js', IMP + 'const of = 4;\nexport const r = Math.round(of / 2);\n' + S_G), hold('src/c.js, src/s.js'));
});

const M3 = G_EDIT(G_C);
const M3T = calls('c.js', 'g', 'g({ admin: false })', "'none'");
const G_DECOY = "export function g(u) {\n  return 'decoy';\n}\n";

test('must hold: Z-N1: M3 plus an untested decoy `g` in a new file that sorts first', async () => {
  const d = await decided({ 'src/a.js': G }, { 'src/a.js': G_A, 'src/b.js': G_DECOY, 'src/c.js': M3, 'test/x.test.js': M3T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js, src/c.js'));
});

test('control: Z-N1z: the same decoy in a file that sorts after holds', async () => {
  const d = await decided({ 'src/a.js': G }, { 'src/a.js': G_A, 'src/z.js': G_DECOY, 'src/c.js': M3, 'test/x.test.js': M3T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js, src/z.js'));
});

test('must hold: Z-N2: M3 where a new g is written in the source file in the old one\'s place', async () => {
  const d = await decided({ 'src/a.js': G }, { 'src/a.js': G_A + "export function g(u) {\n  return 'v2';\n}\n", 'src/c.js': M3, 'test/x.test.js': M3T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js'));
});

test('must hold: Z-N3: E3 plus an `exports.g =` decoy in a file that sorts first', async () => {
  const d = await decided({ 'src/a.cjs': cjs('exports.g') }, { 'src/a.cjs': '', 'src/b.cjs': 'exports.g = () => 0;\n', 'src/c.cjs': G_EDIT(cjs('exports.g')), 'test/x.test.js': calls('c.cjs', 'g', 'g({ admin: false })', "'none'") });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.cjs, src/b.cjs, src/c.cjs'));
});

test('must hold: Z-N4: two sources named g, g moved from the second with its untaken arm edited', async () => {
  const other = "export function g(u) {\n  return [u, u, u].map(String).join('-');\n}\n";
  const d = await decided({ 'src/a.js': G_A + other, 'src/b.js': G_C }, { 'src/a.js': G_A, 'src/b.js': '', 'src/c.js': M3, 'test/x.test.js': M3T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js, src/c.js'));
});

// ---- #1014's eighth review: each same-named pair is scored on its own, so no other pair's size decides by path order
const BIGF = (k: number, v: string) => `export function big${k}(u) {\n${lines(64, (i) => `  const v${i} = alpha(u) + ${i} * beta(u) ^ ${k};\n`)}  return ${v};\n}\n`;
const BIGS = (n: number, v: string) => lines(n, (k) => BIGF(k, v));
const BIG_T = (n: number, s: number) => {
  const items: string[] = [];
  for (let i = 0, len = 0; len < n; i++) {
    const it = `'${s}${(i * 7919 + s * 104729) % 99991}'`;
    items.push(it);
    len += it.length + 1;
  }
  return `export function t(u) { return [${items.join(',')}]; }\n`;
};
const T_PAIR = (n: number) => [{ 'src/0t.js': 'export const k = 1;\n' + BIG_T(n, 1) }, { 'src/0t.js': 'export const k = 1;\n', 'src/01.js': BIG_T(n, 2), 'src/02.js': BIG_T(n, 3) }] as const;

test('must hold: ZN1spent: Z-N1 with five contested ~2,000-character functions moved into a file that sorts first', async () => {
  const d = await decided({ 'src/a.js': G, 'src/p.js': BIGS(5, "'p'") + 'export const kp = 1;\n', 'src/q.js': BIGS(5, "'q'") + 'export const kq = 1;\n' }, { 'src/a.js': G_A, 'src/b.js': G_DECOY, 'src/c.js': M3, 'test/x.test.js': M3T, 'src/0.js': BIGS(5, "'zero'"), 'src/p.js': 'export const kp = 1;\n', 'src/q.js': 'export const kq = 1;\n' });
  assert.deepEqual([d.auto, d.reasons], hold('src/0.js, src/a.js, src/b.js and 3 more'));
});

for (const [id, n, decoy, app] of [
  ['ZN1B', 4500, 'src/b.js', 'src/01.js, src/02.js, src/0t.js and 3 more'],
  ['ZN1Bs', 300, 'src/b.js', 'src/01.js, src/02.js, src/0t.js and 3 more'],
  ['ZN1Bz', 4500, 'src/z.js', 'src/01.js, src/02.js, src/0t.js and 3 more'],
  ['M3B', 4500, null, 'src/01.js, src/02.js, src/0t.js and 2 more'],
] as const) {
  const what = { ZN1B: 'must hold: ZN1B: Z-N1 with two ~4,500-character one-line `t` statements contesting one removed `t`', ZN1Bs: 'control: ZN1Bs: ZN1B with ~300-character `t` statements holds', ZN1Bz: 'control: ZN1Bz: ZN1B with the decoy in a file that sorts after holds', M3B: 'control: M3B: M3 with the `t` statements of ZN1B holds' }[id];
  test(what, async () => {
    const [b, a] = T_PAIR(n);
    const d = await decided({ 'src/a.js': G, ...b }, { 'src/a.js': G_A, ...(decoy ? { [decoy]: G_DECOY } : {}), 'src/c.js': M3, 'test/x.test.js': M3T, ...a });
    assert.deepEqual([d.auto, d.reasons], hold(app));
  });
}

test('must hold: ZN4B: Z-N4 with the `t` statements of ZN1B', async () => {
  const other = "export function g(u) {\n  return [u, u, u].map(String).join('-');\n}\n";
  const [b, a] = T_PAIR(4500);
  const d = await decided({ 'src/a.js': G_A + other, 'src/b.js': G_C, ...b }, { 'src/a.js': G_A, 'src/b.js': '', 'src/c.js': M3, 'test/x.test.js': M3T, ...a });
  assert.deepEqual([d.auto, d.reasons], hold('src/01.js, src/02.js, src/0t.js and 3 more'));
});

test('must hold: ZN1L: Z-N1 with a 120-line g edited at both ends, too large to align by character with either candidate (scored by its lines)', async () => {
  const ARMS = G_C.slice(G_C.indexOf('function grant')) + 'function alpha(u) {\n  return 1;\n}\nfunction beta(u) {\n  return 2;\n}\n';
  const g = (first: number, arm: string) => `export function g(u) {\n  if (u.never) return ${first};\n${lines(120, (i) => `  const v${i} = alpha(u) + ${i} * beta(u);\n`)}  return u.admin ? ${arm}(u) : deny(u);\n}\n`;
  const decoy = `export function g(u) {\n${lines(122, (i) => `  const w${i} = gamma(u) - ${i} / delta(u);\n`)}}\n`;
  const d = await decided({ 'src/a.js': G_A + g(1, 'grant') + ARMS }, { 'src/a.js': G_A, 'src/b.js': decoy, 'src/c.js': g(2, 'grantAll') + ARMS, 'test/x.test.js': M3T });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/b.js, src/c.js'));
});

test('must merge: D1L: D1 with a ~1,300-character line edited at its start and end (aligned within ALIGN_CELLS)', async () => {
  const nums = Array.from({ length: 260 }, (_, i) => 1000 + i).join(',');
  const f = (a: number, tail: string) => `export const f = (x) => x + ${a} + 0 * [${nums}].length${tail};`;
  await merges({ 'src/a.js': D1_A(f(1, '')), 'src/b.js': f(2, ' * 9') + '\nexport const k = 0;\n' }, { 'src/a.js': D1_A(f(2, ' * 9')), 'src/b.js': 'export const k = 0;\n', 'test/x.test.js': calls('a.js', 'f', 'f(1)', '3') });
});

test('must merge: K-G: a tested copy of g added in a new file, the g it copies kept where it was, wrapped into new code', async () => {
  const g = 'function g(u) {\n  return u + 1;\n}\n';
  await merges({ 'src/a.js': g + 'export const k = 1;\n' }, { 'src/a.js': `export const all = [\n${g}];\nexport const k = 2;\n`, 'src/c.js': g + 'export { g };\n', 'test/x.test.js': calls('c.js', 'g', 'g(1)', '2') });
});

test('must merge: O4: a tested g moved to a new file, git keeping one of its code lines where it was (not a source)', async () => {
  const g = 'export function g(u) {\n  debugger;\n  return combine(alpha(u), beta(u));\n}\n';
  await merges({ 'src/s.js': g + S_T }, { 'src/s.js': '  debugger;\n' + editH(S_T), 'src/c.js': IMP + g, 'test/x.test.js': calls('c.js', 'g', 'g({})', '3') });
});

test('must merge: FH3: FH1 with an untested unchanged h moved ahead of run into the same file (only run measured as added)', async () => {
  const head = RUN((i) => (i === 5 ? '  globalThis.flag = [1, 2, 3].length;\n' : i === 140 ? "  u.z = typeof u === 'object';\n" : null));
  await merges({ 'src/a.js': M_A + P_H + RUN(() => null) }, { 'src/a.js': M_A, 'src/c.js': P_H + head, 'test/x.test.js': calls('c.js', 'run', 'run({}).z', 'true') });
});

const BR = (swap: (i: number) => string | null) => `export function run(u) {\n${lines(148, (i) => swap(i) ?? `  u.a${i} = u.b${i} + ${i};\n`)}  return u;\n}\n`;

test('limit: X1: a tested 150-line run moved with two lines in branches it never takes replaced, an untested arm edited in h', { todo: 'two replaced lines are enough to keep a large unit from aligning, so it reads as added code, as before #1014' }, async () => {
  const base = BR((i) => (i === 5 ? '  if (u.never) u.q = 1;\n' : i === 140 ? '  if (u.never) u.r = 2;\n' : null));
  const head = BR((i) => (i === 5 ? '  if (u.never) globalThis.flag = [1, 2, 3].length;\n' : i === 140 ? "  if (u.never) u.z = typeof u === 'object';\n" : null));
  const d = await decided({ 'src/a.js': M_A + base, 'src/s.js': S }, { 'src/a.js': M_A, 'src/c.js': head, 'src/s.js': editH(S), 'test/x.test.js': calls('c.js', 'run', 'run({}).a0', 'NaN') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js, src/s.js'));
});

test('control: X1: the same with one line replaced holds', async () => {
  const base = BR((i) => (i === 140 ? '  if (u.never) u.r = 2;\n' : null));
  const head = BR((i) => (i === 140 ? "  if (u.never) u.z = typeof u === 'object';\n" : null));
  const d = await decided({ 'src/a.js': M_A + base, 'src/s.js': S }, { 'src/a.js': M_A, 'src/c.js': head, 'src/s.js': editH(S), 'test/x.test.js': calls('c.js', 'run', 'run({}).a0', 'NaN') });
  assert.deepEqual([d.auto, d.reasons], hold('src/a.js, src/c.js, src/s.js'));
});
