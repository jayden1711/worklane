// #784 round 6 (the round-5 final check, issuecomment-6309816221): a merge the gate can't place on the default branch
// holds (A1 with a fetch that is behind); runner.one takes only the test runner's own options, and the coverage run
// gets no NODE_OPTIONS of the engine's; what loading a changed module runs counts for nothing even when a test's body
// imports it (B2: a load-only baseline per script); the lexer reads `/` both ways; a run that writes no coverage holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { knownTip } from './vacuity-tip.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

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
  knownTip(c, dir, base);
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return { c, w, p, log, dir, head };
}

function pr(before: Record<string, string | null>, after: Record<string, string | null>, tune?: (c: ReturnType<typeof loadConfig>) => void) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  return gate(dir, base, commit(dir, after), tune);
}

async function decided(t: ReturnType<typeof gate>) {
  const first = t.c.mergeDecisionFor(7, 9, t.p);
  if (first.vacuityRun) await t.c.vacuityRun(t.w, t.p, first.vacuityRun);
  return { first, d: t.c.mergeDecisionFor(7, 9, t.p) };
}

const ranNone = (tests: string, app: string) => `design: vacuity: its tests (${tests}) ran none of the app code it changes (${app})`;
const FOREIGN = "design: vacuity: a merge in it brings in commits the default branch here doesn't have (a fetch of that branch that is behind, or another branch), so its own change can't be told from what it merged in";
const RUNNER = "design: vacuity: tests.yaml runner.one is not `node --test [options] {file}` with only the test runner's own options, the one form whose coverage the merge gate can measure";
const head = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const callsTest = (from: string, name: string, call: string, want: string) => `${head}import { ${name} } from '../${from}';\ntest('${name}', () => { assert.equal(${call}, ${want}); });\n`;

// ---- A1 with a fetch of the default branch that is behind what the PR merged

const CART = 'export function cartTotal(items) {\n  return items.length;\n}\n';
const UTIL = 'export function double(x) {\n  return x * 2;\n}\n';

