// The stale PR pass on the coordinator's timer (src/pr-hygiene.ts has the decisions): every pr_hygiene.every_hours,
// over the open PRs this instance opened (watchedPrs: a person's PR is never among them). The git work happens in a
// scratch worktree of the coordinator's clone; the only push is checkedPush to the PR's own branch, pinned to the
// head it read (never over someone else's push, never the default branch). Nothing runs under an emergency stop.
import { spawnSync } from '../os/child-process.js';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import type { PullRequest } from '../backlog/types.js';
import { conflictTrigger } from '../conflicts.js';
import type { EventPayload } from '../events/types.js';
import { abortMerge, mergeBaseInto } from '../merge-base.js';
import { shownPaths } from '../path-text.js';
import { abandoned, carriedHead, countsOf, daysBetween, heldReasons, HYGIENE_MARKER, hygieneDue, isStale, lastActivity, supersededBy, type HygieneCounts, type HygieneResult } from '../pr-hygiene.js';
import { checkedPush } from '../push-check.js';
import { unlockWorktree, WORKTREE_LOCK_REASON } from '../worktrees.js';
import { Gardener } from './gardener.js';

export abstract class PrHygiene extends Gardener {
  /** The pass's clock (tests move it). */
  protected hygieneNow: () => number = () => (this.d.now?.() ?? new Date()).getTime();

  /** Run the pass when it is due (PR mode, turned on, and no emergency stop). */
  async checkPrHygiene(): Promise<HygieneCounts | null> {
    const cfg = this.d.cfg.project.pr_hygiene;
    if (!cfg.enabled || this.d.cfg.project.land_mode !== 'pr') return null;
    const last = this.d.log.read(0, ['pr_hygiene.pass']).at(-1)?.ts ?? null;
    if (!hygieneDue(last, this.hygieneNow(), cfg.every_hours)) return null;
    return this.prHygienePass();
  }

  /** One pass over every open PR this instance opened; records and returns the counts. */
  async prHygienePass(): Promise<HygieneCounts | null> {
    // Nothing is updated or closed under an emergency stop or while shutting down; the pass runs once it lifts.
    if (this.emergencyInForce() || this.halt.signal.aborted || this.stopped) return null;
    const results: HygieneResult[] = [];
    for (const w of this.watchedPrs()) {
      let r: HygieneResult | null;
      try {
        r = await this.hygieneFor(w);
      } catch (e) {
        r = { number: w.number, outcome: 'skipped', why: `failed: ${(e as Error).message.slice(0, 300)}` };
      }
      if (r) results.push({ ...r, why: r.why.slice(0, 500) });
    }
    const counts = countsOf(results);
    this.emit('pr_hygiene.pass', { ...counts, prs: results });
    return counts;
  }

  private async hygieneFor(w: EventPayload<'pr.opened'>): Promise<HygieneResult | null> {
    const cfg = this.d.cfg.project.pr_hygiene;
    const { issue: n, number } = w;
    const skip = (why: string): HygieneResult => ({ number, outcome: 'skipped', why });
    const pr = await this.d.backlog.pullRequest(number);
    if (pr.state !== 'open') return null; // the PR watch records it closed
    if (this.active.has(n)) return skip('a run is working on it');
    // Waiting on a person: never updated, never closed.
    const decided = this.d.log
      .read(0, ['merge.decided'])
      .map((e) => e.payload as EventPayload<'merge.decided'>)
      .filter((p) => p.number === number)
      .at(-1);
    const held = heldReasons({ labels: (await this.d.backlog.get(number)).labels, holdLabels: cfg.hold_labels, waitsOwner: !!decided && !decided.auto && decided.head === pr.headSha, head: pr.headSha, ourHead: this.ourHead(number) });
    if (held.length) return { number, outcome: 'held', why: held.join('; ') };
    if (this.prBatching() && this.inPrBatch(number)) return skip('it is in a PR batch');
    const now = this.hygieneNow();

    // Abandoned: its task closed or superseded, and quiet for abandon_after_days.
    const task = await this.d.backlog.get(n);
    const later = supersededBy(this.d.log.read(0, ['pr.opened']).map((e) => e.payload as EventPayload<'pr.opened'>), w);
    if (task.state === 'closed' || later !== null) {
      this.git(this.d.repo, 'fetch', '-q', this.remote, `+refs/heads/${pr.head}:refs/remotes/${this.remote}/${pr.head}`);
      const own = carriedHead(this.mergeInsOf(), number, pr.headSha);
      const commitAtMs = Number(this.git(this.d.repo, 'log', '-1', '--format=%ct', own)) * 1000;
      const activity = lastActivity({ commitAtMs, comments: await this.d.backlog.comments(number), reviewsAt: (await this.d.backlog.reviews(number)).map((r) => r.at) });
      const a = abandoned({ taskClosed: task.state === 'closed', supersededBy: later, lastActivityMs: activity, nowMs: now, abandonDays: cfg.abandon_after_days, task: n });
      if (!a.abandoned) return skip(a.why);
      await this.d.backlog.comment(number, `${HYGIENE_MARKER}\n[${BRAND.cli}] Closing this PR as abandoned: ${a.why}. The branch \`${pr.head}\` is kept; reopen the PR to pick it up again.`);
      await this.d.backlog.close(number);
      this.emit('pr_hygiene.closed', { issue: n, number, head: pr.headSha, why: a.why.slice(0, 1000) });
      this.emit('pr.closed', { issue: n, number, merged: false });
      return { number, outcome: 'closed', why: a.why };
    }

    // Stale: the merge base with the default branch is older than stale_after_days.
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch, `+refs/heads/${pr.head}:refs/remotes/${this.remote}/${pr.head}`);
    const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const mb = this.git(this.d.repo, 'merge-base', pr.headSha, tip);
    const baseAtMs = Number(this.git(this.d.repo, 'log', '-1', '--format=%ct', mb)) * 1000;
    const days = daysBetween(baseAtMs, now);
    if (mb === tip) return skip(`already up to date with ${this.branch}`);
    if (!isStale(baseAtMs, now, cfg.stale_after_days)) return skip(`its base is ${days} day(s) old, not over ${cfg.stale_after_days}`);

