// #784 round 5 (the third review and the round-4 final check): what the merge gate measures a PR's tests against.
// A1: the PR's change is measured from where it meets the default branch's tip, never from its claim base, so a merge
// of the default branch (a conflict fix's) never makes that branch's own tested change the PR's. A3/A6/A7: a blank,
// whitespace-only or comment line is no change to measure, and a PR with nothing else waits. A4: a renamed file's lines
// are the ones its rename changed. A8: hunks are never joined across unchanged lines, whatever the config says. Attack
// 2 on a file the PR adds: code that runs as the test file and its imports load counts for nothing (the baseline run).
// Node's own type stripping is measured. runner.one is node --test only. A shutdown stops the setup and the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import * as policy from '../src/merge-policy-vacuity.js';
import { FakeRunner } from '../src/runner.js';
import * as vacuity from '../src/vacuity.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void>; stop(): void };

/** Write `files` (null: delete) and commit them; the new commit. */
function commit(dir: string, files: Record<string, string | null>) {
  for (const [p, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, p));
    else {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'step');
  return git(dir, 'rev-parse', 'HEAD');
}

/** The gate over a ready PR from `base` (its claim's) to `head` in `dir`, with a coordinator of its own. */
function gate(dir: string, base: string, head: string, tune: (c: ReturnType<typeof loadConfig>) => void = () => {}) {
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  tune(cfg);
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return { c, w, p, log, dir, head };
}

/** A PR over the example project: `before` on its base, `after` at its head. */
function pr(before: Record<string, string | null>, after: Record<string, string | null>, tune?: (c: ReturnType<typeof loadConfig>) => void) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  return gate(dir, base, commit(dir, after), tune);
}

/** The decision after the coverage run it asks for. */
async function decided(t: ReturnType<typeof gate>) {
  const first = t.c.mergeDecisionFor(7, 9, t.p);
  if (first.vacuityRun) await t.c.vacuityRun(t.w, t.p, first.vacuityRun);
  return { first, d: t.c.mergeDecisionFor(7, 9, t.p) };
}

const ranNone = (tests: string, app: string) => `design: vacuity: its tests (${tests}) ran none of the app code it changes (${app})`;
const NOTHING = 'design: vacuity: its coverage run failed: nothing to measure: its changes to app code are only blank lines, whitespace, comments or renames, so no changed line holds code a test can run';
const head = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const callsTest = (from: string, name: string, call: string, want: string) => `${head}import { ${name} } from '../${from}';\ntest('${name}', () => { assert.equal(${call}, ${want}); });\n`;
const importsTest = (from: string) => `${head}import '../${from}';\ntest('loads', () => { assert.ok(true); });\n`;

// ---- A1: a PR that merged the default branch in

const CART = 'export function cartTotal(items) {\n  return items.length;\n}\n';
const UTIL = 'export function double(x) {\n  return x * 2;\n}\n';

/** Base B; the PR changes cart.js with `cartTest`; main then changes util.js with a test that calls it; the PR merges main in. */
function mergedMain(cartTest: string) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', 'src/cart.js': CART, 'src/util.js': UTIL });
  git(dir, 'checkout', '-q', '-b', 'pr');
  commit(dir, { 'src/cart.js': CART.replace('items.length', 'items.length * 1'), 'test/cart.test.js': cartTest });
  git(dir, 'checkout', '-q', 'main');
  const tip = commit(dir, { 'src/util.js': UTIL.replace('x * 2', 'x + x'), 'test/util.test.js': callsTest('src/util.js', 'double', 'double(2)', '4') });
  git(dir, 'update-ref', 'refs/remotes/origin/main', tip);
  git(dir, 'checkout', '-q', 'pr');
  // What the harness's own conflict fix makes (fix-runs.ts): a merge commit of the PR's head and the default branch.
  git(dir, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'merge', '-q', '--no-edit', '--no-ff', 'main');
  return gate(dir, base, git(dir, 'rev-parse', 'HEAD'));
}

test('A1, must hold: a PR that merged main in is measured from main\'s tip: main\'s own tested change is not the PR\'s', async () => {
  const { d } = await decided(mergedMain(importsTest('src/cart.js')));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/cart.test.js', 'src/cart.js')]]);
});

