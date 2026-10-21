// The merge gate runs the PR's own tests under coverage (#784): through the coordinator's own decision
// (merge-flow.ts mergeDecisionFor) and its coverage run, on a real repo with the example project's tests.yaml
// (vacuity: dynamic, app_paths src/**, runner.one `node --test {file}`).
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
import { afterCoverageRun, approve, green, openPr, passing, skip } from './repro-state-graph/harness.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const TOUCHES = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('t', () => { assert.equal(totalCents([{ cents: 2, qty: 3 }]), 6); });\n";
const MISSES = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('t', () => { assert.equal(1 + 1, 2); });\n";
const IMPORTS_ONLY = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport '../src/price.js';\ntest('t', () => { assert.ok(true); });\n";
const FAILS = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('t', () => { assert.equal(totalCents([]), 1); });\n";
const PRICE = '// Prices are integer cents.\nexport function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0) + 0;\n}\n\nexport function applyDiscount(cents, pct) {\n  if (pct < 0 || pct > 100) throw new RangeError(\'pct must be 0-100\');\n  return Math.round(cents * (100 - pct) / 100);\n}\n';

type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

/** A PR at a head that writes `files` over the example project, ready (an approving verdict), under rules that hold nothing else. */
function prWith(files: Record<string, string>, tune: (c: ReturnType<typeof loadConfig>) => void = () => {}) {
  const dir = exampleProject().dir;
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  tune(cfg);
  const log = new EventLog(join(dir, '..', 'events.db'));
  const n = 7;
  log.append('issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: n, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: n, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  const pr: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return { c, pr, w, log, dir };
}

/** The decision, after the coverage run the gate asks for (once), as the next PR-watch pass makes it. */
async function decided(t: ReturnType<typeof prWith>) {
  const first = t.c.mergeDecisionFor(7, 9, t.pr);
  if (first.vacuityRun) {
    assert.deepEqual(first.reasons, ['design: vacuity: its tests have not yet been run under coverage at this head'], 'nothing but the run is pending');
    assert.equal(first.auto, false, 'never merged before the run');
    await t.c.vacuityRun(t.w, t.pr, first.vacuityRun);
  }
  return { first, then: t.c.mergeDecisionFor(7, 9, t.pr) };
}

test('gate: a PR whose new test asserts but runs none of the app code it changes waits, after a measured run', async () => {
  const t = prWith({ 'src/price.js': PRICE, 'test/other.test.js': MISSES });
  const { first, then } = await decided(t);
  assert.ok(first.vacuityRun, 'the gate asked for a coverage run');
  assert.equal(then.auto, false);
  assert.deepEqual(then.reasons, ['design: vacuity: its tests (test/other.test.js) ran none of the app code it changes (src/price.js)']);
  const m = t.log.read(0, ['vacuity.measured']).map((e) => e.payload as { head: string; tests: string[]; touched: string[]; error: string | null });
  assert.deepEqual(m, [{ issue: 7, number: 9, head: t.pr.headSha, tests: ['test/other.test.js'], touched: [], error: null }], 'the run is on the record, at this head');
});

test('gate: importing the changed file without calling it is not exercising it', async () => {
  const t = prWith({ 'src/price.js': PRICE, 'test/imports.test.js': IMPORTS_ONLY });
  const { then } = await decided(t);
  assert.deepEqual([then.auto, then.reasons], [false, ['design: vacuity: its tests (test/imports.test.js) ran none of the app code it changes (src/price.js)']]);
});

test('gate: a PR whose test calls the changed code merges (control)', async () => {
  const t = prWith({ 'src/price.js': PRICE, 'test/price-more.test.js': TOUCHES });
  const { then } = await decided(t);
  assert.deepEqual([then.auto, then.reasons], [true, []]);
});

test("gate: an unchanged test its task's done_when names counts when it calls the changed code (control)", async () => {
  const t = prWith({ 'src/price.js': PRICE });
  t.log.append('contract.agreed', { issue: 7, done_when: [{ test: 'test/price.test.js' }], by: 'example-owner' }, 'i');
  const { first, then } = await decided(t);
  assert.deepEqual(first.vacuityRun?.tests, ['test/price.test.js']);
  assert.deepEqual([then.auto, then.reasons], [true, []]);
});

test('gate: app code with no test waits, and nothing is run', () => {
  const t = prWith({ 'src/price.js': PRICE });
  const d = t.c.mergeDecisionFor(7, 9, t.pr);
  assert.deepEqual([d.auto, d.reasons, d.vacuityRun], [false, ["design: vacuity: it changes app code (src/price.js) and no test: it adds or changes none, and its task's done_when names none"], undefined]);
});

test('gate: fail closed: a coverage run whose test fails holds the PR, naming the failure', async () => {
  const t = prWith({ 'src/price.js': PRICE, 'test/red.test.js': FAILS });
  const { then } = await decided(t);
  assert.equal(then.auto, false);
  assert.equal(then.reasons.length, 1);
  assert.match(then.reasons[0]!, /^design: vacuity: its coverage run failed: test\/red\.test\.js exited 1/);
});

test('gate: fail closed: a runner.one that writes no coverage (not Node) holds the PR', async () => {
  const t = prWith({ 'src/price.js': PRICE, 'test/price-more.test.js': TOUCHES }, (c) => {
    c.tests.runner.one = 'true {file}';
  });
  const { then } = await decided(t);
  assert.deepEqual([then.auto, then.reasons], [false, ['design: vacuity: its coverage run failed: no coverage was written (runner.one must run the tests in Node for a coverage run)']]);
});

test('gate: fail closed: runs that start and never finish stop being retried and hold the PR', () => {
  const t = prWith({ 'src/price.js': PRICE, 'test/price-more.test.js': TOUCHES });
  for (let i = 0; i < 3; i++) t.log.append('vacuity.started', { issue: 7, number: 9, head: t.pr.headSha, tests: ['test/price-more.test.js'] }, 'i');
  const d = t.c.mergeDecisionFor(7, 9, t.pr);
  assert.deepEqual([d.auto, d.reasons, d.vacuityRun], [false, ['design: vacuity: its coverage run started 3 times at this head and never finished'], undefined]);
});

test('gate: a static-only vacuity config holds app code: nothing measured whether the tests run it', () => {
  const t = prWith({ 'src/price.js': PRICE, 'test/price-more.test.js': TOUCHES }, (c) => {
    c.tests.vacuity!.dynamic = false;
  });
  const d = t.c.mergeDecisionFor(7, 9, t.pr);
  assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: tests.yaml vacuity.dynamic is off, so nothing measured whether its tests run the app code it changes (src/price.js)']]);
});

test('gate: docs, config and types-only changes need no run (control)', () => {
  const t = prWith({ 'README.md': '# more\n', 'src/settings.json': '{}\n', 'src/types.d.ts': 'export type A = 1;\n' });
  const d = t.c.mergeDecisionFor(7, 9, t.pr);
  assert.deepEqual([d.auto, d.reasons, d.vacuityRun], [true, [], undefined]);
});

// Through the PR watch itself (watchPr, then mergeOrWait): one pass starts the run in the background (the PR waits,
// unannounced), and the pass after it decides (the harness's green makes that pass once the run ends).

test('watch: a fix whose repro test calls the fixed code is measured, then auto-merges on the next pass (control)', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  t.f.backlog.setChecks(t.pr().headSha, passing);
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['vacuity.started']).length, 1, 'the first pass starts the run');
  assert.equal(t.f.log.read(0, ['merge.done']).length, 0, 'not before its run');
  await afterCoverageRun(t.c);
  const measured = t.f.log.read(0, ['vacuity.measured']).map((e) => e.payload as EventPayload<'vacuity.measured'>);
  // The repro it commits, then the test its done_when names (test/price.test.js, unchanged).
  assert.deepEqual(measured.map((m) => [m.head, m.tests, m.touched, m.error]), [[t.opened.head, ['test/repro-qty.test.js', 'test/price.test.js'], ['src/price.js'], null]]);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 1, 'merged');
});

