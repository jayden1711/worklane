// #784 round 8 (the round-7 final check, issuecomment-6311918939, and the round-7 adversarial review,
// issuecomment-6311955569). The default branch is fetched from a real remote for each decision: a stale ref or cached tip
// never decides, a fetch a lock or a refspec stops holds at once (named, never an endless wait), and a measurement is used
// only from the base it measured. The changed code is measured by character against V8's block ranges, a removal at its
// own position. The static assertion count is linear and bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** A bare remote for `dir` with main at `tip`; the clone's ref and the coordinator's cached tip at `seen` (default: tip). */
function remote(dir: string, tip: string, seen = tip) {
  const bare = join(dir, '..', 'origin.git');
  git(join(dir, '..'), 'init', '-q', '--bare', bare);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '--force', 'origin', `${tip}:refs/heads/main`);
  git(dir, 'update-ref', 'refs/remotes/origin/main', seen);
  return seen;
}

/** The gate over a ready PR from `base` (its claim's) to `head` in `dir`, with a coordinator of its own. */
function gate(dir: string, base: string, head: string, seen: string, o: { contract?: string[] } = {}) {
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  if (o.contract) log.append('contract.agreed', { issue: 7, done_when: o.contract.map((t) => ({ test: t })), by: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  (c as unknown as { defaultTip: string }).defaultTip = seen;
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return { c, w, p, log, dir, head };
}

async function decided(t: ReturnType<typeof gate>) {
  const first = t.c.mergeDecisionFor(7, 9, t.p);
  if (first.vacuityRun) await t.c.vacuityRun(t.w, t.p, first.vacuityRun);
  return { first, d: t.c.mergeDecisionFor(7, 9, t.p) };
}

/** A PR over the example project with a real remote at its base: `before` on the base, `after` at the head. */
async function prDecided(before: Record<string, string | null>, after: Record<string, string | null>) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  const head = commit(dir, after);
  remote(dir, base);
  return decided(gate(dir, base, head, base));
}

const ranNone = (tests: string, app: string) => `design: vacuity: its tests (${tests}) ran none of the app code it changes (${app})`;
const UNFETCHED = "design: vacuity: the default branch couldn't be fetched from the remote for this decision, so the PR's own change can't be told from the default branch's";
const H = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const CART = 'export function cartTotal(items) {\n  return items.length;\n}\n';
const UTIL = 'export function double(x) {\n  return x * 2;\n}\n';
const callsUtil = `${H}import { double } from '../src/util.js';\ntest('double', () => { assert.equal(double(2), 4); });\n`;
const importsCart = `${H}import '../src/cart.js';\ntest('loads', () => { assert.ok(true); });\n`;

/** Base B; main gains a tested util.js change (M); the PR, claimed at B, is rebased onto M with its own cart.js change. */
function rebased() {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', 'src/cart.js': CART, 'src/util.js': UTIL });
  const main = commit(dir, { 'src/util.js': UTIL.replace('x * 2', 'x + x'), 'test/util.test.js': callsUtil });
  git(dir, 'checkout', '-q', '-b', 'pr');
  const head = commit(dir, { 'src/cart.js': CART.replace('items.length', 'items.length * 1'), 'test/cart.test.js': importsCart });
  return { dir, base, main, head };
}

// ---- the default branch, fetched for the decision

test('A1, must hold: the cached tip and the clone\'s ref both say an older main, the remote a newer one: measured from the remote\'s', async () => {
  const r = rebased();
  const { d } = await decided(gate(r.dir, r.base, r.head, remote(r.dir, r.main, r.base)));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/cart.test.js', 'src/cart.js')]]);
});

test('A1, must hold: a lock file stops the fetch of a newer main: it holds, named, at once (never a silent wait)', async () => {
  const r = rebased();
  const seen = remote(r.dir, r.main, r.base);
  writeFileSync(join(r.dir, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');
  const t = gate(r.dir, r.base, r.head, seen);
  const { d, first } = await decided(t);
  assert.equal(first.vacuityRun, undefined);
  assert.equal(d.auto, false);
  assert.ok(d.reasons.includes(UNFETCHED), d.reasons.join(' | '));
});

test('A1, must hold: a clone whose configured refspec doesn\'t map the default branch: fetched by an explicit one', async () => {
  const r = rebased();
  const seen = remote(r.dir, r.main, r.base);
  git(r.dir, 'config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
  const { d } = await decided(gate(r.dir, r.base, r.head, seen));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/cart.test.js', 'src/cart.js')]]);
});

test('a measurement is used only from the base it measured: main gains the PR\'s first commit, and the rest is measured again', async () => {
  // cartTotal changes in the PR's first commit (X), cartTax in its second; the task's contract test calls cartTotal only.
  const cart = 'export function cartTotal(items) {\n  return items.length;\n}\nexport function cartTax(x) {\n  return x / 10;\n}\n';
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', 'src/cart.js': cart });
  git(dir, 'checkout', '-q', '-b', 'pr');
  const x = commit(dir, { 'src/cart.js': cart.replace('items.length', 'items.length * 1'), 'test/cart.test.js': `${H}import { cartTotal } from '../src/cart.js';\ntest('total', () => { assert.equal(cartTotal([1]), 1); });\n` });
  const head = commit(dir, { 'src/cart.js': cart.replace('items.length', 'items.length * 1').replace('x / 10', 'x / 5') });
  remote(dir, base);
  const t = gate(dir, base, head, base, { contract: ['test/cart.test.js'] });
  const at = await decided(t);
  assert.deepEqual([at.d.auto, at.d.reasons], [true, []], 'measured from the claim base: the test runs cartTotal, which the PR changes');
  // The PR's first commit lands on main: what is the PR's own now is only cartTax, which no test runs.
  git(dir, 'push', '-q', '--force', 'origin', `${x}:refs/heads/main`);
  const again = t.c.mergeDecisionFor(7, 9, t.p);
  assert.ok(again.vacuityRun, 'measured again, from the new base');
  await t.c.vacuityRun(t.w, t.p, again.vacuityRun);
  const d = t.c.mergeDecisionFor(7, 9, t.p);
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/cart.test.js', 'src/cart.js')]]);
});

// ---- by character, against V8's block ranges

const positive = (from: string, name: string, call: string, want: string) => `${H}import { ${name} } from '../${from}';\ntest('${name}', () => { assert.equal(${call}, ${want}); });\n`;

test('precision, must hold: a single-line `if` whose changed body never runs', async () => {
  const clamp = 'export function clamp(x) {\n  if (x < 0) return 0;\n  return x;\n}\n';
  const { d } = await prDecided({ 'src/clamp.js': clamp }, { 'src/clamp.js': clamp.replace('return 0;', 'return -1;'), 'test/clamp.test.js': positive('src/clamp.js', 'clamp', 'clamp(5)', '5') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/clamp.test.js', 'src/clamp.js')]]);
});

test('precision, must hold: the other arm of a ternary', async () => {
  const abs = 'export function abs(x) {\n  return x > 0 ? x : 0;\n}\n';
  const { d } = await prDecided({ 'src/abs.js': abs }, { 'src/abs.js': abs.replace(': 0;', ': -x;'), 'test/abs.test.js': positive('src/abs.js', 'abs', 'abs(5)', '5') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/abs.test.js', 'src/abs.js')]]);
});

test('precision, must hold: a `??` right side on a line of its own', async () => {
  const port = 'export function port(opts) {\n  return (\n    opts.port\n    ?? 8080\n  );\n}\n';
  const { d } = await prDecided({ 'src/port.js': port }, { 'src/port.js': port.replace('8080', '9090'), 'test/port.test.js': positive('src/port.js', 'port', 'port({ port: 1 })', '1') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/port.test.js', 'src/port.js')]]);
});

test('precision, must hold: a `||` default on a line of its own', async () => {
  const opts = "export function opts(o) {\n  return {\n    name: o.name\n      || 'anon',\n  };\n}\n";
  const { d } = await prDecided({ 'src/opts.js': opts }, { 'src/opts.js': opts.replace("'anon'", "'nobody'"), 'test/opts.test.js': positive('src/opts.js', 'opts', "opts({ name: 'x' }).name", "'x'") });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/opts.test.js', 'src/opts.js')]]);
});

test('precision, must hold: a removed security check right after a block that ran, the code in its place never running', async () => {
  const access = "export function access(user, cache) {\n  if (cache.has(user.id)) {\n    return cache.get(user.id);\n  }\n  if (!user.allowed) throw new Error('denied');\n  return 'computed';\n}\n";
  const cached = `${H}import { access } from '../src/access.js';\ntest('cached', () => { assert.equal(access({ id: 1 }, new Map([[1, 'c']])), 'c'); });\n`;
  const { d } = await prDecided({ 'src/access.js': access }, { 'src/access.js': access.replace("  if (!user.allowed) throw new Error('denied');\n", ''), 'test/access.test.js': cached });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/access.test.js', 'src/access.js')]]);
});

test('precision, must hold: the same security check commented out instead of removed', async () => {
  const access = "export function access(user, cache) {\n  if (cache.has(user.id)) {\n    return cache.get(user.id);\n  }\n  if (!user.allowed) throw new Error('denied');\n  return 'computed';\n}\n";
  const cached = `${H}import { access } from '../src/access.js';\ntest('cached', () => { assert.equal(access({ id: 1 }, new Map([[1, 'c']])), 'c'); });\n`;
  const { d } = await prDecided({ 'src/access.js': access }, { 'src/access.js': access.replace("  if (!user.allowed)", '  // if (!user.allowed)'), 'test/access.test.js': cached });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/access.test.js', 'src/access.js')]]);
});

test('precision, control: the same removal, a test that reaches the code in its place merges', async () => {
  const access = "export function access(user, cache) {\n  if (cache.has(user.id)) {\n    return cache.get(user.id);\n  }\n  if (!user.allowed) throw new Error('denied');\n  return 'computed';\n}\n";
  const computes = `${H}import { access } from '../src/access.js';\ntest('computed', () => { assert.equal(access({ id: 2 }, new Map()), 'computed'); });\n`;
  const { d } = await prDecided({ 'src/access.js': access }, { 'src/access.js': access.replace("  if (!user.allowed) throw new Error('denied');\n", ''), 'test/access.test.js': computes });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('precision, control: the changed body of a single-line `if` that runs merges', async () => {
  const clamp = 'export function clamp(x) {\n  if (x < 0) return 0;\n  return x;\n}\n';
  const { d } = await prDecided({ 'src/clamp.js': clamp }, { 'src/clamp.js': clamp.replace('return 0;', 'return -1;'), 'test/clamp.test.js': positive('src/clamp.js', 'clamp', 'clamp(-5)', '-1') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('precision, must hold: a comment added at the end of a line that runs is no code change', async () => {
  const f = 'export function f(x) {\n  return x + 1;\n}\n';
  const { d } = await prDecided({ 'src/f.js': f }, { 'src/f.js': f.replace('x + 1;', 'x + 1; // one more'), 'test/f.test.js': positive('src/f.js', 'f', 'f(1)', '2') });
  assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: its coverage run failed: nothing to measure: its changes to app code are only blank lines, whitespace, comments or renames, so no changed line holds code a test can run']]);
});

// Named limits, not fixed: what V8's coverage can't tell apart.

test('residual (todo): a line after a call that threw counts as run, since V8 counts a block once it is entered', { todo: 'V8 block coverage has no range for the code after a throwing call; named in "What this can never do"' }, async () => {
  const total = "export function validate(items) {\n  if (!Array.isArray(items)) throw new TypeError('items must be an array');\n}\n\nexport function total(items) {\n  validate(items);\n  return items.length * 2;\n}\n";
  const throws = `${H}import { total } from '../src/total.js';\ntest('rejects', () => { assert.throws(() => total(null), TypeError); });\n`;
  const { d } = await prDecided({ 'src/total.js': total }, { 'src/total.js': total.replace('items.length * 2', 'items.length * 3'), 'test/total.test.js': throws });
  assert.equal(d.auto, false);
});

test('residual (todo): an async_hooks listener a module starts as it loads runs the changed callback on the tests\' own activity', { todo: 'what loading starts and the tests then trigger counts; named in "What this can never do"' }, async () => {
  const trace = "import { createHook } from 'node:async_hooks';\nexport const seen = {};\nexport function onInit(type) {\n  seen[type] = (seen[type] ?? 0) + 1;\n}\ncreateHook({ init: (id, type) => onInit(type) }).enable();\n";
  const loads = `${H}import '../src/trace.js';\ntest('loads', () => { assert.ok(true); });\n`;
  const { d } = await prDecided({ 'src/trace.js': trace }, { 'src/trace.js': trace.replace('+ 1;', '+ 2;'), 'test/trace.test.js': loads });
  assert.equal(d.auto, false);
});

// ---- the static assertion count: linear, bounded

test('the assertion count is linear: 512 KiB of crafted text takes well under a second, on the coordinator\'s thread', () => {
  const kb = 512 * 1024;
  for (const text of ['assert(1);\n' + 'import\n'.repeat(Math.floor(kb / 7)), 'assert(1);\n' + 'const a=require\n'.repeat(Math.floor(kb / 16)), `${H}// ${'/* '.repeat(Math.floor(kb / 3))}\n`, 'assert(1);\n' + '/*\n'.repeat(Math.floor(kb / 3))]) {
    const t0 = performance.now();
    vacuity.countAssertionCalls(text, '\\b(assert|expect)\\b');
    const ms = performance.now() - t0;
    assert.ok(ms < 1_000, `${Math.round(ms)} ms`);
  }
});

test('the assertion count still drops a multi-line import of an assertion module, and keeps a call after an import on its line', () => {
  const count = (t: string) => vacuity.countAssertionCalls(t, '\\b(assert|expect)\\b');
  assert.equal(count("import {\n  strict as assert,\n} from 'node:assert';\ntest('x', () => {});\n"), 0);
  assert.equal(count("import assert from 'node:assert'; assert.ok(1);\n"), 1);
  assert.equal(count("const assert = require('node:assert');\nassert.ok(1);\n"), 1);
});

test('a test file over the size the gate reads for assertions holds the PR', () => {
  const cfg = { test_globs: ['test/**/*.test.js'], assertion_pattern: '\\b(assert|expect)\\b', app_paths: ['src/**'], dynamic: true };
  const big = `assert.ok(1);\n${'x'.repeat(1024 * 1024)}\n`;
  const files: Record<string, string> = { 'src/a.js': 'export const a = 1;\n', 'test/a.test.js': big };
  const v = policy.vacuityCheck({ cfg, runOne: 'node --test {file}', changed: Object.keys(files), atHead: (p) => files[p] ?? null, runs: { started: 0, last: null } });
  assert.equal(v.run, undefined);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0]!, /^design: vacuity: a test file is over \d+ characters, more than the gate reads for its assertions \(test\/a\.test\.js\)$/);
});
