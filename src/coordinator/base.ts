// The coordinator's state and the helpers every part uses: its fields and constructor (the runner wrapper),
// events, git, project commands, paths and task files, the governor, cost, asking, blocking and releasing.
import type { Coordinator } from '../coordinator.js';
import { execFileSync } from '../os/child-process.js';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { BRAND } from '../brand.js';
import type { Config } from '../config/load.js';
import { claim, release } from '../claims.js';
import { settleRecommendation } from '../decision-ask.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { agentReadableDir, cpuCount, diskFree, groupOnlyDir, machineLoad, writeAgentReadable, writeGroupOnly } from '../os/index.js';
import { currentCoreShare, envWithCores, withCores } from '../cores.js';
import { loadMoneyPaths, type ChangeFile } from '../review.js';
import type { ReviewConfig } from '../config/schema.js';
import { changeFiles } from './change-files.js';
import type { DecisionContext } from '../decision-context.js';
import { DEFAULT_COMMIT_IDENTITY, type AgentRunner, type CommitIdentity, type RunRequest, type RunResult } from '../runner.js';
import { writeLive } from '../console.js';
import { allowedOnce } from '../domain-requests.js';
import { type FileIndex } from '../hotspots.js';
import { runIssue } from '../run-record.js';
import { emergencyStop, slotStatus } from '../slots.js';
import { updateDrain } from '../update-drain.js';
import { diskHold, diskRoom, type Hold } from '../governor-holds.js';
import { localDay, nextLocalMidnight } from '../local-day.js';
import type { PushGuard } from '../push-guard.js';
import type { DeployGate } from '../deploy-gate/gate.js';
import type { TestRuns } from './pr-batch.js';
import { removeWorktree, worktreeOptions, type WorktreeOptions } from '../worktrees.js';
import { prepareDepCache } from '../dep-cache.js';
import { seen } from '../intake/store.js';
import { stuckMode } from '../settings.js';
import { stuckOption } from './stuck-guard.js';
import { type CoordinatorDeps, LOCK_WAIT_RECORDED_MS, RETRY_CAP, sh, StoppedByOwner, type LiveEntry, Halted, ShuttingDown, UsagePaused, AuthPaused } from './shared.js';
import { AUTH_CHECK, AUTH_OWNER_RECHECK_MS, AUTH_RECHECK_MS, authHoldsOf, authIncidentKey, authIncidentText, DEFAULT_LOGIN_KEY, type AuthHold } from '../claude-auth-failure.js';
import { takeAuthRecheck } from '../claude-auth-recheck.js';
import { limitHit, pauseOf, resetWords, USAGE_INCIDENT, type LimitHit, type UsagePause } from '../usage-limit.js';
import { cappedModel } from './model-routing.js';
import { resolveProvider } from './providers.js';
import { providerCost, providerOf } from '../providers.js';

export abstract class CoordinatorBase {
  /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
  protected abstract noteRefusedHosts(...args: Parameters<Coordinator['noteRefusedHosts']>): ReturnType<Coordinator['noteRefusedHosts']>;

  protected readonly remote: string;

  /** Where task worktrees go and how they're set up; the project's env is filled in when each one is made. */
  private readonly wtBase: WorktreeOptions;

  protected get wt(): WorktreeOptions {
    const cacheEnv = this.depCacheEnv();
    // The setup steps as the config now says (it follows the default branch); the root is fixed at start.
    return { ...this.wtBase, setup: this.d.cfg.tests.worktree.setup, env: this.projectEnv(), sparseExclude: this.d.cfg.tests.checkout.sparse_exclude, ...(cacheEnv ? { cacheEnv } : {}) };
  }

  protected active = new Map<number, Promise<void>>();

  protected fileIx: { key: string; ix: FileIndex } | null = null;

  /** The default branch's tip as last seen, and when it was last checked. */
  protected defaultTip = '';

  protected tipCheckedAt = 0;

  /** PRs whose combined-state check is running. */
  protected lightRunning = new Set<number>();

  /** When each watched PR was last polled (ms). */
  protected prPolled = new Map<number, number>();

  /** Live runs, for the console. */
  protected live = new Map<string, LiveEntry>();

