/**
 * Whether this instance's test runs came up, as its coordinator last said at a start (./setup.ts): the newest of its
 * sandbox check's result and an outdated helper (which skips the check and refuses every run). null: it never said
 * (no test runs configured, or it hasn't started with them). The engine updater compares this across an update
 * (the `sandbox-status` command).
 */
export function sandboxVerdict(events) {
    let last = null;
    for (const e of events) {
        if (e.type === 'testrun.sandbox') {
            const p = e.payload;
            last = { ok: p.ok, detail: p.detail, at: e.ts };
        }
        else if (e.type === 'testrun.helper') {
            const p = e.payload;
            if (!p.ok)
                last = { ok: false, detail: p.detail, at: e.ts };
        }
    }
    return last;
}
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
};
export function testRunStatus(events, recentN = 30) {
    const rows = new Map();
    const st = { sandbox: null, checksPermission: null, checksBlocked: null, queue: [], running: [], recent: [], tierStats: [], wipeFailures: [], problems: [] };
    const tierRuns = new Map();
    let helperProblem = null;
    for (const e of events) {
        switch (e.type) {
            case 'testrun.queued': {
                const p = e.payload;
                rows.set(p.id, { id: p.id, sha: p.sha, kind: p.kind, prs: p.prs, shard: p.shard, state: 'queued', queuedAt: e.ts, startedAt: null, finishedAt: null, slot: null, lockWaitMs: null, tiers: [] });
                break;
            }
            case 'testrun.started': {
                const p = e.payload;
                const r = rows.get(p.id);
                if (r)
                    Object.assign(r, { state: 'running', startedAt: e.ts, slot: p.slot, lockWaitMs: p.lock_wait_ms });
                break;
            }
            case 'testrun.tier': {
                const p = e.payload;
                rows.get(p.id)?.tiers.push({ tier: p.tier, ok: p.ok, durationMs: p.duration_ms, summary: p.summary, logRef: p.log_ref });
                const t = tierRuns.get(p.tier) ?? { ms: [], mem: [], cpu: [] };
                t.ms.push(p.duration_ms);
                if (p.mem_peak_mb !== null)
                    t.mem.push(p.mem_peak_mb);
                if (p.cpu_s !== null)
                    t.cpu.push(p.cpu_s);
                tierRuns.set(p.tier, t);
                break;
            }
            case 'testrun.finished': {
                const p = e.payload;
                const r = rows.get(p.id);
                if (!r)
                    break;
                r.finishedAt = e.ts;
                r.state = p.outcome === 'cancelled' ? 'cancelled' : p.outcome === 'interrupted' ? 'interrupted' : p.ok ? 'passed' : 'failed';
                // Tiers that never ran (setup failed, cancelled) appear from the final results.
                for (const x of p.results)
                    if (!r.tiers.some((t) => t.tier === x.tier))
                        r.tiers.push({ tier: x.tier, ok: x.ok, durationMs: null });
                break;
            }
            case 'testrun.wipe_failed': {
                const p = e.payload;
                st.wipeFailures.push({ id: p.id, left: p.left, at: e.ts });
                break;
            }
            case 'testrun.sandbox': {
                const p = e.payload;
                st.sandbox = { ok: p.ok, detail: p.detail, at: e.ts };
                break;
            }
            case 'testrun.helper': {
                const p = e.payload;
                helperProblem = p.ok ? null : p.detail;
                break;
            }
            case 'testrun.checks_permission': {
                const p = e.payload;
                st.checksPermission = { level: p.level, detail: p.detail, at: e.ts };
                break;
            }
            case 'testrun.checks_failed': {
                const p = e.payload;
                if (p.reason === 'no_permission')
                    st.checksBlocked = { detail: p.detail, at: e.ts };
                break;
            }
            case 'testrun.checks_posted':
                st.checksBlocked = null;
                break;
        }
    }
    const all = [...rows.values()];
    st.queue = all.filter((r) => r.state === 'queued');
    st.running = all.filter((r) => r.state === 'running');
    st.recent = all.filter((r) => r.finishedAt).slice(-recentN).reverse();
    st.tierStats = [...tierRuns.entries()].map(([tier, t]) => ({ tier, runs: t.ms.length, medianMs: median(t.ms), peakMemMb: t.mem.length ? Math.max(...t.mem) : null, maxCpuS: t.cpu.length ? Math.max(...t.cpu) : null }));
    st.wipeFailures = st.wipeFailures.slice(-10);
    if (helperProblem)
        st.problems.push(`Test runs are off: ${helperProblem}`);
    if (st.sandbox && !st.sandbox.ok)
        st.problems.push(`Test runs are off: the sandbox failed its check (${st.sandbox.detail.split('\n')[0]}). It is checked again by itself (every 5 minutes at most), and test runs go on when it passes. If it keeps failing, an admin runs scripts/setup/test-user.sh check and fixes the FAIL lines; no restart needed.`);
    const cannotPost = st.checksBlocked ?? (st.checksPermission && st.checksPermission.level !== 'write' && st.checksPermission.level !== 'unknown' ? st.checksPermission : null);
    if (cannotPost)
        st.problems.push(`Test runs can't post their checks: the App has no Checks: write permission${st.checksPermission ? ` (it has ${st.checksPermission.level})` : ''}. The owner adds Checks: read & write in the App's settings and accepts it on the installation; until then results are only on the dashboard.`);
    if (st.wipeFailures.length)
        st.problems.push(`A test run was not wiped completely (${st.wipeFailures.at(-1).id}: ${st.wipeFailures.at(-1).left.slice(0, 3).join(', ')}).`);
    return st;
}
/** What a viewer sees of the test runs: each run's commit, PRs, state and tiers' pass or fail. Never a log, summary or slot. */
export function viewerTestRuns(s) {
    const row = (r) => ({ id: r.id, sha: r.sha, kind: r.kind, prs: r.prs, state: r.state, tiers: r.tiers.map((t) => ({ tier: t.tier, ok: t.ok })) });
    return { queue: s.queue.map(row), running: s.running.map(row), recent: s.recent.map(row) };
}
/**
 * The test runs as the dashboard shows them. Owners and writers: the queue, the running slots and their holders,
 * the full-run lock's holders, results with each tier's summary, per-tier figures, and the problems. A viewer: the
 * runs' commits, PRs, states and tiers' pass or fail, and the slot counts; never a log, summary, holder or problem.
 */
export function testRunsView(i) {
    const s = testRunStatus(i.events);
    const base = { configured: i.configured, cap: i.cap, inUse: i.slots.length };
    if (!i.writer)
        return { ...base, viewer: true, ...viewerTestRuns(s) };
    return {
        ...base,
        viewer: false,
        slots: i.slots,
        lock: i.lock,
        queue: s.queue,
        running: s.running,
        recent: s.recent,
        tierStats: s.tierStats,
        sandbox: s.sandbox,
        checksPermission: s.checksPermission,
        problems: s.problems,
    };
}
//# sourceMappingURL=status.js.map