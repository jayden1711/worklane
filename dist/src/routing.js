export const DEFAULT_HIGH_RISK_LABELS = ['size:L', 'money-path', 'review:L3', 'high-risk'];
export const ROUTING = {
    build: { default: 'sonnet', task: 'L1/L2 builds (worker, investigator, conflict fix)' },
    build_high_risk: { default: 'opus', task: 'L3 and high-risk builds, and a build past escalate_after failed attempts' },
    high_risk_labels: { default: DEFAULT_HIGH_RISK_LABELS, task: 'issue labels that make a build high-risk' },
    escalate_after: { default: 2, task: 'failed attempts before a build moves to build_high_risk (0: never)' },
    planner: { default: 'sonnet', task: 'planning' },
    research: { default: 'sonnet', task: 'research' },
    // WHY: on haiku its held-out score dropped (20/20 to 19/20; model routing PR).
    intake_triage: { default: 'sonnet', task: 'intake triage' },
    intake_replier: { default: 'haiku', task: 'intake replies' },
    intake_summary: { default: 'haiku', task: "a decision thread's plain-language summary" },
    // WHY: on haiku its held-out score dropped (21/22 to 19/22).
    intake_thread: { default: 'sonnet', task: 'questions and picks in a decision thread' },
    stage_judge: { default: 'sonnet', task: 'the stage-label judge' },
    eval_answer: { default: 'sonnet', task: 'eval answers' },
    // WHY: a few lines from a rejection and a diff: the cheap tier (#338).
    reflection: { default: 'haiku', task: "the read-only reflection before a worker's retry" },
    // WHY: the dashboard chat's model until now was roles.chief_of_staff.model, else sonnet; that stays its fallback.
    chat: { default: 'sonnet', task: "the dashboard chat's default model (the picker offers only models routing names)" },
    eval_cheap: { default: 'sonnet', task: 'the evaluator, for changes at eval_cheap_levels' },
    eval_cheap_levels: { default: ['L0'], task: 'review levels judged by eval_cheap (the rest: the evaluator role\'s model)' },
    eval_escalate: { default: true, task: 'a failed or uncertain eval_cheap verdict is judged once more by the evaluator role\'s model' },
    // WHY: off by default (the owner, v0.5.1); a second family's verdict can only hold a protected change, never pass one.
    eval_cross_family: { default: 'off', task: 'protected changes: a second verdict from another model family (a hosted provider, hosted:<name>); a disagreement holds the PR with both reasons. off: none' },
};
export const ROUTING_KEYS = Object.keys(ROUTING);
export const ROUTING_ALIASES = {
    model_routing: Object.fromEntries(ROUTING_KEYS.filter((k) => !k.startsWith('eval_') || k === 'eval_answer').map((k) => [k, k])),
    eval_routing: { cheap_model: 'eval_cheap', cheap_levels: 'eval_cheap_levels', escalate: 'eval_escalate' },
};
export function route(a, key) {
    const set = a.routing?.[key];
    if (set !== undefined)
        return { key, value: set, from: a.routing_from?.[key] ?? `routing.${key}` };
    const w = a.roles.workers;
    const r = a.roles.researcher;
    // WHY: a repo that named its workers' or researcher's model before routing existed keeps it for these tasks.
    const fallbacks = {
        build: [[w?.model, 'roles.workers.model']],
        build_high_risk: [[w?.hard_issues_model, 'roles.workers.hard_issues_model']],
        research: [[r?.model, 'roles.researcher.model']],
        intake_triage: [[r?.model, 'roles.researcher.model'], [w?.model, 'roles.workers.model']],
        chat: [[a.roles.chief_of_staff?.model, 'roles.chief_of_staff.model']],
    };
    for (const [v, at] of fallbacks[key] ?? [])
        if (v !== undefined)
            return { key, value: v, from: at };
    return { key, value: ROUTING[key].default, from: null };
}
export function effectiveRouting(a) {
    return ROUTING_KEYS.map((k) => route(a, k));
}
//# sourceMappingURL=routing.js.map