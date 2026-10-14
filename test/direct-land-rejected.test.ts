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
import { InstanceSettings, PolicyFile } from '../src/instance.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(landMode: 'direct' | 'pr') {
  const base = mkdtempSync(join(tmpdir(), 'rejected-'));
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
  cfg.project.land_mode = landMode;
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}

const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';

/** A worker that makes a real fix; an evaluator that rejects it every time. */
const runner = () =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: false, test_correct: true, confidence: 'high', advice: 'it skips zero quantities wrongly', files_reviewed: ['src/price.js'], design_change: false } };
  });

async function run(landMode: 'direct' | 'pr') {
  const f = fixture(landMode);
  const n = f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const mainBefore = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  await c.tick();
  return { f, n, mainBefore };
}

test('direct mode: a change the evaluator rejected is held for the owner (L3), never landed', { skip }, async () => {
  const { f, n, mainBefore } = await run('direct');
  const level = f.log.read(0, ['review.level_set']).at(-1)?.payload as { level: string; reasons: string[] } | undefined;
  assert.equal(level?.level, 'L3', JSON.stringify(level));
  assert.ok(level!.reasons.some((r) => /evaluator rejected the patch: held for the owner \(safety floor\)/.test(r)));
  assert.equal(f.log.read(0, ['land.queued']).length, 0, 'not queued to land');
  const asked = f.log.read(0, ['decision.asked']).at(-1)?.payload as { kind: string; issue: number; recommendation: string } | undefined;
  assert.deepEqual([asked?.kind, asked?.issue, asked?.recommendation], ['land', n, 'reject']);
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], mainBefore, 'main untouched');
});

test('direct mode: the floor holds even when the review levels are configured to ask for nothing', { skip }, async () => {
  const { f } = await runWith((cfg) => {
    cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  });
  assert.equal((f.log.read(0, ['review.level_set']).at(-1)!.payload as { level: string }).level, 'L3');
  assert.equal(f.log.read(0, ['land.queued']).length, 0);
});

async function runWith(edit: (cfg: ReturnType<typeof fixture>['cfg']) => void) {
  const f = fixture('direct');
  edit(f.cfg);
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  return { f };
}

test('no setting can loosen it: the instance policy, its settings and review.yaml reject any such key', () => {
  for (const key of ['land_rejected', 'allow_rejected_land', 'rejected_verdict_level']) {
    assert.equal(PolicyFile.safeParse({ version: 1, budget: { daily_usd: 5 }, [key]: true }).success, false, `policy ${key}`);
    assert.equal(InstanceSettings.safeParse({ [key]: true }).success, false, `settings ${key}`);
    assert.equal(ReviewConfig.safeParse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, [key]: 'L1' }).success, false, `review ${key}`);
  }
});

test('PR mode is unchanged: a rejected change still goes to a PR (readiness needs approval at the head)', { skip }, async () => {
  const { f } = await run('pr');
  const level = f.log.read(0, ['review.level_set']).at(-1)!.payload as { level: string; reasons: string[] };
  assert.notEqual(level.level, 'L3');
  assert.ok(!level.reasons.some((r) => /safety floor/.test(r)));
  assert.equal(f.log.read(0, ['land.queued']).length, 1);
});
