// The optional cross-family evaluator: on a change to a protected surface, when agents.yaml routing names a hosted
// provider for eval_cross_family (off by default), a second verdict comes from that other model family, through the
// same provider plumbing as every open-model run (the instance's opt-in, the key file, the model cap, the eval gate),
// the same read-only tools and sandbox, and never on Anthropic in its place (no fallback). It can only add a doubt:
// when the two verdicts disagree the change waits for a human with both reasons; it never approves anything. A change
// that touches held-out eval cases or secrets is never sent to another provider. Pure: the coordinator runs it.
import { providerOf } from './providers.js';
export const CROSS_FAMILY_OFF = 'off';
/** The provider model routing names for the second verdict, or null when it is off (or names no hosted provider). */
export function crossFamilyModel(value) {
    if (!value || value === CROSS_FAMILY_OFF)
        return null;
    return providerOf(value)?.kind === 'hosted' ? value : null;
}
/** Why a routing value may not be the cross-family evaluator (null: it may): off, or a hosted provider. */
export function crossFamilyRefusal(value) {
    if (value === CROSS_FAMILY_OFF)
        return null;
    const p = providerOf(value);
    if (!p)
        return `${value} is an Anthropic model; the cross-family evaluator is another family: a hosted provider (hosted:<name>) or ${CROSS_FAMILY_OFF}`;
    if (p.kind !== 'hosted')
        return `the cross-family evaluator runs only on a hosted provider (hosted:<name>), not ${p.kind}`;
    return null;
}
/** Paths never sent to another provider: held-out eval cases. */
const NEVER_SENT = /(^|\/)evals\/held-out\//;
/**
 * Why this change is not sent to the cross-family evaluator (null: it may be): it touches held-out eval cases, or
 * secrets (the review category).
 */
export function crossFamilySkip(o) {
    const held = o.paths.filter((p) => NEVER_SENT.test(p));
    if (held.length)
        return `it touches held-out eval cases (${held.slice(0, 3).join(', ')}), which are never sent to another provider`;
    const secrets = o.categories.secrets ?? [];
    if (secrets.length)
        return `it touches secrets (${secrets.slice(0, 3).join(', ')}), which are never sent to another provider`;
    return null;
}
const RANK = { high: 2, medium: 1, low: 0 };
const said = (v) => `${v.patch_correct ? 'approves' : 'rejects'} the patch, confidence ${v.confidence}${v.reason ? ` (${v.reason.slice(0, 400)})` : ''}`;
/**
 * The two verdicts disagree when one approves and the other rejects, or their confidence is two steps apart (high
 * and low). The doubt names both sides and their reasons; null when they agree.
 */
export function crossDisagreement(primary, second) {
    const split = primary.patch_correct !== second.patch_correct || Math.abs(RANK[primary.confidence] - RANK[second.confidence]) >= 2;
    if (!split)
        return null;
    return `the evaluators disagree: the cross-family evaluator (${second.provider}) ${said(second)}; the main evaluator ${said(primary)}`;
}
//# sourceMappingURL=cross-eval.js.map