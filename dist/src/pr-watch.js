function outcomeOf(c) {
    if (c.status !== 'completed')
        return 'pending';
    if (c.conclusion === 'success')
        return 'pass';
    if (c.conclusion === 'cancelled')
        return 'cancelled';
    // Neutral counts as not passed: the harness only trusts an explicit success.
    if (c.conclusion === 'skipped' || c.conclusion === 'neutral')
        return 'skipped';
    // failure, timed_out, action_required, startup_failure, stale, or anything new.
    return 'fail';
}
/** Each required check's outcome on a commit; a check run wins over a status of the same name. */
export function requiredOutcomes(required, checks) {
    return required.map((name) => {
        const c = checks.find((x) => x.name === name && x.source === 'check_run') ?? checks.find((x) => x.name === name);
        if (!c)
            return { name, outcome: 'missing' };
        return { name, outcome: outcomeOf(c), ...(c.id !== undefined ? { id: c.id } : {}), ...(c.url ? { url: c.url } : {}) };
    });
}
export function readiness(o) {
    const checks = requiredOutcomes(o.required, o.checks);
    const reasons = [];
    if (!o.required.length)
        reasons.push('no required checks are configured (required_checks in config.yaml), so nothing is ever marked ready');
    if (!o.evaluated)
        reasons.push('no evaluator verdict');
    else {
        if (!o.evaluated.approved)
            reasons.push('the evaluator did not approve the change');
        if (o.evaluated.head !== o.head)
            reasons.push(`the head ${o.head.slice(0, 8)} is not the commit the evaluator approved (${o.evaluated.head.slice(0, 8)})`);
    }
    for (const c of checks)
        if (c.outcome !== 'pass')
            reasons.push(`${c.name}: ${c.outcome}`);
    return { ready: reasons.length === 0, reasons, checks, failed: checks.filter((c) => c.outcome === 'fail') };
}
//# sourceMappingURL=pr-watch.js.map