  /** Chat turns, one at a time. */
  protected chatQueue: Promise<void> = Promise.resolve();

  /** Intake passes, one at a time. */
  protected intakeQueue: Promise<void> = Promise.resolve();

  protected intakeRunning = false;

  protected intakePulledAt = -Infinity;

  /** The repo's own config, as the default branch has it (src/config/live.ts): the defaults the instance's settings apply over. */
  protected repoCfg: Config;

  protected settingsKey = '';

  /** When each auto-merge's commit on the default branch was last polled (ms). */
  protected mainPolled = new Map<string, number>();

  protected landing = false;

  protected stopped = false;

  /** Aborted by an emergency stop, and by a shutdown: every agent run gets this signal. */
  protected halt = new AbortController();

  /** Aborted once, by a shutdown (stop()): project commands get this signal, and the emergency check never lifts it. */
  protected shutdown = new AbortController();

  /** The tick step running now (stop() names it when the shutdown runs out of time). */
  protected inStep: string | null = null;

  /** Why a run stops now: the shutdown, or an emergency stop. */
  protected haltError(): Halted {
    return this.stopped ? new ShuttingDown() : new Halted();
  }

  /**
   * INVARIANT: while the test sandbox's check is failing (PrTestRuns.ready, src/testrun/sandbox-watch.ts), the test-run
   * service and the deploy gate are as absent as they were when a failed check meant none was set up: batches wait, a
   * red main is not re-run through it, the deploy branch doesn't move. Only the PRs' own runs go to the service then,
   * to be refused with a check that says test runs are off. Read at each use: they go on when the check passes.
   */
  protected get liveTestRuns(): TestRuns | null {
    return this.d.prTestRuns?.ready() === false ? null : (this.d.testRuns ?? null);
  }

  protected get liveDeployGate(): DeployGate | undefined {
    return this.d.prTestRuns?.ready() === false ? undefined : this.d.deployGate;
  }

  /** Open-model providers that hit their usage or rate limit, by label: skipped (their runs fall back) until then (ms). */
  protected providerLimited = new Map<string, number>();

  /** The runner under the wrapper below: only the held-login check calls it directly (it must run while the login is held). */
  private claudeRunner: AgentRunner;

