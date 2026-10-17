// The evaluator's confidence, with its reason (#471). A confidence that isn't high must say why, naming the one
// thing left unverified or the problem found: a verdict without that reason is refused, and the evaluator is asked
// once more. For a change to a protected surface the evaluator also answers the "compromised component" question for
// every actor that can reach it; a missing or unacceptable answer is a doubt with that reason, never a high pass.
// Pure: the coordinator runs the evaluator around these (src/coordinator.ts evaluate).
import { readClaims } from './claim-labels.js';
import { lowerConfidence } from './receipts.js';
import { COMPROMISED_ACTORS, OTHER_ACTOR } from './roles.js';
export { OTHER_ACTOR };
/** The actors the "compromised component" question asks about (src/roles.ts, where the evaluator's schema names them). */
export const ACTORS = COMPROMISED_ACTORS;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');
/** The longest reason recorded (eval.verdict's bound). */
export const REASON_MAX = 2000;
/**
 * Why a verdict is refused as given: a confidence other than high without a reason, or claims not each labeled
 * measured, inferred or guess. Null: accepted. The text is what the evaluator is told when it's asked once more.
 */
export function verdictRefusal(s) {
    if (!s)
        return null;
    const why = [];
    if ((s.confidence === 'medium' || s.confidence === 'low') && !text(s.confidence_reason))
        why.push(`confidence ${s.confidence} needs confidence_reason, one sentence naming the specific thing you could not verify or the likely problem you found`);
    const labels = claimDoubt(s.claims);
    if (labels)
        why.push(`claims must list each claim your verdict rests on, labeled measured (with the command and what it showed), inferred or guess (${labels})`);
    return why.length ? `Your verdict was refused: ${why.join('; and ')}. Give the whole verdict again.` : null;
}
/** What is wrong with a verdict's labeled claims, as one doubt; null when every claim is labeled. */
export function claimDoubt(claims) {
    const { problems } = readClaims(claims);
    return problems.length ? clip(problems.join('; '), 600) : null;
}
/**
 * For a change to a protected surface: one doubt per actor whose answer is missing or empty, and per answer that says
 * what the actor can do is not acceptable. Empty for a change to no protected surface, or when every actor's answer
 * holds.
 */
export function compromisedDoubts(answers, protectedSurface) {
    if (!protectedSurface)
        return [];
    const list = (Array.isArray(answers) ? answers : []).filter((a) => !!a && typeof a === 'object');
    const out = [];
    const missing = [];
    for (const [key, words] of ACTORS) {
        const a = list.find((x) => x.actor === key);
        if (!a || !text(a.can_do) || !text(a.why) || typeof a.acceptable !== 'boolean')
            missing.push(words);
    }
    if (missing.length)
        out.push(`compromised component: no answer for ${missing.join(', ')}`);
    for (const a of list) {
        if (a.acceptable !== false)
            continue;
        const who = ACTORS.find(([k]) => k === a.actor)?.[1] ?? (text(a.actor) || OTHER_ACTOR);
        out.push(`compromised component: ${clip(who, 120)} can ${clip(text(a.can_do) || 'act through it', 300)}, which is not acceptable${text(a.why) ? `: ${clip(text(a.why), 300)}` : ''}`);
    }
    return out;
}
/**
 * The confidence recorded and its reason. The evaluator's own, lowered for claims no record backs (never evidence)
 * and, for a protected surface, to at most medium by any compromised-component doubt, and by any other doubt given
 * (claims left unlabeled, a check handed to the reader instead of run). A confidence other than high
 * always has a reason: the evaluator's, what lowered it, or, when it gave none even when asked again, that it gave none.
 */
export function calibrated(o) {
    let confidence = lowerConfidence(o.confidence, o.unverified);
    const doubts = [...o.compromised, ...(o.doubts ?? [])];
    if (doubts.length && confidence === 'high')
        confidence = 'medium';
    if (confidence === 'high')
        return { confidence };
    const own = o.confidence !== 'high' ? text(o.reason) : '';
    const parts = [
        ...(own ? [own] : []),
        ...(o.unverified ? [`lowered: ${o.unverified} unverified claim(s)`] : []),
        ...doubts,
    ];
    if (!parts.length)
        parts.push(`the evaluator gave no reason for confidence ${o.confidence}, even when asked again`);
    return { confidence, confidence_reason: clip(parts.join('; '), REASON_MAX) };
}
/** The brief line for a change to a protected surface: what it touches, and the question to answer for each actor. */
export function protectedBrief(why) {
    return [
        `PROTECTED SURFACE: this change ${why.slice(0, 6).join('; ')}${why.length > 6 ? `; and ${why.length - 6} more` : ''}.`,
        `Answer compromised_component for each actor (${ACTORS.map(([k, w]) => `${k}: ${w}`).join('; ')}), plus any other actor the change exposes it to (actor "${OTHER_ACTOR}", named in can_do): what it can do through this change if it is compromised or hostile, whether that is acceptable, and why (or what stops it).`,
    ].join('\n');
}
//# sourceMappingURL=verdict-confidence.js.map