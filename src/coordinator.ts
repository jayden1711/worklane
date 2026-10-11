// The coordinator: deterministic code (no LLM) that claims, schedules,
// verifies, levels, lands and deploys. Every step is an event; the next
// step is decided from events plus GitHub, so a restart picks up where the
// log says it was. Agents only ever propose: they commit on their own
// branch in their own worktree; everything outward-facing happens here.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import type { ReviewConfig } from './config/schema.js';
import { actionable, contractKey, ownerFor, parseContract, type Backlog, type CommitCheck, type DoneWhenList, type Issue, type PullRequest } from './backlog/types.js';
import { claim, release, renew, type Lease } from './claims.js';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { globToRegExp } from './guardrails/glob.js';
import { agentReadableDir, cpuCount, diskFree, groupOnlyDir, killTree, killTreeAs, machineLoad, projectCommand, spawnDetached, writeAgentReadable, writeGroupOnly } from './os/index.js';
import { computeLevel, loadMoneyPaths, type ChangeFile, type Level } from './review.js';
import { defaultRolePrompt, INVESTIGATION_SCHEMA, issueBrief, REPRO_SCHEMA, rolePrompt, VERDICT_SCHEMA, WORKER_SCHEMA } from './roles.js';
import { compareInstructions, engineRoleCases, instructionTargets, parseCases, runnerAsk } from './skilleval.js';
import { DEFAULT_COMMIT_IDENTITY, type AgentRunner, type CommitIdentity, type RunAs, type RunControl, type RunResult } from './runner.js';
import { MAX_MESSAGE, takeRequests, writeLive, type PendingMessage } from './console.js';
import { chatTurn, contextFromEvents, recentRuns, takeChatRequests, writeChatAnswer, type ChatRequest } from './chat.js';
import { machineStats } from './os/stats.js';
import { checkedPush, pushProblems } from './push-check.js';
import { allowedOnce, domainDecision, withAllowedHost, type DomainAnswer, type RefusedRequest } from './domain-requests.js';
import { needsPlan, objection, PLAN_DISALLOWED, PLAN_SCHEMA, PLAN_TOOLS, planAnswer, planBrief, planComment, planDecision, planExtra, planHoldReasons, readPlan, type Plan, type PlanAnswer } from './plan-mode.js';
import { DEFAULT_HOTSPOTS, estimateFiles, fileIndex, holdReason, hotspotsIn, pickDispatch, type FileIndex, type Hold } from './hotspots.js';
import { conflictBrief, conflictFixesUsed, conflictTrigger, conflictVerdictSchema, conflictWaitReasons, outsideHunks, parseConflicts, type Side } from './conflicts.js';
import { abortMerge, changedFiles, mergeBaseInto } from './merge-base.js';
import { importsOf, lightCheckPlan, lightOutcome } from './light-check.js';
import { runIssue } from './run-record.js';
import { applySettings, inRunWindow } from './settings.js';
import type { InstanceSettings } from './instance.js';
import { readiness, requiredOutcomes, type Readiness } from './pr-watch.js';
import { instructionEvalReasons, mergeDecision, type MergeDecision } from './merge-policy.js';
import { scanRange } from './scan/secrets.js';
import { emergencyStop, fullRunLock, tryAgentSlot } from './slots.js';
import { nightlyDue, queueNightly } from './nightly.js';
import { buildReport, dueSlot, recentRunRecords } from './reports.js';
import { baselineGate, latestBaseline } from './baseline.js';
import { countAssertions } from './vacuity.js';
import { createWorktree, removeSandboxPlaceholders, removeWorktree, type WorktreeOptions } from './worktrees.js';

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
  /** The clock (tests). */
  now?: () => Date;
  /** Nightly queuing (tests inject this). */
  nightly?: (root: string, cfg: Config, eventsDb: string, actor: string, runAs?: RunAs) => { id: string }[];
  /** Machine readings (tests inject these). */
  machine?: { load(): number | null; disk(path: string): { freePct: number; totalGb: number } };
}

const COMMAND_TIMEOUT_MS = 2 * 3600_000;
/** When GitHub is still computing whether a PR can merge, look again this soon. */
const MERGEABLE_RECHECK_MS = 10_000;
/** How often the default branch's tip is checked for a merge (which can make open PRs conflict). */
const TIP_CHECK_MS = 15_000;
/** A wait on the Claude login shorter than this isn't worth an event. */
const LOCK_WAIT_RECORDED_MS = 1_000;

/**
 * Run a project command without blocking the event loop: with several agents
 * in flight, a blocking test run would starve their output streams and trip
 * their stall timers. Output is capped; the tail is kept for reports.
 */