  constructor(protected d: CoordinatorDeps) {
    // Every agent run carries the halt signal; a run after a halt never starts.
    const runner = d.runner;
    this.claudeRunner = runner;
    this.d = {
      ...d,
      runner: {
        run: async (asked): Promise<RunResult> => {
          if (this.halt.signal.aborted) throw this.haltError();
          // A model that names an open-model provider goes to it, or to its fallback (recorded); then the instance's
          // model cap holds for every run on an Anthropic model, whatever chose it.
          const settings = this.d.settings?.().settings ?? {};
          const limited = (label: string) => {
            const until = this.providerLimited.get(label);
            return until !== undefined && until > this.nowMs() ? new Date(until).toISOString() : null;
          };
          const routed = await resolveProvider(asked, { cfg: this.d.cfg, settings, stateDir: this.d.stateDir, limited, ...(this.d.providerKeys ? { providerKeys: this.d.providerKeys } : {}) });
          // A run that must be on its provider or not at all (the cross-family evaluator): not run, saying why.
          if (routed.fellBack && asked.route?.noFallback) return { reason: 'failed', detail: `not run: ${routed.fellBack.reason}`, costUsd: 0, turns: 0, model: asked.model };
          if (routed.fellBack) this.emit('provider.fallback', { issue: asked.issue ?? runIssue(asked.cwd, asked.taskFile), role: asked.role, provider: routed.fellBack.provider, reason: routed.fellBack.reason.slice(0, 500), model: routed.req.model });
          const req = routed.req.provider ? routed.req : { ...routed.req, model: cappedModel(routed.req.model, settings) };
          // Paused on the Claude usage limit: no run on Anthropic starts until its reset (src/usage-limit.ts).
          const pause = req.provider ? null : this.usagePause();
          if (pause) throw new UsagePaused(pause.resetAt);
          // A Claude login the API refused: no run on it starts until a call on it succeeds (src/claude-auth-failure.ts).
          const loginKey = req.provider ? null : this.loginKeyOf(req);
          const held = loginKey === null ? null : this.authHold(loginKey);
          if (held) throw new AuthPaused(held.login, held.detail);
          const startedMs = this.nowMs();
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
              // The stuck-run guard on the worker and evaluators, in the instance's mode (dry-run unless the owner turned it on).
              ...stuckOption(req, stuckMode(this.d.settings?.().settings ?? {}), who, () => live.run, (p) => this.emit('run.stuck', p)),
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
          if (this.halt.signal.aborted) throw this.haltError();
          if (r.reason === 'rate_limited') {
            const hit = r.limit ?? limitHit({ text: r.detail, now: this.nowMs() });
            this.emit('usage.limit_hit', { ...who, provider: req.provider?.name ?? null, reset_at: hit.resetAt, source: hit.source, kind: hit.kind, detail: r.detail.slice(0, 500) });
            // An open-model provider's limit is its own: it is skipped until its reset, and this run is redone at
            // once on its fallback (the role's normal model). Never a pause, and never retried on the provider.
            if (req.provider) {
              this.providerLimited.set(req.provider.name, Date.parse(hit.resetAt));
              if (asked.route?.noFallback) return { ...r, reason: 'failed', detail: `not run: ${req.provider.name} hit its usage or rate limit; skipped until ${hit.resetAt}` };
              const fallback = asked.route?.fallback ?? 'sonnet';
              this.emit('provider.fallback', { issue: who.issue, role: req.role, provider: req.provider.name, reason: `${req.provider.name} hit its usage or rate limit; skipped until ${hit.resetAt}`, model: fallback });
              return this.d.runner.run({ ...asked, model: fallback });
            }
            // The Claude login's limit: the instance pauses until it resets, and the caller requeues its task.
            this.pauseOnLimit(hit, who, r.detail);
            throw new UsagePaused(hit.resetAt);
          }
          if (loginKey !== null && r.reason === 'auth_failed') {
            const h = this.holdLogin(loginKey, req, who, r);
            throw new AuthPaused(h.login, h.detail);
          }
          if (loginKey !== null && r.reason === 'succeeded') this.loginWorks(loginKey, 'run', req.role, startedMs);
          return r;
        },
      },
    };
    this.repoCfg = d.cfg;
    this.remote = d.remote ?? 'origin';
    // The worktree root resolved to its real path once, here, from the start config (#890 round 19): a root that is a
    // link works as on main, and a link that appears on the way later refuses an add (WorktreeOptions.rootResolved).
    // The task directory is one of the paths a worktree place must never hide (keptPaths).
    this.wtBase = worktreeOptions({ repo: d.repo, root: d.cfg.tests.worktree.root, taskDir: d.agentTasks?.dir ?? join(d.stateDir, 'tasks'), stateDir: d.stateDir, setup: d.cfg.tests.worktree.setup, env: d.cfg.tests.env, ...(d.commandsAs ? { runAs: d.commandsAs } : {}) });
  }

  /** This task's share of the machine's cores right now: the cores over the agents running (cores.ts). */
  private coreShare(): number {
    return currentCoreShare(this.d.cfg.tests.cores, this.d.slotsDir);
  }

  /** The project's env (tests.yaml env) as a command or session starting now gets it: `{cores}` filled in. */
  protected projectEnv(): Record<string, string> {
    return envWithCores(this.d.cfg.tests.env, this.coreShare());
  }

  /**
   * A project command (check, gate, pre-land step, deploy trigger and verify): it runs code an agent or an approved PR
   * wrote, so it runs as the agent user, in its sandbox. `o.timeoutMs`: shorter than the command timeout, never longer.
   * `o.env`: the harness's own variables for this one command (the vacuity gate's NODE_V8_COVERAGE), over tests.yaml
   * env. `o.unset`: variables taken out of its environment, the engine's own included (the vacuity gate: NODE_OPTIONS).
   */
  protected project(command: string, cwd: string, o: { timeoutMs?: number; env?: Record<string, string>; unset?: readonly string[] } = {}) {
    const share = this.coreShare();
    return sh(withCores(command, share), cwd, Math.min(o.timeoutMs ?? this.commandTimeoutMs, this.commandTimeoutMs), this.d.commandsAs, { ...envWithCores(this.d.cfg.tests.env, share), ...o.env }, this.shutdown.signal, o.unset);
  }

