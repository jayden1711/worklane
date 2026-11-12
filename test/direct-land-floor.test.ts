import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// #716: direct land skips mergeDecision, so the merge policy's wait floor applies on the direct path itself: a change
// in a category PR mode always holds for a human is held for the owner (L3) in direct mode too, never landed.

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The example project with a bare remote, its config in direct mode, review levels that ask for nothing. */
function fixture(waitCategories: string[]) {
  const base = mkdtempSync(join(tmpdir(), 'direct-floor-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  // Levels that ask for nothing: without the floor, the change is L0 and lands.
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: waitCategories } });
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}

const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';

/** A worker that makes a real fix (src/price.js, app-non-money); an evaluator that approves it. */
const runner = () =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['src/price.js'], design_change: false } };
  });

async function run(waitCategories: string[]) {
  const f = fixture(waitCategories);
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  const level = f.log.read(0, ['review.level_set']).at(-1)?.payload as { level: string; reasons: string[] } | undefined;
  return { f, level };
}

test("direct mode: a change in a wait category (the repo's merge.wait_categories) is held for the owner, never queued to land", { skip }, async () => {
  const { f, level } = await run(['app-non-money']);
  assert.equal(level?.level, 'L3', JSON.stringify(level));
  assert.ok(level!.reasons.some((r) => r.startsWith('high-risk: app-non-money (') && r.endsWith(": held for the owner (direct land's merge-policy floor)")), JSON.stringify(level!.reasons));
  assert.equal(f.log.read(0, ['land.queued']).length, 0, 'not queued to land');
  assert.equal(f.log.read(0, ['decision.asked']).length, 1, 'the owner is asked');
});

test('direct mode, control: the same approved change in no wait category is queued to land at its level, unchanged', { skip }, async () => {
  const { f, level } = await run([]);
  assert.notEqual(level?.level, 'L3', JSON.stringify(level));
  assert.ok(!level!.reasons.some((r) => r.includes("direct land's merge-policy floor")));
  assert.equal(f.log.read(0, ['land.queued']).length, 1);
});