/** Base B; main gains a tested util.js change; the PR changes cart.js with an import-only test and merges main in. */
function mergedMain(ref: 'base' | 'none') {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', 'src/cart.js': CART, 'src/util.js': UTIL });
  if (ref === 'base') git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  git(dir, 'checkout', '-q', '-b', 'pr');
  commit(dir, { 'src/cart.js': CART.replace('items.length', 'items.length * 1'), 'test/cart.test.js': `${head}import '../src/cart.js';\ntest('loads', () => { assert.ok(true); });\n` });
  git(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/util.js': UTIL.replace('x * 2', 'x + x'), 'test/util.test.js': callsTest('src/util.js', 'double', 'double(2)', '4') });
  git(dir, 'checkout', '-q', 'pr');
  git(dir, 'merge', '-q', '--no-edit', '--no-ff', 'main');
  return gate(dir, base, git(dir, 'rev-parse', 'HEAD'));
}

test('A1, must hold: the clone\'s fetch of main is still at the claim base, behind the main the PR merged in', async () => {
  const { d, first } = await decided(mergedMain('base'));
  assert.equal(first.vacuityRun, undefined, 'no run asked for');
  assert.deepEqual([d.auto, d.reasons], [false, [FOREIGN]]);
});

test('A1, must hold: the remote can\'t be fetched, and the PR has a merge', async () => {
  // #784 rounds 7, 8: the tip is the remote's, fetched for the decision, never the clone's ref; here the fetch fails.
  const t = mergedMain('none');
  execFileSync('git', ['remote', 'set-url', 'origin', join(t.dir, '..', 'no-such-remote.git')], { cwd: t.dir });
  const { d } = await decided(t);
  // The weakening check (#869) holds on the same failed fetch, beside it.
  assert.equal(d.auto, false);
  assert.ok(d.reasons.includes("design: vacuity: the default branch couldn't be fetched from the remote for this decision, so the PR's own change can't be told from the default branch's"), d.reasons.join(' | '));
});

// ---- runner.one: the test runner's own options only

// check-table: never-shrink
const REFUSED = [
  'node --test --env-file=.env {file}',
  'node --test --env-file-if-exists=.env {file}',
  'node --test --experimental-config-file=node.config.json {file}',
  'node --test --experimental-default-config-file {file}',
  'node --test --experimental-transform-types {file}',
  'node --test -e {file}',
  'node --test --eval=x {file}',
  'node --test --test-reporter=./r.mjs {file}',
  'node --test --test-reporter=no-such-reporter {file}',
  'node --test --conditions=dev {file}',
  'node --test --experimental-test-module-mocks {file}',
  'node --test --import=tsx {file}',
  'node --test -r=x {file}',
];
const ACCEPTED = [
  'node --test {file}',
  'node --test --test-reporter=spec {file}',
  'node --test --test-reporter=dot --test-reporter-destination=stdout {file}',
  'node --test --test-timeout=60000 --test-concurrency=1 {file}',
  'node --test --test-name-pattern=price --test-skip-pattern=slow {file}',
  'node --test --test-isolation=none {file}',
  'node --test --test-shard=1/2 --test-force-exit --test-only {file}',
  'node --test --experimental-strip-types --no-warnings {file}',
];

test('runner.one forms: Node options that load code first or change the text are refused; the gate holds before any run, and doctor warns', () => {
  const cfg = { test_globs: ['test/**/*.test.js'], assertion_pattern: '\\b(assert|expect)\\b', app_paths: ['src/**'], dynamic: true };
  const files: Record<string, string> = { 'src/a.js': 'export const a = 1;\n', 'test/a.test.js': "import assert from 'node:assert';\nassert.ok(1);\n" };
  for (const one of REFUSED) {
    assert.equal(policy.coverageRunnerOne(one), false, one);
    const v = policy.vacuityCheck({ cfg, runOne: one, changed: Object.keys(files), atHead: (p) => files[p] ?? null, runs: { started: 0, last: null } });
    assert.deepEqual([v.reasons, v.run], [[RUNNER], undefined], one);
    assert.equal(policy.vacuityDoctor({ vacuity: cfg, runner: { one } }).level, 'warn', one);
  }
  for (const one of ACCEPTED) assert.equal(policy.coverageRunnerOne(one), true, one);
});

test('runner.one with --env-file: a NODE_OPTIONS preload in the PR\'s env file never runs, the PR holds', async () => {
  const t = pr({ 'src/cart.js': CART, 'vars.conf': 'X=1\n' }, { 'src/cart.js': CART.replace('items.length', 'items.length * 1'), 'vars.conf': 'NODE_OPTIONS=--import=./pre.mjs\n', 'pre.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./preload-ran.txt', import.meta.url), 'yes');\n", 'test/cart.test.js': callsTest('src/cart.js', 'cartTotal', 'cartTotal([1])', '1') }, (c) => void (c.tests.runner.one = 'node --test --env-file=vars.conf {file}'));
  const { d, first } = await decided(t);
  assert.equal(first.vacuityRun, undefined);
  assert.deepEqual([d.auto, d.reasons], [false, [RUNNER]]);
});

test('the coverage run gets no NODE_OPTIONS from the engine\'s own environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-options-'));
  const marker = join(dir, 'preload-ran.txt');
  const pre = join(dir, 'pre.mjs');
  // A preload that marks only a coverage run (the gate's reader process has no NODE_V8_COVERAGE).
  writeFileSync(pre, `import { writeFileSync } from 'node:fs';\nif (process.env.NODE_V8_COVERAGE) writeFileSync(${JSON.stringify(marker)}, 'yes');\n`);
  const t = pr({ 'src/cart.js': CART }, { 'src/cart.js': CART.replace('items.length', 'items.length * 1'), 'test/cart.test.js': callsTest('src/cart.js', 'cartTotal', 'cartTotal([1])', '1') });
  const first = t.c.mergeDecisionFor(7, 9, t.p);
  assert.ok(first.vacuityRun);
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${pre}`;
  try {
    await t.c.vacuityRun(t.w, t.p, first.vacuityRun);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
  assert.equal(existsSync(marker), false, 'the preload ran in the coverage run');
  assert.deepEqual(t.c.mergeDecisionFor(7, 9, t.p).reasons, []);
});

// ---- B2: a module imported inside a test's body

const TABLE = 'export function buildTable(n) {\n  return Array.from({ length: n }, (_, i) => i * 2);\n}\nexport const TABLE = buildTable(4);\n\nexport function price(x) {\n  return x * 3;\n}\n';

test('B2, must hold: the PR adds a module, and its only test imports it inside the test\'s body', async () => {
  const body = `${head}test('loads', async () => {\n  const m = await import('../src/table.js');\n  assert.ok(m.TABLE.length);\n});\n`;
  const { d } = await decided(pr({}, { 'src/table.js': TABLE, 'test/table.test.js': body }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/table.test.js', 'src/table.js')]]);
});

test('B2, control: imported inside the test\'s body, then called: merges', async () => {
  const body = `${head}test('price', async () => {\n  const m = await import('../src/table.js');\n  assert.equal(m.price(2), 6);\n});\n`;
  const { d } = await decided(pr({}, { 'src/table.js': TABLE, 'test/table.test.js': body }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('B2, control: a test that calls the helper the module also calls as it loads merges (the most of the baselines, not their sum)', async () => {
  const { d } = await decided(pr({}, { 'src/table.js': TABLE, 'test/table.test.js': callsTest('src/table.js', 'buildTable', 'buildTable(2).length', '2') }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('B1 (a named limit, not fixed): a timer the module starts as it loads runs the changed callback while a test waits', { todo: 'the baseline run ends at once, so the timer never fires there; documented in the PR and quickstart' }, async () => {
  const sweep = 'let n = 0;\nexport function sweep() {\n  n += 1;\n}\nsetInterval(() => sweep(), 5).unref();\nexport function other() {\n  return 2;\n}\n';
  const waits = `${head}import { other } from '../src/sweep.js';\ntest('other', async () => {\n  await new Promise((r) => setTimeout(r, 200));\n  assert.equal(other(), 2);\n});\n`;
  const { d } = await decided(pr({ 'src/sweep.js': sweep }, { 'src/sweep.js': sweep.replace('n += 1', 'n += 2'), 'test/sweep.test.js': waits }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/sweep.test.js', 'src/sweep.js')]]);
});

// ---- the lexer: a `/` that one reading takes for division

test('codeLines: a regular expression holding a backtick after `)` never turns later comments into code', () => {
  const text = 'function u(s) {\n  if (s) /`/.test(s);\n}\nfunction t() {\n  // a comment\n  return 1;\n}\n';
  const { code } = vacuity.codeLines(text);
  assert.equal(code[4], false, 'the comment line');
  assert.equal(code[5], true, 'the code after it');
  assert.equal(vacuity.codeLines('const q = a / b; // c\n/* d */\nx();').code.join(), 'true,false,true', 'division still reads as division');
});

