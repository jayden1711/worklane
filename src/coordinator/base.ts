// The coordinator's state and the helpers every part uses: its fields and constructor (the runner wrapper),
// events, git, project commands, paths and task files, the governor, cost, asking, blocking and releasing.
import type { Coordinator } from '../coordinator.js';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BRAND } from '../brand.js';
import type { Config } from '../config/load.js';
import { claim, release } from '../claims.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { agentReadableDir, cpuCount, diskFree, groupOnlyDir, machineLoad, writeAgentReadable, writeGroupOnly } from '../os/index.js';
import { currentCoreShare, envWithCores, withCores } from '../cores.js';
import { type ChangeFile } from '../review.js';
import { DEFAULT_COMMIT_IDENTITY, type CommitIdentity, type RunResult } from '../runner.js';
import { writeLive } from '../console.js';
import { allowedOnce } from '../domain-requests.js';
import { type FileIndex } from '../hotspots.js';
import { runIssue } from '../run-record.js';
import { emergencyStop } from '../slots.js';
import { removeWorktree, type WorktreeOptions } from '../worktrees.js';
import { prepareDepCache } from '../dep-cache.js';
import { seen } from '../intake/store.js';
import { stuckMode } from '../settings.js';
import { stuckOption } from './stuck-guard.js';
import { type CoordinatorDeps, LOCK_WAIT_RECORDED_MS, RETRY_CAP, sh, StoppedByOwner, type LiveEntry, Halted } from './shared.js';
import { cappedModel } from './model-routing.js';

export abstract class CoordinatorBase {
  /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
  protected abstract noteRefusedHosts(...args: Parameters<Coordinator['noteRefusedHosts']>): ReturnType<Coordinator['noteRefusedHosts']>;

  protected readonly remote: string;

  /** Where task worktrees go and how they're set up; the project's env is filled in when each one is made. */
  private readonly wtBase: WorktreeOptions;

  protected get wt(): WorktreeOptions {
    const cacheEnv = this.depCacheEnv();
    return { ...this.wtBase, env: this.projectEnv(), ...(cacheEnv ? { cacheEnv } : {}) };
  }

  protected active = new Map<number, Promise<void>>();

  /** The hotspot files each running task is expected to change. */
  protected taskHotspots = new Map<number, string[]>();

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

  /** The repo's own config: the defaults the instance's settings apply over. */
  protected readonly repoCfg: Config;

  protected settingsKey = '';

  /** When each auto-merge's commit on the default branch was last polled (ms). */
  protected mainPolled = new Map<string, number>();

  protected landing = false;

  protected stopped = false;

  /** Aborted by an emergency stop: every agent run gets this signal. */
  protected halt = new AbortController();

  constructor(protected d: CoordinatorDeps) {
    // Every agent run carries the halt signal; a run after a halt never starts.
    const runner = d.runner;
    this.d = {
      ...d,
      runner: {
        run: async (asked) => {
          if (this.halt.signal.aborted) throw new Halted();
          // The instance's model cap holds for every run, whatever chose its model.
          const req = { ...asked, model: cappedModel(asked.model, this.d.settings?.().settings) };
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
          if (this.halt.signal.aborted) throw new Halted();
          return r;
        },
      },
    };
    this.repoCfg = d.cfg;
    this.remote = d.remote ?? 'origin';
    this.wtBase = { repo: d.repo, root: d.cfg.tests.worktree.root, stateDir: d.stateDir, setup: d.cfg.tests.worktree.setup, env: d.cfg.tests.env, ...(d.commandsAs ? { runAs: d.commandsAs } : {}) };
  }

  /** This task's share of the machine's cores right now: the cores over the agents running (cores.ts). */
  private coreShare(): number {
    return currentCoreShare(this.d.cfg.tests.cores, this.d.slotsDir);
  }

  /** The project's env (tests.yaml env) as a command or session starting now gets it: `{cores}` filled in. */
  protected projectEnv(): Record<string, string> {
    return envWithCores(this.d.cfg.tests.env, this.coreShare());
  }

  /** A project command (check, gate, pre-land step): it runs agent-written code, so it runs as the agent user. */
  protected project(command: string, cwd: string) {
    const share = this.coreShare();
    return sh(withCores(command, share), cwd, this.commandTimeoutMs, this.d.commandsAs, envWithCores(this.d.cfg.tests.env, share));
  }

  /** How long a project command or an agent run may take (tests.yaml command_timeout_s). */
  protected get commandTimeoutMs(): number {
    return this.d.cfg.tests.command_timeout_s * 1000;
  }

  protected get branch() {
    return this.d.cfg.project.project.default_branch;
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

  /** USD spent today (UTC) by all runs, from the log. */
  spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    return this.d.log.read(0, ['run.cost']).filter((e) => e.ts.startsWith(day)).reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
  }

  /** An emergency stop is in force (read now, not only at the last check): nothing lands and nothing merges. */
  protected emergencyInForce(): boolean {
    return this.halt.signal.aborted || emergencyStop(this.d.slotsDir) !== null;
  }

  private lastHold: string | null = null;

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

  protected noteHold(h: ReturnType<CoordinatorBase['governorHold']>) {
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

  /** Each file the change base..head touches, with its line counts and added and removed lines (for content checks). */
  protected changeFiles(cwd: string, base: string, head: string): ChangeFile[] {
    return this.git(cwd, 'diff', '--numstat', `${base}..${head}`)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, r, p] = l.split('\t');
        const diff = this.git(cwd, 'diff', '-U0', `${base}..${head}`, '--', p!).split('\n');
        const added = diff.filter((x) => x.startsWith('+') && !x.startsWith('+++')).map((x) => x.slice(1));
        const removed = diff.filter((x) => x.startsWith('-') && !x.startsWith('---')).map((x) => x.slice(1));
        return { path: p!, added: Number(a) || 0, removed: Number(r) || 0, addedLines: added, removedLines: removed };
      });
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

  protected cost(issue: number, role: string, r: RunResult) {
    this.emit('run.cost', { issue, role, model: r.model, usd: r.costUsd, turns: r.turns });
  }

  protected ownerOf(issue: number): string {
    const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
    return (c?.payload as { owner?: string } | undefined)?.owner ?? this.d.cfg.project.owners.default;
  }

  protected async ask(kind: 'land' | 'question' | 'domain' | 'plan' | 'intake' | 'delegation', issue: number | null, owner: string, question: string, options: string[], recommendation: string, receipts: string[]): Promise<string> {
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
