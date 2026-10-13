// Model routing: which model each kind of run uses, decided in code, overridable in agents.yaml, capped by the
// instance; a build escalates to the high-risk model after two failed attempts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { AgentsConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { InstanceSettings } from '../src/instance.js';
import { buildModel, capped, DEFAULT_HIGH_RISK_LABELS, modelRouting, routedModel, tierOf } from '../src/model-routing.js';
import { which } from '../src/os/index.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { throughput } from '../src/throughput.js';
import { exampleProject, repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const agents = (o: object = {}) => AgentsConfig.parse({ daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet', hard_issues_model: 'opus' }, evaluator: { enabled: true, model: 'opus' } }, ...o });

test('defaults: haiku for intake replies; sonnet for planning, research, eval answers, the stage judge and builds; opus for high-risk builds; triage keeps its model', () => {
  const r = modelRouting(loadConfig(exampleProject().dir).agents);
  assert.deepEqual(
    { build: r.build, build_high_risk: r.build_high_risk, planner: r.planner, research: r.research, intake_triage: r.intake_triage, intake_replier: r.intake_replier, stage_judge: r.stage_judge, eval_answer: r.eval_answer, escalate_after: r.escalate_after },
    { build: 'sonnet', build_high_risk: 'opus', planner: 'sonnet', research: 'sonnet', intake_triage: 'sonnet', intake_replier: 'haiku', stage_judge: 'sonnet', eval_answer: 'sonnet', escalate_after: 2 },
  );
  assert.deepEqual(r.high_risk_labels, DEFAULT_HIGH_RISK_LABELS);
  assert.equal(routedModel(r, 'intake_replier'), 'haiku');
  // Decision threads: the summary on haiku; questions and picks on sonnet (their held-out score dropped on haiku).
  assert.deepEqual([r.intake_summary, r.intake_thread], ['haiku', 'sonnet']);
});

test('builds: high-risk labels go to the high-risk model; otherwise the build model, escalating after two failed attempts', () => {
  const r = modelRouting(agents());
  assert.deepEqual([1, 2, 3, 4].map((a) => buildModel(r, [], a)), [
    { model: 'sonnet', why: 'default' },
    { model: 'sonnet', why: 'default' },
    { model: 'opus', why: 'escalated' },
    { model: 'opus', why: 'escalated' },
  ]);
  for (const l of ['size:L', 'money-path', 'review:L3', 'high-risk']) assert.deepEqual(buildModel(r, ['bug', l], 1), { model: 'opus', why: 'high-risk' }, l);
  assert.equal(buildModel(modelRouting(agents({ model_routing: { escalate_after: 0 } })), [], 9).model, 'sonnet', '0: never escalates');
  assert.equal(buildModel(modelRouting(agents({ model_routing: { escalate_after: 1 } })), [], 2).model, 'opus');
});

test('overrides: every key in agents.yaml model_routing, validated; a repo naming only its workers\' models keeps them for builds', () => {
  const r = modelRouting(agents({ model_routing: { build: 'claude-sonnet-5-5', build_high_risk: 'claude-opus-5-5', high_risk_labels: ['danger'], planner: 'opus', research: 'opus', intake_triage: 'sonnet', intake_replier: 'sonnet', stage_judge: 'sonnet', eval_answer: 'opus' } }));
  assert.deepEqual([r.build, r.build_high_risk, r.planner, r.research, r.intake_triage, r.intake_replier, r.stage_judge, r.eval_answer], ['claude-sonnet-5-5', 'claude-opus-5-5', 'opus', 'opus', 'sonnet', 'sonnet', 'sonnet', 'opus']);
  assert.equal(buildModel(r, ['size:L'], 1).model, 'claude-sonnet-5-5', 'the repo\'s own high-risk labels replace the defaults');
  assert.equal(buildModel(r, ['danger'], 1).model, 'claude-opus-5-5');
  const legacy = modelRouting(AgentsConfig.parse({ daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'haiku', hard_issues_model: 'sonnet' }, researcher: { enabled: true, model: 'opus' } } }));
  assert.deepEqual([legacy.build, legacy.build_high_risk, legacy.research, legacy.intake_triage], ['haiku', 'sonnet', 'opus', 'opus'], 'triage keeps the researcher\'s model, as before');
  for (const bad of [{ model_routing: { judge: 'opus' } }, { model_routing: { escalate_after: 11 } }, { model_routing: { escalate_after: -1 } }, { model_routing: { planner: '' } }])
    assert.equal(AgentsConfig.safeParse({ daily_budget_usd: 10, roles: {}, ...bad }).success, false, JSON.stringify(bad));
});

test('the instance cap: a model above it runs as the cap; below it, unchanged; a model of unknown tier is capped too', () => {
  assert.deepEqual([tierOf('opus'), tierOf('claude-opus-5-5'), tierOf('claude-sonnet-5-5'), tierOf('claude-haiku-5-5'), tierOf('claude-fable-5-1')], ['opus', 'opus', 'sonnet', 'haiku', null]);
  assert.equal(capped('opus', 'sonnet'), 'sonnet');
  assert.equal(capped('claude-opus-5-5', 'sonnet'), 'sonnet');
  assert.equal(capped('haiku', 'sonnet'), 'haiku');
  assert.equal(capped('claude-sonnet-5-5', 'sonnet'), 'claude-sonnet-5-5');
  assert.equal(capped('claude-fable-5-1', 'opus'), 'opus');
  assert.equal(capped('opus', undefined), 'opus');
  assert.equal(InstanceSettings.safeParse({ model_cap: 'sonnet' }).success, true);
  assert.equal(InstanceSettings.safeParse({ model_cap: 'gpt' }).success, false);
});

test('throughput: usage by model, from run.cost\'s model, per merged PR', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 12, 12, m)).toISOString();
  const events = [
    { type: 'merge.done', ts: at(1), payload: { issue: 1, number: 10, head: 'a'.repeat(40), sha: 'b'.repeat(40), url: 'u', title: 't' } },
    { type: 'run.cost', ts: at(2), payload: { issue: 1, role: 'worker', model: 'claude-sonnet-5-5', usd: 1, turns: 1 } },
    { type: 'run.cost', ts: at(3), payload: { issue: 1, role: 'evaluator-verdict', model: 'opus', usd: 3, turns: 1 } },
    { type: 'run.cost', ts: at(4), payload: { issue: null, role: 'intake-replier', model: 'haiku', usd: 0.5, turns: 1 } },
    { type: 'run.cost', ts: at(5), payload: { issue: 1, role: 'worker', model: 'sonnet', usd: 0.5, turns: 1 } },
  ];
  const t = throughput(events, { now: new Date(Date.UTC(2026, 9, 13)) });
  assert.deepEqual(t.cost.byModel.map((m) => [m.model, m.usd, m.perMergedPrUsd]), [['opus', 3, 3], ['sonnet', 1.5, 1.5], ['haiku', 0.5, 0.5]]);
  assert.equal(t.cost.byModel.reduce((s, m) => s + m.share, 0).toFixed(6), '1.000000');
});