  /** How long a project command or an agent run may take (tests.yaml command_timeout_s). */
  protected get commandTimeoutMs(): number {
    return this.d.cfg.tests.command_timeout_s * 1000;
  }

  protected get branch() {
    return this.d.cfg.project.project.default_branch;
  }

  /**
   * The money paths as the default branch says them now: the list read at <remote>/<branch> (refreshed by every
   * fetch), never from this checkout's working tree, which is as old as the clone (#715). The one way the coordinator
   * reads them. `at`: one commit of the default branch to read them at instead (a merge decision's tip, taken at its
   * start, which its weakening check reads too: #1005).
   */
  protected moneyPaths(src: ReviewConfig['money_path_source'] = this.d.cfg.review?.money_path_source, at: string = `refs/remotes/${this.remote}/${this.branch}`): RegExp[] {
    return loadMoneyPaths(this.d.repo, src, at);
  }

  /**
   * Who may approve a high-risk merge, for the one rule (dashboard-auth.ts mayAnswerKind): review.yaml's `approvals`
   * from the default branch (the live config), writers only while the instance's policy.yaml lets them, read now (#715).
   */
  protected approvals(): ReviewConfig['approvals'] {
    const a = this.d.cfg.review?.approvals;
    if (a?.land !== 'writers') return a;
    try {
      return this.d.writersApproveLand?.() === true ? a : undefined;
    } catch {
      return undefined;
    }
  }

  /** What every push checks: the default branch is never pushed (only the direct land passes `directLand`); a refusal is recorded. */
  protected pushGuard(directLand = false): PushGuard {
    return { defaultBranch: this.branch, directLand, blocked: (ref, head) => this.emit('push.blocked', { ref, head, via: 'coordinator' }) };
  }

  protected git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  protected emit<T extends Parameters<EventLog['append']>[0]>(type: T, payload: EventPayload<T>) {
    return this.d.log.append(type, payload, this.d.instance);
  }

  protected events(issue?: number): StoredEvent[] {
    const all = this.d.log.read();
    return issue === undefined ? all : all.filter((e) => (e.payload as { issue?: number }).issue === issue);
  }

  protected lastSeen(issue: number): unknown {
    return this.d.log
      .read(0, ['issue.seen'])
      .filter((e) => (e.payload as { issue: number }).issue === issue)
      .at(-1)?.payload;
  }

  /** USD spent today (this machine's local day, as the dashboard shows it: src/local-day.ts) by all runs, from the log. */
  spentToday(): number {
    const day = localDay();
    return this.d.log.read(0, ['run.cost']).filter((e) => localDay(e.ts) === day).reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
  }

  /** An emergency stop is in force (read now, not only at the last check): nothing lands and nothing merges. */
  protected emergencyInForce(): boolean {
    return this.halt.signal.aborted || emergencyStop(this.d.slotsDir) !== null;
  }

  private lastHold: string | null = null;

  /** Why no new agent may start right now, or null. Load and disk are machine-wide. Each hold carries its numbers (src/governor-holds.ts). */
  governorHold(): Hold | null {
    const m = this.d.machine ?? { load: machineLoad, disk: diskFree };
    const load = m.load();
    const disk = m.disk(this.d.repo);
    const est = this.d.cfg.tests.worktree.est_size_gb;
    const maxLoad = this.d.cfg.project.governor.max_load ?? cpuCount() * 2;
    const budget = this.d.cfg.agents.daily_budget_usd;
    const spent = this.spentToday();
    if (spent >= budget) return { kind: 'budget', reason: `daily budget $${budget} reached`, load, freeDiskPct: disk.freePct, facts: { spent_usd: spent, budget_usd: budget, until: nextLocalMidnight().toISOString() } }; // spentToday's day: local, by the wall clock
    if (load !== null && load > maxLoad) return { kind: 'load', reason: `machine load ${load.toFixed(0)} > ${maxLoad}`, load, freeDiskPct: disk.freePct, facts: { load, max_load: maxLoad } };
    // WHY: the floor is the larger of an absolute GB and a share of the disk (#470), not a flat share.
    const room = diskRoom({ freeGb: disk.freeGb ?? (disk.freePct / 100) * disk.totalGb, totalGb: disk.totalGb }, this.d.cfg.project.governor, est);
    return diskHold(room, this.d.cfg.project.governor, load);
  }

