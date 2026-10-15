// The coordinator: deterministic code (no LLM) that claims, schedules,
// verifies, levels, lands and deploys. Every step is an event; the next
// step is decided from events plus GitHub, so a restart picks up where the
// log says it was. Agents only ever propose: they commit on their own
// branch in their own worktree; everything outward-facing happens here.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from './brand.js';
import { RECOMMENDATION_PREFIX } from './decision-ask.js';
import { CANARY_LABEL, canaryTask, machineCanaryInstance } from './canary.js';
import { actionable, contractKey, ownerFor, parseContract, type DoneWhenList, type Issue, type PullRequest } from './backlog/types.js';
import { claim, release, renew, type Lease } from './claims.js';
import type { EventPayload, EventType } from './events/types.js';
import { globToRegExp } from './guardrails/glob.js';
import { isProtectedPath } from './guardrails/engine.js';
import { computeLevel, loadMoneyPaths, type ChangeFile, type Level } from './review.js';
import { changeContext, investigationContext, summaryContext } from './decision-context.js';
import { oneParagraph, RISK_CLASSES, sizeFiles, sizeVerdict, type RiskClass } from './pr-rules.js';
import { evalLevel, judge } from './coordinator/eval-routing.js';
import { evalRouting } from './eval-routing.js';
import { MAX_REQUESTS_PER_TASK } from './research-request.js';
import { defaultRolePrompt, INVESTIGATION_OPTIONS, INVESTIGATION_SCHEMA, issueBrief, REFLECTION_SCHEMA, REPRO_SCHEMA, rolePrompt, VERDICT_SCHEMA, WORKER_SCHEMA } from './roles.js';
import { compareInstructions, engineRoleCases, instructionTargets, parseCases, runnerAsk } from './skilleval.js';
import { SESSION_ID, type RunResult } from './runner.js';
import { MAX_MESSAGE, mayRequest, takeRequests } from './console.js';
import { runMachineRequests } from './coordinator/machine-requests.js';
import { recordProfileSwitches } from './claude-profiles.js';
import { failoverStep } from './claude-failover.js';
import { chatTurn, contextFromEvents, recentRuns, takeChatRequests, writeChatAnswer, type ChatRequest } from './chat.js';
import { machineStats } from './os/stats.js';
import { pushProblems } from './push-check.js';
import { needsPlan, PLAN_DISALLOWED, PLAN_TOOLS, planBrief, type Plan } from './plan-mode.js';
import { DEFAULT_HOTSPOTS, estimateFiles, fileIndex, holdReason, hotspotsIn, pickDispatch, type FileIndex, type Hold } from './hotspots.js';
import { TaskGraph } from './coordinator/task-graph.js';
import { bodyHash, childBody, GOAL_LABEL, GOAL_SPLIT_LABEL, GOAL_SPLIT_SCHEMA, readGoalSplit, splitComment } from './goal-split.js';
import { changedFiles } from './merge-base.js';
import { importsOf, lightCheckPlan, lightCheckWait } from './light-check.js';
import { readRun, runsForIssue } from './run-record.js';
import { claimsOf, lowerConfidence, unbackedClaims, type CheckRecord } from './receipts.js';
import { applySettings, inRunWindow } from './settings.js';
import { CONFIG_INCIDENT, LiveConfig } from './config/live.js';
import { CI_CHOICE_FIX, ciChoiceProblem } from './ci-choice.js';
import { researchTrigger } from './research.js';
import { scanRange } from './scan/secrets.js';
import { emergencyStop, tryAgentSlot } from './slots.js';
import { nextRunWindowStart } from './governor-holds.js';
import { nightlyDue, queueNightly } from './nightly.js';
import { buildReport, dueSlot, recentRunRecords, weeklyDue } from './reports.js';
import { readTuneProfile, tuningInput, tuningProposals } from './tuning.js';
import { baselineGate, latestBaseline } from './baseline.js';
import { countAssertions } from './vacuity.js';
import { createWorktree, removeSandboxPlaceholders, removeWorktree } from './worktrees.js';
import { refillPool, setupKey, takeFromPool } from './worktree-pool.js';
import { seen } from './intake/store.js';
import { browserChecks, changeAt, worktreeBaseline, type BaselineRun } from './coordinator/browser.js';
import { buildRoute, routeRun, runRoute } from './coordinator/model-routing.js';
import { builtChangeRefusal } from './coordinator/providers.js';
import { maybePostDigest } from './coordinator/digest.js';
import { HarnessEvals } from './coordinator/harness-evals.js';
import { CASE_WRITER_COST_ROLE, heldOutFor } from './coordinator/held-out.js';
import { POOL_CHECK_MS, retryAfter, laneOf, StoppedByOwner, Halted, ShuttingDown, UsagePaused, AuthPaused, DEFAULT_REVIEW, pushRefusal } from './coordinator/shared.js';
import { AUTH_FAILED_CHAT_TEXT } from './claude-auth-failure.js';
import { resetWords } from './usage-limit.js';
import { stuckFeedback } from './coordinator/stuck-guard.js';
import { budgetState, checksFingerprint, DEFAULT_MAX_ATTEMPTS, failureFingerprint, identicalStreak, IDENTICAL_FAILURES, reassigned, reflectionBrief, reflectionFeedback, sinceReset, TASK_BUDGET_INCIDENT, taskUsage, timeLeftMs, type FailureKind } from './coordinator/loop-control.js';
import { modelRouting } from './model-routing.js';
import { labelWeek } from './coordinator/stage-labels.js';
import { doneWhenCommands } from './stage-label.js';
import { localDoneWhen } from './testrun/local.js';
import { repoGit } from './main-watch.js';
import { MergePosts } from './merge-posts.js';
import { CiMetrics } from './ci-metrics.js';
import { redactPii } from './intake/redact.js';
import { scrub, takeOpsPost } from './watchdog/post.js';
import { storageFailure } from './events/log.js';

export type { CoordinatorDeps } from './coordinator/shared.js';
export { logTail } from './coordinator/shared.js';

/** What one worker build ends in: stop the task, or go on to inspect its change. */
type BuildOut = { stop: true } | { stop: false; stuck?: string; raise?: Level; noChange?: string; provider?: string };

/** A failed worker run shorter than this that committed nothing never got to work. */
export const STARTUP_FAILURE_SECS = 90;

export class Coordinator extends HarnessEvals {
  // ---------------------------------------------------------------- tick

