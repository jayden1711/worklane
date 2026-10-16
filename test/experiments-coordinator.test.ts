// Experiment studies, wired (src/coordinator/experiments.ts): a real coordinator, a fake runner and a fake root
// helper. The baseline waits for an owner; an experimenter session has no shell and no job tool, and its one proposal
// becomes one job; a change to the eval never runs; a running job blocks the next session; a changed eval on the
// default branch stops new sessions; a job cut off by a restart is recorded stopped and never run again; agents are
// denied the jobs' state by guardrail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  metric: { name: 'val_loss', direction: 'min', min_delta: 0.01 },
  eval: { predict: 'python eval/predict.py', score: 'python eval/score.py', files: ['eval/score.py', 'eval/predict.py'], inputs: 'eval-inputs', labels: 'eval-labels' },
  train: { command: 'python train.py', data: ['train-set'], env: { lockfile: 'uv.lock', build: 'true' } },
  editable: ['train.py'],
  config_schema: { lr: { type: 'number', min: 0.0001, max: 0.1 } },
  budget: { gpu_hours_per_day: 4, agent_usd_per_day: 5, agent_usd_total: 60, max_jobs: 200 },
  confirm_runs: 0,
};
const root: RootState = { state: 'on', file: { devices: [0], max_minutes: 60, gpu_hours_per_day: 8, output_gb: 50, env_network: false, sources: { 'train-set': { sha256: 'a'.repeat(64), visibility: 'job' }, 'eval-inputs': { sha256: 'b'.repeat(64), visibility: 'job' }, 'eval-labels': { sha256: 'c'.repeat(64), visibility: 'scorer' } } } };

type Call = { args: string[]; stdin: string };