test('codeLines end to end: a comment added below such a regular expression is nothing to measure', async () => {
  const before = 'export function u(s) {\n  if (s) /`/.test(s);\n  return 1;\n}\nexport function t() {\n  return 1;\n}\n';
  const { d } = await decided(pr({ 'src/lex.js': before }, { 'src/lex.js': before.replace('export function t() {\n', 'export function t() {\n  // a note\n'), 'test/lex.test.js': callsTest('src/lex.js', 't', 't()', '1') }));
  assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: its coverage run failed: nothing to measure: its changes to app code are only blank lines, whitespace, comments or renames, so no changed line holds code a test can run']]);
});

// ---- a run that writes no coverage

test('gate: fail closed: a coverage run that writes no coverage holds the PR', async () => {
  const t = pr({ 'src/cart.js': CART }, { 'src/cart.js': CART.replace('items.length', 'items.length * 1'), 'test/cart.test.js': callsTest('src/cart.js', 'cartTotal', 'cartTotal([1])', '1') });
  // Every project command "passes" and runs nothing, so no coverage is written.
  (t.c as unknown as { project: () => Promise<{ code: number; tail: string; out: string }> }).project = async () => ({ code: 0, tail: '', out: '' });
  const { d } = await decided(t);
  assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: its coverage run failed: no coverage was written (runner.one must run the tests in Node for a coverage run)']]);
});
