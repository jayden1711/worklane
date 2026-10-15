/**
 * Score one replay from its scratch instance's event log. Success: the last verify of the issue passed every
 * done_when check and the last evaluator verdict on it approved the patch and the test. Cost: every run.cost.
 */
export function scoreReplay(events, issue, o = {}) {
    const of = (type) => events.filter((e) => e.type === type).map((e) => e.payload);
    const mine = (xs) => xs.filter((x) => x.issue === issue);
    const verify = mine(of('check.result')).filter((c) => c.stage === 'verify').at(-1);
    const doneWhen = verify ? verify.checks.every((c) => c.status === 'pass' || c.status === 'skipped') : null;
    const v = mine(of('eval.verdict')).at(-1);
    const verdict = v ? v.patch_correct && v.test_correct : null;
    const asked = of('decision.asked').filter((d) => d.issue === issue || d.issue === null).length;
    const blocked = mine(of('issue.blocked'));
    const held = of('merge.decided').filter((m) => m.issue === issue && !m.auto).length;
    const costUsd = round(of('run.cost').reduce((s, c) => s + c.usd, 0));
    const queued = mine(of('land.queued')).length > 0;
    const outcome = o.error ? 'error' : o.budgetHit ? 'budget' : blocked.length ? 'blocked' : asked ? 'asked' : queued ? 'queued' : 'unfinished';
    const detail = o.error ?? (blocked.at(-1)?.why ?? (verify && !doneWhen ? `failed: ${verify.checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped').map((c) => c.check).join(', ')}` : v && !verdict ? `evaluator: ${v.advice}` : '')).slice(0, 500);
    return { success: doneWhen === true && verdict === true, doneWhen, verdict, outcome, costUsd, interventions: asked + blocked.length + held, detail };
}
export const round = (x) => Math.round(x * 10000) / 10000;
export function totals(scores) {
    return {
        runs: scores.length,
        passed: scores.filter((s) => s.success).length,
        costUsd: round(scores.reduce((s, x) => s + x.cost_usd, 0)),
        wallMs: scores.reduce((s, x) => s + x.wall_ms, 0),
        interventions: scores.reduce((s, x) => s + x.interventions, 0),
    };
}
/** Every finished harness eval run in the log, oldest first, with its tasks. */
export function evalRuns(events) {
    const tasks = new Map();
    for (const e of events)
        if (e.type === 'harness_eval.task') {
            const t = e.payload;
            tasks.set(t.run, [...(tasks.get(t.run) ?? []), t]);
        }
    return events.filter((e) => e.type === 'harness_eval.run').map((e) => ({ run: e.payload, at: e.ts, tasks: tasks.get(e.payload.id) ?? [] }));
}
/** The baseline a run is compared with: the latest earlier run that finished (not stopped by its budget, no error). */
export function baselineFor(runs, id) {
    const i = runs.findIndex((r) => r.run.id === id);
    return runs.slice(0, i < 0 ? runs.length : i).filter((r) => !r.run.stopped && !r.run.error && r.run.runs > 0).at(-1) ?? null;
}
const rate = (r) => (r.runs ? r.passed / r.runs : 0);
const per = (x, r) => (r.runs ? x / r.runs : 0);
const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (x) => `$${x.toFixed(2)}`;
const mins = (ms) => `${(ms / 60_000).toFixed(1)} min`;
const signed = (x, f) => (x === 0 ? '±0' : `${x > 0 ? '+' : '−'}${f(Math.abs(x))}`);
/**
 * The PR comment: this run's scores beside the baseline's, with the change in each. Held-out tasks are counted, never
 * named: their repositories and texts are private.
 */