function fixture(answer: (req: RunRequest) => object = () => ({})) {
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
  const runner = new FakeRunner((req) => ({ structured: answer(req), costUsd: 0.3 }));
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
  const helper: ExperimentHost['helper'] = async (args, stdin) => {
    calls.push({ args, stdin: stdin.toString() });
    if (args[0] === 'eval-seal' && !calls.some((c) => c.args[0] === 'eval-put')) return { code: 1, stdout: '', stderr: 'no eval' };
    if (args[0] === 'job') {
      if (hold) await hold;
      const score = scores.shift() ?? 3;
      return { code: 0, stdout: `worklane-exp: job started\n${BRAND.cli}-exp: record ${JSON.stringify({ protocol: 1, job: args[1], outcome: 'scored', step: null, score, gpu_seconds: 600, waited_s: 2, gpus: [0], output_kb: 10 })}\n`, stderr: '' };
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
  return { base, seed, repo, log, runner, calls, scores, pass, of, approve, tickOnly: () => loop().tick(), idle: () => loop().idle(), restart: () => void (c = make()), holdJobs: (p: Promise<void> | null) => void (hold = p) };
}

const jobCalls = (calls: Call[]) => calls.filter((c) => c.args[0] === 'job');

test('the baseline: no agent session, waits for an owner as the first job of the version, then one job through the helper and kept', async () => {
  const t = fixture();
  await t.pass();
  assert.equal(t.runner.calls.length, 0, 'the baseline runs the study\'s own code: no session');
  const p = t.of('experiment.proposed')[0]!;
  assert.deepEqual(p.approval, ['the first job of this study version']);
  await t.pass();
  assert.equal(jobCalls(t.calls).length, 0, 'not before an owner approves');
  t.approve(p.job as string);
  await t.pass();
  assert.equal(jobCalls(t.calls).length, 1);
  assert.deepEqual(t.calls.map((c) => c.args[0]), ['eval-seal', 'eval-put', 'eval-put', 'eval-seal', 'create', 'job', 'wipe']);
  const spec = jobCalls(t.calls)[0]!.stdin;
  assert.match(spec, /STUDY=example-speed\0/);
  assert.match(spec, /LABELS=eval-labels\0/);
  assert.ok(t.of('experiment.job_started')[0]!.gpu === 'planned', 'gpu=planned before the job runs');
  const r = t.of('experiment.recorded')[0]!;
  assert.deepEqual([r.decision, r.score, r.gpu_minutes], ['keep', 3, 10]);
});

test('a session: no shell and no job tool, one structured proposal, the eval frozen; its edit becomes one commit and one job', async () => {
  const t = fixture((req) => {
    writeFileSync(join(req.cwd, 'train.py'), 'lr = 0.02\n');
    return { hypothesis: 'A higher learning rate', motivation: 'the baseline looks slow', expected_effect: 'lower loss', config: { lr: 0.02 } };
  });
  t.scores.push(3, 2.5);
  await t.pass();
  t.approve(t.of('experiment.proposed')[0]!.job as string);
  await t.pass();
  await t.pass();
  const run = t.runner.calls[0]!;
  assert.deepEqual(run.allowedTools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
  assert.ok(run.disallowedTools?.includes('Bash') && run.disallowedTools.includes('WebFetch'));
  assert.equal(run.jsonSchema, PROPOSAL_SCHEMA);
  const task = JSON.parse(readFileSync(run.taskFile!, 'utf8')) as { frozen: string[] };
  assert.ok(task.frozen.includes('eval/score.py') && task.frozen.includes(`${BRAND.configDir}/**`));
  const p = t.of('experiment.proposed')[1]!;
  assert.deepEqual([p.files, p.approval, p.config], [['train.py'], [], { lr: 0.02 }]);
  assert.match(git(t.repo, 'show', `${p.commit as string}:train.py`), /lr = 0\.02/);
  await t.pass();
  assert.equal(jobCalls(t.calls).length, 2, 'one job for the one proposal');
  assert.deepEqual(t.of('experiment.recorded').map((r) => r.decision), ['keep', 'keep']);
  assert.ok(t.of('experiment.cost').length === 1 && t.of('run.cost').some((c) => c.role === 'experimenter'), 'the session\'s cost counts');
});

test('a change to the eval never runs: refused and logged; no job', async () => {
  const t = fixture((req) => {
    writeFileSync(join(req.cwd, 'eval', 'score.py'), 'print("score=0")\n');
    return { hypothesis: 'h', motivation: 'm', expected_effect: 'e', config: {} };
  });
  await t.pass();
  t.approve(t.of('experiment.proposed')[0]!.job as string);
  await t.pass();
  await t.pass();
  assert.match(t.of('experiment.refused')[0]!.why as string, /eval file eval\/score\.py/);
  assert.equal(jobCalls(t.calls).length, 1, 'the baseline only');
});

test('never a second session while a job runs', async () => {
  const t = fixture(() => ({ hypothesis: 'h', motivation: 'm', expected_effect: 'e', config: {} }));
  let release!: () => void;
  t.holdJobs(new Promise((r) => (release = r)));
  await t.pass();
  t.approve(t.of('experiment.proposed')[0]!.job as string);
  t.tickOnly();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(jobCalls(t.calls).length, 1, 'the job is running');
  for (let i = 0; i < 3; i++) t.tickOnly();
  assert.equal(t.of('experiment.session').length, 1, 'no new session while the job runs');
  release();
  await t.idle();
});

test('a changed eval on the default branch starts no session until an owner confirms the new version', async () => {
  const t = fixture(() => ({ hypothesis: 'h', motivation: 'm', expected_effect: 'e', config: {} }));
  writeFileSync(join(t.seed, 'eval', 'score.py'), 'print("score=0")\n');
  commitAll(t.seed, 'eval change');
  git(t.seed, 'push', '-q', 'origin', 'main');
  await t.pass();
  assert.equal(t.of('experiment.session').length, 0);
});

test('a job cut off by a restart is recorded stopped, never run again by itself', async () => {
  const t = fixture();
  await t.pass();
  const job = t.of('experiment.proposed')[0]!.job as string;
  t.approve(job);
  t.log.append('experiment.job_started', { study: 'example-speed', job, n: 1, gpu: 'planned' }, 'alice');
  t.restart();
  await t.pass();
  const r = t.of('experiment.recorded')[0]!;
  assert.deepEqual([r.decision, r.step], ['stopped', 'cut-off']);
  assert.equal(jobCalls(t.calls).length, 0);
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
