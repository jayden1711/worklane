// Gradual delegation, suggest-only: observe each merged harness PR's review categories and whether it merged as
// proposed, put a clean waiting category (or a loosened one that went wrong) to the owner, and file the owner's
// answer as a review.yaml change they review. See src/delegation.ts.
import { BRAND } from '../brand.js';
import { categoryRecords, delegationIssue, suggestions } from '../delegation.js';
import type { EventPayload, EventType } from '../events/types.js';
import { computeLevel } from '../review.js';
import { Corrections } from './corrections.js';
import { lockScopeOf } from './shared.js';

export abstract class Delegation extends Corrections {
  async checkDelegation(): Promise<void> {
    const review = this.d.cfg.review;
    if (!review?.delegation.enabled) return;
    await this.observeMerged();
    await this.answerDelegation();
    const open = new Set<string>();
    const decided = new Set(this.d.log.read(0, ['delegation.decided']).map((e) => (e.payload as { decision: string }).decision));
    for (const e of this.d.log.read(0, ['delegation.suggested'])) {
      const p = e.payload as EventPayload<'delegation.suggested'>;
      if (!decided.has(p.decision)) open.add(p.category);
    }
    const records = categoryRecords(this.d.log.read(0, ['delegation.observed', 'delegation.decided', 'merge.stopped', 'merge.main_result', 'issue.seen']), review);
    for (const s of suggestions(records, { minClean: review.delegation.min_clean, open })) {
      const decision = await this.ask('delegation', null, this.d.cfg.project.owners.default, s.question, s.options, s.recommendation, s.receipts);
      this.emit('delegation.suggested', { category: s.category, direction: s.direction, decision, receipts: s.receipts });
    }
  }

  /** Each harness PR merged since the last look: its review categories (from its own diff) and whether it merged as proposed. */
  private async observeMerged(): Promise<void> {
    const seen = new Set(this.d.log.read(0, ['delegation.observed']).map((e) => (e.payload as { pr: number }).pr));
    const merged = this.d.log
      .read(0, ['pr.closed'])
      .map((e) => ({ ...(e.payload as EventPayload<'pr.closed'>), ts: e.ts }))
      .filter((p) => p.merged && !seen.has(p.number));
    if (!merged.length) return;
    const review = this.d.cfg.review!;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const corrected = new Set(this.d.log.read(0, ['correction.recorded']).map((e) => (e.payload as { pr: number | null }).pr));
    for (const m of merged) {
      const claimed = this.events(m.issue).filter((e) => e.type === 'issue.claimed').at(-1)?.payload as EventPayload<'issue.claimed'> | undefined;
      const heads = this.d.log
        .read(0, ['pr.opened', 'pr.status', 'merge.done'])
        .map((e) => e.payload as { number: number; head: string })
        .filter((p) => p.number === m.number)
        .map((p) => p.head);
      const head = heads.at(-1);
      let categories: string[] = [];
      if (claimed && head) {
        try {
          const files = this.changeFiles(this.d.repo, claimed.base, head);
          categories = Object.keys(computeLevel({ files, labels: [], moneyPaths: this.moneyPaths(review.money_path_source), scope: lockScopeOf(this.d) }, review).categories).sort();
        } catch {
          // the commits aren't here (a squash or a force-push upstream): observed with no categories
        }
      }
      const foreign = this.d.log.read(0, ['merge.decided']).some((e) => {
        const p = e.payload as EventPayload<'merge.decided'>;
        return p.number === m.number && p.reasons.some((r) => /someone other than the harness pushed/.test(r));
      });
      const approval = await this.approvalOf(m.number, m.issue, head, m.ts);
      // Observed once, even if another pass got there while this one asked GitHub.
      if (this.d.log.read(0, ['delegation.observed']).some((e) => (e.payload as { pr: number }).pr === m.number)) continue;
      this.emit('delegation.observed', { pr: m.number, issue: m.issue, categories, unchanged: !corrected.has(m.number) && !foreign, ...approval });
    }
  }

