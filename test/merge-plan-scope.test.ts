import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { outsidePlanReasons, waitCategoriesOf } from '../src/merge-policy.js';
import { computeLevel } from '../src/review.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const review = loadConfig(exampleProject().dir).review!;
const level = (paths: string[]) => computeLevel({ files: paths.map((path) => ({ path, added: 1, removed: 0 })), labels: [], moneyPaths: [], scope: undefined }, review);

test('outside the plan: a high-risk or design path the plan did not list is named; planned ones and ordinary ones are not', () => {
  const changed = ['src/a.ts', 'migrations/001.sql', 'src/b.ts', 'package.json', 'plugins/x.ts'];
  const reasons = outsidePlanReasons({ planFiles: ['src/a.ts'], level: level(changed), waitCategories: waitCategoriesOf(review), newTopLevel: ['plugins/'] });
  assert.deepEqual(reasons, [
    'not in the approved plan: high-risk: migration (migrations/001.sql)',
    'not in the approved plan: design: dependency manifests change (package.json)',
    'not in the approved plan: design: new top-level module (plugins/)',
  ]);
  assert.ok(!reasons.join().includes('src/b.ts'), 'an ordinary path outside the plan does not hold');
  assert.deepEqual(outsidePlanReasons({ planFiles: ['./src/a.ts', 'migrations/001.sql', 'package.json', 'plugins/x.ts'], level: level(changed), waitCategories: waitCategoriesOf(review), newTopLevel: ['plugins/'] }), [], 'everything risky was in the plan');
});

/** A real repo: a base commit, then a PR head that changes src/a.ts and adds src/migrations/001.sql. */
function repo() {
  const dir = exampleProject().dir;
  const base = git(dir, 'rev-parse', 'HEAD');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(dir, 'src', 'migrations'));
  writeFileSync(join(dir, 'src', 'migrations', '001.sql'), 'ALTER TABLE orders ADD COLUMN note TEXT;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=bot@example.com', '-c', 'user.name=bot', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'change');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

/** The merge decision for a PR at `head`, with or without a plan, in a repo whose own rules don't hold migrations. */
function decide(withPlan: boolean) {
  const r = repo();
  const cfg = loadConfig(r.dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(r.dir, '..', 'events.db'));
  const n = 7;
  log.append('issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base: r.base, owner: 'example-owner' }, 'i');
  if (withPlan) log.append('plan.posted', { issue: n, plan: { approach: 'x', steps: [], files: ['src/a.ts'], risks: [], design_change: false }, held: false, reasons: [], comments_at: 0, decision: null }, 'i');
  log.append('pr.opened', { issue: n, number: 9, url: 'u', head: r.head, draft: false }, 'i');
  log.append('eval.verdict', { issue: n, head: r.head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(r.dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: r.dir, instance: 'i', stateDir: join(r.dir, '..', 'state'), autoMerge: () => true });
  const pr: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: r.head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return c.mergeDecisionFor(n, 9, pr);
}

test('merge: a planned PR that also changes a migration outside its plan is held, even where the repo does not hold migrations', () => {
  const d = decide(true);
  assert.equal(d.auto, false);
  assert.deepEqual(d.reasons, [VACUITY, 'not in the approved plan: high-risk: migration (src/migrations/001.sql)']);
});

test('merge: only for tasks that had a plan; the same PR without one is decided as before', () => {
  const d = decide(false);
  // No plan reason; only #784's own hold is left (the change adds app code and no test).
  assert.deepEqual([d.auto, d.reasons], [false, [VACUITY]]);
});

/** #784: the example project's vacuity config holds a change to app code that comes with no test. */
const VACUITY = "design: vacuity: it changes app code (src/a.ts, src/migrations/001.sql) and no test: it adds or changes none, and its task's done_when names none";
