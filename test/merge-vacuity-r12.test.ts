// #784 round 12 (the round-11 final check Q1, second review I1, R1-R4, N1): a removal's two sides must share the
// innermost V8 range in every process that ran the script, not the first one's; code moved between app files (a
// rename git didn't pair, a function split out into a new file) is no change; and no range is left out by its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

function commit(dir: string, files: Record<string, string>, rm: string[] = []) {
  for (const p of rm) unlinkSync(join(dir, p));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'step');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A ready PR over the example project with a real remote at its base (`rm`: files the PR deletes), decided after its coverage run. */
async function decided(before: Record<string, string>, after: Record<string, string>, rm: string[] = []) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  const head = commit(dir, after, rm);
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
const importsOnly = (file: string, name: string) => `${H}import { ${name} } from '../src/${file}';\ntest('loads', () => { assert.equal(typeof ${name}, 'function'); });\n`;
const ranNone = (tests: string, app: string) => `design: vacuity: its tests (${tests}) ran none of the app code it changes (${app})`;

// ---- Q1, I1: a process that loaded the module without calling the function sees one range for all of it

const H1 = 'export function f(x) {\n  if (x) return g;\n  audit();\n  function g() {\n    return 1;\n  }\n  return null;\n}\nfunction audit() {}\nexport function other() {\n  return 2;\n}\n';
const H1_HEAD = H1.replace('  audit();\n', '');
const Q2 = "export function f(x) {\n  if (x) return g;\n  check(x);\n  function g() {\n    return 2;\n  }\n  return 0;\n}\nfunction check(x) {\n  if (!x) throw new Error('denied');\n}\n";
const Q2_HEAD = Q2.replace('  check(x);\n', '');

