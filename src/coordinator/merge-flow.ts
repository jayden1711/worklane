// The merge-policy flow: watching opened PRs, the merge decision, waiting for the owner, the light check, and
// main's checks after a merge (revert on red).
import type { Coordinator } from '../coordinator.js';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import type { ReviewConfig } from '../config/schema.js';
import { type CommitCheck, type PullRequest } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import { writeGroupOnly } from '../os/index.js';
import { computeLevel, loadMoneyPaths } from '../review.js';
import { instructionTargets } from '../skilleval.js';
import { checkedPush } from '../push-check.js';
import { conflictTrigger } from '../conflicts.js';
import { abortMerge, mergeBaseInto } from '../merge-base.js';
import { lightOutcome } from '../light-check.js';
import { readiness, requiredOutcomes, type Readiness } from '../pr-watch.js';
import { instructionEvalReasons, mergeDecision, outsidePlanReasons, waitCategoriesOf, type MergeDecision } from '../merge-policy.js';
import { createWorktree, removeWorktree } from '../worktrees.js';
import { mayMerge, mergeTurn, PrBatcher, PR_BATCH_EVENTS } from './pr-batch.js';
import { FixRuns } from './fix-runs.js';
import { MERGEABLE_RECHECK_MS, TIP_CHECK_MS, DEFAULT_REVIEW } from './shared.js';
import { LIGHT_PENDING_CAP, MAIN_CHECKS_MIN_POLLS, MAIN_CHECKS_TIMEOUT_MS, MERGEABLE_CAP, PollCounter, pollsFor } from './wait-caps.js';

export abstract class MergeFlow extends FixRuns {
  /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
  protected abstract combinedGate(...args: Parameters<Coordinator['combinedGate']>): ReturnType<Coordinator['combinedGate']>;
  /** Polls of the merge flow's capped waits (wait-caps.ts). */
  protected readonly waitPolls = new PollCounter();
  private batcher: PrBatcher | null = null;

  // ---------------------------------------------------------------- PR batches

  /** PR mode with batching on (tests.yaml land.pr_batch): ready PRs are tested together before any merges. */
  protected prBatching(): boolean {
    return this.d.cfg.project.land_mode === 'pr' && this.d.cfg.tests.land.pr_batch.enabled;
  }

  protected get prBatch(): PrBatcher {
    this.batcher ??= new PrBatcher({
      log: this.d.log,
      instance: this.d.instance,
      repo: this.d.repo,
      remote: this.remote,
      branch: this.branch,
      identity: this.identity,
      config: () => this.d.cfg.tests.land.pr_batch,
      testRuns: this.d.testRuns ?? null,
      pullRequest: (n) => this.d.backlog.pullRequest(n),
      comment: (n, body) => this.d.backlog.comment(n, body),
      addLabels: (n, labels) => this.d.backlog.addLabels(n, labels),
      removeLabel: (n, label) => this.d.backlog.removeLabel(n, label),
      ownerOf: (issue) => this.ownerOf(issue),
      // The merge policy decides it on the PR watch's next pass, as for any ready PR.
      tested: (e) => this.prPolled.delete(e.number),
      // High-risk, money-path, or anything else the policy leaves to the owner: batched alone.
      waitsForOwner: (e, pr) => {
        try {
          const d = this.mergeDecisionFor(e.issue, e.number, pr);
          return d.auto ? null : d.reasons.join('; ') || 'waits for the owner';
        } catch (err) {
          return `the merge policy could not decide: ${(err as Error).message.slice(0, 200)}`;
        }
      },
    });
    return this.batcher;
  }

  /** Start the next PR batch in the background (one at a time). */
  protected prBatchTick() {
    if (this.prBatching()) this.prBatch.tick();
  }

