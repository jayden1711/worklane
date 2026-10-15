import { checkResults, prsView, project } from './projection.js';
import { waitingOnYou, WAIT_LABEL } from './digest.js';
import { isOwner, isWriter, mayAnswerKind } from './dashboard-auth.js';
import { batchState, batchSummaries, prBatchStatusIn } from './coordinator/pr-batch.js';
import { localDay } from './local-day.js';
export const BOARD_COLUMNS = ['planning', 'building', 'verifying', 'waiting', 'landing'];
export const COLUMN_LABEL = {
    planning: 'Planning',
    building: 'Building',
    verifying: 'Verifying',
    waiting: 'Waiting on you',
    landing: 'Landing',
};
/**
 * The digest's holds that only the owner ends, which put a card in Waiting on you. A PR held by a pending required
 * check, or a task behind another on the same files, moves on by itself: it stays in its stage's column.
 */
const ONLY_THE_OWNER = new Set(['merge_stopped', 'main_checks_timed_out', 'awaiting_decision', 'plan_held', 'needs_owner', 'ci_fix_gave_up', 'blocked', 'landing_failed']);
/** Run roles that plan or research before anything is built: their task is still being planned. */
const PLANNING_ROLES = new Set(['planner', 'plan-reviewer', 'goal-planner', 'researcher']);
/** How many finished PR batches the Landing column shows beside those running. */
const RECENT_BATCHES = 5;
/** The overall state of a set of check outcomes: any failure fails it, then anything not finished is pending. */
export function checkState(outcomes) {
    if (!outcomes.length)
        return 'none';
    if (outcomes.some((o) => o === 'fail' || o === 'cancelled'))
        return 'failing';
    if (outcomes.some((o) => o === 'pending' || o === 'missing'))
        return 'pending';
    return 'passing';
}
/** Which column a task is in: waiting on the owner first, else by its status (and, in review, its PR's phase). Null: not on the board. */
export function columnOf(t, o) {
    if (['done', 'released', 'triage'].includes(t.status))
        return null;
    if (o.waits || t.status === 'awaiting_decision' || t.status === 'blocked')
        return 'waiting';
    if (o.runRole && PLANNING_ROLES.has(o.runRole))
        return 'planning';
    switch (t.status) {
        case 'ready':
        case 'claimed':
            return 'planning';
        case 'reproducing':
        case 'building':
            return 'building';
        case 'verifying':
        case 'evaluating':
            return 'verifying';
        case 'queued':
        case 'landed':
            return 'landing';
        case 'in_review':
            if (!o.pr || o.pr.state !== 'open')
                return null;
            if (o.pr.phase === 'waiting' || o.pr.phase === 'gave_up')
                return 'waiting';
            return o.pr.phase === 'ready' ? 'landing' : 'verifying';
        default:
            return null;
    }
}
/** The Board for one instance, as this role sees it. */
export function boardView(i) {
    const now = i.now ?? new Date();
    const p = project(i.events, localDay(now));
    const prs = prsView(i.events).prs;
    const digest = waitingOnYou(i.events, now);
    const owner = isOwner(i.role);
    // What the board reads beside the projection: claims, the last proposed change and PR stats, each run's process group.
    const claimedAt = new Map();
    const change = new Map();
    const stats = new Map();
    const pgid = new Map();
    // WHY: each card's last check result, and its PR's batch, read from one pass each, not one pass per card (a busy
    // log's Board took seconds). checkResults reads only its issue's check results, in order, so its issue's are enough.
    const checkEvents = new Map();
    let batchFold = null;
    for (const e of i.events) {
        const q = e.payload;
        if ((e.type === 'check.result' || e.type === 'issue.no_change') && typeof q.issue === 'number') {
            const list = checkEvents.get(q.issue);
            if (list)
                list.push(e);
            else
                checkEvents.set(q.issue, [e]);
        }
        if (e.type === 'issue.claimed')
            claimedAt.set(Number(q.issue), e.ts);
        else if (e.type === 'change.proposed')
            change.set(Number(q.issue), { added: typeof q.added === 'number' ? q.added : null, removed: typeof q.removed === 'number' ? q.removed : null, lines: Number(q.lines), files: q.files.length });
        else if (e.type === 'pr.stats')
            stats.set(Number(q.number), { head: String(q.head), additions: Number(q.additions), deletions: Number(q.deletions), files: Number(q.files), comments: Number(q.comments) });
        else if (e.type === 'run.started' && typeof q.pgid === 'number')
            pgid.set(`${q.issue}:${q.role}`, q.pgid);
    }
    const running = new Map(p.runs.active.map((r) => [r.issue, r]));
    const groups = [...running.values()].map((r) => pgid.get(`${r.issue}:${r.role}`)).filter((g) => typeof g === 'number');
    const usage = i.usage && groups.length ? i.usage(groups) : new Map();
    const cards = [];
    for (const t of p.tasks) {
        const mine = prs.filter((x) => x.issue === t.issue);
        const pr = mine.find((x) => x.state === 'open') ?? mine[0] ?? null;
        const wait = digest.items.find((w) => ONLY_THE_OWNER.has(w.kind) && (w.issue === t.issue || (pr !== null && w.pr === pr.number))) ?? null;
        const r = running.get(t.issue) ?? null;
        const column = columnOf(t, { waits: !!wait, pr, runRole: r?.role ?? null });
        if (!column)
            continue;
        const s = pr ? stats.get(pr.number) : undefined;
        const c = change.get(t.issue);
        const diff = s ? { added: s.additions, removed: s.deletions, lines: s.additions + s.deletions, files: s.files, source: 'pr' } : c ? { ...c, source: 'change' } : null;
        let checks = { state: 'none', source: null, items: [] };
        if (pr?.status && pr.state === 'open')
            checks = { state: checkState(pr.status.checks.map((x) => x.outcome)), source: 'pr', items: pr.status.checks };
        else {
            const last = checkResults(checkEvents.get(t.issue) ?? [], t.issue)[0];
            if (last) {
                const items = last.checks.map((x) => ({ name: x.check, outcome: x.status }));
                checks = { state: checkState(items.filter((x) => x.outcome === 'pass' || x.outcome === 'fail').map((x) => x.outcome)), source: 'coordinator', items };
            }
        }
        const live = r ? (i.live.find((l) => l.issue === r.issue && l.role === r.role)?.run ?? null) : null;
        const group = r ? pgid.get(`${r.issue}:${r.role}`) : undefined;
        const d = t.openDecision ? (p.decisions.find((x) => x.id === t.openDecision && !x.answer) ?? null) : null;
        const highRisk = t.level === 'L3' || d?.kind === 'land';
        const batch = pr && pr.state === 'open' ? prBatchStatusIn((batchFold ??= batchState(i.events)), pr.number, pr.head) : null;
        const startedAt = claimedAt.get(t.issue) ?? t.firstSeen;
        // Approve/Merge: the owner's, on a high-risk change that waits for them. A landing decision is answered through
        // decide (which refuses anyone else); a PR left to the owner is merged on GitHub, where its own rules apply.
        let approve = null;
        if (owner && highRisk && column === 'waiting') {
            if (d?.kind === 'land')
                approve = { decision: d.id, options: d.options };
            else if (pr && pr.state === 'open' && pr.phase === 'waiting')
                approve = { merge: pr.url };
        }
        cards.push({
            instance: i.instance,
            issue: t.issue,
            title: t.title,
            column,
            status: t.status,
            pr: pr ? { number: pr.number, url: pr.url, phase: pr.phase } : null,
            diff,
            comments: s ? s.comments : null,
            startedAt,
            since: wait?.since ?? startedAt,
            checks,
            run: r ? { role: r.role, model: r.model, startedAt: r.startedAt, lastHeartbeat: r.lastHeartbeat, note: r.note, live, usage: group !== undefined ? (usage.get(group) ?? null) : null } : null,
            waiting: wait ? { kind: wait.kind, label: WAIT_LABEL[wait.kind], detail: i.canReadDigest ? wait.detail : null, since: wait.since } : null,
            decision: d ? { id: d.id, kind: d.kind, question: d.question, options: d.options, recommendation: d.recommendation } : null,
            level: t.level,
            batch: batch ? { status: batch.status, id: batch.batch } : null,
            highRisk,
            actions: {
                watch: live && isWriter(i.role) ? 'feed' : null,
                steer: !!live && isWriter(i.role),
                // A landing decision is the Approve action, not an answer.
                answer: !!d && d.kind !== 'land' && mayAnswerKind(d.kind, i.role),
                approve,
            },
        });
    }
    // Oldest first in each column: what has waited longest is on top.
    cards.sort((a, b) => BOARD_COLUMNS.indexOf(a.column) - BOARD_COLUMNS.indexOf(b.column) || a.since.localeCompare(b.since) || a.issue - b.issue);
    const summaries = batchSummaries(i.events).filter((b) => b.prs.length);
    const batches = [...summaries.filter((b) => b.open).reverse(), ...summaries.filter((b) => !b.open).slice(-RECENT_BATCHES).reverse()].map((b) => ({ id: b.id, status: b.status, prs: b.prs.map((x) => x.number), issues: b.prs.map((x) => x.issue), at: b.at, detail: b.detail }));
    return { instance: i.instance, role: i.role, at: now.toISOString(), columns: BOARD_COLUMNS.map((id) => ({ id, label: COLUMN_LABEL[id] })), cards, slots: i.slots, batches };
}
/**
 * A card as a viewer (read on the repo) may have it: an allowlist of its fields, as src/viewer-events.ts allows a
 * viewer only some events and fields. A viewer sees the task's progress, its PR, its decision and why it waits
 * (not the digest's reason): never the agent running on it (its live run, what it uses), the change's size or the
 * checks' outcomes, which come from events viewers don't get; and they may do nothing from it. A field added to
 * cards later stays hidden from viewers until it is put here.
 */
