const H = 3_600_000;
const median = (xs) => {
    if (!xs.length)
        return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export function scorecard(events, opts) {
    const from = opts.from.getTime();
    const to = (opts.to ?? new Date()).getTime();
    const inWin = (e) => {
        const t = Date.parse(e.ts);
        return t >= from && t <= to;
    };
    const p = (e) => e.payload;
    const win = events.filter(inWin);
    const verdicts = win.filter((e) => e.type === 'eval.verdict').map((e) => p(e).patch_correct);
    // Unverified claims: a worker run "succeeded", then the same issue's next verdict on it was negative.
    let claims = 0;
    let unverified = 0;
    const byIssue = new Map();
    for (const e of events) {
        const n = p(e).issue;
        if (typeof n === 'number')
            (byIssue.get(n) ?? byIssue.set(n, []).get(n)).push(e);
    }
    for (const evs of byIssue.values()) {
        for (let i = 0; i < evs.length; i++) {
            const e = evs[i];
            if (!inWin(e) || e.type !== 'run.finished')
                continue;
            const r = p(e);
            if (r.role !== 'worker' || r.reason !== 'succeeded')
                continue;
            claims++;
            const next = evs.slice(i + 1).find((x) => ['change.rejected', 'check.result', 'eval.verdict', 'run.started'].includes(x.type));
            if (!next)
                continue;
            if (next.type === 'change.rejected')
                unverified++;
            else if (next.type === 'check.result' && p(next).checks.some((c) => c.status !== 'pass'))
                unverified++;
        }
    }
    const landed = win.filter((e) => e.type === 'land.result' && p(e).outcome === 'landed');
    const reverts = opts.revertedShas ? landed.filter((e) => opts.revertedShas.has(p(e).landed)).length : 0;
    const redCaught = win.filter((e) => e.type === 'land.result' && p(e).outcome === 'red').length;
    const baselines = events.filter((e) => e.type === 'baseline.recorded');
    const before = [...baselines].reverse().find((e) => Date.parse(e.ts) < from) ?? baselines.find(inWin);
    const latest = [...baselines].reverse().find((e) => Date.parse(e.ts) <= to);
    const baselineGrowth = before && latest ? p(latest).failing.filter((f) => !p(before).failing.includes(f)).length : 0;
    // Ready-to-done runs from the first actionable sighting.
    // Done is landed when there's no deploy target, or verified on an environment when there is.
    const issueBySha = new Map();
    for (const e of events)
        if (e.type === 'land.result' && p(e).outcome === 'landed')
            issueBySha.set(p(e).landed, p(e).issue);
    const doneAt = new Map();
    for (const e of win) {
        const n = e.type === 'issue.released' && p(e).why === 'landed' ? p(e).issue : e.type === 'deploy.verified' ? issueBySha.get(p(e).sha) : undefined;
        if (n !== undefined && !doneAt.has(n))
            doneAt.set(n, Date.parse(e.ts));
    }
    const firstReady = new Map();
    for (const e of events)
        if (e.type === 'issue.seen' && p(e).actionable && !firstReady.has(p(e).issue))
            firstReady.set(p(e).issue, Date.parse(e.ts));
    const leadTimes = [...doneAt].filter(([n]) => firstReady.has(n)).map(([n, t]) => (t - firstReady.get(n)) / H);
    const spendUsd = win.filter((e) => e.type === 'run.cost').reduce((s, e) => s + p(e).usd, 0);
    const interventions = win.filter((e) => e.type === 'decision.answered' || e.type === 'issue.blocked').length;
    // Idle: intervals between ticks where nothing ran but ready work waited (each interval capped at 10 min).
    let idleMs = 0;
    const ticks = events.filter((e) => e.type === 'coordinator.tick');
    for (let i = 1; i < ticks.length; i++) {
        const prev = ticks[i - 1];
        const t0 = Math.max(Date.parse(prev.ts), from);
        const t1 = Math.min(Date.parse(ticks[i].ts), to);
        if (t1 <= t0)
            continue;
        const st = p(prev);
        if ((st.active ?? 1) === 0 && (st.ready ?? 0) > 0)
            idleMs += Math.min(t1 - t0, 10 * 60_000);
    }
    // Waiting on the owner: decisions until answered (or now), and blocks until the next claim (or now).
    const answeredAt = new Map(events.filter((e) => e.type === 'decision.answered').map((e) => [p(e).id, Date.parse(e.ts)]));
    let decisionMs = 0;
    for (const e of events.filter((x) => x.type === 'decision.asked')) {
        const a = Math.max(Date.parse(e.ts), from);
        const b = Math.min(answeredAt.get(p(e).id) ?? to, to);
        if (b > a)
            decisionMs += b - a;
    }
    let blockedMs = 0;
    for (const evs of byIssue.values()) {
        for (let i = 0; i < evs.length; i++) {
            if (evs[i].type !== 'issue.blocked')
                continue;
            const until = evs.slice(i + 1).find((x) => x.type === 'issue.claimed');
            const a = Math.max(Date.parse(evs[i].ts), from);
            const b = Math.min(until ? Date.parse(until.ts) : to, to);
            if (b > a)
                blockedMs += b - a;
        }
    }
    const done = doneAt.size;
    const round = (x) => Math.round(x * 100) / 100;
    return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        tasksDone: done,
        evaluatorPassRate: verdicts.length ? round(verdicts.filter(Boolean).length / verdicts.length) : null,
        unverifiedClaimRate: claims ? round(unverified / claims) : null,
        reverts,
        redCaught,
        baselineGrowth,
        costPerDoneUsd: done ? round(spendUsd / done) : null,
        readyToDoneHours: leadTimes.length ? round(median(leadTimes)) : null,
        interventionsPerTask: done ? round(interventions / done) : null,
        idleHours: round(idleMs / H),
        decisionWaitHours: round(decisionMs / H),
        blockedHours: round(blockedMs / H),
        spendUsd: round(spendUsd),
    };
}
//# sourceMappingURL=scorecard.js.map