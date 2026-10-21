// #784 round 9: the assertion count's total input is capped; two false holds fixed (a field a test's `new` runs, a file
// starting with a byte-order mark); and every place V8 makes no block range of its own, so a change there counts when
// the code around it ran, named as a limit with a todo test each.
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
import * as policy from '../src/merge-policy-vacuity.js';
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
const calls = (file: string, name: string, call: string, want: string) => `${H}import { ${name} } from '../${file}';\ntest('${name}', () => { assert.deepEqual(${call}, ${want}); });\n`;

// ---- the assertion count's total input

test('the assertion count reads at most so much of a PR\'s tests in all: more holds the PR', () => {
  const cfg = { test_globs: ['test/**/*.test.js'], assertion_pattern: '\\b(assert|expect)\\b', app_paths: ['src/**'], dynamic: true };
  const files: Record<string, string> = { 'src/a.js': 'export const a = 1;\n' };
  for (let k = 0; k < 6; k++) files[`test/t${k}.test.js`] = `assert.ok(1);\n${'x'.repeat(900 * 1024)}\n`;
  const v = policy.vacuityCheck({ cfg, runOne: 'node --test {file}', changed: Object.keys(files), atHead: (p) => files[p] ?? null, runs: { started: 0, last: null } });
  assert.equal(v.run, undefined);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0]!, /^design: vacuity: its tests are over \d+ characters in all, more than the gate reads for their assertions/);
});

// ---- false holds fixed

test('a field initializer a test\'s `new` runs counts: the PR merges', async () => {
  const counter = 'export class Counter {\n  count = 0;\n  inc() {\n    this.count++;\n  }\n}\n';
  const d = await decided({ 'src/counter.js': counter }, { 'src/counter.js': counter.replace('count = 0;', 'count = 10;'), 'test/c.test.js': `${H}import { Counter } from '../src/counter.js';\ntest('starts at 10', () => { assert.equal(new Counter().count, 10); });\n` });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('a module starting with a byte-order mark is measured: a test that calls its change merges', async () => {
  const f = '﻿export function f(x) {\n  return x + 1;\n}\n';
  const d = await decided({ 'src/f.js': f }, { 'src/f.js': f.replace('x + 1', 'x + 2'), 'test/f.test.js': calls('src/f.js', 'f', 'f(1)', '3') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- named limits: where V8 makes no block range of its own (each would hold if the gate could see it)

const LIMIT = { todo: 'V8 makes no block range here: named in "What this can never do", the quickstart and the changelog' };

test('limit: the arguments of an optional call that never happens', LIMIT, async () => {
  const f = "export function read(audit, user) {\n  audit?.record(user.id, 'read');\n  return user.id;\n}\n";
  const d = await decided({ 'src/r.js': f }, { 'src/r.js': f.replace("'read'", "'write'"), 'test/r.test.js': calls('src/r.js', 'read', 'read(undefined, { id: 1 })', '1') });
  assert.equal(d.auto, false);
});

test('limit: a default parameter the test always passes', LIMIT, async () => {
  const f = 'export function cap(x, max = 100) {\n  return Math.min(x, max);\n}\n';
  const d = await decided({ 'src/cap.js': f }, { 'src/cap.js': f.replace('max = 100', 'max = Infinity'), 'test/cap.test.js': calls('src/cap.js', 'cap', 'cap(5, 3)', '3') });
  assert.equal(d.auto, false);
});

test('limit: a destructuring default the test always fills', LIMIT, async () => {
  const f = "export function role({ role = 'guest' }) {\n  return role;\n}\n";
  const d = await decided({ 'src/role.js': f }, { 'src/role.js': f.replace("'guest'", "'admin'"), 'test/role.test.js': calls('src/role.js', 'role', "role({ role: 'x' })", "'x'") });
  assert.equal(d.auto, false);
});

test('limit: a logical assignment whose right side never runs', LIMIT, async () => {
  const f = "export function fill(o) {\n  o.role ??= 'guest';\n  return o.role;\n}\n";
  const d = await decided({ 'src/fill.js': f }, { 'src/fill.js': f.replace("'guest'", "'admin'"), 'test/fill.test.js': calls('src/fill.js', 'fill', "fill({ role: 'x' })", "'x'") });
  assert.equal(d.auto, false);
});

test('limit: code in a string, never run', LIMIT, async () => {
  const f = "export function make() {\n  return new Function('x', 'return x + 1');\n}\n";
  const d = await decided({ 'src/make.js': f }, { 'src/make.js': f.replace('x + 1', 'x - 1'), 'test/make.test.js': calls('src/make.js', 'make', 'typeof make()', "'function'") });
  assert.equal(d.auto, false);
});

test('limit: built code is placed by line through its map, so an untaken arm on a line that ran counts', LIMIT, async () => {
  const src = 'export function abs(x) {\n  return x > 0 ? x : -x;\n}\n';
  const map = (file: string) => JSON.stringify({ version: 3, file, sources: ['../src/abs.js'], names: [], mappings: 'AAAA;AACA;AACA' });
  const changed = src.replace(': -x', ': 0');
  const d = await decided({ 'src/abs.js': src, 'dist/abs.js': src, 'dist/abs.js.map': map('abs.js') }, { 'src/abs.js': changed, 'dist/abs.js': changed, 'test/abs.test.js': calls('dist/abs.js', 'abs', 'abs(5)', '5') });
  assert.equal(d.auto, false);
});