  /** The hold when no agent slot is free: the updater's drain, or the machine-wide cap with its numbers. */
  protected slotHold(): Hold {
    if (updateDrain(this.d.slotsDir)) return { kind: 'update_drain', reason: 'draining for an engine update: no new agent starts until it is installed', load: null, freeDiskPct: null };
    const s = slotStatus(this.d.slotsDir);
    return { kind: 'slots', reason: 'machine-wide agent cap reached (all harnesses)', load: null, freeDiskPct: null, facts: { cap: s.cap, running: s.agents.length } };
  }

  /** The coordinator's clock, in ms (tests set `now`). */
  protected nowMs(): number {
    return (this.d.now?.() ?? new Date()).getTime();
  }

  /**
   * Why no new work may start now: the disk is full (the event log's writes wait in memory) or below its floor
   * (src/disk-guard.ts). Every place that holds on the usage pause holds on this too; runs in flight go on.
   */
  protected diskHeld(): string | null {
    return this.d.disk?.held() ?? null;
  }

  /** The usage-limit pause in force (src/usage-limit.ts), from the log, or null. */
  protected usagePause(): UsagePause | null {
    return pauseOf(this.d.log.read(0, ['usage.paused', 'usage.resumed']));
  }

  /** The Claude login a run would use: the runner's own answer (its config dir), else the one login there is. */
  protected loginKeyOf(req: Pick<RunRequest, 'lane' | 'provider'>): string {
    return this.claudeRunner.loginOf?.(req) ?? DEFAULT_LOGIN_KEY;
  }

  /** Every Claude login held now (src/claude-auth-failure.ts), from the log. */
  protected authHolds(): AuthHold[] {
    return authHoldsOf(this.d.log.read(0, ['claude_auth.failed', 'claude_auth.checked', 'claude_auth.recovered']));
  }

  protected authHold(key: string): AuthHold | null {
    return this.authHolds().find((h) => h.key === key) ?? null;
  }

  /**
   * A held login, if any: nothing new is dispatched while one is (a task's runs span the instance's logins, its
   * worker's and its evaluator's), and nothing that runs on its own (research, fix runs, evals) starts.
   */
  protected authHeld(): AuthHold | null {
    return this.authHolds()[0] ?? null;
  }

  /** A run's login was refused: it is held (once; a second refusal while held keeps the hold), and the red incident raised. */
  private holdLogin(key: string, req: RunRequest, who: { issue: number | null; role: string }, r: RunResult): AuthHold {
    const was = this.authHold(key);
    const login = r.login?.account ?? was?.login ?? (key === DEFAULT_LOGIN_KEY ? "this instance's Claude login" : `the Claude login in ${key}`);
    this.emit('claude_auth.failed', { key, login, lane: req.lane ?? 'default', issue: who.issue, role: who.role, detail: r.detail.slice(0, 1000) });
    const h = this.authHold(key)!;
    if (!was) {
      const t = authIncidentText(this.authHolds());
      this.d.incidents?.raiseIncident('claude_auth', authIncidentKey(this.d.instance), t.detail, t.fix);
    }
    return h;
  }

  /** A call on a held login succeeded (a run that started after the hold began, or the check): the hold ends. */
  private loginWorks(key: string, via: 'run' | 'check', role: string, startedMs: number): void {
    const h = this.authHold(key);
    if (!h || Date.parse(h.since) > startedMs) return;
    this.emit('claude_auth.recovered', { key, login: h.login, via, role, held_ms: Math.max(0, Math.round(this.nowMs() - Date.parse(h.since))), hold_id: h.id });
    if (!this.authHolds().length) this.d.incidents?.resolveIncident('claude_auth', authIncidentKey(this.d.instance));
  }

  /** When the owner's last re-check was taken (ms): one a minute at most. */
  private ownerRecheckAt = -Infinity;

