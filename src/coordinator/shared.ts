// What the coordinator's parts share: its dependencies, constants and module-level helpers.
import type { AutomationsPolicy } from '../automations/schema.js';
import type { Get } from '../automations/github.js';
import type { IncidentSink } from '../usage-limit.js';
import type { SlotPathLike } from '../slot-file.js';
import { spawn } from 'node:child_process';
import type { Config, ConfigError } from '../config/load.js';
import { type Backlog, type Issue } from '../backlog/types.js';
import { claim, release } from '../claims.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import { redactString } from '../events/redact.js';
import type { SuiteOptions } from '../harness-evals/replay.js';
import { killTree, killTreeAs, projectCommand, spawnDetached, type ProjectRunAs } from '../os/index.js';
import { type AgentRunner, type CommitIdentity, type RunControl } from '../runner.js';
import { type PendingMessage } from '../console.js';
import type { InstanceSettings } from '../instance.js';
import { type IntakeConfig, type IntakeSource } from '../intake/report.js';
import type { PrTestRuns } from './test-runs.js';
import type { TestRuns } from './pr-batch.js';
import type { RoleOf } from '../dashboard-auth.js';
import type { MainWatchApi } from '../main-watch.js';
import type { MergePostsApi } from '../merge-posts.js';
import type { CiMetricsApi } from '../ci-metrics.js';
import type { DeployGate } from '../deploy-gate/gate.js';
import type { JournalRead } from '../superfan/digest.js';
import type { Previews } from '../preview/previews.js';
import { DEFAULT_GENERATED } from '../config/schema.js';
import type { LockScope } from '../review.js';
import { shownPath } from '../path-text.js';

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
  slotsDir?: SlotPathLike;
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
  /** Project commands' agent user, with what their sandbox hides (src/os projectCommand). */
  commandsAs?: ProjectRunAs;
  /** The instance's GitHub token expiry, from the start-up scope check (null: never expires). */
  tokenExpiresAt?: string | null;
  /** The identity on every commit; agents' commits with any other are rejected. */
  commitIdentity?: CommitIdentity;
  /** The instance's GitHub App key, whose age the reports watch. */
  appKeyPath?: string;
  maxAttempts?: number;
  leaseMs?: number;
  /** WHY: tests shorten it; a task waiting on another's files re-checks this often (ms; default 15 s). */
  ownershipPollMs?: number;
  /** How often each open PR is polled for its checks (ms; default 60 s). */
  prPollMs?: number;
  /** How often the harness's open PRs are read for new reviews that start a fix run (ms; default REVIEW_FIX_POLL_MS, 5 min). */
  reviewPollMs?: number;
  /** The instance policy's auto-merge kill switch, read on every decision (absent or throwing: off). */
  autoMerge?: () => boolean;
  /** The instance's settings (policy.yaml), read every tick; absent: the repo's config as is. */
  settings?: () => { settings: InstanceSettings; error: string | null };
  /**
   * The watchdog's incident model (one alert per incident, one when resolved), when the instance has one: the
   * usage-limit pause raises and resolves its incident there. Absent: the pause reports only through its events.
   */
  incidents?: IncidentSink;
  /**
   * The superfan's view of this instance (src/coordinator/superfan.ts): its name (the incidents' `instance`) and its
   * own service log, read as the coordinator's user (never sudo). Absent (a checkout's coordinator): no superfan.
   */
  superfan?: { name: string; journal?: () => Promise<JournalRead | null> };
  /**
   * Experiment studies (src/coordinator/experiments.ts), server mode only: the instance's name (the root helper's
   * first argument) and its pins file. `helper` and `root` replace the real sudo helper and root's file (tests).
   */
  experiments?: { instance: string; pinsFile: string; helper?: import('./experiments.js').ExperimentHost['helper']; root?: () => import('../experiments/root-file.js').RootState; logTail?: (job: string, step: string) => string };
  /**
   * The config follows the default branch (src/config/live.ts): `tree`, the config tree `cfg` was loaded from
   * (absent: the checkout's HEAD); `check`, checks beyond the schema a new config must pass (an instance's policy).
   */
  liveConfig?: { tree?: string | null; check?: (cfg: Config) => ConfigError[] };
  /**
   * When the last Claude account switch put this instance on a new login and resumed it (src/claude-account.ts,
   * switchedOnto): that time, else null. A usage-limit pause from before it ends then. Absent: only the reset ends it.
   */
  accountSwitched?: () => string | null;
  /** Open-model providers' key files, by credential name (credentials.yaml provider_keys): paths only, never keys. */
  providerKeys?: Record<string, string>;
  /**
   * Whose repo this instance works, for the self-modification locks (src/review.ts LockScope), asked on every review
   * level: root's word only (src/managed-apps.ts readLockScope). Absent (a checkout's coordinator, tests): the engine's.
   */
  lockScope?: () => LockScope;
  /** The clock (tests). */
  now?: () => Date;
  /** Nightly queuing (tests inject this). */
  nightly?: (root: string, cfg: Config, eventsDb: string, actor: string, runAs?: ProjectRunAs) => { id: string }[];
  /** Machine readings (tests inject these). */
  machine?: { load(): number | null; disk(path: string): { freePct: number; totalGb: number; freeGb?: number } };
  /**
   * The harness eval suite (src/harness-evals/; tests inject these): the suite run itself, the engine commit running
   * here, and whether src/ changed between two engine commits. Absent: the real ones.
   */
  harnessEvals?: {
    /** This coordinator is itself a replay's scratch instance: it never runs harness evals (no recursion), whatever its config says. */
    replay?: true;
    suite?: (o: SuiteOptions) => Promise<EventPayload<'harness_eval.run'>>; engine?: () => string | null; changed?: (from: string, to: string) => boolean | null };
  /** How the machine helper is run for the dashboard's machine requests (sudo -n; tests inject it). */
  machineExec?: (file: string, args: string[]) => string;
  /**
   * Work intake (docs/intake.md): the instance's intake config, read on every pass (null: intake is off), and its
   * sources. `pullMs`: how often the sources are pulled (default 30 s). `roleOf`: a person's role on the instance's
   * repo, read as the dashboard reads it (dashboard-auth.ts), for what a mapped chat sender may do (absent: nothing).
   * `typingMs`: how often the typing indicator is sent again while a reply is on its way (default 8 s; tests).
   * `name`: the instance's name, as the dashboard hub knows it (a setup step's one-time link names it).
   */
  intake?: { config: () => IntakeConfig | null; sources: IntakeSource[]; pullMs?: number; roleOf?: RoleOf; typingMs?: number; name?: string };
  /**
   * The fast test runs on every open PR (src/coordinator/test-runs.ts); absent: tests.yaml has no test_run. While the
   * sandbox's check is failing it refuses every run, and `testRuns` and `deployGate` below count as absent.
   */
  prTestRuns?: PrTestRuns;
  /**
   * The disk guard (src/disk-guard.ts): why no new work may start (the disk is full, or below its floor), or null.
   * Absent: never held.
   */
  disk?: { held(): string | null };
  /**
   * The test-run service (src/testrun/: startTestRun, postChecks) for PR-mode batching (tests.yaml land.pr_batch).
   * Absent with batching on: queued PRs wait, and nothing merges untested.
   */
  testRuns?: TestRuns;
  /**
   * The main watch (src/main-watch.ts): its GitHub calls, and the instance policy's main_watch (auto: on when GitHub
   * doesn't protect the default branch; off). Absent: no watch (no GitHub, e.g. a file backlog).
   * `engineBot` (#733): the GitHub App's own bot user, which makes this instance's merges: its login (`<slug>[bot]`) and
   * numeric id, read with the App's credentials (appBotIdentity), never from commit_identity. A merge whose record a
   * crash cut off counts as the engine's (reconciled) only when GitHub's merged_by is exactly this user. Absent or null
   * (a token install, the lookup failed, or no GitHub): never, so such a merge stays unaccounted. `engineBotError`: why
   * the lookup failed at start; the PR watch records once that reconciliation is off until a restart.
   */
  mainWatch?: { api: MainWatchApi; setting?: () => 'auto' | 'off'; now?: () => number; engineBot?: { login: string; id: number } | null; engineBotError?: string };
  /**
   * Merge posts (src/merge-posts.ts): every merge to the default branch posted in intake.yaml's discord.ops_channel
   * (discord.post_merges). Its GitHub calls. Absent: none (no GitHub, e.g. a file backlog).
   */
  mergePosts?: { api: MergePostsApi; now?: () => number };
  /**
   * CI timings for the metrics (src/ci-metrics.ts): merged PRs' CI wall-clock and the default branch's CI jobs' slow
   * tests, read from GitHub. Its GitHub calls. Absent: not measured (no GitHub, e.g. a file backlog).
   */
  ciMetrics?: { api: CiMetricsApi; now?: () => number };
  /**
   * The default branch's protection, as the main watch asks it (src/direct-land.ts): land_mode direct pushes nothing
   * unless GitHub enforces it, asked again before every direct land. Absent: only a remote that is a local path lands.
   */
  protection?: Pick<MainWatchApi, 'protection'>;
  /** A person's role on the repo, from their permission (dashboard-auth.ts): whose PRs get the full run. Absent: nobody's. */
  roleOf?: RoleOf;
  /** The pre-deploy gate (src/deploy-gate/, tests.yaml deploy_gate); absent: off. */
  deployGate?: DeployGate;
  /** docs/previews.md: PR previews; absent, off. */
  previews?: Previews;
  /**
   * Automations (src/coordinator/automations.ts): the instance's automations.yaml, its policy's automations part (read
   * every pass), and a GET for GitHub's listings (absent: no GitHub triggers). Absent: no automations (a checkout).
   */
  automations?: { file: string; policy: () => AutomationsPolicy; github?: Get };
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
export function sh(command: string, cwd: string, timeoutMs = COMMAND_TIMEOUT_MS, runAs?: ProjectRunAs, projectEnv: Record<string, string> = {}, signal?: AbortSignal): Promise<{ code: number | null; tail: string; out: string }> {
  return new Promise((resolveRun) => {
    // Aborted (the coordinator shutting down): never started, or killed like a timed-out command.
    if (signal?.aborted) return resolveRun({ code: null, tail: 'not run: the coordinator is shutting down', out: '' });
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
    const kill = () => {
      timedOut = true;
      if (runAs) killTreeAs(runAs.user, child.pid);
      else killTree(child.pid, () => child.kill('SIGKILL'));
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      // Project code printed it: credential-shaped text never reaches an event or a prompt (#713).
      const clean = redactString(out);
      resolveRun({ code: timedOut ? null : code, tail: clean.trim().split('\n').slice(-20).join('\n'), out: clean });
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
  constructor(message = 'emergency stop') {
    super(message);
  }
}

/**
 * The coordinator is shutting down (SIGTERM or SIGINT: a restart, an update, a stop): its runs are aborted and their
 * tasks requeued to start again after the restart. A kind of halt, so every caller that requeues on a halt does here too.
 */
export class ShuttingDown extends Halted {
  constructor() {
    super('the coordinator is shutting down');
  }
}

/**
 * The instance is paused on the Claude usage limit (src/usage-limit.ts): a run that hit it, or one asked for while
 * the pause holds, which never starts. A kind of halt, so every caller that requeues on a halt requeues on this too.
 */
export class UsagePaused extends Halted {
  constructor(readonly resetAt: string) {
    super(`paused on the Claude usage limit until ${resetAt}`);
  }
}

/**
 * The run's Claude login is held (src/claude-auth-failure.ts): the API refused it, on this run or an earlier one, and
 * no call on it has succeeded since. A run asked for while it holds never starts. A kind of halt, so every caller that
 * requeues on a halt requeues on this too; it never counts as an attempt.
 */
export class AuthPaused extends Halted {
  constructor(readonly login: string, readonly detail: string) {
    super(`Claude sign-in failed on this machine (${login}): no new runs on that login until it works again`);
  }
}

/** The lock scope these deps give now: the engine's when they give none, or asking fails (fails closed). */
export function lockScopeOf(d: Pick<CoordinatorDeps, 'lockScope'>): LockScope {
  try {
    return d.lockScope?.() ?? 'engine';
  } catch {
    return 'engine';
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
  max_pr_lines: 600,
  generated: DEFAULT_GENERATED,
  docs_only_checks: [] as string[],
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
      return `- ${shownPath(r.target)}: ${what}${held}${r.samples ? `, ${r.samples} sample(s) per case` : ''} (~$${r.cost_usd.toFixed(2)})`;
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
