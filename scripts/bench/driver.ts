// The bench driver (#748): runs the task set under the caps, one task at a time, and leaves per-task results, the
// exported patches and the aggregate in the run's folder. Before anything else (any container, any model call, any
// write) it refuses to start without caps, as anyone but the bench user, on a CLI that isn't the pin, without a
// claude.ai login, when the srt sandbox probe reaches a daemon socket or a credential file (probe.ts), on a Docker
// daemon that isn't rootless, with research-on-demand able to run, or when a probe container's memory, CPU or pids
// limit doesn't read back. Its first model call is the sandbox confirmation (confirm.ts): Claude Code itself tries
// the same in its own sandbox, on sentinels; a leak refuses the run. Per task: a fresh container (its limits read back
// first), the task's run (RunTask: the engine's PR-mode loop, wired in the follow-up PR) under the driver's own
// wall-clock cap, which every agent run and container command of the task gets (none starts after it, and the
// driver waits for those in flight before it records the task's spend or starts the next), its patches exported, its
// container removed. At the first usage limit it stops cleanly: the task in flight is aborted and recorded as
// stopped, every later task is "not run (usage limit)", and the aggregate says the run is partial.
//
// Where an agent may write: its Bash commands, only where the sandbox lets them (Claude Code's default: the working
// folder and the temp folder). Its Edit and Write tools run outside the sandbox, as the bench user, and the lane's deny
// list covers reads only. Claude Code asks before any file edit, and the bench runs in dontAsk mode, which refuses
// what would ask; but a run whose allowed tools name Edit or Write unqualified has them pre-approved, and then they can
// change any file the bench user can (its ~/.gitconfig, a shell rc file, ~/.docker/config.json, its ~/.claude
// settings). Nothing in this lane stops that. What the driver reads back after a task is built so it doesn't matter:
// patches come from the clone's objects only, in a repo the driver makes, with no config but its own (grade.ts
// exportPatch), and every claude the driver starts is checked again (auth.ts).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnerOnly } from '../../src/os/index.js';
import type { AgentRunner } from '../../src/runner.js';
import { researchCaps } from '../../src/settings.js';
import type { InstanceSettings } from '../../src/instance.js';
import { aggregate, type Aggregate } from './aggregate.js';
import { isMode, MODE_MAX_USD, PER_TASK_MAX_USD, type Caps } from './caps.js';
import type { LaneInput } from './agent.js';
import type { Login } from './auth.js';
import { confirmSandbox, type SandboxConfirmation } from './confirm.js';
import type { ProbeReport } from './probe.js';
import { Docker, LimitsNotApplied, TaskRunner, type DockerOptions, type Limits, type TaskContainer } from './container.js';
import { exportPatch, runDir } from './grade.js';
import type { BenchLayout } from './paths.js';
import { taskView, type TaskRow, type TaskView } from './hidden.js';
import { TASK_KEY } from './store.js';
import { UsageMeter, type RunUsage } from './usage.js';

/** The instance settings every task's coordinator gets: research-on-demand off (it could fetch the upstream fix). */
export const BENCH_SETTINGS = { research: { max_searches_per_day: 0, max_fetches_per_day: 0, max_usd_per_day: 0 } } as InstanceSettings;

