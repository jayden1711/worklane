export const STATUS_ORDER = ['triage', 'ready', 'claimed', 'reproducing', 'building', 'verifying', 'evaluating', 'awaiting_decision', 'queued', 'landed', 'done', 'blocked', 'released'];
const RUN_STATUS = {
    'evaluator-repro': 'reproducing',
    worker: 'building',
    investigator: 'building',
    'evaluator-verdict': 'evaluating',
};
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
        case 'baseline.recorded':
            return `baseline: ${p.failing.length} failing at ${String(p.sha).slice(0, 8)}`;
        case 'lesson.proposed':
            return `lesson proposed`;
        case 'issue.seen':
            return p.actionable ? 'seen: actionable' : `seen: ${p.why}`;
        case 'contract.missing':
            return `no contract: ${p.why}`;
        case 'land.batch':
            return `batch ${p.outcome}: ${p.issues.map((x) => `#${x}`).join(' ')}`;
        case 'governor.hold':
            return `dispatch held: ${p.reason}`;
        case 'governor.release':
            return 'dispatch resumed';
        case 'trust.evaluated':
            return `trust: stage ${p.stage} ${p.healthy ? 'healthy' : `not healthy (${p.why.join('; ')})`}`;
        case 'stage.changed':
            return `trust stage ${p.from} -> ${p.to} (${p.by})`;
        case 'report.posted':
            return `report posted (${p.slot})`;
        case 'lessons.pr':
            return `lessons PR opened (${p.count})`;
        case 'nightly.queued':
            return 'nightly runs queued';
        default:
            return e.type;
    }
}
export function project(events, today = new Date().toISOString().slice(0, 10)) {
    const tasks = new Map();
    const decisions = new Map();
    const deploys = [];
    const spendByRole = {};
    let spendToday = 0;
    let landedToday = 0;
    let baseline = null;
    let coordinator = null;
    const errors = [];
    const active = new Map();
    const recent = [];
    const queue = new Map();
    const batches = new Map();
    let governor = null;
    const trust = { stage: null, evaluations: [], changes: [] };
    const reports = [];
    const lessonPrs = [];
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
                spendByRole[String(p.role)] = (spendByRole[String(p.role)] ?? 0) + usd;
                if (e.ts.startsWith(today))
                    spendToday += usd;
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
                    if (e.ts.startsWith(today))
                        landedToday++;
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
                else if (t.status !== 'blocked')
                    t.status = 'released';
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
                break;
            case 'coordinator.tick':
                if (coordinator)
                    coordinator.lastTick = e.ts;
                break;
            case 'coordinator.error':
                errors.push({ at: e.ts, where: String(p.where), message: String(p.message) });
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
                batches.set(String(p.id), { id: String(p.id), issues: p.issues, tip: String(p.tip), outcome: String(p.outcome), detail: String(p.detail).slice(0, 300), at: b?.at ?? e.ts });
                break;
            }
            case 'governor.hold':
                governor = { held: true, reason: String(p.reason), load: p.load ?? null, freeDiskPct: p.free_disk_pct ?? null, at: e.ts };
                break;
            case 'governor.release':
                governor = { held: false, reason: null, load: p.load ?? null, freeDiskPct: p.free_disk_pct ?? null, at: e.ts };
                break;
            case 'trust.evaluated':
                trust.evaluations.push({ day: String(p.day), stage: Number(p.stage), healthy: Boolean(p.healthy), why: p.why });
                break;
            case 'stage.changed':
                trust.stage = Number(p.to);
                trust.changes.push({ from: Number(p.from), to: Number(p.to), by: String(p.by), reason: String(p.reason), at: e.ts });
                break;
            case 'report.posted':
                reports.push({ day: String(p.day), slot: String(p.slot), issue: p.issue ?? null, at: e.ts });
                break;
            case 'lessons.pr':
                lessonPrs.push({ day: String(p.day), count: Number(p.count), url: String(p.url), at: e.ts });
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
        errors: errors.slice(-20).reverse(),
        activity,
        runs: { active: [...active.values()], recent: recent.slice(-50).reverse() },
        landQueue: [...queue.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
        batches: [...batches.values()].slice(-30).reverse(),
        governor,
        trust: { stage: trust.stage, evaluations: trust.evaluations.slice(-30).reverse(), changes: trust.changes.reverse() },
        reports: reports.slice(-30).reverse(),
        lessonPrs: lessonPrs.slice(-30).reverse(),
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
//# sourceMappingURL=projection.js.map