// Trust stages. Stage 1 is the project's starting practice. When the
// scorecard stays healthy for promote_after_days in a row, the owner is
// asked to promote; promotion is always a human decision. A regression
// demotes automatically. A stage only relaxes the categories review.yaml
// lists for it, and never the protected ones.
import type { AgentsConfig, ReviewConfig } from './config/schema.js';
import type { StoredEvent } from './events/types.js';
import type { Level } from './review.js';
import { scorecard, type Scorecard } from './scorecard.js';

export function effectiveStage(events: StoredEvent[], configured: number): number {
  const last = events.filter((e) => e.type === 'stage.changed').at(-1);
  return last ? (last.payload as { to: number }).to : configured;
}

/** Category -> level for everything the stages up to `stage` relax (later stages win). */
export function relaxedFor(stage: number, review: ReviewConfig | undefined): Record<string, Level> {
  const out: Record<string, Level> = {};
  for (const s of [...(review?.stages ?? [])].sort((a, b) => a.stage - b.stage)) if (s.stage <= stage) for (const r of s.relax) out[r.category] = r.to;
  return out;
}

export interface Health {
  healthy: boolean;
  why: string[];
  card: Scorecard;
}

export function health(events: StoredEvent[], trust: AgentsConfig['trust'], now = new Date(), revertedShas?: Set<string>): Health {
  const card = scorecard(events, { from: new Date(now.getTime() - trust.window_days * 86_400_000), to: now, ...(revertedShas ? { revertedShas } : {}) });
  const why: string[] = [];
  if (card.tasksDone < trust.min_tasks) why.push(`only ${card.tasksDone} tasks done in ${trust.window_days} days (need ${trust.min_tasks})`);
  if (card.evaluatorPassRate !== null && card.evaluatorPassRate < trust.min_evaluator_pass_rate) why.push(`evaluator pass rate ${card.evaluatorPassRate} < ${trust.min_evaluator_pass_rate}`);
  if (card.unverifiedClaimRate !== null && card.unverifiedClaimRate > trust.max_unverified_claim_rate) why.push(`unverified-claim rate ${card.unverifiedClaimRate} > ${trust.max_unverified_claim_rate}`);
  if (card.reverts > trust.max_reverts) why.push(`${card.reverts} revert(s) > ${trust.max_reverts}`);
  if (card.baselineGrowth > trust.max_baseline_growth) why.push(`main's baseline grew by ${card.baselineGrowth}`);
  return { healthy: why.length === 0, why, card };
}

/** A regression is a breach of a quality threshold; too few tasks is not a regression. */
export function regressed(h: Health): boolean {
  return h.why.some((w) => !w.startsWith('only '));
}

/** Consecutive healthy daily evaluations, most recent first. */
export function healthyStreak(events: StoredEvent[]): number {
  let n = 0;
  for (const e of [...events].reverse()) {
    if (e.type === 'stage.changed') break;
    if (e.type !== 'trust.evaluated') continue;
    if (!(e.payload as { healthy: boolean }).healthy) break;
    n++;
  }
  return n;
}