export function commentMarkdown(cur, base, brand) {
    const c = cur.run;
    const b = base?.run ?? null;
    const row = (name, now, then, f, better) => {
        if (then === null)
            return `| ${name} | ${f(now)} | – | – |`;
        const d = now - then;
        const worse = better === 'up' ? d < 0 : d > 0;
        return `| ${name} | ${f(now)} | ${f(then)} | ${signed(d, f)}${worse && Math.abs(d) > 1e-9 ? ' (worse)' : ''} |`;
    };
    const lines = [
        `**${brand} harness evals** at \`${(c.engine ?? 'unknown').slice(0, 8)}\` (${c.trigger}): ${c.passed}/${c.runs} replays passed, ${c.tasks} task(s) × ${c.samples} sample(s)${c.stopped ? `; **stopped at the $${c.budget_usd} budget**` : ''}${c.error ? `; error: ${c.error}` : ''}.`,
        '',
        `| | this run | baseline${b ? ` (\`${(b.engine ?? 'unknown').slice(0, 8)}\`, ${base.at.slice(0, 10)})` : ''} | change |`,
        '|---|---|---|---|',
        row('success rate', rate(c), b ? rate(b) : null, pct, 'up'),
        row('cost per replay', per(c.cost_usd, c), b ? per(b.cost_usd, b) : null, usd, 'down'),
        row('wall-clock per replay', per(c.wall_ms, c), b ? per(b.wall_ms, b) : null, mins, 'down'),
        row('human interventions per replay', per(c.interventions, c), b ? per(b.interventions, b) : null, (x) => x.toFixed(2), 'down'),
    ];
    const pub = cur.tasks.filter((t) => !t.held_out);
    const held = cur.tasks.filter((t) => t.held_out);
    if (pub.length) {
        const byTask = new Map();
        for (const t of pub)
            byTask.set(t.task, [...(byTask.get(t.task) ?? []), t]);
        lines.push('', '| task | passed | cost | outcome |', '|---|---|---|---|');
        for (const [id, ts] of byTask)
            lines.push(`| ${id} | ${ts.filter((t) => t.success).length}/${ts.length} | ${usd(ts.reduce((s, t) => s + t.cost_usd, 0))} | ${[...new Set(ts.map((t) => t.outcome))].join(', ')} |`);
    }
    if (held.length)
        lines.push('', `Held-out tasks (private, not named): ${held.filter((t) => t.success).length}/${held.length} replays passed.`);
    if (!b)
        lines.push('', 'No baseline yet: this run becomes the baseline.');
    return lines.join('\n');
}
/** The dashboard's panel (GET /api/harness-evals): the latest runs, newest first, and the latest run's tasks. */
export function harnessEvalView(events, limit = 20) {
    const all = evalRuns(events);
    const rowOf = (r) => {
        const x = r.run;
        const b = baselineFor(all, x.id)?.run ?? null;
        const sr = x.runs ? x.passed / x.runs : null;
        const cpr = x.runs ? round(x.cost_usd / x.runs) : null;
        return {
            id: x.id,
            at: r.at,
            trigger: x.trigger,
            engine: x.engine,
            pr: x.pr,
            runs: x.runs,
            passed: x.passed,
            successRate: sr,
            costPerRun: cpr,
            wallMsPerRun: x.runs ? Math.round(x.wall_ms / x.runs) : null,
            interventionsPerRun: x.runs ? x.interventions / x.runs : null,
            costUsd: x.cost_usd,
            budgetUsd: x.budget_usd,
            stopped: x.stopped !== null,
            error: x.error ?? null,
            successDelta: b && b.runs && sr !== null ? sr - b.passed / b.runs : null,
            costDelta: b && b.runs && cpr !== null ? round(cpr - b.cost_usd / b.runs) : null,
        };
    };
    const byTask = new Map();
    for (const t of all.at(-1)?.tasks ?? []) {
        const cur = byTask.get(t.task) ?? { task: t.task, heldOut: t.held_out, passed: 0, samples: 0, costUsd: 0, outcomes: [] };
        cur.samples++;
        if (t.success)
            cur.passed++;
        cur.costUsd = round(cur.costUsd + t.cost_usd);
        if (!cur.outcomes.includes(t.outcome))
            cur.outcomes.push(t.outcome);
        byTask.set(t.task, cur);
    }
    return { runs: all.slice(-limit).map(rowOf).reverse(), latest: [...byTask.values()] };
}
//# sourceMappingURL=score.js.map