  /**
   * The way out of a held login (no run may start on it, so no run can succeed to end the hold): one tiny real call
   * on it, as its own user, at most every AUTH_RECHECK_MS; at once after an account switch, and on the owner's
   * re-check from the dashboard (one a minute at most). A refused call costs nothing; one that is answered ends the hold.
   */
  protected async checkHeldLogins(): Promise<number> {
    const asked = takeAuthRecheck(this.d.stateDir);
    if (this.stopped || this.halt.signal.aborted) return 0;
    const holds = this.authHolds();
    if (!holds.length) return 0;
    const now = this.nowMs();
    const owner = asked !== null && now - this.ownerRecheckAt >= AUTH_OWNER_RECHECK_MS;
    if (owner) this.ownerRecheckAt = now;
    const switched = this.d.accountSwitched?.() ?? null;
    let checked = 0;
    for (const h of holds) {
      const last = h.lastCheck ? Date.parse(h.lastCheck.at) : Date.parse(h.since);
      const by = owner ? 'owner' : switched !== null && Date.parse(switched) > last ? 'account_switch' : now - last >= AUTH_RECHECK_MS ? 'timer' : null;
      if (!by) continue;
      await this.checkLogin(h, by);
      checked++;
    }
    return checked;
  }

  private async checkLogin(h: AuthHold, by: 'timer' | 'owner' | 'account_switch'): Promise<void> {
    const startedMs = this.nowMs();
    const r = await this.claudeRunner.run({
      role: 'login-check',
      prompt: AUTH_CHECK.prompt,
      model: AUTH_CHECK.model,
      cwd: this.d.repo,
      allowedTools: [],
      maxTurns: AUTH_CHECK.maxTurns,
      maxBudgetUsd: AUTH_CHECK.maxBudgetUsd,
      stallMs: AUTH_CHECK.stallMs,
      timeoutMs: AUTH_CHECK.timeoutMs,
      // Not an agent's run: it never waits behind one on the login's run lock, and it is the same user and login.
      interactive: true,
      ...(h.lane !== 'default' ? { lane: h.lane } : {}),
      signal: this.halt.signal,
    });
    this.cost(null, 'login-check', r);
    // Answered at all (a reply, the budget cap, a usage limit): the API took the login.
    const ok = r.reason === 'succeeded' || r.reason === 'budget_exhausted' || r.reason === 'rate_limited';
    this.emit('claude_auth.checked', { key: h.key, login: h.login, ok, by, detail: (ok ? 'Claude answered a minimal call on this login' : r.detail).slice(0, 1000), cost_usd: Math.max(0, r.costUsd) });
    if (ok) this.loginWorks(h.key, 'check', 'login-check', startedMs);
  }

  /** Pause on a usage-limit hit: once (a hit while paused changes nothing), with the incident raised when there's a watchdog. */
  private pauseOnLimit(hit: LimitHit, who: { issue: number | null; role: string }, detail: string) {
    if (this.usagePause()) return;
    this.emit('usage.paused', { reset_at: hit.resetAt, source: hit.source, kind: hit.kind, issue: who.issue, role: who.role, detail: detail.slice(0, 500) });
    const when = resetWords(hit.resetAt, this.nowMs());
    this.d.incidents?.raiseIncident(USAGE_INCIDENT, this.d.instance, `Claude usage limit reached; no new runs until ${when}${hit.source === 'default' ? " (claude gave no reset time: the default wait)" : ''}`, 'Nothing to do: it resumes on its own at the reset. To resume sooner, switch the Claude account.');
  }

  /**
   * The pause ends, and the next dispatch starts runs again: at its reset time, or once a Claude account switch put
   * this instance on a new login after it began (the old account's limit no longer applies).
   */
  protected resumeIfDue(): boolean {
    const p = this.usagePause();
    if (!p) return false;
    const switched = this.d.accountSwitched?.() ?? null;
    const reason = Date.parse(p.resetAt) <= this.nowMs() ? 'reset' : switched !== null && Date.parse(switched) >= Date.parse(p.since) ? 'account switched' : null;
    if (!reason) return false;
    this.emit('usage.resumed', { reset_at: p.resetAt, paused_ms: Math.max(0, Math.round(this.nowMs() - Date.parse(p.since))), reason });
    this.d.incidents?.resolveIncident(USAGE_INCIDENT, this.d.instance);
    return true;
  }

