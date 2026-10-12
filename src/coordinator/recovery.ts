// Recovery: what a restart finds (recover), reconciling with the tracker, and the requeue of issues blocked on a
// rate limit or budget.
import { BRAND } from '../brand.js';
import { claim, release } from '../claims.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { refuseInterruptedChats } from '../chat.js';
import { ClosedIssueWatch } from './closed-issues.js';
import { Intake } from './intake.js';
import { RETRY_CAP } from './shared.js';

export abstract class Recovery extends Intake {
  private readonly closedWatch = new ClosedIssueWatch();

  /**
   * After a crash or restart: a task that was mid-pipeline (claimed, not yet
   * queued for landing or waiting on a decision) has no live run anymore, so
   * it's released and requeued; its history stays in the log. Queued
   * landings and open decisions resume from the log on their own.
   */
  async recover(): Promise<number[]> {
    // Chat turns and intake reports cut off by a restart: each ended once, never run again.
    refuseInterruptedChats(this.d.stateDir);
    try {
      await this.recoverIntake();
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: 'intake recovery', kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    }
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

  protected async reconcile(): Promise<number> {
    // Tasks whose issue was closed elsewhere are cancelled, never re-dispatched.
    let n = 0;
    for (const e of this.d.log.read(0, ['issue.claimed'])) {
      const issue = (e.payload as { issue: number }).issue;
      if (this.isTerminal(issue)) continue;
      const gh = await this.d.backlog.get(issue);
      if (gh.state === 'closed') {
        this.emit('issue.released', { issue, instance: this.d.instance, why: 'issue closed on GitHub' });
        this.emit('issue.closed', { issue });
        n++;
      }
    }
    // Issues held for the owner with no claim to check (blocked and released, a decision, a held plan): one listing.
    for (const issue of await this.closedWatch.check(this.d.log.read(), this.d.backlog)) {
      this.emit('issue.closed', { issue });
      n++;
    }
    return n;
  }

  protected isTerminal(issue: number): boolean {
    const last = this.events(issue).filter((e) => ['issue.released', 'deploy.verified', 'land.result', 'issue.claimed'].includes(e.type)).at(-1);
    if (!last) return true;
    if (last.type === 'issue.released' || last.type === 'deploy.verified') return true;
    if (last.type === 'land.result') return (last.payload as { outcome: string }).outcome === 'landed' && !this.d.cfg.deploy?.environments.some((x) => !x.production && x.trigger);
    return false;
  }

  /**
   * Rate-limit and budget blocks whose window has passed: relabelled `ready` (so the next dispatch takes them)
   * up to RETRY_CAP times per issue, then left blocked with a comment. Auth blocks never retry on their own.
   */
  protected async retryBlocked(now = Date.now()) {
    const latest = new Map<number, StoredEvent>();
    for (const e of this.d.log.read(0, ['issue.blocked', 'issue.claimed', 'issue.retry'])) latest.set((e.payload as { issue: number }).issue, e);
    for (const [n, e] of latest) {
      if (e.type !== 'issue.blocked') continue;
      const b = e.payload as EventPayload<'issue.blocked'>;
      if (!b.retry_after || !b.retry_kind || Date.parse(b.retry_after) > now) continue;
      const used = this.d.log.read(0, ['issue.retry']).filter((r) => (r.payload as EventPayload<'issue.retry'>).issue === n && !(r.payload as EventPayload<'issue.retry'>).gave_up).length;
      if (used >= RETRY_CAP) {
        this.emit('issue.retry', { issue: n, attempt: used, kind: b.retry_kind, gave_up: true });
        await this.d.backlog.comment(n, `[${BRAND.cli}] @${b.owner} still blocked after ${used} automatic retries (${b.retry_kind === 'rate_limit' ? 'rate limit' : 'budget'}); label it \`ready\` again when it should run.`);
        continue;
      }
      this.emit('issue.retry', { issue: n, attempt: used + 1, kind: b.retry_kind, gave_up: false });
      await this.d.backlog.removeLabel(n, 'blocked');
      await this.d.backlog.addLabels(n, ['ready']);
      await this.d.backlog.comment(n, `[${BRAND.cli}] The ${b.retry_kind === 'rate_limit' ? 'rate-limit' : 'budget'} window has passed: requeued (automatic retry ${used + 1} of ${RETRY_CAP}).`);
    }
  }
}
