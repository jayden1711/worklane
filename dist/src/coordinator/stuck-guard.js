/** The roles the guard watches: the worker and the evaluators. */
export const STUCK_ROLES = new Set(['worker', 'evaluator-verdict', 'evaluator-repro']);
/** The guard's option for a run, or nothing when it doesn't apply (another role, the guard off, or set by the caller). */
export function stuckOption(req, mode, who, runId, emit) {
    if (req.stuck || mode === 'off' || !STUCK_ROLES.has(req.role))
        return {};
    return {
        stuck: {
            mode,
            onVerdict: (v, action) => emit({ issue: who.issue, role: who.role, run: runId(), kind: v.kind, mode, action, tool: v.tool, input: v.input.slice(0, 300), repeats: v.repeats, failures: v.failures }),
        },
    };
}
/** What the worker is told on its next attempt after a stuck stop. */
export function stuckFeedback(detail) {
    return [`Your previous attempt was stopped because it kept repeating the same failing call (${detail.replace(/^stopped as stuck: /, '')}). Try a different approach rather than repeating it.`];
}
//# sourceMappingURL=stuck-guard.js.map