export const VIEWER_CARD_FIELDS = Object.freeze(['instance', 'issue', 'title', 'column', 'status', 'pr', 'startedAt', 'since', 'waiting', 'decision', 'level', 'batch', 'highRisk']);
const VIEWER_PR_FIELDS = Object.freeze(['number', 'url']);
const VIEWER_WAIT_FIELDS = Object.freeze(['kind', 'label', 'since']);
const VIEWER_DECISION_FIELDS = Object.freeze(['id', 'kind', 'question', 'options', 'recommendation']);
export const VIEWER_BOARD_KEYS = Object.freeze(['instance', 'role', 'at', 'columns', 'cards', 'slots', 'batches']);
/** A PR batch as a viewer sees it: its status (src/viewer-events.ts), not what happened in it. */
const VIEWER_BOARD_BATCH_FIELDS = Object.freeze(['id', 'status', 'prs', 'issues', 'at']);
const VIEWER_CARD_BATCH_FIELDS = Object.freeze(['status', 'id']);
const pick = (o, keys) => (o && typeof o === 'object' ? Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]])) : null);
/** The board as a viewer may have it: only the allowlisted keys, each card only its allowlisted fields, and no actions. */
export function boardForViewer(b) {
    const out = pick(b, VIEWER_BOARD_KEYS);
    out.cards = b.cards.map((c) => {
        const v = pick(c, VIEWER_CARD_FIELDS);
        if (v.pr)
            v.pr = pick(v.pr, VIEWER_PR_FIELDS);
        if (v.waiting)
            v.waiting = { ...pick(v.waiting, VIEWER_WAIT_FIELDS), detail: null };
        if (v.decision)
            v.decision = pick(v.decision, VIEWER_DECISION_FIELDS);
        if (v.batch)
            v.batch = pick(v.batch, VIEWER_CARD_BATCH_FIELDS);
        return { ...v, actions: { watch: null, steer: false, answer: false, approve: null } };
    });
    out.batches = (b.batches ?? []).map((x) => pick(x, VIEWER_BOARD_BATCH_FIELDS));
    return out;
}
//# sourceMappingURL=board.js.map