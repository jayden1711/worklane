/**
 * The instance's threshold (owner, 2026-10-15): a job whose output quota (its loop-mounted volume, the disk it may
 * fill) is above 20 GB waits for an owner. Time needs none: root's max_minutes (20 to start) is a cap, not a threshold.
 */
export const APPROVE_DEFAULTS = { above_gb: 20 };
/** Why an owner must approve this job (empty: it may start by itself). */
export function approvalReasons(j, t) {
    const r = [];
    if (j.first)
        r.push('the first job of this study version');
    if (j.gpus > 1)
        r.push(`${j.gpus} GPUs`);
    if (j.output_gb > t.above_gb)
        r.push(`${j.output_gb} GB of output is above ${t.above_gb} GB`);
    if (j.lockfile)
        r.push('the dependency lockfile changed');
    return r;
}
/** Why a study can't run on this machine at all (root's caps and data sources), or null. */
export function rootRefusal(s, root) {
    if (!root)
        return 'experiments are not on for this instance in root\'s file';
    if (s.job.max_minutes > root.max_minutes)
        return `${s.job.max_minutes} min a job is above root's ${root.max_minutes}`;
    for (const z of s.ladder)
        if ((z.max_minutes ?? s.job.max_minutes) > root.max_minutes)
            return `the ${z.name} size's ${z.max_minutes} min is above root's ${root.max_minutes}`;
    if (s.job.gpus > root.devices.length)
        return `${s.job.gpus} GPUs a job, root's file lists ${root.devices.length}`;
    if (s.job.output_gb > root.output_gb)
        return `${s.job.output_gb} GB a job is above root's ${root.output_gb}`;
    if (s.budget.gpu_hours_per_day > root.gpu_hours_per_day)
        return `${s.budget.gpu_hours_per_day} GPU-hours a day is above root's ${root.gpu_hours_per_day}`;
    for (const id of [...s.train.data, s.eval.inputs]) {
        const src = root.sources[id];
        if (!src)
            return `the data source ${id} is not approved in root's file`;
        if (src.visibility !== 'job')
            return `the data source ${id} is the scorer's only; a job can't read it`;
    }
    const l = root.sources[s.eval.labels];
    if (!l)
        return `the data source ${s.eval.labels} is not approved in root's file`;
    if (l.visibility !== 'scorer')
        return `the labels ${s.eval.labels} must be a scorer-only source in root's file`;
    return null;
}
/** Why the study can't start another session or job now (its budget), or null. A job is held if its cap could cross a line. */
export function budgetHold(s, u, instanceUsdLeft) {
    if (u.jobs >= s.budget.max_jobs)
        return `${u.jobs} of ${s.budget.max_jobs} jobs used`;
    if (u.agent_usd_total >= s.budget.agent_usd_total)
        return `$${u.agent_usd_total.toFixed(2)} of $${s.budget.agent_usd_total} in all`;
    if (u.agent_usd_today >= s.budget.agent_usd_per_day)
        return `$${u.agent_usd_today.toFixed(2)} of $${s.budget.agent_usd_per_day} today`;
    if (u.gpu_hours_today + (s.job.max_minutes * s.job.gpus) / 60 > s.budget.gpu_hours_per_day + 1e-9)
        return `${u.gpu_hours_today.toFixed(2)} of ${s.budget.gpu_hours_per_day} GPU-hours today; a job may take ${(s.job.max_minutes * s.job.gpus) / 60}`;
    if (instanceUsdLeft <= 0)
        return 'the instance\'s daily budget is spent';
    return null;
}
/** A session's budget: the least of the per-session cap, the study's day and total, and the instance's day. */
export function sessionBudgetUsd(s, u, instanceUsdLeft, perSession = 2) {
    return Math.max(0, Math.min(perSession, s.budget.agent_usd_per_day - u.agent_usd_today, s.budget.agent_usd_total - u.agent_usd_total, instanceUsdLeft));
}
//# sourceMappingURL=approval.js.map