import { normalizeCause } from '../failure-modes.js';
/** Identical failures in a row that stop the attempts: the first time the task is reassigned, the second it is blocked. */
export const IDENTICAL_FAILURES = 3;
/** The share of a budget at which the incident is raised. */
export const BUDGET_WARN = 0.85;
/** The incident a task near its budget raises, keyed by instance and issue. */
export const TASK_BUDGET_INCIDENT = 'task_budget';
/** The default attempt cap, when agents.yaml sets none. */
export const DEFAULT_MAX_ATTEMPTS = 8;
/** An attempt's failure, reduced so the same failure reads the same each time (ids, numbers, paths and quotes out). */
export function failureFingerprint(kind, text) {
    return `${kind}: ${normalizeCause(text)}`;
}
/** The fingerprint of failed checks: each failing check and the start of its output. */
export function checksFingerprint(failing) {
    return failureFingerprint('checks', failing.map((c) => `${c.check}: ${(c.tail ?? '').trim().split(/\r?\n/).slice(-3).join(' ')}`).join(' | '));
}
/**
 * The issue's events since its attempt budget last reset: its last block or decision asked, after which the owner
 * relabels or answers and the task starts afresh (as the coordinator's attempt count resets).
 */
export function sinceReset(events) {
    let from = 0;
    events.forEach((e, i) => {
        if (e.type === 'issue.blocked' || e.type === 'decision.asked')
            from = i + 1;
    });
    return events.slice(from);
}
/** Whether the task was already reassigned since its last reset. */
export function reassigned(events) {
    return sinceReset(events).some((e) => e.type === 'task.reassigned');
}
/**
 * The run of identical failures the task's attempts end on (since the reset and the last reassign): its fingerprint
 * and how many in a row.
 */
export function identicalStreak(events) {
    const since = sinceReset(events);
    const last = since.findLastIndex((e) => e.type === 'task.reassigned');
    const failures = since.slice(last + 1).filter((e) => e.type === 'attempt.failed').map((e) => e.payload.fingerprint);
    const fingerprint = failures.at(-1) ?? null;
    let count = 0;
    for (let i = failures.length - 1; i >= 0 && failures[i] === fingerprint; i--)
        count++;
    return { fingerprint, count };
}
/** What the issue's runs used since its reset: tokens in and out, and run time, from their run.cost events. */
export function taskUsage(events) {
    let tokens = 0;
    let secs = 0;
    for (const e of sinceReset(events)) {
        if (e.type !== 'run.cost')
            continue;
        const p = e.payload;
        tokens += (p.tokens_in ?? 0) + (p.tokens_out ?? 0);
        secs += p.secs ?? 0;
    }
    return { tokens, minutes: secs / 60 };
}
/** Where the usage stands against the budget: over at 100% of either, warn at BUDGET_WARN. */
export function budgetState(u, b) {
    const parts = [];
    if (b?.task_tokens)
        parts.push({ share: u.tokens / b.task_tokens, text: `${Math.round(u.tokens).toLocaleString('en-US')} of ${b.task_tokens.toLocaleString('en-US')} tokens (budget.task_tokens)` });
    if (b?.task_minutes)
        parts.push({ share: u.minutes / b.task_minutes, text: `${Math.round(u.minutes)} of ${b.task_minutes} minutes of agent time (budget.task_minutes)` });
    if (!parts.length)
        return { level: 'ok', share: 0, detail: '' };
    const share = Math.max(...parts.map((p) => p.share));
    const detail = parts.map((p) => `${p.text}, ${Math.round(p.share * 100)}%`).join('; ');
    return { level: share >= 1 ? 'over' : share >= BUDGET_WARN ? 'warn' : 'ok', share, detail };
}
/** How long the next run may take before the time budget runs out (ms), or null with no time budget. */
export function timeLeftMs(u, b) {
    if (!b?.task_minutes)
        return null;
    return Math.max(0, (b.task_minutes - u.minutes) * 60_000);
}
/** The prompt for a reflection run: the issue brief, why the last attempt failed, the earlier failures, the change. */
export function reflectionBrief(brief, feedback, earlier, changed) {
    return [
        brief,
        '',
        'The last attempt at this issue failed. Why it was rejected:',
        ...feedback,
        ...(earlier.length ? ['', 'Earlier failures on this issue, oldest first:', ...earlier.map((f) => `- ${f}`)] : []),
        '',
        changed ? `What the attempt changed against the base (git diff --stat), as left in this worktree:\n${changed}` : 'The attempt left no change against the base.',
    ].join('\n');
}
/** What the next attempt is told from a reflection. */
export function reflectionFeedback(s) {
    const failed = typeof s?.what_failed === 'string' ? s.what_failed.trim() : '';
    const change = typeof s?.what_to_change === 'string' ? s.what_to_change.trim() : '';
    if (!failed || !change)
        return [];
    return ['', 'A review of the failed attempt, before this one:', `- What failed: ${failed.slice(0, 1500)}`, `- What to change: ${change.slice(0, 1500)}`];
}
//# sourceMappingURL=loop-control.js.map