  /**
   * Whether a merged PR waited for a person at the head that merged (the merge policy left it to one at that head, or
   * that head's landing was asked), who approved it and how long after it started waiting. The approval, the first of:
   * an owner's from Discord at that head (as mergeApproval, src/decide.ts); the latest approving GitHub review since the
   * hold by an owner or writer here; an owner or writer who merged it by hand; the approve answer on its landing. Only
   * someone with a role here counts (never a bot, an outsider or the harness's own account), and nothing given before
   * the hold. Read only: this is evidence for the owner, and nothing here decides anything.
   */
  private async approvalOf(pr: number, issue: number, mergedHead: string | undefined, closedAt: string): Promise<{ held: boolean; approved_by: string | null; approver_role: 'owner' | 'writer' | null; wait_ms: number | null }> {
    const read = <T extends EventType>(type: T) => this.d.log.read(0, [type]).map((e) => ({ ts: e.ts, p: e.payload as EventPayload<T> }));
    const decided = read('merge.decided').filter((e) => e.p.number === pr);
    const head = mergedHead ?? decided.at(-1)?.p.head;
    // Left to a person at the head that merged, and still so (a hold at an earlier head, or one decided auto after, doesn't count).
    const atHead = decided.filter((e) => e.p.head === head);
    const left = atHead.at(-1)?.p.auto === false ? atHead.find((e) => !e.p.auto) : undefined;
    // That head's landing: the one asked at this head; an older decision recorded no head, so the issue's latest.
    const lands = read('decision.asked').filter((e) => e.p.kind === 'land' && e.p.issue === issue);
    const land = lands.filter((e) => e.p.context?.head === head).at(-1) ?? lands.filter((e) => !e.p.context?.head).at(-1);
    const since = [left?.ts, land?.ts].filter((t): t is string => !!t).sort()[0];
    if (!head || !since) return { held: false, approved_by: null, approver_role: null, wait_ms: null };
    const after = (at: string) => Date.parse(at) >= Date.parse(since);
    let own: Set<string> | null = null;
    const role = async (login: string) => {
      if (login.endsWith('[bot]')) return null;
      own ??= await this.ownAccount(pr);
      return own.has(login) ? null : await this.roleFor(login);
    };
    let got: { by: string; at: string; role: 'owner' | 'writer' } | null = null;
    // Discord approves only an owner, only at a head waiting for one (approveMerge); the first at a head stands.
    const discord = left ? read('merge.approved').find((e) => e.p.number === pr && e.p.head === head) : undefined;
    if (discord && after(discord.ts)) got = { by: discord.p.by, at: discord.ts, role: 'owner' };
    if (!got) {
      // Each reviewer's latest say since the hold (as the merge policy's adminApproved): approved, by a role here.
      const latest = new Map<string, { state: string; at: string }>();
      for (const r of [...(await this.d.backlog.reviews(pr).catch(() => []))].sort((a, b) => a.at.localeCompare(b.at))) if (r.state !== 'COMMENTED' && after(r.at)) latest.set(r.author, r);
      for (const [by, r] of [...latest].sort(([, a], [, b]) => b.at.localeCompare(a.at))) {
        const as = r.state === 'APPROVED' ? await role(by) : null;
        if (as) {
          got = { by, at: r.at, role: as };
          break;
        }
      }
    }
    if (!got && !read('merge.done').some((e) => e.p.number === pr)) {
      const by = await this.d.backlog.closedBy(pr).catch(() => null);
      const as = by && after(closedAt) ? await role(by) : null;
      if (by && as) got = { by, at: closedAt, role: as };
    }
    if (!got && land) {
      const a = read('decision.answered').find((e) => e.p.id === land.p.id && e.p.answer === 'approve');
      // The dashboard recorded the role it read (an owner or a writer); a chat answer without one is looked up.
      const as = a ? (a.p.role ?? (await role(a.p.by))) : null;
      if (a && as && after(a.ts)) got = { by: a.p.by, at: a.ts, role: as };
    }
    if (!got) return { held: true, approved_by: null, approver_role: null, wait_ms: null };
    const ms = Date.parse(got.at) - Date.parse(since);
    return { held: true, approved_by: got.by, approver_role: got.role, wait_ms: Number.isFinite(ms) ? Math.round(ms) : null };
  }

  /** The harness's own account(s) on a PR: who posted its tagged comments there (it opened the PR; it never approves). */
  private async ownAccount(pr: number): Promise<Set<string>> {
    const tag = `[${BRAND.cli}]`;
    return new Set((await this.d.backlog.comments(pr).catch(() => [])).filter((c) => c.body.startsWith(tag)).map((c) => c.author));
  }

  /** A person's role on the instance: the default owner, else as the repo says (when asked), else the config's writers. */
  private async roleFor(login: string): Promise<'owner' | 'writer' | null> {
    const owners = this.d.cfg.project.owners;
    if (login === owners.default) return 'owner';
    const role = this.d.roleOf ? await this.d.roleOf(login).catch(() => null) : null;
    if (role === 'owner' || role === 'writer') return role;
    return owners.writers.includes(login) ? 'writer' : null;
  }

  /** The owner's answers: loosen or tighten files the review.yaml change as an issue; keep changes nothing. */
  private async answerDelegation(): Promise<void> {
    const decided = new Set(this.d.log.read(0, ['delegation.decided']).map((e) => (e.payload as { decision: string }).decision));
    const answers = this.d.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
    for (const e of this.d.log.read(0, ['delegation.suggested'])) {
      const s = e.payload as EventPayload<'delegation.suggested'>;
      if (decided.has(s.decision)) continue;
      const a = answers.find((x) => x.id === s.decision);
      if (!a) continue;
      let issue: number | null = null;
      if (a.answer === s.direction) {
        const d = delegationIssue(s.category, s.direction, BRAND.configDir, s.receipts);
        issue = await this.d.backlog.createIssue(d.title, d.body, ['ready']);
      }
      this.emit('delegation.decided', { category: s.category, decision: s.decision, answer: a.answer, by: a.by, issue });
    }
  }
}
