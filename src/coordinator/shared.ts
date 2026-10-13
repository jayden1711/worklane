// What the coordinator's parts share: its dependencies, constants and module-level helpers.
import { spawn } from 'node:child_process';
import type { Config } from '../config/load.js';
import { type Backlog, type Issue } from '../backlog/types.js';
import { claim, release } from '../claims.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import { killTree, killTreeAs, projectCommand, spawnDetached } from '../os/index.js';
import { type AgentRunner, type CommitIdentity, type RunAs, type RunControl } from '../runner.js';
import { type PendingMessage } from '../console.js';
import type { InstanceSettings } from '../instance.js';
import { type IntakeConfig, type IntakeSource } from '../intake/report.js';
import type { PrTestRuns } from './test-runs.js';
import type { TestRuns } from './pr-batch.js';
import type { RoleOf } from '../dashboard-auth.js';
import type { MainWatchApi } from '../main-watch.js';

export interface CoordinatorDeps {
  cfg: Config;
  log: EventLog;
  backlog: Backlog;
  runner: AgentRunner;
  /** The coordinator's own clone of the project (it fetches, lands and pushes here). */
  repo: string;
  remote?: string;
  instance: string;
  stateDir: string;
  /** Slot directory override (tests). */
  slotsDir?: string;
  /**
   * Where task files go when agents run as their own user: a directory the agent user can read but not
   * write (group `gid`, 2750; files 0640), outside the worktree. Without it, task files stay in stateDir.
   */
  agentTasks?: { dir: string; gid: number };
  /**
   * The instance's root (beside its checkout), where its dependency cache lives, and the agents' group: set only
   * when agents run as their own user. Without it there is no shared cache.
   */
  depCacheRoot?: { dir: string; gid: number };
  /** The OS user project commands run as (checks, gates, setup, full runs): the agent user, never the coordinator's. */
  commandsAs?: RunAs;
  /** The instance's GitHub token expiry, from the start-up scope check (null: never expires). */
  tokenExpiresAt?: string | null;
  /** The identity on every commit; agents' commits with any other are rejected. */
  commitIdentity?: CommitIdentity;
  /** The instance's GitHub App key, whose age the reports watch. */
  appKeyPath?: string;
  maxAttempts?: number;
  leaseMs?: number;
  /** How often each open PR is polled for its checks (ms; default 60 s). */
  prPollMs?: number;
  /** The instance policy's auto-merge kill switch, read on every decision (absent or throwing: off). */
  autoMerge?: () => boolean;
  /** The instance's settings (policy.yaml), read every tick; absent: the repo's config as is. */
  settings?: () => { settings: InstanceSettings; error: string | null };
  /** Open-model providers' key files, by credential name (credentials.yaml provider_keys): paths only, never keys. */
  providerKeys?: Record<string, string>;
  /** The clock (tests). */
  now?: () => Date;
  /** Nightly queuing (tests inject this). */
  nightly?: (root: string, cfg: Config, eventsDb: string, actor: string, runAs?: RunAs) => { id: string }[];
  /** Machine readings (tests inject these). */
  machine?: { load(): number | null; disk(path: string): { freePct: number; totalGb: number } };
  /** How the machine helper is run for the dashboard's machine requests (sudo -n; tests inject it). */
  machineExec?: (file: string, args: string[]) => string;
  /**
   * Work intake (docs/intake.md): the instance's intake config, read on every pass (null: intake is off), and its
   * sources. `pullMs`: how often the sources are pulled (default 30 s). `roleOf`: a person's role on the instance's
   * repo, read as the dashboard reads it (dashboard-auth.ts), for what a mapped chat sender may do (absent: nothing).
   */
  intake?: { config: () => IntakeConfig | null; sources: IntakeSource[]; pullMs?: number; roleOf?: RoleOf };
  /** The fast test runs on every open PR (src/coordinator/test-runs.ts); absent: tests.yaml has no test_run, or no sandbox. */
  prTestRuns?: PrTestRuns;
  /**
   * The test-run service (src/testrun/: startTestRun, postChecks) for PR-mode batching (tests.yaml land.pr_batch).
   * Absent with batching on: queued PRs wait, and nothing merges untested.
   */
  testRuns?: TestRuns;
  /**
   * The main watch (src/main-watch.ts): its GitHub calls, and the instance policy's main_watch (auto: on when GitHub
   * doesn't protect the default branch; off). Absent: no watch (no GitHub, e.g. a file backlog).
   */
  mainWatch?: { api: MainWatchApi; setting?: () => 'auto' | 'off'; now?: () => number };
  /** A person's role on the repo, from their permission (dashboard-auth.ts): whose PRs get the full run. Absent: nobody's. */
  roleOf?: RoleOf;
}

