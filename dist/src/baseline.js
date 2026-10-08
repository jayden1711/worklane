// The baseline gate: main is allowed to be red, but a change may not add red.
// main's failing set is recorded from a run at a known commit; a run then
// passes the gate if every failure it shows was already failing on main.
// A run that fails without a parsable failure list never passes: unknown red
// is red.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const ANSI = /\x1b\[[0-9;]*m/g;
/** Failing names in a run's output, or null when the output has no failure section. */
export function parseFailureList(output, fmt) {
    const lines = output.replace(ANSI, '').split(/\r?\n/);
    const section = new RegExp(fmt.section);
    const item = new RegExp(fmt.item);
    const start = lines.findIndex((l) => section.test(l));
    if (start < 0)
        return null;
    const n = lines[start].match(/\b(\d+)\b/);
    const names = new Set();
    for (const l of lines.slice(start + 1)) {
        const m = l.match(item);
        if (m?.[1])
            names.add(m[1].trim());
    }
    return { names: [...names].sort(), reported: n ? Number(n[1]) : null };
}
/** Why a parsed list can't be trusted, or null. A count mismatch means the item pattern is wrong. */
export function listProblem(p) {
    if (!p || !p.names.length)
        return 'no parsable failure list';
    if (p.reported !== null && p.reported !== p.names.length) {
        return `the runner reported ${p.reported} failure(s) but ${p.names.length} distinct name(s) parsed; tests.yaml failures.item is probably wrong`;
    }
    return null;
}
export function parseFailures(output, fmt) {
    return parseFailureList(output, fmt)?.names ?? null;
}
export function latestBaseline(log) {
    const e = log.read(0, ['baseline.recorded']).at(-1);
    if (!e)
        return null;
    const p = e.payload;
    return { sha: p.sha, failing: p.failing, recordedAt: e.ts };
}
export function baselineGate(exitCode, output, fmt, baseline) {
    if (exitCode === 0)
        return { outcome: 'pass', preexisting: [], note: 'all green' };
    if (exitCode === null)
        return { outcome: 'fail', newFailures: [], note: 'the test run did not finish (timeout or could not start)' };
    if (!fmt)
        return { outcome: 'fail', newFailures: [], note: `exit ${exitCode}; tests.yaml has no failures format, so failures can't be compared with the baseline` };
    const parsed = parseFailureList(output, fmt);
    const problem = listProblem(parsed);
    if (problem)
        return { outcome: 'fail', newFailures: [], note: `exit ${exitCode} with ${problem}; unknown red is red` };
    const failing = parsed.names;
    if (!baseline)
        return { outcome: 'fail', newFailures: failing, note: `no baseline recorded; ${failing.length} failure(s) can't be compared` };
    const known = new Set(baseline.failing);
    const fresh = failing.filter((f) => !known.has(f));
    if (fresh.length)
        return { outcome: 'fail', newFailures: fresh, note: `${fresh.length} new failure(s) not in main's baseline (${baseline.sha.slice(0, 8)})` };
    return { outcome: 'pass', preexisting: failing, note: `no new failures; ${failing.length} already failing on main (${baseline.sha.slice(0, 8)})` };
}
export function recordBaseline(log, actor, sha, exitCode, output, fmt) {
    if (exitCode === null)
        return { ok: false, why: 'the run did not finish' };
    let failing = [];
    if (exitCode !== 0) {
        if (!fmt)
            return { ok: false, why: 'tests.yaml has no failures format' };
        const parsed = parseFailureList(output, fmt);
        const problem = listProblem(parsed);
        if (problem)
            return { ok: false, why: `exit ${exitCode} with ${problem}; not recording an unknown baseline` };
        failing = parsed.names;
    }
    log.append('baseline.recorded', { sha, failing }, actor);
    return { ok: true, failing };
}
/** The latest baseline straight from an events database, read-only (for hooks; never creates the file). */
export function readBaseline(dbPath) {
    if (!existsSync(dbPath))
        return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const r = db.prepare("SELECT ts, payload FROM events WHERE type = 'baseline.recorded' ORDER BY id DESC LIMIT 1").get();
        if (!r)
            return null;
        const p = JSON.parse(r.payload);
        return { sha: p.sha, failing: p.failing, recordedAt: r.ts };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=baseline.js.map