  protected noteHold(h: Hold | null) {
    const key = h?.reason.replace(/[\d.]+/g, '#') ?? null; // record changes of reason, not every reading
    if (key === this.lastHold) return;
    this.lastHold = key;
    if (h) this.emit('governor.hold', { reason: h.reason, load: h.load, free_disk_pct: h.freeDiskPct, kind: h.kind, ...(h.facts ? { facts: h.facts } : {}) });
    else this.emit('governor.release', { load: (this.d.machine?.load ?? machineLoad)(), free_disk_pct: null });
  }

  /**
   * The instance's settings (policy.yaml), re-read every tick: when they change, the repo's config with
   * them applied becomes the config in effect, without a restart. Refused settings: the repo's values.
   */
  /** The live runs list the dashboard reads (only runs whose session is up: they have an id). */
  protected writeLive() {
    writeLive(
      this.d.stateDir,
      [...this.live.values()].filter((l) => l.run).map((l) => ({ run: l.run!, issue: l.issue, role: l.role, model: l.model, startedAt: l.startedAt, pending: l.pending })),
    );
  }

  // ---------------------------------------------------------------- task pipeline

  protected paths(issue: number) {
    return { name: this.pooledName(issue) ?? `issue-${issue}`, branch: `${BRAND.cli}/issue-${issue}`, taskFile: join(this.d.agentTasks?.dir ?? join(this.d.stateDir, 'tasks'), `issue-${issue}.json`) };
  }

  /** The pooled worktree this claim of the issue runs in, if it took one (recorded, so a restart still finds it). */
  private pooledName(issue: number): string | null {
    const ev = this.events(issue);
    const claim = ev.map((e) => e.type).lastIndexOf('issue.claimed');
    const p = ev.slice(claim + 1).filter((e) => e.type === 'worktree.pooled').at(-1);
    return p ? String((p.payload as { name: string }).name) : null;
  }

  /**
   * The instance's dependency cache (pip, uv, npm, pnpm, yarn) for worktree setup: only for an instance whose
   * agents run as their own user (the cache lives beside its checkout), and when the project keeps it on.
   * Not for agent sessions: their sandbox writes only inside the worktree, so a cache outside it fails there.
   */
  private depCacheEnv(): Record<string, string> | undefined {
    const root = this.d.depCacheRoot;
    if (!root || !this.d.cfg.tests.worktree.dep_cache) return undefined;
    if (this.cacheEnv === undefined) {
      try {
        this.cacheEnv = prepareDepCache(root.dir, root.gid).env;
      } catch (e) {
        this.emit('coordinator.error', { instance: this.d.instance, where: 'dep-cache', kind: 'error', message: (e as Error).message.slice(0, 500) });
        this.cacheEnv = null;
      }
    }
    return this.cacheEnv ?? undefined;
  }

  private cacheEnv: Record<string, string> | null | undefined;

  protected get identity(): CommitIdentity {
    return this.d.commitIdentity ?? DEFAULT_COMMIT_IDENTITY;
  }

  /** The latest eval of each instruction target for an issue. */
  protected instructionResults(n: number): EventPayload<'instructions.eval'>[] {
    const latest = new Map<string, EventPayload<'instructions.eval'>>();
    for (const e of this.events(n)) if (e.type === 'instructions.eval') latest.set((e.payload as { target: string }).target, e.payload as EventPayload<'instructions.eval'>);
    return [...latest.values()];
  }

  /**
   * Each file the change base..head touches, with its line counts and added and removed lines (for content checks).
   * A rename is its old path and its new path (./change-files.ts), so a lock on either one holds.
   */
  protected changeFiles(cwd: string, base: string, head: string): ChangeFile[] {
    return changeFiles(cwd, base, head);
  }

  /**
   * The task file the agent's hook reads (its frozen paths): readable by the agent user, never writable by it,
   * so an agent can neither lose its guard nor rewrite it. The hook refuses every tool call if it can't read it.
   */
  protected writeTask(file: string, task: object) {
    const at = this.d.agentTasks;
    if (at) {
      agentReadableDir(at.dir, at.gid);
      writeAgentReadable(file, JSON.stringify(task), at.gid);
    } else {
      groupOnlyDir(dirname(file));
      writeGroupOnly(file, JSON.stringify(task));
    }
  }

