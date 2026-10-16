// The weekly optimization pass, wired end to end: a baseline on main, a normal task on the strongest model, the
// benchmark again on its change, and a PR only for a median better than main's by more than the noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { which } from '../src/os/index.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A benchmark whose number is src/speed.json's cost plus a fixed jitter (0, 2, -2, 1, -1 in turn: MAD 1), so the
// baseline is median 100, MAD 1, and a change's median is whatever cost it sets.
const BENCH = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const counter = process.argv[2];
const i = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(i + 1));
const { cost } = JSON.parse(readFileSync('src/speed.json', 'utf8'));
console.log('elapsed: ' + (cost + [0, 2, -2, 1, -1][i % 5]) + ' ms');
`;

function commitAll(cwd: string, msg: string) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

const readAll = (req: RunRequest) => {
  const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)?.[1];
  return base ? git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean) : [];
};

/** The worker sets src/speed.json's cost (null: a change that touches only the README); `fail` breaks a test. */
function agents(cost: number | null, o: { usd?: number; fail?: boolean } = {}) {
  return new FakeRunner((req) => {
    if (req.role === 'worker') {
      if (cost === null) writeFileSync(join(req.cwd, 'README.md'), `${readFileSync(join(req.cwd, 'README.md'), 'utf8')}\nFaster, maybe.\n`);
      else writeFileSync(join(req.cwd, 'src', 'speed.json'), JSON.stringify({ cost }));
      if (o.fail) writeFileSync(join(req.cwd, 'test', 'broken.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n");
      commitAll(req.cwd, 'Make it faster');
      return { structured: { summary: 'made it faster' }, costUsd: o.usd ?? 0.5 };
    }
    if (req.role === 'evaluator-repro') return { structured: { test_path: '', explanation: '', not_reproducible: 'a speed change' } };
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: readAll(req), design_change: false } };
  });
}

function fixture(runner: FakeRunner, edit: (cfg: ReturnType<typeof loadConfig>) => void = () => {}) {
  const base = mkdtempSync(join(tmpdir(), 'optimize-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  writeFileSync(join(seed, 'bench.mjs'), BENCH);
  writeFileSync(join(seed, 'src', 'speed.json'), JSON.stringify({ cost: 100 }));
  const counter = join(base, 'bench-counter');
  writeFileSync(join(seed, BRAND.configDir, 'benchmarks.yaml'), `version: 1\nbenchmarks:\n  - name: checkout\n    command: node bench.mjs ${counter}\n    repeats: 5\n    metric: { pattern: 'elapsed: ([0-9.]+) ms', unit: ms }\n`);
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
  cfg.project.land_mode = 'pr';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const now = new Date(2026, 9, 12, 3, 0);
  cfg.project.optimize = { ...cfg.project.optimize, enabled: true, weekday: now.getDay(), at: '02:00', budget_usd: 10 };
  edit(cfg);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const log = new EventLog(join(base, 'events.db'));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const c = new Coordinator({ cfg, log, backlog, runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, maxAttempts: 2, now: () => now, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  const of = (type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
  /** The pass, the task it files, and the landing step that opens its PR. */
  const run = async () => {
    await c.tick();
    await c.idle();
    await c.tick();
    await c.idle();
    await c.tick();
    await c.idle();
  };
  return { cfg, log, backlog, c, run, of, runner };
}

test('a real improvement: measured on main, built on the strongest model, a PR with the before and after numbers and raw runs', { skip }, async () => {
  const t = fixture(agents(50));
  await t.run();
  const pass = t.of('optimize.pass')[0]!;
  assert.equal(pass.outcome, 'filed');
  assert.deepEqual((pass.baseline as { runs: number[] }).runs, [100, 102, 98, 101, 99]);
  const issue = await t.backlog.get(pass.issue as number);
  assert.ok(issue.labels.includes('optimize'), issue.labels.join(','));
  assert.match(issue.body, /change only what improves this number/i);
  const worker = t.runner.calls.find((r) => r.role === 'worker')!;
  assert.equal(worker.model, 'opus', 'the strongest model (agents.yaml routing: the high-risk build model)');
  assert.deepEqual(t.of('optimize.result').map((r) => r.outcome), ['improved']);
  const prs = t.backlog.prs();
  assert.equal(prs.length, 1, 'one PR');
  const body = prs[0]!.body;
  assert.match(body, /\*\*Optimization\*\* \(`bench:checkout`, lower is better\): median 100 ms → 50 ms/);
  assert.match(body, /before \(main\).*\| 100 \| 1 \| 100, 102, 98, 101, 99 \|/);
  assert.match(body, /\| after .*\| 50 \| 1 \| 50, 52, 48, 51, 49 \|/);
  assert.equal(prs[0]!.draft, true, 'a normal draft PR: every normal gate before it merges');
});

test('no improvement: no PR; the task is closed with why', { skip }, async () => {
  const t = fixture(agents(null));
  await t.run();
  assert.equal(t.backlog.prs().length, 0);
  const r = t.of('optimize.result')[0]!;
  assert.equal(r.outcome, 'discarded');
  assert.match(r.why as string, /^no improvement: median 100 ms before, 100 ms after/);
  const issue = await t.backlog.get(r.issue as number);
  assert.equal(issue.state, 'closed');
  assert.match((await t.backlog.comments(issue.number)).at(-1)!.body, /Optimization discarded, no PR: no improvement/);
});

test('a noise-level improvement: no PR', { skip }, async () => {
  const t = fixture(agents(99));
  await t.run();
  assert.equal(t.backlog.prs().length, 0);
  const r = t.of('optimize.result')[0]!;
  assert.equal(r.outcome, 'discarded');
  assert.match(r.why as string, /^within the noise: median 100 ms before, 99 ms after/);
});

test("the week's budget stops the pass: every run capped at what is left, and no attempt once it is spent", { skip }, async () => {
  const t = fixture(agents(50, { usd: 0.6, fail: true }), (cfg) => void (cfg.project.optimize.budget_usd = 0.5));
  await t.run();
  const workers = t.runner.calls.filter((r) => r.role === 'worker');
  assert.equal(workers.length, 1, 'the second attempt never starts');
  assert.ok(workers[0]!.maxBudgetUsd <= 0.5, `capped at the week's budget: ${workers[0]!.maxBudgetUsd}`);
  const r = t.of('optimize.result')[0]!;
  assert.equal(r.outcome, 'discarded');
  assert.match(r.why as string, /optimization budget \(\$0.5\) is spent/);
  assert.equal(t.backlog.prs().length, 0);
  // A pass the next week while last week's spend still counts (within 7 days) files nothing.
  const u = fixture(agents(50), (cfg) => void (cfg.project.optimize.budget_usd = 1));
  u.log.append('optimize.pass', { started_at: new Date(2026, 9, 5, 9, 0).toISOString(), target: 'bench:checkout', unit: 'ms', lower_is_better: true, issue: 99, baseline: null, outcome: 'filed' }, 'alice');
  u.log.append('optimize.result', { issue: 99, target: 'bench:checkout', head: null, outcome: 'discarded', why: 'x', before: null, after: null, gain: null, pct: null, noise: null }, 'alice');
  u.log.append('run.cost', { issue: 99, role: 'worker', model: 'opus', usd: 1.5, turns: 3 }, 'alice');
  await u.run();
  assert.match(u.of('optimize.pass').at(-1)!.outcome as string, /optimization budget \(\$1\) is spent/);
  assert.equal(u.runner.calls.length, 0);
  assert.equal((await u.backlog.list('optimize')).length, 0);
});

test('disabled (the default): nothing runs, nothing is filed', { skip }, async () => {
  const t = fixture(agents(50), (cfg) => void (cfg.project.optimize.enabled = false));
  await t.run();
  assert.equal(t.of('optimize.pass').length, 0);
  assert.equal(t.runner.calls.length, 0);
  assert.equal(t.backlog.prs().length, 0);
});

test('an optimize label alone never makes an issue actionable: only a task this instance filed is', { skip }, async () => {
  const t = fixture(agents(50), (cfg) => void (cfg.project.optimize.enabled = false));
  t.backlog.open({ title: 'Optimize everything', body: '```done_when\n- suite: full\n```\n', author: 'someone-else', labels: ['optimize', 'ready'] });
  await t.run();
  assert.equal(t.runner.calls.length, 0);
});