  /** Wait for a running PR batch. */
  protected async prBatchIdle() {
    await this.batcher?.idle();
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
  protected async watchPrs() {
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
    // Batching: ready on the fast checks (the full check comes from the batch); a head returned from a batch is not.
    const batching = this.prBatching();
    const r = this.prReadiness(n, pr.headSha, await this.d.backlog.checks(pr.headSha), batching ? this.d.cfg.tests.land.pr_batch.full_checks : []);
    const returned = batching && r.ready ? this.prBatch.returnedFor(number, pr.headSha) : null;
    if (returned) {
      r.ready = false;
      r.reasons.push(returned);
    }
    const last = this.d.log.read(0, ['pr.status']).map((e) => e.payload as EventPayload<'pr.status'>).filter((p) => p.number === number).at(-1);
    const checks = r.checks.map((c) => ({ name: c.name, outcome: c.outcome }));
    if (!last || last.head !== pr.headSha || last.ready !== r.ready || JSON.stringify(last.checks) !== JSON.stringify(checks)) {
      this.emit('pr.status', { issue: n, number, head: pr.headSha, ready: r.ready, reasons: r.reasons, checks });
    }
    this.notePrStats(n, pr);
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
    if (r.ready) await (batching ? this.batchOrMerge(w, pr) : this.mergeOrWait(w, pr));
  }

  /** A PR ready on its fast checks: the merge policy once a batch with this head passed, else the batch queue. */
  private async batchOrMerge(w: EventPayload<'pr.opened'>, pr: PullRequest) {
    if (this.prBatch.testedIn(w.number, pr.headSha)) return this.mergeOrWait(w, pr);
    this.prBatch.enqueue({ issue: w.issue, number: w.number, head: pr.headSha });
  }

  /** The PR's size and comment count as the tracker reports them, recorded only when they change (the dashboard's board reads them). */
  private notePrStats(n: number, pr: PullRequest) {
    if (!pr.stats) return;
    const next = { issue: n, number: pr.number, head: pr.headSha, additions: pr.stats.additions, deletions: pr.stats.deletions, files: pr.stats.files, comments: pr.stats.comments };
    const last = this.d.log.read(0, ['pr.stats']).map((e) => e.payload as EventPayload<'pr.stats'>).filter((p) => p.number === pr.number).at(-1);
    if (!last || JSON.stringify(last) !== JSON.stringify(next)) this.emit('pr.stats', next);
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
    const plan = (this.events(n).filter((e) => e.type === 'plan.posted').at(-1)?.payload as EventPayload<'plan.posted'> | undefined)?.plan as { files?: string[] } | undefined;
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
      waitCategories: waitCategoriesOf(review),
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
      // A planned task: high-risk or design-level files its approved plan didn't list hold the merge: the repo's
      // high-risk categories and the engine's own, whether or not this repo's merge rules hold them elsewhere.
      outsidePlan: plan ? outsidePlanReasons({ planFiles: plan.files ?? [], level, waitCategories: [...new Set([...waitCategoriesOf(review), ...DEFAULT_REVIEW.levels.L3_human.when])], newTopLevel }) : [],
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
    // Safety floor: nothing auto-merges under an emergency stop; the next poll after it's lifted decides.
    if (this.emergencyInForce()) return;
    const { issue: n, number } = w;
    const prior = this.d.log
      .read(0, ['merge.decided'])
      .map((e) => e.payload as EventPayload<'merge.decided'>)
      .filter((p) => p.number === number && p.head === pr.headSha)
      .at(-1);
    if (prior && !prior.auto) {
      // Batching: the owner's approval (a review) merges it, on exactly the main its batch tested.
      if (this.prBatching() && !this.emergencyInForce() && (await this.ownerApproved(w, pr))) await this.mergeTested(w, pr, 'approved');
      return; // otherwise already waiting for the owner
    }
    const d = this.mergeDecisionFor(n, number, pr);
    if (d.auto) {
      // GitHub still computing: try again next poll, up to a cap. A conflict, or anything else blocking a clean merge: a human.
      if (pr.mergeableState === 'draft') return;
      if (pr.mergeable === null || pr.mergeableState === 'unknown') {
        const polls = this.waitPolls.bump(`mergeable:${number}:${pr.headSha}`);
        if (polls < MERGEABLE_CAP) return;
        const why = `GitHub was still computing whether it can merge after ${polls} polls`;
        this.emit('wait.capped', { issue: n, number, kind: 'mergeable_recheck', detail: why });
        d.reasons.push(why);
      } else if (!pr.mergeable || !['clean', 'unstable', 'has_hooks'].includes(pr.mergeableState)) d.reasons.push(`GitHub can't merge it cleanly (${pr.mergeableState})`);
      const failures = this.d.log.read(0, ['merge.failed']).map((e) => e.payload as EventPayload<'merge.failed'>).filter((p) => p.number === number && p.head === pr.headSha);
      if (failures.length >= 3) d.reasons.push(`merging failed ${failures.length} times: ${failures.at(-1)!.why}`);
      d.auto = d.reasons.length === 0;
      // The default branch moved under the PR in a way that could matter: check the combination (fast tier only,
      // off the PR) before merging. Not decided until that check has a result.
      if (d.auto) {
        // Batching: the combination is what the batch tested; mergeTested checks main is still exactly that.
        const gate = this.prBatching() ? 'merge' : await this.combinedGate(w, pr);
        if (gate === 'pending') return;
        // The combined check found a conflict GitHub doesn't report: wait for GitHub to catch up, up to a cap.
        if (gate === 'conflict') {
          const polls = this.waitPolls.bump(`light:${number}:${pr.headSha}`);
          if (polls < LIGHT_PENDING_CAP) return;
          const why = `merging the default branch into it conflicts, but GitHub still reports it mergeable after ${polls} polls`;
          this.emit('wait.capped', { issue: n, number, kind: 'light_check_pending', detail: why });
          d.reasons.push(why);
          d.auto = false;
        } else if (gate !== 'merge') {
          d.reasons.push(gate.hold);
          d.auto = false;
        }
      }
    }
    if (!prior || prior.auto !== d.auto) this.emit('merge.decided', { issue: n, number, head: pr.headSha, auto: d.auto, reasons: d.reasons });
    if (!d.auto) return this.waitForOwner(w, pr.headSha, d.reasons);
    // Again right before merging: the combined gate can take minutes, and a stop raised meanwhile must hold the merge.
    if (this.emergencyInForce()) return;
    if (this.prBatching()) return this.mergeTested(w, pr, 'auto');
    const m = await this.d.backlog.mergePr(number, pr.headSha, `${pr.title} (#${number})`);
    if (!m.ok) {
      this.emit('merge.failed', { issue: n, number, head: pr.headSha, why: m.why.slice(0, 500) });
      return;
    }
    this.emit('merge.done', { issue: n, number, head: pr.headSha, sha: m.sha, url: pr.url, title: pr.title });
    this.prPolled.clear(); // the other open PRs may conflict now: look at them on the next pass
    await this.d.backlog.comment(number, `[${BRAND.cli}] Auto-merged as \`${m.sha.slice(0, 8)}\` (a merge commit of the evaluated head \`${pr.headSha.slice(0, 8)}\`): every required check passed on it and nothing in it needs a human under this instance's merge policy.`);
  }

  /**
   * Batching: merge a PR only as tested. Both checks on this exact head (mayMerge), and main exactly what its green
   * batch tested it on, in batch order (mergeTurn); a main that moved otherwise sends it, and the PRs after it, back to
   * be tested again. Merged with a merge commit (merge_method: merge, pinned to the head), whose tree is the tested one.
   */
  private async mergeTested(w: EventPayload<'pr.opened'>, pr: PullRequest, how: 'auto' | 'approved') {
    const { issue: n, number } = w;
    const events = () => this.d.log.read(0, [...PR_BATCH_EVENTS, 'merge.done', 'merge.decided', 'pr.status', 'pr.opened']);
    const ok = mayMerge({ events: events(), number, head: pr.headSha, checks: await this.d.backlog.checks(pr.headSha), fastChecks: this.d.cfg.tests.land.pr_batch.fast_checks });
    if (!ok.ok) {
      this.emit('merge.failed', { issue: n, number, head: pr.headSha, why: `not merged untested: ${ok.why}`.slice(0, 500) });
      return;
    }
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const turn = mergeTurn({ events: events(), number, head: pr.headSha, tip, treeOf: (sha) => this.gitOrNull(this.d.repo, 'rev-parse', `${sha}^{tree}`) });
    if (turn.act === 'wait') return;
    if (turn.act === 'stale') {
      this.prBatch.stale(turn.batch, turn.prs, turn.why);
      if (how === 'approved') await this.d.backlog.comment(number, `[${BRAND.cli}] Approved, but not merged yet: ${turn.why}. It is tested again on the current ${this.branch} first, and merges once that passes.`);
      return;
    }
    const m = await this.d.backlog.mergePr(number, pr.headSha, `${pr.title} (#${number})`);
    if (!m.ok) {
      this.emit('merge.failed', { issue: n, number, head: pr.headSha, why: m.why.slice(0, 500) });
      return;
    }
    this.emit('merge.done', { issue: n, number, head: pr.headSha, sha: m.sha, url: pr.url, title: pr.title });
    this.prPolled.clear(); // the next PR in the batch, and the other open PRs, on the next pass
    const what = how === 'approved' ? `Merged on your approval as \`${m.sha.slice(0, 8)}\`` : `Auto-merged as \`${m.sha.slice(0, 8)}\``;
    await this.d.backlog.comment(number, `[${BRAND.cli}] ${what} (a merge commit of \`${pr.headSha.slice(0, 8)}\` onto exactly the ${this.branch} its batch ${turn.batch} tested, full run included).`);
  }

  /** The owner's latest review on the PR approves it, given since this head was queued for a batch. */
  private async ownerApproved(w: EventPayload<'pr.opened'>, pr: PullRequest): Promise<boolean> {
    if (!this.prBatch.testedIn(w.number, pr.headSha) && !this.prBatch.state().queue.some((q) => q.number === w.number && q.head === pr.headSha)) return false;
    const queued = this.d.log
      .read(0, ['pr_batch.queued'])
      .filter((e) => (e.payload as EventPayload<'pr_batch.queued'>).number === w.number && (e.payload as EventPayload<'pr_batch.queued'>).head === pr.headSha)
      .at(0);
    if (!queued) return false;
    const owner = this.ownerOf(w.issue);
    const last = (await this.d.backlog.reviews(w.number)).filter((r) => r.author === owner && r.state !== 'COMMENTED').sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    return last?.state === 'APPROVED' && Date.parse(last.at) >= Date.parse(queued.ts);
  }

  /** A PR that waits for the owner: the needs-owner label, one comment with every reason, a review request. */
  private async waitForOwner(w: EventPayload<'pr.opened'>, head: string, reasons: string[]) {
    const owner = this.ownerOf(w.issue);
    await this.d.backlog.addLabels(w.number, ['needs-owner']);
    const ask = this.prBatching()
      ? `waits for your review: approve it and ${BRAND.name} merges it onto exactly the ${this.branch} its full run tested (testing it again first if ${this.branch} moved). Merging it by hand skips that`
      : 'waits for you to review and merge';
    await this.d.backlog.comment(w.number, `[${BRAND.cli}] @${owner} ready, and ${ask} (\`${head.slice(0, 8)}\`):\n${reasons.map((r) => `- ${r}`).join('\n')}`);
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
  protected async watchMerges() {
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
      if (!failed.length && outcomes.some((c) => c.outcome !== 'pass')) {
        // Still running, up to a timeout (in polls, so it holds whatever the poll interval).
        const polls = this.waitPolls.bump(`main:${m.sha}`);
        if (polls < pollsFor(MAIN_CHECKS_TIMEOUT_MS, this.d.prPollMs ?? 60_000, MAIN_CHECKS_MIN_POLLS)) continue;
        const missing = outcomes.filter((c) => c.outcome !== 'pass').map((c) => c.name);
        this.emit('merge.main_result', { issue: m.issue, number: m.number, sha: m.sha, outcome: 'timed_out', failed: missing });
        this.emit('wait.capped', { issue: m.issue, number: m.number, kind: 'main_checks', detail: `${missing.join(', ')} never reported on ${m.sha.slice(0, 8)} after ${polls} polls` });
        await this.d.backlog.comment(m.number, `[${BRAND.cli}] @${this.ownerOf(m.issue)} the required check(s) ${missing.join(', ')} never reported on the merge commit \`${m.sha.slice(0, 8)}\` (${polls} polls), so whether ${this.branch} is green after this merge is unknown. Auto-merge goes on; check them yourself.`);
        continue;
      }
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

  /** Merge the default branch into the PR head in a scratch worktree and run the fast tier there. Nothing is pushed. */
  protected async lightCheck(w: EventPayload<'pr.opened'>, pr: PullRequest, baseRef: string, mainSha: string, overlap: string[]) {
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

  /** The readiness of an issue's PR at `head`, against the latest evaluator verdict for the issue; `except`: required checks left out. */
  prReadiness(n: number, head: string, checks: CommitCheck[], except: string[] = []): Readiness {
    const v = this.events(n).filter((e) => e.type === 'eval.verdict').at(-1)?.payload as EventPayload<'eval.verdict'> | undefined;
    return readiness({ required: this.d.cfg.project.required_checks.filter((c) => !except.includes(c)), checks, head, evaluated: v ? { head: v.head, approved: v.patch_correct } : null });
  }
}
