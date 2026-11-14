import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// #716, R1182f: direct land's merge-policy floor is checked again in landBatch, on the commit it would push (tip..HEAD,
// the pre-land steps' output included), under the review config and land mode in force at landing. (The adversarial
// review's attacks 7-9, as tests.)

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = (wait: string[]) => ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });

function fixture(mode: 'direct' | 'pr', wait: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'direct-floor-land-'));
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
  cfg.project.land_mode = mode;
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = REVIEW(wait);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { base, remote, repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}
type Fixture = ReturnType<typeof fixture>;

const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';

/** A worker that makes the real fix plus `extra` files; an evaluator that approves, having read them all. */
const runner = (extra: Record<string, string>) =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      for (const [f, body] of Object.entries(extra)) {
        mkdirSync(dirname(join(req.cwd, f)), { recursive: true });
        writeFileSync(join(req.cwd, f), body);
      }
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['src/price.js', ...Object.keys(extra)], design_change: false } };
  });

const coord = (f: Fixture, extra: Record<string, string> = {}) => new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(extra), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
async function cycle(f: Fixture, extra: Record<string, string> = {}) {
  const c = coord(f, extra);
  await c.tick();
  await c.idle();
}
async function run(f: Fixture, extra: Record<string, string>) {
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, extra);
}
const onMain = (f: Fixture) => git(f.base, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
const results = (f: Fixture) => f.log.read(0, ['land.result']).map((e) => e.payload as EventPayload<'land.result'>);
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');
const CI = { '.gitlab-ci.yml': 'test: { script: [echo pwned] }\n' };

test('R1182f 1: a ci-config file a pre-land step writes into the land commit is held for the owner, not pushed; approved, it lands', { skip }, async () => {
  const f = fixture('direct');
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  await run(f, { 'tools/gen.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', 'test: { script: [echo pwned] }\\n');\n" });
  await cycle(f);
  const s = JSON.stringify(results(f));
  assert.ok(!onMain(f).includes('.gitlab-ci.yml'), `ci-config landed via the pre-land step: ${s}`);
  assert.equal(results(f).at(-1)?.outcome, 'rejected', s);
  const q = asked(f).at(-1);
  assert.ok(q?.receipts.some((r) => r.startsWith('high-risk: ci-config (.gitlab-ci.yml)') && r.includes('checked again at landing')), JSON.stringify(q));
  assert.equal(q?.recommendation, 'reject', 'the evaluator never saw the pre-land output');
  // The owner approves: it lands, with the step's output, and isn't asked again.
  f.log.append('decision.answered', { id: q!.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  await cycle(f);
  await cycle(f);
  assert.equal(results(f).at(-1)?.outcome, 'landed', JSON.stringify(results(f)));
  assert.ok(onMain(f).includes('.gitlab-ci.yml'));
  assert.equal(asked(f).length, 1, 'asked once');
});

test('R1182f 2: a change queued in pr mode, then landed by a direct-mode coordinator, meets the floor at landing', { skip }, async () => {
  const f = fixture('pr');
  await run(f, CI);
  assert.equal(f.log.read(0, ['land.queued']).length, 1, 'queued in pr mode');
  f.cfg.project.land_mode = 'direct';
  await cycle(f);
  assert.ok(!onMain(f).includes('.gitlab-ci.yml'), `ci-config landed on main without the owner: ${JSON.stringify(results(f))}`);
  assert.ok(asked(f).at(-1)?.receipts.some((r) => r.startsWith('high-risk: ci-config')), JSON.stringify(asked(f)));
});

test('R1182f 3: a wait category added after queueing holds the queued change at landing', { skip }, async () => {
  const f = fixture('direct', []);
  await run(f, {});
  assert.equal(f.log.read(0, ['land.queued']).length, 1);
  f.cfg.review = REVIEW(['app-non-money']);
  await cycle(f);
  assert.notEqual(results(f).at(-1)?.outcome, 'landed', JSON.stringify(results(f)));
  assert.ok(asked(f).at(-1)?.receipts.some((r) => r.startsWith('high-risk: app-non-money')), JSON.stringify(asked(f)));
  assert.equal(asked(f).at(-1)?.recommendation, 'approve', "every file is the worker's own, which the evaluator read");
});

test('R1182f control: a pre-land step that writes nothing in a wait category lands as before, with no question', { skip }, async () => {
  const f = fixture('direct');
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  await run(f, { 'tools/gen.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/generated.js', 'export const g = 1;\\n');\n" });
  await cycle(f);
  assert.equal(results(f).at(-1)?.outcome, 'landed', JSON.stringify(results(f)));
  assert.ok(onMain(f).includes('src/generated.js'));
  assert.equal(asked(f).length, 0);
});