/** Refuses (throws) unless every research cap in `s` is 0. */
export function assertResearchOff(s: InstanceSettings): void {
  const caps = researchCaps(s);
  const on = Object.entries(caps).filter(([, v]) => v !== 0);
  if (on.length) throw new Error(`research-on-demand must be off in the bench (its researcher could find the upstream fix): ${on.map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

export interface BenchTask {
  key: string;
  row: TaskRow;
  image: string;
}

/** A patch to export: the diff of `base`..`head` in the task's clone. */
export interface Head {
  label: string;
  base: string;
  head: string;
}

export interface TaskOutcome {
  decision: 'auto-merge' | 'hold' | 'failed';
  detail?: string;
  /** The task's clone, where the heads are. */
  repo?: string;
  heads: Head[];
}

export interface TaskContext {
  key: string;
  /** What the agents and the container may know of the task. */
  view: TaskView;
  /** The task's agents: metered, capped, stopped at a usage limit. */
  runner: AgentRunner;
  /** Aborted at the first usage limit. */
  signal: AbortSignal;
  /** The task's commands: `docker exec` into its container, nothing else. */
  exec: TaskRunner;
  /** The task's own folder on the host (its clone, local remote and engine state). */
  workDir: string;
  settings: InstanceSettings;
}

export type RunTask = (ctx: TaskContext) => Promise<TaskOutcome>;

export type TaskStatus = TaskOutcome['decision'] | 'error' | 'stopped (usage limit)' | 'not run (usage limit)' | 'not run (spend cap)' | 'not run (limits)' | 'not run (halted)';

export interface TaskResult {
  key: string;
  status: TaskStatus;
  detail?: string;
  usage_equivalent_usd: number;
  runs: RunUsage[];
  patches: string[];
  wall_ms: number;
  /** The driver's wall-clock cap ended the task. */
  wall_cap_hit?: boolean;
  /** The limits its container had, read back before the task started. */
  limits?: Limits;
}

export interface Preflight {
  /** Throws unless this process runs as the bench user (auth.ts requireBenchUser). */
  benchUser: () => string;
  /** Throws unless claude --version is the pin; the version (auth.ts requireClaudePin). */
  claudePin: () => string;
  /** Throws unless claude reports a claude.ai login (auth.ts requireSubscription). */
  subscription: () => Login;
  /**
   * Throws unless every attempt to reach a daemon socket or a credential file from inside the agents' sandbox is
   * refused, under sandbox-runtime 0.0.79 (probe.ts sandboxProbe, with the lane's settings); the per-attempt report.
   */
  sandboxProbe: () => ProbeReport;
}

/** The driver's own wall-clock cap per task, always enforced (the design's 3 h). */
export const TASK_WALL_MS = 3 * 3600_000;
/** After a task's cap, how long its runs in flight get to end (and be recorded) before the bench halts. */
export const SETTLE_MS = 5 * 60_000;

export interface BenchOptions {
  layout: BenchLayout;
  runId: string;
  caps: Caps;
  tasks: BenchTask[];
  preflight: Preflight;
  /** The bench's agents (agent.ts benchClaude, on `lane`). */
  runner: AgentRunner;
  /** The agents' lane (agent.ts benchLane) and what it was made from: the sandbox confirmation runs in it. */
  lane: LaneInput & { settings: unknown };
  /** After a wall-clock cap, how long runs in flight get to end (default SETTLE_MS). */
  settleMs?: number;
  docker: DockerOptions;
  /**
   * The task's base tree, as a tar stream of its base commit, made before any agent runs: what every tree sent to its
   * container is checked against (container.ts TaskRunner). Required.
   */
  baseTree: (task: BenchTask) => Buffer | Promise<Buffer>;
  runTask: RunTask;
  settings?: InstanceSettings;
  /** Per task (default TASK_WALL_MS). */
  taskWallMs?: number;
  /** Every container's memory, CPU and pids limits (container.ts limitsFrom); required. */
  limits: Limits;
  say?: (line: string) => void;
}

function checkCaps(c: Caps | undefined): asserts c is Caps {
  if (!c || !Number.isFinite(c.spendUsd) || !Number.isFinite(c.perTaskUsd) || !(c.spendUsd > 0) || !(c.perTaskUsd > 0)) throw new Error('not run: the bench needs a spend cap (--spend <usd>) and a per-task cap');
  // isMode: MODE_MAX_USD's own keys only, never what every object inherits (constructor, toString, __proto__).
  if (!isMode(c.mode) || c.spendUsd > MODE_MAX_USD[c.mode] || c.perTaskUsd > PER_TASK_MAX_USD || c.perTaskUsd > c.spendUsd) throw new Error(`not run: caps over the owner's approval (${JSON.stringify(c)})`);
}

export async function runBench(o: BenchOptions): Promise<Aggregate> {
  checkCaps(o.caps);
  const settings = o.settings ?? BENCH_SETTINGS;
  assertResearchOff(settings);
  o.preflight.benchUser();
  const claudeVersion = o.preflight.claudePin();
  const login = o.preflight.subscription();
  for (const t of o.tasks) if (!TASK_KEY.test(t.key)) throw new Error(`task key ${t.key} refused`);
  // Option A: from inside sandbox-runtime 0.0.79's sandbox with the agents' lane, every socket and credential refused.
  const probe = o.preflight.sandboxProbe();
  if (!probe.ok) throw new Error('not run: the sandbox probe did not refuse every attempt');
  const limits = o.limits;
  if (!limits || !(limits.memoryBytes > 0 && limits.cpus > 0 && limits.pids > 0)) throw new Error('not run: every container needs a memory, CPU and pids limit');
  const docker = new Docker(o.docker, limits);
  docker.preflight();
  // Fail closed before the first task: a container with the limits, read back from the daemon and its own cgroup.
  if (o.tasks[0]) docker.probe({ name: `bench-${o.runId}-probe`, image: o.tasks[0].image });

  const dir = runDir(o.layout, o.runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meter = new UsageMeter(o.runner, o.caps.spendUsd);

  // Option D, the run's first model call: Claude Code itself tries the same in its own sandbox, on sentinels.
  const checkDir = join(dir, 'sandbox-check');
  mkdirSync(checkDir, { recursive: true, mode: 0o700 });
  const check = meter.task(o.caps.perTaskUsd);
  const confirmation: SandboxConfirmation = await confirmSandbox({ ...o.lane, runner: check, cwd: checkDir, signal: meter.signal });
  const sandbox = { probe, confirmation, usage_equivalent_usd: check.spent, runs: check.runs };
  writeOwnerOnly(join(dir, 'sandbox.json'), JSON.stringify(sandbox, null, 2) + '\n');
  if (confirmation.status === 'leaked') throw new Error(`not run: ${confirmation.detail} (${join(dir, 'sandbox.json')})`);
  if (confirmation.status === 'model declined') o.say?.(`WARNING: ${confirmation.detail}`);

  const results: TaskResult[] = [];
  let limitsFailed: string | null = null;
  let halted: string | null = null;
  const wallMs = o.taskWallMs ?? TASK_WALL_MS;
  const meta = () => ({ run: o.runId, claude_version: claudeVersion, subscription_type: login.subscription_type, caps: o.caps, total_tasks: o.tasks.length, limits, task_wall_ms: wallMs, stopped: meter.limited ? ('usage_limit' as const) : halted ? ('halted' as const) : null, stop_detail: meter.limited?.detail ?? halted ?? null, sandbox: { probe, confirmation: { status: confirmation.status, detail: confirmation.detail, model: confirmation.model, usage_equivalent_usd: check.spent, attempts: confirmation.attempts, skipped: confirmation.skipped } } });
  const write = () => {
    const agg = aggregate(meta(), results);
    writeOwnerOnly(join(dir, 'results.json'), JSON.stringify({ claude_version: claudeVersion, subscription_type: login.subscription_type, limits, sandbox, results }, null, 2) + '\n');
    writeOwnerOnly(join(dir, 'aggregate.json'), JSON.stringify(agg, null, 2) + '\n');
    return agg;
  };

  for (const t of o.tasks) {
    const skip = meter.limited ? 'not run (usage limit)' : halted ? 'not run (halted)' : limitsFailed ? 'not run (limits)' : meter.left < 0.01 ? 'not run (spend cap)' : null;
    if (skip) {
      results.push({ key: t.key, status: skip, usage_equivalent_usd: 0, runs: [], patches: [], wall_ms: 0 });
      continue;
    }
    o.say?.(`${t.key}: starting ($${meter.left.toFixed(2)} of $${o.caps.spendUsd} left)`);
    const started = Date.now();
    const workDir = join(dir, t.key);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const c: TaskContainer = { name: `bench-${o.runId}-${t.key}`, image: t.image };
    // The task's own stop: the wall-clock cap, or the run's usage limit. Every agent run and every command in the
    // container gets it, whatever the task passes; none starts after it fires.
    const wall = new AbortController();
    const signal = AbortSignal.any([meter.signal, wall.signal]);
    const runner = meter.task(o.caps.perTaskUsd, signal);
    let status: TaskStatus = 'error';
    let detail: string | undefined;
    let applied = false;
    const patches: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    const capped = new Promise<'wall'>((resolve) => {
      timer = setTimeout(() => {
        wall.abort();
        resolve('wall');
      }, wallMs);
    });
    try {
      // Its limits read back before any agent or command runs: a limit that didn't apply stops the run here.
      docker.start(c, t.row);
      applied = true;
      const base = await o.baseTree(t);
      const out = await Promise.race([o.runTask({ key: t.key, view: taskView(t.row, t.key), runner, signal, exec: new TaskRunner(o.docker, c, t.row, base, signal), workDir, settings }), capped]);
      if (out === 'wall') {
        status = 'failed';
        detail = `the driver's wall-clock cap (${Math.round(wallMs / 60_000)} min) ended the task`;
      } else {
        status = out.decision;
        detail = out.detail;
        if (out.repo) for (const h of out.heads) patches.push(exportPatch({ layout: o.layout, runId: o.runId, key: t.key, label: h.label, repo: out.repo, base: h.base, head: h.head }));
      }
    } catch (e) {
      if (e instanceof LimitsNotApplied) limitsFailed = e.message;
      detail = (e as Error).message.slice(0, 500);
    } finally {
      clearTimeout(timer);
      // Its runs in flight end (aborted at the cap) and are recorded before its spend is, and before the next task.
      if (!(await runner.settled(o.settleMs ?? SETTLE_MS))) {
        halted = `${t.key}: an agent run was still going ${Math.round((o.settleMs ?? SETTLE_MS) / 1000)} s after the task ended; the bench stopped rather than overlap the next task`;
        detail = halted;
        status = 'error';
      }
      docker.stop(c);
    }
    if (meter.limited) {
      status = 'stopped (usage limit)';
      detail = meter.limited.detail;
    }
    results.push({ key: t.key, status, ...(detail ? { detail } : {}), usage_equivalent_usd: runner.spent, runs: runner.runs, patches: patches.map((p) => p.slice(dir.length + 1)), wall_ms: Date.now() - started, ...(wall.signal.aborted ? { wall_cap_hit: true } : {}), ...(applied ? { limits } : {}) });
    o.say?.(`${t.key}: ${status} ($${runner.spent.toFixed(2)} usage-equivalent)`);
    write();
  }
  const agg = write();
  if (meter.limited) o.say?.(`stopped at a usage limit: ${meter.limited.detail}${meter.limited.reset_at ? ` (resets ${meter.limited.reset_at})` : ''}; no retry. The aggregate is partial.`);
  return agg;
}