    const conflict = conflictTrigger(pr);
    if (conflict.act === 'recheck') return skip(conflict.why);
    if (conflict.act === 'fix') {
      // The existing conflict path: a fix run within its cap, or the needs-owner label and one comment.
      await this.maybeFixConflict(w, pr);
      return { number, outcome: 'conflicting', why: `conflicts with ${this.branch}; handed to the conflict fix` };
    }
    return this.mergeIn(w, pr, tip, days);
  }

  /** Whether PR `number` waits in the batch queue or is in an open batch: a new head would cancel its run. */
  private inPrBatch(number: number): boolean {
    const st = this.prBatch.state();
    return st.queue.some((q) => q.number === number) || [...st.batches.values()].some((b) => b.open && b.prs.some((p) => p.number === number));
  }

  /** Merge the default branch at `tip` into the PR's head and push it to the PR's branch (pinned to the head read). */
  private async mergeIn(w: EventPayload<'pr.opened'>, pr: PullRequest, tip: string, days: number): Promise<HygieneResult> {
    const { issue: n, number } = w;
    const dir = join(this.d.stateDir, 'pr-hygiene', `pr-${number}`);
    const clean = () => {
      unlockWorktree(this.d.repo, dir);
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.d.repo });
      spawnSync('git', ['worktree', 'prune'], { cwd: this.d.repo });
    };
    clean();
    try {
      this.git(this.d.repo, 'worktree', 'add', '-q', '--detach', dir, pr.headSha);
      // Locked against a prune run inside an agent's sandbox, where it is hidden (src/worktrees.ts WORKTREE_LOCK_REASON).
      this.git(this.d.repo, 'worktree', 'lock', '--reason', WORKTREE_LOCK_REASON, dir);
      const id = this.identity;
      const message = `Merge ${this.branch} into ${pr.head}\n\nIts base was ${days} day(s) old (pr_hygiene.stale_after_days: ${this.d.cfg.project.pr_hygiene.stale_after_days}); merged so CI runs again on the current ${this.branch}.\n\nSigned-off-by: ${id.name} <${id.email}>`;
      const m = mergeBaseInto(dir, tip, message, id);
      if ('error' in m) return { number, outcome: 'skipped', why: `merging ${this.branch} in failed: ${m.error}` };
      if (!m.clean) {
        abortMerge(dir);
        // GitHub hasn't caught up: the PR watch looks again, and its conflict path takes it from there.
        this.prPolled.delete(number);
        return { number, outcome: 'conflicting', why: `conflicts with ${this.branch} in ${shownPaths(Object.keys(m.conflicted))}; nothing pushed` };
      }
      const push = checkedPush({ cwd: dir, remote: this.remote, base: tip, head: m.head, ref: `refs/heads/${pr.head}`, limits: this.d.cfg.guardrails.push, guard: this.pushGuard(), expect: pr.headSha });
      if (!push.ok) return { number, outcome: 'skipped', why: 'refused' in push ? `the push was refused: ${push.refused.join('; ')}` : `the branch moved (someone pushed), so nothing was pushed over it` };
      this.emit('pr_hygiene.merged_in', { issue: n, number, from: pr.headSha, head: m.head, base_sha: tip, base_days: days });
      this.prPolled.delete(number); // the PR watch reads the new head and its checks on the next pass
      return { number, outcome: 'merged_in', why: `base ${days} day(s) old; merged ${this.branch} (${tip.slice(0, 8)}) in as ${m.head.slice(0, 8)}` };
    } finally {
      clean();
    }
  }
}