// ---- wired: a build escalates after two failed attempts; the instance cap holds for every run

const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';

async function run(settings: object = {}) {
  const base = mkdtempSync(join(tmpdir(), 'routing-'));
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
  cfg.project.land_mode = 'pr';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const log = new EventLog(join(base, 'events.db'));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  let builds = 0;
  // The first two attempts commit nothing; the third fixes it.
  const runner = new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      if (++builds >= 3) {
        const p = join(req.cwd, 'src', 'price.js');
        writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
        git(req.cwd, 'add', '-A');
        git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      }
      return { structured: { summary: builds >= 3 ? 'fixed' : 'tried' } };
    }
    if (req.role === 'evaluator-repro') return { structured: { test_path: '', explanation: '', not_reproducible: 'covered by the existing test' } };
    const b = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)![1]!;
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: git(req.cwd, 'diff', '--name-only', `${b}..HEAD`).split('\n').filter(Boolean), design_change: false } };
  });
  const c = new Coordinator({ cfg, log, backlog, runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, maxAttempts: 3, settings: () => ({ settings, error: null }), machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  return { runner, log };
}

test('wired: a build that failed twice on the build model runs its third attempt on the high-risk model', { skip }, async () => {
  const t = await run();
  assert.deepEqual(t.runner.calls.filter((r) => r.role === 'worker').map((r) => r.model), ['sonnet', 'sonnet', 'opus']);
  assert.deepEqual(t.log.read(0, ['run.started']).map((e) => e.payload as { role: string; model: string; attempt: number }).filter((p) => p.role === 'worker').map((p) => [p.attempt, p.model]), [[1, 'sonnet'], [2, 'sonnet'], [3, 'opus']]);
  assert.equal(t.log.read(0, ['eval.verdict']).length, 1, 'and it went on to evaluation');
});

test('wired: the instance\'s model cap holds for every run, the escalated build and the evaluator included', { skip }, async () => {
  const t = await run({ model_cap: 'sonnet' });
  assert.deepEqual(t.runner.calls.filter((r) => r.role === 'worker').map((r) => r.model), ['sonnet', 'sonnet', 'sonnet']);
  assert.ok(t.runner.calls.every((r) => r.model === 'sonnet' || r.model === 'haiku'), t.runner.calls.map((r) => `${r.role}:${r.model}`).join(' '));
  assert.ok(t.runner.calls.some((r) => r.role === 'evaluator-verdict'), 'the evaluator ran, capped');
});
