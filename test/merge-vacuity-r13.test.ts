// #784 round 13 (the round-12 second review M1-M5b, final check D0-D2, C1, R3s). Round 12's moved-code pairing is
// taken out: a dead copy of an edited line's old text in another app file made the whole edited line count (M1, M1b,
// M1c, D1, D2), and a replacement whose new line another file lost was judged as a removal (C1). These must-holds keep
// that route closed. Code moved, edited, re-wrapped or reordered out of git's own pairing (M3, M4b, M5b, R3s) read as
// added code again at round 13, so an untested change merged. #1014 pairs moved code only to take measure away (a file
// counts only where it counts both with and without the pairing): each holds, with M4b1, M5c and A6 (round 13's last
// reviews), and the must-holds above still hold.
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
async function decided(before: Record<string, string>, after: Record<string, string>) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
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

// ---- P2: a moved unit that can't be placed holds the PR, never its file measured as added code

const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('');
const BIG_G = `export function g(u) {\n${lines(297, (i) => `  const v${i} = u.a${i} + ${i};\n`)}  return u;\n}\n`;
const P_H = 'export function h(x) {\n  return x * 2;\n}\n';
const UNPLACED = "design: vacuity: its coverage run failed: a change too large to align character by character, so where it changed code can't be told";

test('must hold: P2: a 300-line g moved and rewritten untested into 280 lines, beside a tested unchanged h', async () => {
  const rewritten = `export function g(u) {\n${lines(277, (i) => `  const w${i} = u.b${i} * ${i};\n`)}  return u;\n}\n`;
  const d = await decided({ 'src/a.js': M_A + BIG_G + P_H }, { 'src/a.js': M_A, 'src/c.js': rewritten + P_H, 'test/x.test.js': calls('c.js', 'h', 'h(2)', '4') });
  assert.deepEqual([d.auto, d.reasons], [false, [UNPLACED]]);
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