  protected cost(issue: number | null, role: string, r: RunResult) {
    this.emit('run.cost', { issue, role, ...this.usage(r) });
  }

  /**
   * A run's usage for run.cost: its model, turns, tokens and seconds, and its estimated cost. On an open-model
   * provider that is the provider's price (src/providers.ts): local runs cost nothing, a hosted one without prices
   * configured counts as 0 and says which provider it was.
   */
  protected usage(r: RunResult): { model: string; usd: number; turns: number; provider?: string; tokens_in?: number; tokens_out?: number; secs?: number } {
    const named = r.provider ? providerOf(r.provider) : null;
    const p = named ? (named.kind === 'local' ? this.d.cfg.agents.providers?.local : named.kind === 'cli' ? (this.d.cfg.agents.providers?.cli as Record<string, { usd_per_mtok_in: number; usd_per_mtok_out: number }> | undefined)?.[named.name] : this.d.cfg.agents.providers?.hosted?.[named.name]) : undefined;
    const usd = named ? (providerCost(named.kind, p ?? {}, r.tokens ?? { in: 0, out: 0 }) ?? 0) : r.costUsd;
    return {
      model: r.model,
      usd,
      turns: r.turns,
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.tokens ? { tokens_in: r.tokens.in, tokens_out: r.tokens.out } : {}),
      ...(r.durationMs !== undefined ? { secs: Math.round(r.durationMs / 100) / 10 } : {}),
    };
  }

  protected ownerOf(issue: number): string {
    const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
    return (c?.payload as { owner?: string } | undefined)?.owner ?? this.d.cfg.project.owners.default;
  }

  protected async ask(kind: 'land' | 'question' | 'domain' | 'plan' | 'intake' | 'delegation' | 'automation', issue: number | null, owner: string, question: string, options: string[], recommended: string, detail: string[], context?: DecisionContext): Promise<string> {
    const id = `d-${issue ?? kind}-${randomBytes(3).toString('hex')}`;
    // The recommendation is one of the options or nothing: prose (an agent's reasoning) moves into the detail.
    const { recommendation, receipts } = settleRecommendation(options, recommended, detail);
    // What it rests on (src/decision-context.ts), for the dashboard's detail view: never a viewer's (src/viewer-events.ts).
    this.emit('decision.asked', { id, kind, issue, owner, question, options, recommendation, receipts, ...(context ? { context } : {}) });
    if (issue === null) return id; // not tied to an issue: answered from the dashboard or CLI
    await this.d.backlog.addLabels(issue, ['needs:decision']);
    await this.d.backlog.comment(
      issue,
      `[${BRAND.cli}] @${owner} decision needed: **${question}**\n\nOptions: ${options.join(' / ')}.${recommendation ? ` Recommendation: **${recommendation}**.` : ''}\n\n${receipts.map((r) => `- ${r}`).join('\n')}\n\nReply \`/${BRAND.cli} ${options.join('` or `/' + BRAND.cli + ' ')}\` (owner or a writer), or run \`${BRAND.cli} decide ${id} <option>\`.`,
    );
    return id;
  }

  /** `retry`: a rate-limit or budget block that retries on its own after `after` (up to RETRY_CAP times). */
  protected async block(issue: number, owner: string, why: string, release_ = true, retry?: { kind: 'rate_limit' | 'budget'; after: Date }) {
    this.emit('issue.blocked', { issue, owner, why: why.slice(0, 1000), ...(retry ? { retry_after: retry.after.toISOString(), retry_kind: retry.kind } : {}) });
    await this.d.backlog.addLabels(issue, ['blocked']);
    await this.d.backlog.removeLabel(issue, 'agent:working');
    const when = retry ? ` It retries on its own after ${retry.after.toISOString()} (at most ${RETRY_CAP} times), or label it \`ready\` again sooner.` : '';
    await this.d.backlog.comment(issue, `[${BRAND.cli}] @${owner} blocked: ${why}${when}`);
    if (release_) this.releaseClaim(issue, why);
  }

  protected releaseClaim(issue: number, why: string) {
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
}
