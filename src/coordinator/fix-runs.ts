// CI fix runs and conflict fix runs on the harness's own PRs.
import type { Coordinator } from '../coordinator.js';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BRAND } from '../brand.js';
import type { ReviewConfig } from '../config/schema.js';
import { type DoneWhenList, type Issue, type PullRequest } from '../backlog/types.js';
import { claim, release, renew, type Lease } from '../claims.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { computeLevel, loadMoneyPaths } from '../review.js';
import { issueBrief, rolePrompt, VERDICT_SCHEMA, WORKER_SCHEMA } from '../roles.js';
import { checkedPush } from '../push-check.js';
import { conflictBrief, conflictFixesUsed, conflictVerdictSchema, conflictWaitReasons, outsideHunks, parseConflicts, type Side } from '../conflicts.js';
import { mergeBaseInto } from '../merge-base.js';
import { type Readiness } from '../pr-watch.js';
import { tryAgentSlot } from '../slots.js';
import { createWorktree, removeSandboxPlaceholders, removeWorktree } from '../worktrees.js';
import { seen } from '../intake/store.js';
import { Landing } from './landing.js';
import { buildRoute } from './model-routing.js';
import { COMMAND_TIMEOUT_MS, MERGEABLE_RECHECK_MS, CLAIM_HELD_GIVE_UP_MS, laneOf, StoppedByOwner, Halted, DEFAULT_REVIEW, logTail, pushRefusal } from './shared.js';

export abstract class FixRuns extends Landing {
  /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
  protected abstract inspect(...args: Parameters<Coordinator['inspect']>): ReturnType<Coordinator['inspect']>;
  protected abstract verify(...args: Parameters<Coordinator['verify']>): ReturnType<Coordinator['verify']>;
  protected abstract evaluate(...args: Parameters<Coordinator['evaluate']>): ReturnType<Coordinator['evaluate']>;

  // ---------------------------------------------------------------- CI fix runs

  /**
   * A fix run found the issue's claim held elsewhere. The first time for this PR head it is recorded (`record`);
   * it never counts toward the fix cap, so a brief collision costs nothing. Only once the claim has been held
   * elsewhere for CLAIM_HELD_GIVE_UP_MS since that first record does this say to give up.
   */
  private claimHeldTooLong(type: 'ci_fix.finished' | 'conflict_fix.finished', number: number, head: string, record: () => void): boolean {
    const first = this.d.log.read(0, [type]).find((e) => {
      const p = e.payload as { number: number; outcome: string; head: string | null };
      return p.number === number && p.outcome === 'claim_lost' && p.head === head;
    });
    if (!first) {
      record();
      return false;
    }
    return Date.now() - Date.parse(first.ts) >= CLAIM_HELD_GIVE_UP_MS;
  }

  protected fixGaveUp(number: number): boolean {
    return this.d.log.read(0, ['ci_fix.gave_up']).some((e) => (e.payload as { number: number }).number === number);
  }

  /** The last commit the harness itself put on a PR's branch: the head it opened with, or its latest pushed fix. */
  protected ourHead(number: number): string | null {
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
  protected async maybeFix(w: EventPayload<'pr.opened'>, pr: PullRequest, r: Readiness) {
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
    if (!won.won) {
      const holder = won.holder?.instance ?? 'another run';
      const record = () => this.emit('ci_fix.finished', { issue: n, number, outcome: 'claim_lost', head: pr.headSha, detail: `the issue's claim is held by ${holder}` });
      if (this.claimHeldTooLong('ci_fix.finished', number, pr.headSha, record)) await this.giveUpFix(w, pr.headSha, `the issue's claim has been held by ${holder} for over an hour`, failed);
      return;
    }
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
      const verdict = await this.evaluate(issue, doneWhen, path, claimed.base, head, change.patchHash, checks, repro, change.tampered, change.files);
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
      env: this.projectEnv(),
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

  // ---------------------------------------------------------------- conflict fix runs

  /**
   * GitHub reports a watched PR as conflicting with its base: merge the base into the branch and let a worker
   * resolve the conflicted hunks, within the cap; otherwise ask the owner. Never on a branch someone else
   * pushed to. Recorded once per head and base as conflict_fix.detected.
   */
  protected async maybeFixConflict(w: EventPayload<'pr.opened'>, pr: PullRequest) {
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
  protected gitOrNull(cwd: string, ...args: string[]): string | null {
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
    if (!won.won) {
      const holder = won.holder?.instance ?? 'another run';
      const record = () => this.emit('conflict_fix.finished', { issue: n, number, base_sha: baseSha, strategy: 'merge', outcome: 'claim_lost', head: pr.headSha, files: [], waits_owner: false, reasons: [], detail: `the issue's claim is held by ${holder}` });
      if (this.claimHeldTooLong('conflict_fix.finished', number, pr.headSha, record)) await this.giveUpConflict(w, pr.headSha, baseSha, `the issue's claim has been held by ${holder} for over an hour`, []);
      return;
    }
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
      const verdict = await this.evaluate(issue, doneWhen, path, baseSha, head, change.patchHash, checks, repro, change.tampered, change.files, {
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
    const fixModel = buildRoute(this.d.cfg, issue.labels, 1, true).model;
    const extra = [
      `Conflict fix ${attempt} for this issue's pull request (${pr.url}, branch ${pr.head}).`,
      brief,
      'The merge is in progress in this worktree. Resolve every conflicted file, `git add` them, and finish the merge with `git commit --no-edit`. Make no other commits, never rebase or reset, and change nothing the merge did not leave conflicted. The coordinator then re-runs the done_when checks, the evaluator judges the resolution, and the coordinator pushes it.',
      ...(repro?.path ? [`Frozen reproduction test (must pass; never edit): ${repro.path}`] : []),
    ];
    const r = await this.d.runner.run({
      env: this.projectEnv(),
      role: 'worker',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'worker'),
      cwd: path,
      model: fixModel,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      maxTurns: 100,
      maxBudgetUsd: Math.min(workers.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: WORKER_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'conflict-fix', model: fixModel, worktree: path, pid: p, pgid: p, attempt }),
    });
    this.cost(n, 'conflict-fix', r);
    this.emit('run.finished', { issue: n, role: 'conflict-fix', reason: r.reason, detail: r.detail.slice(0, 1000) });
    const s = (r.structured ?? {}) as { summary?: string; blocked?: string; ask?: { question: string } };
    if (r.reason !== 'succeeded') return { ended: `the fix run ended: ${r.reason} (${r.detail.slice(0, 300)})` };
    if (s.blocked) return { ended: `the fix run was blocked: ${s.blocked}` };
    if (s.ask) return { ended: `the fix run has a question for you: ${s.ask.question}` };
    return { summary: s.summary ?? '' };
  }
}
