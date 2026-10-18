// The merge-policy flow: watching opened PRs, the merge decision, waiting for the owner, the light check, and
// main's checks after a merge (revert on red).
import { startRefusal, TestRunHeld } from '../testrun/gate.js';
import { CI_NONE_MAIN_WATCH, ciIsNone, headChecks, requiredFor } from '../ci-none.js';
import type { Coordinator } from '../coordinator.js';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import type { ReviewConfig } from '../config/schema.js';
import { type CommitCheck, type DoneWhenList, type PullRequest } from '../backlog/types.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { writeGroupOnly } from '../os/index.js';
import { computeLevel, loadMoneyPaths } from '../review.js';
import type { Episode } from '../fix-forward.js';
import { instructionTargets } from '../skilleval.js';
import { checkedPush } from '../push-check.js';
import { conflictTrigger } from '../conflicts.js';
import { abortMerge, mergeBaseInto } from '../merge-base.js';
import { changedNamesOrNull } from './change-files.js';
import { lightOutcome } from '../light-check.js';
import { readiness, requiredOutcomes, type Readiness } from '../pr-watch.js';
import { checksFor, effectiveClass, riskClassOf, rulesetHold } from '../pr-rules.js';
import { instructionEvalReasons, mergeDecision, neverAutoMerge, outsidePlanReasons, REVERT_BRANCH_PREFIX, waitCategoriesOf, type MergeDecision } from '../merge-policy.js';
import { deferDelay, deferrable, isBehind, mergeDeferral, mergeMessage, MergePass, mergeRefusal, type Deferral } from '../merge-policy-train.js';
import { MainWatch, repoGit, type MainWatchDeps, type Trip } from '../main-watch.js';
import { carriedHead, mergeInBase, type MergeIn } from '../pr-hygiene.js';
import { alertTarget, directPushKey, directPushText, ownerMentions } from '../direct-push-alert.js';
import { redactString } from '../events/redact.js';
import { takeOpsPost } from '../watchdog/post.js';
import { createWorktree, removeWorktree } from '../worktrees.js';
import { approveMerge, mergeApproval } from '../decide.js';
import type { ChatPerson } from '../intake/people.js';
import { mayMerge, mergesPending, mergeTurn, PrBatcher, PR_BATCH_EVENTS } from './pr-batch.js';
import { FixRuns } from './fix-runs.js';
import { FlakyGate } from './flaky.js';
import { FixForward } from './fix-forward.js';
import { lit, reviewPacket, type PacketInput } from './review-packet.js';
import { MERGEABLE_RECHECK_MS, TIP_CHECK_MS, DEFAULT_REVIEW } from './shared.js';
import { LIGHT_PENDING_CAP, MAIN_CHECKS_MIN_POLLS, MAIN_CHECKS_TIMEOUT_MS, MERGEABLE_CAP, PollCounter, pollsFor } from './wait-caps.js';

export abstract class MergeFlow extends FixRuns {
  /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
  protected abstract combinedGate(...args: Parameters<Coordinator['combinedGate']>): ReturnType<Coordinator['combinedGate']>;
  /** Polls of the merge flow's capped waits (wait-caps.ts). */
  protected readonly waitPolls = new PollCounter();
  private batcher: PrBatcher | null = null;
  private flakyGateInst: FlakyGate | null = null;
  private fixForwardInst: FixForward | null = null;

