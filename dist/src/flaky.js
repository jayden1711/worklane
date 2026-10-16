export const FLAKY_EVENTS = ['flaky.rerun_requested', 'flaky.rerun_result', 'flaky.quarantined', 'flaky.sighted', 'flaky.observed', 'flaky.released'];
/** Every test ever quarantined, by name, as the log has it now. */
export function quarantine(events) {
    const q = new Map();
    for (const e of events) {
        if (e.type === 'flaky.quarantined') {
            const p = e.payload;
            const was = q.get(p.test);
            q.set(p.test, {
                test: p.test,
                state: 'quarantined',
                firstSeen: was?.firstSeen ?? e.ts,
                lastSeen: e.ts,
                sightings: (was?.sightings ?? 0) + 1,
                issue: p.issue ?? was?.issue ?? null,
                url: p.url ?? was?.url ?? null,
                passes: 0,
                released: null,
            });
        }
        else if (e.type === 'flaky.sighted') {
            const p = e.payload;
            const t = q.get(p.test);
            if (t)
                Object.assign(t, { sightings: p.sightings, lastSeen: e.ts, passes: 0 });
        }
        else if (e.type === 'flaky.observed') {
            const p = e.payload;
            const t = q.get(p.test);
            if (t && t.state === 'quarantined')
                t.passes = p.passes;
        }
        else if (e.type === 'flaky.released') {
            const p = e.payload;
            const t = q.get(p.test);
            if (t && t.state === 'quarantined')
                Object.assign(t, { state: 'released', passes: p.passes, released: { at: e.ts, how: p.how, by: p.by } });
        }
    }
    return q;
}
export const isQuarantined = (q, test) => q.get(test)?.state === 'quarantined';
/** A failure, as the harness's red/green decisions count one. */
export const failed = (o) => o === 'fail' || o === 'cancelled';
/**
 * The re-run's verdict on each check that failed: passed now (flaky), failed again or couldn't re-run (real), or
 * not finished (waiting; real once `timedOut`). `now`: each check's outcome on the re-run, null while it runs.
 */
export function classifyRerun(checks, timedOut) {
    const v = { flaky: [], real: [], timedOut: [], waiting: [] };
    for (const c of checks) {
        if (c.now === 'pass')
            v.flaky.push(c.check);
        else if (c.now === 'fail')
            v.real.push(c.check);
        else if (timedOut) {
            v.real.push(c.check);
            v.timedOut.push(c.check);
        }
        else
            v.waiting.push(c.check);
    }
    return v;
}
/** The passes in a row after one more result, and whether that releases it (at `releaseAfter`). */
export function afterResult(passes, ok, releaseAfter) {
    const n = ok ? passes + 1 : 0;
    return { passes: n, release: ok && n >= releaseAfter };
}
/** The flake rate over each window (default 7 and 30 days, up to `now`): flaky re-runs over red runs. */
export function flakeRates(events, now, windows = [7, 30]) {
    const requested = new Map();
    const flakySha = new Set();
    for (const e of events) {
        if (e.type === 'flaky.rerun_requested')
            requested.set(e.payload.sha, Date.parse(e.ts));
        else if (e.type === 'flaky.rerun_result') {
            const p = e.payload;
            if (p.flaky.length)
                flakySha.add(p.sha);
        }
    }
    return windows.map((days) => {
        const since = now.getTime() - days * 86_400_000;
        const red = [...requested.entries()].filter(([, t]) => t >= since && t <= now.getTime());
        const flaky = red.filter(([sha]) => flakySha.has(sha)).length;
        return { days, redRuns: red.length, flakyReruns: flaky, rate: red.length ? flaky / red.length : null };
    });
}
export const issueTitle = (test) => `Flaky test: ${test}`;
export function issueBody(o) {
    return [
        `The check \`${o.test}\` failed on \`${o.sha.slice(0, 8)}\` on ${o.branch}, then passed when ${o.product} re-ran it on the same commit: it is flaky.`,
        '',
        `It is quarantined: it still runs and reports (red on GitHub when it fails), but it no longer stops auto-merge, opens a revert or a fix for ${o.product}. It blocks again after ${o.releaseAfter} passes in a row on ${o.branch}, or when an owner clears it on the dashboard (Reports, Flaky tests).`,
        '',
        'Quarantine never changes what the updater requires: every check green on the exact commit.',
        '',
        'Each new sighting is counted on the dashboard; this issue is the only one filed for it.',
    ].join('\n');
}
/** The dashboard's view: the quarantined tests, those released lately, and the flake rate. */
export function flakyView(events, o) {
    const q = [...quarantine(events).values()];
    return {
        releaseAfter: o.releaseAfter,
        quarantined: q.filter((t) => t.state === 'quarantined').sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
        released: q
            .filter((t) => t.state === 'released')
            .sort((a, b) => (b.released?.at ?? '').localeCompare(a.released?.at ?? ''))
            .slice(0, 20),
        rates: flakeRates(events, o.now),
    };
}
/**
 * An owner clears a test from quarantine (the dashboard; the caller checks they are an owner and audits it): it blocks
 * again from the next commit. Refused for a test not quarantined.
 */
export function releaseByOwner(log, test, by) {
    const name = typeof test === 'string' ? test.trim() : '';
    if (!name)
        return { ok: false, status: 400, error: 'name the test (the check) to clear' };
    const t = quarantine(log.read(0, [...FLAKY_EVENTS])).get(name);
    if (!t || t.state !== 'quarantined')
        return { ok: false, status: 404, error: `${name.slice(0, 200)} is not quarantined` };
    log.append('flaky.released', { test: name, how: 'owner', by, passes: t.passes }, by, 'human');
    return { ok: true };
}
//# sourceMappingURL=flaky.js.map