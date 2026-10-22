// #784 round 11: how the merge gate reads a PR's diff. The histogram algorithm, pinned (P8: the default one slides a
// removed function's lines onto a kept one's), and a name with a space (N4: git ends its ---/+++ lines with a TAB).
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
import { changedLineNumbers } from '../src/coordinator/change-files.js';
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
async function decided(before: Record<string, string>, after: Record<string, string>, tune?: (dir: string) => void) {
  const dir = exampleProject().dir;
  tune?.(dir);
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

// ---- P8: a removed function's lines slid onto a kept one's (the default diff algorithm)

const SL_BEFORE = 'function u(x) {\n  return x + 1;\n}\nexport function t(x) {\n  return x + 1;\n}\n';
const SL_AFTER = 'export function t(x) {\n  return x + 1;\n}\nfunction v(x) {\n  return x + 1;\n}\n';

test('must hold: P8: an untested function removed before a tested one and an identical untested one added after it', async () => {
  const d = await decided({ 'src/sl.js': SL_BEFORE }, { 'src/sl.js': SL_AFTER, 'test/x.test.js': calls('sl.js', 't', 't(1)', '2') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/sl.js')]]);
});

test('must hold: P8 under a repository that sets another diff algorithm (the pin wins)', async () => {
  const d = await decided({ 'src/sl.js': SL_BEFORE }, { 'src/sl.js': SL_AFTER, 'test/x.test.js': calls('sl.js', 't', 't(1)', '2') }, (dir) => git(dir, 'config', 'diff.algorithm', 'myers'));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/sl.js')]]);
});

test('control: P8: a test that calls the added function merges', async () => {
  const after = SL_AFTER.replace('function v', 'export function v');
  const d = await decided({ 'src/sl.js': SL_BEFORE }, { 'src/sl.js': after, 'test/x.test.js': calls('sl.js', 'v', 'v(1)', '2') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- N4: a name with a space (git ends its ---/+++ lines with a TAB)

test('N4: a tested change to a file whose name holds a space merges', async () => {
  const f = 'export function f(x) {\n  return x + 1;\n}\n';
  const t = `${H}import { f } from '../src/my f.js';\ntest('f', () => { assert.equal(f(1), 3); });\n`;
  const d = await decided({ 'src/my f.js': f }, { 'src/my f.js': f.replace('x + 1', 'x + 2'), 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('N4: an untested change to a file whose name holds a space holds', async () => {
  const f = 'export function f(x) {\n  return x + 1;\n}\nexport function g() {\n  return 0;\n}\n';
  const t = `${H}import { g } from '../src/my f.js';\ntest('g', () => { assert.equal(g(), 0); });\n`;
  const d = await decided({ 'src/my f.js': f }, { 'src/my f.js': f.replace('x + 1', 'x + 2'), 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/my f.js')]]);
});

test("N4: changedLineNumbers drops the TAB git adds to a name with a space, on both the ---/+++ lines", () => {
  const diff = 'diff --git a/src/old f.js b/src/my f.js\n--- a/src/old f.js\t\n+++ b/src/my f.js\t\n@@ -2 +2 @@\n-  return x + 1;\n+  return x + 2;\n';
  assert.deepEqual([...changedLineNumbers(diff)], [['src/my f.js', [{ at: 1, added: [2], removed: ['  return x + 1;'], from: 2, oldPath: 'src/old f.js' }]]]);
});