test('watch: a PR held for another reason gets no coverage run, and its hold names only that reason', { skip }, async () => {
  // The default verdict gives no design-change answer: a doubt holds it.
  const t = await openPr({}, { autoMerge: () => true });
  await green(t);
  assert.equal(t.f.log.read(0, ['vacuity.started']).length, 0, 'nothing run for a PR the owner decides anyway');
  const decided = t.f.log.read(0, ['merge.decided']).map((e) => e.payload as EventPayload<'merge.decided'>);
  assert.deepEqual(decided.map((d) => [d.auto, d.reasons]), [[false, ['doubt: the evaluator gave no design-change answer']]]);
});

test('watch: fail closed: a coverage run that fails holds the PR for the owner, with the reason, and never merges', { skip }, async () => {
  // Passes as the task's own checks run it; fails only under the gate's coverage run.
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true, edit: (cfg) => void (cfg.tests.runner.one = 'node --test --test-reporter=spec {file} && test -z "$NODE_V8_COVERAGE"') });
  await green(t);
  await green(t);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 0, 'not merged');
  const decided = t.f.log.read(0, ['merge.decided']).map((e) => e.payload as EventPayload<'merge.decided'>);
  assert.deepEqual(decided.map((d) => [d.auto, d.reasons.length]), [[false, 1]]);
  assert.match(decided[0]!.reasons[0]!, /^design: vacuity: its coverage run failed: test\/repro-qty\.test\.js exited 1/);
  assert.equal(t.f.log.read(0, ['vacuity.started']).length, 1, 'measured once at the head, not again on every pass');
});
