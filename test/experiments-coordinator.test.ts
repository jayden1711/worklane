// Experiment studies, wired (src/coordinator/experiments.ts): a real coordinator, a fake runner and a fake root
// helper. The baseline waits for an owner; an experimenter session has no shell and no job tool, and its one proposal
// becomes one job; a change to the eval never runs; a running job blocks the next session; a changed eval on the
// default branch stops new sessions; a job cut off by a restart is recorded stopped and never run again; agents are
// denied the jobs' state by guardrail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { BRAND } from '../src/brand.js';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { currentPin, type ExperimentHost, type ExperimentLoop } from '../src/coordinator/experiments.js';
import { EventLog } from '../src/events/log.js';
import { PROPOSAL_SCHEMA } from '../src/experiments/proposal.js';
import type { RootState } from '../src/experiments/root-file.js';
import { Study } from '../src/experiments/study.js';
import { runHook } from '../src/hook.js';
import { etcPath, expBasePath } from '../src/os/system-paths.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitAll = (cwd: string, msg: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
};
const study = {
  id: 'example-speed',
  goal: 'Lower validation loss',
  eval: { predict: 'python eval/predict.py', score: 'python eval/score.py', files: ['eval/score.py'], predict_files: ['eval/predict.py'], inputs: 'eval-inputs', labels: 'eval-labels' },
  train: { command: 'python train.py', data: ['train-set'], env: { lockfile: 'uv.lock', build: 'true' } },
  editable: ['train.py'],
  config_schema: { lr: { type: 'number', min: 0.0001, max: 0.1 } },
  budget: { gpu_hours_per_day: 4, agent_usd_per_day: 5, agent_usd_total: 60, max_jobs: 200 },
  screen: { margin: 0.05, seeds: 2 },
  metric: { name: 'val_loss', direction: 'min', min_delta: 0.01, anomaly_margin: 0.5 },
};
const root: RootState = { state: 'on', file: { devices: [0], max_minutes: 20, gpu_hours_per_day: 8, output_gb: 50, env_network: false, tasks_max: 1024, memory_gb: 16, cpu_cores: 4, sources: { 'train-set': { sha256: 'a'.repeat(64), visibility: 'job' }, 'eval-inputs': { sha256: 'b'.repeat(64), visibility: 'job' }, 'eval-labels': { sha256: 'c'.repeat(64), visibility: 'scorer' } } } };

type Call = { args: string[]; stdin: string };

