// The coordinator: deterministic code (no LLM) that claims, schedules,
// verifies, levels, lands and deploys. Every step is an event; the next
// step is decided from events plus GitHub, so a restart picks up where the
// log says it was. Agents only ever propose: they commit on their own
// branch in their own worktree; everything outward-facing happens here.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { actionable, ownerFor, parseContract, type Backlog, type DoneWhenList, type Issue } from './backlog/types.js';
import { claim, release, renew, type Lease } from './claims.js';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { globToRegExp } from './guardrails/glob.js';
import { cpuCount, diskFree, killTree, killTreeAs, machineLoad, projectCommand, spawnDetached } from './os/index.js';
import { computeLevel, loadMoneyPaths, type ChangeFile, type Level } from './review.js';
import { INVESTIGATION_SCHEMA, issueBrief, REPRO_SCHEMA, rolePrompt, VERDICT_SCHEMA, WORKER_SCHEMA } from './roles.js';
import { DEFAULT_COMMIT_IDENTITY, type AgentRunner, type CommitIdentity, type RunAs, type RunResult } from './runner.js';
import { scanRange } from './scan/secrets.js';
import { emergencyStop, fullRunLock, tryAgentSlot } from './slots.js';
import { nightlyDue, queueNightly } from './nightly.js';
import { buildReport, dueSlot } from './reports.js';
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
  /** Nightly queuing (tests inject this). */
  nightly?: (root: string, cfg: Config, eventsDb: string, actor: string, runAs?: RunAs) => { id: string }[];
  /** Machine readings (tests inject these). */
  machine?: { load(): number | null; disk(path: string): { freePct: number; totalGb: number } };
}

const COMMAND_TIMEOUT_MS = 2 * 3600_000;

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

