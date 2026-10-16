/** Entries shown whole; older ones get one line each. */
export const LOG_FULL = 40;
const quote = (s) => (s ? s.split('\n').map((l) => `> ${l}`).join('\n') : '> (none)');
const cfg = (c) => (Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k}=${v}`).join(', ') : '(defaults)');
const num = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : String(Number(x.toPrecision(5))));
const result = (e) => (e.result === null ? (e.step ? `none (stopped at ${e.step})` : 'none') : num(e.result));
const stages = (e) => (e.stage2 ?? []).map((s) => `size ${s.size + 1}: ${num(s.meanCandidate)} ± ${num(s.spread)} vs best ${num(s.meanBest)} (${s.seeds} seeds each; ${s.minutesCandidate.toFixed(1)} vs ${s.minutesBest.toFixed(1)} GPU-min)`);
/** One entry in the fixed template. Seeds of a stage-2 round are folded into their candidate's entry. */
export function renderEntry(e) {
    return [
        `## #${e.n} ${e.kind} - ${e.decision.replace('_', ' ')}`,
        `- Motivation (the session's words):`,
        quote(e.motivation),
        `- Hypothesis (the session's words):`,
        quote(e.hypothesis),
        `- The one thing it changes: ${e.variable || '(none said)'}`,
        `- Change: ${e.commit ? `commit ${e.commit.slice(0, 12)}` : 'none'}${e.files.length ? `; files ${e.files.join(', ')}` : ''}${e.parent !== null ? `; from #${e.parent}` : ''}`,
        `- Config: ${cfg(e.config)}`,
        `- Budget: ${e.gpu_minutes === null ? 'not run' : `${e.gpu_minutes.toFixed(1)} GPU-min (stage 1)`}`,
        `- Result: ${result(e)}${stages(e).length ? `; stage 2: ${stages(e).join('; ')}` : ''}`,
        `- Decision: ${e.decision.replace('_', ' ')}${e.why ? ` (${e.why})` : ''}`,
        ...(e.tail ? ['- Output (end, redacted):', '```', e.tail, '```'] : []),
    ].join('\n');
}
/** The whole log for a session: the goal and the metric in words, the best, then the entries (newest last). */
export function renderLog(study, s) {
    const shown = s.entries.filter((e) => e.kind !== 'seed');
    const old = shown.slice(0, -LOG_FULL);
    const recent = shown.slice(-LOG_FULL);
    return [
        `# Research log: ${study.id} (version ${s.version})`,
        `Goal: ${study.goal}`,
        `Metric: ${study.metric.name}, ${study.metric.direction === 'min' ? 'lower' : 'higher'} is better${study.metric.source === 'score' ? '' : ` (measured by the harness: the ${study.metric.source === 'train_ms' ? 'training' : 'prediction'} step's wall time in ms)`}. A candidate is run once (screened), then ${study.screen.seeds} seeds of it and of the best at the same budget; it counts only when it beats the best by more than the seeds' spread${study.ladder.length ? `, at every size (${study.ladder.map((z) => z.name).join(', ')})` : ''}.`,
        `Best so far: ${s.best ? `${num(s.best.value)} (#${s.best.n})` : 'none yet (the next job is the baseline)'}`,
        '',
        ...(old.length ? ['## Earlier entries (one line each)', ...old.map((e) => `- #${e.n} ${e.kind} ${e.decision} ${result(e)}: ${e.hypothesis.slice(0, 120)}`), ''] : []),
        ...recent.map((e) => `${renderEntry(e)}\n`),
    ].join('\n');
}
//# sourceMappingURL=log.js.map