test('A1, control: the same merge, with a PR test that calls the code it changes, merges', async () => {
  const { d } = await decided(mergedMain(callsTest('src/cart.js', 'cartTotal', 'cartTotal([1, 2])', '2')));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- A3/A6/A7: blank, whitespace-only and comment lines

const CALC = 'export function add(a, b) {\n  /*\n   * Adds.\n   */\n  // plain sum\n  const s = a + b;\n  return s;\n}\nexport function sub(a, b) {\n  return a - b;\n}\n';
const ADD_TEST = callsTest('src/calc.js', 'add', 'add(1, 2)', '3');

const ONLY: Record<string, string> = {
  'a line comment inside a function the test runs': CALC.replace('  const s', '  // still a plain sum\n  const s'),
  'a line inside a block comment, with no comment mark of its own': CALC.replace('   * Adds.\n', '   * Adds.\n     and more words here\n'),
  'blank lines inside a function the test runs': CALC.replace('  const s', '\n\n  const s'),
  'a whitespace-only re-indent of the body': CALC.replace('  const s = a + b;\n  return s;', '      const s = a  +  b;\n\treturn s;'),
  'a deleted comment line': CALC.replace('  // plain sum\n', ''),
  'a deleted block comment': CALC.replace('  /*\n   * Adds.\n   */\n', ''),
};

for (const [shape, after] of Object.entries(ONLY)) {
  test(`A3/A6/A7, must hold: ${shape} is nothing to measure, so the PR waits (never a pass)`, async () => {
    const { d } = await decided(pr({ 'src/calc.js': CALC }, { 'src/calc.js': after, 'test/add.test.js': ADD_TEST }));
    assert.deepEqual([d.auto, d.reasons], [false, [NOTHING]]);
  });
}

test('A3, must hold across files: a comment in a function the test runs does not make another file\'s untested change count', async () => {
  const other = 'export function mul(a, b) {\n  return a * b;\n}\n';
  const { d } = await decided(pr({ 'src/calc.js': CALC, 'src/other.js': other }, { 'src/calc.js': ONLY['a line comment inside a function the test runs']!, 'src/other.js': other.replace('a * b', 'b * a'), 'test/add.test.js': ADD_TEST }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/add.test.js', 'src/calc.js, src/other.js')]]);
});

test('A3, must hold: a comment in a function the test runs, a code change in one it doesn\'t', async () => {
  const { d } = await decided(pr({ 'src/calc.js': CALC }, { 'src/calc.js': ONLY['a line comment inside a function the test runs']!.replace('a - b', 'b - a'), 'test/add.test.js': ADD_TEST }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/add.test.js', 'src/calc.js')]]);
});

test('A3, control: a code change with a comment, in a function the test runs, counts', async () => {
  const { d } = await decided(pr({ 'src/calc.js': CALC }, { 'src/calc.js': CALC.replace('  const s = a + b;', '  // now with zero\n  const s = a + b + 0;'), 'test/add.test.js': ADD_TEST }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('A3, control: a deleted line of code in a function the test runs counts (the code on either side of it ran)', async () => {
  const before = CALC.replace('  const s', '  const unused = 0;\n  const s');
  const { d } = await decided(pr({ 'src/calc.js': before }, { 'src/calc.js': CALC, 'test/add.test.js': ADD_TEST }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- A4: a rename

test('A4, must hold: a renamed file\'s lines are the ones its rename changed, not every line', async () => {
  const old = 'export function f(x) {\n  return x + 1;\n}\nexport function g(x) {\n  return x - 1;\n}\nexport const NAME = "calc";\n';
  const { d } = await decided(pr({ 'src/old.js': old }, { 'src/old.js': null, 'src/moved.js': old.replace('x - 1', 'x - 2'), 'test/m.test.js': callsTest('src/moved.js', 'f', 'f(1)', '2') }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/m.test.js', 'src/moved.js')]]);
});

test('A4, control: the same rename, the test calls the function it changed', async () => {
  const old = 'export function f(x) {\n  return x + 1;\n}\nexport function g(x) {\n  return x - 1;\n}\nexport const NAME = "calc";\n';
  const { d } = await decided(pr({ 'src/old.js': old }, { 'src/old.js': null, 'src/moved.js': old.replace('x - 1', 'x - 2'), 'test/m.test.js': callsTest('src/moved.js', 'g', 'g(3)', '1') }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('A4: a pure rename of app code is nothing to measure', async () => {
  const old = 'export function f(x) {\n  return x + 1;\n}\n';
  const { d } = await decided(pr({ 'src/old.js': old }, { 'src/old.js': null, 'src/moved.js': old, 'test/m.test.js': callsTest('src/moved.js', 'f', 'f(1)', '2') }));
  assert.deepEqual([d.auto, d.reasons], [false, [NOTHING]]);
});

// ---- A8: hunks joined by the config

test('A8, must hold: diff.interHunkContext in the repo config never joins two changes around a line the test runs', async () => {
  const three = 'export function a(x) {\n  return x + 1;\n}\nexport function b(x) {\n  return x + 2;\n}\nexport function c(x) {\n  return x + 3;\n}\n';
  const dir = exampleProject().dir;
  git(dir, 'config', 'diff.interHunkContext', '1000');
  const base = commit(dir, { 'dist/.keep': '', 'src/three.js': three });
  const h = commit(dir, { 'src/three.js': three.replace('x + 1', 'x + 10').replace('x + 3', 'x + 30'), 'test/b.test.js': callsTest('src/three.js', 'b', 'b(1)', '3') });
  const { d } = await decided(gate(dir, base, h));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/b.test.js', 'src/three.js')]]);
});

// ---- attack 2 on a file the PR adds: what loading runs counts for nothing

const ADDED: Record<string, [string, string]> = {
  'a helper called as the module loads': ['src/table.js', 'function buildTable(n) {\n  return Array.from({ length: n }, (_, i) => i * 2);\n}\nexport const TABLE = buildTable(4);\n\nexport function price(x) {\n  return x * 3;\n}\n'],
  "tsc's __decorate": ['src/service.cjs', '"use strict";\nvar __decorate = (this && this.__decorate) || function (decorators, target) {\n  return decorators.reduceRight((t, d) => d(t) || t, target);\n};\nlet Service = class Service {\n  run() {\n    return 2;\n  }\n};\nService = __decorate([(t) => t], Service);\nexports.Service = Service;\n'],
  "esbuild's keepNames __name": ['src/discount.js', "var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, 'name', { value, configurable: true });\nexport function discount(x) {\n  return x - 2;\n}\n__name(discount, 'discount');\n"],
};
const loads = (p: string) => `${head}import { createRequire } from 'node:module';\n${p.endsWith('.cjs') ? `createRequire(import.meta.url)('../${p}');` : `import '../${p}';`}\ntest('loads', () => { assert.ok(true); });\n`;

for (const [shape, [file, text]] of Object.entries(ADDED)) {
  test(`attack 2 on an added file, must hold: ${shape}: a test that only imports it runs none of its code`, async () => {
    const { d, first } = await decided(pr({}, { [file]: text, 'test/imports.test.js': loads(file) }));
    assert.ok(first.vacuityRun, 'measured');
    assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/imports.test.js', file)]]);
  });
}

test('attack 2 on an added file, must hold: a helper the test file calls at its own top level, outside any test', async () => {
  const [file, text] = ADDED['a helper called as the module loads']!;
  const top = `${head}import { price } from '../${file}';\nconst p = price(2);\ntest('loads', () => { assert.ok(p > 0); });\n`;
  const { d } = await decided(pr({}, { [file]: text, 'test/top.test.js': top }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/top.test.js', file)]]);
});

test('attack 2 on an added file, control: a test that calls its function merges', async () => {
  const [file, text] = ADDED['a helper called as the module loads']!;
  const { d } = await decided(pr({}, { [file]: text, 'test/calls.test.js': callsTest(file, 'price', 'price(2)', '6') }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- Node's own type stripping (the final check: it counted for nothing)

test('a TypeScript app file run under Node\'s own type stripping is measured: a test that calls it merges', async () => {
  const rate = 'export function rate(x: number): number {\n  const k: number = 3;\n  return x * k;\n}\n';
  const { d } = await decided(pr({}, { 'src/rate.ts': rate, 'test/rate.test.js': callsTest('src/rate.ts', 'rate', 'rate(2)', '6') }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('a TypeScript app file under type stripping, must hold: a test that only imports it', async () => {
  const rate = 'export function rate(x: number): number {\n  return x * 3;\n}\nexport const R: number = rate(1);\n';
  const { d } = await decided(pr({}, { 'src/rate.ts': rate, 'test/rate.test.js': importsTest('src/rate.ts') }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/rate.test.js', 'src/rate.ts')]]);
});

// ---- runner.one: node --test only (the final check: a transform counts for nothing, yet doctor said ok)

test('runner.one: tsx, vitest, jest and preload options are not measured: the gate holds before any run, and doctor warns', () => {
  const coverageRunnerOne = (policy as unknown as { coverageRunnerOne(o: string): boolean }).coverageRunnerOne;
  const cfg = { test_globs: ['test/**/*.test.js'], assertion_pattern: '\\b(assert|expect)\\b', app_paths: ['src/**'], dynamic: true };
  const files: Record<string, string> = { 'src/a.js': 'export const a = 1;\n', 'test/a.test.js': "import assert from 'node:assert';\nassert.ok(1);\n" };
  for (const one of ['npx vitest run {file}', 'npx jest {file}', 'npx tsx --test {file}', 'pnpm exec vitest run {file}', 'node --test --import=tsx {file}', 'node --test -r ts-node/register {file}']) {
    assert.equal(coverageRunnerOne(one), false, one);
    const v = policy.vacuityCheck({ cfg, runOne: one, changed: Object.keys(files), atHead: (p) => files[p] ?? null, runs: { started: 0, last: null } });
    assert.equal(v.run, undefined, one);
    assert.equal(v.reasons.length, 1, one);
    assert.match(v.reasons[0]!, /runner\.one is not `node --test \[options\] \{file\}`/, one);
    assert.equal(policy.vacuityDoctor({ vacuity: cfg, runner: { one } }).level, 'warn', one);
  }
  assert.equal(coverageRunnerOne('node --test --test-reporter=spec {file}'), true);
});

// ---- the lexer the changed lines go through

test('codeLines: comments, strings, templates and regular expressions', () => {
  const codeLines = (vacuity as unknown as { codeLines?: (t: string) => { code: boolean[]; inComment: boolean[] } }).codeLines;
  assert.equal(typeof codeLines, 'function');
  const rows = (t: string) => codeLines!(t).code;
  assert.deepEqual(rows('a();\n// x\n\n  /* y\n z */\nb();'), [true, false, false, false, false, true]);
  assert.deepEqual(rows("const s = '// not a comment';\n/* c */ x();"), [true, true]);
  assert.deepEqual(rows('const r = /\\/*x/;\n// c'), [true, false], 'a regular expression holding /* starts no comment');
  assert.deepEqual(rows('const q = a / b; // c\n/* d */'), [true, false], 'division');
  assert.deepEqual(rows('const t = `a\n\n${x /* in */}\n// in the template\n`;'), [true, true, true, true, true], 'a template\'s lines are its text');
  assert.deepEqual(rows('#!/usr/bin/env node\nrun();'), [false, true]);
  assert.deepEqual(codeLines!('/*\n a\n*/ b();').inComment, [true, true, false]);
});

// ---- a shutdown stops the setup steps and the coverage read

test('shutdown: the scratch worktree\'s setup is stopped, and nothing is recorded', async () => {
  const t = pr({}, { 'src/p.js': 'export function p(x) {\n  return x + 1;\n}\n', 'test/p.test.js': callsTest('src/p.js', 'p', 'p(1)', '2') }, (c) => void (c.tests.worktree.setup = ['sleep 20']));
  const first = t.c.mergeDecisionFor(7, 9, t.p);
  assert.ok(first.vacuityRun);
  const t0 = performance.now();
  const run = t.c.vacuityRun(t.w, t.p, first.vacuityRun);
  setTimeout(() => t.c.stop(), 500);
  await run;
  assert.ok(performance.now() - t0 < 10_000, `the run took ${Math.round(performance.now() - t0)} ms after the shutdown`);
  assert.equal(t.log.read(0, ['vacuity.measured']).length, 0);
});

test('shutdown: the coverage read process stops on the signal', async () => {
  const read = (vacuity as unknown as { readTouchedInChild: (r: object, ms: number, s?: AbortSignal) => Promise<{ error?: string }> }).readTouchedInChild;
  const cov = mkdtempSync(join(tmpdir(), 'stop-cov-'));
  const stop = new AbortController();
  stop.abort();
  const r = await read({ coverageDir: cov, baselineDir: cov, root: cov, appPaths: ['src/**'], only: [], hunks: {} }, 60_000, stop.signal);
  assert.equal(r.error, 'the coverage read was stopped (the coordinator is shutting down)');
});
