// Stale PR hygiene: a periodic pass over the harness's own open PRs (never a person's). A PR whose merge base with
// the default branch is older than pr_hygiene.stale_after_days gets the default branch merged in (a normal merge
// commit, signed off, as the harness's identity, pushed only to the PR's branch), so CI and the test runs run again on
// what it would merge into; a conflicting one goes to the conflict-fix path; one whose task is closed or superseded
// and that has seen no commit or comment for pr_hygiene.abandon_after_days is closed with a comment (its branch is
// kept). A PR waiting on an owner (a hold label, or the merge policy left it to them at this head) is never touched,
// only counted. Each pass records its counts (pr_hygiene.pass): the dashboard shows the latest, and a weekly digest
// can sum them (hygieneWeek).
//
// These are the pure decisions; the coordinator does the git work and the GitHub calls (coordinator/pr-hygiene.ts).
// A merge-in carries the evaluator's verdict across (carriedHead): its tree is the evaluated change plus the default
// branch, merged cleanly, and CI judges the combination again before anything merges.
import { BRAND } from './brand.js';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Every comment a pass leaves carries this, so its own comments never count as activity on the PR. */
export const HYGIENE_MARKER = `<!-- ${BRAND.cli}:pr-hygiene -->`;
/** A pass is due when none ran yet, or the last one is at least `everyHours` old. */
export function hygieneDue(lastPassAt, nowMs, everyHours) {
    if (!lastPassAt)
        return true;
    const t = Date.parse(lastPassAt);
    return !Number.isFinite(t) || nowMs - t >= everyHours * HOUR_MS;
}
/** Whether a base made at `baseAtMs` is older than `days`. */
export const isStale = (baseAtMs, nowMs, days) => nowMs - baseAtMs > days * DAY_MS;
/** Whole days between two times, for messages. */
export const daysBetween = (fromMs, toMs) => Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
/**
 * Why a PR is left alone because it waits on a person (empty: it doesn't). A hold label on it; the merge policy left
 * this head to an owner; or someone else pushed to it (the harness never pushes over that).
 */
export function heldReasons(o) {
    const r = [];
    const labels = o.labels.filter((l) => o.holdLabels.includes(l));
    if (labels.length)
        r.push(`labelled ${labels.join(', ')}`);
    if (o.waitsOwner)
        r.push('the merge policy left it to an owner at this head');
    if (o.ourHead !== o.head)
        r.push(`someone else pushed to it (its head ${o.head.slice(0, 8)} is not the harness's last push ${o.ourHead?.slice(0, 8) ?? 'none'})`);
    return r;
}
/** A later PR the harness opened for the same task, which supersedes this one; null when there is none. */
export function supersededBy(opened, pr) {
    const later = opened.filter((o) => o.issue === pr.issue && o.number > pr.number).map((o) => o.number);
    return later.length ? Math.max(...later) : null;
}
/**
 * The last activity on a PR: its newest commit (before the harness's own merge-ins), comment (not the pass's own) or
 * review. null when a comment's time is unknown: then nothing proves it abandoned.
 */
export function lastActivity(o) {
    let t = o.commitAtMs;
    for (const c of o.comments) {
        if (c.body.includes(HYGIENE_MARKER))
            continue;
        const at = c.at ? Date.parse(c.at) : NaN;
        if (!Number.isFinite(at))
            return null;
        t = Math.max(t, at);
    }
    for (const r of o.reviewsAt) {
        const at = Date.parse(r);
        if (Number.isFinite(at))
            t = Math.max(t, at);
    }
    return t;
}
/**
 * Abandoned: its task is closed or superseded, and nothing happened on it for `abandonDays`. `why` says which, for the
 * closing comment (or, when not abandoned yet, why it is left as is).
 */
export function abandoned(o) {
    const task = o.taskClosed ? `its task #${o.task} is closed` : o.supersededBy !== null ? `it is superseded by #${o.supersededBy}` : null;
    if (!task)
        return { abandoned: false, why: 'its task is open' };
    if (o.lastActivityMs === null)
        return { abandoned: false, why: `${task}, but when it last saw activity is unknown` };
    const idle = daysBetween(o.lastActivityMs, o.nowMs);
    if (o.nowMs - o.lastActivityMs <= o.abandonDays * DAY_MS)
        return { abandoned: false, why: `${task}; it closes after ${o.abandonDays} days without a commit or comment (${idle} so far)` };
    return { abandoned: true, why: `${task}, and it has had no commit or comment for ${idle} days (pr_hygiene.abandon_after_days: ${o.abandonDays})` };
}
/**
 * The head a PR had before the harness's merge-ins on top of it: what the evaluator judged, when nothing else moved it.
 * `number` null: whichever PR the merge-ins were on (a commit is on one PR's branch).
 */
export function carriedHead(mergeIns, number, head) {
    let h = head;
    for (let guard = 0; guard < 1000; guard++) {
        const m = mergeIns.find((x) => (number === null || x.number === number) && x.head === h);
        if (!m)
            break;
        h = m.from;
    }
    return h;
}
/** The default-branch commit a merge-in at `head` merged: the base the PR's own change is measured from. */
export function mergeInBase(mergeIns, number, head) {
    return mergeIns.find((x) => x.number === number && x.head === head)?.base_sha ?? null;
}
export function countsOf(results) {
    const c = { merged_in: 0, conflicting: 0, closed: 0, held: 0, skipped: 0 };
    for (const r of results)
        c[r.outcome]++;
    return c;
}
/** One line of counts, as the dashboard and a digest show it. */
export function hygieneLine(c) {
    return `${c.merged_in} merged in, ${c.conflicting} conflicting, ${c.closed} closed, ${c.held} held for an owner, ${c.skipped} skipped`;
}
/**
 * The digest hook: every pass since `sinceMs`, summed (a weekly digest calls this with a week ago). Events are the
 * log's pr_hygiene.pass events, oldest first.
 */
export function hygieneWeek(events, sinceMs) {
    const c = { merged_in: 0, conflicting: 0, closed: 0, held: 0, skipped: 0 };
    let passes = 0;
    for (const e of events) {
        if (e.type !== 'pr_hygiene.pass' || Date.parse(e.ts) < sinceMs)
            continue;
        passes++;
        const p = e.payload;
        for (const k of Object.keys(c))
            c[k] += Number(p[k] ?? 0);
    }
    return { ...c, passes, line: passes ? `Stale PRs (${passes} passes): ${hygieneLine(c)}` : 'Stale PRs: no pass ran' };
}
//# sourceMappingURL=pr-hygiene.js.map