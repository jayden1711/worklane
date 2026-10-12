// Gradual delegation, suggest-only: observe each merged harness PR's review categories and whether it merged as
// proposed, put a clean waiting category (or a loosened one that went wrong) to the owner, and file the owner's
// answer as a review.yaml change they review. See src/delegation.ts.
import { BRAND } from '../brand.js';
import { categoryRecords, delegationIssue, suggestions } from '../delegation.js';
import type { EventPayload } from '../events/types.js';
import { computeLevel, loadMoneyPaths } from '../review.js';
import { Corrections } from './corrections.js';

export abstract class Delegation extends Corrections {
  async checkDelegation(): Promise<void> {
    const review = this.d.cfg.review;
    if (!review?.delegation.enabled) return;
    this.observeMerged();
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
  private observeMerged(): void {
    const seen = new Set(this.d.log.read(0, ['delegation.observed']).map((e) => (e.payload as { pr: number }).pr));
    const merged = this.d.log.read(0, ['pr.closed']).map((e) => e.payload as EventPayload<'pr.closed'>).filter((p) => p.merged && !seen.has(p.number));
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
          categories = Object.keys(computeLevel({ files, labels: [], moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review).categories).sort();
        } catch {
          // the commits aren't here (a squash or a force-push upstream): observed with no categories
        }
      }
      const foreign = this.d.log.read(0, ['merge.decided']).some((e) => {
        const p = e.payload as EventPayload<'merge.decided'>;
        return p.number === m.number && p.reasons.some((r) => /someone other than the harness pushed/.test(r));
      });
      this.emit('delegation.observed', { pr: m.number, issue: m.issue, categories, unchanged: !corrected.has(m.number) && !foreign });
    }
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
