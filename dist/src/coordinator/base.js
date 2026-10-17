import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BRAND } from '../brand.js';
import { release } from '../claims.js';
import { settleRecommendation } from '../decision-ask.js';
import { agentReadableDir, cpuCount, diskFree, groupOnlyDir, machineLoad, writeAgentReadable, writeGroupOnly } from '../os/index.js';
import { currentCoreShare, envWithCores, withCores } from '../cores.js';
import { DEFAULT_COMMIT_IDENTITY } from '../runner.js';
import { writeLive } from '../console.js';
import { allowedOnce } from '../domain-requests.js';
import { runIssue } from '../run-record.js';
import { emergencyStop, slotStatus } from '../slots.js';
import { updateDrain } from '../update-drain.js';
import { diskHold, diskRoom } from '../governor-holds.js';
import { localDay, nextLocalMidnight } from '../local-day.js';
import { removeWorktree } from '../worktrees.js';
import { prepareDepCache } from '../dep-cache.js';
import { stuckMode } from '../settings.js';
import { stuckOption } from './stuck-guard.js';
import { LOCK_WAIT_RECORDED_MS, RETRY_CAP, sh, StoppedByOwner, Halted, ShuttingDown, UsagePaused, AuthPaused } from './shared.js';
import { AUTH_CHECK, AUTH_OWNER_RECHECK_MS, AUTH_RECHECK_MS, authHoldsOf, authIncidentKey, authIncidentText, DEFAULT_LOGIN_KEY } from '../claude-auth-failure.js';
import { takeAuthRecheck } from '../claude-auth-recheck.js';
import { limitHit, pauseOf, resetWords, USAGE_INCIDENT } from '../usage-limit.js';
import { cappedModel } from './model-routing.js';
import { resolveProvider } from './providers.js';
import { providerCost, providerOf } from '../providers.js';
export class CoordinatorBase {
    d;
    remote;
    /** Where task worktrees go and how they're set up; the project's env is filled in when each one is made. */
    wtBase;
    get wt() {
        const cacheEnv = this.depCacheEnv();
        // The setup steps as the config now says (it follows the default branch); the root is fixed at start.
        return { ...this.wtBase, setup: this.d.cfg.tests.worktree.setup, env: this.projectEnv(), sparseExclude: this.d.cfg.tests.checkout.sparse_exclude, ...(cacheEnv ? { cacheEnv } : {}) };
    }
    active = new Map();
    fileIx = null;
    /** The default branch's tip as last seen, and when it was last checked. */
    defaultTip = '';
    tipCheckedAt = 0;
    /** PRs whose combined-state check is running. */
    lightRunning = new Set();
    /** When each watched PR was last polled (ms). */
    prPolled = new Map();
    /** Live runs, for the console. */
    live = new Map();
    /** Chat turns, one at a time. */
    chatQueue = Promise.resolve();
    /** Intake passes, one at a time. */
    intakeQueue = Promise.resolve();
    intakeRunning = false;
    intakePulledAt = -Infinity;
    /** The repo's own config, as the default branch has it (src/config/live.ts): the defaults the instance's settings apply over. */
    repoCfg;
    settingsKey = '';
    /** When each auto-merge's commit on the default branch was last polled (ms). */
    mainPolled = new Map();
    landing = false;
    stopped = false;
    /** Aborted by an emergency stop, and by a shutdown: every agent run gets this signal. */
    halt = new AbortController();
    /** Aborted once, by a shutdown (stop()): project commands get this signal, and the emergency check never lifts it. */
    shutdown = new AbortController();
    /** The tick step running now (stop() names it when the shutdown runs out of time). */
    inStep = null;
    /** Why a run stops now: the shutdown, or an emergency stop. */
    haltError() {
        return this.stopped ? new ShuttingDown() : new Halted();
    }
    /**
     * INVARIANT: while the test sandbox's check is failing (PrTestRuns.ready, src/testrun/sandbox-watch.ts), the test-run
     * service and the deploy gate are as absent as they were when a failed check meant none was set up: batches wait, a
     * red main is not re-run through it, the deploy branch doesn't move. Only the PRs' own runs go to the service then,
     * to be refused with a check that says test runs are off. Read at each use: they go on when the check passes.
     */
    get liveTestRuns() {
        return this.d.prTestRuns?.ready() === false ? null : (this.d.testRuns ?? null);
    }
    get liveDeployGate() {
        return this.d.prTestRuns?.ready() === false ? undefined : this.d.deployGate;
    }
    /** Open-model providers that hit their usage or rate limit, by label: skipped (their runs fall back) until then (ms). */
    providerLimited = new Map();
    /** The runner under the wrapper below: only the held-login check calls it directly (it must run while the login is held). */
    claudeRunner;
    constructor(d) {
        this.d = d;
        // Every agent run carries the halt signal; a run after a halt never starts.
        const runner = d.runner;
        this.claudeRunner = runner;
        this.d = {
            ...d,
            runner: {
                run: async (asked) => {
                    if (this.halt.signal.aborted)
                        throw this.haltError();
                    // A model that names an open-model provider goes to it, or to its fallback (recorded); then the instance's
                    // model cap holds for every run on an Anthropic model, whatever chose it.
                    const settings = this.d.settings?.().settings ?? {};
                    const limited = (label) => {
                        const until = this.providerLimited.get(label);
                        return until !== undefined && until > this.nowMs() ? new Date(until).toISOString() : null;
                    };
                    const routed = await resolveProvider(asked, { cfg: this.d.cfg, settings, stateDir: this.d.stateDir, limited, ...(this.d.providerKeys ? { providerKeys: this.d.providerKeys } : {}) });
                    // A run that must be on its provider or not at all (the cross-family evaluator): not run, saying why.
                    if (routed.fellBack && asked.route?.noFallback)
                        return { reason: 'failed', detail: `not run: ${routed.fellBack.reason}`, costUsd: 0, turns: 0, model: asked.model };
                    if (routed.fellBack)
                        this.emit('provider.fallback', { issue: asked.issue ?? runIssue(asked.cwd, asked.taskFile), role: asked.role, provider: routed.fellBack.provider, reason: routed.fellBack.reason.slice(0, 500), model: routed.req.model });
                    const req = routed.req.provider ? routed.req : { ...routed.req, model: cappedModel(routed.req.model, settings) };
                    // Paused on the Claude usage limit: no run on Anthropic starts until its reset (src/usage-limit.ts).
                    const pause = req.provider ? null : this.usagePause();
                    if (pause)
                        throw new UsagePaused(pause.resetAt);
                    // A Claude login the API refused: no run on it starts until a call on it succeeds (src/claude-auth-failure.ts).
                    const loginKey = req.provider ? null : this.loginKeyOf(req);
                    const held = loginKey === null ? null : this.authHold(loginKey);
                    if (held)
                        throw new AuthPaused(held.login, held.detail);
                    const startedMs = this.nowMs();
                    // Waits on the Claude login and transient retries are recorded for every run, with its issue and role.
                    const who = { issue: req.issue ?? runIssue(req.cwd, req.taskFile), role: req.role, model: req.model };
                    // The console holds every live run's input: listed for the dashboard while it runs.
                    const live = { key: randomBytes(4).toString('hex'), run: null, control: null, issue: who.issue, role: req.role, model: req.model, startedAt: new Date().toISOString(), pending: [], stoppedBy: null };
                    this.live.set(live.key, live);
                    // Hosts the owner allowed once for this task reach its next build run (worker, CI fix, conflict fix) only.
                    const once = who.issue !== null && req.role === 'worker' ? allowedOnce(this.d.log.read(0, ['network.domain_decided', 'run.started']), who.issue) : [];
                    let r;
                    try {
                        r = await runner.run({
                            ...req,
                            ...(once.length ? { allowOnce: [...new Set([...(req.allowOnce ?? []), ...once])] } : {}),
                            // The stuck-run guard on the worker and evaluators, in the instance's mode (dry-run unless the owner turned it on).
                            ...stuckOption(req, stuckMode(this.d.settings?.().settings ?? {}), who, () => live.run, (p) => this.emit('run.stuck', p)),
                            signal: req.signal ?? this.halt.signal,
                            onLockWait: (ms) => {
                                if (ms >= LOCK_WAIT_RECORDED_MS)
                                    this.emit('run.lock_waited', { ...who, wait_ms: Math.round(ms) });
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
                    }
                    finally {
                        this.live.delete(live.key);
                        this.writeLive();
                    }
                    // A host the run was refused becomes the owner's decision (once per task and host); nothing is widened here.
                    if (r.refusedHosts?.length && who.issue !== null) {
                        try {
                            await this.noteRefusedHosts(who.issue, req.role, live.run, r.refusedHosts);
                        }
                        catch (e) {
                            this.emit('coordinator.error', { instance: this.d.instance, where: `domain request #${who.issue}`, kind: e.kind ?? 'error', message: e.message.slice(0, 500) });
                        }
                    }
                    if (live.stoppedBy)
                        throw new StoppedByOwner(live.stoppedBy);
                    if (this.halt.signal.aborted)
                        throw this.haltError();
                    if (r.reason === 'rate_limited') {
                        const hit = r.limit ?? limitHit({ text: r.detail, now: this.nowMs() });
                        this.emit('usage.limit_hit', { ...who, provider: req.provider?.name ?? null, reset_at: hit.resetAt, source: hit.source, kind: hit.kind, detail: r.detail.slice(0, 500) });
                        // An open-model provider's limit is its own: it is skipped until its reset, and this run is redone at
                        // once on its fallback (the role's normal model). Never a pause, and never retried on the provider.
                        if (req.provider) {
                            this.providerLimited.set(req.provider.name, Date.parse(hit.resetAt));
                            if (asked.route?.noFallback)
                                return { ...r, reason: 'failed', detail: `not run: ${req.provider.name} hit its usage or rate limit; skipped until ${hit.resetAt}` };
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
                    if (loginKey !== null && r.reason === 'succeeded')
                        this.loginWorks(loginKey, 'run', req.role, startedMs);
                    return r;
                },
            },
        };
        this.repoCfg = d.cfg;
        this.remote = d.remote ?? 'origin';
        this.wtBase = { repo: d.repo, root: d.cfg.tests.worktree.root, stateDir: d.stateDir, setup: d.cfg.tests.worktree.setup, env: d.cfg.tests.env, ...(d.commandsAs ? { runAs: d.commandsAs } : {}) };
    }
    /** This task's share of the machine's cores right now: the cores over the agents running (cores.ts). */
    coreShare() {
        return currentCoreShare(this.d.cfg.tests.cores, this.d.slotsDir);
    }
    /** The project's env (tests.yaml env) as a command or session starting now gets it: `{cores}` filled in. */
    projectEnv() {
        return envWithCores(this.d.cfg.tests.env, this.coreShare());
    }
    /** A project command (check, gate, pre-land step): it runs agent-written code, so it runs as the agent user. */
    project(command, cwd) {
        const share = this.coreShare();
        return sh(withCores(command, share), cwd, this.commandTimeoutMs, this.d.commandsAs, envWithCores(this.d.cfg.tests.env, share), this.shutdown.signal);
    }
    /** How long a project command or an agent run may take (tests.yaml command_timeout_s). */
    get commandTimeoutMs() {
        return this.d.cfg.tests.command_timeout_s * 1000;
    }
    get branch() {
        return this.d.cfg.project.project.default_branch;
    }
    /** What every push checks: the default branch is never pushed (only the direct land passes `directLand`); a refusal is recorded. */
    pushGuard(directLand = false) {
        return { defaultBranch: this.branch, directLand, blocked: (ref, head) => this.emit('push.blocked', { ref, head, via: 'coordinator' }) };
    }
    git(cwd, ...args) {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    }
    emit(type, payload) {
        return this.d.log.append(type, payload, this.d.instance);
    }
    events(issue) {
        const all = this.d.log.read();
        return issue === undefined ? all : all.filter((e) => e.payload.issue === issue);
    }
    lastSeen(issue) {
        return this.d.log
            .read(0, ['issue.seen'])
            .filter((e) => e.payload.issue === issue)
            .at(-1)?.payload;
    }
    /** USD spent today (this machine's local day, as the dashboard shows it: src/local-day.ts) by all runs, from the log. */
    spentToday() {
        const day = localDay();
        return this.d.log.read(0, ['run.cost']).filter((e) => localDay(e.ts) === day).reduce((s, e) => s + e.payload.usd, 0);
    }
    /** An emergency stop is in force (read now, not only at the last check): nothing lands and nothing merges. */
    emergencyInForce() {
        return this.halt.signal.aborted || emergencyStop(this.d.slotsDir) !== null;
    }
    lastHold = null;
    /** Why no new agent may start right now, or null. Load and disk are machine-wide. Each hold carries its numbers (src/governor-holds.ts). */
    governorHold() {
        const m = this.d.machine ?? { load: machineLoad, disk: diskFree };
        const load = m.load();
        const disk = m.disk(this.d.repo);
        const est = this.d.cfg.tests.worktree.est_size_gb;
        const maxLoad = this.d.cfg.project.governor.max_load ?? cpuCount() * 2;
        const budget = this.d.cfg.agents.daily_budget_usd;
        const spent = this.spentToday();
        if (spent >= budget)
            return { kind: 'budget', reason: `daily budget $${budget} reached`, load, freeDiskPct: disk.freePct, facts: { spent_usd: spent, budget_usd: budget, until: nextLocalMidnight().toISOString() } }; // spentToday's day: local, by the wall clock
        if (load !== null && load > maxLoad)
            return { kind: 'load', reason: `machine load ${load.toFixed(0)} > ${maxLoad}`, load, freeDiskPct: disk.freePct, facts: { load, max_load: maxLoad } };
        // WHY: the floor is the larger of an absolute GB and a share of the disk (#470), not a flat share.
        const room = diskRoom({ freeGb: disk.freeGb ?? (disk.freePct / 100) * disk.totalGb, totalGb: disk.totalGb }, this.d.cfg.project.governor, est);
        return diskHold(room, this.d.cfg.project.governor, load);
    }
    /** The hold when no agent slot is free: the updater's drain, or the machine-wide cap with its numbers. */
    slotHold() {
        if (updateDrain(this.d.slotsDir))
            return { kind: 'update_drain', reason: 'draining for an engine update: no new agent starts until it is installed', load: null, freeDiskPct: null };
        const s = slotStatus(this.d.slotsDir);
        return { kind: 'slots', reason: 'machine-wide agent cap reached (all harnesses)', load: null, freeDiskPct: null, facts: { cap: s.cap, running: s.agents.length } };
    }
    /** The coordinator's clock, in ms (tests set `now`). */
    nowMs() {
        return (this.d.now?.() ?? new Date()).getTime();
    }
    /**
     * Why no new work may start now: the disk is full (the event log's writes wait in memory) or below its floor
     * (src/disk-guard.ts). Every place that holds on the usage pause holds on this too; runs in flight go on.
     */
    diskHeld() {
        return this.d.disk?.held() ?? null;
    }
    /** The usage-limit pause in force (src/usage-limit.ts), from the log, or null. */
    usagePause() {
        return pauseOf(this.d.log.read(0, ['usage.paused', 'usage.resumed']));
    }
    /** The Claude login a run would use: the runner's own answer (its config dir), else the one login there is. */
    loginKeyOf(req) {
        return this.claudeRunner.loginOf?.(req) ?? DEFAULT_LOGIN_KEY;
    }
    /** Every Claude login held now (src/claude-auth-failure.ts), from the log. */
    authHolds() {
        return authHoldsOf(this.d.log.read(0, ['claude_auth.failed', 'claude_auth.checked', 'claude_auth.recovered']));
    }
    authHold(key) {
        return this.authHolds().find((h) => h.key === key) ?? null;
    }
    /**
     * A held login, if any: nothing new is dispatched while one is (a task's runs span the instance's logins, its
     * worker's and its evaluator's), and nothing that runs on its own (research, fix runs, evals) starts.
     */
    authHeld() {
        return this.authHolds()[0] ?? null;
    }
    /** A run's login was refused: it is held (once; a second refusal while held keeps the hold), and the red incident raised. */
    holdLogin(key, req, who, r) {
        const was = this.authHold(key);
        const login = r.login?.account ?? was?.login ?? (key === DEFAULT_LOGIN_KEY ? "this instance's Claude login" : `the Claude login in ${key}`);
        this.emit('claude_auth.failed', { key, login, lane: req.lane ?? 'default', issue: who.issue, role: who.role, detail: r.detail.slice(0, 1000) });
        const h = this.authHold(key);
        if (!was) {
            const t = authIncidentText(this.authHolds());
            this.d.incidents?.raiseIncident('claude_auth', authIncidentKey(this.d.instance), t.detail, t.fix);
        }
        return h;
    }
    /** A call on a held login succeeded (a run that started after the hold began, or the check): the hold ends. */
    loginWorks(key, via, role, startedMs) {
        const h = this.authHold(key);
        if (!h || Date.parse(h.since) > startedMs)
            return;
        this.emit('claude_auth.recovered', { key, login: h.login, via, role, held_ms: Math.max(0, Math.round(this.nowMs() - Date.parse(h.since))), hold_id: h.id });
        if (!this.authHolds().length)
            this.d.incidents?.resolveIncident('claude_auth', authIncidentKey(this.d.instance));
    }
    /** When the owner's last re-check was taken (ms): one a minute at most. */
    ownerRecheckAt = -Infinity;
    /**
     * The way out of a held login (no run may start on it, so no run can succeed to end the hold): one tiny real call
     * on it, as its own user, at most every AUTH_RECHECK_MS; at once after an account switch, and on the owner's
     * re-check from the dashboard (one a minute at most). A refused call costs nothing; one that is answered ends the hold.
     */
    async checkHeldLogins() {
        const asked = takeAuthRecheck(this.d.stateDir);
        if (this.stopped || this.halt.signal.aborted)
            return 0;
        const holds = this.authHolds();
        if (!holds.length)
            return 0;
        const now = this.nowMs();
        const owner = asked !== null && now - this.ownerRecheckAt >= AUTH_OWNER_RECHECK_MS;
        if (owner)
            this.ownerRecheckAt = now;
        const switched = this.d.accountSwitched?.() ?? null;
        let checked = 0;
        for (const h of holds) {
            const last = h.lastCheck ? Date.parse(h.lastCheck.at) : Date.parse(h.since);
            const by = owner ? 'owner' : switched !== null && Date.parse(switched) > last ? 'account_switch' : now - last >= AUTH_RECHECK_MS ? 'timer' : null;
            if (!by)
                continue;
            await this.checkLogin(h, by);
            checked++;
        }
        return checked;
    }
    async checkLogin(h, by) {
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
        if (ok)
            this.loginWorks(h.key, 'check', 'login-check', startedMs);
    }
    /** Pause on a usage-limit hit: once (a hit while paused changes nothing), with the incident raised when there's a watchdog. */
    pauseOnLimit(hit, who, detail) {
        if (this.usagePause())
            return;
        this.emit('usage.paused', { reset_at: hit.resetAt, source: hit.source, kind: hit.kind, issue: who.issue, role: who.role, detail: detail.slice(0, 500) });
        const when = resetWords(hit.resetAt, this.nowMs());
        this.d.incidents?.raiseIncident(USAGE_INCIDENT, this.d.instance, `Claude usage limit reached; no new runs until ${when}${hit.source === 'default' ? " (claude gave no reset time: the default wait)" : ''}`, 'Nothing to do: it resumes on its own at the reset. To resume sooner, switch the Claude account.');
    }
    /**
     * The pause ends, and the next dispatch starts runs again: at its reset time, or once a Claude account switch put
     * this instance on a new login after it began (the old account's limit no longer applies).
     */
    resumeIfDue() {
        const p = this.usagePause();
        if (!p)
            return false;
        const switched = this.d.accountSwitched?.() ?? null;
        const reason = Date.parse(p.resetAt) <= this.nowMs() ? 'reset' : switched !== null && Date.parse(switched) >= Date.parse(p.since) ? 'account switched' : null;
        if (!reason)
            return false;
        this.emit('usage.resumed', { reset_at: p.resetAt, paused_ms: Math.max(0, Math.round(this.nowMs() - Date.parse(p.since))), reason });
        this.d.incidents?.resolveIncident(USAGE_INCIDENT, this.d.instance);
        return true;
    }
    noteHold(h) {
        const key = h?.reason.replace(/[\d.]+/g, '#') ?? null; // record changes of reason, not every reading
        if (key === this.lastHold)
            return;
        this.lastHold = key;
        if (h)
            this.emit('governor.hold', { reason: h.reason, load: h.load, free_disk_pct: h.freeDiskPct, kind: h.kind, ...(h.facts ? { facts: h.facts } : {}) });
        else
            this.emit('governor.release', { load: (this.d.machine?.load ?? machineLoad)(), free_disk_pct: null });
    }
    /**
     * The instance's settings (policy.yaml), re-read every tick: when they change, the repo's config with
     * them applied becomes the config in effect, without a restart. Refused settings: the repo's values.
     */
    /** The live runs list the dashboard reads (only runs whose session is up: they have an id). */
    writeLive() {
        writeLive(this.d.stateDir, [...this.live.values()].filter((l) => l.run).map((l) => ({ run: l.run, issue: l.issue, role: l.role, model: l.model, startedAt: l.startedAt, pending: l.pending })));
    }
    // ---------------------------------------------------------------- task pipeline
    paths(issue) {
        return { name: this.pooledName(issue) ?? `issue-${issue}`, branch: `${BRAND.cli}/issue-${issue}`, taskFile: join(this.d.agentTasks?.dir ?? join(this.d.stateDir, 'tasks'), `issue-${issue}.json`) };
    }
    /** The pooled worktree this claim of the issue runs in, if it took one (recorded, so a restart still finds it). */
    pooledName(issue) {
        const ev = this.events(issue);
        const claim = ev.map((e) => e.type).lastIndexOf('issue.claimed');
        const p = ev.slice(claim + 1).filter((e) => e.type === 'worktree.pooled').at(-1);
        return p ? String(p.payload.name) : null;
    }
    /**
     * The instance's dependency cache (pip, uv, npm, pnpm, yarn) for worktree setup: only for an instance whose
     * agents run as their own user (the cache lives beside its checkout), and when the project keeps it on.
     * Not for agent sessions: their sandbox writes only inside the worktree, so a cache outside it fails there.
     */
    depCacheEnv() {
        const root = this.d.depCacheRoot;
        if (!root || !this.d.cfg.tests.worktree.dep_cache)
            return undefined;
        if (this.cacheEnv === undefined) {
            try {
                this.cacheEnv = prepareDepCache(root.dir, root.gid).env;
            }
            catch (e) {
                this.emit('coordinator.error', { instance: this.d.instance, where: 'dep-cache', kind: 'error', message: e.message.slice(0, 500) });
                this.cacheEnv = null;
            }
        }
        return this.cacheEnv ?? undefined;
    }
    cacheEnv;
    get identity() {
        return this.d.commitIdentity ?? DEFAULT_COMMIT_IDENTITY;
    }
    /** The latest eval of each instruction target for an issue. */
    instructionResults(n) {
        const latest = new Map();
        for (const e of this.events(n))
            if (e.type === 'instructions.eval')
                latest.set(e.payload.target, e.payload);
        return [...latest.values()];
    }
    /** Each file the change base..head touches, with its line counts and added and removed lines (for content checks). */
    changeFiles(cwd, base, head) {
        return this.git(cwd, 'diff', '--numstat', `${base}..${head}`)
            .split('\n')
            .filter(Boolean)
            .map((l) => {
            const [a, r, p] = l.split('\t');
            const diff = this.git(cwd, 'diff', '-U0', `${base}..${head}`, '--', p).split('\n');
            const added = diff.filter((x) => x.startsWith('+') && !x.startsWith('+++')).map((x) => x.slice(1));
            const removed = diff.filter((x) => x.startsWith('-') && !x.startsWith('---')).map((x) => x.slice(1));
            return { path: p, added: Number(a) || 0, removed: Number(r) || 0, addedLines: added, removedLines: removed };
        });
    }
    /**
     * The task file the agent's hook reads (its frozen paths): readable by the agent user, never writable by it,
     * so an agent can neither lose its guard nor rewrite it. The hook refuses every tool call if it can't read it.
     */
    writeTask(file, task) {
        const at = this.d.agentTasks;
        if (at) {
            agentReadableDir(at.dir, at.gid);
            writeAgentReadable(file, JSON.stringify(task), at.gid);
        }
        else {
            groupOnlyDir(dirname(file));
            writeGroupOnly(file, JSON.stringify(task));
        }
    }
    cost(issue, role, r) {
        this.emit('run.cost', { issue, role, ...this.usage(r) });
    }
    /**
     * A run's usage for run.cost: its model, turns, tokens and seconds, and its estimated cost. On an open-model
     * provider that is the provider's price (src/providers.ts): local runs cost nothing, a hosted one without prices
     * configured counts as 0 and says which provider it was.
     */
    usage(r) {
        const named = r.provider ? providerOf(r.provider) : null;
        const p = named ? (named.kind === 'local' ? this.d.cfg.agents.providers?.local : named.kind === 'cli' ? this.d.cfg.agents.providers?.cli?.[named.name] : this.d.cfg.agents.providers?.hosted?.[named.name]) : undefined;
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
    ownerOf(issue) {
        const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
        return c?.payload?.owner ?? this.d.cfg.project.owners.default;
    }
    async ask(kind, issue, owner, question, options, recommended, detail, context) {
        const id = `d-${issue ?? kind}-${randomBytes(3).toString('hex')}`;
        // The recommendation is one of the options or nothing: prose (an agent's reasoning) moves into the detail.
        const { recommendation, receipts } = settleRecommendation(options, recommended, detail);
        // What it rests on (src/decision-context.ts), for the dashboard's detail view: never a viewer's (src/viewer-events.ts).
        this.emit('decision.asked', { id, kind, issue, owner, question, options, recommendation, receipts, ...(context ? { context } : {}) });
        if (issue === null)
            return id; // not tied to an issue: answered from the dashboard or CLI
        await this.d.backlog.addLabels(issue, ['needs:decision']);
        await this.d.backlog.comment(issue, `[${BRAND.cli}] @${owner} decision needed: **${question}**\n\nOptions: ${options.join(' / ')}.${recommendation ? ` Recommendation: **${recommendation}**.` : ''}\n\n${receipts.map((r) => `- ${r}`).join('\n')}\n\nReply \`/${BRAND.cli} ${options.join('` or `/' + BRAND.cli + ' ')}\` (owner or a writer), or run \`${BRAND.cli} decide ${id} <option>\`.`);
        return id;
    }
    /** `retry`: a rate-limit or budget block that retries on its own after `after` (up to RETRY_CAP times). */
    async block(issue, owner, why, release_ = true, retry) {
        this.emit('issue.blocked', { issue, owner, why: why.slice(0, 1000), ...(retry ? { retry_after: retry.after.toISOString(), retry_kind: retry.kind } : {}) });
        await this.d.backlog.addLabels(issue, ['blocked']);
        await this.d.backlog.removeLabel(issue, 'agent:working');
        const when = retry ? ` It retries on its own after ${retry.after.toISOString()} (at most ${RETRY_CAP} times), or label it \`ready\` again sooner.` : '';
        await this.d.backlog.comment(issue, `[${BRAND.cli}] @${owner} blocked: ${why}${when}`);
        if (release_)
            this.releaseClaim(issue, why);
    }
    releaseClaim(issue, why) {
        const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
        const lease = c?.payload?.lease;
        if (lease)
            release(issue, lease, { repo: this.d.repo, remote: this.remote });
        this.emit('issue.released', { issue, instance: this.d.instance, why });
        try {
            removeWorktree(this.wt, this.paths(issue).name);
        }
        catch {
            // not ours or already gone
        }
    }
}
//# sourceMappingURL=base.js.map