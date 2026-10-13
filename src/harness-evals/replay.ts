// Replaying a fixed past task through the real coordinator: a scratch instance (its own event log, a file backlog,
// its own state and slots) on a scratch clone whose default branch is the task's base commit, pushed to a local bare
// remote, so nothing reaches GitHub. The agents are the real ones (the runner given), within the run's budget. A
// scratch clone is deleted when its replay ends.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from '../brand.js';
import { FileBacklog } from '../backlog/file.js';
import { loadConfig } from '../config/load.js';
import { Coordinator } from '../coordinator.js';
import type { CoordinatorDeps } from '../coordinator/shared.js';
import { EventLog } from '../events/log.js';
import type { EventPayload, EventType } from '../events/types.js';
import { DEFAULT_COMMIT_IDENTITY, type AgentRunner, type RunRequest, type RunResult } from '../runner.js';
import { round, scoreReplay, totals, type TaskScore } from './score.js';
import { issueBody, type LoadedTask } from './tasks.js';

/**
 * The run's budget over every agent run in it: each run is capped at what is left, and once it is spent no run
 * starts (it ends as budget_exhausted, as a real budget stop does), so the replay in flight stops and no other starts.
 */
export class BudgetRunner implements AgentRunner {
  spent = 0;
  hit = false;
  constructor(
    private inner: AgentRunner,
    readonly budgetUsd: number,
  ) {}
  get left(): number {
    return Math.max(0, this.budgetUsd - this.spent);
  }
  /** Under a cent left counts as spent: no run can do anything with it. */
  get exhausted(): boolean {
    return this.hit || this.left < 0.01;
  }
  async run(req: RunRequest): Promise<RunResult> {
    if (this.exhausted) {
      this.hit = true;
      return { reason: 'budget_exhausted', detail: `the harness eval budget ($${this.budgetUsd}) is spent`, costUsd: 0, turns: 0, model: req.model };
    }
    const cap = Math.min(req.maxBudgetUsd, this.left);
    const r = await this.inner.run({ ...req, maxBudgetUsd: cap });
    this.spent = round(this.spent + r.costUsd);
    if (r.reason === 'budget_exhausted' && cap < req.maxBudgetUsd) this.hit = true;
    if (this.left < 0.01) this.hit = true;
    return r;
  }
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }).trim();