  /** The flaky-test gate in front of a red default branch (coordinator/flaky.ts): re-run first, quarantine what passes. */
  protected get flakyGate(): FlakyGate {
    const live = () => this.liveTestRuns;
    this.flakyGateInst ??= new FlakyGate({
      log: this.d.log,
      actor: this.d.instance,
      backlog: this.d.backlog,
      config: () => this.d.cfg.project.flaky,
      repo: this.d.cfg.project.project.repo,
      branch: this.branch,
      clone: this.d.repo,
      // WHY: read at each use, not once: off while the sandbox's check fails, on when it passes (liveTestRuns).
      get testRuns() {
        return live();
      },
      tiers: () => this.d.cfg.tests.test_run?.tiers ?? [],
      fetch: () => void this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch),
    });
    return this.flakyGateInst;
  }

  /** Fix-forward on a real red default branch (coordinator/fix-forward.ts): the culprit, fix tasks, the revert if they fail. */
  protected get fixForward(): FixForward {
    const git = (...a: string[]) => this.gitOrNull(this.d.repo, ...a);
    const live = () => this.liveTestRuns;
    this.fixForwardInst ??= new FixForward({
      log: this.d.log,
      actor: this.d.instance,
      backlog: this.d.backlog,
      branch: this.branch,
      repo: this.d.cfg.project.project.repo,
      clone: this.d.repo,
      git: {
        tip: () => {
          git('fetch', '-q', this.remote, this.branch);
          return git('rev-parse', '--verify', '-q', `${this.remote}/${this.branch}`);
        },
        parent: (sha) => git('rev-parse', '--verify', '-q', `${sha}^1`),
        isAncestor: (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: this.d.repo }).status === 0,
        firstParents: (from, to) => (git('rev-list', '--first-parent', '--reverse', `${from}..${to}`) ?? '').split('\n').filter(Boolean),
        subject: (sha) => git('log', '-1', '--format=%s', sha) ?? '',
        // A rename as both its paths and each path as itself, so a locked category on either one holds (#683).
        files: (sha) => changedNamesOrNull(this.d.repo, [`${sha}^1`, sha]) ?? [],
        diff: (sha) => git('diff', `${sha}^1`, sha) ?? '',
      },
      config: () => this.d.cfg.project.fix_forward,
      required: () => this.requiredChecks(),
      checks: (sha) => this.headChecksOf(sha),
      probeTimeoutMin: () => this.d.cfg.project.flaky.rerun_timeout_min,
      // WHY: read at each use, not once: off while the sandbox's check fails, on when it passes (liveTestRuns).
      get testRuns() {
        return live();
      },
      tiers: () => this.d.cfg.tests.test_run?.tiers ?? [],
      categories: (files) => {
        const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
        return computeLevel({ files: files.map((path) => ({ path, added: 0, removed: 0 })), labels: [], moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review).categories;
      },
      revert: (o) => this.fixForwardRevert(o),
      giveUp: (o) => this.fixForwardGaveUp(o.ep, o.reason),
      post: (key, text) => this.opsPost(key, text),
      pollMs: () => this.d.prPollMs ?? 60_000,
    });
    return this.fixForwardInst;
  }

  /** Fix-forward's pass: the open red default branch moved on, and its ops posts. */
  protected async fixForwardStep() {
    await this.fixForward.step();
  }

  /** The merge train: this pass's merges, up to tests.yaml land.parallel_merges. */
  protected readonly mergePass = new MergePass(() => this.d.cfg.tests.land.parallel_merges);
  /** The merge train's clock for deferrals (tests move it). */
  protected trainNow: () => number = () => Date.now();

  // ---------------------------------------------------------------- PR batches

  /** PR mode with batching on (tests.yaml land.pr_batch): ready PRs are tested together before any merges. */
  protected prBatching(): boolean {
    return this.d.cfg.project.land_mode === 'pr' && this.d.cfg.tests.land.pr_batch.enabled;
  }

  protected get prBatch(): PrBatcher {
    const live = () => this.liveTestRuns;
    this.batcher ??= new PrBatcher({
      log: this.d.log,
      instance: this.d.instance,
      repo: this.d.repo,
      remote: this.remote,
      branch: this.branch,
      identity: this.identity,
      config: () => this.d.cfg.tests.land.pr_batch,
      // WHY: read at each use, not once: off while the sandbox's check fails, on when it passes (liveTestRuns).
      get testRuns() {
        return live();
      },
      pullRequest: (n) => this.d.backlog.pullRequest(n),
      comment: (n, body) => this.d.backlog.comment(n, body),
      addLabels: (n, labels) => this.d.backlog.addLabels(n, labels),
      removeLabel: (n, label) => this.d.backlog.removeLabel(n, label),
      ownerOf: (issue) => this.ownerOf(issue),
      // The merge policy decides it on the PR watch's next pass, as for any ready PR.
      tested: (e) => this.prPolled.delete(e.number),
      mergesSettled: () => !mergesPending(this.d.log.read(0, [...PR_BATCH_EVENTS, 'merge.done', 'merge.decided']), Date.now()),
      // High-risk, money-path, or anything else the policy leaves to the owner: batched alone. A person's PR too: it
      // merges when they merge it, so nothing of the harness's may wait behind it in a batch.
      waitsForOwner: (e, pr) => {
        if (e.by) return `opened by @${e.by}: a person merges it, never the harness`;
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
    // WHY: a batch starts full test runs: none while the start gate refuses (src/testrun/gate.ts); asked here too, so a
    // held batch isn't built only to be abandoned.
    if (this.prBatching() && !startRefusal()) this.prBatch.tick();
  }

  /** When each person's PR was last looked at (its fast checks), by number. */
  private readonly peoplePolled = new Map<number, number>();

  /**
   * People's PRs into the default branch join the batch queue: once their fast checks pass on the head, a PR opened
   * by a mapped admin or writer (their role from their repo permission) gets the same sharded full run, and the full
   * check posted on its head. A bot's or an unmapped author's stays fast-only until an admin approves it. The harness
   * never merges any of them (the merge policy refuses a PR it didn't open): the person does, once it's green. From
   * the test runs' own listing of open PRs: no listing of its own.
   */
  protected async batchPeoplesPrs() {
    if (!this.prBatching() || !this.d.prTestRuns) return;
    const fastChecks = this.d.cfg.tests.land.pr_batch.fast_checks;
    if (!fastChecks.length) return;
    const ours = new Set(this.d.log.read(0, ['pr.opened']).map((e) => (e.payload as EventPayload<'pr.opened'>).number));
    const now = Date.now();
    const interval = this.d.prPollMs ?? 60_000;
    const st = this.prBatch.state();
    for (const pr of this.d.prTestRuns.listing()) {
      if (ours.has(pr.number) || pr.base !== this.branch) continue;
      // A head that moved off the one in the running batch drops it: its run is cancelled.
      this.prBatch.observe(pr.number, pr.headSha, 'open');
      const k = `${pr.number}@${pr.headSha}`;
      if (st.posted.has(k) || st.returned.has(k) || st.queue.some((q) => q.number === pr.number && q.head === pr.headSha)) continue;
      if (now - (this.peoplePolled.get(pr.number) ?? 0) < interval) continue;
      this.peoplePolled.set(pr.number, now);
      const role = pr.bot ? null : ((await this.d.roleOf?.(pr.author)) ?? null);
      const mapped = role === 'owner' || role === 'writer';
      const fast = requiredOutcomes(fastChecks, await this.headChecksOf(pr.headSha));
      if (fast.some((c) => c.outcome !== 'pass')) continue;
      if (!mapped && !(await this.adminApproved(pr.number))) continue;
      this.prBatch.enqueue({ issue: pr.number, number: pr.number, head: pr.headSha, by: pr.author || 'unknown' });
    }
  }

  /** An admin's (owner's) latest review on the PR approves it. */
  private async adminApproved(n: number): Promise<boolean> {
    if (!this.d.roleOf) return false;
    const latest = new Map<string, string>();
    for (const r of [...(await this.d.backlog.reviews(n))].sort((a, b) => a.at.localeCompare(b.at))) if (r.state !== 'COMMENTED') latest.set(r.author, r.state);
    for (const [author, state] of latest) if (state === 'APPROVED' && (await this.d.roleOf(author)) === 'owner') return true;
    return false;
  }

  /** Wait for a running PR batch. */
  /** The coordinator is stopping: cancel a batch run in flight. */
  protected prBatchStop() {
    this.batcher?.stop();
  }

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
    this.mergePass.start();
    const interval = this.d.prPollMs ?? 60_000;
    // A merge into the default branch (by anyone) is when PRs start conflicting: look at all of them now.
    if (this.watchedPrs().length && now - this.tipCheckedAt >= TIP_CHECK_MS) {
      this.tipCheckedAt = now;
      const r = spawnSync('git', ['ls-remote', this.remote, `refs/heads/${this.branch}`], { cwd: this.d.repo, encoding: 'utf8' });
      const tip = r.status === 0 ? (r.stdout.split(/\s/)[0] ?? '') : '';
      if (tip && tip !== this.defaultTip) {
        if (this.defaultTip) this.prPolled.clear();
        // Main moved off a running batch's base: its result would be stale, so its run is cancelled.
        if (this.prBatching()) this.batcher?.mainMoved(tip);
        this.defaultTip = tip;
      }
    }
    const due = this.watchedPrs()
      .filter((p) => now - (this.prPolled.get(p.number) ?? 0) >= interval)
      .sort((a, b) => (this.prPolled.get(a.number) ?? 0) - (this.prPolled.get(b.number) ?? 0))
      .slice(0, Math.max(10, this.d.cfg.tests.land.parallel_merges));
    for (const watched of due) {
      this.prPolled.set(watched.number, now);
      await this.watchPr(watched);
    }
  }

  private async watchPr(w: EventPayload<'pr.opened'>) {
    const { issue: n, number } = w;
    const pr = await this.d.backlog.pullRequest(number);
    // A head that moved, or a PR that closed, drops it from a running batch: that batch's run is cancelled.
    if (this.prBatching()) this.batcher?.observe(number, pr.headSha, pr.state);
    if (pr.state !== 'open') {
      this.emit('pr.closed', { issue: n, number, merged: pr.state === 'merged' });
      return;
    }
    const conflict = conflictTrigger(pr);
    if (conflict.act === 'recheck') this.prPolled.set(number, Date.now() - (this.d.prPollMs ?? 60_000) + MERGEABLE_RECHECK_MS);
    if (conflict.act === 'fix') return this.maybeFixConflict(w, pr);
    // Batching: ready on the fast checks (the full check comes from the batch); a head returned from a batch is not.
    // A docs-only PR with light checks configured: ready on those alone, and never batched (src/pr-rules.ts).
    const plan = this.checksPlan(n, pr.headSha);
    const batching = this.prBatching() && !plan.fast;
    const except = plan.fast ? this.requiredChecks().filter((c) => !plan.checks.includes(c)) : batching ? this.d.cfg.tests.land.pr_batch.full_checks : [];
    const r = this.prReadiness(n, pr.headSha, await this.d.backlog.checks(pr.headSha), except);
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

  /** Whether this instance opened PR `number` (a pr.opened event of its own). */
  private openedByUs(number: number): boolean {
    return this.d.log.read(0, ['pr.opened']).some((e) => (e.payload as EventPayload<'pr.opened'>).number === number);
  }

  /**
   * The only way the harness merges: GitHub's merge API, pinned to the head, and never for a PR it didn't open or a
   * revert it opened (neverAutoMerge), whatever led here.
   */
  private async mergeOurs(pr: PullRequest): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
    const never = neverAutoMerge({ branch: pr.head, openedByHarness: this.openedByUs(pr.number) });
    if (never.length) return { ok: false, why: never.join('; ') };
    const msg = mergeMessage({ title: pr.title, number: pr.number, head: pr.headSha, product: BRAND.name });
    return this.d.backlog.mergePr(pr.number, pr.headSha, msg.subject, msg.body);
  }

  // ---------------------------------------------------------------- merge train

  /**
   * The merge train's one door to mergeOurs (src/merge-policy-train.ts): within this pass's cap (a PR over it merges
   * on the next pass); at the head GitHub reports right now, since an earlier merge of the pass or a push may have
   * moved it (a moved head is never merged: it is decided afresh); and a branch GitHub calls behind its base (strict
   * protection) or a base that moved mid-merge is put off with a backoff, never retried in a loop and never made to
   * merge the default branch in. null: not merged this pass, nothing to record; a failure is the caller's to record.
   */
  private async trainMerge(w: EventPayload<'pr.opened'>, pr: PullRequest): Promise<{ ok: true; sha: string } | { ok: false; why: string } | null> {
    const { number } = w;
    if (this.mergeDeferred(number, pr.headSha)) return null;
    // The default branch is red: only fix-forward's fix PR merges until it is green again.
    if (this.fixForward.holds(w.issue)) return null;
    if (!this.mergePass.room()) {
      this.prPolled.delete(number); // first in line on the next pass
      return null;
    }
    const now = await this.d.backlog.pullRequest(number);
    if (now.state !== 'open' || now.headSha !== pr.headSha) {
      this.prPolled.delete(number);
      return null;
    }
    if (isBehind(now)) {
      await this.deferMerge(w, pr, 'behind', `GitHub requires it up to date with ${this.branch} first (mergeable_state behind)`);
      return null;
    }
    const m = await this.mergeOurs(pr);
    if (m.ok) {
      this.mergePass.took();
      return m;
    }
    const refusal = mergeRefusal(m.why);
    if (deferrable(refusal)) {
      await this.deferMerge(w, pr, refusal as 'behind' | 'base_moved', `GitHub refused the merge: ${m.why}`);
      return null;
    }
    if (refusal === 'head_moved') this.prPolled.delete(number);
    return m;
  }

  private deferrals(): Deferral[] {
    return this.d.log.read(0, ['merge.deferred']).map((e) => e.payload as EventPayload<'merge.deferred'>);
  }

  /** PR `number` at `head` was put off and its retry time hasn't come. */
  protected mergeDeferred(number: number, head: string): boolean {
    return mergeDeferral(this.deferrals(), number, head, this.trainNow()).waiting;
  }

  /**
   * Put off merging PR `number` at this head, for longer each time (deferDelay). The first time a head is put off as
   * behind, one comment says why and what lets it through; the owner isn't asked: it isn't theirs to decide.
   */
  private async deferMerge(w: EventPayload<'pr.opened'>, pr: PullRequest, kind: 'behind' | 'base_moved', why: string) {
    const now = this.trainNow();
    const { times } = mergeDeferral(this.deferrals(), w.number, pr.headSha, now);
    const retryAt = now + deferDelay(times);
    this.emit('merge.deferred', { issue: w.issue, number: w.number, head: pr.headSha, why: why.slice(0, 500), retry_at: new Date(retryAt).toISOString() });
    if (kind === 'behind' && times === 0) {
      await this.d.backlog.comment(w.number, `[${BRAND.cli}] Ready to merge, but this repo requires branches to be up to date with ${this.branch} (strict branch protection), and ${BRAND.name} doesn't merge ${this.branch} into a PR to get there. It tries again later, waiting longer each time (up to ${deferDelay(99) / 60_000} min). Updating the branch, or turning off "require branches to be up to date", lets it merge.`);
    }
  }

  /** The policy's call on a ready PR at its current head. */
  mergeDecisionFor(n: number, number: number, pr: PullRequest): MergeDecision {
    const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
    // A stale-PR merge-in head: the PR's own change is measured from the default branch it merged (src/pr-hygiene.ts).
    const mergeIns = this.mergeInsOf();
    const base = mergeInBase(mergeIns, number, pr.headSha) ?? (this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>).base;
    const files = this.changeFiles(this.d.repo, base, pr.headSha);
    const labels = (this.events(n).filter((e) => e.type === 'issue.seen').at(-1)?.payload as { labels?: string[] } | undefined)?.labels ?? [];
    const level = computeLevel({ files, labels, moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review);
    const exists = (p: string) => spawnSync('git', ['cat-file', '-e', `${base}:${p}`], { cwd: this.d.repo }).status === 0;
    const newTopLevel = [...new Set(files.map((f) => f.path.split('/')).filter((s) => s.length > 1).map((s) => s[0]!))].filter((d) => !exists(d)).map((d) => `${d}/`);
    // The verdict on this head, or on the head the harness's merge-ins of the default branch were made on.
    const judged = carriedHead(mergeIns, number, pr.headSha);
    const v = this.events(n).filter((e) => e.type === 'eval.verdict' && (e.payload as { head: string }).head === judged).at(-1)?.payload as EventPayload<'eval.verdict'> | undefined;
    const plan = (this.events(n).filter((e) => e.type === 'plan.posted').at(-1)?.payload as EventPayload<'plan.posted'> | undefined)?.plan as { files?: string[] } | undefined;
    let policyOn = false;
    try {
      policyOn = this.d.autoMerge?.() ?? false;
    } catch {
      // an unreadable policy is "off"
    }
    const d = mergeDecision({
      branch: pr.head,
      openedByHarness: this.openedByUs(number),
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
      claimedProtected: this.claimedClass(n) === 'protected',
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
    // A docs-only PR on the fast path is never batched: it merges like any PR outside a batch.
    const fast = this.checksPlan(n, pr.headSha).fast;
    const batching = this.prBatching() && !fast;
    const prior = this.d.log
      .read(0, ['merge.decided'])
      .map((e) => e.payload as EventPayload<'merge.decided'>)
      .filter((p) => p.number === number && p.head === pr.headSha)
      .at(-1);
    if (prior && !prior.auto) {
      // An owner's approval from a Discord thread at this very head: merged through the normal path below.
      const approved = mergeApproval(this.d.log, number, pr.headSha);
      if (approved) return this.mergeApproved(w, pr, approved.by);
      // Batching: the owner's approval (a review) merges it, on exactly the main its batch tested.
      if (batching && !this.emergencyInForce() && (await this.ownerApproved(w, pr))) await this.mergeTested(w, pr, 'approved');
      return; // otherwise already waiting for the owner
    }
    const d = this.mergeDecisionFor(n, number, pr);
    if (d.auto) {
      // The merge train put it off (behind its base under strict protection, or its base moved mid-merge): not before
      // its retry time. Behind is never a human's call, and never merged by merging the default branch in.
      if (this.mergeDeferred(number, pr.headSha)) return;
      if (isBehind(pr)) return this.deferMerge(w, pr, 'behind', `GitHub requires it up to date with ${this.branch} first (mergeable_state behind)`);
      // GitHub still computing: try again next poll, up to a cap. A conflict, or anything else blocking a clean merge: a human.
      if (pr.mergeableState === 'draft') return;
      // Decided on the light checks, but GitHub's ruleset still requires every required check: blocked until they pass.
      const hold = fast && pr.mergeableState === 'blocked' ? rulesetHold(requiredOutcomes(this.requiredChecks(), await this.headChecksOf(pr.headSha))) : { act: 'none' as const };
      if (hold.act === 'wait') return;
      if (hold.act === 'hold') d.reasons.push(hold.why);
      else if (pr.mergeable === null || pr.mergeableState === 'unknown') {
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
        const gate = batching ? 'merge' : await this.combinedGate(w, pr);
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
    if (!prior || prior.auto !== d.auto) this.emit('merge.decided', { issue: n, number, head: pr.headSha, auto: d.auto, reasons: d.reasons, ...(d.auto ? {} : { why: d.why }) });
    if (!d.auto) return this.waitForOwner(w, pr.headSha, d.reasons, d.advice);
    // Again right before merging: the combined gate can take minutes, and a stop raised meanwhile must hold the merge.
    if (this.emergencyInForce()) return;
    if (batching) return this.mergeTested(w, pr, 'auto');
    const m = await this.trainMerge(w, pr);
    if (!m) return;
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
    const ok = mayMerge({ events: events(), number, head: pr.headSha, checks: await this.headChecksOf(pr.headSha), fastChecks: this.d.cfg.tests.land.pr_batch.fast_checks });
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
    const m = await this.trainMerge(w, pr);
    if (!m) return;
    if (!m.ok) {
      this.emit('merge.failed', { issue: n, number, head: pr.headSha, why: m.why.slice(0, 500) });
      return;
    }
    this.emit('merge.done', { issue: n, number, head: pr.headSha, sha: m.sha, url: pr.url, title: pr.title });
    this.prPolled.clear(); // the next PR in the batch, and the other open PRs, on the next pass
    const what = how === 'approved' ? `Merged on your approval as \`${m.sha.slice(0, 8)}\`` : `Auto-merged as \`${m.sha.slice(0, 8)}\``;
    await this.d.backlog.comment(number, `[${BRAND.cli}] ${what} (a merge commit of \`${pr.headSha.slice(0, 8)}\` onto exactly the ${this.branch} its batch ${turn.batch} tested, full run included).`);
  }

  /**
   * An owner's approval from a Discord thread, of PR `number` waiting for an owner at `head` (src/coordinator/
   * channel.ts): the same checks as a merge, now, before anything is recorded: an open PR this instance opened,
   * waiting for an owner at exactly this head (unchanged since the decision), its required checks green on it, no
   * emergency stop and auto-merge not stopped (the main watch). Recorded through decide (approveMerge: an owner only,
   * audited via discord); the PR watch then looks at it on its next pass, where mergeApproved merges it.
   */
  protected async chatApproveMerge(number: number, head: string, who: ChatPerson): Promise<{ ok: true } | { ok: false; already?: { answer: string; by: string }; error?: string }> {
    const w = this.watchedPrs().find((p) => p.number === number);
    if (!w) return { ok: false, error: `#${number} isn't an open PR of this instance's` };
    const decided = this.d.log.read(0, ['merge.decided']).map((e) => e.payload as EventPayload<'merge.decided'>).filter((p) => p.number === number).at(-1);
    if (!decided || decided.auto) return { ok: false, error: `PR #${number} isn't waiting for an owner` };
    if (this.emergencyInForce()) return { ok: false, error: 'an emergency stop is in force; nothing is approved' };
    const stopped = this.autoMergeStopped();
    if (stopped) return { ok: false, error: `auto-merge is stopped on this instance (${stopped.slice(0, 200)}); an admin clears it on the dashboard first. Nothing is approved` };
    const pr = await this.d.backlog.pullRequest(number);
    if (pr.state !== 'open') return { ok: false, error: `PR #${number} is ${pr.state}` };
    if (pr.headSha !== head || decided.head !== head) return { ok: false, error: `the head of PR #${number} moved since the decision (${head.slice(0, 8)}, now ${pr.headSha.slice(0, 8)}); nothing is approved: the new head is decided afresh` };
    const batching = this.prBatching();
    const r = this.prReadiness(w.issue, head, await this.d.backlog.checks(head), batching ? this.d.cfg.tests.land.pr_batch.full_checks : []);
    if (!r.ready) return { ok: false, error: `PR #${number} isn't ready at ${head.slice(0, 8)}: ${r.reasons.join('; ').slice(0, 300) || 'its required checks are not all green'}` };
    const got = approveMerge(this.d.log, { issue: w.issue, number, head, who: { login: who.login, role: who.role!, via: 'discord' }, instance: this.d.instance, repo: this.d.cfg.project.project.repo });
    if (!got.ok) return got.status === 409 ? { ok: false, already: { answer: 'approve', by: got.by! } } : { ok: false, error: got.error };
    // No waiting: the PR watch looks at it on its very next pass.
    this.prPolled.delete(number);
    return { ok: true };
  }

  /**
   * Merge a PR an owner approved from Discord at this head, through the normal merge path: nothing under an emergency
   * stop or a stopped auto-merge; GitHub must say it merges cleanly; batching, exactly as tested (mergeTested); else
   * the combined check of main into it first, then GitHub's merge API pinned to the head (mergeOurs, which still
   * never merges a PR the harness didn't open or a revert). A hold is recorded once per head and reason.
   */
  private async mergeApproved(w: EventPayload<'pr.opened'>, pr: PullRequest, by: string) {
    const { issue: n, number } = w;
    const hold = (why: string) => {
      const said = this.d.log.read(0, ['merge.failed']).some((e) => (e.payload as EventPayload<'merge.failed'>).number === number && (e.payload as EventPayload<'merge.failed'>).head === pr.headSha && (e.payload as EventPayload<'merge.failed'>).why === why);
      if (!said) this.emit('merge.failed', { issue: n, number, head: pr.headSha, why });
    };
    if (this.emergencyInForce()) return;
    const stopped = this.autoMergeStopped();
    if (stopped) return hold(`approved by @${by}, but auto-merge is stopped: ${stopped}`.slice(0, 500));
    if (pr.mergeableState === 'draft' || pr.mergeable === null || pr.mergeableState === 'unknown') return; // GitHub still computing: next poll
    if (this.mergeDeferred(number, pr.headSha)) return;
    if (isBehind(pr)) return this.deferMerge(w, pr, 'behind', `approved by @${by}, but GitHub requires it up to date with ${this.branch} first (mergeable_state behind)`);
    if (!pr.mergeable || !['clean', 'unstable', 'has_hooks'].includes(pr.mergeableState)) return hold(`approved by @${by}, but GitHub can't merge it cleanly (${pr.mergeableState})`);
    if (this.prBatching()) return this.mergeTested(w, pr, 'approved');
    const gate = await this.combinedGate(w, pr);
    if (gate === 'pending') return;
    if (gate !== 'merge') return hold(`approved by @${by}, but ${gate === 'conflict' ? 'merging the default branch into it conflicts' : gate.hold}`.slice(0, 500));
    if (this.emergencyInForce() || this.autoMergeStopped()) return;
    const m = await this.trainMerge(w, pr);
    if (!m) return;
    if (!m.ok) {
      this.emit('merge.failed', { issue: n, number, head: pr.headSha, why: m.why.slice(0, 500) });
      return;
    }
    this.emit('merge.done', { issue: n, number, head: pr.headSha, sha: m.sha, url: pr.url, title: pr.title });
    this.prPolled.clear();
    await this.d.backlog.comment(number, `[${BRAND.cli}] Merged on @${by}'s approval (an owner, from Discord; audited) as \`${m.sha.slice(0, 8)}\`: a merge commit of the approved head \`${pr.headSha.slice(0, 8)}\`, its required checks green on it.`);
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

  /**
   * A PR that waits for the owner: the needs-owner label, one comment (the review packet, src/coordinator/
   * review-packet.ts: every reason, the risk class, the evaluator, the eval scores and the receipts, sized for a
   * phone), a review request. Called once per head and decision (mergeOrWait); it changes nothing about either.
   */
  private async waitForOwner(w: EventPayload<'pr.opened'>, head: string, reasons: string[], advice?: string) {
    const owner = this.ownerOf(w.issue);
    await this.d.backlog.addLabels(w.number, ['needs-owner']);
    const ask = this.prBatching()
      ? `waits for your review: approve it and ${BRAND.name} merges it onto exactly the ${this.branch} its full run tested (testing it again first if ${this.branch} moved). Merging it by hand skips that`
      : 'waits for you to review and merge';
    // The packet never costs the owner the comment or the review request: if building it throws, the plain comment
    // (every reason and the advice, still literal text), and the error is recorded.
    let body: string;
    try {
      body = reviewPacket({ owner, ask, head, reasons, advice, ...this.packetFacts(w, head) });
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: `review packet #${w.number}`, kind: 'error', message: String((e as Error)?.message ?? e).slice(0, 500) });
      body = `[${BRAND.cli}] @${owner} ready, and ${ask} (\`${head.slice(0, 8)}\`):\n${reasons.map((r) => `- ${lit(r)}`).join('\n')}${advice ? `\n\n**Evaluator's advice:** ${lit(advice, 1500)}` : ''}`;
    }
    await this.d.backlog.comment(w.number, body);
    try {
      await this.d.backlog.requestReview(w.number, [owner]);
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: `review request #${w.number}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    }
  }

  /**
   * What the review packet reports beside the wait reasons, read from the record (nothing here decides anything):
   * the risk class at this head (from its paths, as the PR body has it, raised never lowered by the worker's claim),
   * the latest verdict, the instruction evals and the latest check receipts. A fact it can't read is left out, never
   * a reason not to post.
   */
  private packetFacts(w: EventPayload<'pr.opened'>, head: string): Pick<PacketInput, 'risk' | 'verdict' | 'evals' | 'receipts'> {
    const n = w.issue;
    const last = <T>(type: string) => this.events(n).filter((e) => e.type === type).at(-1)?.payload as T | undefined;
    let risk: PacketInput['risk'] = null;
    try {
      const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
      const base = mergeInBase(this.mergeInsOf(), w.number, head) ?? last<EventPayload<'issue.claimed'>>('issue.claimed')!.base;
      const files = this.changeFiles(this.d.repo, base, head);
      const labels = last<{ labels?: string[] }>('issue.seen')?.labels ?? [];
      const level = computeLevel({ files, labels, moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review);
      const computed = riskClassOf({ paths: files.map((f) => f.path), level, waitCategories: waitCategoriesOf(review) });
      const cls = effectiveClass(computed.cls, this.claimedClass(n));
      risk = { cls, why: cls === computed.cls ? computed.why : [`raised from ${computed.cls} by the worker`, ...computed.why] };
    } catch {
      // unknown: the packet says so
    }
    const verdict = last<EventPayload<'eval.verdict'>>('eval.verdict');
    const checks = last<EventPayload<'check.result'>>('check.result');
    const doneWhen = (last<EventPayload<'contract.agreed'>>('contract.agreed')?.done_when ?? []) as DoneWhenList;
    const receipts = checks ? { checks: checks.checks, doneWhen, unverified: verdict?.unverified_claims ?? [], head: checks.head } : null;
    return { risk, verdict, evals: this.instructionResults(n), receipts };
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
      const required = this.requiredChecks();
      // WHY (#469): nothing to judge by is never "green": no result is recorded (the config_invalid incident and the
      // first-run step say why); a merge is never marked green with nothing checked.
      if (!required.length) continue;
      // No CI: every test_run tier (fast and full) runs on the merge commit, in the sandbox; judged from the log.
      if (ciIsNone(this.d.cfg.project)) this.startMainRuns(m.sha);
      // Failing checks are re-run on this same commit first (src/flaky.ts): passing then, they are flaky, quarantined,
      // and don't turn the branch red here; a quarantined check's failure doesn't either. Only the harness's own
      // decision changes: the checks on GitHub, and what the updater requires, stay as they are.
      const gate = await this.flakyGate.judge({ sha: m.sha, number: m.number, outcomes: requiredOutcomes(required, await this.headChecksOf(m.sha)) });
      if (gate.wait) continue;
      const outcomes = gate.outcomes;
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
      this.emit('merge.main_result', { issue: m.issue, number: m.number, sha: m.sha, outcome: failed.length ? 'red' : 'green', failed, ...(gate.flaky.length ? { flaky: gate.flaky } : {}), ...(gate.quarantined.length ? { quarantined: gate.quarantined } : {}) });
      if (failed.length) await this.mainWentRed(m, failed);
    }
  }

  /** No CI: merge commits whose tier runs this process started (or found already queued in the log). */
  private readonly mainRuns = new Set<string>();

  /**
   * No CI (#469): run every test_run tier, fast and full, on merge commit `sha` in the sandbox, once (a restart finds
   * them queued in the log). Their results land in the event log as testrun.finished, which is all main is judged by.
   * Held at the start gate, or test runs off: nothing starts now, the next poll tries again, and the main check's
   * timeout says so if it never can.
   */
  private startMainRuns(sha: string) {
    if (this.mainRuns.has(sha)) return;
    if (this.d.log.read(0, ['testrun.queued']).some((e) => (e.payload as EventPayload<'testrun.queued'>).sha === sha)) {
      this.mainRuns.add(sha);
      return;
    }
    const tr = this.liveTestRuns;
    if (!tr) return;
    const tiers = (this.d.cfg.tests.test_run?.tiers ?? []).map((t) => t.name);
    if (!tiers.length) return;
    this.mainRuns.add(sha);
    void (async () => {
      try {
        this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
        // Every tier, fast and full, in one run (as the deploy gate's post-merge run asks for them).
        await tr.startTestRun({ repo: this.d.repo, sha, kind: 'full', prs: [], tiers });
      } catch (e) {
        // Held, or failed to start: try again on a later poll.
        this.mainRuns.delete(sha);
        if (!(e instanceof TestRunHeld)) this.emit('coordinator.error', { instance: this.d.instance, where: `No CI runs on ${sha.slice(0, 8)}`, kind: 'error', message: (e as Error).message.slice(0, 500) });
      }
    })();
  }

  /** A real red after auto-merging `m`: fix-forward takes it (coordinator/fix-forward.ts), unless the branch was red already. */
  private async mainWentRed(m: EventPayload<'merge.done'>, failed: string[]) {
    await this.fixForward.start({ sha: m.sha, number: m.number, failed });
  }

  private get stopResume() {
    return `Auto-merge is stopped on this instance until the operator deletes \`${this.stopFile}\`; until then every PR waits for you.`;
  }

  /** Who is told about a red default branch: the owner of the issue behind one of `shas` (a harness merge), else the default owner. */
  private redOwner(...shas: string[]): string {
    const m = this.d.log.read(0, ['merge.done']).map((e) => e.payload as EventPayload<'merge.done'>).find((p) => shas.includes(p.sha));
    return m ? this.ownerOf(m.issue) : this.d.cfg.project.owners.default;
  }

  private stopFor(reason: string, number: number | null, sha: string, revert: string | null) {
    writeGroupOnly(this.stopFile, JSON.stringify({ reason, number, sha, revert, at: new Date().toISOString() }, null, 2));
    this.emit('merge.stopped', { reason, number, sha, revert });
  }

  /**
   * Fix-forward reverts the culprit: a revert PR (git revert -m 1 on the current tip, through the push checks; never
   * watched, never auto-merged) with the evidence, auto-merge stopped until the operator clears it, and the owner told
   * on the PR that went red, the culprit's PR and the revert.
   */
  private async fixForwardRevert(o: { ep: Episode; culprit: string; number: number | null; title: string; evidence: string }): Promise<{ url: string; number: number } | null> {
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const s = o.ep.started;
    const c = `${o.number ? `#${o.number} ` : ''}(\`${o.culprit.slice(0, 8)}\`)`;
    const title = o.number ? `Revert "${o.title}" (#${o.number})` : `Revert ${o.culprit.slice(0, 8)} (culprit of ${this.branch} going red)`;
    const body = `Reverts ${c}: after it, ${this.branch}'s required checks failed: ${s.failed.join(', ')}.\n\n${o.evidence}\n\nOpened by ${BRAND.name}. It never merges this; a human does.`;
    let revert: { url: string; number: number } | null = null;
    let why = '';
    try {
      const r = await this.openRevertOf(o.culprit, o.number ? `pr-${o.number}` : o.culprit.slice(0, 12), title, body);
      if ('why' in r) why = r.why;
      else revert = r;
    } catch (e) {
      why = (e as Error).message.slice(0, 500);
      this.emit('coordinator.error', { instance: this.d.instance, where: `fix-forward revert ${o.culprit.slice(0, 8)}`, kind: 'error', message: why });
    }
    const what = `${this.branch}'s required checks failed (${s.failed.join(', ')}) on \`${s.sha.slice(0, 8)}\`${s.number ? ` after auto-merging #${s.number}` : ''}; the culprit is ${c}`;
    const reason = `${what}${revert ? `; revert PR ${revert.url}` : `; opening a revert PR failed${why ? `: ${redactString(why).replace(/\s+/g, ' ')}` : ''}`}`;
    this.stopFor(reason, s.number, s.sha, revert?.url ?? null);
    const owner = this.redOwner(o.culprit, s.sha);
    for (const n of new Set([s.number, o.number].filter((x): x is number => x !== null))) await this.d.backlog.comment(n, `[${BRAND.cli}] @${owner} ${reason}. ${this.stopResume}`);
    if (revert) {
      await this.d.backlog.addLabels(revert.number, ['needs-owner']);
      await this.d.backlog.comment(revert.number, `[${BRAND.cli}] @${owner} reverts ${c}: ${what}. This revert waits for you; it never merges itself. ${this.stopResume}`);
      try {
        await this.d.backlog.requestReview(revert.number, [owner]);
      } catch (e) {
        this.emit('coordinator.error', { instance: this.d.instance, where: `review request #${revert.number}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
      }
    }
    return revert;
  }

  /** Fix-forward can neither fix nor revert: auto-merge stopped until the operator clears it, and the owner told. */
  private async fixForwardGaveUp(ep: Episode, why: string) {
    const s = ep.started;
    const reason = `${this.branch}'s required checks failed (${s.failed.join(', ')}) on \`${s.sha.slice(0, 8)}\`${s.number ? ` after auto-merging #${s.number}` : ''}, but ${why}`;
    this.stopFor(reason, s.number, s.sha, null);
    if (s.number) await this.d.backlog.comment(s.number, `[${BRAND.cli}] @${this.redOwner(s.sha)} ${reason}. ${this.stopResume}`);
  }

  /**
   * One ops post (intake.yaml discord.ops_channel), once per key, within the machine-wide limit of ops posts
   * (watchdog/post.ts takeOpsPost): sent (or had been), limited (a later pass tries again), off (nowhere to post).
   */
  private async opsPost(key: string, text: string): Promise<'sent' | 'limited' | 'off'> {
    if (this.postedKeys().has(key)) return 'sent';
    const cfg = this.d.intake?.config() ?? null;
    const src = this.chatSource();
    if (!cfg?.discord.enabled || !cfg.discord.ops_channel || !src) return 'off';
    if (!takeOpsPost({ ...(this.d.slotsDir ? { dir: this.d.slotsDir } : {}) })) return 'limited';
    await this.channelSend(src, key, { channel: cfg.discord.ops_channel }, { kind: 'notice', text });
    return 'sent';
  }

  /**
   * A revert PR of commit `sha` on the current tip (`-m 1` for a merge commit), on `<cli>/revert-<name>`, through the
   * push checks; with `range` (revertRange), one commit reverting all of them instead. The merge policy never
   * auto-merges a revert branch (neverAutoMerge), and it is never watched. `why`: it could not be opened, and why.
   */
  private async openRevertOf(sha: string, name: string, title: string, body: string, range: string[] | null = null): Promise<{ url: string; number: number } | { why: string }> {
    const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const dir = join(this.d.stateDir, 'reverts', name);
    const branch = `${REVERT_BRANCH_PREFIX}${name}`;
    const as = ['-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`];
    const failed = (why: string) => {
      this.emit('coordinator.error', { instance: this.d.instance, where: `revert ${name}`, kind: 'error', message: why.slice(0, 500) });
      return { why: why.slice(0, 500) };
    };
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.d.repo });
    try {
      this.git(this.d.repo, 'worktree', 'add', '-q', '--detach', dir, tip);
      const parents = this.git(this.d.repo, 'rev-list', '--parents', '-n', '1', sha).split(' ').length - 1;
      // A range: newest first (git revert's order), into one commit (no pre-commit or commit-msg hook, as git revert itself).
      const rv = range
        ? spawnSync('git', [...as, 'revert', '--no-commit', `${range[0]}^..${range.at(-1)}`], { cwd: dir, encoding: 'utf8' })
        : spawnSync('git', [...as, 'revert', ...(parents > 1 ? ['-m', '1'] : []), '--no-edit', sha], { cwd: dir, encoding: 'utf8' });
      const done = rv.status === 0 && range ? spawnSync('git', [...as, 'commit', '-q', '--no-verify', '-m', `${title}\n\nThis reverts commits ${range[0]}^..${range.at(-1)}.`], { cwd: dir, encoding: 'utf8' }) : rv;
      if (done.status !== 0) {
        const lines = `${done.stdout ?? ''}\n${done.stderr ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
        const conflicts = lines.filter((l) => l.startsWith('CONFLICT'));
        const what = `git revert of ${range && range.length > 1 ? `${range[0]!.slice(0, 8)}..${range.at(-1)!.slice(0, 8)}` : sha.slice(0, 8)} on ${this.branch}'s tip ${tip.slice(0, 8)}`;
        return failed(conflicts.length ? `${what} conflicts with later commits: ${conflicts.slice(0, 5).join('; ')}` : `${what} failed: ${lines.find((l) => /^(error|fatal):/.test(l)) ?? lines.at(-1) ?? `exit ${done.status}`}`);
      }
      const head = this.git(dir, 'rev-parse', 'HEAD');
      const push = checkedPush({ cwd: dir, remote: this.remote, base: tip, head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, guard: this.pushGuard(), force: true });
      if (!push.ok) return failed('refused' in push ? `the push checks refused the revert branch: ${push.refused.join('; ')}` : `pushing the revert branch failed: ${push.error}`);
      const pr = await this.d.backlog.openPr(branch, this.branch, title, body, { headSha: head });
      return { url: pr.url, number: pr.number };
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.d.repo });
      spawnSync('git', ['worktree', 'prune'], { cwd: this.d.repo });
    }
  }

  // ---------------------------------------------------------------- main watch

  private mainWatcher: MainWatch | null = null;

  /** The main watch's state: its mode, the last commit it checked, the call it is waiting on (src/main-watch.ts). */
  protected get mainWatchFile() {
    return join(this.d.stateDir, 'main-watch.json');
  }

  /**
   * The default branch with no protection on GitHub: check each new commit on it (at most one API call a minute).
   * PR mode only: with land_mode direct, the harness lands by pushing the default branch itself.
   */
  protected async watchMain() {
    const w = this.d.mainWatch;
    if (!w) return;
    this.mainWatcher ??= new MainWatch({
      stateFile: this.mainWatchFile,
      branch: this.branch,
      required: () => this.d.cfg.project.required_checks,
      // No CI: the watch is off, and says what that means (src/ci-none.ts).
      offWhy: () => (ciIsNone(this.d.cfg.project) ? CI_NONE_MAIN_WATCH : null),
      api: w.api,
      git: repoGit(this.d.repo, this.remote, this.branch),
      harnessMerge: (sha) => {
        const e = this.d.log.read(0, ['merge.done']).find((x) => (x.payload as EventPayload<'merge.done'>).sha === sha);
        if (!e) return null;
        const m = e.payload as EventPayload<'merge.done'>;
        return { number: m.number, head: m.head, at: e.ts };
      },
      ...(w.now ? { now: w.now } : {}),
      mode: (mode, detail) => this.emit('main_watch.mode', { mode, detail }),
      checked: (sha, how, number) => this.emit('main_watch.checked', { sha, how, number }),
      accepted: (sha, number, a) => this.emit('main_watch.accepted', { sha, how: 'accepted', number, id: a.id, by: a.by, reason: a.reason.slice(0, 500) }),
      unaccounted: (o) => this.mainUnaccounted(o),
      deadCheckMs: () => this.d.cfg.project.main_watch.dead_check_days * 24 * 3600_000,
      deadCheck: (o) => this.emit('main_watch.dead_check', o),
    });
    // A direct push's alert that couldn't go yet (the ops posts' limit was reached): try again.
    await this.directPushOutbound();
    await this.deadCheckOutbound();
    if (this.d.cfg.project.land_mode !== 'pr') return this.mainWatcher.off(`land_mode direct: the harness lands by pushing ${this.branch} itself`);
    if ((w.setting?.() ?? 'auto') === 'off') return this.mainWatcher.off('turned off in the instance policy (main_watch: off)');
    await this.mainWatcher.step();
  }

  /**
   * A commit on the default branch nothing accounts for: stop auto-merge at once (the stop file, until an admin clears
   * it on the dashboard), then alert (main_watch.unaccounted: the dashboard; the asks channel posts it) and open a revert
   * PR for a human, unless a cap on revert PRs says not to (revertCapped). Once per commit, even across a restart.
   */
  private async mainUnaccounted(o: Parameters<MainWatchDeps['unaccounted']>[0]) {
    const before = this.d.log.read(0, ['main_watch.unaccounted']);
    if (before.some((e) => (e.payload as EventPayload<'main_watch.unaccounted'>).sha === o.sha)) return;
    const url = `https://github.com/${this.d.cfg.project.project.repo}/commit/${o.sha}`;
    const reason = `main watch: ${o.reason}`;
    if (!existsSync(this.stopFile)) writeGroupOnly(this.stopFile, JSON.stringify({ reason, by: 'main_watch', number: o.number, sha: o.sha, revert: null, at: new Date().toISOString() }, null, 2));
    this.emit('merge.stopped', { reason, number: o.number, sha: o.sha, revert: null });
    // Landed without a PR: the ops channel hears of it now, before the revert PR is made.
    if (o.push) await this.directPushNoted(o.sha, url, o.push);
    let revert: { url: string; number: number } | null = null;
    let through: string | null = null;
    let failed: string | null = null;
    const capped = o.revert && o.trip ? this.revertCapped(o.sha, o.trip, before) : null;
    if (o.revert && !capped) {
      try {
        // A rebase-merged PR's commits: one revert of them all, so a later one that edits the same files can't conflict.
        const range = o.through ? this.revertRange(o.sha, o.through.sha, o.through.commits) : null;
        const what = range ? `the ${range.length} commits${o.number ? ` of #${o.number}` : ''} from \`${o.sha.slice(0, 8)}\` through \`${range.at(-1)!.slice(0, 8)}\`` : `\`${o.sha.slice(0, 8)}\``;
        const title = range ? `Revert ${o.sha.slice(0, 8)}..${range.at(-1)!.slice(0, 8)} (${o.number ? `#${o.number}, ` : ''}${range.length} commits, unaccounted on ${this.branch})` : `Revert ${o.sha.slice(0, 8)} (unaccounted on ${this.branch})`;
        const body = `Reverts ${what} on ${this.branch} (${url}): ${o.reason}.\n\nOpened by ${BRAND.name}'s main watch, which guards ${this.branch} where GitHub doesn't. It never merges this; a human approves and merges it. Auto-merge is stopped on this instance until an admin clears it on the dashboard.`;
        const r = await this.openRevertOf(o.sha, o.sha.slice(0, 12), title, body, range);
        if ('why' in r) failed = r.why;
        else {
          revert = r;
          through = range ? range.at(-1)! : null;
          await this.d.backlog.addLabels(revert.number, ['needs-owner']);
          await this.d.backlog.requestReview(revert.number, [this.d.cfg.project.owners.default]).catch(() => undefined);
        }
      } catch (e) {
        if (!revert) failed = (e as Error).message;
        this.emit('coordinator.error', { instance: this.d.instance, where: `main watch revert ${o.sha.slice(0, 8)}`, kind: 'error', message: (e as Error).message.slice(0, 500) });
      }
    }
    // Why there is no revert PR, whenever there is none: a cap, its failure, or a rewrite (no commit to revert).
    const none = capped ?? (revert ? null : o.revert ? `opening the revert PR failed: ${failed ?? 'no reason was given'}` : `${this.branch} was rewritten: there is no commit to revert`);
    const noRevert = none === null ? null : redactString(none).replace(/\s+/g, ' ').slice(0, 1000);
    this.emit('main_watch.unaccounted', { sha: o.sha, url, reason: o.reason.slice(0, 1000), number: o.number, revert: revert?.url ?? null, ...(o.trip ? { trip: o.trip.id } : {}), no_revert: noRevert, ...(through ? { revert_through: through } : {}) });
  }

  /**
   * The commits from `sha` through `through`, oldest first, when they are one straight line of single-parent commits
   * on the default branch's tip, no more than the PR has (`commits`) and at most 250 (GitHub's limit on a rebase
   * merge): a rebase-merged PR's. Null otherwise, and the revert is of `sha` alone, as before.
   */
  private revertRange(sha: string, through: string, commits: number): string[] | null {
    const tip = `${this.remote}/${this.branch}`;
    if (spawnSync('git', ['merge-base', '--is-ancestor', through, tip], { cwd: this.d.repo }).status !== 0) return null;
    // Parents before children whatever the commit dates say, so only the checks below decide.
    const r = spawnSync('git', ['rev-list', '--topo-order', '--parents', '--reverse', `${sha}^..${through}`], { cwd: this.d.repo, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const rows = r.stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
    if (rows.length < 2 || rows.length > Math.min(commits, 250) || rows[0]![0] !== sha || rows.at(-1)![0] !== through) return null;
    if (rows.some((x, i) => x.length !== 2 || (i > 0 && x[1] !== rows[i - 1]![0]))) return null;
    return rows.map((x) => x[0]!);
  }

  /** Whether `a` is `b` or an ancestor of it, in the clone. */
  private isAncestor(a: string, b: string) {
    return spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: this.d.repo }).status === 0;
  }

  /**
   * Why an unaccounted commit gets no revert PR of its own (null: it gets one). Per trip: the trip has its revert PR(s)
   * already; the alert names them and the trip's commits, and says so when one of them reverts this commit too (a
   * range, revert_through). Per day: this instance's main watch opened so many in the last 24 hours. Counted from the
   * log (`before`), so both hold across a restart.
   */
  private revertCapped(sha: string, trip: Trip, before: StoredEvent[]): string | null {
    const now = this.d.mainWatch?.now?.() ?? Date.now();
    const all = before.map((e) => ({ ts: e.ts, p: e.payload as EventPayload<'main_watch.unaccounted'> }));
    const mine = all.filter((x) => x.p.trip === trip.id).map((x) => x.p);
    const prs = mine.flatMap((p) => (p.revert ? [p.revert] : []));
    const cover = mine.find((p) => p.revert && p.revert_through && this.isAncestor(p.sha, sha) && this.isAncestor(sha, p.revert_through));
    const covers = cover ? `this trip's revert PR ${cover.revert} reverts this commit too (${cover.sha.slice(0, 8)}..${cover.revert_through!.slice(0, 8)})` : null;
    const list = [...mine.map((p) => p.sha), sha].map((x) => x.slice(0, 8));
    const commits = `${list.slice(0, 20).join(', ')}${list.length > 20 ? ` and ${list.length - 20} more` : ''}`;
    if (prs.length >= trip.perTrip) return `the per-trip cap is reached (main_watch.revert_prs_per_trip: ${trip.perTrip}): ${covers ?? `this trip's revert PR ${prs.join(', ')}`}; the trip's commits so far: ${commits}`;
    if (covers) return `${covers}; the trip's commits so far: ${commits}`;
    const day = all.filter((x) => x.p.revert && now - Date.parse(x.ts) < 24 * 3600_000).length;
    if (day >= trip.perDay) return `the per-day cap is reached (main_watch.revert_prs_per_day: ${trip.perDay}): the main watch opened ${day} revert PRs in the last 24 hours`;
    return null;
  }

  /**
   * Each dead check raised (main_watch.dead_check) and not cleared since: one ops post, once per check and since;
   * one more when it clears. What is over the ops posts' limit waits for a later pass.
   */
  protected async deadCheckOutbound() {
    const last = new Map<string, EventPayload<'main_watch.dead_check'>>();
    for (const e of this.d.log.read(0, ['main_watch.dead_check'])) last.set((e.payload as EventPayload<'main_watch.dead_check'>).check, e.payload as EventPayload<'main_watch.dead_check'>);
    for (const d of last.values()) {
      const text =
        d.state === 'raised'
          ? `Main watch: the required check "${d.check}" has had no run on any commit judged since ${d.since}. Merges into ${this.branch} keep tripping the watch until it posts, or until it leaves required_checks in config.yaml.`
          : `Main watch: the required check "${d.check}" has a run again, or is no longer required: its dead-check warning is cleared.`;
      const key = (state: string) => `main-watch-dead-check:${state}:${d.check}:${d.since}`;
      // Cleared before its warning went out: nothing to clear in the channel.
      if (d.state === 'cleared' && !this.postedKeys().has(key('raised'))) continue;
      if ((await this.opsPost(key(d.state), text)) === 'limited') return;
    }
  }

  /**
   * A commit that landed without a PR (src/direct-push-alert.ts): who pushed it (one API call: a GitHub login, never
   * an email) and its subject (git), recorded once (main_watch.direct_push); then its ops post, unless turned off.
   */
  private async directPushNoted(sha: string, url: string, push: { kind: 'direct' | 'rewrite'; alert: boolean }) {
    if (this.d.log.read(0, ['main_watch.direct_push']).some((e) => (e.payload as EventPayload<'main_watch.direct_push'>).sha === sha)) return;
    let who: { login: string; from: 'activity' | 'commit' } | null = null;
    try {
      who = (await this.d.mainWatch?.api.pusher?.(this.branch, sha)) ?? null;
    } catch {
      who = null;
    }
    const s = spawnSync('git', ['log', '-1', '--format=%s', sha], { cwd: this.d.repo, encoding: 'utf8' });
    const subject = redactString(s.status === 0 ? s.stdout.trim() : '').slice(0, 300);
    this.emit('main_watch.direct_push', { sha, url, kind: push.kind, pusher: who?.login ?? null, pusher_from: who?.from ?? null, subject, alert: push.alert });
    await this.directPushOutbound();
  }

  /**
   * Post each direct push's alert not posted yet to the ops channel, once per commit, mentioning the Discord owners,
   * within the machine-wide limit of ops posts (what is over it waits for a later pass). Turned off (`alert` false):
   * never posted. No ops channel: not posted, and the dashboard says why (recorded once).
   */
  protected async directPushOutbound() {
    const pushes = this.d.log.read(0, ['main_watch.direct_push']).map((e) => e.payload as EventPayload<'main_watch.direct_push'>).filter((p) => p.alert);
    if (!pushes.length) return;
    const posted = this.postedKeys();
    const noted = new Set(this.d.log.read(0, ['main_watch.direct_push_alert']).map((e) => (e.payload as EventPayload<'main_watch.direct_push_alert'>).sha));
    const cfg = this.d.intake?.config() ?? null;
    const target = alertTarget(cfg);
    const src = this.chatSource();
    for (const p of pushes) {
      if (posted.has(directPushKey(p.sha))) continue;
      if ('why' in target || !src || !cfg) {
        const why = 'why' in target ? target.why : 'the Discord bot is not connected';
        if (!noted.has(p.sha)) this.emit('main_watch.direct_push_alert', { sha: p.sha, ok: false, mentioned: 0, note: `not posted: ${why}` });
        noted.add(p.sha);
        continue;
      }
      if (!takeOpsPost({ ...(this.d.slotsDir ? { dir: this.d.slotsDir } : {}) })) return;
      const { mentions, note } = ownerMentions(cfg);
      await this.channelSend(src, directPushKey(p.sha), { channel: target.channel }, { kind: 'notice', text: directPushText(p, { branch: this.branch, dashboardUrl: target.dashboardUrl }), ...(mentions.length ? { mentions } : {}) });
      const ok = this.d.log.read(0, ['discord.posted']).some((e) => (e.payload as EventPayload<'discord.posted'>).key === directPushKey(p.sha) && (e.payload as EventPayload<'discord.posted'>).ok);
      this.emit('main_watch.direct_push_alert', { sha: p.sha, ok, mentioned: ok ? mentions.length : 0, note: ok ? note : 'not posted: Discord refused the post (it is not sent again)' });
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

  /** The worker's own risk class for the issue's change (worker.claims), if it gave one. */
  private claimedClass(n: number) {
    return (this.events(n).filter((e) => e.type === 'worker.claims').at(-1)?.payload as EventPayload<'worker.claims'> | undefined)?.risk_class;
  }

  /**
   * The required checks the harness's own merge call waits on at this head: every one, or for a docs-only change
   * (its paths, raised by the worker's claim) the light ones, review.yaml docs_only_checks (src/pr-rules.ts).
   */
  protected checksPlan(n: number, head: string): { checks: string[]; fast: boolean } {
    const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
    const required = this.requiredChecks();
    if (!review.docs_only_checks.length) return { checks: required, fast: false };
    const claimed = this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)?.payload as EventPayload<'issue.claimed'> | undefined;
    if (!claimed) return { checks: required, fast: false };
    const files = this.changeFiles(this.d.repo, claimed.base, head);
    const labels = (this.events(n).filter((e) => e.type === 'issue.seen').at(-1)?.payload as { labels?: string[] } | undefined)?.labels ?? [];
    const level = computeLevel({ files, labels, moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review);
    const cls = effectiveClass(riskClassOf({ paths: files.map((f) => f.path), level, waitCategories: waitCategoriesOf(review) }).cls, this.claimedClass(n));
    return checksFor({ cls, required, docsOnlyChecks: review.docs_only_checks });
  }

  /**
   * The readiness of an issue's PR at `head`, against the latest evaluator verdict for the issue; `except`: required
   * checks left out. A verdict on the head the harness merged the default branch into (a clean stale-PR merge-in,
   * src/pr-hygiene.ts) holds for the merge-in; its required checks still have to pass on it.
   */
  prReadiness(n: number, head: string, checks: CommitCheck[], except: string[] = []): Readiness {
    const v = this.events(n).filter((e) => e.type === 'eval.verdict').at(-1)?.payload as EventPayload<'eval.verdict'> | undefined;
    const judged = v && carriedHead(this.mergeInsOf(), null, head) === v.head ? head : v?.head;
    // No CI (src/ci-none.ts): the test-run checks from this instance's event log, never GitHub's of the same name.
    const judgedChecks = headChecks({ project: this.d.cfg.project, tests: this.d.cfg.tests, github: checks, events: () => this.testRunEvents(), sha: head });
    return readiness({ required: this.requiredChecks().filter((c) => !except.includes(c)), checks: judgedChecks, head, evaluated: v ? { head: judged!, approved: v.patch_correct } : null });
  }

  /** The checks a PR must pass: config.yaml required_checks, or under No CI every test-run tier's check (src/ci-none.ts). */
  protected requiredChecks(): string[] {
    return requiredFor(this.d.cfg.project, this.d.cfg.tests);
  }

  /** The checks on a PR's head as the merge policy judges them: GitHub's, or under No CI the event log's test runs in place of any of their names. */
  protected async headChecksOf(sha: string): Promise<CommitCheck[]> {
    return headChecks({ project: this.d.cfg.project, tests: this.d.cfg.tests, github: await this.d.backlog.checks(sha), events: () => this.testRunEvents(), sha });
  }

  /** The test runs' own records in this instance's event log: what No CI judges by. */
  private testRunEvents() {
    return this.d.log.read(0, ['testrun.queued', 'testrun.finished']);
  }

  /** The stale-PR merge-ins this instance pushed (pr_hygiene.merged_in), oldest first. */
  protected mergeInsOf(): MergeIn[] {
    return this.d.log.read(0, ['pr_hygiene.merged_in']).map((e) => e.payload as EventPayload<'pr_hygiene.merged_in'>);
  }
}