  /** One deterministic pass: reconcile, handle approvals, land, dispatch. */
  async tick(): Promise<void> {
    // Each step is guarded on its own: a GitHub hiccup in reconcile must not stop landing or dispatch.
    // Once stopping (stop()), no further step starts: the one running finishes or is aborted, and the tick ends.
    const step = async <T>(where: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
      if (this.stopped) return fallback;
      this.inStep = where;
      try {
        return await fn();
      } catch (e) {
        this.emit('coordinator.error', { instance: this.d.instance, where, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
        return fallback;
      } finally {
        this.inStep = null;
      }
    };
    this.checkEmergency();
    this.checkConsole();
    void this.checkChat();
    // The config as the default branch has it now, before anything below reads it (src/config/live.ts).
    await step('config', () => this.refreshConfig(), undefined);
    await step('settings', () => this.refreshSettings(), undefined);
    // A usage-limit pause whose reset has passed ends here, before anything below would start a run.
    await step('usage', () => this.resumeIfDue(), false);
    // A Claude login the API refused is checked with one tiny real call (every 10 min at most, at once on the owner's
    // re-check or after an account switch): the only way its hold can end while no run may start on it.
    await step('claude sign-in', () => this.checkHeldLogins(), 0);
    // Machine changes the dashboard recorded (it can't sudo; this unit can): src/coordinator/machine-requests.ts.
    await step('machine', () => runMachineRequests({ log: this.d.log, instance: this.d.instance, ...(this.d.machineExec ? { exec: this.d.machineExec } : {}) }), 0);
    // A Claude account profile switch this dashboard asked for, once the root script has finished it: account.switched.
    await step('account profiles', () => recordProfileSwitches(this.d.log, this.d.instance), 0);
    // Auto-failover between account profiles on a usage limit, when it is on (src/claude-failover.ts). Never on an auth failure.
    await step('account failover', () => failoverStep({ log: this.d.log, instance: this.d.instance, ...(this.d.machineExec ? { exec: this.d.machineExec } : {}), ...(this.d.incidents ? { incidents: this.d.incidents } : {}) }), null);
    const reconciled = await step('reconcile', () => this.reconcile(), 0);
    await step('nightly', () => this.maybeNightly(), undefined);
    await step('report', () => this.maybeReport(), undefined);
    await step('digest', () => maybePostDigest({ log: this.d.log, backlog: this.d.backlog, project: this.d.cfg.project, emit: (p) => this.emit('digest.posted', p) }), null);
    await step('decisions', () => this.handleDecisions(), undefined);
    await step('land', () => this.landNext(), undefined);
    await step('prs', () => this.watchPrs(), undefined);
    await step('review fixes', () => this.watchReviewFixes(), undefined);
    await step('pr hygiene', () => this.checkPrHygiene(), null);
    await step('test runs', () => this.d.prTestRuns?.tick(), undefined);
    await step('people-prs', () => this.batchPeoplesPrs(), undefined);
    await step('pr-batch', () => this.prBatchTick(), undefined);
    await step('merged', () => this.watchMerges(), undefined);
    await step('main watch', () => this.watchMain(), undefined);
    await step('fix forward', () => this.fixForwardStep(), undefined);
    await step('merge posts', () => this.postMerges(), undefined);
    await step('ci metrics', () => this.measureCi(), undefined);
    await step('deploy gate', () => this.liveDeployGate?.step(), undefined);
    await step('previews', () => this.d.previews?.step(), undefined);
    await step('retry', () => this.retryBlocked(), undefined);
    await step('corrections', () => this.checkCorrections(), undefined);
    await step('delegation', () => this.checkDelegation(), undefined);
    await step('gardener', () => this.checkGardener(), undefined);
    await step('checks from feedback', () => this.checkFeedbackChecks(), undefined);
    await step('optimize', () => this.checkOptimize(), undefined);
    await step('harness evals', () => this.checkHarnessEvals(), undefined);
    await step('learnings', () => this.promoteLearnings(), undefined);
    await step('superfan', () => this.checkSuperfan(), undefined);
    const dispatched = await step('dispatch', () => this.dispatch(), 0);
    await step('pool', () => this.maybeRefillPool(), undefined);
    if (this.stopped) return;
    this.emit('coordinator.tick', { instance: this.d.instance, dispatched, reconciled });
  }

  /** Wait for in-flight task pipelines (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()]);
    await this.d.prTestRuns?.idle();
    await this.d.deployGate?.idle();
    await this.d.previews?.idle();
    await this.chatQueue;
    await this.intakeQueue;
    await this.quickIdle();
    await this.poolRefill;
    await this.correctionsRun;
    await this.gardenerRun;
    await this.feedbackChecksRun;
    await this.optimizeRun;
    await this.superfanRun;
    await this.harnessEvalRun;
    await this.prBatchIdle();
  }

  private ciMeter: CiMetrics | null = null;

  /** CI timings for the metrics (src/ci-metrics.ts): with GitHub, at most one read-only call per CI_METRICS_CALL_MS. */
  protected async measureCi(): Promise<void> {
    const m = this.d.ciMetrics;
    if (!m) return;
    this.ciMeter ??= new CiMetrics({
      api: m.api,
      events: (types) => this.d.log.read(0, types as EventType[]),
      emit: (type, payload) => this.emit(type, payload),
      required: () => this.d.cfg.project.required_checks,
      ...(m.now ? { now: m.now } : {}),
    });
    await this.ciMeter.step();
  }

  private mergePoster: MergePosts | null = null;

  /**
   * Every merge to the default branch, posted once in the ops channel (src/merge-posts.ts): with GitHub, a Discord
   * source, discord.ops_channel and discord.post_merges (on by default). Off, its place is forgotten.
   */
  protected async postMerges(): Promise<void> {
    const m = this.d.mergePosts;
    if (!m) return;
    const intake = () => this.d.intake?.config() ?? null;
    this.mergePoster ??= new MergePosts({
      stateFile: join(this.d.stateDir, 'merge-posts.json'),
      branch: this.branch,
      api: m.api,
      git: repoGit(this.d.repo, this.remote, this.branch),
      redact: (s) => scrub(redactPii(s, { names: intake()?.redact.names ?? [], patterns: intake()?.redact.patterns ?? [] })),
      send: async (key, text) => {
        if (this.postedKeys().has(key)) return 'sent';
        const channel = intake()?.discord.ops_channel;
        const src = this.chatSource();
        if (!channel || !src || !takeOpsPost({ ...(this.d.slotsDir ? { dir: this.d.slotsDir } : {}), now: m.now?.() ?? Date.now() })) return 'limited';
        await this.channelSend(src, key, { channel }, { kind: 'notice', text });
        return 'sent';
      },
      ...(m.now ? { now: m.now } : {}),
    });
    const cfg = intake();
    if (!cfg || !cfg.discord.enabled || !cfg.discord.ops_channel || !cfg.discord.post_merges) return this.mergePoster.off();
    if (!this.chatSource()) return;
    await this.mergePoster.step();
  }

  /**
   * Honor the machine-wide emergency stop: abort every running agent (their
   * tasks release their claims and requeue) and start nothing new until it
   * is lifted. Called every tick and on a short timer by the service.
   */
  checkEmergency(): void {
    // Shutting down: the halt stays (stop() set it), whatever the emergency stop file says.
    if (this.stopped) return;
    const stop = emergencyStop(this.d.slotsDir);
    if (stop && !this.halt.signal.aborted) {
      this.emit('emergency.stop', { by: stop.by, reason: stop.reason, running: this.active.size });
      this.halt.abort();
    } else if (!stop && this.halt.signal.aborted) {
      this.emit('emergency.resume', { instance: this.d.instance });
      this.halt = new AbortController();
    }
  }

  /**
   * Shut down (SIGTERM, SIGINT): nothing new starts, and everything in flight is aborted rather than waited for.
   * Agent runs and project commands are aborted; their tasks requeue (runTask) and start again after the restart.
   */
  stop() {
    this.stopped = true;
    this.shutdown.abort();
    if (!this.halt.signal.aborted) this.halt.abort();
    // Test runs in flight are cancelled (and wiped); a cancelled PR's head runs again after the restart.
    this.d.prTestRuns?.stop();
    this.d.deployGate?.stop();
    this.d.previews?.stop();
    this.prBatchStop();
    this.superfanStop();
  }

  /** What a shutdown still waits on: the tick step, tasks and live runs (named in the log when it runs out of time). */
  pending(): string[] {
    return [
      ...(this.inStep ? [`tick step: ${this.inStep}`] : []),
      ...[...this.active.keys()].map((n) => `task #${n}`),
      ...[...this.live.values()].map((l) => `${l.role} run${l.issue !== null ? ` for #${l.issue}` : ''}`),
      ...(this.poolBusy ? ['worktree pool refill'] : []),
    ];
  }

  /**
   * Worker attempts already used on an issue, from the log: since its last block or decision (after which the
   * owner relabels or answers, and the task starts with a fresh budget). Restarts and requeues don't reset it.
   */
  private attemptsUsed(n: number): number {
    let used = 0;
    for (const e of this.events(n)) {
      if (e.type === 'issue.blocked' || e.type === 'decision.asked') used = 0;
      // A worker run the usage limit cut off (or a provider's limit sent to its fallback) wasn't an attempt at the task.
      else if (e.type === 'usage.limit_hit' && (e.payload as { role: string }).role === 'worker') used = Math.max(0, used - 1);
      // Nor was one Claude refused the login on (src/claude-auth-failure.ts): the task is requeued, the login held.
      else if (e.type === 'claude_auth.failed' && (e.payload as { role: string }).role === 'worker') used = Math.max(0, used - 1);
      // A run resumed after research it asked for continues its attempt; it isn't another one.
      else if (e.type === 'run.started' && (e.payload as { role: string }).role === 'worker' && !(e.payload as { resumed?: string }).resumed) used++;
    }
    return used;
  }

  /** Post the report for the latest configured time already passed today, once. */
  async maybeReport(now = new Date()) {
    const slot = dueSlot(this.d.cfg.project.reports.times, now);
    if (!slot) return;
    const day = now.toLocaleDateString('en-CA');
    const posted = this.d.log.read(0, ['report.posted']);
    if (posted.some((e) => (e.payload as { day: string; slot: string }).day === day && (e.payload as { slot: string }).slot === slot)) return;
    const last = posted.at(-1);
    const since = last ? new Date(last.ts) : new Date(now.getTime() - 12 * 3_600_000);
    const runRecords = recentRunRecords(this.d.stateDir, new Date(now.getTime() - 7 * 86_400_000));
    // The weekly section groups the week's failed runs by their earliest failed stage: label the new ones first.
    if (weeklyDue(this.d.cfg.project.reports.times, slot, now)) await this.labelStages(now, runRecords);
    const events = this.d.log.read();
    const report = buildReport(events, this.d.cfg, { since, now, slot, runRecords, ...(this.d.tokenExpiresAt !== undefined ? { tokenExpiresAt: this.d.tokenExpiresAt } : {}), ...(this.d.appKeyPath ? { appKeyPath: this.d.appKeyPath } : {}) });
    // A fix proposed for a repeated failure goes to the owner's Inbox once; it changes nothing until answered.
    const asked = new Set(events.filter((e) => e.type === 'decision.asked').flatMap((e) => (e.payload as { receipts: string[] }).receipts));
    // So does a tuning suggestion from what was measured (check times, a tune profile); a change is a reviewed PR.
    const tuning = tuningProposals(tuningInput(events, this.d.cfg.tests, readTuneProfile(this.d.stateDir)));
    for (const p of [...report.proposals, ...tuning]) {
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

  /** Label the week's unlabelled failed worker runs (coordinator/stage-labels.ts); a problem never stops the report. */
  private async labelStages(now: Date, runRecords: ReturnType<typeof recentRunRecords>) {
    try {
      await labelWeek({
        events: this.d.log.read(),
        records: runRecords,
        since: new Date(now.getTime() - 7 * 86_400_000),
        until: now,
        instance: this.d.instance,
        runner: this.d.runner,
        ...(({ model, route }) => ({ model, route }))(runRoute(this.d.cfg, 'stage_judge')),
        // The judge has no tools: it reads only what the prompt carries, wherever it runs.
        cwd: this.d.repo,
        doneWhenOf: async (n) => {
          const c = parseContract((await this.d.backlog.get(n)).body);
          if (!c.ok) return { commands: [], tests: [] };
          const list = localDoneWhen(c.done_when, this.d.cfg.tests);
          return { commands: doneWhenCommands(list, this.d.cfg.tests.runner), tests: list.flatMap((x) => ('test' in x ? [x.test] : [])) };
        },
        spentToday: () => this.spentToday(),
        dailyBudgetUsd: this.d.cfg.agents.daily_budget_usd,
        emit: (type, payload) => this.emit(type, payload),
      });
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: 'stage labels', kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    }
  }

  /** Queue the nightly runs once a day, after tests.yaml nightly_at. */
  private maybeNightly() {
    const last = this.d.log.read(0, ['nightly.queued']).at(-1)?.payload as { day: string } | undefined;
    if (!nightlyDue(this.d.cfg.tests.nightly_at, last?.day ?? null)) return;
    const jobs = (this.d.nightly ?? queueNightly)(this.d.repo, this.d.cfg, this.d.log.path, this.d.instance, this.d.commandsAs);
    this.emit('nightly.queued', { day: new Date().toLocaleDateString('en-CA'), jobs: jobs.map((j) => j.id) });
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
      const paused = this.usagePause();
      if (paused) return refuse(`paused on the Claude usage limit until ${resetWords(paused.resetAt, this.nowMs())}; it resumes on its own then`);
      if (this.authHold(this.loginKeyOf({}))) return refuse(AUTH_FAILED_CHAT_TEXT);
      const disk = this.diskHeld();
      if (disk) return refuse(`paused: ${disk}; it resumes on its own once there is room`);
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
      if (e instanceof AuthPaused) return refuse(AUTH_FAILED_CHAT_TEXT);
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
      // The console's own rule (console.ts): a message from the owner or a writer the dashboard read as one, a stop from the owner.
      const refused = mayRequest(this.d.cfg, { kind: q.kind, by: q.by, ...(q.owner === true ? { owner: true } : {}), ...(q.writer === true ? { writer: true } : {}) });
      if (refused) {
        refuse(refused);
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

  private liveCfg: LiveConfig | null = null;

  /**
   * Follow the default branch's config: fetch it, and when its config changed, swap the new one in whole (one
   * assignment: every reader after it sees the new config) with the instance's settings over it. An invalid one is
   * never applied: the last good one stays, recorded once (and raised as an incident when there's a watchdog).
   */
  refreshConfig(): void {
    this.liveCfg ??= new LiveConfig({ repo: this.d.repo, remote: this.remote, branch: this.branch, ...(this.d.liveConfig?.tree !== undefined ? { tree: this.d.liveConfig.tree } : {}), ...(this.d.liveConfig?.check ? { check: this.d.liveConfig.check } : {}) });
    spawnSync('git', ['fetch', '-q', this.remote, `+refs/heads/${this.branch}:refs/remotes/${this.remote}/${this.branch}`], { cwd: this.d.repo, stdio: 'ignore', timeout: 60_000 });
    const r = this.liveCfg.poll(this.repoCfg);
    if (r.kind === 'same') return;
    if (r.kind === 'invalid') {
      const errors = r.errors.slice(0, 20).map((e) => `${e.file}${e.path ? ` at ${e.path}` : ''}: ${e.message}`.slice(0, 500));
      this.emit('config.invalid', { sha: r.sha, errors });
      this.d.incidents?.raiseIncident(CONFIG_INCIDENT, this.d.instance, `${BRAND.configDir}/ on ${this.branch} at ${r.sha.slice(0, 8)} is invalid; running on the last good config: ${errors.join('; ').slice(0, 800)}`, `Fix ${BRAND.configDir}/ on ${this.branch}; it is applied on the next tick.`);
      return;
    }
    if (r.kind === 'confirmed') {
      // Started on a valid config: an incident left open by an earlier process (or engine) is stale.
      this.configLoads();
      return;
    }
    if (r.kind === 'recovered') {
      this.emit('config.recovered', { sha: r.sha });
      this.configLoads();
      return;
    }
    this.repoCfg = r.cfg;
    this.d.cfg = this.d.settings ? applySettings(r.cfg, this.d.settings().settings) : r.cfg;
    this.emit('config.applied', { sha: r.sha, changed: r.changed, restart_needed: r.restart });
    this.configLoads();
    if (r.restart.length) console.error(`restart needed: ${r.restart.map((s) => s.path).join(', ')} changed on ${this.branch}; running with the old values until a restart`);
  }

  /**
   * The config on the default branch loads: the config_invalid incident is resolved, unless it can never mark a PR
   * ready (src/ci-choice.ts, #469). That config still runs (the loader accepts it), but the incident names why.
   */
  private configLoads(): void {
    const problem = ciChoiceProblem(this.repoCfg.project);
    if (problem) this.d.incidents?.raiseIncident(CONFIG_INCIDENT, this.d.instance, `${BRAND.configDir}/ on ${this.branch}: ${problem.split(' Fix: ')[0]}`, `Fix: ${CI_CHOICE_FIX}.`);
    else this.d.incidents?.resolveIncident(CONFIG_INCIDENT, this.d.instance);
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
    // Paused on the Claude usage limit: nothing starts until its reset (the tick's usage step ends the pause).
    const paused = this.usagePause();
    if (paused) {
      this.noteHold({ kind: 'usage_limit', reason: `paused on the Claude usage limit until ${paused.resetAt}`, load: null, freeDiskPct: null, facts: { until: paused.resetAt } });
      return 0;
    }
    // A Claude login the API refused: nothing starts until a call on it succeeds (the tick's sign-in step checks it).
    const refused = this.authHeld();
    if (refused) {
      this.noteHold({ kind: 'sign_in', reason: `Claude sign-in failed (${refused.login}): no new runs until a call on that login succeeds`, load: null, freeDiskPct: null });
      return 0;
    }
    // WHY: a full disk, or one below its floor (src/disk-guard.ts): nothing new starts until there is room.
    const disk = this.diskHeld();
    if (disk) {
      this.noteHold({ kind: 'disk_full', reason: `paused: ${disk}`, load: null, freeDiskPct: null });
      return 0;
    }
    const windows = this.d.cfg.project.agent_runtime.run_windows;
    const now = this.d.now?.() ?? new Date();
    if (!inRunWindow(windows, now)) {
      const list = windows.map((w) => `${w.from}-${w.to}`).join(', ');
      const next = nextRunWindowStart(windows, now);
      this.noteHold({ kind: 'run_window', reason: `outside the run windows (${list})`, load: null, freeDiskPct: null, facts: { windows: list, ...(next ? { until: next.toISOString() } : {}) } });
      return 0;
    }
    let started = 0;
    // Fix-forward's fix task for a red default branch goes first: until it is green, only its PR merges.
    const ready = (await this.d.backlog.list('ready')).sort((a, b) => Number(this.fixForward.isFixTask(b.number)) - Number(this.fixForward.isFixTask(a.number)));
    // Hotspots: a task that would change a file a running task changes too waits; the loop goes on to the
    // next ready task, so the slot is used meanwhile. The files come from a cheap guess, never an agent run.
    const globs = this.d.cfg.project.hotspots ?? DEFAULT_HOTSPOTS;
    const files = ready.length ? this.repoFileIndex(globs) : null;
    this.graph.seed(ready);
    const planned = this.plannedFiles();
    // Fill free capacity this tick: one pass over the ready issues, one start per free worker.
    for (const issue of ready) {
      if (this.active.size >= (workers.count ?? 1)) break;
      const hold = this.governorHold();
      this.noteHold(hold);
      if (hold) break;
      if (this.active.has(issue.number) || !this.isTerminal(issue.number)) continue;
      // The machine's canary (src/canary.ts): its own App's canary issue, on the canary instance only.
      // Fix-forward's fix task: this instance filed it (its own event log says so), so it is worked whoever the tracker says opened it.
      const fixTask = issue.state === 'open' && issue.labels.includes('ready') && this.fixForward.isFixTask(issue.number) ? { actionable: true, why: 'fix-forward: the fix task for a red default branch' } : null;
      const act = fixTask ?? this.goalChild(issue) ?? canaryTask(issue, { instance: this.d.instance, canaryInstance: issue.labels.includes(CANARY_LABEL.name) ? machineCanaryInstance() : null, bot: this.identity.name }) ?? this.optimizeTask(issue) ?? (await actionable(issue, this.d.cfg.project.owners.writers, this.d.backlog));
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
      if (await this.graph.held(issue)) continue;
      // WHY: a running task owns its hotspots and its plan's files; this one waits if it would change any of them.
      const estimated = files ? estimateFiles(`${issue.title}\n${issue.body}`, files, globs) : [];
      const owns = [...hotspotsIn(estimated, globs), ...(planned.get(issue.number) ?? [])];
      const clash = pickDispatch([{ issue: issue.number, hotspots: [...new Set([...estimated, ...owns])] }], this.graph.claims.running(), 1).held[0];
      if (clash) {
        this.noteHotspotHold(clash);
        continue;
      }
      const slot = tryAgentSlot(`${BRAND.cli} ${this.d.cfg.project.project.name} #${issue.number}`, this.d.slotsDir);
      if (!slot) {
        this.noteHold(this.slotHold());
        break; // try again next tick
      }
      this.endHotspotHold(issue.number, true);
      this.graph.claims.set(issue.number, owns);
      const p = this.runTask(issue, contract.done_when)
        .catch(async (e: Error) => {
          this.emit('coordinator.error', { instance: this.d.instance, where: `task #${issue.number}`, kind: 'error', message: e.message.slice(0, 500) });
          // Never left silently claimed: the owner is told on the issue, and the claim released.
          try {
            await this.block(issue.number, this.ownerOf(issue.number), `the task failed: ${e.message.slice(0, 300)}`);
          } catch (e2) {
            this.emit('coordinator.error', { instance: this.d.instance, where: `task #${issue.number}: blocking it`, kind: 'error', message: (e2 as Error).message.slice(0, 500) });
          }
        })
        .finally(() => {
          slot.release();
          this.active.delete(issue.number);
          this.graph.claims.release(issue.number);
          // WHY: item 33; a note is a side record, so a problem writing it never touches the task's own outcome.
          try {
            this.noteLearnings(issue.number, doneWhenCommands(localDoneWhen(contract.done_when, this.d.cfg.tests), this.d.cfg.tests.runner));
          } catch (e) {
            this.emit('coordinator.error', { instance: this.d.instance, where: `learnings #${issue.number}`, kind: 'error', message: (e as Error).message.slice(0, 500) });
          }
        });
      this.active.set(issue.number, p);
      started++;
    }
    // A held task that is no longer ready (closed, relabeled) stops waiting.
    const stillReady = new Set(ready.map((i) => i.number));
    // INVARIANT: a running task waiting on files in-task is not ready, yet still held.
    for (const n of this.heldOn()) if (!stillReady.has(n) && !this.active.has(n)) this.endHotspotHold(n, false);
    this.graph.dropNotReady(stillReady);
    return started;
  }

  private graph_: TaskGraph | null = null;

  protected get graph(): TaskGraph {
    return (this.graph_ ??= new TaskGraph({ backlog: this.d.backlog, emit: (t, p) => this.emit(t, p), read: (types) => this.d.log.read(0, types), now: () => this.nowMs(), ...(this.d.ownershipPollMs ? { pollMs: this.d.ownershipPollMs } : {}) }));
  }

  /**
   * WHY: a child this instance filed from a writer's goal is worked though the tracker names the bot as its author;
   * only while it is open, labelled ready and its body is exactly as filed (an edit makes it a writer's call again).
   */
  private goalChild(issue: Issue): { actionable: true; why: string } | null {
    if (issue.state !== 'open' || !issue.labels.includes('ready')) return null;
    for (const e of this.d.log.read(0, ['goal.split'])) {
      const p = e.payload as EventPayload<'goal.split'>;
      const c = p.children.find((x) => x.number === issue.number);
      if (c && c.body_hash === bodyHash(issue.body)) return { actionable: true, why: `a child of goal #${p.issue}, filed by this instance` };
    }
    return null;
  }

  /** INVARIANT: a goal is split once; the split is checked whole (src/goal-split.ts) before any child is filed. */
  private async splitGoal(issue: Issue, doneWhen: DoneWhenList, path: string, owner: string): Promise<void> {
    const n = issue.number;
    const done = async (why: string) => {
      await this.d.backlog.removeLabel(n, 'agent:working');
      await this.d.backlog.addLabels(n, [GOAL_SPLIT_LABEL]);
      this.releaseClaim(n, why);
    };
    if (this.d.log.read(0, ['goal.split']).some((e) => (e.payload as { issue: number }).issue === n)) {
      await this.d.backlog.comment(n, `[${BRAND.cli}] This goal was already split; its child issues are listed above. Nothing filed again.`);
      return await done('goal already split');
    }
    const workers = this.d.cfg.agents.roles.workers!;
    const model = routeRun(this.d.cfg, 'planner');
    const r = await this.d.runner.run({
      env: this.projectEnv(),
      role: 'goal-planner',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen),
      appendSystemPrompt: rolePrompt(this.d.cfg, 'goal-planner'),
      cwd: path,
      model,
      allowedTools: PLAN_TOOLS,
      disallowedTools: PLAN_DISALLOWED,
      maxTurns: 60,
      maxBudgetUsd: Math.min(workers.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: GOAL_SPLIT_SCHEMA,
      stallMs: 20 * 60_000,
      timeoutMs: this.commandTimeoutMs,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'goal-planner', model, worktree: path, pid: p, pgid: p, attempt: 1 }),
    });
    this.cost(n, 'goal-planner', r);
    this.emit('run.finished', { issue: n, role: 'goal-planner', reason: r.reason, detail: r.detail.slice(0, 1000) });
    if (r.reason !== 'succeeded') return await this.block(n, owner, `the goal split run ended: ${r.reason} (${r.detail.slice(0, 300)})`);
    const split = readGoalSplit(r.structured);
    if ('invalid' in split) return await this.block(n, owner, `the goal split was refused: ${split.invalid}`);
    if ('notSplittable' in split) return await this.block(n, owner, `the goal planner did not split it: ${split.notSplittable}`);
    const numbers = new Map<string, number>();
    const filed: { number: number; key: string; title: string; deps: number[]; body_hash: string }[] = [];
    for (const c of split.children) {
      const deps = c.depends_on.map((k) => numbers.get(k)!);
      const body = childBody(c, n, deps);
      const num = await this.d.backlog.createIssue(c.title, body, ['ready']);
      numbers.set(c.key, num);
      filed.push({ number: num, key: c.key, title: c.title, deps, body_hash: bodyHash((await this.d.backlog.get(num)).body) });
    }
    this.emit('goal.split', { issue: n, summary: split.summary.slice(0, 2000), children: filed.map((f) => ({ number: f.number, key: f.key, depends_on: f.deps, body_hash: f.body_hash })) });
    await this.d.backlog.comment(n, splitComment(BRAND.cli, split.summary, filed));
    await done(`goal split into ${filed.length} child issues`);
  }

  /** WHY: an issue planned before (a held plan approved, a requeue) is judged by its plan's files too. */
  private plannedFiles(): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const e of this.d.log.read(0, ['plan.posted'])) {
      const p = e.payload as EventPayload<'plan.posted'>;
      const files = (p.plan as { files?: unknown }).files;
      out.set(p.issue, Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : []);
    }
    return out;
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

  private poolBusy = false;

  private poolCheckedAt = 0;

  private poolRefill: Promise<void> = Promise.resolve();

  /**
   * Keep the worktree pool on main's tip, in the background: at most one refill at a time, checked every
   * few minutes, so a slow setup never holds the coordinator's tick.
   */
  private maybeRefillPool(now = Date.now()) {
    const size = this.d.cfg.tests.worktree.pool;
    if (size <= 0 || this.poolBusy || this.stopped || now - this.poolCheckedAt < POOL_CHECK_MS) return;
    this.poolCheckedAt = now;
    this.poolBusy = true;
    this.poolRefill = (async () => {
      try {
        spawnSync('git', ['fetch', '-q', this.remote, this.branch], { cwd: this.d.repo });
        const base = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
        const wt = this.wt;
        const keyFiles = this.d.cfg.tests.worktree.setup_key;
        const r = await refillPool(wt, { size, base, estSizeGb: this.d.cfg.tests.worktree.est_size_gb, key: (b) => setupKey(wt, b, keyFiles) });
        if (r.created.length || r.moved.length || r.removed.length || r.errors.length) this.emit('worktree.pool_refilled', { base, created: r.created, moved: r.moved, removed: r.removed, errors: r.errors.map((x) => x.slice(0, 500)) });
      } catch (e) {
        this.emit('coordinator.error', { instance: this.d.instance, where: 'worktree pool', kind: 'error', message: (e as Error).message.slice(0, 500) });
      } finally {
        this.poolBusy = false;
      }
    })();
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
    // The contract as agreed is recorded; what runs here skips the full suite when the test run is the full run.
    doneWhen = localDoneWhen(doneWhen, this.d.cfg.tests);
    this.emit('issue.claimed', { issue: n, instance: this.d.instance, lease: leaseSha, base, owner });
    await this.d.backlog.removeLabel(n, 'ready');
    await this.d.backlog.addLabels(n, ['agent:working']);
    if (!issue.assignees.length) await this.d.backlog.setAssignees(n, [owner]);
    await this.d.backlog.comment(n, `[${BRAND.cli}] Claimed by \`${this.d.instance}\` (owner @${owner}, agent delegate: worker). Base \`${base.slice(0, 8)}\`, lease \`${leaseSha.slice(0, 8)}\`.`);
    const heartbeat = setInterval(() => {
      try {
        const next = renew({ ...lease, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString() }, leaseSha, { repo: this.d.repo, remote: this.remote });
        if (next) leaseSha = next;
      } catch (e) {
        // WHY: a full disk fails the lease commit; thrown from a timer it would kill the coordinator. The next beat renews.
        if (!storageFailure(e)) throw e;
      }
    }, 20 * 60_000);
    heartbeat.unref();

    const { name, branch, taskFile } = this.paths(n);
    // Raised when the issue's runs reach 85% of its budget; resolved once the task stops here, however it ends.
    let budgetRaised = false;
    try {
      // A worktree already set up on this base, from the pool, when there is one; else a fresh one.
      const pooled = this.d.cfg.tests.worktree.pool > 0 ? takeFromPool(this.wt, base, branch) : null;
      if (pooled) this.emit('worktree.pooled', { issue: n, name: pooled.name });
      let wtName = pooled ? pooled.name : name;
      // A reassign starts the attempts again in a fresh worktree.
      let { path, setupErrors } = pooled ? { path: pooled.path, setupErrors: [] as string[] } : createWorktree(this.wt, name, branch, base);
      if (setupErrors.length) throw new Error(`worktree setup failed: ${setupErrors.join('; ')}`);
      this.writeTask(taskFile, { id: `issue-${n}`, done_when: doneWhen });

      // Research first, when the issue asks for it (a type:research or type:investigation label, or a ```research
      // block): its report is posted on the issue, and a later investigation or build gets it in its brief.
      // Only a research issue (type:research alone) stops when its research fails: for an investigation or a build,
      // research helps but never gates, so a failed or capped run is noted and the task goes on without it.
      const asks = researchTrigger(issue);
      if (asks) {
        const researchOnly = issue.labels.includes('type:research') && !issue.labels.includes('type:investigation');
        const failed = await this.research(issue, asks.questions, path);
        if (failed && researchOnly) {
          await this.block(n, owner, failed);
          return;
        }
        if (failed) await this.d.backlog.comment(n, `[${BRAND.cli}] No research report for this issue (${failed}); going on without one.`);
        if (researchOnly) {
          await this.d.backlog.removeLabel(n, 'agent:working');
          await this.d.backlog.addLabels(n, ['in-review']);
          this.releaseClaim(n, 'research reported');
          return;
        }
      }

      if (issue.labels.includes('type:investigation')) return await this.investigate(issue, doneWhen, path, taskFile, base, owner);
      if (issue.labels.includes(GOAL_LABEL)) return await this.splitGoal(issue, doneWhen, path, owner);

      // size:M/L: a read-only plan first. One that touches high-risk or design-level areas waits for the owner's
      // approval (the task stops here and resumes on the answer); any other is posted and built at once.
      let plan: Plan | null = null;
      let planComments = 0;
      if (needsPlan(issue.labels)) {
        const p = await this.planStep(issue, doneWhen, path, base, owner);
        if ('stop' in p) return;
        plan = p.plan;
        planComments = p.commentsAt;
        await this.graph.own(n, plan.files, {
          live: (i) => i === n || this.active.has(i),
          halted: () => {
            if (this.halt.signal.aborted) throw this.haltError();
          },
          onHold: (h) => this.noteHotspotHold(h),
          onFree: () => this.endHotspotHold(n, true),
        });
      }

      const repro = doneWhen.some((d) => 'repro' in d && d.repro) ? await this.reproduce(issue, doneWhen, base, path) : null;
      // The frozen test is off-limits to the worker: its hook denies writes to it.
      if (repro?.path) this.writeTask(taskFile, { id: `issue-${n}`, done_when: doneWhen, frozen: [repro.path] });
      // agents.yaml max_attempts (default 8), read from the live config; a test may set its own.
      const maxAttempts = this.d.maxAttempts ?? this.d.cfg.agents.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
      let feedback: string[] = [];
      // Where every attempt starts: the base, with the frozen reproduction test when there is one. A reassign goes back here.
      const start = this.git(path, 'rev-parse', 'HEAD');
      // Once reassigned (src/coordinator/loop-control.ts), the task's attempts run on the escalated model.
      let escalate = reassigned(this.events(n));
      const failed = (attempt: number, kind: FailureKind, text: string) => this.emit('attempt.failed', { issue: n, attempt, kind, fingerprint: failureFingerprint(kind, text).slice(0, 200) });
      // The push limits the last attempt hit, if that's why it was rejected: the block then lists them.
      let refused: string[] | null = null;
      // Attempts are counted from the log, so a restart or an emergency stop's requeue continues the count
      // instead of starting again from 1.
      const used = this.attemptsUsed(n);
      if (used >= maxAttempts) return await this.block(n, owner, `no passing change after ${used} attempts (counted across restarts and requeues)`);
      // Once a hosted model's change is refused, the task's later attempts run on Anthropic.
      let noOpenModel = false;
      // An optimization task (src/coordinator/optimize.ts): its week's budget is a hard stop before every attempt.
      const optimizing = this.optimizePassOf(n);
      for (let attempt = used + 1; attempt <= maxAttempts; attempt++) {
        if (plan && (await this.planObjected(n, owner, planComments))) return;
        if (optimizing && this.optimizeLeft() <= 0) {
          const why = `the week's optimization budget ($${this.d.cfg.project.optimize.budget_usd}) is spent ($${this.optimizeSpent().toFixed(2)})`;
          this.emit('optimize.result', { issue: n, target: optimizing.target ?? '', head: null, outcome: 'discarded', why, before: optimizing.baseline, after: null, gain: null, pct: null, noise: null });
          return await this.optimizeDiscard(n, why, optimizing.baseline);
        }
        // The issue's budget: an incident at 85%, stopped at 100%.
        const budget = this.taskBudget(n);
        if (budget.raised) budgetRaised = true;
        if (budget.level === 'over') return await this.block(n, owner, `stopped at its budget: ${budget.detail}. Raise agents.yaml budget, or label it \`ready\` again to start over with a fresh budget.`);
        // The same failure IDENTICAL_FAILURES times in a row: no more attempts down that road. Reassigned once (a
        // fresh worktree, the escalated model); the second time it is blocked.
        const streak = identicalStreak(this.events(n));
        if (streak.count >= IDENTICAL_FAILURES) {
          if (escalate) return await this.block(n, owner, `the same failure ${streak.count} times in a row, again after a reassign to a fresh worktree and the escalated model: ${streak.fingerprint}`);
          try {
            removeWorktree(this.wt, wtName);
          } catch {
            // not ours or already gone: the fresh one replaces it either way
          }
          ({ path, setupErrors } = createWorktree(this.wt, name, branch, start));
          wtName = name;
          if (setupErrors.length) throw new Error(`worktree setup failed: ${setupErrors.join('; ')}`);
          escalate = true;
          this.emit('task.reassigned', { issue: n, attempt, fingerprint: streak.fingerprint!.slice(0, 200), repeats: streak.count, model: this.buildModelFor(issue, attempt, noOpenModel, true) });
          await this.d.backlog.comment(n, `[${BRAND.cli}] The same failure ${streak.count} times in a row (${streak.fingerprint}): starting again from \`${start.slice(0, 8)}\` in a fresh worktree, on the escalated model.`);
          feedback = [`Earlier attempts failed the same way ${streak.count} times in a row (${streak.fingerprint}); their work was discarded. Take a different approach.`];
        }
        // Before a retry: a short read-only look at why the last attempt failed, for this attempt's brief.
        if (feedback.length && attempt > 1) feedback = [...feedback, ...(await this.reflect(issue, doneWhen, path, start, feedback, attempt))];
        const left = timeLeftMs(taskUsage(this.events(n)), this.d.cfg.agents.budget);
        const out = await this.build(issue, doneWhen, path, taskFile, repro, feedback, attempt, plan, 0, noOpenModel, { escalate, ...(left !== null ? { timeoutMs: Math.max(60_000, Math.min(left, this.commandTimeoutMs)) } : {}) });
        if (out.stop) return;
        // Stopped by the stuck-run guard: a failed attempt, whatever it committed.
        if (out.stuck) {
          failed(attempt, 'stuck', out.stuck);
          feedback = stuckFeedback(out.stuck);
          continue;
        }
        removeSandboxPlaceholders(path);
        const head = this.git(path, 'rev-parse', 'HEAD');
        // A finding of "no change" counts only for a branch with nothing on it: work an earlier attempt committed is
        // judged as a change against the base, like any other.
        if (out.noChange && this.git(path, 'rev-list', '--count', `${base}..${head}`) === '0') {
          const done = await this.confirmNoChange(n, owner, path, base, head, doneWhen, repro, out.noChange);
          if (done.confirmed) return;
          this.emit('change.rejected', { issue: n, why: done.why });
          failed(attempt, 'rejected', done.why);
          feedback = [`Your previous attempt was rejected: ${done.why}`];
          continue;
        }
        const change = await this.inspect(n, path, base, head, repro);
        refused = 'rejected' in change ? (change.refused ?? null) : null;
        // A hosted open model never builds L3, money-path or agent-instructions work: such a change is refused, and the
        // task goes on with the next attempt on the build's Anthropic model.
        // WHY: item 38. A cli: build rejected for any reason (a protected path among them) still moves the task to Anthropic.
        const built = 'rejected' in change ? (out.provider?.startsWith('cli:') ? this.changeFiles(path, base, head) : null) : change.files;
        const hostedWhy = built ? builtChangeRefusal(out.provider, { files: built, labels: issue.labels, moneyPaths: () => loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source), review: this.d.cfg.review ?? DEFAULT_REVIEW, guardrails: this.d.cfg.guardrails }) : null;
        if (hostedWhy) {
          noOpenModel = true;
          this.emit('provider.fallback', { issue: n, role: 'worker', provider: out.provider!, reason: hostedWhy, model: buildRoute(this.d.cfg, issue.labels, attempt + 1, true).model });
          this.emit('change.rejected', { issue: n, why: hostedWhy });
          feedback = [`Your previous attempt was rejected: ${hostedWhy}. It is being redone on the harness's own model.`];
          continue;
        }
        if ('rejected' in change) {
          this.emit('change.rejected', { issue: n, why: change.rejected });
          failed(attempt, 'rejected', change.rejected);
          feedback = [`Your previous attempt was rejected: ${change.rejected}`];
          continue;
        }
        const checks = await this.verify(n, path, head, doneWhen, repro);
        if (checks.some((c) => c.status !== 'pass')) {
          this.emit('attempt.failed', { issue: n, attempt, kind: 'checks', fingerprint: checksFingerprint(checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped')).slice(0, 200) });
          feedback = [`Independent checks failed on your last attempt:`, ...checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped').map((c) => `- ${c.check}: ${c.status}\n${c.tail}`)];
          continue;
        }
        const verdict = await this.evaluate(issue, doneWhen, path, base, head, change.patchHash, checks, repro, change.tampered, change.files);
        if (!verdict.patch_correct && attempt < maxAttempts) {
          failed(attempt, 'evaluator', verdict.advice);
          feedback = [`The independent evaluator rejected your change: ${verdict.advice}`];
          continue;
        }
        // An optimization becomes a PR only if its benchmark beats main's by more than the noise; else discarded.
        if (optimizing && !(await this.optimizeGate(n, optimizing, path, base, head))) return;
        // A change to the agents' own instructions is evaluated before it can land (the merge policy reads the result).
        if (verdict.patch_correct) await this.instructionEvals(n, path, base, head, change.files.map((f) => f.path));
        const levelInput = { files: change.files, labels: issue.labels, moneyPaths: loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source), verdict, ...(verdict.unread.length ? { requested: 'L3' as Level } : out.raise || change.tampered.length || repro?.unavailable ? { requested: out.raise ?? ('L2' as Level) } : {}) };
        const lvl = computeLevel(levelInput, this.d.cfg.review ?? DEFAULT_REVIEW);
        // Safety floor: in direct mode a change the evaluator rejected never lands without the owner. Not a
        // setting: no config, policy or review level can lower it. (PR mode needs the approval at the head anyway.)
        if (this.d.cfg.project.land_mode === 'direct' && !verdict.patch_correct) {
          lvl.level = 'L3';
          lvl.reasons.push('the evaluator rejected the patch: held for the owner (safety floor)');
        }
        if (plan && (await this.planObjected(n, owner, planComments))) return;
        this.emit('review.level_set', { issue: n, head, level: lvl.level, reasons: [...lvl.reasons, ...(verdict.unread.length ? [`evaluator did not read: ${verdict.unread.slice(0, 10).join(', ')}${verdict.unread.length > 10 ? ` and ${verdict.unread.length - 10} more` : ''}`] : []), ...change.tampered.map((t) => `tamper guard: ${t}`), ...(repro?.unavailable ? [`no reproduction: ${repro.unavailable}`] : [])] });
        await this.d.backlog.removeLabel(n, 'agent:working');
        await this.d.backlog.addLabels(n, ['in-review', `review:${lvl.level}`]);
        if (lvl.level === 'L3') {
          await this.ask('land', n, owner, `Approve landing #${n} (${lvl.level})?`, ['approve', 'reject'], verdict.patch_correct ? 'approve' : 'reject', [`head ${head.slice(0, 8)}`, ...lvl.reasons, `evaluator: ${verdict.confidence}; ${verdict.advice || 'no concerns'}`], changeContext({ base, head, files: change.files, level: lvl, verdict, checks, tampered: change.tampered }));
        } else {
          this.emit('land.queued', { issue: n, head, level: lvl.level });
        }
        return;
      }
      await this.block(n, owner, refused ? `no pushable change after ${maxAttempts} attempts; ${pushRefusal(refused)}` : `no passing change after ${maxAttempts} attempts`);
    } catch (e) {
      // Stopped from the console: the task waits for the owner, saying who stopped it.
      if (e instanceof StoppedByOwner) return await this.block(n, owner, e.message);
      // The usage limit: requeued, not failed or blocked, with no attempt counted; dispatch holds until the reset.
      // A refused Claude login: requeued the same way, no attempt counted; dispatch holds until the login works.
      if (e instanceof AuthPaused) {
        this.releaseClaim(n, 'Claude sign-in failed; requeued');
        await this.d.backlog.removeLabel(n, 'agent:working');
        await this.d.backlog.addLabels(n, ['ready']);
        await this.d.backlog.comment(n, `[${BRAND.cli}] Claude sign-in failed on this machine (the owner has been told): requeued, and it starts again on its own once the login works. Nothing to do here.`);
        return;
      }
      if (e instanceof UsagePaused) {
        this.releaseClaim(n, 'paused on the Claude usage limit; requeued');
        await this.d.backlog.removeLabel(n, 'agent:working');
        await this.d.backlog.addLabels(n, ['ready']);
        await this.d.backlog.comment(n, `[${BRAND.cli}] Paused on the Claude usage limit until ${resetWords(e.resetAt, this.nowMs())}: requeued, and it starts again on its own after the reset. Nothing to do.`);
        return;
      }
      // Shutting down (a restart or an update): requeued, and it starts again after the restart. Nothing is lost:
      // a shutdown that runs out of time before this leaves the claim, and the next start's recovery requeues it.
      if (e instanceof ShuttingDown) {
        this.releaseClaim(n, 'shutdown: the coordinator stopped while it ran; requeued');
        await this.d.backlog.removeLabel(n, 'agent:working');
        await this.d.backlog.addLabels(n, ['ready']);
        await this.d.backlog.comment(n, `[${BRAND.cli}] The coordinator stopped (a restart or an update) while this ran: requeued from the start, and it starts again on its own after the restart. Nothing to do.`);
        return;
      }
      if (!(e instanceof Halted)) throw e;
      // Requeued: the task starts over once the stop is lifted.
      this.releaseClaim(n, 'emergency stop');
      await this.d.backlog.removeLabel(n, 'agent:working');
      await this.d.backlog.addLabels(n, ['ready']);
      await this.d.backlog.comment(n, `[${BRAND.cli}] Stopped by an emergency stop; requeued from the start once it is lifted.`);
    } finally {
      clearInterval(heartbeat);
      if (budgetRaised) this.d.incidents?.resolveIncident(TASK_BUDGET_INCIDENT, `${this.d.instance}#${n}`);
    }
  }

  /**
   * The issue's runs against its agents.yaml budget (src/coordinator/loop-control.ts). Each level is recorded once
   * per reset, and the incident is raised once, when the first is (`raised`: it is open).
   */
  private taskBudget(n: number): { level: 'ok' | 'warn' | 'over'; detail: string; raised: boolean } {
    const events = this.events(n);
    const usage = taskUsage(events);
    const s = budgetState(usage, this.d.cfg.agents.budget);
    if (s.level === 'ok') return { level: 'ok', detail: '', raised: false };
    const recorded = sinceReset(events).filter((e) => e.type === 'task.budget').map((e) => (e.payload as { level: string }).level);
    if (!recorded.includes(s.level)) this.emit('task.budget', { issue: n, level: s.level, share: Math.round(s.share * 1000) / 1000, tokens: Math.round(usage.tokens), minutes: Math.round(usage.minutes * 10) / 10, detail: s.detail.slice(0, 500) });
    if (!recorded.length) this.d.incidents?.raiseIncident(TASK_BUDGET_INCIDENT, `${this.d.instance}#${n}`, `Issue #${n} has used ${s.detail}`, s.level === 'over' ? `It was stopped; raise agents.yaml budget or label #${n} ready again.` : `It is stopped at 100%; raise agents.yaml budget if it should go on.`);
    return { level: s.level, detail: s.detail, raised: true };
  }

  /** A build's model: as routed for the attempt, or escalated once the task was reassigned. */
  private buildModelFor(issue: Issue, attempt: number, noOpenModel: boolean, escalate: boolean): string {
    return buildRoute(this.d.cfg, issue.labels, escalate ? Math.max(attempt, modelRouting(this.d.cfg.agents).escalate_after + 1) : attempt, noOpenModel).model;
  }

  /**
   * Before a retry: a short read-only run on the cheap tier (model routing's `reflection`) reads why the last attempt
   * failed and the change it left, and says what failed and what to change; that goes into the next attempt's brief.
   * Its cost counts toward the issue's budget. A failed reflection never stops the task: the attempt goes on without it.
   */
  private async reflect(issue: Issue, doneWhen: DoneWhenList, path: string, start: string, feedback: string[], attempt: number): Promise<string[]> {
    const n = issue.number;
    const { model, route } = runRoute(this.d.cfg, 'reflection');
    const earlier = sinceReset(this.events(n)).filter((e) => e.type === 'attempt.failed').map((e) => (e.payload as { fingerprint: string }).fingerprint).slice(0, -1);
    let changed = '';
    try {
      changed = this.git(path, 'diff', '--stat', start).slice(0, 3000);
    } catch {
      // no diff to show: the brief says so
    }
    const began = Date.now();
    try {
      const r = await this.d.runner.run({
        env: this.projectEnv(),
        role: 'reflection',
        ...laneOf(issue),
        stateDir: this.d.stateDir,
        prompt: reflectionBrief(issueBrief(issue, doneWhen), feedback, earlier, changed),
        appendSystemPrompt: rolePrompt(this.d.cfg, 'reflection'),
        cwd: path,
        model,
        route,
        allowedTools: ['Read', 'Glob', 'Grep'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
        maxTurns: 15,
        maxBudgetUsd: Math.min(1, Math.max(0.1, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
        jsonSchema: REFLECTION_SCHEMA,
        stallMs: 5 * 60_000,
        timeoutMs: Math.min(15 * 60_000, this.commandTimeoutMs),
      });
      this.cost(n, 'reflection', r.durationMs === undefined ? { ...r, durationMs: Date.now() - began } : r);
      const lines = r.reason === 'succeeded' ? reflectionFeedback(r.structured as { what_failed?: unknown; what_to_change?: unknown } | undefined) : [];
      this.emit('attempt.reflected', { issue: n, attempt, model, ok: lines.length > 0, ...(lines.length ? {} : { why: (r.reason === 'succeeded' ? 'no what_failed / what_to_change in its output' : `${r.reason}: ${r.detail}`).slice(0, 500) }) });
      return lines;
    } catch (e) {
      if (e instanceof StoppedByOwner || e instanceof Halted || e instanceof ShuttingDown || e instanceof UsagePaused) throw e;
      this.emit('attempt.reflected', { issue: n, attempt, model, ok: false, why: (e as Error).message.slice(0, 500) });
      return [];
    }
  }

  /** Read-only work: findings with evidence go to the owner; nothing is committed or landed. */
  private async investigate(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, base: string, owner: string) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.workers!;
    // Routed like a build (src/model-routing.ts): the high-risk model for a high-risk issue; never an open model.
    const { model } = buildRoute(this.d.cfg, issue.labels, 1, true);
    const r = await this.d.runner.run({
      env: this.projectEnv(),
      role: 'investigator',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, this.answers(n)),
      appendSystemPrompt: rolePrompt(this.d.cfg, 'investigator'),
      cwd: path,
      model,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      maxTurns: 150,
      maxBudgetUsd: Math.min(role.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: INVESTIGATION_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      timeoutMs: this.commandTimeoutMs,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'investigator', model, worktree: path, pid: p, pgid: p, attempt: 1 }),
    });
    this.cost(n, 'investigator', r);
    this.emit('run.finished', { issue: n, role: 'investigator', reason: r.reason, detail: r.detail.slice(0, 1000) });
    // Read-only means read-only: any change it left behind is discarded and reported.
    const touched = this.git(path, 'status', '--porcelain') || (this.git(path, 'rev-parse', 'HEAD') !== base ? 'commits' : '');
    const s = r.structured as { summary: string; findings: { claim: string; evidence: string }[]; recommendation: string; recommended?: string; confidence: string; unverified?: string[] } | undefined;
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
    // The option it recommends is the recommendation; its reasoning, whole, is the detail's last line.
    await this.ask('question', n, owner, 'How should this proceed?', [...INVESTIGATION_OPTIONS], s.recommended ?? '', [`confidence ${s.confidence}`, `${s.findings.length} finding(s)`, ...(s.recommendation?.trim() ? [`${RECOMMENDATION_PREFIX}${s.recommendation.trim()}`] : [])], investigationContext(s));
  }

  private async reproduce(issue: Issue, doneWhen: DoneWhenList, base: string, workerPath: string): Promise<{ path: string; hash: string } & { unavailable?: string }> {
    const n = issue.number;
    const name = `issue-${n}-repro`;
    const { path } = createWorktree(this.wt, name, `${BRAND.cli}/issue-${n}-repro`, base);
    try {
      const role = this.d.cfg.agents.roles.evaluator!;
      const r = await this.d.runner.run({
        env: this.projectEnv(),
        role: 'evaluator-repro',
        stateDir: this.d.stateDir,
        prompt: issueBrief(issue, doneWhen),
        appendSystemPrompt: rolePrompt(this.d.cfg, 'evaluator-repro'),
        cwd: path,
        model: role.model,
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
        maxTurns: 40,
        maxBudgetUsd: role.budget_usd ?? 3,
        jsonSchema: REPRO_SCHEMA,
        stallMs: 15 * 60_000,
        timeoutMs: this.commandTimeoutMs,
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

  private async build(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, repro: { path: string } | null, feedback: string[], attempt: number, plan: Plan | null = null, researched = 0, noOpenModel = false, more: { escalate?: boolean; timeoutMs?: number } = {}): Promise<BuildOut> {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.workers!;
    // Routed (src/model-routing.ts): the high-risk model for an L3 or high-risk issue, or once `escalate_after`
    // attempts have failed (or the task was reassigned); the build model otherwise (an open model only on the default
    // route, src/providers.ts).
    const { model, route } = buildRoute(this.d.cfg, issue.labels, more.escalate ? Math.max(attempt, modelRouting(this.d.cfg.agents).escalate_after + 1) : attempt, noOpenModel);
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
      env: this.projectEnv(),
      role: 'worker',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg, 'worker'),
      cwd: path,
      model,
      route,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      maxTurns: 200,
      // An optimization task's run is also capped at what its week's budget has left (a hard stop).
      maxBudgetUsd: Math.min(role.budget_usd ?? 10, remaining, ...(this.optimizePassOf(n) ? [Math.max(0.01, this.optimizeLeft())] : [])),
      jsonSchema: WORKER_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      // Within the issue's time budget, when it has one.
      timeoutMs: more.timeoutMs ?? this.commandTimeoutMs,
      onStart: (p) => {
        pid = p;
        this.emit('run.started', { issue: n, role: 'worker', model, worktree: path, pid: p, pgid: p, attempt, ...(researched ? { resumed: 'research' as const } : {}) });
      },
    });
    void pid;
    // The run's time counts toward the issue's budget even when claude reported none (a timeout, a stop).
    this.cost(n, 'worker', r.durationMs === undefined ? { ...r, durationMs: Date.now() - started } : r);
    // Its session is kept: a fix run on this issue's PR resumes it (src/coordinator/fix-runs.ts).
    this.emit('run.finished', { issue: n, role: 'worker', reason: r.reason, detail: r.detail.slice(0, 1000), ...(r.sessionId && SESSION_ID.test(r.sessionId) ? { session: r.sessionId } : {}) });
    const s = (r.structured ?? {}) as { summary?: string; blocked?: string; no_change_needed?: string; ask?: { question: string; options: string[]; recommendation: string; detail?: string }; raise_review?: Level; research_request?: unknown; intent?: string; risk_class?: RiskClass };
    const owner = this.ownerOf(n);
    // The runner already waited out auth and transient errors for half an hour: not the change, so say so.
    if (r.transient) {
      const said = r.detail.slice(0, 1500).replace(/`{3,}/g, "'''");
      // The claim is released, so relabelling `ready` requeues it; a rate limit also retries on its own.
      await this.block(n, owner, `claude kept failing to start on an auth or transient error (token refresh, rate limit, overload or network), not on this change, so no attempt was counted. Check the agent user's Claude login (\`claude auth status\`) and label it \`ready\` again. claude reported:\n\n\`\`\`\n${said}\n\`\`\``, true, r.reason === 'rate_limited' ? retryAfter('rate_limit') : undefined);
      return { stop: true as const };
    }
    if (r.reason === 'rate_limited' || r.reason === 'budget_exhausted' || r.reason === 'auth_mismatch') {
      // Released, so relabelling `ready` requeues it. Rate limits and budgets also retry once their window resets;
      // an auth problem waits for the owner.
      await this.block(n, owner, `worker run ended: ${r.reason} (${r.detail})`, true, r.reason === 'rate_limited' ? retryAfter('rate_limit') : r.reason === 'budget_exhausted' ? retryAfter('budget') : undefined);
      return { stop: true as const };
    }
    if (r.reason === 'stuck') return { stop: false as const, stuck: r.detail };
    // A run that failed almost at once and committed nothing never got to work: another attempt would fail the
    // same way, so say what claude reported instead of spending the attempts on "no passing change".
    const secs = Math.round((Date.now() - started) / 1000);
    if (r.reason === 'failed' && secs < STARTUP_FAILURE_SECS && this.git(path, 'rev-parse', 'HEAD') === before) {
      this.emit('run.startup_failed', { issue: n, role: 'worker', attempt, seconds: secs, turns: r.turns, detail: r.detail.slice(0, 2000) });
      const said = r.detail.slice(0, 1500).replace(/`{3,}/g, "'''");
      await this.block(n, owner, `the worker's claude run failed to start (ended after ${secs}s, ${r.turns} turn(s), nothing committed), so no further attempts were made. claude reported:\n\n\`\`\`\n${said}\n\`\`\``);
      return { stop: true as const };
    }
    // Research it asked for instead of guessing: answered within the caps and the per-task limit, then the same
    // attempt resumes with the answer (or why there is none) in its brief. Past the limit, its output stands as is.
    if (s.research_request && researched < MAX_REQUESTS_PER_TASK) {
      const section = await this.answerResearch(issue, s.research_request, path, 'worker');
      return this.build(issue, doneWhen, path, taskFile, repro, [...feedback, '', section], attempt, plan, researched + 1, noOpenModel, more);
    }
    if (s.ask) {
      await this.ask('question', n, owner, s.ask.question, s.ask.options, s.ask.recommendation, [s.summary ?? '', ...(s.ask.detail ? [`${RECOMMENDATION_PREFIX}${s.ask.detail}`] : [])], summaryContext(s.summary));
      return { stop: true as const };
    }
    if (s.blocked) {
      await this.block(n, owner, s.blocked);
      return { stop: true as const };
    }
    // What the worker says it verified: checked against the record at evaluation, listed in the PR's receipts.
    // And its intent (the summary's first paragraph when it gave none) and risk class: the top of the PR body.
    const intent = oneParagraph(s.intent || (s.summary ?? '').split(/\n\s*\n/)[0]).slice(0, 4000);
    const riskClass = s.risk_class && RISK_CLASSES.includes(s.risk_class) ? s.risk_class : undefined;
    this.emit('worker.claims', { issue: n, claims: claimsOf(s.summary ?? ''), ...(intent ? { intent } : {}), ...(riskClass ? { risk_class: riskClass } : {}) });
    return { stop: false as const, ...(s.raise_review ? { raise: s.raise_review } : {}), ...(s.no_change_needed ? { noChange: s.no_change_needed } : {}), ...(r.provider ? { provider: r.provider } : {}) };
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
    const model = cfg.model ?? routeRun(this.d.cfg, 'eval_answer');
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
        // A role is judged on its held-out cases too (the coordinator's own, never in the repo); they decide.
        const held = t.role ? await heldOutFor({ role: t.role, baseText, headText, stateDir: this.d.stateDir, model: judge, ask: runnerAsk(this.d.runner, (r) => this.cost(n, CASE_WRITER_COST_ROLE, r as RunResult), this.d.stateDir) }) : null;
        const c = await compareInstructions({ target: t.target, baseText, headText, cases, heldOut: held && 'cases' in held ? held.cases : null, model, judge, samples: cfg.samples, capUsd: cfg.cap_usd, ask });
        // Held-out cases go into the log by number only: their titles stay in the coordinator's store.
        const heldOut = c.heldOut ? { base: c.heldOut.base, result: c.heldOut.head, dropped: c.heldOut.dropped, incomplete: c.heldOut.incomplete, changes: c.heldOut.changes.map((x) => ({ ...x, title: '' })) } : null;
        record({ base: c.base, result: c.head, dropped: c.dropped, incomplete: c.incomplete, changes: c.changes, cost_usd: c.costUsd, samples: c.samples, ...(t.role ? { held_out: heldOut } : {}), ...(held && 'error' in held ? { held_out_error: held.error } : {}) });
      } catch (e) {
        if (e instanceof Halted) throw e;
        record({ ...none, error: (e as Error).message.slice(0, 500) });
      }
    }
  }

  /** Mechanical checks on what the worker produced, before anyone trusts it. */
  protected async inspect(n: number, path: string, base: string, head: string, repro: { path: string; hash: string } | null) {
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
    const prot = names.filter((f) => isProtectedPath(f, this.d.cfg.guardrails));
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
    // The size limit: over review.yaml max_pr_lines and not mechanical, sent back to be split (src/pr-rules.ts).
    const review = this.d.cfg.review ?? DEFAULT_REVIEW;
    const size = sizeVerdict(sizeFiles(path, base, head), { maxLines: review.max_pr_lines, generated: review.generated });
    if (!size.ok) return { rejected: `${size.why}. Make this change one self-contained part under ${review.max_pr_lines} lines, and say in your summary what is left for follow-up issues` };
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
    const added = files.reduce((s, f) => s + f.added, 0);
    const removed = files.reduce((s, f) => s + f.removed, 0);
    const patchHash = createHash('sha256').update(this.git(path, 'diff', `${base}..${head}`)).digest('hex');
    this.emit('change.proposed', { issue: n, branch: this.paths(n).branch, base, head, files: names, lines: added + removed, added, removed, patch_hash: patchHash });
    return { files, tampered, patchHash };
  }

  /** Browser baselines per (base, flow), kept across a task's attempts (src/coordinator/browser.ts). */
  private readonly browserBaselines = new Map<string, BaselineRun>();

  /** The coordinator's own run of the contract: it never trusts the agent's word. */
  protected async verify(n: number, path: string, head: string, doneWhen: DoneWhenList, repro: { path: string } | null) {
    const checks: { check: string; status: 'pass' | 'fail' | 'unavailable' | 'skipped'; exitCode: number | null; tail: string; duration_ms?: number; kind?: 'browser' }[] = [];
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
      // A person checks it: listed under NOT CHECKED in the PR's receipts, never run here.
      else if ('manual' in d) continue;
      // The frozen reproduction test, run below from `repro`.
      else if ('repro' in d) continue;
      // Run below with the UI-paths gate, which may add flows of its own (src/coordinator/browser.ts).
      else if ('browser' in d) continue;
      else {
        // A done_when kind without a branch here must not pass by being skipped: typecheck fails on a new kind
        // (d is never), and anything that reaches this at run time fails the attempt.
        const unknown: never = d;
        checks.push({ check: `done_when ${JSON.stringify(unknown).slice(0, 200)}`, status: 'fail', exitCode: null, tail: 'unknown done_when kind: the coordinator has no way to check it' });
      }
    }
    // Browser checks (src/coordinator/browser.ts), each flow judged against its run at the change's base.
    const change = changeAt(this.events(n), head);
    const out = join(this.d.stateDir, 'browser', `issue-${n}`);
    const runAs = this.d.commandsAs ? { runAs: this.d.commandsAs } : {};
    const app = this.d.cfg.app;
    const baseline = change && app ? (chrome: string) => worktreeBaseline({ wt: this.wt, name: `issue-${n}-browser-base`, base: change.base, app, cache: this.browserBaselines, outDir: join(out, `base-${change.base.slice(0, 12)}`), chrome, ...runAs }) : undefined;
    const browser = await browserChecks({ app, doneWhen, changed: change?.files ?? [], cwd: path, outDir: join(out, head.slice(0, 12)), ...(baseline ? { baseline } : {}), ...runAs });
    checks.push(...browser.checks);
    if (browser.lines.length) this.emit('browser.evidence', { issue: n, head, lines: browser.lines });
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

  protected async evaluate(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, head: string, patchHash: string, checks: { check: string; status: string }[], repro: { path: string } | null, tampered: string[], files: ChangeFile[], opts: { extra?: string[]; schema?: object } = {}) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.evaluator!;
    const changed = files.map((f) => f.path);
    const unverified = this.unverifiedClaims(n, checks);
    const extra = [
      `Base commit: ${base}. Head: ${head}. Inspect with: git diff ${base}..${head}`,
      `Reproduction test: ${repro?.path || 'none'}`,
      `Coordinator's check results: ${checks.map((c) => `${c.check}=${c.status}`).join(', ') || 'none'}`,
      ...(unverified.length ? [`NOT VERIFIED (the worker claimed these; no recorded command or check backs them, so they are not evidence): ${unverified.map((c) => `"${c}"`).join('; ')}`] : []),
      ...(tampered.length ? [`Tamper guard flags: ${tampered.join('; ')}`] : []),
      ...(opts.extra ?? []),
    ];
    type Out = { patch_correct?: boolean; test_correct?: boolean; confidence?: 'high' | 'medium' | 'low'; advice?: string; design_change?: boolean; design_reason?: string; both_sides_kept?: boolean } | undefined;
    // The model is chosen in code from the change's level; a cheap verdict that isn't a confident pass is judged
    // once more by the evaluator role's model. What the run read comes from its record, not from its own list.
    const judged = await judge({
      level: evalLevel({ files, labels: issue.labels, moneyPaths: () => loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source), review: this.d.cfg.review ?? DEFAULT_REVIEW, tampered }),
      strongModel: role.model,
      routing: evalRouting(this.d.cfg.agents),
      changed,
      stateDir: this.d.stateDir,
      verdictOf: (r) => (r.reason === 'succeeded' && r.structured ? { patch_correct: (r.structured as Out)?.patch_correct === true, confidence: (r.structured as Out)?.confidence ?? 'low' } : null),
      run: async (model, costRole) => {
        // Research the evaluator asked for instead of guessing: answered, then it judges again with the answer.
        let brief = extra;
        for (let researched = 0; ; researched++) {
          let runId: string | null = null;
          const r = await this.d.runner.run({
            env: this.projectEnv(),
            role: 'evaluator-verdict',
            stateDir: this.d.stateDir,
            prompt: issueBrief(issue, doneWhen, brief),
            appendSystemPrompt: rolePrompt(this.d.cfg, 'evaluator-verdict'),
            cwd: path,
            model,
            allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
            disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
            maxTurns: 60,
            maxBudgetUsd: role.budget_usd ?? 5,
            jsonSchema: opts.schema ?? VERDICT_SCHEMA,
            stallMs: 15 * 60_000,
            timeoutMs: this.commandTimeoutMs,
            onControl: (c) => void (runId = c.runId),
          });
          this.cost(n, costRole, r);
          const asked = r.reason === 'succeeded' ? (r.structured as { research_request?: unknown } | undefined)?.research_request : undefined;
          if (!asked || researched >= MAX_REQUESTS_PER_TASK) return { r, runId };
          brief = [...brief, '', await this.answerResearch(issue, asked, path, 'evaluator')];
        }
      },
    });
    const r = judged.r;
    const s = r.structured as Out;
    // A review that didn't read every changed file can't pass on its own: those files go to a human.
    const unread = judged.unread;
    // No verdict is a failed verdict, never a pass.
    // An unbacked claim lowers the confidence whatever the evaluator said: it is never evidence.
    const v = {
      patch_correct: r.reason === 'succeeded' && s?.patch_correct === true,
      test_correct: r.reason === 'succeeded' && s?.test_correct !== false,
      confidence: lowerConfidence((r.reason === 'succeeded' && s?.confidence) || 'low', unverified.length),
      advice: r.reason === 'succeeded' ? (s?.advice ?? '') : `evaluator run ${r.reason}: ${r.detail}`,
      ...(unverified.length ? { unverified_claims: unverified } : {}),
    } as const;
    if (this.git(path, 'rev-parse', 'HEAD') !== head) throw new Error('the worktree moved during evaluation; the verdict would not match the patch');
    const design = r.reason === 'succeeded' && typeof s?.design_change === 'boolean' ? { design_change: s.design_change, ...(s.design_reason ? { design_reason: s.design_reason.slice(0, 500) } : {}) } : {};
    this.emit('eval.verdict', { issue: n, head, patch_hash: patchHash, ...v, ...(unread.length ? { unread } : {}), ...design, model: judged.model, ...(judged.escalatedFrom ? { escalated_from: judged.escalatedFrom } : {}) });
    return { ...v, unread, bothSidesKept: r.reason === 'succeeded' && typeof s?.both_sides_kept === 'boolean' ? s.both_sides_kept : null };
  }

  /**
   * The latest worker's claims that no record backs: not the coordinator's passing checks, nor a command the
   * worker's last run recorded as succeeding.
   */
  private unverifiedClaims(n: number, checks: { check: string; status: string }[]): string[] {
    const claims = (this.events(n).filter((e) => e.type === 'worker.claims').at(-1)?.payload as EventPayload<'worker.claims'> | undefined)?.claims ?? [];
    if (!claims.length) return [];
    const run = this.d.stateDir ? runsForIssue(this.d.stateDir, n).filter((r) => r.role === 'worker').at(-1) : undefined;
    const steps = run ? (readRun(this.d.stateDir!, run.id)?.steps ?? []) : [];
    const commands = steps.filter((st) => st.kind === 'command' && st.status === 'ok').map((st) => st.what);
    return unbackedClaims(claims, { checks: checks as CheckRecord[], commands });
  }

  // ---------------------------------------------------------------- combined-state check

  /**
   * Whether a PR the policy would merge can merge as is: yes when the combined-state check is off, the default
   * branch hasn't moved since the PR branched, or its new commits touch nothing the PR touches or imports.
   * Otherwise the result of the check on that exact head and branch tip (started in the background if there is
   * none yet: 'pending'). The PR is never changed: a pass merges the unchanged head that already passed CI.
   */
  protected async combinedGate(w: EventPayload<'pr.opened'>, pr: PullRequest): Promise<'merge' | 'pending' | 'conflict' | { hold: string }> {
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
    if (done?.outcome === 'conflict') return 'conflict'; // GitHub should report it next, and the conflict path take it (capped in mergeOrWait)
    if (!this.lightRunning.has(number) && !this.active.has(w.issue)) {
      // Debounced: a burst of moves of main checks at most twice, then the newest main once the window allows.
      const wait = lightCheckWait(this.d.log.read(0, ['light_check.started']).filter((e) => (e.payload as { number: number }).number === number).map((e) => Date.parse(e.ts)), Date.now());
      if (wait > 0) {
        this.prPolled.set(number, Date.now() - (this.d.prPollMs ?? 60_000) + wait);
        return 'pending';
      }
      this.lightRunning.add(number);
      void this.lightCheck(w, pr, baseRef, mainSha, plan.overlap)
        .catch((e: Error) => this.emit('coordinator.error', { instance: this.d.instance, where: `combined check #${number}`, kind: 'error', message: e.message.slice(0, 500) }))
        .finally(() => this.lightRunning.delete(number));
    }
    return 'pending';
  }
}
