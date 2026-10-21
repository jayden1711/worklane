// #784 round 7 (the round-6 final check, issuecomment-6310491381): what loading runs is taken away as many times as
// the tests evaluated each module more than the test baseline did, and every such module is loaded on its own, not only
// the touched ones (B2 in four more shapes); the PR's change is measured from the tip the remote gave, never from the
// clone's writable ref (A1 with a rebase and a stale ref, and with the ref written to the head); the load-only runs
// share one time budget; a reporter destination stays in the worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The gate over a ready PR from `base` (its claim's) to `head` in `dir`, with a coordinator of its own. `tip`: the
 * default branch's tip as the remote gave it (the coordinator's ls-remote); the clone's origin/main is `ref`.
 */
function gate(dir: string, base: string, head: string, o: { tip?: string; ref?: string; tune?: (c: ReturnType<typeof loadConfig>) => void } = {}) {
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  o.tune?.(cfg);
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  git(dir, 'update-ref', 'refs/remotes/origin/main', o.ref ?? o.tip ?? base);
  (c as unknown as { defaultTip: string }).defaultTip = o.tip ?? base;
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return { c, w, p, log, dir, head };
}

function pr(before: Record<string, string | null>, after: Record<string, string | null>, tune?: (c: ReturnType<typeof loadConfig>) => void) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  return gate(dir, base, commit(dir, after), tune ? { tune } : {});
}

async function decided(t: ReturnType<typeof gate>) {
  const first = t.c.mergeDecisionFor(7, 9, t.p);
  if (first.vacuityRun) await t.c.vacuityRun(t.w, t.p, first.vacuityRun);
  return { first, d: t.c.mergeDecisionFor(7, 9, t.p) };
}

const ranNone = (tests: string, app: string) => `design: vacuity: its tests (${tests}) ran none of the app code it changes (${app})`;
const PENDING = 'design: vacuity: its tests have not yet been run under coverage at this head';
const H = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const TABLE = 'export function buildTable(n) {\n  return Array.from({ length: n }, (_, i) => i * 2);\n}\nexport const TABLE = buildTable(4);\n\nexport function price(x) {\n  return x * 3;\n}\n';
const bodyImport = (spec: string) => `${H}test('loads', async () => {\n  const m = await import('${spec}');\n  assert.ok(m.TABLE.length);\n});\n`;
const HELPER = 'export function build(n) {\n  return Array.from({ length: n }, (_, i) => i * 2);\n}\nexport function other() {\n  return 1;\n}\n';
const WRAP = "import { build } from './helper.js';\nexport const TABLE = build(4);\n";

// ---- B2: what loading runs, however many times and however indirectly a test's body loads it