/** The engine's own identity on the scratch config commit, as an agent session commits. */
function commit(cwd: string, msg: string) {
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

/**
 * The scratch instance's config, committed on top of the base: a file backlog, direct landing into the local remote,
 * and nothing scheduled (no nightly runs, test runs, deploy gate, gardener, or harness evals of its own). The daily
 * budget is at most the run's.
 */
export function scratchConfig(root: string, budgetUsd: number): void {
  const dir = join(root, BRAND.configDir);
  const edit = (file: string, fn: (d: ReturnType<typeof parseDocument>) => void) => {
    const f = join(dir, file);
    if (!existsSync(f)) return;
    const d = parseDocument(readFileSync(f, 'utf8'));
    fn(d);
    writeFileSync(f, d.toString());
  };
  edit('config.yaml', (d) => {
    d.set('backlog', 'file');
    d.set('land_mode', 'direct');
    d.deleteIn(['gardener']);
    d.setIn(['gardener', 'enabled'], false);
    d.deleteIn(['harness_evals']);
  });
  edit('tests.yaml', (d) => {
    for (const k of ['nightly_at', 'test_run', 'deploy_gate']) d.delete(k);
  });
  edit('agents.yaml', (d) => {
    const cur = Number(d.get('daily_budget_usd') ?? budgetUsd);
    d.set('daily_budget_usd', Math.min(Number.isFinite(cur) ? cur : budgetUsd, budgetUsd));
  });
}

export interface ReplayOptions {
  runner: BudgetRunner;
  /** Where scratch clones go (each in its own new directory, deleted after). */
  workDir: string;
  /** Where to fetch the task's base from: a local clone that has it, or the repository's URL. */
  source: (t: LoadedTask) => string;
  sample: number;
  /** Ticks before a replay that hasn't finished is given up (unfinished). */
  maxTicks?: number;
  /** Wall-clock cap per replay. */
  timeoutMs?: number;
  /** Keep the scratch clone (debugging). */
  keep?: boolean;
  signal?: AbortSignal;
  /** Instance wiring passed through to the scratch coordinator (agents as their own user). */
  deps?: Pick<CoordinatorDeps, 'commandsAs' | 'agentTasks' | 'depCacheRoot' | 'commitIdentity'>;
  /** Readings for the scratch coordinator's machine gates (tests); default: never held by load or disk. */
  machine?: CoordinatorDeps['machine'];
  say?: (line: string) => void;
}

export interface ReplayResult extends TaskScore {
  wallMs: number;
}

/** Events that end a replay: the change is queued to land, the owner is asked, or the task is blocked. */
const ENDS: EventType[] = ['land.queued', 'decision.asked', 'issue.blocked'];

export async function replayTask(t: LoadedTask, o: ReplayOptions): Promise<ReplayResult> {
  const dir = join(o.workDir, `${t.id}-${o.sample}-${randomBytes(3).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  let log: EventLog | null = null;
  try {
    const remote = join(dir, 'remote.git');
    const root = join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', remote);
    git(remote, 'fetch', '-q', '--depth', '1', o.source(t), t.base);
    const cfgText = (() => {
      try {
        return git(remote, 'show', `${t.base}:${BRAND.configDir}/config.yaml`);
      } catch {
        throw new Error(`${t.repo} at ${t.base.slice(0, 8)} has no ${BRAND.configDir}/config.yaml`);
      }
    })();
    const branch = String((parseDocument(cfgText).getIn(['project', 'default_branch']) as string | undefined) ?? 'main');
    git(remote, 'update-ref', `refs/heads/${branch}`, t.base);
    git(remote, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    git(dir, 'clone', '-q', remote, root);
    for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false'], ['maintenance.auto', 'false'], ['gc.auto', '0']] as const) git(root, 'config', k, v);
    scratchConfig(root, o.runner.budgetUsd);
    git(root, 'add', '--', BRAND.configDir);
    commit(root, `${BRAND.cli} harness eval: scratch instance config`);
    git(root, 'push', '-q', 'origin', branch);

    const cfg = loadConfig(root);
    const state = join(dir, 'state');
    const slots = join(state, 'slots');
    mkdirSync(slots, { recursive: true });
    writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 1 }));
    log = new EventLog(join(state, 'events.db'));
    const backlog = new FileBacklog(join(state, 'backlog.json'));
    const owner = cfg.project.owners.default;
    const n = backlog.open({ title: t.title, body: issueBody(t), author: owner, labels: ['ready', ...t.labels] });
    const instance = `harness-eval@${t.id}`;
    const c = new Coordinator({ cfg, log, backlog, runner: o.runner, repo: root, instance, stateDir: state, slotsDir: slots, harnessEvals: { replay: true }, machine: o.machine ?? { load: () => 0, disk: () => ({ freePct: 80, totalGb: 500 }) }, ...(o.deps ?? {}) });
    const stop = () => c.stop();
    o.signal?.addEventListener('abort', stop, { once: true });
    const started = Date.now();
    const ended = () => log!.read(0, ENDS).some((e) => (e.payload as { issue: number | null }).issue === n);
    try {
      log.append('coordinator.started', { instance, pid: process.pid, version: 'harness-eval' }, instance);
      const maxTicks = o.maxTicks ?? 6;
      for (let i = 0; i < maxTicks; i++) {
        await c.tick();
        await c.idle();
        if (ended() || o.runner.exhausted || o.signal?.aborted) break;
        if (Date.now() - started > (o.timeoutMs ?? 3 * 3600_000)) break;
      }
    } finally {
      o.signal?.removeEventListener('abort', stop);
      c.stop();
      await c.idle();
    }
    const wallMs = Date.now() - started;
    return { ...scoreReplay(log.read(), n, { budgetHit: o.runner.hit && !ended() }), wallMs };
  } finally {
    log?.close();
    if (!o.keep) rmSync(dir, { recursive: true, force: true });
  }
}

export interface SuiteOptions extends Omit<ReplayOptions, 'sample' | 'runner'> {
  tasks: LoadedTask[];
  samples: number;
  budgetUsd: number;
  /** The agents (the instance's runner, or a CLI runner); wrapped in the run's budget. */
  runner: AgentRunner;
  trigger: EventPayload<'harness_eval.run'>['trigger'];
  engine: string | null;
  pr: number | null;
  /** Records each event in the instance's own log. */
  emit: <T extends EventType>(type: T, payload: EventPayload<T>) => void;
  /** Replays a task (tests inject this); default: replayTask. */
  replay?: (t: LoadedTask, o: ReplayOptions) => Promise<ReplayResult>;
}

/**
 * Run the suite: every task, `samples` times, in order, within the budget. Each replay is recorded as it ends
 * (harness_eval.task, and its spend as a run.cost so the instance's daily budget counts it); then the run
 * (harness_eval.run). Once the budget is spent, nothing more starts and the run says it stopped there.
 */
export async function runSuite(o: SuiteOptions): Promise<EventPayload<'harness_eval.run'>> {
  const id = `he-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const runner = new BudgetRunner(o.runner, o.budgetUsd);
  const replay = o.replay ?? replayTask;
  const done: EventPayload<'harness_eval.task'>[] = [];
  let error: string | undefined;
  outer: for (const t of o.tasks) {
    for (let s = 1; s <= o.samples; s++) {
      if (runner.exhausted || o.signal?.aborted) break outer;
      o.say?.(`replaying ${t.id} (sample ${s} of ${o.samples}; $${runner.left.toFixed(2)} of $${o.budgetUsd} left)`);
      const before = runner.spent;
      let r: ReplayResult;
      try {
        r = await replay(t, { ...o, runner, sample: s });
      } catch (e) {
        const spent = round(runner.spent - before);
        r = { success: false, doneWhen: null, verdict: null, outcome: 'error', costUsd: spent, interventions: 0, detail: (e as Error).message.slice(0, 500), wallMs: 0 };
      }
      const p: EventPayload<'harness_eval.task'> = { run: id, task: t.id, held_out: t.heldOut, sample: s, success: r.success, done_when: r.doneWhen, verdict: r.verdict, outcome: r.outcome, cost_usd: r.costUsd, wall_ms: r.wallMs, interventions: r.interventions, detail: r.detail };
      o.emit('harness_eval.task', p);
      if (r.costUsd > 0) o.emit('run.cost', { issue: null, role: 'harness-eval', model: 'mixed', usd: r.costUsd, turns: 0 });
      done.push(p);
      o.say?.(`  ${t.id}: ${r.success ? 'pass' : 'FAIL'} (${r.outcome}) $${r.costUsd.toFixed(2)}, ${(r.wallMs / 60_000).toFixed(1)} min, ${r.interventions} intervention(s)${r.detail ? `: ${r.detail.slice(0, 200)}` : ''}`);
    }
  }
  if (!o.tasks.length) error = 'no tasks';
  const tot = totals(done);
  const run: EventPayload<'harness_eval.run'> = {
    id,
    trigger: o.trigger,
    engine: o.engine,
    pr: o.pr,
    tasks: new Set(done.map((d) => d.task)).size,
    samples: o.samples,
    runs: tot.runs,
    passed: tot.passed,
    cost_usd: tot.costUsd,
    wall_ms: tot.wallMs,
    interventions: tot.interventions,
    budget_usd: o.budgetUsd,
    stopped: runner.exhausted && done.length < o.tasks.length * o.samples ? 'budget' : runner.hit ? 'budget' : null,
    ...(error ? { error } : {}),
  };
  o.emit('harness_eval.run', run);
  return run;
}
