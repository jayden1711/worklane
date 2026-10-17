// Read models for the dashboard: the Intake page (each report, its triage, the issue it became or joined, the
// reproduction result and the replies sent) and the health panel's numbers (reports per day by source, drops by
// reason, and the time from a report to its merged fix). Built from the event log only, which holds no personal
// data: senders appear as a short hash, text only as the redacted excerpt.
const median = (xs) => {
    if (!xs.length)
        return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** The issue each report ended up on, and when each issue's fix merged. */
function links(events) {
    const issueOf = new Map();
    const mergedAt = new Map();
    for (const e of events) {
        const p = e.payload;
        if ((e.type === 'intake.filed' || e.type === 'intake.commented') && typeof p.issue === 'number')
            issueOf.set(p.id, p.issue);
        if (e.type === 'intake.decided' && typeof p.issue === 'number')
            issueOf.set(p.id, p.issue);
        if (((e.type === 'pr.closed' && p.merged === true) || e.type === 'merge.done') && typeof p.issue === 'number' && !mergedAt.has(p.issue))
            mergedAt.set(p.issue, e.ts);
        if (e.type === 'land.result' && p.outcome === 'landed' && typeof p.issue === 'number' && !mergedAt.has(p.issue))
            mergedAt.set(p.issue, e.ts);
    }
    return { issueOf, mergedAt };
}
export function intakeReports(events, limit = 200) {
    const rows = new Map();
    const { issueOf } = links(events);
    for (const e of events) {
        const p = e.payload;
        const id = p.id;
        if (!id || !e.type.startsWith('intake.'))
            continue;
        if (e.type === 'intake.received') {
            rows.set(id, { id, source: String(p.source), receivedAt: e.ts, sender: String(p.sender), kind: null, reproduction: null, outcome: 'pending', issue: null, dropped: null, replies: [], excerpt: typeof p.excerpt === 'string' ? p.excerpt : null });
            continue;
        }
        const r = rows.get(id);
        if (!r)
            continue;
        if (e.type === 'intake.triaged') {
            r.kind = String(p.kind);
            r.reproduction = p.reproduction ?? null;
        }
        else if (e.type === 'intake.dropped') {
            r.outcome = 'dropped';
            r.dropped = String(p.reason);
        }
        else if (e.type === 'intake.filed')
            r.outcome = 'filed';
        else if (e.type === 'intake.awaiting')
            r.outcome = 'awaiting_owner';
        else if (e.type === 'intake.commented')
            r.outcome = 'commented';
        else if (e.type === 'intake.grouped')
            r.outcome = 'grouped';
        else if (e.type === 'intake.asked')
            r.outcome = 'asked_owner';
        else if (e.type === 'intake.decided')
            r.outcome = p.answer === 'reject' ? 'rejected' : 'filed';
        else if (e.type === 'intake.replied' && p.ok) {
            if (!r.replies.includes(String(p.stage)))
                r.replies.push(String(p.stage));
            if (r.outcome === 'pending')
                r.outcome = 'replied';
        }
    }
    for (const r of rows.values())
        r.issue = issueOf.get(r.id) ?? null;
    return [...rows.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
}
export function intakeHealth(events, now = new Date(), days = 14) {
    const since = now.getTime() - days * 86_400_000;
    const perDay = new Map();
    const dropped = {};
    const received = new Map();
    for (const e of events) {
        const p = e.payload;
        if (Date.parse(e.ts) < since)
            continue;
        if (e.type === 'intake.received') {
            const key = `${e.ts.slice(0, 10)}\0${String(p.source)}`;
            perDay.set(key, (perDay.get(key) ?? 0) + 1);
            received.set(p.id, e.ts);
        }
        if (e.type === 'intake.dropped')
            dropped[String(p.reason)] = (dropped[String(p.reason)] ?? 0) + 1;
    }
    const { issueOf, mergedAt } = links(events);
    const minutes = [];
    for (const [id, at] of received) {
        const n = issueOf.get(id);
        const m = n !== undefined ? mergedAt.get(n) : undefined;
        if (m)
            minutes.push(Math.max(0, (Date.parse(m) - Date.parse(at)) / 60_000));
    }
    return {
        perDay: [...perDay].map(([k, reports]) => ({ day: k.split('\0')[0], source: k.split('\0')[1], reports })).sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source)),
        dropped,
        reportToMerged: { count: minutes.length, medianMinutes: median(minutes) === null ? null : Math.round(median(minutes)) },
    };
}
//# sourceMappingURL=view.js.map