/** The default for tests.yaml command_timeout_s (2 hours), for a command run without the config. */
export const COMMAND_TIMEOUT_MS = 2 * 3600_000;
/** How often the worktree pool is checked against main's tip. */
export const POOL_CHECK_MS = 5 * 60_000;
/** When GitHub is still computing whether a PR can merge, look again this soon. */
export const MERGEABLE_RECHECK_MS = 10_000;
/** How often the default branch's tip is checked for a merge (which can make open PRs conflict). */
export const TIP_CHECK_MS = 15_000;
/** A wait on the Claude login shorter than this isn't worth an event. */
export const LOCK_WAIT_RECORDED_MS = 1_000;
/** How many times an issue blocked on a rate limit or budget is requeued on its own before it waits for a person. */
export const RETRY_CAP = 3;
/** When a rate-limit or budget block may retry: a rate limit after its window (5 h), a budget at the next UTC midnight. */
export function retryAfter(kind: 'rate_limit' | 'budget', now = Date.now()): { kind: 'rate_limit' | 'budget'; after: Date } {
  if (kind === 'rate_limit') return { kind, after: new Date(now + 5 * 3600_000) };
  const d = new Date(now);
  return { kind, after: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)) };
}
/** How long a fix run waits on an issue claim held elsewhere (from the first time it found it so) before giving up. */
export const CLAIM_HELD_GIVE_UP_MS = 3600_000;

/**
 * Run a project command without blocking the event loop: with several agents
 * in flight, a blocking test run would starve their output streams and trip
 * their stall timers. Output is capped; the tail is kept for reports.
 */
export function sh(command: string, cwd: string, timeoutMs = COMMAND_TIMEOUT_MS, runAs?: RunAs, projectEnv: Record<string, string> = {}): Promise<{ code: number | null; tail: string; out: string }> {
  return new Promise((resolveRun) => {
    const { file, args, env } = projectCommand(command, runAs, projectEnv);
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: spawnDetached });
    let out = '';
    const take = (d: Buffer) => {
      out += d.toString();
      if (out.length > 32_000_000) out = out.slice(-16_000_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (runAs) killTreeAs(runAs.user, child.pid);
      else killTree(child.pid, () => child.kill('SIGKILL'));
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolveRun({ code: timedOut ? null : code, tail: out.trim().split('\n').slice(-20).join('\n'), out });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}



/** An issue's lane: its lane:<name> label, if any (otherwise the runner's default lane). */
export const laneOf = (issue: Issue): { lane?: string } => {
  const l = issue.labels.find((x) => x.startsWith('lane:'));
  return l ? { lane: l.slice(5) } : {};
};

/** An emergency stop interrupted this task. */
/** The owner stopped this run from the console. */
export class StoppedByOwner extends Error {
  constructor(readonly by: string) {
    super(`stopped by @${by} from the console`);
  }
}

/** A live run, as the console holds it. */
export interface LiveEntry {
  key: string;
  /** The run's id (its record and feed), once the session is up. */
  run: string | null;
  control: RunControl | null;
  issue: number | null;
  role: string;
  model: string;
  startedAt: string;
  pending: PendingMessage[];
  stoppedBy: string | null;
}

export class Halted extends Error {
  constructor() {
    super('emergency stop');
  }
}

export const DEFAULT_REVIEW = {
  version: 1 as const,
  categories: {},
  levels: {
    L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
    L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
    L2_notify: { when: ['app-non-money-large', 'dependency', 'test-machinery'] },
    L3_human: { when: ['money-path', 'migration', 'auth', 'secrets', 'deploy-config', 'release-config', 'harness-config', 'guardrail-config', 'deletes-data'], over_lines: 800 },
  },
  merge: { auto: true, max_lines: 800, max_files: 20, wait_categories: [] as string[], loosened: [] as string[] },
  delegation: { enabled: false, min_clean: 10 },
};

/** The PR body's lines for instruction evals: base and head scores, the cost, and every case that changed. */
export function evalLines(results: EventPayload<'instructions.eval'>[]): string[] {
  if (!results.length) return [];
  const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');
  const total = results.reduce((s, r) => s + r.cost_usd, 0);
  return [
    `**Instruction evals** (base → head; ~$${total.toFixed(2)}, the CLI's cost estimate):`,
    ...results.map((r) => {
      const changed = r.changes.filter((c) => !(c.base === 'pass' && c.head === 'pass')).map((c) => `case ${c.id} ${c.base} → ${c.head}`);
      const what = r.error ? `not evaluated: ${r.error}` : `visible ${score(r.base)} → ${score(r.result)}${r.dropped ? ', **lower**' : ''}${r.incomplete ? ', incomplete (cost cap)' : ''}${changed.length ? `; ${changed.join(', ')}` : ''}`;
      const h = r.held_out;
      const held = r.error || h === undefined ? '' : h === null ? `; held-out: none${r.held_out_error ? ` (${r.held_out_error})` : ''}` : `; held-out ${score(h.base)} → ${score(h.result)}${h.dropped ? ', **lower**' : ''}${h.incomplete ? ', incomplete (cost cap)' : ''}`;
      return `- ${r.target}: ${what}${held}${r.samples ? `, ${r.samples} sample(s) per case` : ''} (~$${r.cost_usd.toFixed(2)})`;
    }),
  ];
}

/** The end of a CI job log, for a fix run's brief: the last lines, without the runner's per-line timestamps. */
export function logTail(text: string, lines = 150, chars = 12_000): string {
  const out = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z /, ''))
    .slice(-lines)
    .join('\n');
  return out.length > chars ? out.slice(-chars) : out;
}

/** The blocked comment for a refused push: every reason, one per line. */
export function pushRefusal(reasons: string[]): string {
  return `the push was refused:\n${reasons.map((r) => `- ${r}`).join('\n')}`;
}
