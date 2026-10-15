// Model routing, decided in code: which model each kind of run uses. Haiku for the intake replier and the decision
// thread summary (held-out 20/20 on haiku and on sonnet at 3 samples), and the reflection before a retry; Sonnet for
// L1/L2 builds, planning, research, eval answering and the stage-label judge; Opus for L3 and high-risk builds,
// and for a build that already failed twice on its usual model. Intake triage stays on the model it had (the
// researcher's, else the workers'): its held-out score dropped on haiku. The stage-label judge stays on sonnet:
// on haiku it missed a case of its eval in two samples of three. Decision-thread questions and picks stay on sonnet:
// on haiku their held-out score dropped (21/22 on sonnet to 19/22, 3 samples). The evaluator's model is
// tiered separately (src/eval-routing.ts). The repo's agents.yaml `routing` overrides any of these (defaults: src/routing.ts); the
// instance's `model_cap` (policy.yaml settings) caps every run's model at a tier (in the coordinator's runner,
// so no run escapes it), never raises one.
import { OPTIMIZE_LABEL } from './optimize.js';
import { route } from './routing.js';
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'];
export { DEFAULT_HIGH_RISK_LABELS } from './routing.js';
export function modelRouting(agents) {
    const v = (k) => route(agents, k).value;
    return {
        build: v('build'),
        build_high_risk: v('build_high_risk'),
        high_risk_labels: v('high_risk_labels'),
        escalate_after: v('escalate_after'),
        planner: v('planner'),
        research: v('research'),
        intake_triage: v('intake_triage'),
        intake_replier: v('intake_replier'),
        intake_summary: v('intake_summary'),
        intake_thread: v('intake_thread'),
        stage_judge: v('stage_judge'),
        eval_answer: v('eval_answer'),
        reflection: v('reflection'),
    };
}
/** A model's tier from its alias or full id; null for a model this doesn't know (treated as the top tier when capping). */
export function tierOf(model) {
    const words = model.toLowerCase().split(/[^a-z0-9]+/);
    return MODEL_TIERS.find((t) => words.includes(t)) ?? null;
}
/** The model, capped at `cap`: a model above it (or of an unknown tier) becomes the cap's alias. */
export function capped(model, cap) {
    if (!cap)
        return model;
    const t = tierOf(model);
    return t !== null && MODEL_TIERS.indexOf(t) <= MODEL_TIERS.indexOf(cap) ? model : cap;
}
/** The model for a routed run. */
export function routedModel(r, kind) {
    return r[kind];
}
/**
 * A build's model: the high-risk model for an issue labelled high-risk (L3, money path, size L), or from the
 * attempt after `escalate_after` failed ones; else the usual build model. `why` says which applied.
 */
export function buildModel(r, labels, attempt = 1) {
    // An optimization task (src/optimize.ts) always runs on the strongest model: the high-risk build model.
    const risky = labels.some((l) => r.high_risk_labels.includes(l)) || labels.includes(OPTIMIZE_LABEL);
    const escalated = r.escalate_after > 0 && attempt > r.escalate_after;
    const why = risky ? 'high-risk' : escalated ? 'escalated' : 'default';
    return { model: why === 'default' ? r.build : r.build_high_risk, why };
}
//# sourceMappingURL=model-routing.js.map