export class Coordinator {
  private readonly remote: string;
  private readonly wt: WorktreeOptions;
  private active = new Map<number, Promise<void>>();
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
          const r = await runner.run({ ...req, signal: req.signal ?? this.halt.signal });
          if (this.halt.signal.aborted) throw new Halted();
          return r;
        },
      },
    };
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
    const reconciled = await step('reconcile', () => this.reconcile(), 0);
    await step('nightly', () => this.maybeNightly(), undefined);
    await step('report', () => this.maybeReport(), undefined);
    await step('decisions', () => this.handleDecisions(), undefined);
    await step('land', () => this.landNext(), undefined);
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
    const report = buildReport(this.d.log.read(), this.d.cfg, { since, now, slot, ...(this.d.tokenExpiresAt !== undefined ? { tokenExpiresAt: this.d.tokenExpiresAt } : {}), ...(this.d.appKeyPath ? { appKeyPath: this.d.appKeyPath } : {}) });
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

  private async dispatch(): Promise<number> {
    if (this.stopped || this.halt.signal.aborted) return 0;
    const workers = this.d.cfg.agents.roles.workers;
    if (!workers?.enabled) return 0;
    let started = 0;
    const ready = await this.d.backlog.list('ready');
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
        const seen = this.events(issue.number).some((e) => e.type === 'contract.missing');
        if (!seen) {
          this.emit('contract.missing', { issue: issue.number, why: contract.why });
          await this.d.backlog.comment(issue.number, `[${BRAND.cli}] Not starting: ${contract.why}. Add a \`\`\`done_when block (no contract, no build).`);
        }
        continue;
      }
      const slot = tryAgentSlot(`${BRAND.cli} ${this.d.cfg.project.project.name} #${issue.number}`, this.d.slotsDir);
      if (!slot) {
        this.noteHold({ reason: 'machine-wide agent cap reached (all harnesses)', load: null, freeDiskPct: null });
        break; // try again next tick
      }
      const p = this.runTask(issue, contract.done_when)
        .catch((e: Error) => {
          this.emit('coordinator.error', { instance: this.d.instance, where: `task #${issue.number}`, kind: 'error', message: e.message.slice(0, 500) });
        })
        .finally(() => {
          slot.release();
          this.active.delete(issue.number);
        });
      this.active.set(issue.number, p);
      started++;
    }
    return started;
  }

  // ---------------------------------------------------------------- task pipeline

  private paths(issue: number) {
    return { name: `issue-${issue}`, branch: `${BRAND.cli}/issue-${issue}`, taskFile: join(this.d.stateDir, 'tasks', `issue-${issue}.json`) };
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
      mkdirSync(dirname(taskFile), { recursive: true });
      writeFileSync(taskFile, JSON.stringify({ id: `issue-${n}`, done_when: doneWhen }));

      if (issue.labels.includes('type:investigation')) return await this.investigate(issue, doneWhen, path, taskFile, base, owner);

      const repro = doneWhen.some((d) => 'repro' in d && d.repro) ? await this.reproduce(issue, doneWhen, base, path) : null;
      // The frozen test is off-limits to the worker: its hook denies writes to it.
      if (repro?.path) writeFileSync(taskFile, JSON.stringify({ id: `issue-${n}`, done_when: doneWhen, frozen: [repro.path] }));
      const maxAttempts = this.d.maxAttempts ?? 3;
      let feedback: string[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const out = await this.build(issue, doneWhen, path, taskFile, repro, feedback, attempt);
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
        if ('rejected' in change) {
          this.emit('change.rejected', { issue: n, why: change.rejected });
          feedback = [`Your previous attempt was rejected: ${change.rejected}`];
          continue;
        }
        const checks = await this.verify(n, path, head, doneWhen, repro);
        if (checks.some((c) => c.status !== 'pass')) {
          feedback = [`Independent checks failed on your last attempt:`, ...checks.filter((c) => c.status !== 'pass').map((c) => `- ${c.check}: ${c.status}\n${c.tail}`)];
          continue;
        }
        const verdict = await this.evaluate(issue, doneWhen, path, base, head, change.patchHash, checks, repro, change.tampered, change.files.map((f) => f.path));
        if (!verdict.patch_correct && attempt < maxAttempts) {
          feedback = [`The independent evaluator rejected your change: ${verdict.advice}`];
          continue;
        }
        const levelInput = { files: change.files, labels: issue.labels, moneyPaths: loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source), verdict, ...(verdict.unread.length ? { requested: 'L3' as Level } : out.raise || change.tampered.length || repro?.unavailable ? { requested: out.raise ?? ('L2' as Level) } : {}) };
        const lvl = computeLevel(levelInput, this.d.cfg.review ?? DEFAULT_REVIEW);
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
      await this.block(n, owner, `no passing change after ${maxAttempts} attempts`);
    } catch (e) {
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

  private async build(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, repro: { path: string } | null, feedback: string[], attempt: number) {
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
      ...(feedback.length ? ['', ...feedback] : []),
    ];
    let pid = -1;
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
    if (r.reason === 'rate_limited' || r.reason === 'budget_exhausted' || r.reason === 'auth_mismatch') {
      await this.block(n, owner, `worker run ended: ${r.reason} (${r.detail})`, false);
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
    const failing = checks.filter((c) => c.status !== 'pass');
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
    const numstat = this.git(path, 'diff', '--numstat', `${base}..${head}`).split('\n').filter(Boolean);
    const files: ChangeFile[] = numstat.map((l) => {
      const [a, r, p] = l.split('\t');
      const added = this.git(path, 'diff', '-U0', `${base}..${head}`, '--', p!).split('\n').filter((x) => x.startsWith('+') && !x.startsWith('+++')).map((x) => x.slice(1));
      return { path: p!, added: Number(a) || 0, removed: Number(r) || 0, addedLines: added };
    });
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
    const checks: { check: string; status: 'pass' | 'fail' | 'unavailable'; exitCode: number | null; tail: string }[] = [];
    const run = async (command: string) => {
      const r = await this.project(command, path);
      const busy = this.d.cfg.tests.stop_gate.busy_patterns.some((p) => new RegExp(p, 'm').test(r.out));
      checks.push({ check: command, status: busy || r.code === null ? 'unavailable' : r.code === 0 ? 'pass' : 'fail', exitCode: r.code, tail: r.tail });
    };
    const one = this.d.cfg.tests.runner.one;
    for (const d of doneWhen) {
      if ('command' in d) await run(d.command);
      else if ('suite' in d) {
        const cmd = d.suite === 'full' ? this.d.cfg.tests.runner.full : this.d.cfg.tests.runner.changed;
        const r = await this.project(cmd, path);
        const v = baselineGate(r.code, r.out, this.d.cfg.tests.failures, latestBaseline(this.d.log));
        checks.push({ check: `${cmd} (baseline gate)`, status: v.outcome === 'pass' ? 'pass' : r.code === null ? 'unavailable' : 'fail', exitCode: r.code, tail: v.outcome === 'fail' ? `${v.note}${v.newFailures.length ? `: ${v.newFailures.join(', ')}` : ''}\n${r.tail}` : v.note });
      }
      else if ('test' in d) {
        if (one) await run(one.replaceAll('{file}', d.test));
        else checks.push({ check: `test ${d.test}`, status: 'unavailable', exitCode: null, tail: 'tests.yaml runner.one not set' });
      }
    }
    if (repro?.path && one) await run(one.replaceAll('{file}', repro.path));
    for (const c of this.d.cfg.tests.checks) await run(c);
    this.emit('check.result', { issue: n, head, stage: 'verify', checks: checks.map(({ tail, ...c }) => ({ ...c, ...(c.status !== 'pass' && tail ? { tail: tail.slice(-1500) } : {}) })) });
    return checks;
  }

  private async evaluate(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, head: string, patchHash: string, checks: { check: string; status: string }[], repro: { path: string } | null, tampered: string[], changed: string[]) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.evaluator!;
    const extra = [
      `Base commit: ${base}. Head: ${head}. Inspect with: git diff ${base}..${head}`,
      `Reproduction test: ${repro?.path || 'none'}`,
      `Coordinator's check results: ${checks.map((c) => `${c.check}=${c.status}`).join(', ') || 'none'}`,
      ...(tampered.length ? [`Tamper guard flags: ${tampered.join('; ')}`] : []),
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
      jsonSchema: VERDICT_SCHEMA,
      stallMs: 15 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    this.cost(n, 'evaluator-verdict', r);
    const s = r.structured as { patch_correct?: boolean; test_correct?: boolean; confidence?: 'high' | 'medium' | 'low'; advice?: string; files_reviewed?: string[] } | undefined;
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
    this.emit('eval.verdict', { issue: n, head, patch_hash: patchHash, ...v, ...(unread.length ? { unread } : {}) });
    return { ...v, unread };
  }

  private cost(issue: number, role: string, r: RunResult) {
    this.emit('run.cost', { issue, role, model: r.model, usd: r.costUsd, turns: r.turns });
  }

  private ownerOf(issue: number): string {
    const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
    return (c?.payload as { owner?: string } | undefined)?.owner ?? this.d.cfg.project.owners.default;
  }

  private async ask(kind: 'land' | 'question', issue: number | null, owner: string, question: string, options: string[], recommendation: string, receipts: string[]) {
    const id = `d-${issue ?? kind}-${randomBytes(3).toString('hex')}`;
    this.emit('decision.asked', { id, kind, issue, owner, question, options, recommendation, receipts });
    if (issue === null) return; // not tied to an issue: answered from the dashboard or CLI
    await this.d.backlog.addLabels(issue, ['needs:decision']);
    await this.d.backlog.comment(
      issue,
      `[${BRAND.cli}] @${owner} decision needed: **${question}**\n\nOptions: ${options.join(' / ')}. Recommendation: **${recommendation}**.\n\n${receipts.map((r) => `- ${r}`).join('\n')}\n\nReply \`/${BRAND.cli} ${options.join('` or `/' + BRAND.cli + ' ')}\` (owner or a writer), or run \`${BRAND.cli} decide ${id} <option>\`.`,
    );
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
  private async handleDecisions() {
    const writers = new Set(this.d.cfg.project.owners.writers.map((w) => w.toLowerCase()));
    const cmd = new RegExp(`^/${BRAND.cli}\\s+(\\S+)`, 'm');
    for (const asked of this.d.log.read(0, ['decision.asked'])) {
      const q = asked.payload as EventPayload<'decision.asked'>;
      if (q.issue === null) continue;
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
  private async runGates(path: string, tiers: string[]): Promise<{ ok: true; notes: string[] } | { ok: false; deferred: boolean; note: string }> {
    const notes: string[] = [];
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
        for (let attempt = 1; attempt <= 2; attempt++) {
          const r = await this.project(command, path);
          verdict = baselineGate(r.code, r.out, this.d.cfg.tests.failures, latestBaseline(this.d.log));
          tail = r.tail;
          if (verdict.outcome === 'pass') break;
        }
        if (verdict!.outcome === 'fail') return { ok: false, deferred: false, note: `${tier}: ${verdict!.note}${verdict!.newFailures.length ? `: ${verdict!.newFailures.join(', ')}` : ''}\n${tail}` };
        notes.push(`${tier}: ${verdict!.note}`);
      } finally {
        lock?.release();
      }
    }
    return { ok: true, notes };
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
      const push = spawnSync('git', ['push', this.remote, `${head}:refs/heads/${this.branch}`], { cwd: path, encoding: 'utf8' });
      if (push.status !== 0) {
        // The tip moved under us: leave them queued; the next tick rebuilds on the new tip.
        for (const q of applied) result(q.issue, 'deferred', null, `push rejected (tip moved): ${push.stderr.trim().split('\n').pop()}`);
        return;
      }
      this.emit('check.result', { issue: applied[0]!.issue, head, stage: 'land', checks: gates.notes.map((note) => ({ check: note, status: 'pass', exitCode: 0 })) });
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
    const push = spawnSync('git', ['push', this.remote, `+${q.head}:refs/heads/${branch}`], { cwd: this.d.repo, encoding: 'utf8' });
    if (push.status !== 0) {
      this.emit('land.result', { issue: n, outcome: 'error', landed: null, detail: `pushing ${branch} failed: ${(push.stderr || '').trim().slice(-500)}` });
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
      `Opened by ${BRAND.name}. It never merges this; a human does.`,
      '',
      `**Review level:** ${lvl?.level ?? '?'}${lvl?.reasons.length ? ` (${lvl.reasons.slice(0, 6).join('; ')})` : ''}`,
      `**Independent evaluator:** ${verdict ? `${verdict.patch_correct ? 'approves' : 'rejects'}, confidence ${verdict.confidence}${verdict.advice ? `: ${verdict.advice.slice(0, 500)}` : ''}` : 'none'}`,
      `**Checks run by the harness:** ${checks?.checks.map((c) => `${c.check} ${c.status}`).join(', ') || 'none'}`,
    ].join('\n');
    let url: string;
    try {
      url = await this.d.backlog.openPr(branch, this.branch, `${issue.title} (#${n})`, body);
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
};