function sh(command: string, cwd: string, timeoutMs = COMMAND_TIMEOUT_MS, runAs?: RunAs, projectEnv: Record<string, string> = {}): Promise<{ code: number | null; tail: string; out: string }> {
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

/** A failed worker run shorter than this that committed nothing never got to work. */
export const STARTUP_FAILURE_SECS = 90;

export class Coordinator {
  private readonly remote: string;
  private readonly wt: WorktreeOptions;
  private active = new Map<number, Promise<void>>();
  /** The hotspot files each running task is expected to change. */
  private taskHotspots = new Map<number, string[]>();
  private fileIx: { key: string; ix: FileIndex } | null = null;
  /** The default branch's tip as last seen, and when it was last checked. */
  private defaultTip = '';
  private tipCheckedAt = 0;
  /** PRs whose combined-state check is running. */
  private lightRunning = new Set<number>();
  /** When each watched PR was last polled (ms). */
  private prPolled = new Map<number, number>();
  /** Live runs, for the console. */
  private live = new Map<string, LiveEntry>();
  /** Chat turns, one at a time. */
  private chatQueue: Promise<void> = Promise.resolve();
  /** The repo's own config: the defaults the instance's settings apply over. */
  private readonly repoCfg: Config;
  private settingsKey = '';
  /** When each auto-merge's commit on the default branch was last polled (ms). */
  private mainPolled = new Map<string, number>();
  private landing = false;
  private stopped = false;
  /** Aborted by an emergency stop: every agent run gets this signal. */
  private halt = new AbortController();

  constructor(private d: CoordinatorDeps) {
    // Every agent run carries the halt signal; a run after a halt never starts.
    const runner = d.runner;
    this.d = {
      ...d,
      runner: {
        run: async (req) => {
          if (this.halt.signal.aborted) throw new Halted();
          // Waits on the Claude login and transient retries are recorded for every run, with its issue and role.
          const who = { issue: req.issue ?? runIssue(req.cwd, req.taskFile), role: req.role, model: req.model };
          // The console holds every live run's input: listed for the dashboard while it runs.
          const live: LiveEntry = { key: randomBytes(4).toString('hex'), run: null, control: null, issue: who.issue, role: req.role, model: req.model, startedAt: new Date().toISOString(), pending: [], stoppedBy: null };
          this.live.set(live.key, live);
          // Hosts the owner allowed once for this task reach its next build run (worker, CI fix, conflict fix) only.
          const once = who.issue !== null && req.role === 'worker' ? allowedOnce(this.d.log.read(0, ['network.domain_decided', 'run.started']), who.issue) : [];
          let r: RunResult;
          try {
            r = await runner.run({
              ...req,
              ...(once.length ? { allowOnce: [...new Set([...(req.allowOnce ?? []), ...once])] } : {}),
              signal: req.signal ?? this.halt.signal,
              onLockWait: (ms) => {
                if (ms >= LOCK_WAIT_RECORDED_MS) this.emit('run.lock_waited', { ...who, wait_ms: Math.round(ms) });
                req.onLockWait?.(ms);
              },
              onTransientRetry: (t) => {
                this.emit('run.transient_retry', { ...who, attempt: t.attempt, cause: t.cause, wait_ms: Math.round(t.waitMs), detail: t.detail.slice(0, 300) });
                req.onTransientRetry?.(t);
              },
              onControl: (c) => {
                // A retried start is a new session: its own id and handle.
                live.control = c;
                live.run = c.runId;
                this.writeLive();
                req.onControl?.(c);
              },
              onMessage: (m) => {
                const at = live.pending.findIndex((p) => p.id === m.id);
                if (m.state !== 'queued' && at >= 0) {
                  live.pending.splice(at, 1);
                  this.emit(m.state === 'delivered' ? 'console.message_delivered' : 'console.message_dropped', { run: live.run ?? live.key, issue: live.issue, role: live.role, id: m.id });
                  this.writeLive();
                }
                req.onMessage?.(m);
              },
            });
          } finally {
            this.live.delete(live.key);
            this.writeLive();
          }
          // A host the run was refused becomes the owner's decision (once per task and host); nothing is widened here.
          if (r.refusedHosts?.length && who.issue !== null) {
            try {
              await this.noteRefusedHosts(who.issue, req.role, live.run, r.refusedHosts);
            } catch (e) {
              this.emit('coordinator.error', { instance: this.d.instance, where: `domain request #${who.issue}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
            }
          }
          if (live.stoppedBy) throw new StoppedByOwner(live.stoppedBy);
          if (this.halt.signal.aborted) throw new Halted();
          return r;
        },
      },
    };
    this.repoCfg = d.cfg;
    this.remote = d.remote ?? 'origin';
    this.wt = { repo: d.repo, root: d.cfg.tests.worktree.root, stateDir: d.stateDir, setup: d.cfg.tests.worktree.setup, env: d.cfg.tests.env, ...(d.commandsAs ? { runAs: d.commandsAs } : {}) };
  }

  /** A project command (check, gate, pre-land step): it runs agent-written code, so it runs as the agent user. */
  private project(command: string, cwd: string) {
    return sh(command, cwd, COMMAND_TIMEOUT_MS, this.d.commandsAs, this.d.cfg.tests.env);
  }

  private get branch() {
    return this.d.cfg.project.project.default_branch;
  }
  private git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  private emit<T extends Parameters<EventLog['append']>[0]>(type: T, payload: EventPayload<T>) {
    return this.d.log.append(type, payload, this.d.instance);
  }
  private events(issue?: number): StoredEvent[] {
    const all = this.d.log.read();
    return issue === undefined ? all : all.filter((e) => (e.payload as { issue?: number }).issue === issue);
  }

  private lastSeen(issue: number): unknown {
    return this.d.log
      .read(0, ['issue.seen'])
      .filter((e) => (e.payload as { issue: number }).issue === issue)
      .at(-1)?.payload;
  }

  /** USD spent today (UTC) by all runs, from the log. */
  spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    return this.d.log.read(0, ['run.cost']).filter((e) => e.ts.startsWith(day)).reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
  }

  // ---------------------------------------------------------------- tick

  /** One deterministic pass: reconcile, handle approvals, land, dispatch. */
  async tick(): Promise<void> {
    // Each step is guarded on its own: a GitHub hiccup in reconcile must not stop landing or dispatch.
    const step = async <T>(where: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        this.emit('coordinator.error', { instance: this.d.instance, where, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
        return fallback;
      }
    };
    this.checkEmergency();
    this.checkConsole();
    void this.checkChat();
    await step('settings', () => this.refreshSettings(), undefined);
    const reconciled = await step('reconcile', () => this.reconcile(), 0);
    await step('nightly', () => this.maybeNightly(), undefined);
    await step('report', () => this.maybeReport(), undefined);
    await step('decisions', () => this.handleDecisions(), undefined);
    await step('land', () => this.landNext(), undefined);
    await step('prs', () => this.watchPrs(), undefined);
    await step('merged', () => this.watchMerges(), undefined);
    const dispatched = await step('dispatch', () => this.dispatch(), 0);
    this.emit('coordinator.tick', { instance: this.d.instance, dispatched, reconciled });
  }

  /**
   * After a crash or restart: a task that was mid-pipeline (claimed, not yet
   * queued for landing or waiting on a decision) has no live run anymore, so
   * it's released and requeued; its history stays in the log. Queued
   * landings and open decisions resume from the log on their own.
   */
  async recover(): Promise<number[]> {
    // A CI fix run cut off by a restart: release its claim and record it; the PR watch decides what's next.
    for (const e of this.d.log.read(0, ['ci_fix.started'])) {
      const p = e.payload as EventPayload<'ci_fix.started'>;
      if (this.active.has(p.issue) || this.d.log.read(e.id, ['ci_fix.finished']).some((f) => (f.payload as { number: number }).number === p.number)) continue;
      release(p.issue, p.lease, { repo: this.d.repo, remote: this.remote });
      this.emit('ci_fix.finished', { issue: p.issue, number: p.number, outcome: 'interrupted', head: null, detail: 'coordinator restarted mid-run' });
    }
    // The same for a conflict fix run (it still counts toward the PR's cap).
    for (const e of this.d.log.read(0, ['conflict_fix.started'])) {
      const p = e.payload as EventPayload<'conflict_fix.started'>;
      if (this.active.has(p.issue) || this.d.log.read(e.id, ['conflict_fix.finished']).some((f) => (f.payload as { number: number }).number === p.number)) continue;
      release(p.issue, p.lease, { repo: this.d.repo, remote: this.remote });
      this.emit('conflict_fix.finished', { issue: p.issue, number: p.number, base_sha: p.base_sha, strategy: p.strategy, outcome: 'interrupted', head: null, files: [], waits_owner: false, reasons: [], detail: 'coordinator restarted mid-run' });
    }
    const requeued: number[] = [];
    for (const e of this.d.log.read(0, ['issue.claimed'])) {
      const n = (e.payload as { issue: number }).issue;
      if (this.isTerminal(n) || this.active.has(n) || requeued.includes(n)) continue;
      const after = this.events(n).filter((x) => x.id > e.id);
      const waiting = after.some((x) => x.type === 'land.queued' || x.type === 'decision.asked');
      if (waiting) continue;
      this.releaseClaim(n, 'coordinator restarted mid-task; requeued');
      await this.d.backlog.removeLabel(n, 'agent:working');
      await this.d.backlog.addLabels(n, ['ready']);
      await this.d.backlog.comment(n, `[${BRAND.cli}] The coordinator restarted while this was in progress; requeued from the start.`);
      requeued.push(n);
    }
    return requeued;
  }

  /** Wait for in-flight task pipelines (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()]);
    await this.chatQueue;
  }

  /**
   * Honor the machine-wide emergency stop: abort every running agent (their
   * tasks release their claims and requeue) and start nothing new until it
   * is lifted. Called every tick and on a short timer by the service.
   */
  checkEmergency(): void {
    const stop = emergencyStop(this.d.slotsDir);
    if (stop && !this.halt.signal.aborted) {
      this.emit('emergency.stop', { by: stop.by, reason: stop.reason, running: this.active.size });
      this.halt.abort();
    } else if (!stop && this.halt.signal.aborted) {
      this.emit('emergency.resume', { instance: this.d.instance });
      this.halt = new AbortController();
    }
  }

  stop() {
    this.stopped = true;
  }

  private async reconcile(): Promise<number> {
    // Tasks whose issue was closed elsewhere are cancelled, never re-dispatched.
    let n = 0;
    for (const e of this.d.log.read(0, ['issue.claimed'])) {
      const issue = (e.payload as { issue: number }).issue;
      if (this.isTerminal(issue)) continue;
      const gh = await this.d.backlog.get(issue);
      if (gh.state === 'closed') {
        this.emit('issue.released', { issue, instance: this.d.instance, why: 'issue closed on GitHub' });
        n++;
      }
    }
    return n;
  }

  private isTerminal(issue: number): boolean {
    const last = this.events(issue).filter((e) => ['issue.released', 'deploy.verified', 'land.result', 'issue.claimed'].includes(e.type)).at(-1);
    if (!last) return true;
    if (last.type === 'issue.released' || last.type === 'deploy.verified') return true;
    if (last.type === 'land.result') return (last.payload as { outcome: string }).outcome === 'landed' && !this.d.cfg.deploy?.environments.some((x) => !x.production && x.trigger);
    return false;
  }

  private lastHold: string | null = null;

  /** Post the report for the latest configured time already passed today, once. */
  async maybeReport(now = new Date()) {
    const slot = dueSlot(this.d.cfg.project.reports.times, now);
    if (!slot) return;
    const day = now.toLocaleDateString('en-CA');
    const posted = this.d.log.read(0, ['report.posted']);
    if (posted.some((e) => (e.payload as { day: string; slot: string }).day === day && (e.payload as { slot: string }).slot === slot)) return;
    const last = posted.at(-1);
    const since = last ? new Date(last.ts) : new Date(now.getTime() - 12 * 3_600_000);
    const events = this.d.log.read();
    const runRecords = recentRunRecords(this.d.stateDir, new Date(now.getTime() - 7 * 86_400_000));
    const report = buildReport(events, this.d.cfg, { since, now, slot, runRecords, ...(this.d.tokenExpiresAt !== undefined ? { tokenExpiresAt: this.d.tokenExpiresAt } : {}), ...(this.d.appKeyPath ? { appKeyPath: this.d.appKeyPath } : {}) });
    // A fix proposed for a repeated failure goes to the owner's Inbox once; it changes nothing until answered.
    const asked = new Set(events.filter((e) => e.type === 'decision.asked').flatMap((e) => (e.payload as { receipts: string[] }).receipts));
    for (const p of report.proposals) {
      if (asked.has(`key: ${p.key}`)) continue;
      await this.ask('question', null, this.d.cfg.project.owners.default, p.question, p.options, p.recommendation, [`key: ${p.key}`, ...p.receipts]);
    }
    const to = this.d.cfg.project.reports.to.length ? this.d.cfg.project.reports.to : [this.d.cfg.project.owners.default];
    const mention = to.map((u) => `@${u}`).join(' ');
    let issue = (await this.d.backlog.list('report'))[0]?.number ?? null;
    if (issue === null) issue = await this.d.backlog.createIssue(`${BRAND.name} reports`, `Scheduled ${BRAND.name} reports are posted here as comments (${this.d.cfg.project.reports.times.join(' and ')}).`, ['report']);
    await this.d.backlog.comment(issue, `${report.markdown}\n\n${mention}`.trim());
    this.emit('report.posted', { day, slot, issue });
  }

  /** Queue the nightly runs once a day, after tests.yaml nightly_at. */
  private maybeNightly() {
    const last = this.d.log.read(0, ['nightly.queued']).at(-1)?.payload as { day: string } | undefined;
    if (!nightlyDue(this.d.cfg.tests.nightly_at, last?.day ?? null)) return;
    const jobs = (this.d.nightly ?? queueNightly)(this.d.repo, this.d.cfg, this.d.log.path, this.d.instance, this.d.commandsAs);
    this.emit('nightly.queued', { day: new Date().toLocaleDateString('en-CA'), jobs: jobs.map((j) => j.id) });
  }

  /** Why no new agent may start right now, or null. Load and disk are machine-wide. */
  governorHold(): { reason: string; load: number | null; freeDiskPct: number | null } | null {
    const m = this.d.machine ?? { load: machineLoad, disk: diskFree };
    const load = m.load();
    const disk = m.disk(this.d.repo);
    const est = this.d.cfg.tests.worktree.est_size_gb;
    const freeAfter = disk.freePct - (est / Math.max(disk.totalGb, 1)) * 100;
    const maxLoad = this.d.cfg.project.governor.max_load ?? cpuCount() * 2;
    const minFree = this.d.cfg.project.governor.min_free_disk_pct;
    if (this.spentToday() >= this.d.cfg.agents.daily_budget_usd) return { reason: `daily budget $${this.d.cfg.agents.daily_budget_usd} reached`, load, freeDiskPct: disk.freePct };
    if (load !== null && load > maxLoad) return { reason: `machine load ${load.toFixed(0)} > ${maxLoad}`, load, freeDiskPct: disk.freePct };
    if (freeAfter < minFree) return { reason: `free disk would drop to ${freeAfter.toFixed(1)}% (< ${minFree}%) with another ${est} GB worktree`, load, freeDiskPct: disk.freePct };
    return null;
  }

  private noteHold(h: ReturnType<Coordinator['governorHold']>) {
    const key = h?.reason.replace(/[\d.]+/g, '#') ?? null; // record changes of reason, not every reading
    if (key === this.lastHold) return;
    this.lastHold = key;
    if (h) this.emit('governor.hold', { reason: h.reason, load: h.load, free_disk_pct: h.freeDiskPct });
    else this.emit('governor.release', { load: (this.d.machine?.load ?? machineLoad)(), free_disk_pct: null });
  }

  /**
   * The instance's settings (policy.yaml), re-read every tick: when they change, the repo's config with
   * them applied becomes the config in effect, without a restart. Refused settings: the repo's values.
   */
  /** The live runs list the dashboard reads (only runs whose session is up: they have an id). */
  private writeLive() {
    writeLive(
      this.d.stateDir,
      [...this.live.values()].filter((l) => l.run).map((l) => ({ run: l.run!, issue: l.issue, role: l.role, model: l.model, startedAt: l.startedAt, pending: l.pending })),
    );
  }

  /**
   * The console's requests from the dashboard (called every few seconds and on each tick): message or stop
   * a live run. Only the owner's are acted on; every outcome is an event.
   */
  /**
   * The dashboard chat's questions (called every few seconds and on each tick). Each is answered by a
   * chief_of_staff turn through this coordinator's runner, so it holds the per-login lock like every run and
   * never overlaps another claude on the same login. Turns go one at a time; the returned promise is the queue.
   */
  checkChat(): Promise<void> {
    for (const q of takeChatRequests(this.d.stateDir)) this.chatQueue = this.chatQueue.then(() => this.chatRequest(q));
    return this.chatQueue;
  }

  private async chatRequest(q: ChatRequest): Promise<void> {
    const refuse = (why: string) => {
      writeChatAnswer(this.d.stateDir, q.id, { refused: why });
      this.emit('chat.turn', { id: q.id, by: q.by, read_only: true, citations: 0, draft: 'none', actions: 0, cost_usd: 0, refused: why });
    };
    try {
      const role = this.d.cfg.agents.roles.chief_of_staff;
      if (role && !role.enabled) return refuse('the chat is off (agents.yaml roles.chief_of_staff)');
      if (this.halt.signal.aborted || this.stopped) return refuse('agents are stopped');
      const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
      if (left <= 0) return refuse(`the daily budget ($${this.d.cfg.agents.daily_budget_usd}) is spent`);
      const events = this.d.log.read();
      const context = {
        instance: this.d.instance,
        repo: this.d.cfg.project.project.repo,
        events: events.slice(-2000),
        runs: recentRuns(this.d.stateDir),
        health: machineStats({ paths: [this.d.repo, this.d.stateDir] }),
        ...contextFromEvents(events),
      };
      // Bundles beside the agents' task files: readable by their group, never writable by it.
      const at = this.d.agentTasks;
      const bundle = at ? { root: join(dirname(at.dir), 'chat'), gid: at.gid } : { root: join(this.d.stateDir, 'chat', 'bundles'), gid: process.getgid?.() ?? 0 };
      const a = await chatTurn({
        cfg: this.d.cfg,
        context,
        question: q.question,
        by: q.by,
        runner: this.d.runner,
        stateDir: this.d.stateDir,
        bundleRoot: bundle.root,
        gid: bundle.gid,
        repo: this.d.repo,
        remainingUsd: left,
        onCost: (r) => this.emit('run.cost', { issue: null, role: 'chat', model: r.model, usd: r.costUsd, turns: r.turns }),
      });
      writeChatAnswer(this.d.stateDir, q.id, { answer: a });
      this.emit('chat.turn', { id: q.id, by: q.by, read_only: a.readOnly, citations: a.citations.length, draft: a.issueDraft ? (a.issueDraft.ok ? 'valid' : 'refused') : 'none', actions: a.actions.length, cost_usd: a.costUsd, refused: null });
    } catch (e) {
      refuse(`the chat turn failed: ${(e as Error).message.slice(0, 300)}`);
    }
  }

  checkConsole(): void {
    try {
      this.consoleRequests();
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: 'console', kind: 'error', message: (e as Error).message.slice(0, 500) });
    }
  }

  private consoleRequests(): void {
    for (const q of takeRequests(this.d.stateDir)) {
      const refuse = (why: string) => this.emit('console.request_refused', { request: q.id, kind: q.kind, run: q.run, by: q.by, why });
      const owner = this.d.cfg.project.owners.default;
      if (q.by.toLowerCase() !== owner.toLowerCase()) {
        refuse(`only the owner (@${owner}) may use the console`);
        continue;
      }
      const l = [...this.live.values()].find((x) => x.run === q.run);
      if (!l?.control) {
        refuse(`run ${q.run} isn't live`);
        continue;
      }
      const who = { run: q.run, issue: l.issue, role: l.role };
      if (q.kind === 'stop') {
        l.stoppedBy = q.by;
        this.emit('console.run_stopped', { ...who, by: q.by });
        l.control.stop();
        continue;
      }
      const text = q.text.trim().slice(0, MAX_MESSAGE);
      if (!text) {
        refuse('the message is empty');
        continue;
      }
      l.pending.push({ id: q.id, text, by: q.by, at: q.at });
      const sent = l.control.send(q.id, text);
      if (!sent.queued) {
        l.pending.pop();
        refuse(sent.why);
        continue;
      }
      this.emit('console.message_queued', { ...who, id: q.id, by: q.by, text });
      this.writeLive();
    }
  }

  refreshSettings(): void {
    if (!this.d.settings) return;
    const r = this.d.settings();
    const key = JSON.stringify(r);
    if (key === this.settingsKey) return;
    this.settingsKey = key;
    this.d.cfg = applySettings(this.repoCfg, r.settings);
    this.emit('settings.applied', { settings: r.settings as Record<string, unknown>, error: r.error });
  }

  private async dispatch(): Promise<number> {
    if (this.stopped || this.halt.signal.aborted) return 0;
    const workers = this.d.cfg.agents.roles.workers;
    if (!workers?.enabled) return 0;
    if (!inRunWindow(this.d.cfg.project.agent_runtime.run_windows, this.d.now?.() ?? new Date())) {
      this.noteHold({ reason: `outside the run windows (${this.d.cfg.project.agent_runtime.run_windows.map((w) => `${w.from}-${w.to}`).join(', ')})`, load: null, freeDiskPct: null });
      return 0;
    }
    let started = 0;
    const ready = await this.d.backlog.list('ready');
    // Hotspots: a task that would change a file a running task changes too waits; the loop goes on to the
    // next ready task, so the slot is used meanwhile. The files come from a cheap guess, never an agent run.
    const globs = this.d.cfg.project.hotspots ?? DEFAULT_HOTSPOTS;
    const files = globs.length && ready.length ? this.repoFileIndex(globs) : null;
    // Fill free capacity this tick: one pass over the ready issues, one start per free worker.
    for (const issue of ready) {
      if (this.active.size >= (workers.count ?? 1)) break;
      const hold = this.governorHold();
      this.noteHold(hold);
      if (hold) break;
      if (this.active.has(issue.number) || !this.isTerminal(issue.number)) continue;
      const act = await actionable(issue, this.d.cfg.project.owners.writers, this.d.backlog);
      const contract = parseContract(issue.body);
      // Recorded only when something about the issue changed, not on every tick.
      const seen = { issue: issue.number, title: issue.title, labels: issue.labels, author: issue.author, owner: null, actionable: act.actionable && contract.ok, why: act.actionable ? (contract.ok ? act.why : contract.why) : act.why };
      const prev = this.lastSeen(issue.number);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(seen)) this.emit('issue.seen', seen);
      if (!act.actionable) continue;
      if (!contract.ok) {
        // Judged again whenever the done_when block changes: an edit that is still invalid gets the new error.
        // (A refusal recorded before block hashes existed is compared by its error instead.)
        const key = contractKey(issue.body);
        const last = this.events(issue.number).filter((e) => e.type === 'contract.missing').at(-1)?.payload as EventPayload<'contract.missing'> | undefined;
        const edited = !!last && (last.block_hash !== undefined ? last.block_hash !== key : last.why !== contract.why);
        if (!last || edited) {
          this.emit('contract.missing', { issue: issue.number, why: contract.why, block_hash: key });
          await this.d.backlog.comment(
            issue.number,
            edited
              ? `[${BRAND.cli}] Still not starting after the edit: ${contract.why}. Fix the \`\`\`done_when block; each edit is checked again.`
              : `[${BRAND.cli}] Not starting: ${contract.why}. Add a \`\`\`done_when block (no contract, no build).`,
          );
        }
        continue;
      }
      const hotspots = files ? hotspotsIn(estimateFiles(`${issue.title}\n${issue.body}`, files, globs), globs) : [];
      const clash = pickDispatch([{ issue: issue.number, hotspots }], [...this.taskHotspots].map(([n, h]) => ({ issue: n, hotspots: h })), 1).held[0];
      if (clash) {
        this.noteHotspotHold(clash);
        continue;
      }
      const slot = tryAgentSlot(`${BRAND.cli} ${this.d.cfg.project.project.name} #${issue.number}`, this.d.slotsDir);
      if (!slot) {
        this.noteHold({ reason: 'machine-wide agent cap reached (all harnesses)', load: null, freeDiskPct: null });
        break; // try again next tick
      }
      this.endHotspotHold(issue.number, true);
      this.taskHotspots.set(issue.number, hotspots);
      const p = this.runTask(issue, contract.done_when)
        .catch((e: Error) => {
          this.emit('coordinator.error', { instance: this.d.instance, where: `task #${issue.number}`, kind: 'error', message: e.message.slice(0, 500) });
        })
        .finally(() => {
          slot.release();
          this.active.delete(issue.number);
          this.taskHotspots.delete(issue.number);
        });
      this.active.set(issue.number, p);
      started++;
    }
    // A held task that is no longer ready (closed, relabeled) stops waiting.
    const stillReady = new Set(ready.map((i) => i.number));
    for (const n of this.heldOn()) if (!stillReady.has(n)) this.endHotspotHold(n, false);
    return started;
  }

  /** The checkout's file list, indexed for hotspot estimates; rebuilt only when the checkout's commit or the globs change. */
  private repoFileIndex(globs: string[]): FileIndex {
    const key = `${this.git(this.d.repo, 'rev-parse', 'HEAD')} ${globs.join('\n')}`;
    if (this.fileIx?.key !== key) this.fileIx = { key, ix: fileIndex(this.git(this.d.repo, 'ls-files').split('\n').filter(Boolean), globs) };
    return this.fileIx.ix;
  }

  /** Tasks whose latest hotspot event is a hold (from the log, so a restart doesn't count a wait twice). */
  private heldOn(): number[] {
    const last = new Map<number, string>();
    for (const e of this.d.log.read(0, ['hotspot.held', 'hotspot.released'])) last.set((e.payload as { issue: number }).issue, e.type);
    return [...last].filter(([, t]) => t === 'hotspot.held').map(([n]) => n);
  }

  private noteHotspotHold(h: Hold) {
    const last = this.events(h.issue).filter((e) => e.type === 'hotspot.held' || e.type === 'hotspot.released').at(-1);
    if (last?.type === 'hotspot.held') return; // already waiting: recorded once
    this.emit('hotspot.held', { issue: h.issue, by: h.by, files: h.files, reason: holdReason(h) });
  }

  private endHotspotHold(issue: number, started: boolean) {
    const last = this.events(issue).filter((e) => e.type === 'hotspot.held' || e.type === 'hotspot.released').at(-1);
    if (last?.type !== 'hotspot.held') return;
    const since = Date.parse(last.ts);
    this.emit('hotspot.released', { issue, waited_ms: Math.max(0, Math.round(Date.now() - since)), files: (last.payload as { files: string[] }).files, started });
  }

  // ---------------------------------------------------------------- task pipeline

  private paths(issue: number) {
    return { name: `issue-${issue}`, branch: `${BRAND.cli}/issue-${issue}`, taskFile: join(this.d.agentTasks?.dir ?? join(this.d.stateDir, 'tasks'), `issue-${issue}.json`) };
  }

  async runTask(issue: Issue, doneWhen: DoneWhenList): Promise<void> {
    const n = issue.number;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const base = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const lease: Lease = { instance: this.d.instance, run_id: randomBytes(4).toString('hex'), issue: n, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString(), base };
    const won = claim(lease, { repo: this.d.repo, remote: this.remote });
    if (!won.won) {
      this.emit('issue.claim_lost', { issue: n, instance: this.d.instance, holder: won.holder?.instance ?? null });
      return;
    }
    let leaseSha = won.sha;
    const owner = ownerFor(issue, [], this.d.cfg.project.owners, (g, p) => globToRegExp(g).test(p));
    this.emit('contract.agreed', { issue: n, done_when: doneWhen as Record<string, unknown>[], by: issue.author });
    this.emit('issue.claimed', { issue: n, instance: this.d.instance, lease: leaseSha, base, owner });
    await this.d.backlog.removeLabel(n, 'ready');
    await this.d.backlog.addLabels(n, ['agent:working']);
    if (!issue.assignees.length) await this.d.backlog.setAssignees(n, [owner]);
    await this.d.backlog.comment(n, `[${BRAND.cli}] Claimed by \`${this.d.instance}\` (owner @${owner}, agent delegate: worker). Base \`${base.slice(0, 8)}\`, lease \`${leaseSha.slice(0, 8)}\`.`);
    const heartbeat = setInterval(() => {
      const next = renew({ ...lease, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString() }, leaseSha, { repo: this.d.repo, remote: this.remote });
      if (next) leaseSha = next;
    }, 20 * 60_000);
    heartbeat.unref();

    const { name, branch, taskFile } = this.paths(n);
    try {
      const { path, setupErrors } = createWorktree(this.wt, name, branch, base);
      if (setupErrors.length) throw new Error(`worktree setup failed: ${setupErrors.join('; ')}`);
      this.writeTask(taskFile, { id: `issue-${n}`, done_when: doneWhen });

      if (issue.labels.includes('type:investigation')) return await this.investigate(issue, doneWhen, path, taskFile, base, owner);

      // size:M/L: a read-only plan first. One that touches high-risk or design-level areas waits for the owner's
      // approval (the task stops here and resumes on the answer); any other is posted and built at once.
      let plan: Plan | null = null;
      let planComments = 0;
      if (needsPlan(issue.labels)) {
        const p = await this.planStep(issue, doneWhen, path, base, owner);
        if ('stop' in p) return;
        plan = p.plan;
        planComments = p.commentsAt;
      }

      const repro = doneWhen.some((d) => 'repro' in d && d.repro) ? await this.reproduce(issue, doneWhen, base, path) : null;
      // The frozen test is off-limits to the worker: its hook denies writes to it.
      if (repro?.path) this.writeTask(taskFile, { id: `issue-${n}`, done_when: doneWhen, frozen: [repro.path] });
      const maxAttempts = this.d.maxAttempts ?? 3;
      let feedback: string[] = [];
      // The push limits the last attempt hit, if that's why it was rejected: the block then lists them.
      let refused: string[] | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (plan && (await this.planObjected(n, owner, planComments))) return;
        const out = await this.build(issue, doneWhen, path, taskFile, repro, feedback, attempt, plan);
        if (out.stop) return;
        removeSandboxPlaceholders(path);
        const head = this.git(path, 'rev-parse', 'HEAD');
        // A finding of "no change" counts only for a branch with nothing on it: work an earlier attempt committed is
        // judged as a change against the base, like any other.
        if (out.noChange && this.git(path, 'rev-list', '--count', `${base}..${head}`) === '0') {
          const done = await this.confirmNoChange(n, owner, path, base, head, doneWhen, repro, out.noChange);
          if (done.confirmed) return;
          this.emit('change.rejected', { issue: n, why: done.why });
          feedback = [`Your previous attempt was rejected: ${done.why}`];
          continue;
        }
        const change = await this.inspect(n, path, base, head, repro);
        refused = 'rejected' in change ? (change.refused ?? null) : null;
        if ('rejected' in change) {
          this.emit('change.rejected', { issue: n, why: change.rejected });
          feedback = [`Your previous attempt was rejected: ${change.rejected}`];
          continue;
        }
        const checks = await this.verify(n, path, head, doneWhen, repro);
        if (checks.some((c) => c.status !== 'pass')) {
          feedback = [`Independent checks failed on your last attempt:`, ...checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped').map((c) => `- ${c.check}: ${c.status}\n${c.tail}`)];
          continue;
        }
        const verdict = await this.evaluate(issue, doneWhen, path, base, head, change.patchHash, checks, repro, change.tampered, change.files.map((f) => f.path));
        if (!verdict.patch_correct && attempt < maxAttempts) {
          feedback = [`The independent evaluator rejected your change: ${verdict.advice}`];
          continue;
        }
        // A change to the agents' own instructions is evaluated before it can land (the merge policy reads the result).
        if (verdict.patch_correct) await this.instructionEvals(n, path, base, head, change.files.map((f) => f.path));
        const levelInput = { files: change.files, labels: issue.labels, moneyPaths: loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source), verdict, ...(verdict.unread.length ? { requested: 'L3' as Level } : out.raise || change.tampered.length || repro?.unavailable ? { requested: out.raise ?? ('L2' as Level) } : {}) };
        const lvl = computeLevel(levelInput, this.d.cfg.review ?? DEFAULT_REVIEW);
        if (plan && (await this.planObjected(n, owner, planComments))) return;
        this.emit('review.level_set', { issue: n, head, level: lvl.level, reasons: [...lvl.reasons, ...(verdict.unread.length ? [`evaluator did not read: ${verdict.unread.slice(0, 10).join(', ')}${verdict.unread.length > 10 ? ` and ${verdict.unread.length - 10} more` : ''}`] : []), ...change.tampered.map((t) => `tamper guard: ${t}`), ...(repro?.unavailable ? [`no reproduction: ${repro.unavailable}`] : [])] });
        await this.d.backlog.removeLabel(n, 'agent:working');
        await this.d.backlog.addLabels(n, ['in-review', `review:${lvl.level}`]);
        if (lvl.level === 'L3') {
          await this.ask('land', n, owner, `Approve landing #${n} (${lvl.level})?`, ['approve', 'reject'], verdict.patch_correct ? 'approve' : 'reject', [`head ${head.slice(0, 8)}`, ...lvl.reasons, `evaluator: ${verdict.confidence}; ${verdict.advice || 'no concerns'}`]);
        } else {
          this.emit('land.queued', { issue: n, head, level: lvl.level });
        }
        return;
      }
      await this.block(n, owner, refused ? `no pushable change after ${maxAttempts} attempts; ${pushRefusal(refused)}` : `no passing change after ${maxAttempts} attempts`);
    } catch (e) {
      // Stopped from the console: the task waits for the owner, saying who stopped it.
      if (e instanceof StoppedByOwner) return await this.block(n, owner, e.message);
      if (!(e instanceof Halted)) throw e;
      // Requeued: the task starts over once the stop is lifted.
      this.releaseClaim(n, 'emergency stop');
      await this.d.backlog.removeLabel(n, 'agent:working');
      await this.d.backlog.addLabels(n, ['ready']);
      await this.d.backlog.comment(n, `[${BRAND.cli}] Stopped by an emergency stop; requeued from the start once it is lifted.`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Read-only work: findings with evidence go to the owner; nothing is committed or landed. */
  private async investigate(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, base: string, owner: string) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.workers!;
    const model = role.hard_issues_model && (issue.labels.includes('size:L') || issue.labels.includes('money-path')) ? role.hard_issues_model : role.model;
    const r = await this.d.runner.run({
      env: this.d.cfg.tests.env,
      role: 'investigator',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, this.answers(n)),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'investigator'),
      cwd: path,
      model,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      maxTurns: 150,
      maxBudgetUsd: Math.min(role.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: INVESTIGATION_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'investigator', model, worktree: path, pid: p, pgid: p, attempt: 1 }),
    });
    this.cost(n, 'investigator', r);
    this.emit('run.finished', { issue: n, role: 'investigator', reason: r.reason, detail: r.detail.slice(0, 1000) });
    // Read-only means read-only: any change it left behind is discarded and reported.
    const touched = this.git(path, 'status', '--porcelain') || (this.git(path, 'rev-parse', 'HEAD') !== base ? 'commits' : '');
    const s = r.structured as { summary: string; findings: { claim: string; evidence: string }[]; recommendation: string; confidence: string; unverified?: string[] } | undefined;
    if (r.reason !== 'succeeded' || !s) {
      await this.block(n, owner, `investigation run ended: ${r.reason} (${r.detail.slice(0, 300)})`);
      return;
    }
    const body = [
      `[${BRAND.cli}] Investigation findings (read-only, confidence ${s.confidence})${touched ? `\n\n**Note:** the run modified files despite being read-only; those changes were discarded.` : ''}`,
      '',
      s.summary,
      '',
      ...s.findings.map((f, i) => `${i + 1}. ${f.claim}\n   Evidence: ${f.evidence}`),
      ...(s.unverified?.length ? ['', '**Unverified:**', ...s.unverified.map((u) => `- ${u}`)] : []),
      '',
      `**Recommendation:** ${s.recommendation}`,
    ].join('\n');
    await this.d.backlog.comment(n, body);
    await this.d.backlog.removeLabel(n, 'agent:working');
    await this.d.backlog.addLabels(n, ['in-review']);
    await this.ask('question', n, owner, 'How should this proceed?', ['approve-fix', 'investigate-more', 'close'], s.recommendation.slice(0, 200), [`confidence ${s.confidence}`, `${s.findings.length} finding(s)`]);
  }

  private async reproduce(issue: Issue, doneWhen: DoneWhenList, base: string, workerPath: string): Promise<{ path: string; hash: string } & { unavailable?: string }> {
    const n = issue.number;
    const name = `issue-${n}-repro`;
    const { path } = createWorktree(this.wt, name, `${BRAND.cli}/issue-${n}-repro`, base);
    try {
      const role = this.d.cfg.agents.roles.evaluator!;
      const r = await this.d.runner.run({
        env: this.d.cfg.tests.env,
        role: 'evaluator-repro',
        stateDir: this.d.stateDir,
        prompt: issueBrief(issue, doneWhen),
        appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'evaluator-repro'),
        cwd: path,
        model: role.model,
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
        maxTurns: 40,
        maxBudgetUsd: role.budget_usd ?? 3,
        jsonSchema: REPRO_SCHEMA,
        stallMs: 15 * 60_000,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      this.cost(n, 'evaluator-repro', r);
      const s = r.structured as { test_path?: string; not_reproducible?: string } | undefined;
      const unavailable = (why: string) => {
        this.emit('repro.unavailable', { issue: n, why });
        return { path: '', hash: '', unavailable: why };
      };
      if (r.reason !== 'succeeded' || !s) return unavailable(`evaluator run ${r.reason}`);
      if (s.not_reproducible || !s.test_path) return unavailable(s.not_reproducible ?? 'no test path');
      const changed = this.git(path, 'diff', '--name-only', base).split('\n').filter(Boolean).concat(this.git(path, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));
      if (changed.some((f) => f !== s.test_path)) return unavailable(`repro run changed more than the test: ${changed.join(', ')}`);
      if (!existsSync(join(path, s.test_path))) return unavailable(`test ${s.test_path} not found`);
      const one = this.d.cfg.tests.runner.one;
      if (!one) return unavailable('tests.yaml runner.one is not set');
      const onBase = await this.project(one.replaceAll('{file}', s.test_path), path);
      if (onBase.code === 0) return unavailable(`the test passes on the unfixed code, so it doesn't reproduce the issue`);
      // Freeze it: commit the test into the worker's branch; its hash is checked later.
      mkdirSync(dirname(join(workerPath, s.test_path)), { recursive: true });
      cpSync(join(path, s.test_path), join(workerPath, s.test_path));
      this.git(workerPath, 'add', s.test_path);
      this.git(workerPath, '-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`, 'commit', '-q', '-m', `Add reproduction test for #${n} (frozen)`);
      // Git's blob id of the committed test: line-ending normalized, and exactly what would land.
      const hash = this.git(workerPath, 'rev-parse', `HEAD:${s.test_path}`);
      this.emit('repro.frozen', { issue: n, path: s.test_path, hash, fails_on_base: true });
      return { path: s.test_path, hash };
    } finally {
      removeWorktree(this.wt, name);
    }
  }

  private async build(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, repro: { path: string } | null, feedback: string[], attempt: number, plan: Plan | null = null) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.workers!;
    const model = issue.labels.includes('size:L') && role.hard_issues_model ? role.hard_issues_model : role.model;
    const remaining = Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday());
    const { runner, checks } = this.d.cfg.tests;
    const extra = [
      `Fast tests to run while you work: ${runner.changed}`,
      `When you finish, the coordinator runs each done_when check${checks.length ? `, then: ${checks.join('; ')}` : ''}.`,
      ...(repro?.path ? [`Frozen reproduction test (must pass; never edit): ${repro.path}`] : []),
      ...this.answers(n),
      ...(plan ? ['', ...planBrief(plan)] : []),
      ...(feedback.length ? ['', ...feedback] : []),
    ];
    let pid = -1;
    const before = this.git(path, 'rev-parse', 'HEAD');
    const started = Date.now();
    const r: RunResult = await this.d.runner.run({
      env: this.d.cfg.tests.env,
      role: 'worker',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'worker'),
      cwd: path,
      model,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      maxTurns: 200,
      maxBudgetUsd: Math.min(role.budget_usd ?? 10, remaining),
      jsonSchema: WORKER_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStart: (p) => {
        pid = p;
        this.emit('run.started', { issue: n, role: 'worker', model, worktree: path, pid: p, pgid: p, attempt });
      },
    });
    void pid;
    this.cost(n, 'worker', r);
    this.emit('run.finished', { issue: n, role: 'worker', reason: r.reason, detail: r.detail.slice(0, 1000) });
    const s = (r.structured ?? {}) as { summary?: string; blocked?: string; no_change_needed?: string; ask?: { question: string; options: string[]; recommendation: string }; raise_review?: Level };
    const owner = this.ownerOf(n);
    // The runner already waited out auth and transient errors for half an hour: not the change, so say so.
    if (r.transient) {
      const said = r.detail.slice(0, 1500).replace(/`{3,}/g, "'''");
      await this.block(n, owner, `claude kept failing to start on an auth or transient error (token refresh, rate limit, overload or network), not on this change, so no attempt was counted. Check the agent user's Claude login (\`claude auth status\`) and label it \`ready\` again. claude reported:\n\n\`\`\`\n${said}\n\`\`\``, r.reason !== 'rate_limited');
      return { stop: true as const };
    }
    if (r.reason === 'rate_limited' || r.reason === 'budget_exhausted' || r.reason === 'auth_mismatch') {
      await this.block(n, owner, `worker run ended: ${r.reason} (${r.detail})`, false);
      return { stop: true as const };
    }
    // A run that failed almost at once and committed nothing never got to work: another attempt would fail the
    // same way, so say what claude reported instead of spending the attempts on "no passing change".
    const secs = Math.round((Date.now() - started) / 1000);
    if (r.reason === 'failed' && secs < STARTUP_FAILURE_SECS && this.git(path, 'rev-parse', 'HEAD') === before) {
      this.emit('run.startup_failed', { issue: n, role: 'worker', attempt, seconds: secs, turns: r.turns, detail: r.detail.slice(0, 2000) });
      const said = r.detail.slice(0, 1500).replace(/`{3,}/g, "'''");
      await this.block(n, owner, `the worker's claude run failed to start (ended after ${secs}s, ${r.turns} turn(s), nothing committed), so no further attempts were made. claude reported:\n\n\`\`\`\n${said}\n\`\`\``);
      return { stop: true as const };
    }
    if (s.ask) {
      await this.ask('question', n, owner, s.ask.question, s.ask.options, s.ask.recommendation, [s.summary ?? '']);
      return { stop: true as const };
    }
    if (s.blocked) {
      await this.block(n, owner, s.blocked);
      return { stop: true as const };
    }
    return { stop: false as const, ...(s.raise_review ? { raise: s.raise_review } : {}), ...(s.no_change_needed ? { noChange: s.no_change_needed } : {}) };
  }

  /**
   * A worker says the issue needs no change. Not taken on its word: with
   * nothing committed, the worktree is reset to the base and the coordinator
   * runs the done_when checks itself. All passing, the owner gets the
   * verdict and the evidence and decides whether to close; the task stops
   * (no retries toward a change nobody needs).
   */
  private async confirmNoChange(n: number, owner: string, path: string, base: string, head: string, doneWhen: DoneWhenList, repro: { path: string } | null, why: string): Promise<{ confirmed: true } | { confirmed: false; why: string }> {
    const commits = this.git(path, 'rev-list', '--count', `${base}..${head}`);
    if (commits !== '0') return { confirmed: false, why: `you reported no change needed but committed ${commits} commit(s); either make the change or commit nothing` };
    this.git(path, 'reset', '-q', '--hard', base);
    this.git(path, 'clean', '-q', '-fd');
    const checks = await this.verify(n, path, base, doneWhen, repro);
    const failing = checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped');
    if (!checks.length) return { confirmed: false, why: 'you reported no change needed, but done_when has no check the coordinator can run to confirm it' };
    if (failing.length) return { confirmed: false, why: `you reported no change needed, but on the unchanged base these checks don't pass:\n${failing.map((c) => `- ${c.check}: ${c.status}\n${c.tail}`).join('\n')}` };
    this.emit('issue.no_change', { issue: n, owner, base, why: why.slice(0, 2000), checks: checks.map(({ tail: _t, ...c }) => c) });
    const manual = doneWhen.filter((d) => 'manual' in d).map((d) => (d as { manual: string }).manual);
    await this.d.backlog.removeLabel(n, 'agent:working');
    await this.d.backlog.removeLabel(n, 'ready');
    await this.d.backlog.addLabels(n, ['no-change-needed']);
    await this.d.backlog.comment(
      n,
      `[${BRAND.cli}] @${owner} no change needed, so nothing was committed. The worker's finding: ${why}\n\nThe coordinator's own checks on the unchanged base \`${base.slice(0, 8)}\`:\n${checks.map((c) => `- ${c.status === 'pass' ? 'pass' : c.status}: \`${c.check}\``).join('\n')}${manual.length ? `\n\nStill for you to check by hand: ${manual.join('; ')}` : ''}\n\nClose the issue if you agree; otherwise say what's missing and label it \`ready\` again.`,
    );
    this.releaseClaim(n, 'no change needed');
    return { confirmed: true };
  }

  private get identity(): CommitIdentity {
    return this.d.commitIdentity ?? DEFAULT_COMMIT_IDENTITY;
  }

  /**
   * Evals of the agents' instructions a change touches (a skill, AGENTS.md, a role prompt): the same cases on
   * the instructions at the base and at the head, under the per-eval cost cap, through the runner like every
   * run (the agent user, the subscription CLI). One instructions.eval event each; anything that keeps an eval
   * from running is recorded as its error, and the merge policy waits on it.
   */
  private async instructionEvals(n: number, path: string, base: string, head: string, files: string[]) {
    const targets = instructionTargets(files);
    if (!targets.length) return;
    const cfg = this.d.cfg.agents.instruction_evals;
    const model = cfg.model ?? this.d.cfg.agents.roles.workers?.model ?? 'sonnet';
    const judge = cfg.judge ?? this.d.cfg.agents.roles.evaluator?.model ?? 'opus';
    const at = (rev: string, p: string): string | null => {
      try {
        return this.git(path, 'show', `${rev}:${p}`);
      } catch {
        return null;
      }
    };
    const ask = runnerAsk(this.d.runner, (r) => this.cost(n, 'instruction-eval', r as RunResult), this.d.stateDir);
    const none = { base: null, result: null, dropped: false, incomplete: true, changes: [], cost_usd: 0 };
    for (const t of targets) {
      const record = (p: Omit<EventPayload<'instructions.eval'>, 'issue' | 'head' | 'target'>) => this.emit('instructions.eval', { issue: n, head, target: t.target, ...p });
      if (!cfg.enabled) {
        record({ ...none, error: 'instruction evals are off (agents.yaml instruction_evals)' });
        continue;
      }
      // A project role prompt that doesn't exist on one side is the engine's built-in one there.
      const builtIn = t.role ? defaultRolePrompt(t.role) || null : null;
      const baseText = at(base, t.file) ?? builtIn;
      const headText = at(head, t.file) ?? builtIn;
      if (headText === null) {
        record({ ...none, error: `${t.file} is removed; nothing to evaluate` });
        continue;
      }
      const casesMd = at(head, t.cases) ?? at(base, t.cases) ?? (t.role ? engineRoleCases(t.role) : null);
      const cases = casesMd ? parseCases(casesMd) : [];
      if (!cases.length) {
        record({ ...none, error: `no eval cases (${t.cases})` });
        continue;
      }
      try {
        const c = await compareInstructions({ target: t.target, baseText, headText, cases, model, judge, samples: cfg.samples, capUsd: cfg.cap_usd, ask });
        record({ base: c.base, result: c.head, dropped: c.dropped, incomplete: c.incomplete, changes: c.changes, cost_usd: c.costUsd });
      } catch (e) {
        if (e instanceof Halted) throw e;
        record({ ...none, error: (e as Error).message.slice(0, 500) });
      }
    }
  }

  /** The latest eval of each instruction target for an issue. */
  private instructionResults(n: number): EventPayload<'instructions.eval'>[] {
    const latest = new Map<string, EventPayload<'instructions.eval'>>();
    for (const e of this.events(n)) if (e.type === 'instructions.eval') latest.set((e.payload as { target: string }).target, e.payload as EventPayload<'instructions.eval'>);
    return [...latest.values()];
  }

  /** Each file the change base..head touches, with its line counts and added lines (for content checks). */
  private changeFiles(cwd: string, base: string, head: string): ChangeFile[] {
    return this.git(cwd, 'diff', '--numstat', `${base}..${head}`)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, r, p] = l.split('\t');
        const added = this.git(cwd, 'diff', '-U0', `${base}..${head}`, '--', p!).split('\n').filter((x) => x.startsWith('+') && !x.startsWith('+++')).map((x) => x.slice(1));
        return { path: p!, added: Number(a) || 0, removed: Number(r) || 0, addedLines: added };
      });
  }

  /**
   * The task file the agent's hook reads (its frozen paths): readable by the agent user, never writable by it,
   * so an agent can neither lose its guard nor rewrite it. The hook refuses every tool call if it can't read it.
   */
  private writeTask(file: string, task: object) {
    const at = this.d.agentTasks;
    if (at) {
      agentReadableDir(at.dir, at.gid);
      writeAgentReadable(file, JSON.stringify(task), at.gid);
    } else {
      groupOnlyDir(dirname(file));
      writeGroupOnly(file, JSON.stringify(task));
    }
  }

  /** Mechanical checks on what the worker produced, before anyone trusts it. */
  private async inspect(n: number, path: string, base: string, head: string, repro: { path: string; hash: string } | null) {
    if (repro?.path) {
      let blob = '';
      try {
        blob = this.git(path, 'rev-parse', `${head}:${repro.path}`);
      } catch {
        // deleted
      }
      if (blob !== repro.hash) return { rejected: `modified the frozen reproduction test ${repro.path}` };
    }
    if (this.git(path, 'status', '--porcelain')) return { rejected: 'uncommitted changes left in the worktree; commit your work' };
    // Every commit carries the harness identity: an agent never commits as a person (or anyone else).
    const id = this.identity;
    const strangers = this.git(path, 'log', '--format=%h %an <%ae> / %cn <%ce>', `${base}..${head}`).split('\n').filter(Boolean).filter((l) => !l.endsWith(` ${id.name} <${id.email}> / ${id.name} <${id.email}>`));
    if (strangers.length) return { rejected: `commits must carry the harness identity ${id.name} <${id.email}>, which your environment already sets; never set GIT_AUTHOR_*/GIT_COMMITTER_*, user.name/user.email or --author. Recommit these without an identity of your own: ${strangers.slice(0, 5).join('; ')}` };
    const names = this.git(path, 'diff', '--name-only', `${base}..${head}`).split('\n').filter(Boolean);
    const workerFiles = repro?.path ? names.filter((f) => f !== repro.path) : names;
    if (!workerFiles.length) return { rejected: 'no changes committed' };
    const protectedRes = this.d.cfg.guardrails.protected_paths.map((g) => globToRegExp(g));
    const prot = names.filter((f) => protectedRes.some((re) => re.test(f)));
    if (prot.length) return { rejected: `changes protected harness files: ${prot.join(', ')}` };
    const scan = await scanRange(path, `${base}..${head}`);
    if (scan.status === 'leaks') return { rejected: `secret scan found ${scan.findings.length} possible secret(s) in the change` };
    if (scan.status === 'unavailable') return { rejected: `secret scan could not run (${scan.error}); not accepting an unscanned change` };
    // The push limits, checked now so a change that can't be pushed doesn't spend a test run first.
    const limits = pushProblems(path, base, head, this.d.cfg.guardrails.push);
    if (limits.length) {
      this.emit('push.refused', { issue: n, head, stage: 'change', reasons: limits });
      return { rejected: `it can't be pushed: ${limits.join('; ')}`, refused: limits };
    }
    const files = this.changeFiles(path, base, head);
    // Tamper guard: tests deleted, skipped, focused, or with fewer assertions.
    const tampered: string[] = [];
    const pattern = this.d.cfg.tests.vacuity?.assertion_pattern ?? '\\b(assert|expect|check)\\b';
    const testRes = (this.d.cfg.tests.vacuity?.test_globs ?? ['test/**', '**/*.test.*']).map((g) => globToRegExp(g));
    for (const f of files.filter((x) => testRes.some((re) => re.test(x.path)))) {
      const after = existsSync(join(path, f.path)) ? readFileSync(join(path, f.path), 'utf8') : null;
      let before: string | null = null;
      try {
        before = this.git(path, 'show', `${base}:${f.path}`);
      } catch {
        // new file
      }
      if (before !== null && after === null) tampered.push(`deleted test ${f.path}`);
      if (after !== null && /\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/.test((f.addedLines ?? []).join('\n'))) tampered.push(`skipped/focused tests in ${f.path}`);
      if (before !== null && after !== null && countAssertions(after, pattern) < countAssertions(before, pattern)) tampered.push(`fewer assertions in ${f.path}`);
    }
    const lines = files.reduce((s, f) => s + f.added + f.removed, 0);
    const patchHash = createHash('sha256').update(this.git(path, 'diff', `${base}..${head}`)).digest('hex');
    this.emit('change.proposed', { issue: n, branch: this.paths(n).branch, base, head, files: names, lines, patch_hash: patchHash });
    return { files, tampered, patchHash };
  }

  /** The coordinator's own run of the contract: it never trusts the agent's word. */
  private async verify(n: number, path: string, head: string, doneWhen: DoneWhenList, repro: { path: string } | null) {
    const checks: { check: string; status: 'pass' | 'fail' | 'unavailable' | 'skipped'; exitCode: number | null; tail: string; duration_ms?: number }[] = [];
    // Each check's wall time, so a project's test times can be followed over time.
    const timed = async (command: string) => {
      const t0 = Date.now();
      const r = await this.project(command, path);
      return { r, duration_ms: Math.max(0, Date.now() - t0) };
    };
    const run = async (command: string) => {
      const { r, duration_ms } = await timed(command);
      const busy = this.d.cfg.tests.stop_gate.busy_patterns.some((p) => new RegExp(p, 'm').test(r.out));
      checks.push({ check: command, status: busy || r.code === null ? 'unavailable' : r.code === 0 ? 'pass' : 'fail', exitCode: r.code, tail: r.tail, duration_ms });
    };
    const one = this.d.cfg.tests.runner.one;
    for (const d of doneWhen) {
      if ('command' in d) await run(d.command);
      else if ('suite' in d) {
        const cmd = d.suite === 'full' ? this.d.cfg.tests.runner.full : this.d.cfg.tests.runner.changed;
        const { r, duration_ms } = await timed(cmd);
        const v = baselineGate(r.code, r.out, this.d.cfg.tests.failures, latestBaseline(this.d.log));
        checks.push({ check: `${cmd} (baseline gate)`, status: v.outcome === 'pass' ? 'pass' : r.code === null ? 'unavailable' : 'fail', exitCode: r.code, tail: v.outcome === 'fail' ? `${v.note}${v.newFailures.length ? `: ${v.newFailures.join(', ')}` : ''}\n${r.tail}` : v.note, duration_ms });
      }
      else if ('test' in d) {
        if (one) await run(one.replaceAll('{file}', d.test));
        else checks.push({ check: `test ${d.test}`, status: 'unavailable', exitCode: null, tail: 'tests.yaml runner.one not set' });
      }
    }
    if (repro?.path && one) await run(one.replaceAll('{file}', repro.path));
    // The project's checks can be long (a full suite): once the issue's own checks have failed the attempt
    // is rejected anyway, so they're recorded as skipped instead of run.
    const failed = checks.some((c) => c.status !== 'pass');
    for (const c of this.d.cfg.tests.checks) {
      if (failed) checks.push({ check: c, status: 'skipped', exitCode: null, tail: '' });
      else await run(c);
    }
    this.emit('check.result', { issue: n, head, stage: 'verify', checks: checks.map(({ tail, ...c }) => ({ ...c, ...(c.status !== 'pass' && tail ? { tail: tail.slice(-1500) } : {}) })) });
    return checks;
  }

  private async evaluate(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, head: string, patchHash: string, checks: { check: string; status: string }[], repro: { path: string } | null, tampered: string[], changed: string[], opts: { extra?: string[]; schema?: object } = {}) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.evaluator!;
    const extra = [
      `Base commit: ${base}. Head: ${head}. Inspect with: git diff ${base}..${head}`,
      `Reproduction test: ${repro?.path || 'none'}`,
      `Coordinator's check results: ${checks.map((c) => `${c.check}=${c.status}`).join(', ') || 'none'}`,
      ...(tampered.length ? [`Tamper guard flags: ${tampered.join('; ')}`] : []),
      ...(opts.extra ?? []),
    ];
    const r = await this.d.runner.run({
      env: this.d.cfg.tests.env,
      role: 'evaluator-verdict',
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'evaluator-verdict'),
      cwd: path,
      model: role.model,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      maxTurns: 60,
      maxBudgetUsd: role.budget_usd ?? 5,
      jsonSchema: opts.schema ?? VERDICT_SCHEMA,
      stallMs: 15 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    this.cost(n, 'evaluator-verdict', r);
    const s = r.structured as { patch_correct?: boolean; test_correct?: boolean; confidence?: 'high' | 'medium' | 'low'; advice?: string; files_reviewed?: string[]; design_change?: boolean; design_reason?: string; both_sides_kept?: boolean } | undefined;
    // A review that didn't read every changed file can't pass on its own: those files go to a human.
    const reviewed = new Set((s?.files_reviewed ?? []).map((f) => f.replace(/^\.\//, '')));
    const unread = changed.filter((f) => !reviewed.has(f));
    // No verdict is a failed verdict, never a pass.
    const v = {
      patch_correct: r.reason === 'succeeded' && s?.patch_correct === true,
      test_correct: r.reason === 'succeeded' && s?.test_correct !== false,
      confidence: (r.reason === 'succeeded' && s?.confidence) || 'low',
      advice: r.reason === 'succeeded' ? (s?.advice ?? '') : `evaluator run ${r.reason}: ${r.detail}`,
    } as const;
    if (this.git(path, 'rev-parse', 'HEAD') !== head) throw new Error('the worktree moved during evaluation; the verdict would not match the patch');
    const design = r.reason === 'succeeded' && typeof s?.design_change === 'boolean' ? { design_change: s.design_change, ...(s.design_reason ? { design_reason: s.design_reason.slice(0, 500) } : {}) } : {};
    this.emit('eval.verdict', { issue: n, head, patch_hash: patchHash, ...v, ...(unread.length ? { unread } : {}), ...design });
    return { ...v, unread, bothSidesKept: r.reason === 'succeeded' && typeof s?.both_sides_kept === 'boolean' ? s.both_sides_kept : null };
  }

  private cost(issue: number, role: string, r: RunResult) {
    this.emit('run.cost', { issue, role, model: r.model, usd: r.costUsd, turns: r.turns });
  }

  private ownerOf(issue: number): string {
    const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
    return (c?.payload as { owner?: string } | undefined)?.owner ?? this.d.cfg.project.owners.default;
  }

  private async ask(kind: 'land' | 'question' | 'domain' | 'plan', issue: number | null, owner: string, question: string, options: string[], recommendation: string, receipts: string[]): Promise<string> {
    const id = `d-${issue ?? kind}-${randomBytes(3).toString('hex')}`;
    this.emit('decision.asked', { id, kind, issue, owner, question, options, recommendation, receipts });
    if (issue === null) return id; // not tied to an issue: answered from the dashboard or CLI
    await this.d.backlog.addLabels(issue, ['needs:decision']);
    await this.d.backlog.comment(
      issue,
      `[${BRAND.cli}] @${owner} decision needed: **${question}**\n\nOptions: ${options.join(' / ')}. Recommendation: **${recommendation}**.\n\n${receipts.map((r) => `- ${r}`).join('\n')}\n\nReply \`/${BRAND.cli} ${options.join('` or `/' + BRAND.cli + ' ')}\` (owner or a writer), or run \`${BRAND.cli} decide ${id} <option>\`.`,
    );
    return id;
  }

  private async block(issue: number, owner: string, why: string, release_ = true) {
    this.emit('issue.blocked', { issue, owner, why: why.slice(0, 1000) });
    await this.d.backlog.addLabels(issue, ['blocked']);
    await this.d.backlog.removeLabel(issue, 'agent:working');
    await this.d.backlog.comment(issue, `[${BRAND.cli}] @${owner} blocked: ${why}`);
    if (release_) this.releaseClaim(issue, why);
  }

  private releaseClaim(issue: number, why: string) {
    const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
    const lease = (c?.payload as { lease?: string } | undefined)?.lease;
    if (lease) release(issue, lease, { repo: this.d.repo, remote: this.remote });
    this.emit('issue.released', { issue, instance: this.d.instance, why });
    try {
      removeWorktree(this.wt, this.paths(issue).name);
    } catch {
      // not ours or already gone
    }
  }

  // ---------------------------------------------------------------- decisions

  /** Decisions answered by CLI (decision.answered) or by a writer's `/<cli> <option>` comment. */
  /**
   * The plan for a size:M/L task. After the owner approved a held plan: that plan. Otherwise a read-only plan
   * run (with the owner's note after a revise), posted on the issue; one touching high-risk or design-level
   * areas is held as the owner's decision (the claim is released and the task stops: 'stop').
   */
  private async planStep(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, owner: string): Promise<{ plan: Plan; commentsAt: number } | { stop: true }> {
    const n = issue.number;
    const last = this.events(n).filter((e) => e.type === 'plan.posted' || e.type === 'plan.decided').at(-1);
    const decided = last?.type === 'plan.decided' ? (last.payload as EventPayload<'plan.decided'>) : null;
    if (decided?.answer === 'approve') {
      const posted = this.events(n).filter((e) => e.type === 'plan.posted').at(-1)!.payload as EventPayload<'plan.posted'>;
      return { plan: posted.plan as unknown as Plan, commentsAt: (await this.d.backlog.comments(n)).length };
    }
    const note = decided?.answer === 'revise' ? decided.note : null;
    const workers = this.d.cfg.agents.roles.workers!;
    const r = await this.d.runner.run({
      env: this.d.cfg.tests.env,
      role: 'planner',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, [...planExtra(), ...(note ? ['', `The owner asked for a revised plan: ${note}`] : [])]),
      cwd: path,
      model: workers.model,
      allowedTools: PLAN_TOOLS,
      disallowedTools: PLAN_DISALLOWED,
      maxTurns: 60,
      maxBudgetUsd: Math.min(workers.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: PLAN_SCHEMA,
      stallMs: 20 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'planner', model: workers.model, worktree: path, pid: p, pgid: p, attempt: 1 }),
    });
    this.cost(n, 'planner', r);
    this.emit('run.finished', { issue: n, role: 'planner', reason: r.reason, detail: r.detail.slice(0, 1000) });
    if (r.reason !== 'succeeded') {
      await this.block(n, owner, `the plan run ended: ${r.reason} (${r.detail.slice(0, 300)})`);
      return { stop: true };
    }
    const plan = readPlan(r.structured);
    if ('invalid' in plan) {
      await this.block(n, owner, plan.invalid);
      return { stop: true };
    }
    const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
    const reasons = planHoldReasons(plan, { review, moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source), existsAtBase: (d) => spawnSync('git', ['cat-file', '-e', `${base}:${d}`], { cwd: this.d.repo }).status === 0 });
    await this.d.backlog.comment(n, planComment(plan, owner, reasons));
    const commentsAt = (await this.d.backlog.comments(n)).length;
    if (reasons.length) {
      const d = planDecision(reasons);
      const id = await this.ask('plan', n, owner, d.question, d.options, d.recommendation, d.receipts);
      this.emit('plan.posted', { issue: n, plan: plan as unknown as Record<string, unknown>, held: true, reasons, comments_at: commentsAt, decision: id });
      await this.d.backlog.removeLabel(n, 'agent:working');
      this.releaseClaim(n, 'plan held for the owner');
      return { stop: true };
    }
    this.emit('plan.posted', { issue: n, plan: plan as unknown as Record<string, unknown>, held: false, reasons: [], comments_at: commentsAt, decision: null });
    return { plan, commentsAt };
  }

  /** An objection to a plan that is being built: the task stops (blocked, saying who objected and why). */
  private async planObjected(n: number, owner: string, commentsAt: number): Promise<boolean> {
    const o = objection(await this.d.backlog.comments(n), commentsAt, [owner, ...this.d.cfg.project.owners.writers]);
    if (!o) return false;
    this.emit('plan.objected', { issue: n, by: o.by, why: o.why.slice(0, 500) });
    await this.block(n, owner, `@${o.by} objected to the plan: ${o.why}`);
    return true;
  }

  /** The owner's answer on a held plan: approve and revise put the task back to ready; reject stops it. */
  private async handlePlanDecision(askedId: number, q: EventPayload<'decision.asked'>, writers: Set<string>, cmd: RegExp) {
    const n = q.issue!;
    if (this.d.log.read(askedId, ['plan.decided']).some((e) => (e.payload as { decision: string }).decision === q.id)) return;
    let a = this.d.log.read(askedId, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === q.id);
    let body = '';
    if (!a) {
      const reply = (await this.d.backlog.comments(n))
        .filter((c) => writers.has(c.author.toLowerCase()))
        .map((c) => ({ by: c.author, body: c.body, m: c.body.match(cmd) }))
        .filter((x) => x.m && q.options.includes(x.m[1]!))
        .at(-1);
      if (!reply) return;
      body = reply.body;
      a = this.emit('decision.answered', { id: q.id, by: reply.by, answer: reply.m![1]! }).payload;
    }
    const act = planAnswer(a.answer, body);
    const answer = a.answer as PlanAnswer;
    this.emit('plan.decided', { issue: n, decision: q.id, answer, by: a.by, note: act.act === 'replan' ? act.note.slice(0, 2000) : '' });
    await this.d.backlog.removeLabel(n, 'needs:decision');
    if (act.act === 'stop') {
      await this.d.backlog.comment(n, `[${BRAND.cli}] @${a.by} rejected the plan; nothing is built.`);
      return;
    }
    await this.d.backlog.addLabels(n, ['ready']);
    await this.d.backlog.comment(n, `[${BRAND.cli}] @${a.by} ${act.act === 'build' ? 'approved the plan; the build starts with it' : `asked for a revised plan: ${act.note}`}.`);
  }

  /** Each newly refused host for a task: recorded, and asked of the owner, once per task and host. */
  private async noteRefusedHosts(issue: number, role: string, run: string | null, refused: RefusedRequest[]) {
    const asked = new Set(this.d.log.read(0, ['network.domain_requested']).map((e) => e.payload as EventPayload<'network.domain_requested'>).filter((p) => p.issue === issue).map((p) => p.host));
    for (const r of refused) {
      if (asked.has(r.host)) continue;
      asked.add(r.host);
      const d = domainDecision({ ...r, issue, role, run: run ?? 'unknown' }, `${BRAND.configDir}/guardrails.yaml`);
      const id = await this.ask('domain', issue, this.ownerOf(issue), d.question, d.options, d.recommendation, d.receipts);
      this.emit('network.domain_requested', { issue, host: r.host, role, run, tool: r.tool, what: r.what.slice(0, 300), decision: id });
    }
  }

  /** The owner's answer on a refused host: recorded, and an allow-repo answer opens the config change as a PR. */
  private async handleDomainDecision(askedId: number, q: EventPayload<'decision.asked'>, writers: Set<string>, cmd: RegExp) {
    const issue = q.issue!;
    if (this.d.log.read(askedId, ['network.domain_decided']).some((e) => (e.payload as { decision: string }).decision === q.id)) return;
    const req = this.d.log.read(askedId, ['network.domain_requested']).map((e) => e.payload as EventPayload<'network.domain_requested'>).find((p) => p.decision === q.id);
    if (!req) return;
    let a = this.d.log.read(askedId, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === q.id);
    if (!a) {
      const reply = (await this.d.backlog.comments(issue))
        .filter((c) => writers.has(c.author.toLowerCase()))
        .map((c) => ({ by: c.author, m: c.body.match(cmd) }))
        .filter((x) => x.m && q.options.includes(x.m[1]!))
        .at(-1);
      if (!reply) return;
      a = this.emit('decision.answered', { id: q.id, by: reply.by, answer: reply.m![1]! }).payload;
    }
    await this.d.backlog.removeLabel(issue, 'needs:decision');
    const answer = a.answer as DomainAnswer;
    let pr: string | null = null;
    let detail = '';
    if (answer === 'allow-repo') {
      const r = await this.proposeAllowedHost(req.host);
      pr = r.pr;
      detail = r.detail;
    } else detail = answer === 'allow-once' ? "the task's next run may reach it" : 'nothing changes';
    this.emit('network.domain_decided', { issue, host: req.host, decision: q.id, answer, by: a.by, pr, detail: detail.slice(0, 500) });
    await this.d.backlog.comment(issue, `[${BRAND.cli}] ${req.host}: @${a.by} answered ${answer}. ${pr ? `Proposed as ${pr}; it applies once merged.` : detail}`);
  }

  /**
   * The guardrails change that allows a host for this repo, opened as a pull request on its own branch (built
   * from the default branch with git plumbing: no worktree, no setup). Never applied in place.
   */
  private async proposeAllowedHost(host: string): Promise<{ pr: string | null; detail: string }> {
    const file = `${BRAND.configDir}/guardrails.yaml`;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const base = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const shown = spawnSync('git', ['show', `${base}:${file}`], { cwd: this.d.repo, encoding: 'utf8' });
    if (shown.status !== 0) return { pr: null, detail: `${file} isn't on ${this.branch}, so no change was proposed` };
    const next = withAllowedHost(shown.stdout, host);
    if (next === null) return { pr: null, detail: `${host} is already allowed on ${this.branch}` };
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: this.d.repo, encoding: 'utf8', input: next }).stdout.trim();
    const index = join(this.d.stateDir, `allow-${randomBytes(3).toString('hex')}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: this.identity.name, GIT_AUTHOR_EMAIL: this.identity.email, GIT_COMMITTER_NAME: this.identity.name, GIT_COMMITTER_EMAIL: this.identity.email };
    const g = (args: string[], input?: string) => {
      const r = spawnSync('git', args, { cwd: this.d.repo, encoding: 'utf8', env, ...(input !== undefined ? { input } : {}) });
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim().slice(-300)}`);
      return r.stdout.trim();
    };
    let head: string;
    try {
      g(['read-tree', base]);
      g(['update-index', '--cacheinfo', `100644,${blob},${file}`]);
      head = g(['commit-tree', g(['write-tree']), '-p', base], `Allow agents to reach ${host}\n\nThe owner answered allow-repo to a refused request for ${host}.\n`);
    } finally {
      rmSync(index, { force: true });
    }
    const branch = `${BRAND.cli}/allow-${host.replace(/[^A-Za-z0-9.-]/g, '-')}`;
    const push = checkedPush({ cwd: this.d.repo, remote: this.remote, base, head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, force: true });
    if (!push.ok) return { pr: null, detail: `the config change couldn't be pushed: ${'refused' in push ? push.refused.join('; ') : push.error.split('\n').pop()}` };
    const opened = await this.d.backlog.openPr(branch, this.branch, `Allow agents to reach ${host}`, `Adds \`${host}\` to \`${file}\` \`network.allow\`, as the owner answered (allow-repo) to an agent's refused request for it. It applies once a human merges this; ${BRAND.name} never merges its own config changes.`);
    return { pr: opened.url, detail: '' };
  }

  private async handleDecisions() {
    const writers = new Set(this.d.cfg.project.owners.writers.map((w) => w.toLowerCase()));
    const cmd = new RegExp(`^/${BRAND.cli}\\s+(\\S+)`, 'm');
    for (const asked of this.d.log.read(0, ['decision.asked'])) {
      const q = asked.payload as EventPayload<'decision.asked'>;
      if (q.issue === null) continue;
      if (q.kind === 'domain') {
        await this.handleDomainDecision(asked.id, q, writers, cmd);
        continue;
      }
      if (q.kind === 'plan') {
        await this.handlePlanDecision(asked.id, q, writers, cmd);
        continue;
      }
      const later = this.events(q.issue).filter((e) => e.id > asked.id);
      // Already acted on: something moved the task on since the question.
      if (later.some((e) => e.type === 'land.queued' || e.type === 'issue.released')) continue;
      let a = this.d.log.read(asked.id, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === q.id);
      if (!a) {
        const reply = (await this.d.backlog.comments(q.issue))
          .filter((c) => writers.has(c.author.toLowerCase()))
          .map((c) => ({ by: c.author, m: c.body.match(cmd) }))
          .filter((x) => x.m && q.options.includes(x.m[1]!))
          .at(-1);
        if (!reply) continue;
        a = this.emit('decision.answered', { id: q.id, by: reply.by, answer: reply.m![1]! }).payload;
      }
      await this.d.backlog.removeLabel(q.issue, 'needs:decision');
      if (q.kind === 'land') {
        const level = this.events(q.issue).filter((e) => e.type === 'review.level_set').at(-1)?.payload as EventPayload<'review.level_set'> | undefined;
        if (a.answer === 'approve' && level) this.emit('land.queued', { issue: q.issue, head: level.head, level: level.level });
        else {
          await this.d.backlog.comment(q.issue, `[${BRAND.cli}] Not landing: @${a.by} answered ${a.answer}.`);
          this.releaseClaim(q.issue, `landing ${a.answer} by ${a.by}`);
        }
      } else {
        const issue = await this.d.backlog.get(q.issue);
        this.releaseClaim(q.issue, `question answered by ${a.by}`);
        await this.d.backlog.removeLabel(q.issue, 'in-review');
        if (issue.labels.includes('type:investigation') && a.answer !== 'investigate-more') {
          // Investigations never turn into code changes on their own.
          await this.d.backlog.comment(
            q.issue,
            a.answer === 'close'
              ? `[${BRAND.cli}] @${a.by} closed the investigation.`
              : `[${BRAND.cli}] @${a.by} approved a fix. Give the fix its own done_when contract (in this issue or a new one), remove \`type:investigation\`, and mark it ready.`,
          );
          if (a.answer === 'close') await this.d.backlog.close(q.issue);
        } else {
          // A worker's question: release and requeue; the next run gets the answer in its brief.
          await this.d.backlog.comment(q.issue, `[${BRAND.cli}] @${a.by} answered: ${a.answer}. Requeued.`);
          await this.d.backlog.addLabels(q.issue, ['ready']);
        }
      }
    }
  }

  /** Answers to this issue's earlier questions, for the next worker's brief. */
  private answers(issue: number): string[] {
    const asked = new Map(this.d.log.read(0, ['decision.asked']).map((e) => [(e.payload as { id: string }).id, e.payload as EventPayload<'decision.asked'>]));
    return this.d.log
      .read(0, ['decision.answered'])
      .map((e) => e.payload as EventPayload<'decision.answered'>)
      .filter((a) => asked.get(a.id)?.issue === issue && asked.get(a.id)?.kind === 'question')
      .map((a) => `Owner decision: "${asked.get(a.id)!.question}" -> ${a.answer} (by ${a.by})`);
  }

  // ---------------------------------------------------------------- landing

  /** Queued changes without a final landing result, oldest first. "deferred" isn't final. */
  private landQueue(): EventPayload<'land.queued'>[] {
    const out: EventPayload<'land.queued'>[] = [];
    for (const q of this.d.log.read(0, ['land.queued'])) {
      const p = q.payload as EventPayload<'land.queued'>;
      const final = this.d.log.read(q.id, ['land.result']).some((r) => (r.payload as { issue: number; outcome: string }).issue === p.issue && (r.payload as { outcome: string }).outcome !== 'deferred');
      if (!final && !out.some((x) => x.issue === p.issue)) out.push(p);
    }
    return out;
  }

  private filesOf(issue: number, head: string): string[] {
    const e = this.events(issue).filter((x) => x.type === 'change.proposed' && (x.payload as { head: string }).head === head).at(-1);
    return (e?.payload as { files?: string[] } | undefined)?.files ?? [];
  }

  /** Seed with the oldest; add later changes whose files don't overlap, at most one L3, up to batch_max. */
  buildBatch(queue: EventPayload<'land.queued'>[]): EventPayload<'land.queued'>[] {
    const max = this.d.cfg.tests.land.batch_max;
    const batch: EventPayload<'land.queued'>[] = [];
    const files = new Set<string>();
    for (const q of queue) {
      if (batch.length >= max) break;
      const f = this.filesOf(q.issue, q.head);
      if (batch.length && f.some((x) => files.has(x))) continue;
      if (q.level === 'L3' && batch.some((b) => b.level === 'L3')) continue;
      batch.push(q);
      f.forEach((x) => files.add(x));
    }
    return batch;
  }

  private async landNext() {
    if (this.landing) return;
    const queue = this.landQueue();
    if (!queue.length) return;
    this.landing = true;
    try {
      if (this.d.cfg.project.land_mode === 'pr') for (const q of queue) await this.proposePr(q);
      else await this.landBatch(this.buildBatch(queue));
    } finally {
      this.landing = false;
    }
  }

  private gateTiers(batch: EventPayload<'land.queued'>[]): string[] {
    const gates = this.d.cfg.tests.gates;
    const money = loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source);
    const touchesMoney = batch.some((q) => this.filesOf(q.issue, q.head).some((f) => money.some((re) => re.test(f))) || this.events(q.issue).some((e) => e.type === 'issue.seen' && (e.payload as { labels: string[] }).labels.includes('money-path')));
    return [...new Set([...gates.land, ...(touchesMoney ? gates.money_path : [])])];
  }

  private tierCommand(name: string): { command: string; exclusive: boolean } {
    const t = this.d.cfg.tests.tiers.find((x) => x.name === name);
    if (t) return { command: t.command, exclusive: t.exclusive };
    if (name === 'full') return { command: this.d.cfg.tests.runner.full, exclusive: true };
    return { command: this.d.cfg.tests.runner.changed, exclusive: false };
  }

  /** Run the land gates: baseline-aware, a failure retried once (flake), exclusive tiers under the machine-wide lock. */
  private async runGates(path: string, tiers: string[]): Promise<{ ok: true; notes: string[]; durations: number[] } | { ok: false; deferred: boolean; note: string }> {
    const notes: string[] = [];
    /** Each tier's passing run, in ms (a flake's retry is the run that counts). */
    const durations: number[] = [];
    for (const tier of tiers) {
      const { command, exclusive } = this.tierCommand(tier);
      let lock: { release(): void } | null = null;
      if (exclusive) {
        const got = await fullRunLock(`${BRAND.cli} land gate ${tier}`, 5_000, this.d.slotsDir);
        if (!('lock' in got)) return { ok: false, deferred: true, note: `tier ${tier} needs the machine-wide full-run slot (held by ${got.holder?.owner ?? 'another run'}); deferred` };
        lock = got.lock;
      }
      try {
        let verdict = null as ReturnType<typeof baselineGate> | null;
        let tail = '';
        let ms = 0;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const t0 = Date.now();
          const r = await this.project(command, path);
          ms = Math.max(0, Date.now() - t0);
          verdict = baselineGate(r.code, r.out, this.d.cfg.tests.failures, latestBaseline(this.d.log));
          tail = r.tail;
          if (verdict.outcome === 'pass') break;
        }
        if (verdict!.outcome === 'fail') return { ok: false, deferred: false, note: `${tier}: ${verdict!.note}${verdict!.newFailures.length ? `: ${verdict!.newFailures.join(', ')}` : ''}\n${tail}` };
        notes.push(`${tier}: ${verdict!.note}`);
        durations.push(ms);
      } finally {
        lock?.release();
      }
    }
    return { ok: true, notes, durations };
  }

  /**
   * Land a batch on the tip in one tested commit. On a red gate: retry once
   * (flake), then split in half and land each half on its own (bors-style
   * bisection); a single change that's still red is ejected with the evidence.
   */
  private async landBatch(batch: EventPayload<'land.queued'>[]): Promise<void> {
    if (!batch.length) return;
    const id = `b-${randomBytes(3).toString('hex')}`;
    const issues = batch.map((q) => q.issue);
    const result = (n: number, outcome: EventPayload<'land.result'>['outcome'], landed: string | null, detail: string) => this.emit('land.result', { issue: n, outcome, landed, detail: `[batch ${id}] ${detail}`.slice(0, 2000) });
    const ownerOf = (n: number) => (this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>).owner;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    this.emit('land.batch', { id, issues, tip, outcome: 'started', detail: '' });
    const name = `land-${id}`;
    const { path, setupErrors } = createWorktree(this.wt, name, `${BRAND.cli}/${name}`, tip);
    let applied: EventPayload<'land.queued'>[] = [];
    let split = false;
    try {
      if (setupErrors.length) {
        for (const n of issues) result(n, 'error', null, `land worktree setup failed: ${setupErrors.join('; ')}`);
        return;
      }
      for (const q of batch) {
        const claimed = this.events(q.issue).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>;
        const pick = spawnSync('git', ['cherry-pick', `${claimed.base}..${q.head}`], { cwd: path, encoding: 'utf8' });
        if (pick.status !== 0) {
          spawnSync('git', ['cherry-pick', '--abort'], { cwd: path });
          result(q.issue, 'conflict', null, `does not apply cleanly on ${tip.slice(0, 8)}${applied.length ? ` after ${applied.map((a) => `#${a.issue}`).join(', ')}` : ''}; never guessing at conflicts`);
          await this.block(q.issue, ownerOf(q.issue), `conflicts with ${this.branch}; needs a rebase`);
          continue;
        }
        applied.push(q);
      }
      if (!applied.length) return;
      for (const step of this.d.cfg.tests.land.pre) {
        const r = await this.project(step, path);
        if (r.code !== 0) {
          for (const q of applied) result(q.issue, 'error', null, `pre-land step failed: ${step}\n${r.tail}`);
          return;
        }
      }
      if (this.git(path, 'status', '--porcelain')) {
        this.git(path, 'add', '-A');
        this.git(path, '-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`, 'commit', '-q', '-m', `Pre-land steps for ${applied.map((a) => `#${a.issue}`).join(', ')}`);
      }
      const gates = await this.runGates(path, this.gateTiers(applied));
      if (!gates.ok) {
        if (gates.deferred) {
          for (const q of applied) result(q.issue, 'deferred', null, gates.note);
          this.emit('land.batch', { id, issues, tip, outcome: 'deferred', detail: gates.note.slice(0, 500) });
          return;
        }
        if (applied.length === 1) {
          const q = applied[0]!;
          result(q.issue, 'red', null, gates.note);
          this.emit('land.batch', { id, issues, tip, outcome: 'red', detail: gates.note.slice(0, 500) });
          await this.block(q.issue, ownerOf(q.issue), `land gate red after rebasing onto ${this.branch}: ${gates.note.split('\n')[0]}`);
          return;
        }
        this.emit('land.batch', { id, issues: applied.map((q) => q.issue), tip, outcome: 'split', detail: gates.note.slice(0, 500) });
        split = true;
        return;
      }
      const scan = await scanRange(path, `${tip}..HEAD`);
      if (scan.status !== 'clean') {
        for (const q of applied) result(q.issue, 'rejected', null, `secret scan ${scan.status} at landing`);
        return;
      }
      const head = this.git(path, 'rev-parse', 'HEAD');
      // A plain (non-force) push only succeeds if the tip hasn't moved: compare-and-swap.
      const push = checkedPush({ cwd: path, remote: this.remote, base: tip, head, ref: `refs/heads/${this.branch}`, limits: this.d.cfg.guardrails.push });
      if (!push.ok && 'refused' in push) {
        for (const q of applied) {
          this.emit('push.refused', { issue: q.issue, head, stage: 'push', reasons: push.refused });
          result(q.issue, 'rejected', null, `push refused: ${push.refused.join('; ')}`);
          await this.block(q.issue, ownerOf(q.issue), pushRefusal(push.refused));
        }
        return;
      }
      if (!push.ok) {
        // The tip moved under us: leave them queued; the next tick rebuilds on the new tip.
        for (const q of applied) result(q.issue, 'deferred', null, `push rejected (tip moved): ${push.error.split('\n').pop()}`);
        return;
      }
      this.emit('check.result', { issue: applied[0]!.issue, head, stage: 'land', checks: gates.notes.map((note, i) => ({ check: note, status: 'pass' as const, exitCode: 0, duration_ms: gates.durations[i] ?? 0 })) });
      this.emit('land.batch', { id, issues: applied.map((q) => q.issue), tip, outcome: 'landed', detail: gates.notes.join('; ') });
      for (const q of applied) result(q.issue, 'landed', head, `landed on ${this.branch} (${gates.notes.join('; ')})`);
      for (const q of applied) await this.afterLand(q.issue, head, ownerOf(q.issue));
    } finally {
      removeWorktree(this.wt, name);
      if (split) {
        const mid = Math.ceil(applied.length / 2);
        await this.landBatch(applied.slice(0, mid));
        await this.landBatch(applied.slice(mid));
      }
      applied = [];
    }
  }

  /**
   * land_mode pr: push the task's own branch and open a pull request for a
   * human to merge. The coordinator never merges and never pushes the
   * default branch; the PR closes the issue when it's merged.
   */
  private async proposePr(q: EventPayload<'land.queued'>) {
    const n = q.issue;
    const branch = this.paths(n).branch;
    if (branch === this.branch) throw new Error(`refusing to push the default branch ${this.branch} in pr mode`);
    const claimedBase = (this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>).base;
    const push = checkedPush({ cwd: this.d.repo, remote: this.remote, base: claimedBase, head: q.head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, force: true });
    if (!push.ok && 'refused' in push) {
      this.emit('push.refused', { issue: n, head: q.head, stage: 'push', reasons: push.refused });
      this.emit('land.result', { issue: n, outcome: 'rejected', landed: null, detail: `push refused: ${push.refused.join('; ')}`.slice(0, 2000) });
      await this.block(n, this.ownerOf(n), pushRefusal(push.refused));
      return;
    }
    if (!push.ok) {
      this.emit('land.result', { issue: n, outcome: 'error', landed: null, detail: `pushing ${branch} failed: ${push.error.slice(-500)}` });
      await this.block(n, this.ownerOf(n), `could not push the task branch ${branch}`);
      return;
    }
    const last = <T>(type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => this.events(n).filter((e) => e.type === type).at(-1)?.payload as T | undefined;
    const lvl = last<{ level: string; reasons: string[] }>('review.level_set');
    const verdict = last<{ patch_correct: boolean; confidence: string; advice: string }>('eval.verdict');
    const checks = last<{ checks: { check: string; status: string }[] }>('check.result');
    const issue = await this.d.backlog.get(n);
    const body = [
      `Closes #${n}`,
      '',
      `Opened by ${BRAND.name}. It merges this itself only if the instance's merge policy allows (required checks green on the evaluated commit, nothing high-risk, design-level, big or in doubt); otherwise it waits for a human.`,
      '',
      `**Review level:** ${lvl?.level ?? '?'}${lvl?.reasons.length ? ` (${lvl.reasons.slice(0, 6).join('; ')})` : ''}`,
      `**Independent evaluator:** ${verdict ? `${verdict.patch_correct ? 'approves' : 'rejects'}, confidence ${verdict.confidence}${verdict.advice ? `: ${verdict.advice.slice(0, 500)}` : ''}` : 'none'}`,
      `**Checks run by the harness:** ${checks?.checks.map((c) => `${c.check} ${c.status}`).join(', ') || 'none'}`,
      ...evalLines(this.instructionResults(n)),
    ].join('\n');
    let url: string;
    try {
      // A draft until its required checks pass on the commit the evaluator approved (the PR watcher marks it ready).
      const pr = await this.d.backlog.openPr(branch, this.branch, `${issue.title} (#${n})`, body, { draft: true, headSha: q.head });
      url = pr.url;
      this.emit('pr.opened', { issue: n, number: pr.number, url, head: q.head, draft: pr.draft });
    } catch (e) {
      this.emit('land.result', { issue: n, outcome: 'error', landed: null, detail: `opening the PR failed: ${(e as Error).message.slice(0, 500)}` });
      await this.block(n, this.ownerOf(n), `could not open a PR for ${branch}`);
      return;
    }
    this.emit('land.result', { issue: n, outcome: 'pr_opened', landed: null, detail: url });
    const claimed = this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>;
    release(n, claimed.lease, { repo: this.d.repo, remote: this.remote });
    try {
      removeWorktree(this.wt, this.paths(n).name);
    } catch {
      // already gone
    }
    await this.d.backlog.comment(n, `[${BRAND.cli}] Opened ${url} for review. Merging it closes this issue.`);
    this.emit('issue.released', { issue: n, instance: this.d.instance, why: 'pr opened' });
  }

  // ---------------------------------------------------------------- PR watch

  /** Open PRs this instance opened: the latest pr.opened per number, without a pr.closed after it. */
  watchedPrs(): EventPayload<'pr.opened'>[] {
    const open = new Map<number, EventPayload<'pr.opened'>>();
    for (const e of this.d.log.read(0, ['pr.opened', 'pr.closed'])) {
      const p = e.payload as EventPayload<'pr.opened'> | EventPayload<'pr.closed'>;
      if (e.type === 'pr.opened') open.set(p.number, p as EventPayload<'pr.opened'>);
      else open.delete(p.number);
    }
    return [...open.values()];
  }

  /**
   * Each watched PR, at most once per poll interval and a few per tick: read its head and the checks on it,
   * record changes, and mark it ready (out of draft, labelled merge-ready) once every required check passed
   * on the exact commit the evaluator approved. A head that moves after that takes the label off again.
   */
  private async watchPrs() {
    const now = Date.now();
    const interval = this.d.prPollMs ?? 60_000;
    // A merge into the default branch (by anyone) is when PRs start conflicting: look at all of them now.
    if (this.watchedPrs().length && now - this.tipCheckedAt >= TIP_CHECK_MS) {
      this.tipCheckedAt = now;
      const r = spawnSync('git', ['ls-remote', this.remote, `refs/heads/${this.branch}`], { cwd: this.d.repo, encoding: 'utf8' });
      const tip = r.status === 0 ? (r.stdout.split(/\s/)[0] ?? '') : '';
      if (tip && tip !== this.defaultTip) {
        if (this.defaultTip) this.prPolled.clear();
        this.defaultTip = tip;
      }
    }
    const due = this.watchedPrs()
      .filter((p) => now - (this.prPolled.get(p.number) ?? 0) >= interval)
      .sort((a, b) => (this.prPolled.get(a.number) ?? 0) - (this.prPolled.get(b.number) ?? 0))
      .slice(0, 10);
    for (const watched of due) {
      this.prPolled.set(watched.number, now);
      await this.watchPr(watched);
    }
  }

  private async watchPr(w: EventPayload<'pr.opened'>) {
    const { issue: n, number } = w;
    const pr = await this.d.backlog.pullRequest(number);
    if (pr.state !== 'open') {
      this.emit('pr.closed', { issue: n, number, merged: pr.state === 'merged' });
      return;
    }
    const conflict = conflictTrigger(pr);
    if (conflict.act === 'recheck') this.prPolled.set(number, Date.now() - (this.d.prPollMs ?? 60_000) + MERGEABLE_RECHECK_MS);
    if (conflict.act === 'fix') return this.maybeFixConflict(w, pr);
    const r = this.prReadiness(n, pr.headSha, await this.d.backlog.checks(pr.headSha));
    const last = this.d.log.read(0, ['pr.status']).map((e) => e.payload as EventPayload<'pr.status'>).filter((p) => p.number === number).at(-1);
    const checks = r.checks.map((c) => ({ name: c.name, outcome: c.outcome }));
    if (!last || last.head !== pr.headSha || last.ready !== r.ready || JSON.stringify(last.checks) !== JSON.stringify(checks)) {
      this.emit('pr.status', { issue: n, number, head: pr.headSha, ready: r.ready, reasons: r.reasons, checks });
    }
    const marked = this.d.log
      .read(0, ['pr.ready', 'pr.unready'])
      .filter((e) => (e.payload as { number: number }).number === number)
      .at(-1);
    const markedHead = marked?.type === 'pr.ready' ? (marked.payload as EventPayload<'pr.ready'>).head : null;
    if (r.ready && markedHead !== pr.headSha) {
      if (pr.draft) await this.d.backlog.markReady(number);
      await this.d.backlog.addLabels(number, ['merge-ready']);
      if (this.fixGaveUp(number)) await this.d.backlog.removeLabel(number, 'ci-failing');
      this.emit('pr.ready', { issue: n, number, head: pr.headSha });
    } else if (!r.ready && markedHead) {
      await this.d.backlog.removeLabel(number, 'merge-ready');
      this.emit('pr.unready', { issue: n, number, head: pr.headSha, why: r.reasons.join('; ').slice(0, 1000) });
    }
    if (!r.ready && r.failed.length) await this.maybeFix(w, pr, r);
    if (r.ready) await this.mergeOrWait(w, pr);
  }

  // ---------------------------------------------------------------- merge policy

  private get stopFile() {
    return join(this.d.stateDir, 'auto-merge-stopped.json');
  }

  /** Why auto-merge is stopped for this instance, or null. Persisted in a file only the operator clears. */
  autoMergeStopped(): string | null {
    if (!existsSync(this.stopFile)) return null;
    try {
      return String((JSON.parse(readFileSync(this.stopFile, 'utf8')) as { reason?: string }).reason ?? 'stopped');
    } catch {
      return `the stop file ${this.stopFile} is unreadable`;
    }
  }

  /** The policy's call on a ready PR at its current head. */
  mergeDecisionFor(n: number, number: number, pr: PullRequest): MergeDecision {
    const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
    const base = (this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>).base;
    const files = this.changeFiles(this.d.repo, base, pr.headSha);
    const labels = (this.events(n).filter((e) => e.type === 'issue.seen').at(-1)?.payload as { labels?: string[] } | undefined)?.labels ?? [];
    const level = computeLevel({ files, labels, moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review);
    const exists = (p: string) => spawnSync('git', ['cat-file', '-e', `${base}:${p}`], { cwd: this.d.repo }).status === 0;
    const newTopLevel = [...new Set(files.map((f) => f.path.split('/')).filter((s) => s.length > 1).map((s) => s[0]!))].filter((d) => !exists(d)).map((d) => `${d}/`);
    const v = this.events(n).filter((e) => e.type === 'eval.verdict' && (e.payload as { head: string }).head === pr.headSha).at(-1)?.payload as EventPayload<'eval.verdict'> | undefined;
    let policyOn = false;
    try {
      policyOn = this.d.autoMerge?.() ?? false;
    } catch {
      // an unreadable policy is "off"
    }
    const d = mergeDecision({
      policyOn,
      repoOn: review.merge.auto,
      stopped: this.autoMergeStopped(),
      level,
      waitCategories: [...review.levels.L3_human.when, 'ci-config', ...review.merge.wait_categories],
      limits: { max_lines: review.merge.max_lines, max_files: review.merge.max_files },
      lines: files.reduce((s, f) => s + f.added + f.removed, 0),
      files: files.length,
      verdict: v ?? null,
      newTopLevel,
      ciFixRuns: this.d.log.read(0, ['ci_fix.started']).filter((e) => (e.payload as { number: number }).number === number).length,
      foreignPush: pr.headSha !== this.ourHead(number),
      pushLimitHit: this.events(n).some((e) => e.type === 'push.refused'),
      instructionEvals: instructionEvalReasons(
        instructionTargets(files.map((f) => f.path)).map((t) => t.target),
        this.instructionResults(n),
      ),
    });
    // A head a conflict fix pushed: its own reasons to wait (outside the hunks, risky files, an unsure evaluator).
    const fix = this.d.log.read(0, ['conflict_fix.finished']).map((e) => e.payload as EventPayload<'conflict_fix.finished'>).filter((p) => p.number === number && p.outcome === 'pushed' && p.head === pr.headSha).at(-1);
    if (fix?.reasons.length) return { ...d, auto: false, reasons: [...d.reasons, ...fix.reasons] };
    return d;
  }

  /**
   * A ready PR: merge it (a merge commit, pinned to the evaluated head) when the policy allows and GitHub says
   * it merges cleanly; otherwise ask the owner once per head, saying why.
   */
  private async mergeOrWait(w: EventPayload<'pr.opened'>, pr: PullRequest) {
    const { issue: n, number } = w;
    const prior = this.d.log
      .read(0, ['merge.decided'])
      .map((e) => e.payload as EventPayload<'merge.decided'>)
      .filter((p) => p.number === number && p.head === pr.headSha)
      .at(-1);
    if (prior && !prior.auto) return; // already waiting for the owner
    const d = this.mergeDecisionFor(n, number, pr);
    if (d.auto) {
      // GitHub still computing: try again next poll. A conflict, or anything else blocking a clean merge: a human.
      if (pr.mergeable === null || pr.mergeableState === 'unknown' || pr.mergeableState === 'draft') return;
      if (!pr.mergeable || !['clean', 'unstable', 'has_hooks'].includes(pr.mergeableState)) d.reasons.push(`GitHub can't merge it cleanly (${pr.mergeableState})`);
      const failures = this.d.log.read(0, ['merge.failed']).map((e) => e.payload as EventPayload<'merge.failed'>).filter((p) => p.number === number && p.head === pr.headSha);
      if (failures.length >= 3) d.reasons.push(`merging failed ${failures.length} times: ${failures.at(-1)!.why}`);
      d.auto = d.reasons.length === 0;
      // The default branch moved under the PR in a way that could matter: check the combination (fast tier only,
      // off the PR) before merging. Not decided until that check has a result.
      if (d.auto) {
        const gate = await this.combinedGate(w, pr);
        if (gate === 'pending') return;
        if (gate !== 'merge') {
          d.reasons.push(gate.hold);
          d.auto = false;
        }
      }
    }
    if (!prior || prior.auto !== d.auto) this.emit('merge.decided', { issue: n, number, head: pr.headSha, auto: d.auto, reasons: d.reasons });
    if (!d.auto) return this.waitForOwner(w, pr.headSha, d.reasons);
    const m = await this.d.backlog.mergePr(number, pr.headSha, `${pr.title} (#${number})`);
    if (!m.ok) {
      this.emit('merge.failed', { issue: n, number, head: pr.headSha, why: m.why.slice(0, 500) });
      return;
    }
    this.emit('merge.done', { issue: n, number, head: pr.headSha, sha: m.sha, url: pr.url, title: pr.title });
    this.prPolled.clear(); // the other open PRs may conflict now: look at them on the next pass
    await this.d.backlog.comment(number, `[${BRAND.cli}] Auto-merged as \`${m.sha.slice(0, 8)}\` (a merge commit of the evaluated head \`${pr.headSha.slice(0, 8)}\`): every required check passed on it and nothing in it needs a human under this instance's merge policy.`);
  }

  /** A PR that waits for the owner: the needs-owner label, one comment with every reason, a review request. */
  private async waitForOwner(w: EventPayload<'pr.opened'>, head: string, reasons: string[]) {
    const owner = this.ownerOf(w.issue);
    await this.d.backlog.addLabels(w.number, ['needs-owner']);
    await this.d.backlog.comment(w.number, `[${BRAND.cli}] @${owner} ready, and waits for you to review and merge (\`${head.slice(0, 8)}\`):\n${reasons.map((r) => `- ${r}`).join('\n')}`);
    try {
      await this.d.backlog.requestReview(w.number, [owner]);
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: `review request #${w.number}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    }
  }

  /**
   * After each auto-merge, the default branch's required checks on its merge commit. Red, with the commit
   * before it green: stop auto-merging on this instance, open a revert PR and tell the owner. Red with main
   * already red before it: stop and tell, nothing to revert. A stop lasts until the operator clears it.
   */
  private async watchMerges() {
    const stopped = this.d.log.read(0, ['merge.stopped', 'merge.resumed']).at(-1);
    if (stopped?.type === 'merge.stopped' && !existsSync(this.stopFile)) this.emit('merge.resumed', { detail: 'the operator cleared the stop' });
    const judged = new Set(this.d.log.read(0, ['merge.main_result']).map((e) => (e.payload as { sha: string }).sha));
    const now = Date.now();
    for (const e of this.d.log.read(0, ['merge.done'])) {
      const m = e.payload as EventPayload<'merge.done'>;
      if (judged.has(m.sha) || now - (this.mainPolled.get(m.sha) ?? 0) < (this.d.prPollMs ?? 60_000)) continue;
      this.mainPolled.set(m.sha, now);
      const required = this.d.cfg.project.required_checks;
      const outcomes = requiredOutcomes(required, await this.d.backlog.checks(m.sha));
      const failed = outcomes.filter((c) => c.outcome === 'fail' || c.outcome === 'cancelled').map((c) => c.name);
      if (!failed.length && outcomes.some((c) => c.outcome !== 'pass')) continue; // still running
      this.emit('merge.main_result', { issue: m.issue, number: m.number, sha: m.sha, outcome: failed.length ? 'red' : 'green', failed });
      if (failed.length) await this.mainWentRed(m, failed);
    }
  }

  private async mainWentRed(m: EventPayload<'merge.done'>, failed: string[]) {
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    let parent = '';
    try {
      parent = this.git(this.d.repo, 'rev-parse', `${m.sha}^1`);
    } catch {
      // not a commit we have: treated as "main's state before it is unknown"
    }
    const before = parent ? requiredOutcomes(this.d.cfg.project.required_checks, await this.d.backlog.checks(parent)) : [];
    const wasGreen = before.length > 0 && before.every((c) => c.outcome === 'pass');
    const revert = wasGreen ? await this.openRevert(m, failed) : null;
    const what = `${this.branch}'s required checks failed (${failed.join(', ')}) on \`${m.sha.slice(0, 8)}\` after auto-merging #${m.number}`;
    const reason = wasGreen ? `${what}${revert ? `; revert PR ${revert.url}` : '; opening a revert PR failed'}` : `${what}, but ${this.branch} was not green before it (\`${parent.slice(0, 8) || '?'}\`), so nothing was reverted`;
    writeGroupOnly(this.stopFile, JSON.stringify({ reason, number: m.number, sha: m.sha, revert: revert?.url ?? null, at: new Date().toISOString() }, null, 2));
    this.emit('merge.stopped', { reason, number: m.number, sha: m.sha, revert: revert?.url ?? null });
    const owner = this.ownerOf(m.issue);
    const resume = `Auto-merge is stopped on this instance until the operator deletes \`${this.stopFile}\`; until then every PR waits for you.`;
    await this.d.backlog.comment(m.number, `[${BRAND.cli}] @${owner} ${reason}. ${resume}`);
    if (revert) {
      await this.d.backlog.addLabels(revert.number, ['needs-owner']);
      await this.d.backlog.comment(revert.number, `[${BRAND.cli}] @${owner} reverts #${m.number}: ${what}. This revert waits for you; it never merges itself. ${resume}`);
      try {
        await this.d.backlog.requestReview(revert.number, [owner]);
      } catch (e) {
        this.emit('coordinator.error', { instance: this.d.instance, where: `review request #${revert.number}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
      }
    }
  }

  /** A PR reverting an auto-merge (git revert -m 1 on the current tip), through the push checks. Never watched, so never merged by the harness. */
  private async openRevert(m: EventPayload<'merge.done'>, failed: string[]): Promise<{ url: string; number: number } | null> {
    const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const dir = join(this.d.stateDir, 'reverts', `pr-${m.number}`);
    const branch = `${BRAND.cli}/revert-pr-${m.number}`;
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.d.repo });
    try {
      this.git(this.d.repo, 'worktree', 'add', '-q', '--detach', dir, tip);
      const rv = spawnSync('git', ['-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`, 'revert', '-m', '1', '--no-edit', m.sha], { cwd: dir, encoding: 'utf8' });
      if (rv.status !== 0) {
        this.emit('coordinator.error', { instance: this.d.instance, where: `revert #${m.number}`, kind: 'error', message: (rv.stderr || rv.stdout).trim().slice(-500) });
        return null;
      }
      const head = this.git(dir, 'rev-parse', 'HEAD');
      const push = checkedPush({ cwd: dir, remote: this.remote, base: tip, head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, force: true });
      if (!push.ok) {
        this.emit('coordinator.error', { instance: this.d.instance, where: `revert #${m.number}`, kind: 'error', message: ('refused' in push ? push.refused.join('; ') : push.error).slice(0, 500) });
        return null;
      }
      const body = `Reverts #${m.number} (\`${m.sha.slice(0, 8)}\`): after it was auto-merged, ${this.branch}'s required checks failed: ${failed.join(', ')}.\n\nOpened by ${BRAND.name}. It never merges this; a human does.`;
      const pr = await this.d.backlog.openPr(branch, this.branch, `Revert "${m.title}" (#${m.number})`, body, { headSha: head });
      return { url: pr.url, number: pr.number };
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.d.repo });
      spawnSync('git', ['worktree', 'prune'], { cwd: this.d.repo });
    }
  }

  // ---------------------------------------------------------------- CI fix runs

  private fixGaveUp(number: number): boolean {
    return this.d.log.read(0, ['ci_fix.gave_up']).some((e) => (e.payload as { number: number }).number === number);
  }

  /** The last commit the harness itself put on a PR's branch: the head it opened with, or its latest pushed fix. */
  private ourHead(number: number): string | null {
    let head: string | null = null;
    for (const e of this.d.log.read(0, ['pr.opened', 'ci_fix.finished', 'conflict_fix.finished'])) {
      const p = e.payload as { number: number; head: string | null; outcome?: string };
      if (p.number === number && (e.type === 'pr.opened' || p.outcome === 'pushed')) head = p.head;
    }
    return head;
  }

  /**
   * A required check failed on a watched PR: start a fix run on its branch, within the cap, or give up and ask
   * the owner. Never on a branch someone else pushed to, and never without the failing job's log (a fix that
   * can't see why CI failed would be a guess).
   */
  private async maybeFix(w: EventPayload<'pr.opened'>, pr: PullRequest, r: Readiness) {
    const { issue: n, number } = w;
    if (this.active.has(n) || this.stopped || this.halt.signal.aborted || this.fixGaveUp(number)) return;
    const failed = r.failed.map((c) => c.name);
    const give = (reason: string) => this.giveUpFix(w, pr.headSha, reason, failed);
    const ours = this.ourHead(number);
    if (pr.headSha !== ours) return give(`someone else pushed to the branch (its head ${pr.headSha.slice(0, 8)} is not the harness's last push ${ours?.slice(0, 8) ?? 'none'}), and the harness never pushes over that`);
    const role = this.d.cfg.agents.roles.ci_repair;
    if (!role?.enabled) return give('CI fix runs are off (agents.yaml roles.ci_repair)');
    const runs = this.d.log.read(0, ['ci_fix.started']).filter((e) => (e.payload as { number: number }).number === number).length;
    const cap = role.max_fixes_per_pr ?? 2;
    if (runs >= cap) return give(`${runs} fix run(s) already, the limit (agents.yaml roles.ci_repair.max_fixes_per_pr: ${cap})`);
    const hold = this.governorHold();
    this.noteHold(hold);
    if (hold) return;
    const logs: string[] = [];
    for (const c of r.failed) {
      if (c.id === undefined) return give(`${c.name} has no job log the harness can read (it isn't a check run), so a fix would be a guess`);
      const log = await this.d.backlog.jobLog(c.id);
      if (!log.ok)
        return give(log.why === 'forbidden' ? `can't read the log of ${c.name}: the GitHub credential has no Actions: read permission, and a fix without the log would be a guess` : `the log of ${c.name} isn't available (not a GitHub Actions job, or expired), so a fix would be a guess`);
      logs.push(`### ${c.name}\n${logTail(log.text)}`);
    }
    const slot = tryAgentSlot(`${BRAND.cli} ${this.d.cfg.project.project.name} #${n} CI fix`, this.d.slotsDir);
    if (!slot) {
      this.noteHold({ reason: 'machine-wide agent cap reached (all harnesses)', load: null, freeDiskPct: null });
      return;
    }
    const p = this.fixRun(w, pr, failed, logs, runs + 1)
      .catch((e: Error) => {
        this.emit('coordinator.error', { instance: this.d.instance, where: `CI fix #${n}`, kind: 'error', message: e.message.slice(0, 500) });
      })
      .finally(() => {
        slot.release();
        this.active.delete(n);
      });
    this.active.set(n, p);
  }

  /** No more fix runs on this PR: say why on it, label it, and ask the owner to review. */
  private async giveUpFix(w: EventPayload<'pr.opened'>, head: string, reason: string, failed: string[]) {
    const owner = this.ownerOf(w.issue);
    this.emit('ci_fix.gave_up', { issue: w.issue, number: w.number, head, reason: reason.slice(0, 2000) });
    await this.d.backlog.addLabels(w.number, ['ci-failing']);
    await this.d.backlog.comment(w.number, `[${BRAND.cli}] @${owner} required check(s) failing on \`${head.slice(0, 8)}\`: ${failed.join(', ')}. No more CI fix runs on this PR: ${reason}. It needs you; nothing here merges it.`);
    try {
      await this.d.backlog.requestReview(w.number, [owner]);
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: `review request #${w.number}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    }
  }

  /**
   * One fix run: reclaim the issue, a worktree at the PR's head, a worker with the failing logs, then the
   * usual inspect, verify and evaluate on the whole change, and a push to the same branch only if it is still
   * at the head the run started from. Anything short of that gives up and asks the owner.
   */
  private async fixRun(w: EventPayload<'pr.opened'>, pr: PullRequest, failed: string[], logs: string[], attempt: number) {
    const { issue: n, number } = w;
    const last = <T>(type: StoredEvent['type']) => this.events(n).filter((e) => e.type === type).at(-1)?.payload as T | undefined;
    const claimed = last<EventPayload<'issue.claimed'>>('issue.claimed')!;
    const doneWhen = (last<EventPayload<'contract.agreed'>>('contract.agreed')?.done_when ?? []) as DoneWhenList;
    const frozen = last<EventPayload<'repro.frozen'>>('repro.frozen');
    const repro = frozen ? { path: frozen.path, hash: frozen.hash } : null;
    const issue = await this.d.backlog.get(n);
    this.git(this.d.repo, 'fetch', '-q', this.remote, `+refs/heads/${pr.head}:refs/remotes/${this.remote}/${pr.head}`);
    const lease: Lease = { instance: this.d.instance, run_id: randomBytes(4).toString('hex'), issue: n, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString(), base: claimed.base };
    const won = claim(lease, { repo: this.d.repo, remote: this.remote });
    if (!won.won) return; // held elsewhere; the next poll tries again
    let leaseSha = won.sha;
    this.emit('ci_fix.started', { issue: n, number, head: pr.headSha, checks: failed, attempt, lease: leaseSha });
    const heartbeat = setInterval(() => {
      const next = renew({ ...lease, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString() }, leaseSha, { repo: this.d.repo, remote: this.remote });
      if (next) leaseSha = next;
    }, 20 * 60_000);
    heartbeat.unref();
    const { name, branch, taskFile } = this.paths(n);
    let finished: { outcome: 'pushed' | 'no_push'; head: string | null; detail: string } = { outcome: 'no_push', head: null, detail: '' };
    const give = async (reason: string) => {
      finished = { outcome: 'no_push', head: null, detail: reason.slice(0, 1000) };
      await this.giveUpFix(w, pr.headSha, reason, failed);
    };
    try {
      const { path, setupErrors } = createWorktree(this.wt, name, branch, pr.headSha);
      if (setupErrors.length) return await give(`the fix worktree's setup failed: ${setupErrors.join('; ')}`);
      this.writeTask(taskFile, { id: `issue-${n}`, done_when: doneWhen, ...(repro ? { frozen: [repro.path] } : {}) });
      const s = await this.fixAgent(issue, doneWhen, path, taskFile, repro, pr, logs, attempt);
      if ('ended' in s) return await give(s.ended);
      removeSandboxPlaceholders(path);
      const head = this.git(path, 'rev-parse', 'HEAD');
      if (s.no_change_needed || head === pr.headSha) return await give(`the fix run found the failure isn't caused by this change: ${s.no_change_needed ?? `it made no commit (${s.summary})`}`);
      if (spawnSync('git', ['merge-base', '--is-ancestor', pr.headSha, head], { cwd: path }).status !== 0) return await give('the fix run rewrote the branch history instead of adding commits');
      const change = await this.inspect(n, path, claimed.base, head, repro);
      if ('rejected' in change) return await give(`the fix was rejected: ${change.rejected}`);
      const checks = await this.verify(n, path, head, doneWhen, repro);
      const red = checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped');
      if (red.length) return await give(`the fix doesn't pass the coordinator's own checks: ${red.map((c) => `${c.check} ${c.status}`).join(', ')}`);
      const verdict = await this.evaluate(issue, doneWhen, path, claimed.base, head, change.patchHash, checks, repro, change.tampered, change.files.map((f) => f.path));
      if (!verdict.patch_correct) return await give(`the evaluator rejected the fix: ${verdict.advice || 'no reason given'}`);
      const push = checkedPush({ cwd: path, remote: this.remote, base: claimed.base, head, ref: `refs/heads/${pr.head}`, limits: this.d.cfg.guardrails.push, expect: pr.headSha });
      if (!push.ok && 'refused' in push) {
        this.emit('push.refused', { issue: n, head, stage: 'push', reasons: push.refused });
        return await give(pushRefusal(push.refused));
      }
      if (!push.ok) return await give(`the branch moved while the fix ran (someone pushed), so the harness didn't push over it: ${push.error.split('\n').pop()}`);
      finished = { outcome: 'pushed', head, detail: s.summary.slice(0, 1000) };
      await this.d.backlog.comment(number, `[${BRAND.cli}] ${failed.join(', ')} failed on \`${pr.headSha.slice(0, 8)}\`. CI fix run ${attempt} pushed \`${head.slice(0, 8)}\`: ${s.summary}`);
    } catch (e) {
      if (e instanceof StoppedByOwner) await give(e.message);
      else if (!(e instanceof Halted)) throw e;
      else finished = { outcome: 'no_push', head: null, detail: 'stopped by an emergency stop' };
    } finally {
      clearInterval(heartbeat);
      release(n, leaseSha, { repo: this.d.repo, remote: this.remote });
      try {
        removeWorktree(this.wt, name);
      } catch {
        // already gone
      }
      this.emit('ci_fix.finished', { issue: n, number, ...finished });
    }
  }

  /** The fix run's worker: the issue's brief plus the failing logs. Ends with its answer, or why it stopped. */
  private async fixAgent(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, repro: { path: string } | null, pr: PullRequest, logs: string[], attempt: number): Promise<{ summary: string; no_change_needed?: string } | { ended: string }> {
    const n = issue.number;
    const workers = this.d.cfg.agents.roles.workers!;
    const role = this.d.cfg.agents.roles.ci_repair!;
    const model = role.model || workers.model;
    const { runner, checks } = this.d.cfg.tests;
    const extra = [
      `CI fix run ${attempt}: this issue's pull request (${pr.url}, branch ${pr.head}, head ${pr.headSha}) failed a required check on GitHub. The end of each failing job's log:`,
      ...logs.map((l) => `\`\`\`\n${l}\n\`\`\``),
      'Fix the failure with new commits on this branch; never rewrite its history. When you finish, the coordinator re-runs the done_when checks' + (checks.length ? ` and ${checks.join('; ')}` : '') + ', the evaluator judges the whole change, and the coordinator pushes your commits to the pull request.',
      "If the failure isn't caused by this change (for example a test that also fails on the default branch, or a flaky one), commit nothing and put your evidence in no_change_needed.",
      `Fast tests to run while you work: ${runner.changed}`,
      ...(repro?.path ? [`Frozen reproduction test (must pass; never edit): ${repro.path}`] : []),
    ];
    const r = await this.d.runner.run({
      env: this.d.cfg.tests.env,
      role: 'worker',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'worker'),
      cwd: path,
      model,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      maxTurns: 200,
      maxBudgetUsd: Math.min(role.budget_usd ?? workers.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: WORKER_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'ci-fix', model, worktree: path, pid: p, pgid: p, attempt }),
    });
    this.cost(n, 'ci-fix', r);
    this.emit('run.finished', { issue: n, role: 'ci-fix', reason: r.reason, detail: r.detail.slice(0, 1000) });
    const s = (r.structured ?? {}) as { summary?: string; blocked?: string; no_change_needed?: string; ask?: { question: string } };
    if (r.reason !== 'succeeded') return { ended: `the fix run ended: ${r.reason} (${r.detail.slice(0, 300)})` };
    if (s.blocked) return { ended: `the fix run was blocked: ${s.blocked}` };
    if (s.ask) return { ended: `the fix run has a question for you: ${s.ask.question}` };
    return { summary: s.summary ?? '', ...(s.no_change_needed ? { no_change_needed: s.no_change_needed } : {}) };
  }

  // ---------------------------------------------------------------- combined-state check

  /**
   * Whether a PR the policy would merge can merge as is: yes when the combined-state check is off, the default
   * branch hasn't moved since the PR branched, or its new commits touch nothing the PR touches or imports.
   * Otherwise the result of the check on that exact head and branch tip (started in the background if there is
   * none yet: 'pending'). The PR is never changed: a pass merges the unchanged head that already passed CI.
   */
  private async combinedGate(w: EventPayload<'pr.opened'>, pr: PullRequest): Promise<'merge' | 'pending' | { hold: string }> {
    if (!this.d.cfg.project.combined_check) return 'merge';
    const { number } = w;
    const baseRef = pr.base || this.branch;
    this.git(this.d.repo, 'fetch', '-q', this.remote, baseRef, `+refs/heads/${pr.head}:refs/remotes/${this.remote}/${pr.head}`);
    const mainSha = this.git(this.d.repo, 'rev-parse', `${this.remote}/${baseRef}`);
    const mb = this.gitOrNull(this.d.repo, 'merge-base', pr.headSha, mainSha);
    if (!mb) return { hold: `can't find where this PR branched from ${baseRef}, so the combination can't be checked` };
    const mainChanged = mb === mainSha ? [] : changedFiles(this.d.repo, mb, mainSha);
    const prFiles = this.git(this.d.repo, 'diff', '--name-only', mb, pr.headSha).split('\n').filter(Boolean);
    const imports: Record<string, string[]> = {};
    if (mainChanged.length) {
      const tree = new Set(this.git(this.d.repo, 'ls-tree', '-r', '--name-only', pr.headSha).split('\n').filter(Boolean));
      for (const f of prFiles) {
        if (!/\.((m|c)?(j|t)sx?|py)$/.test(f)) continue;
        const r = spawnSync('git', ['show', `${pr.headSha}:${f}`], { cwd: this.d.repo, encoding: 'utf8' });
        if (r.status === 0) imports[f] = importsOf(f, r.stdout, tree);
      }
    }
    const plan = lightCheckPlan({ enabled: true, mainChanged, prFiles, imports });
    if (plan.action === 'merge-now') return 'merge';
    const done = this.d.log
      .read(0, ['light_check.finished'])
      .map((e) => e.payload as EventPayload<'light_check.finished'>)
      .filter((p) => p.number === number && p.head === pr.headSha && p.main_sha === mainSha)
      .at(-1);
    if (done?.outcome === 'merge') return 'merge';
    if (done?.outcome === 'hold') return { hold: `combined with ${baseRef} at ${mainSha.slice(0, 8)} (which changed ${plan.overlap.slice(0, 3).join(', ')}), the fast tests fail: ${done.detail.split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 400)}` };
    if (done?.outcome === 'conflict') return 'pending'; // GitHub reports the conflict next, and the conflict path takes it
    if (!this.lightRunning.has(number) && !this.active.has(w.issue)) {
      this.lightRunning.add(number);
      void this.lightCheck(w, pr, baseRef, mainSha, plan.overlap)
        .catch((e: Error) => this.emit('coordinator.error', { instance: this.d.instance, where: `combined check #${number}`, kind: 'error', message: e.message.slice(0, 500) }))
        .finally(() => this.lightRunning.delete(number));
    }
    return 'pending';
  }

  /** Merge the default branch into the PR head in a scratch worktree and run the fast tier there. Nothing is pushed. */
  private async lightCheck(w: EventPayload<'pr.opened'>, pr: PullRequest, baseRef: string, mainSha: string, overlap: string[]) {
    const { issue: n, number } = w;
    const t0 = Date.now();
    this.emit('light_check.started', { issue: n, number, head: pr.headSha, main_sha: mainSha, overlap });
    const name = `issue-${n}-combined`;
    let outcome: 'merge' | 'hold' | 'conflict' = 'hold';
    let detail = '';
    try {
      const { path, setupErrors } = createWorktree(this.wt, name, `${BRAND.cli}/combined-${n}`, pr.headSha);
      if (setupErrors.length) detail = `the scratch worktree's setup failed: ${setupErrors.join('; ')}`;
      else {
        const m = mergeBaseInto(path, mainSha, `Combined check: ${baseRef} into ${pr.head}`, this.identity);
        if ('error' in m) detail = `merging ${baseRef} in failed: ${m.error}`;
        else if (!m.clean) {
          abortMerge(path);
          outcome = 'conflict';
          detail = `conflicts in ${Object.keys(m.conflicted).join(', ')}`;
        } else {
          const r = await this.project(this.d.cfg.tests.runner.changed, path);
          outcome = lightOutcome({ merged: true, fastPassed: r.code === 0 });
          detail = r.code === 0 ? '' : r.tail.slice(-1500);
        }
      }
    } finally {
      try {
        removeWorktree(this.wt, name);
      } catch {
        // already gone
      }
      spawnSync('git', ['branch', '-D', `${BRAND.cli}/combined-${n}`], { cwd: this.d.repo });
      this.emit('light_check.finished', { issue: n, number, head: pr.headSha, main_sha: mainSha, overlap, outcome, wait_ms: Math.max(0, Date.now() - t0), detail });
      this.prPolled.delete(number); // decide on the next pass, not after the poll interval
    }
  }

  // ---------------------------------------------------------------- conflict fix runs

  /**
   * GitHub reports a watched PR as conflicting with its base: merge the base into the branch and let a worker
   * resolve the conflicted hunks, within the cap; otherwise ask the owner. Never on a branch someone else
   * pushed to. Recorded once per head and base as conflict_fix.detected.
   */
  private async maybeFixConflict(w: EventPayload<'pr.opened'>, pr: PullRequest) {
    const { issue: n, number } = w;
    if (this.active.has(n) || this.stopped || this.halt.signal.aborted) return;
    const baseRef = pr.base || this.branch;
    this.git(this.d.repo, 'fetch', '-q', this.remote, baseRef);
    const baseSha = this.git(this.d.repo, 'rev-parse', `${this.remote}/${baseRef}`);
    // The branch already contains its base: GitHub's merge check is behind. Look again soon instead.
    this.git(this.d.repo, 'fetch', '-q', this.remote, `+refs/heads/${pr.head}:refs/remotes/${this.remote}/${pr.head}`);
    if (spawnSync('git', ['merge-base', '--is-ancestor', baseSha, pr.headSha], { cwd: this.d.repo }).status === 0) {
      this.prPolled.set(number, Date.now() - (this.d.prPollMs ?? 60_000) + MERGEABLE_RECHECK_MS);
      return;
    }
    const seen = this.d.log.read(0, ['conflict_fix.detected']).filter((e) => {
      const p = e.payload as EventPayload<'conflict_fix.detected'>;
      return p.number === number && p.head === pr.headSha && p.base_sha === baseSha;
    }).at(-1);
    // The owner was already asked about this head and base: once is enough (a new push or base looks again).
    if (seen && this.d.log.read(seen.id, ['conflict_fix.finished']).some((e) => (e.payload as { number: number; outcome: string }).number === number && (e.payload as { outcome: string }).outcome === 'gave_up')) return;
    if (!seen) this.emit('conflict_fix.detected', { issue: n, number, head: pr.headSha, base_sha: baseSha });
    const give = (reason: string) => this.giveUpConflict(w, pr.headSha, baseSha, reason, []);
    const ours = this.ourHead(number);
    if (pr.headSha !== ours) return give(`someone else pushed to the branch (its head ${pr.headSha.slice(0, 8)} is not the harness's last push ${ours?.slice(0, 8) ?? 'none'}), and the harness never pushes over that`);
    const cfg = this.d.cfg.project.conflicts;
    if (!cfg.fix) return give('conflict fix runs are off (config.yaml conflicts.fix)');
    const used = conflictFixesUsed(this.d.log.read(0, ['conflict_fix.started']), number);
    if (used >= cfg.max_fixes_per_pr) return give(`${used} conflict fix run(s) already, the limit (config.yaml conflicts.max_fixes_per_pr: ${cfg.max_fixes_per_pr})`);
    const hold = this.governorHold();
    this.noteHold(hold);
    if (hold) return;
    const slot = tryAgentSlot(`${BRAND.cli} ${this.d.cfg.project.project.name} #${n} conflict fix`, this.d.slotsDir);
    if (!slot) {
      this.noteHold({ reason: 'machine-wide agent cap reached (all harnesses)', load: null, freeDiskPct: null });
      return;
    }
    const p = this.conflictRun(w, pr, baseRef, baseSha, used + 1)
      .catch((e: Error) => {
        this.emit('coordinator.error', { instance: this.d.instance, where: `conflict fix #${n}`, kind: 'error', message: e.message.slice(0, 500) });
      })
      .finally(() => {
        slot.release();
        this.active.delete(n);
      });
    this.active.set(n, p);
  }

  /** No (more) conflict fixes on this PR: say why on it, label it, ask the owner to review. */
  private async giveUpConflict(w: EventPayload<'pr.opened'>, head: string, baseSha: string, reason: string, files: string[], record = true) {
    const owner = this.ownerOf(w.issue);
    if (record) this.emit('conflict_fix.finished', { issue: w.issue, number: w.number, base_sha: baseSha, strategy: 'merge', outcome: 'gave_up', head: null, files, waits_owner: true, reasons: [], detail: reason.slice(0, 1000) });
    await this.d.backlog.addLabels(w.number, ['needs-owner']);
    await this.d.backlog.comment(w.number, `[${BRAND.cli}] @${owner} this PR conflicts with its base (\`${baseSha.slice(0, 8)}\`) at \`${head.slice(0, 8)}\`. No conflict fix: ${reason}. It needs you; nothing here merges it.`);
    try {
      await this.d.backlog.requestReview(w.number, [owner]);
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: `review request #${w.number}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    }
  }

  /** git, returning null instead of throwing (a path missing at a commit, an unmerged index entry). */
  private gitOrNull(cwd: string, ...args: string[]): string | null {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
  }

  /** What the base branch changed in the conflicted files since the PR branched: each commit's subject and body. */
  private baseSides(path: string, head: string, baseSha: string, files: string[]): Side[] {
    const mb = this.gitOrNull(path, 'merge-base', head, baseSha);
    if (!mb) return [];
    const log = this.gitOrNull(path, 'log', '--format=%s%x1f%b%x1e', '-n', '5', `${mb}..${baseSha}`, '--', ...files) ?? '';
    return log
      .split('\x1e')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [subject, body] = x.split('\x1f');
        return { label: subject!.trim(), intent: (body ?? '').trim().slice(0, 1500) || subject!.trim() };
      });
  }

  /**
   * One conflict fix: reclaim the issue, a worktree at the PR's head, merge the base in (a merge commit), a
   * worker for the conflicted hunks, then inspect, verify and evaluate against the new base (with the
   * resolution diff given to the evaluator separately), and a push to the same branch only if it is still at
   * the head the run started from. The merge policy then decides from scratch on the new head.
   */
  private async conflictRun(w: EventPayload<'pr.opened'>, pr: PullRequest, baseRef: string, baseSha: string, attempt: number) {
    const { issue: n, number } = w;
    const last = <T>(type: StoredEvent['type']) => this.events(n).filter((e) => e.type === type).at(-1)?.payload as T | undefined;
    const claimed = last<EventPayload<'issue.claimed'>>('issue.claimed')!;
    const doneWhen = (last<EventPayload<'contract.agreed'>>('contract.agreed')?.done_when ?? []) as DoneWhenList;
    const frozen = last<EventPayload<'repro.frozen'>>('repro.frozen');
    const repro = frozen ? { path: frozen.path, hash: frozen.hash } : null;
    const issue = await this.d.backlog.get(n);
    this.git(this.d.repo, 'fetch', '-q', this.remote, `+refs/heads/${pr.head}:refs/remotes/${this.remote}/${pr.head}`);
    const lease: Lease = { instance: this.d.instance, run_id: randomBytes(4).toString('hex'), issue: n, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString(), base: claimed.base };
    const won = claim(lease, { repo: this.d.repo, remote: this.remote });
    if (!won.won) return; // held elsewhere; the next poll tries again
    let leaseSha = won.sha;
    this.emit('conflict_fix.started', { issue: n, number, head: pr.headSha, base_sha: baseSha, strategy: 'merge', attempt, lease: leaseSha });
    const heartbeat = setInterval(() => {
      const next = renew({ ...lease, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString() }, leaseSha, { repo: this.d.repo, remote: this.remote });
      if (next) leaseSha = next;
    }, 20 * 60_000);
    heartbeat.unref();
    const { name, branch, taskFile } = this.paths(n);
    let files: string[] = [];
    let finished: Omit<EventPayload<'conflict_fix.finished'>, 'issue' | 'number' | 'base_sha' | 'strategy'> = { outcome: 'no_push', head: null, files: [], waits_owner: false, reasons: [], detail: '' };
    const give = async (reason: string) => {
      finished = { outcome: 'gave_up', head: null, files, waits_owner: true, reasons: [], detail: reason.slice(0, 1000) };
      await this.giveUpConflict(w, pr.headSha, baseSha, reason, files, false);
    };
    try {
      const { path, setupErrors } = createWorktree(this.wt, name, branch, pr.headSha);
      if (setupErrors.length) return await give(`the fix worktree's setup failed: ${setupErrors.join('; ')}`);
      this.writeTask(taskFile, { id: `issue-${n}`, done_when: doneWhen, ...(repro ? { frozen: [repro.path] } : {}) });
      const merged = mergeBaseInto(path, baseSha, `Merge ${baseRef} into ${pr.head}`, this.identity);
      if ('error' in merged) return await give(`merging ${baseRef} into the branch failed: ${merged.error}`);
      let outside: string[] = [];
      let summary = `${baseRef} merged in without conflicts (GitHub's conflict no longer reproduces)`;
      let resolution = 'No conflicted hunks: the base merged in cleanly.';
      if (!merged.clean) {
        files = Object.keys(merged.conflicted).sort();
        // What the merge itself made of every other file, to tell a resolution that strays from one that doesn't.
        const staged = Object.fromEntries(merged.otherFiles.map((f) => [f, this.gitOrNull(path, 'rev-parse', `:${f}`)]));
        const hunks = Object.entries(merged.conflicted).flatMap(([f, t]) => parseConflicts(f, t));
        const brief = conflictBrief({ baseRef, baseSha, strategy: 'merge', hunks, ours: { label: `this pull request (#${number}, issue #${n}: ${issue.title})`, intent: issue.body }, theirs: this.baseSides(path, pr.headSha, baseSha, files) });
        const s = await this.conflictAgent(issue, doneWhen, path, taskFile, repro, pr, brief, attempt);
        if ('ended' in s) return await give(s.ended);
        summary = s.summary;
        removeSandboxPlaceholders(path);
        if (this.git(path, 'diff', '--name-only', '--diff-filter=U')) return await give('the fix run left conflicts unresolved');
        // Still exactly the merge of the PR's head and the base: no rewritten history, no extra commits.
        if (this.gitOrNull(path, 'rev-parse', 'HEAD^1') !== pr.headSha || this.gitOrNull(path, 'rev-parse', 'HEAD^2') !== baseSha) return await give('the fix run did not finish the merge commit of the branch and its base (it rewrote history, added commits, or left the merge uncommitted)');
        // Exactly as committed (no trimming): the comparison is line for line, the last line included.
        const committed = (f: string) => {
          const r = spawnSync('git', ['show', `HEAD:${f}`], { cwd: path, encoding: 'utf8' });
          return r.status === 0 ? r.stdout : null;
        };
        const resolved = Object.fromEntries(files.map((f) => [f, committed(f)]));
        const expected = new Set([...files, ...merged.otherFiles]);
        const strays = [
          ...merged.otherFiles.filter((f) => this.gitOrNull(path, 'rev-parse', `HEAD:${f}`) !== staged[f]),
          ...this.git(path, 'diff', '--name-only', 'HEAD^1', 'HEAD').split('\n').filter((f) => f && !expected.has(f)),
        ];
        outside = outsideHunks(merged.conflicted, resolved, strays);
        resolution = ['How the conflicts were resolved (a combined diff of the merge commit against both parents):', '```diff', (this.gitOrNull(path, 'show', '--format=', '--cc', 'HEAD') ?? '').slice(0, 12_000), '```'].join('\n');
      }
      const head = this.git(path, 'rev-parse', 'HEAD');
      // Against the new base: the PR's own change, not what the base brought in.
      const change = await this.inspect(n, path, baseSha, head, repro);
      if ('rejected' in change) return await give(`the resolution was rejected: ${change.rejected}`);
      const checks = await this.verify(n, path, head, doneWhen, repro);
      const red = checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped');
      if (red.length) return await give(`the resolution doesn't pass the coordinator's own checks: ${red.map((c) => `${c.check} ${c.status}`).join(', ')}`);
      const verdict = await this.evaluate(issue, doneWhen, path, baseSha, head, change.patchHash, checks, repro, change.tampered, change.files.map((f) => f.path), {
        extra: [
          `This head merges ${baseRef} (${baseSha.slice(0, 8)}) into the pull request to resolve a conflict. Judge the change against the new base, and answer both_sides_kept: does the resolution keep what this pull request does AND what ${baseRef} changed?`,
          resolution,
        ],
        schema: conflictVerdictSchema(VERDICT_SCHEMA),
      });
      if (!verdict.patch_correct) return await give(`the evaluator rejected the resolution: ${verdict.advice || 'no reason given'}`);
      const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
      const touched = change.files.filter((f) => files.includes(f.path));
      const lvl = touched.length ? computeLevel({ files: touched, labels: [], moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review) : null;
      const reasons = conflictWaitReasons({ outside, riskCategories: lvl?.level === 'L3' ? lvl.reasons : [], evaluator: { approved: verdict.patch_correct, confidence: verdict.confidence, bothSidesKept: merged.clean ? true : verdict.bothSidesKept } });
      const push = checkedPush({ cwd: path, remote: this.remote, base: baseSha, head, ref: `refs/heads/${pr.head}`, limits: this.d.cfg.guardrails.push, expect: pr.headSha });
      if (!push.ok && 'refused' in push) {
        this.emit('push.refused', { issue: n, head, stage: 'push', reasons: push.refused });
        return await give(pushRefusal(push.refused));
      }
      if (!push.ok) return await give(`the branch moved while the fix ran (someone pushed), so the harness didn't push over it: ${push.error.split('\n').pop()}`);
      finished = { outcome: 'pushed', head, files, waits_owner: reasons.length > 0, reasons, detail: summary.slice(0, 1000) };
      await this.d.backlog.comment(number, `[${BRAND.cli}] Conflicted with ${baseRef} (\`${baseSha.slice(0, 8)}\`)${files.length ? ` in ${files.join(', ')}` : ''}. Conflict fix ${attempt} merged it in and pushed \`${head.slice(0, 8)}\`: ${summary}${reasons.length ? `\n\nThis one waits for a human: ${reasons.join('; ')}.` : ''}`);
    } catch (e) {
      if (!(e instanceof Halted) && !(e instanceof StoppedByOwner)) throw e;
      finished = { outcome: 'no_push', head: null, files, waits_owner: false, reasons: [], detail: e instanceof StoppedByOwner ? e.message : 'stopped by an emergency stop' };
    } finally {
      clearInterval(heartbeat);
      release(n, leaseSha, { repo: this.d.repo, remote: this.remote });
      try {
        removeWorktree(this.wt, name);
      } catch {
        // already gone
      }
      this.emit('conflict_fix.finished', { issue: n, number, base_sha: baseSha, strategy: 'merge', ...finished });
    }
  }

  /** The conflict fix's worker: the issue's brief plus the conflicted hunks and both sides' intent. */
  private async conflictAgent(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, repro: { path: string } | null, pr: PullRequest, brief: string, attempt: number): Promise<{ summary: string } | { ended: string }> {
    const n = issue.number;
    const workers = this.d.cfg.agents.roles.workers!;
    const extra = [
      `Conflict fix ${attempt} for this issue's pull request (${pr.url}, branch ${pr.head}).`,
      brief,
      'The merge is in progress in this worktree. Resolve every conflicted file, `git add` them, and finish the merge with `git commit --no-edit`. Make no other commits, never rebase or reset, and change nothing the merge did not leave conflicted. The coordinator then re-runs the done_when checks, the evaluator judges the resolution, and the coordinator pushes it.',
      ...(repro?.path ? [`Frozen reproduction test (must pass; never edit): ${repro.path}`] : []),
    ];
    const r = await this.d.runner.run({
      env: this.d.cfg.tests.env,
      role: 'worker',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'worker'),
      cwd: path,
      model: workers.model,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      maxTurns: 100,
      maxBudgetUsd: Math.min(workers.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: WORKER_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'conflict-fix', model: workers.model, worktree: path, pid: p, pgid: p, attempt }),
    });
    this.cost(n, 'conflict-fix', r);
    this.emit('run.finished', { issue: n, role: 'conflict-fix', reason: r.reason, detail: r.detail.slice(0, 1000) });
    const s = (r.structured ?? {}) as { summary?: string; blocked?: string; ask?: { question: string } };
    if (r.reason !== 'succeeded') return { ended: `the fix run ended: ${r.reason} (${r.detail.slice(0, 300)})` };
    if (s.blocked) return { ended: `the fix run was blocked: ${s.blocked}` };
    if (s.ask) return { ended: `the fix run has a question for you: ${s.ask.question}` };
    return { summary: s.summary ?? '' };
  }

  /** The readiness of an issue's PR at `head`, against the latest evaluator verdict for the issue. */
  prReadiness(n: number, head: string, checks: CommitCheck[]): Readiness {
    const v = this.events(n).filter((e) => e.type === 'eval.verdict').at(-1)?.payload as EventPayload<'eval.verdict'> | undefined;
    return readiness({ required: this.d.cfg.project.required_checks, checks, head, evaluated: v ? { head: v.head, approved: v.patch_correct } : null });
  }

  private async afterLand(n: number, sha: string, owner: string) {
    const claimed = this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>;
    release(n, claimed.lease, { repo: this.d.repo, remote: this.remote });
    try {
      removeWorktree(this.wt, this.paths(n).name);
    } catch {
      // already gone
    }
    await this.d.backlog.removeLabel(n, 'in-review');
    const staging = this.d.cfg.deploy?.environments.find((e) => !e.production && e.trigger);
    if (!staging) {
      await this.d.backlog.comment(n, `[${BRAND.cli}] Landed \`${sha.slice(0, 8)}\` on ${this.branch}. No deploy target configured, so done means landed.`);
      await this.d.backlog.close(n);
      this.emit('issue.released', { issue: n, instance: this.d.instance, why: 'landed' });
      return;
    }
    const ok = await this.deploy(staging.name, staging.trigger!, staging.verify, sha);
    await this.d.backlog.comment(n, ok ? `[${BRAND.cli}] Landed \`${sha.slice(0, 8)}\` and verified it on ${staging.name}.` : `[${BRAND.cli}] @${owner} landed \`${sha.slice(0, 8)}\` but ${staging.name} is NOT serving it. Not closing.`);
    if (ok) await this.d.backlog.close(n);
    else await this.d.backlog.addLabels(n, ['blocked']);
  }

  /** Trigger a deploy, then confirm the environment serves the exact sha. A skipped deploy is a failure. */
  async deploy(env: string, trigger: string, verify: string, sha: string, polls = 60, pollMs = 15_000): Promise<boolean> {
    this.emit('deploy.requested', { env, sha });
    const t = await sh(trigger, this.d.repo);
    if (t.code !== 0) {
      this.emit('deploy.failed', { env, sha, why: `trigger failed: ${t.tail}` });
      return false;
    }
    for (let i = 0; i < polls; i++) {
      const v = await sh(verify, this.d.repo, 120_000);
      if (v.code === 0 && v.out.includes(sha)) {
        this.emit('deploy.verified', { env, sha });
        return true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    this.emit('deploy.failed', { env, sha, why: `${env} did not report ${sha.slice(0, 8)} after ${(polls * pollMs) / 60_000} min` });
    return false;
  }
}

/** An issue's lane: its lane:<name> label, if any (otherwise the runner's default lane). */
const laneOf = (issue: Issue): { lane?: string } => {
  const l = issue.labels.find((x) => x.startsWith('lane:'));
  return l ? { lane: l.slice(5) } : {};
};

/** An emergency stop interrupted this task. */
/** The owner stopped this run from the console. */
class StoppedByOwner extends Error {
  constructor(readonly by: string) {
    super(`stopped by @${by} from the console`);
  }
}

/** A live run, as the console holds it. */
interface LiveEntry {
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

class Halted extends Error {
  constructor() {
    super('emergency stop');
  }
}

const DEFAULT_REVIEW = {
  version: 1 as const,
  categories: {},
  levels: {
    L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
    L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
    L2_notify: { when: ['app-non-money-large', 'dependency', 'test-machinery'] },
    L3_human: { when: ['money-path', 'migration', 'auth', 'secrets', 'deploy-config', 'release-config', 'harness-config', 'guardrail-config', 'deletes-data'], over_lines: 800 },
  },
  merge: { auto: true, max_lines: 400, max_files: 10, wait_categories: [] as string[] },
};

/** The PR body's lines for instruction evals: base and head scores, the cost, and every case that changed. */
function evalLines(results: EventPayload<'instructions.eval'>[]): string[] {
  if (!results.length) return [];
  const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');
  const total = results.reduce((s, r) => s + r.cost_usd, 0);
  return [
    `**Instruction evals** (base → head; ~$${total.toFixed(2)}, the CLI's cost estimate):`,
    ...results.map((r) => {
      const changed = r.changes.filter((c) => !(c.base === 'pass' && c.head === 'pass')).map((c) => `case ${c.id} ${c.base} → ${c.head}`);
      const what = r.error ? `not evaluated: ${r.error}` : `${score(r.base)} → ${score(r.result)}${r.dropped ? ', **lower**' : ''}${r.incomplete ? ', incomplete (cost cap)' : ''}${changed.length ? `; ${changed.join(', ')}` : ''}`;
      return `- ${r.target}: ${what} (~$${r.cost_usd.toFixed(2)})`;
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
function pushRefusal(reasons: string[]): string {
  return `the push was refused:\n${reasons.map((r) => `- ${r}`).join('\n')}`;
}