test('must hold: Q1a: H1 plus one more test file that only imports the module', async () => {
  const d = await decided({ 'src/h.js': H1 }, { 'src/h.js': H1_HEAD, 'test/a0.test.js': importsOnly('h.js', 'f'), 'test/b.test.js': calls('h.js', 'f', 'f(true)()', '1') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/a0.test.js, test/b.test.js', 'src/h.js')]]);
});

test('must hold: Q2: a guard call removed after an early return, before a hoisted function; three import-only files', async () => {
  const files = { 'test/a0.test.js': importsOnly('q.js', 'f'), 'test/a1.test.js': importsOnly('q.js', 'f'), 'test/a2.test.js': importsOnly('q.js', 'f'), 'test/b.test.js': calls('q.js', 'f', 'f(true)()', '2') };
  const d = await decided({ 'src/q.js': Q2 }, { 'src/q.js': Q2_HEAD, ...files });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/a0.test.js, test/a1.test.js, test/a2.test.js and 1 more', 'src/q.js')]]);
});

test('must hold: I1: test/a loads the module and calls another function, test/b takes the early return', async () => {
  const d = await decided({ 'src/h.js': H1 }, { 'src/h.js': H1_HEAD, 'test/a.test.js': calls('h.js', 'other', 'other()', '2'), 'test/b.test.js': calls('h.js', 'f', 'f(1)()', '1') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/a.test.js, test/b.test.js', 'src/h.js')]]);
});

test('must hold: I1q: one test file imports a `?c` copy first, then takes the early return', async () => {
  const t = `${H}import { other } from '../src/h.js?c';\nimport { f } from '../src/h.js';\ntest('f', () => { assert.equal(other(), 2); assert.equal(f(1)(), 1); });\n`;
  const d = await decided({ 'src/h.js': H1 }, { 'src/h.js': H1_HEAD, 'test/b.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/b.test.js', 'src/h.js')]]);
});

test('control: a plain statement removed inside a block that runs merges, with an import-only test file beside the one that runs it', async () => {
  const f = "const seen = [];\nexport function access(u) {\n  if (u.admin) {\n    const id = u.id;\n    seen.push(u);\n    return 'all ' + id;\n  }\n  return 'some';\n}\n";
  const d = await decided({ 'src/a.js': f }, { 'src/a.js': f.replace('    seen.push(u);\n', ''), 'test/a0.test.js': importsOnly('a.js', 'access'), 'test/b.test.js': calls('a.js', 'access', 'access({ admin: true, id: 1 })', "'all 1'") });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- R1, R3, R4: code moved between files, out of git's rename pairing

const R_BASE = "export function f(x) {\n  return x + 1;\n}\nexport function g(u) {\n  if (u.guest) {\n    throw new Error('denied');\n  }\n  return 'ok';\n}\n";
const R_HEAD = R_BASE.replace("  if (u.guest) {\n    throw new Error('denied');\n  }\n", '');
const tabs = (s: string) => s.replace(/^( {2})+/gm, (m) => '\t'.repeat(m.length / 2));

test('must hold: R1: a file renamed and re-indented with tabs (git pairs no rename), a guard removed from untested g', async () => {
  const d = await decided({ 'src/a.js': R_BASE }, { 'src/b.js': tabs(R_HEAD), 'test/x.test.js': calls('b.js', 'f', 'f(1)', '2') }, ['src/a.js']);
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/x.test.js', 'src/b.js')]]);
});

test('control: R1: the same move with a tested change in f merges', async () => {
  const d = await decided({ 'src/a.js': R_BASE }, { 'src/b.js': tabs(R_HEAD.replace('x + 1', 'x + 2')), 'test/x.test.js': calls('b.js', 'f', 'f(1)', '3') }, ['src/a.js']);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('control: R1c: the rename git pairs (same indentation), guard removed, still holds', async () => {
  const d = await decided({ 'src/a.js': R_BASE }, { 'src/b.js': R_HEAD, 'test/x.test.js': calls('b.js', 'f', 'f(1)', '2') }, ['src/a.js']);
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/x.test.js', 'src/b.js')]]);
});

const M_BASE = "export function f(x) {\n  return x + 1;\n}\nexport function g(u) {\n  if (u.guest) {\n    throw new Error('denied');\n  }\n  return 'ok';\n}\nexport function h(x) {\n  return x * 2;\n}\n";
const M_A = 'export function f(x) {\n  return x + 1;\n}\n';
const M_C = "export function g(u) {\n  return 'ok';\n}\nexport function h(x) {\n  return x * 2;\n}\n";

test('must hold: R3: g (its guard removed) and an unchanged h moved to a new file; the test calls h', async () => {
  const d = await decided({ 'src/a.js': M_BASE }, { 'src/a.js': M_A, 'src/c.js': M_C, 'test/x.test.js': calls('c.js', 'h', 'h(2)', '4') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/x.test.js', 'src/a.js, src/c.js')]]);
});

test('control: R3: the same move with a tested change in h merges', async () => {
  const d = await decided({ 'src/a.js': M_BASE }, { 'src/a.js': M_A, 'src/c.js': M_C.replace('x * 2', 'x * 3'), 'test/x.test.js': calls('c.js', 'h', 'h(2)', '6') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

const R4_BASE = R_BASE.replace("  return 'ok';\n", "  const r = 'ok';\n  return r;\n");

test('must hold: R4: a file moved with its guard removed and another line of untested g edited (under git\'s similarity)', async () => {
  const d = await decided({ 'src/a.js': R4_BASE }, { 'src/b.js': R_HEAD.replace("  return 'ok';\n", "  return 'ok' + '';\n"), 'test/x.test.js': calls('b.js', 'f', 'f(1)', '2') }, ['src/a.js']);
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/x.test.js', 'src/b.js')]]);
});

test('control: R4: the same move with the edit in tested f merges', async () => {
  const d = await decided({ 'src/a.js': R4_BASE }, { 'src/b.js': R_HEAD.replace('x + 1', 'x + 1 + 0'), 'test/x.test.js': calls('b.js', 'f', 'f(1)', '2') }, ['src/a.js']);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- N1: no range is left out by its function's name

const N_BASE = (name: string) => `export function f(u) {\n  const h = {\n    ${name}() {\n      return u.id;\n    },\n  };\n  return typeof h;\n}\n`;
const N_HEAD = (name: string) => N_BASE(name).replace('return u.id;', 'return u.name;');

test("must hold: N1: a method named '<static_x>' never called, its body changed; the test calls only f", async () => {
  const d = await decided({ 'src/n.js': N_BASE("'<static_x>'") }, { 'src/n.js': N_HEAD("'<static_x>'"), 'test/x.test.js': calls('n.js', 'f', 'f({})', "'object'") });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/x.test.js', 'src/n.js')]]);
});

test("control: N1: the method named '<static_x>' called by the test merges", async () => {
  const t = `${H}import { f2 } from '../src/n.js';\ntest('f2', () => { assert.equal(f2({ name: 'a' }), 'a'); });\n`;
  const add = "export function f2(u) {\n  return { '<static_x>'() { return u.name; } }['<static_x>']();\n}\n";
  const d = await decided({ 'src/n.js': N_BASE("'<static_x>'") }, { 'src/n.js': N_HEAD("'<static_x>'") + add, 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('control: a class with a static field and a static block, its tested method changed, merges (static initializers run at load, taken away by the baseline)', async () => {
  const cls = 'export class A {\n  static n = 1;\n  static {\n    A.ready = true;\n  }\n  m(x) {\n    return x + 1;\n  }\n}\n';
  const t = `${H}import { A } from '../src/k.js';\ntest('m', () => { assert.equal(new A().m(1), 3); });\n`;
  const d = await decided({ 'src/k.js': cls }, { 'src/k.js': cls.replace('x + 1', 'x + 2'), 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('must hold: a static field initializer changed, the test only makes an instance (loading runs it)', async () => {
  const cls = 'export class A {\n  static n = 1;\n  m(x) {\n    return x + 1;\n  }\n}\n';
  const t = `${H}import { A } from '../src/k.js';\ntest('m', () => { assert.equal(new A().m(1), 2); });\n`;
  const d = await decided({ 'src/k.js': cls }, { 'src/k.js': cls.replace('static n = 1', 'static n = 2'), 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/x.test.js', 'src/k.js')]]);
});