function fixture(answer: (req: RunRequest) => object | Promise<object> = () => ({}), monitor: (req: RunRequest) => object = () => ({ flagged: false, findings: [] }), stream: unknown[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'exp-coord-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  mkdirSync(join(seed, 'eval'));
  writeFileSync(join(seed, 'eval', 'score.py'), 'print("score=1")\n');
  writeFileSync(join(seed, 'eval', 'predict.py'), 'pass\n');
  writeFileSync(join(seed, 'train.py'), 'lr = 0.01\n');
  writeFileSync(join(seed, BRAND.configDir, 'experiments.yaml'), stringify({ version: 1, studies: [study] }));
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  commitAll(seed, 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  const cfg = loadConfig(repo);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const log = new EventLog(join(base, 'events.db'));
  const runner = new FakeRunner((req) => (req.role === 'experiment-monitor' ? { structured: monitor(req), costUsd: 0.05 } : Promise.resolve(answer(req)).then((structured) => ({ structured, costUsd: 0.3, stream }))));
  // The pins as an owner's Start writes them: the version of the study, its eval and root's sources at main's tip.
  const tip = git(repo, 'rev-parse', 'origin/main');
  const show = (commit: string, path: string) => {
    try {
      return execFileSync('git', ['show', `${commit}:${path}`], { cwd: repo });
    } catch {
      return null;
    }
  };
  const pin = currentPin({ show }, Study.parse(study), tip, root);
  assert.ok('pin' in pin);
  const pinsFile = join(base, 'experiments.yaml');
  writeFileSync(pinsFile, stringify({ version: 1, studies: { 'example-speed': { ...pin.pin, started_by: 'example-owner', started_at: '2026-10-15T12:00:00Z' } } }), { mode: 0o600 });
  const calls: Call[] = [];
  const scores: number[] = [];
  let hold: Promise<void> | null = null;
  const put = new Set<string>();
  const helper: ExperimentHost['helper'] = async (args, stdin) => {
    calls.push({ args, stdin: stdin.toString() });
    if (args[0] === 'eval-put') put.add(args[1]!);
    if (args[0] === 'eval-seal' && !put.has(args[1]!)) return { code: 1, stdout: '', stderr: 'no eval' };
    if (args[0] === 'job') {
      if (hold) await hold;
      const score = scores.shift() ?? 3;
      return { code: 0, stdout: `worklane-exp: job started\n${BRAND.cli}-exp: record ${JSON.stringify({ protocol: 2, job: args[1], outcome: 'scored', step: null, score, gpu_seconds: 600, waited_s: 2, gpus: [0], output_kb: 10, timings: { train_ms: 5, predict_ms: 3, score_ms: 1 } })}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const make = () => new Coordinator({ cfg, log, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, experiments: { instance: 'ex', pinsFile, helper, root: () => root, logTail: () => '' } });
  let c = make();
  const loop = () => (c as unknown as { experiments(): ExperimentLoop }).experiments();
  const pass = async () => {
    loop().tick();
    await loop().idle();
  };
  const of = (type: string) => log.read(0, [type as never]).map((e) => e.payload as Record<string, unknown>);
  const approve = (job: string) => log.append('experiment.approval', { study: 'example-speed', job, answer: 'approve', by: 'example-owner' }, 'example-owner');
  /** Pass after pass until nothing more starts (approving the baseline): at most `n` passes. */
  const run = async (n = 30) => {
    for (let i = 0; i < n; i++) {
      for (const p of of('experiment.proposed')) if ((p.approval as string[]).length && !of('experiment.approval').some((a) => a.job === p.job)) approve(p.job as string);
      const before = log.read().length;
      await pass();
      if (log.read().length === before) return;
    }
  };
  return { base, seed, repo, log, runner, calls, scores, pass, run, of, approve, tickOnly: () => loop().tick(), idle: () => loop().idle(), restart: () => void (c = make()), holdJobs: (p: Promise<void> | null) => void (hold = p) };
}



const jobCalls = (calls: Call[]) => calls.filter((c) => c.args[0] === 'job');
const specOf = (c: Call) => Object.fromEntries(c.stdin.split('\0').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
let edits = 0;
const lrUp = (req: RunRequest) => {
  writeFileSync(join(req.cwd, 'train.py'), `lr = 0.0${++edits + 1}\n`);
  return { hypothesis: 'A different training loop', variable: 'the code in train.py', motivation: 'the baseline looks slow', expected_effect: 'lower loss', config: {} };
};

test('the baseline: no agent session, waits for an owner as the first job, then one job through the helper and kept', async () => {
  const t = fixture();
  await t.pass();
  assert.equal(t.runner.calls.length, 0);
  const p = t.of('experiment.proposed')[0]!;
  assert.deepEqual(p.approval, ['the first job of this study version']);
  await t.pass();
  assert.equal(jobCalls(t.calls).length, 0, 'not before an owner approves');
  t.approve(p.job as string);
  await t.pass();
  assert.equal(jobCalls(t.calls).length, 1);
  const spec = specOf(jobCalls(t.calls)[0]!);
  assert.equal(spec.METRIC, 'score');
  assert.notEqual(spec.PREDICT_EVAL, 'none');
  assert.notEqual(spec.PREDICT_EVAL, spec.EVAL, 'the predict step\'s copy is never the scorer\'s');
  assert.equal(t.of('experiment.recorded')[0]!.decision, 'keep');
});

test('an agent session never sees the eval: not in its copy, denied by the hook, and not in its prompt', async () => {
  let seen: { score: boolean; predict: boolean } | null = null;
  let denied = '';
  let allowed = '';
  const t = fixture(async (req) => {
    seen = { score: existsSync(join(req.cwd, 'eval', 'score.py')), predict: existsSync(join(req.cwd, 'eval', 'predict.py')) };
    // The hook as the session's own tool calls meet it, during the session: a Read of where the scorer would be.
    const hook = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: req.cwd, tool_name: 'Read', tool_input: { file_path: join(req.cwd, 'eval', 'score.py') } }, { ...process.env, [`${BRAND.envPrefix}_AGENT`]: '1', [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile! });
    denied = (JSON.parse(hook.stdout ?? '{}') as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? '';
    const own = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: req.cwd, tool_name: 'Read', tool_input: { file_path: join(req.cwd, 'train.py') } }, { ...process.env, [`${BRAND.envPrefix}_AGENT`]: '1', [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile! });
    allowed = (JSON.parse(own.stdout || '{}') as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? 'none';
    return lrUp(req);
  });
  await t.run(3);
  const run = t.runner.calls.find((r) => r.role === 'experimenter')!;
  assert.deepEqual(seen, { score: false, predict: false }, 'the eval files are out of its worktree');
  const task = JSON.parse(readFileSync(run.taskFile!, 'utf8')) as { hidden: string[] };
  assert.ok(task.hidden.includes('eval/score.py') && task.hidden.includes('eval/predict.py') && task.hidden.includes(`${BRAND.configDir}/**`));
  for (const never of ['score.py', 'predict.py', 'python eval', 'eval-labels']) assert.ok(!`${run.prompt}\n${run.appendSystemPrompt}`.includes(never), `the prompt names ${never}`);
  assert.equal(denied, 'deny', 'the hook denies the eval\'s path in its copy');
  assert.notEqual(allowed, 'deny', 'while its own files stay readable');
  assert.deepEqual(run.allowedTools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
  assert.equal(run.jsonSchema, PROPOSAL_SCHEMA);
});

test('a two-change proposal is refused: one variable per round', async () => {
  const t = fixture((req) => {
    writeFileSync(join(req.cwd, 'train.py'), 'lr = 0.02\n');
    return { hypothesis: 'h', variable: 'both', motivation: 'm', expected_effect: 'e', config: { lr: 0.02 } };
  });
  await t.run(3);
  assert.match(t.of('experiment.refused')[0]!.why as string, /more than one variable changed \(knob lr, code\)/);
});

test('a change to the eval never runs: refused and logged', async () => {
  const t = fixture((req) => {
    mkdirSync(join(req.cwd, 'eval'), { recursive: true });
    writeFileSync(join(req.cwd, 'eval', 'score.py'), 'print("score=0")\n');
    return { hypothesis: 'h', variable: 'v', motivation: 'm', expected_effect: 'e', config: {} };
  });
  await t.run(3);
  assert.ok(!t.of('experiment.proposed').some((p) => (p.files as string[]).includes('eval/score.py')), 'what it wrote there was overwritten by the pinned file');
  assert.match(t.of('experiment.refused')[0]!.why as string, /no change|nothing changed/);
});

test('a stage-1 winner triggers N seeds of both arms at equal budget; a loser is never run again', async () => {
  const t = fixture(lrUp);
  // baseline 3; candidate 2.8 (passes the screen); seeds: candidate 2.8, 2.81 / best 3.0, 3.01; then a loser at 2.99.
  t.scores.push(3, 2.8, 2.8, 3.0, 2.81, 3.01, 2.99);
  await t.run(20);
  const kinds = t.of('experiment.session').map((s) => `${s.kind}${s.arm ? `:${s.arm}` : ''}`);
  assert.deepEqual(kinds.slice(0, 6), ['baseline', 'exploit', 'seed:candidate', 'seed:best', 'seed:candidate', 'seed:best']);
  const seedSpecs = jobCalls(t.calls).slice(2, 6).map(specOf);
  assert.deepEqual(new Set(seedSpecs.map((x) => `${x.MINUTES}/${x.GPUS}/${x.OUTPUT_GB}`)).size, 1, 'the same budget for every seed of both arms');
  const judged = t.of('experiment.judged')[0]!;
  assert.equal(judged.decision, 'keep');
  assert.equal((judged.stage2 as { minutesCandidate: number; minutesBest: number }).minutesCandidate, (judged.stage2 as { minutesBest: number }).minutesBest);
  const loser = t.of('experiment.recorded').find((r) => r.decision === 'screened_out')!;
  assert.ok(loser, 'the next candidate was screened out');
  assert.ok(!t.of('experiment.session').some((s) => s.of === loser.n), 'a stage-1 loser is never run again');
});

test('the tampering monitor reads the whole transcript; a finding holds the job for the owner and never reaches a session', async () => {
  const stream = [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'maybe I can find where the labels live' }, { type: 'tool_use', name: 'Glob', input: { pattern: '**/labels*' } }] } }];
  let monitorPrompt = '';
  const t = fixture(lrUp, (req) => {
    monitorPrompt = req.prompt;
    return { flagged: true, findings: ['it searched for the labels (FINDING-MARKER)'] };
  }, stream);
  await t.pass();
  t.approve(t.of('experiment.proposed')[0]!.job as string);
  await t.pass();
  await t.pass();
  const mon = t.runner.calls.find((r) => r.role === 'experiment-monitor')!;
  assert.deepEqual(mon.allowedTools, [], 'no tools');
  assert.match(monitorPrompt, /maybe I can find where the labels live/, 'it reads the reasoning');
  assert.match(monitorPrompt, /\[tool Glob\]/, 'and the tool calls');
  const p = t.of('experiment.proposed')[1]!;
  assert.ok((p.approval as string[]).includes('held for an owner\'s review before it runs'));
  assert.equal(t.of('experiment.monitor')[0]!.flagged, true);
  assert.ok(t.of('experiment.cost').some((c) => String(c.session).endsWith('-monitor')), 'its cost counts against the study');
  // Approve it and let the next session start: its prompt never carries the finding.
  t.approve(p.job as string);
  await t.run(12);
  for (const r of t.runner.calls.filter((x) => x.role === 'experimenter')) assert.ok(!`${r.prompt}${r.appendSystemPrompt}`.includes('FINDING-MARKER'));
});

test('a job cut off by a restart is recorded stopped, never run again by itself', async () => {
  const t = fixture();
  await t.pass();
  const job = t.of('experiment.proposed')[0]!.job as string;
  t.approve(job);
  t.log.append('experiment.job_started', { study: 'example-speed', job, n: 1, gpu: 'planned' }, 'alice');
  t.restart();
  await t.pass();
  assert.deepEqual([t.of('experiment.recorded')[0]!.decision, t.of('experiment.recorded')[0]!.step], ['stopped', 'cut-off']);
  assert.equal(jobCalls(t.calls).length, 0);
});

test('a changed eval on the default branch starts nothing until an owner confirms the new version', async () => {
  const t = fixture();
  writeFileSync(join(t.seed, 'eval', 'score.py'), 'print("score=0")\n');
  commitAll(t.seed, 'eval change');
  git(t.seed, 'push', '-q', 'origin', 'main');
  await t.pass();
  assert.equal(t.of('experiment.session').length, 0);
});

test('an agent session is denied the jobs\' state and root\'s experiment files, by tool and by shell argument', { skip: !posix && 'POSIX paths' }, async () => {
  const { dir, stateDir } = exampleProject();
  const decision = (out: { stdout?: string }) => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision : 'none');
  const call = (tool: string, input: Record<string, unknown>) => runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: dir, tool_name: tool, tool_input: input }, { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir, [`${BRAND.envPrefix}_AGENT`]: '1' });
  const labels = `${expBasePath()}/ex/data/eval-labels/y.txt`;
  assert.equal(decision(await call('Read', { file_path: labels })), 'deny');
  assert.equal(decision(await call('Bash', { command: `cat ${labels}` })), 'deny');
  assert.equal(decision(await call('Read', { file_path: `${etcPath('experiments')}/ex.json` })), 'deny');
  assert.notEqual(decision(await call('Read', { file_path: join(dir, 'README.md') })), 'deny');
});
