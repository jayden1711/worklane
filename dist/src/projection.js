import { batchSummaries } from './coordinator/pr-batch.js';
import { hygieneLine } from './pr-hygiene.js';
import { DIRECT_LAND_REFUSED } from './direct-land.js';
import { localDay } from './local-day.js';
import { holdBanner } from './governor-holds.js';
export const STATUS_ORDER = ['triage', 'ready', 'claimed', 'reproducing', 'building', 'verifying', 'evaluating', 'awaiting_decision', 'queued', 'in_review', 'landed', 'done', 'blocked', 'released'];
/**
 * Which coordinator errors are still current, as the log is folded. Each tick runs every step and catches each
 * step's error on its own (src/coordinator.ts tick), so a `coordinator.tick` doesn't mean every step worked: an error
 * from a place clears only at a tick that ends with no new error from that place. A restart (`coordinator.started`)
 * after a tick clears the rest. A refused direct land and a config error are recorded once for a standing
 * condition, not on every tick: they stay until a restart that came after a tick (or, for a refused direct land, a
 * land that pushed: src/direct-land.ts directLandProblem). A config error recorded during start-up, before
 * `coordinator.started`, so stays through that start.
 */
class CoordinatorErrors {
    current = new Map();
    earlier = [];
    /** Places with an error since the last tick. */
    erred = new Set();
    error(at, where, message, kind) {
        const key = `${where}\n${message}`;
        const standing = kind === DIRECT_LAND_REFUSED || kind === 'config';
        const g = this.current.get(key);
        if (g) {
            g.count++;
            g.last = g.at = at;
            g.ticked = false;
            // Newest last: the map's order is the order shown (reversed).
            this.current.delete(key);
            this.current.set(key, g);
        }
        else
            this.current.set(key, { where, message, kind, count: 1, first: at, last: at, at, standing, ticked: false });
        this.erred.add(where);
    }
    tick() {
        for (const [key, g] of this.current) {
            if (g.standing)
                g.ticked = true;
            else if (!this.erred.has(g.where))
                this.retire(key);
        }
        this.erred.clear();
    }
    started() {
        for (const [key, g] of this.current)
            if (!g.standing || g.ticked || g.kind === DIRECT_LAND_REFUSED)
                this.retire(key);
        this.erred.clear();
    }
    landed() {
        for (const [key, g] of this.current)
            if (g.kind === DIRECT_LAND_REFUSED)
                this.retire(key);
    }
    retire(key) {
        const g = this.current.get(key);
        this.current.delete(key);
        this.earlier.push(plain(g));
        if (this.earlier.length > 40)
            this.earlier.splice(0, this.earlier.length - 20);
    }
    view() {
        return { errors: [...this.current.values()].slice(-20).reverse().map(plain), earlierErrors: this.earlier.slice(-20).reverse() };
    }
}
const plain = (g) => ({ where: g.where, message: g.message, kind: g.kind, count: g.count, first: g.first, last: g.last, at: g.at });
const RUN_STATUS = {
    'evaluator-repro': 'reproducing',
    worker: 'building',
    investigator: 'building',
    'evaluator-verdict': 'evaluating',
};
/** A setting's value as one short line: run windows as from-to pairs, the rest as written. */
export function settingText(v) {
    if (Array.isArray(v))
        return v.length ? v.map((w) => (w && typeof w === 'object' && 'from' in w ? `${w.from}-${w.to}` : JSON.stringify(w))).join(', ') : 'any time';
    if (v === undefined || v === null)
        return 'unset';
    return String(v);
}
export function summarize(e) {
    const p = e.payload;
    switch (e.type) {
        case 'issue.claimed':
            return `claimed by ${p.instance} for @${p.owner}`;
        case 'run.started':
            return `${p.role} started (${p.model})`;
        case 'run.finished':
            return `${p.role} ${p.reason}`;
        case 'run.cost':
            return `${p.role} cost $${Number(p.usd).toFixed(2)}`;
        case 'repro.frozen':
            return `reproduction test frozen: ${p.path}`;
        case 'repro.unavailable':
            return `no reproduction: ${p.why}`;
        case 'change.proposed':
            return `change proposed: ${p.files.length} files, ${p.lines} lines`;
        case 'change.rejected':
            return `change rejected: ${p.why}`;
        case 'check.result':
            return `${p.stage} checks: ${p.checks.every((c) => c.status === 'pass') ? 'pass' : 'fail'}`;
        case 'eval.verdict':
            return `evaluator: ${p.patch_correct ? 'approves' : 'rejects'} (${p.confidence})`;
        case 'review.level_set':
            return `review level ${p.level}`;
        case 'decision.asked':
            return `decision for @${p.owner}: ${p.question}`;
        case 'decision.answered':
            return `@${p.by} answered ${p.answer}`;
        case 'land.queued':
            return `queued for landing (${p.level})`;
        case 'testrun.finished': {
            const r = p.results;
            const failed = r.filter((x) => !x.ok).map((x) => x.tier);
            return `${p.kind} test run ${p.outcome === 'done' ? (p.ok ? 'passed' : `failed${failed.length ? `: ${failed.join(', ')}` : ''}`) : p.outcome} on ${String(p.sha).slice(0, 8)}${p.prs.length ? ` (${p.prs.map((n) => `#${n}`).join(', ')})` : ''}`;
        }
        case 'land.result':
            return `landing ${p.outcome}${p.landed ? ` at ${String(p.landed).slice(0, 8)}` : ''}`;
        case 'deploy.verified':
            return `${p.env} serving ${String(p.sha).slice(0, 8)}`;
        case 'deploy.failed':
            return `${p.env} deploy failed: ${p.why}`;
        case 'issue.released':
            return `released: ${p.why}`;
        case 'issue.blocked':
            return `blocked: ${p.why}`;
        case 'issue.closed':
            return 'closed on GitHub';
        case 'baseline.recorded':
            return `baseline: ${p.failing.length} failing at ${String(p.sha).slice(0, 8)}`;
        case 'issue.seen':
            return p.actionable ? 'seen: actionable' : `seen: ${p.why}`;
        case 'contract.missing':
            return `no contract: ${p.why}`;
        case 'land.batch':
            return `batch ${p.outcome}: ${p.issues.map((x) => `#${x}`).join(' ')}`;
        case 'pr_batch.queued':
            return `PR #${p.number} queued for a batch`;
        case 'pr_batch.step': {
            // A viewer's copy has only the id and the step (src/viewer-events.ts).
            const prs = Array.isArray(p.prs) ? p.prs.map((x) => `#${x.number}`).join(' ') : '';
            return `${p.id} ${String(p.step).replace('_', ' ')}${prs ? `: ${prs}` : ''}${p.tier ? ` (${p.tier})` : ''}`;
        }
        case 'governor.hold':
            return `dispatch held: ${p.reason}`;
        case 'governor.release':
            return 'dispatch resumed';
        case 'report.posted':
            return `report posted (${p.slot})`;
        case 'nightly.queued':
            return 'nightly runs queued';
        case 'console.message_queued':
            return `message for the ${p.role} from @${p.by}, held until its turn ends`;
        case 'console.message_delivered':
            return `message delivered to the ${p.role}`;
        case 'console.message_dropped':
            return `message to the ${p.role} dropped: the run ended first`;
        case 'console.run_stopped':
            return `${p.role} stopped by @${p.by} from the console`;
        case 'console.request_refused':
            return `console request refused: ${p.why}`;
        case 'settings.changed':
            return `setting ${p.key}: ${settingText(p.from)} → ${settingText(p.to)}, by @${p.by}`;
        case 'pr_hygiene.pass':
            return `stale PR pass: ${hygieneLine(p)}`;
        case 'pr_hygiene.merged_in':
            return `#${p.number}: ${String(p.base_sha).slice(0, 8)} merged in (base ${p.base_days} day(s) old)`;
        case 'pr_hygiene.closed':
            return `#${p.number} closed as abandoned: ${p.why}`;
        default:
            return e.type;
    }
}
/** `today`: the day (YYYY-MM-DD) "today" counts, in this machine's local time (src/local-day.ts). */
export function project(events, today = localDay()) {
    const tasks = new Map();
    const decisions = new Map();
    const deploys = [];
    const spendByRole = {};
    let spendToday = 0;
    let landedToday = 0;
    let baseline = null;
    let coordinator = null;
    const errors = new CoordinatorErrors();
    const active = new Map();
    const recent = [];
    const queue = new Map();
    const batches = new Map();
    let governor = null;
    const emergency = { lastStop: null, lastResume: null };
    const reports = [];
    const task = (n, ts) => {
        let t = tasks.get(n);
        if (!t) {
            t = { issue: n, title: `#${n}`, labels: [], author: '', owner: null, delegate: null, status: 'triage', actionable: false, why: '', level: null, levelReasons: [], doneWhen: [], verdict: null, costUsd: 0, attempts: 0, head: null, landed: null, deployed: null, repro: null, openDecision: null, blockedReason: null, lastActivity: ts, firstSeen: ts, eventIds: [] };
            tasks.set(n, t);
        }
        return t;
    };
    for (const e of events) {
        const p = e.payload;
        const n = typeof p.issue === 'number' ? p.issue : null;
        const t = n !== null ? task(n, e.ts) : null;
        if (t) {
            t.lastActivity = e.ts;
            t.eventIds.push(e.id);
        }
        switch (e.type) {
            case 'issue.seen':
                t.title = String(p.title);
                t.labels = p.labels;
                t.author = String(p.author);
                t.actionable = Boolean(p.actionable);
                t.why = String(p.why);
                // The assigned owner, until a claim names the routed one.
                if (!t.owner && typeof p.owner === 'string')
                    t.owner = p.owner;
                if (['triage', 'ready', 'released'].includes(t.status))
                    t.status = p.actionable ? 'ready' : 'triage';
                break;
            case 'contract.agreed':
                t.doneWhen = p.done_when;
                break;
            case 'contract.missing':
                t.why = String(p.why);
                t.status = 'triage';
                break;
            case 'issue.claimed':
                t.owner = String(p.owner);
                t.delegate = { instance: String(p.instance), role: 'worker' };
                t.status = 'claimed';
                t.blockedReason = null;
                t.verdict = null;
                t.level = null;
                t.landed = null;
                t.openDecision = null;
                break;
            case 'run.started':
                t.status = RUN_STATUS[String(p.role)] ?? 'building';
                if (t.delegate)
                    t.delegate.role = String(p.role);
                if (p.role === 'worker' || p.role === 'investigator')
                    t.attempts = Math.max(t.attempts, Number(p.attempt));
                break;
            case 'repro.frozen':
                t.repro = String(p.path);
                break;
            case 'change.proposed':
                t.head = String(p.head);
                t.status = 'verifying';
                break;
            case 'eval.verdict':
                t.verdict = { patch_correct: Boolean(p.patch_correct), test_correct: Boolean(p.test_correct), confidence: String(p.confidence), advice: String(p.advice) };
                break;
            case 'review.level_set':
                t.level = String(p.level);
                t.levelReasons = p.reasons;
                break;
            case 'run.cost': {
                const usd = Number(p.usd);
                if (t)
                    t.costUsd += usd;
                if (localDay(e.ts) === today) {
                    spendToday += usd;
                    spendByRole[String(p.role)] = (spendByRole[String(p.role)] ?? 0) + usd;
                }
                break;
            }
            case 'decision.asked': {
                const d = { id: String(p.id), kind: String(p.kind ?? 'question'), issue: n, owner: String(p.owner), question: String(p.question), options: p.options, recommendation: String(p.recommendation), receipts: p.receipts, askedAt: e.ts, answer: null };
                decisions.set(d.id, d);
                if (t) {
                    t.openDecision = d.id;
                    t.status = 'awaiting_decision';
                }
                break;
            }
            case 'decision.answered': {
                const d = decisions.get(String(p.id));
                if (d) {
                    d.answer = { by: String(p.by), answer: String(p.answer), at: e.ts };
                    if (d.issue !== null) {
                        const dt = task(d.issue, e.ts);
                        if (dt.openDecision === d.id)
                            dt.openDecision = null;
                    }
                }
                break;
            }
            case 'land.queued':
                t.status = 'queued';
                break;
            case 'land.result':
                if (p.outcome === 'deferred') {
                    t.status = 'queued';
                    t.blockedReason = null;
                }
                else if (p.outcome === 'landed') {
                    t.landed = String(p.landed);
                    t.status = 'landed';
                    if (localDay(e.ts) === today)
                        landedToday++;
                }
                else if (p.outcome === 'pr_opened') {
                    // PR mode: the change is out for review, not blocked.
                    t.status = 'in_review';
                    t.blockedReason = null;
                }
                else {
                    t.status = 'blocked';
                    t.blockedReason = `landing ${p.outcome}: ${String(p.detail).split('\n')[0]}`;
                }
                break;
            case 'issue.blocked':
                t.status = 'blocked';
                t.blockedReason = String(p.why);
                // A block can come before any claim (e.g. an investigation); it names who must unblock it.
                t.owner = String(p.owner);
                break;
            case 'issue.released':
                if (t.status === 'landed' || p.why === 'landed')
                    t.status = 'done';
                // A PR in review: its claim is released when it opens; the task is done once the merge closes the issue.
                else if (t.status === 'in_review')
                    t.status = p.why === 'issue closed on GitHub' ? 'done' : 'in_review';
                else if (t.status !== 'blocked' && t.status !== 'done')
                    t.status = 'released';
                t.delegate = null;
                break;
            case 'issue.closed':
                // Closed by hand on GitHub: done, whatever held it (a block, a decision); a later claim (reopened) starts it again.
                t.status = 'done';
                t.blockedReason = null;
                t.openDecision = null;
                t.delegate = null;
                break;
            case 'run.finished':
                if (!['succeeded'].includes(String(p.reason))) {
                    t.blockedReason = `${p.role} ${p.reason}: ${String(p.detail).slice(0, 200)}`;
                }
                break;
            case 'baseline.recorded':
                baseline = { sha: String(p.sha), failing: p.failing, at: e.ts };
                break;
            case 'deploy.requested':
                deploys.push({ env: String(p.env), sha: String(p.sha), status: 'requested', at: e.ts });
                break;
            case 'deploy.verified':
            case 'deploy.failed': {
                const d = [...deploys].reverse().find((x) => x.env === p.env && x.sha === p.sha);
                const status = e.type === 'deploy.verified' ? 'verified' : 'failed';
                if (d)
                    Object.assign(d, { status, at: e.ts, ...(p.why ? { why: String(p.why) } : {}) });
                else
                    deploys.push({ env: String(p.env), sha: String(p.sha), status, at: e.ts, ...(p.why ? { why: String(p.why) } : {}) });
                for (const tk of tasks.values())
                    if (tk.landed === p.sha && status === 'verified')
                        tk.deployed = String(p.env);
                break;
            }
            case 'coordinator.started':
                coordinator = { instance: String(p.instance), startedAt: e.ts, lastTick: null };
                errors.started();
                break;
            case 'coordinator.tick':
                if (coordinator)
                    coordinator.lastTick = e.ts;
                errors.tick();
                break;
            case 'coordinator.error':
                errors.error(e.ts, String(p.where), String(p.message), String(p.kind ?? 'error'));
                break;
            case 'land.batch':
                if (p.outcome === 'landed')
                    errors.landed();
                break;
        }
        // Read models that sit beside the per-task fold.
        switch (e.type) {
            case 'run.started':
                active.set(`${n}:${p.role}`, { issue: n, role: String(p.role), model: String(p.model), pid: Number(p.pid), attempt: Number(p.attempt), startedAt: e.ts, lastHeartbeat: null, note: null, finishedAt: null, reason: null, costUsd: 0 });
                break;
            case 'run.heartbeat': {
                const r = active.get(`${n}:${p.role}`);
                if (r) {
                    r.lastHeartbeat = e.ts;
                    r.note = String(p.note).slice(0, 200);
                }
                break;
            }
            case 'run.finished': {
                const r = active.get(`${n}:${p.role}`);
                if (r) {
                    active.delete(`${n}:${p.role}`);
                    r.finishedAt = e.ts;
                    r.reason = String(p.reason);
                    recent.push(r);
                }
                break;
            }
            case 'run.cost': {
                const r = [...recent].reverse().find((x) => x.issue === n && x.role === p.role && x.costUsd === 0) ?? active.get(`${n}:${p.role}`);
                if (r)
                    r.costUsd = Number(p.usd);
                break;
            }
            case 'land.queued':
                queue.set(n, { issue: n, title: t?.title ?? `#${n}`, head: String(p.head), level: String(p.level), queuedAt: e.ts, deferred: null });
                break;
            case 'land.result': {
                const q = queue.get(n);
                if (q && p.outcome === 'deferred')
                    q.deferred = String(p.detail).split('\n')[0].slice(0, 200);
                else
                    queue.delete(n);
                break;
            }
            case 'land.batch': {
                const b = batches.get(String(p.id));
                batches.set(String(p.id), { id: String(p.id), kind: 'land', issues: p.issues, prs: [], tip: String(p.tip), outcome: String(p.outcome), detail: String(p.detail).slice(0, 300), at: b?.at ?? e.ts });
                break;
            }
            case 'governor.hold':
                governor = { held: true, reason: String(p.reason), load: p.load ?? null, freeDiskPct: p.free_disk_pct ?? null, at: e.ts, banner: holdBanner({ kind: p.kind, reason: String(p.reason), facts: p.facts }, e.ts) };
                break;
            case 'governor.release':
                governor = { held: false, reason: null, load: p.load ?? null, freeDiskPct: p.free_disk_pct ?? null, at: e.ts, banner: null };
                break;
            case 'emergency.stop':
                emergency.lastStop = { at: e.ts, by: String(p.by), reason: String(p.reason), running: Number(p.running) };
                break;
            case 'emergency.resume':
                emergency.lastResume = e.ts;
                break;
            case 'report.posted':
                reports.push({ day: String(p.day), slot: String(p.slot), issue: p.issue ?? null, at: e.ts });
                break;
        }
    }
    const activity = events
        .filter((e) => !['coordinator.tick', 'run.heartbeat'].includes(e.type))
        .slice(-200)
        .reverse()
        .map((e) => ({ id: e.id, ts: e.ts, type: e.type, actor: e.actor, issue: typeof e.payload.issue === 'number' ? (e.payload.issue) : null, summary: summarize(e) }));
    return {
        lastId: events.at(-1)?.id ?? 0,
        tasks: [...tasks.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
        decisions: [...decisions.values()].sort((a, b) => b.askedAt.localeCompare(a.askedAt)),
        spendToday,
        spendByRole,
        landedToday,
        baseline,
        deploys: deploys.slice(-50).reverse(),
        coordinator,
        ...errors.view(),
        activity,
        runs: { active: [...active.values()], recent: recent.slice(-50).reverse() },
        landQueue: [...queue.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
        batches: [
            ...batches.values(),
            ...batchSummaries(events)
                .filter((s) => s.prs.length)
                .map((s) => ({ id: s.id, kind: 'pr', issues: s.prs.map((x) => x.issue), prs: s.prs.map((x) => x.number), tip: '', outcome: s.status, detail: s.detail.slice(0, 300), at: s.at })),
        ]
            .sort((a, b) => a.at.localeCompare(b.at))
            .slice(-30)
            .reverse(),
        governor,
        emergency,
        reports: reports.slice(-30).reverse(),
    };
}
/** What needs this person: their open decisions, their blocked tasks, and recent L2 landings to look over. */
export function inbox(p, user) {
    const u = user.toLowerCase();
    const mine = (o) => (o ?? '').toLowerCase() === u;
    return {
        decisions: p.decisions.filter((d) => !d.answer && mine(d.owner)),
        blocked: p.tasks.filter((t) => t.status === 'blocked' && mine(t.owner)),
        notify: p.tasks.filter((t) => (t.status === 'landed' || t.status === 'done') && t.level === 'L2' && mine(t.owner)).slice(0, 20),
    };
}
/** An issue's check results, newest first: every check the coordinator ran itself, with each failure's output. */
export function checkResults(events, issue) {
    const out = [];
    for (const e of events) {
        if (e.type !== 'check.result' && e.type !== 'issue.no_change')
            continue;
        const p = e.payload;
        if (p.issue !== issue)
            continue;
        out.push({
            id: e.id,
            at: e.ts,
            stage: e.type === 'issue.no_change' ? 'no change' : String(p.stage),
            head: String(p.head ?? p.base ?? ''),
            checks: p.checks.map((c) => ({ check: c.check, status: c.status, exitCode: c.exitCode ?? null, tail: c.tail ?? null })),
        });
    }
    return out.reverse();
}
/** Every PR the harness opened, newest first, with what happened to it; plus refused pushes and auto-merge stops. */
export function prsView(events) {
    const titles = new Map();
    const prs = new Map();
    const refused = [];
    const stops = [];
    const holds = [];
    let hygiene = null;
    for (const e of events) {
        const p = e.payload;
        const n = Number(p.number);
        const pr = prs.get(n);
        switch (e.type) {
            case 'issue.seen':
                titles.set(Number(p.issue), String(p.title));
                break;
            case 'pr.opened':
                prs.set(n, { number: n, issue: Number(p.issue), title: titles.get(Number(p.issue)) ?? `#${p.issue}`, url: String(p.url), openedAt: e.ts, head: String(p.head), state: 'open', draft: Boolean(p.draft), status: null, unready: null, fixes: [], gaveUp: null, decision: null, waitReasons: [], merged: null, mergeFailed: null, mainResult: null, conflict: null, lightCheck: null, phase: 'checks' });
                break;
            case 'pr.status':
                if (pr) {
                    pr.status = { head: String(p.head), at: e.ts, ready: Boolean(p.ready), reasons: p.reasons, checks: p.checks };
                    // The watch reads the PR's head on GitHub: after a person pushes, that's the PR's head, not the harness's last push.
                    pr.head = String(p.head);
                }
                break;
            case 'pr.ready':
                if (pr)
                    pr.draft = false;
                break;
            case 'pr.unready':
                if (pr) {
                    pr.draft = true;
                    pr.unready = { at: e.ts, why: String(p.why) };
                }
                break;
            case 'ci_fix.started':
                if (pr)
                    pr.fixes.push({ attempt: Number(p.attempt), at: e.ts, checks: p.checks, outcome: 'running', detail: '' });
                break;
            case 'ci_fix.finished':
                if (pr) {
                    const f = pr.fixes.at(-1);
                    if (f && f.outcome === 'running')
                        Object.assign(f, { outcome: p.outcome, detail: String(p.detail) });
                    if (p.outcome === 'pushed' && p.head)
                        pr.head = String(p.head);
                }
                break;
            case 'ci_fix.gave_up':
                if (pr)
                    pr.gaveUp = { at: e.ts, reason: String(p.reason) };
                break;
            case 'merge.decided':
                if (pr)
                    pr.decision = { at: e.ts, head: String(p.head), auto: Boolean(p.auto), reasons: p.reasons };
                break;
            case 'merge.done':
                if (pr) {
                    pr.merged = { at: e.ts, sha: String(p.sha), url: String(p.url), auto: true };
                    pr.state = 'merged';
                }
                break;
            case 'merge.failed':
                if (pr)
                    pr.mergeFailed = { at: e.ts, why: String(p.why) };
                break;
            case 'merge.main_result':
                if (pr)
                    pr.mainResult = { at: e.ts, outcome: p.outcome, failed: p.failed };
                break;
            case 'pr.closed':
                if (pr) {
                    pr.state = p.merged ? 'merged' : 'closed';
                    if (p.merged && !pr.merged)
                        pr.merged = { at: e.ts, sha: '', url: pr.url, auto: false };
                }
                break;
            case 'push.refused':
                refused.push({ at: e.ts, issue: Number(p.issue), title: titles.get(Number(p.issue)) ?? `#${p.issue}`, head: String(p.head), stage: String(p.stage), reasons: p.reasons });
                break;
            case 'merge.stopped':
                stops.push({ at: e.ts, kind: 'stopped', reason: String(p.reason), number: p.number ?? null, revert: p.revert ?? null });
                break;
            case 'merge.resumed':
                stops.push({ at: e.ts, kind: 'resumed', reason: String(p.detail), number: null, revert: null });
                break;
            case 'conflict_fix.detected':
                if (pr)
                    pr.conflict = { state: 'detected', at: e.ts, attempt: 0, outcome: null, files: [], waitsOwner: false, reasons: [], detail: '' };
                break;
            case 'conflict_fix.started':
                if (pr)
                    pr.conflict = { ...(pr.conflict ?? { files: [], waitsOwner: false, reasons: [], detail: '', outcome: null }), state: 'running', at: e.ts, attempt: Number(p.attempt) };
                break;
            case 'conflict_fix.finished':
                if (pr) {
                    pr.conflict = { state: 'done', at: e.ts, attempt: pr.conflict?.attempt ?? 1, outcome: String(p.outcome), files: p.files, waitsOwner: Boolean(p.waits_owner), reasons: p.reasons, detail: String(p.detail) };
                    if (p.outcome === 'pushed' && p.head)
                        pr.head = String(p.head);
                }
                break;
            case 'light_check.started':
                if (pr)
                    pr.lightCheck = { state: 'running', at: e.ts, mainSha: String(p.main_sha), overlap: p.overlap, outcome: null, waitMs: null, detail: '' };
                break;
            case 'light_check.finished':
                if (pr)
                    pr.lightCheck = { state: 'done', at: e.ts, mainSha: String(p.main_sha), overlap: p.overlap, outcome: String(p.outcome), waitMs: Number(p.wait_ms), detail: String(p.detail) };
                break;
            case 'pr_hygiene.pass': {
                const c = { merged_in: Number(p.merged_in), conflicting: Number(p.conflicting), closed: Number(p.closed), held: Number(p.held), skipped: Number(p.skipped) };
                hygiene = { ...c, at: e.ts, line: hygieneLine(c) };
                break;
            }
            case 'hotspot.held':
                holds.push({ issue: Number(p.issue), title: titles.get(Number(p.issue)) ?? `#${p.issue}`, by: Number(p.by), files: p.files, reason: String(p.reason), since: e.ts, until: null, waitedMs: null });
                break;
            case 'hotspot.released': {
                const h = [...holds].reverse().find((x) => x.issue === Number(p.issue) && x.until === null && x.kind !== 'dependency');
                if (h)
                    Object.assign(h, { until: e.ts, waitedMs: Number(p.waited_ms) });
                break;
            }
            case 'dependency.held': {
                // INVARIANT: one row per wait; a later hold for the same wait (a dependency closed, others still open) updates it.
                const on = p.on;
                const h = [...holds].reverse().find((x) => x.issue === Number(p.issue) && x.until === null && x.kind === 'dependency');
                if (h)
                    Object.assign(h, { by: on[0] ?? h.by, reason: String(p.reason) });
                else
                    holds.push({ issue: Number(p.issue), title: titles.get(Number(p.issue)) ?? `#${p.issue}`, by: on[0] ?? Number(p.issue), files: [], reason: String(p.reason), since: e.ts, until: null, waitedMs: null, kind: 'dependency' });
                break;
            }
            case 'dependency.unblocked': {
                const h = [...holds].reverse().find((x) => x.issue === Number(p.issue) && x.until === null && x.kind === 'dependency');
                if (h)
                    Object.assign(h, { until: e.ts, waitedMs: Number(p.waited_ms) });
                break;
            }
        }
    }
    for (const pr of prs.values()) {
        pr.waitReasons = pr.decision && !pr.decision.auto && pr.decision.head === pr.head ? pr.decision.reasons : [];
        pr.phase = phaseOf(pr);
    }
    return { prs: [...prs.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.number - a.number), refused: refused.reverse(), stops: stops.reverse(), holds: holds.reverse(), hygiene };
}
/** Whether the last conflict fix left the PR to a person: it gave up, or what it pushed waits for review. */
export const conflictNeedsOwner = (pr) => !!pr.conflict && pr.conflict.state === 'done' && (pr.conflict.outcome === 'gave_up' || pr.conflict.waitsOwner);
function phaseOf(pr) {
    if (pr.state === 'merged')
        return pr.merged?.auto ? 'auto_merged' : 'merged';
    if (pr.state === 'closed')
        return 'closed';
    if (pr.fixes.at(-1)?.outcome === 'running')
        return 'fixing';
    if (pr.conflict && pr.conflict.state !== 'done')
        return 'resolving';
    if (pr.gaveUp)
        return 'gave_up';
    // A conflict fix that gave up, or whose result needs a person, leaves it to the owner.
    if (conflictNeedsOwner(pr))
        return 'waiting';
    if (pr.lightCheck?.state === 'running')
        return 'light_check';
    // A "wait for a person" call stands while the PR is still at the head it was made on.
    if (pr.decision && !pr.decision.auto && pr.decision.head === pr.head)
        return 'waiting';
    return pr.draft ? 'checks' : 'ready';
}
//# sourceMappingURL=projection.js.map