import { scorecard } from './scorecard.js';
export function effectiveStage(events, configured) {
    const last = events.filter((e) => e.type === 'stage.changed').at(-1);
    return last ? last.payload.to : configured;
}
/** Category -> level for everything the stages up to `stage` relax (later stages win). */
export function relaxedFor(stage, review) {
    const out = {};
    for (const s of [...(review?.stages ?? [])].sort((a, b) => a.stage - b.stage))
        if (s.stage <= stage)
            for (const r of s.relax)
                out[r.category] = r.to;
    return out;
}
export function health(events, trust, now = new Date(), revertedShas) {
    const card = scorecard(events, { from: new Date(now.getTime() - trust.window_days * 86_400_000), to: now, ...(revertedShas ? { revertedShas } : {}) });
    const why = [];
    if (card.tasksDone < trust.min_tasks)
        why.push(`only ${card.tasksDone} tasks done in ${trust.window_days} days (need ${trust.min_tasks})`);
    if (card.evaluatorPassRate !== null && card.evaluatorPassRate < trust.min_evaluator_pass_rate)
        why.push(`evaluator pass rate ${card.evaluatorPassRate} < ${trust.min_evaluator_pass_rate}`);
    if (card.unverifiedClaimRate !== null && card.unverifiedClaimRate > trust.max_unverified_claim_rate)
        why.push(`unverified-claim rate ${card.unverifiedClaimRate} > ${trust.max_unverified_claim_rate}`);
    if (card.reverts > trust.max_reverts)
        why.push(`${card.reverts} revert(s) > ${trust.max_reverts}`);
    if (card.baselineGrowth > trust.max_baseline_growth)
        why.push(`main's baseline grew by ${card.baselineGrowth}`);
    return { healthy: why.length === 0, why, card };
}
/** A regression is a breach of a quality threshold; too few tasks is not a regression. */
export function regressed(h) {
    return h.why.some((w) => !w.startsWith('only '));
}
/** Consecutive healthy daily evaluations, most recent first. */
export function healthyStreak(events) {
    let n = 0;
    for (const e of [...events].reverse()) {
        if (e.type === 'stage.changed')
            break;
        if (e.type !== 'trust.evaluated')
            continue;
        if (!e.payload.healthy)
            break;
        n++;
    }
    return n;
}
//# sourceMappingURL=trust.js.map