test('B2, must hold: two test files, each importing the added module in its body', async () => {
  const { d } = await decided(pr({}, { 'src/table.js': TABLE, 'test/a.test.js': bodyImport('../src/table.js'), 'test/b.test.js': bodyImport('../src/table.js') }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/a.test.js, test/b.test.js', 'src/table.js')]]);
});

test('B2, must hold: a static import plus a cache-busting import in the body', async () => {
  const t = `${H}import { TABLE } from '../src/table.js';\ntest('fresh', async () => {\n  const m = await import('../src/table.js?fresh=1');\n  assert.deepEqual(m.TABLE, TABLE);\n});\n`;
  const { d } = await decided(pr({}, { 'src/table.js': TABLE, 'test/table.test.js': t }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/table.test.js', 'src/table.js')]]);
});

test('B2, must hold: two cache-busting imports in one body', async () => {
  const t = `${H}test('fresh', async () => {\n  const a = await import('../src/table.js?a');\n  const b = await import('../src/table.js?b');\n  assert.ok(a.TABLE.length && b.TABLE.length);\n});\n`;
  const { d } = await decided(pr({}, { 'src/table.js': TABLE, 'test/table.test.js': t }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/table.test.js', 'src/table.js')]]);
});

test('B2, must hold: the body imports an unchanged module whose loading calls the changed helper', async () => {
  const { d } = await decided(pr({ 'src/helper.js': HELPER, 'src/wrap.js': WRAP }, { 'src/helper.js': HELPER.replace('i * 2', 'i * 3'), 'test/wrap.test.js': bodyImport('../src/wrap.js') }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/wrap.test.js', 'src/helper.js')]]);
});

test('B2, must hold: the same, with the PR adding that module too', async () => {
  const { d } = await decided(pr({ 'src/helper.js': HELPER }, { 'src/helper.js': HELPER.replace('i * 2', 'i * 3'), 'src/wrap.js': WRAP, 'test/wrap.test.js': bodyImport('../src/wrap.js') }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/wrap.test.js', 'src/helper.js, src/wrap.js')]]);
});

test('B2, control: two test files that import in their bodies and call the changed function merge', async () => {
  const calls = `${H}test('price', async () => {\n  const m = await import('../src/table.js');\n  assert.equal(m.price(2), 6);\n});\n`;
  const { d } = await decided(pr({}, { 'src/table.js': TABLE, 'test/a.test.js': calls, 'test/b.test.js': calls }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('B2, control: a body import of the wrapper, then a call of the changed helper itself, merges', async () => {
  const calls = `${H}test('build', async () => {\n  await import('../src/wrap.js');\n  const h = await import('../src/helper.js');\n  assert.equal(h.build(2).length, 2);\n});\n`;
  const { d } = await decided(pr({ 'src/helper.js': HELPER, 'src/wrap.js': WRAP }, { 'src/helper.js': HELPER.replace('i * 2', 'i * 3'), 'test/wrap.test.js': calls }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- the load-only runs' one time budget

test('load budget: past one time budget for all the load-only runs, the PR waits with the reason named', async () => {
  const slow = 'await new Promise((r) => setTimeout(r, 3_000));\nexport function buildTable(n) {\n  return Array.from({ length: n }, (_, i) => i * 2);\n}\nexport const TABLE = buildTable(4);\n';
  const t = pr({}, { 'src/table.js': slow, 'test/table.test.js': bodyImport('../src/table.js') });
  (t.c as unknown as { vacuityLoadBudgetMs: number }).vacuityLoadBudgetMs = 1_000;
  const { d } = await decided(t);
  assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: its coverage run failed: the modules its tests import more often than loading the test files does took longer than 1 s in all to load on their own']]);
});

// ---- A1: the tip the remote gave, not the clone's ref

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

test('A1, must hold: rebased onto main while the clone\'s ref is still the claim base: it waits, never measured from the ref', async () => {
  const r = rebased();
  const t = gate(r.dir, r.base, r.head, { tip: r.main, ref: r.base });
  const { d, first } = await decided(t);
  assert.equal(first.vacuityRun, undefined, 'no run until the clone has the tip');
  assert.deepEqual([d.auto, d.reasons], [false, [PENDING]]);
});

test('A1, must hold: rebased onto main, the ref brought up to the tip: measured from main, the PR\'s own test runs none of its code', async () => {
  const r = rebased();
  const { d } = await decided(gate(r.dir, r.base, r.head, { tip: r.main }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/cart.test.js', 'src/cart.js')]]);
});

test('A1, must hold: the clone\'s ref written to the PR\'s head (#926): it waits', async () => {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', 'src/cart.js': CART, 'src/util.js': UTIL });
  git(dir, 'checkout', '-q', '-b', 'pr');
  commit(dir, { 'src/cart.js': CART.replace('items.length', 'items.length * 1'), 'test/cart.test.js': importsCart });
  git(dir, 'checkout', '-q', 'main');
  const main = commit(dir, { 'src/util.js': UTIL.replace('x * 2', 'x + x'), 'test/util.test.js': callsUtil });
  git(dir, 'checkout', '-q', 'pr');
  git(dir, 'merge', '-q', '--no-edit', '--no-ff', 'main');
  const head = git(dir, 'rev-parse', 'HEAD');
  const { d, first } = await decided(gate(dir, base, head, { tip: main, ref: head }));
  assert.equal(first.vacuityRun, undefined);
  assert.deepEqual([d.auto, d.reasons], [false, [PENDING]]);
});

test('A1, must hold: the tip the remote gave is not in the clone: it waits', async () => {
  const r = rebased();
  const missing = 'f'.repeat(40);
  const { d } = await decided(gate(r.dir, r.base, r.head, { tip: missing, ref: r.base }));
  assert.deepEqual([d.auto, d.reasons], [false, [PENDING]]);
});

// ---- a reporter destination stays in the worktree

test('runner.one: a reporter destination with a `..` segment is refused', () => {
  for (const one of ['node --test --test-reporter=spec --test-reporter-destination=../out.txt {file}', 'node --test --test-reporter=spec --test-reporter-destination=src/../../out.txt {file}', 'node --test --test-reporter=spec --test-reporter-destination=a/.. {file}']) assert.equal(policy.coverageRunnerOne(one), false, one);
  assert.equal(policy.coverageRunnerOne('node --test --test-reporter=spec --test-reporter-destination=out/report..txt {file}'), true);
});
