// A study's state and research log, folded from its events (src/events/types.ts `experiment.*`): nothing else keeps
// any. One entry in flight at a time, one proposal per session (the first counts; a second for the same session, or
// one for a session that isn't the current one, changes nothing), and a new entry only while the study is idle.
import { best } from './keep.js';
export const BREAKER = 3;
const str = (v) => (typeof v === 'string' ? v : '');
export function foldStudy(events, study, version) {
    const entries = [];
    const byN = new Map();
    let current = null;
    let phase = 'idle';
    let paused = false;
    let archived = false;
    let resumedAt = 0;
    for (const e of events) {
        const p = e.payload;
        if (p.study !== study)
            continue;
        if (e.type === 'experiment.changed') {
            const a = p.action;
            if (a === 'pause' || a === 'stop_job')
                paused = true;
            else if (a === 'resume' || a === 'start') {
                paused = false;
                archived = false;
                resumedAt = entries.length;
            }
            else if (a === 'archive')
                archived = true;
            continue;
        }
        if (e.type === 'experiment.verdict') {
            const x = byN.get(p.n);
            if (!x || x.decision !== 'held')
                continue;
            if (p.answer === 'accept')
                x.decision = x.after ?? 'keep';
            else {
                x.decision = 'discard';
                x.why = `rejected on review by ${str(p.by)}`;
            }
            continue;
        }
        if (p.version !== undefined && p.version !== version)
            continue;
        const n = p.n;
        if (e.type === 'experiment.session') {
            if (phase !== 'idle' || byN.has(n))
                continue;
            const kind = p.kind;
            const entry = {
                n,
                kind,
                parent: p.parent ?? null,
                ...(p.of !== undefined ? { of: p.of } : {}),
                ...(p.arm !== undefined ? { arm: p.arm } : {}),
                ...(p.combines !== undefined ? { combines: p.combines } : {}),
                size: p.size ?? 0,
                seed: p.seed ?? 1,
                result: null,
                decision: 'running',
                ts: e.ts,
                session: str(p.session),
                job: null,
                hypothesis: '',
                variable: '',
                motivation: '',
                expected_effect: '',
                config: {},
                commit: null,
                files: [],
                approval: [],
                gpu_minutes: null,
                waited_s: null,
                step: null,
                tail: '',
                why: '',
                timings: null,
            };
            entries.push(entry);
            byN.set(n, entry);
            current = n;
            phase = 'session';
        }
        else if (e.type === 'experiment.proposed' || e.type === 'experiment.refused') {
            const entry = byN.get(n);
            if (!entry || current !== n || phase !== 'session' || entry.session !== str(p.session))
                continue;
            if (e.type === 'experiment.refused') {
                entry.decision = 'refused';
                entry.why = str(p.why);
                current = null;
                phase = 'idle';
                continue;
            }
            Object.assign(entry, { job: str(p.job), hypothesis: str(p.hypothesis), variable: str(p.variable), motivation: str(p.motivation), expected_effect: str(p.expected_effect), config: p.config ?? {}, commit: str(p.commit), files: p.files ?? [], approval: p.approval ?? [] });
            phase = entry.approval.length ? 'awaiting_approval' : 'queued';
        }
        else if (e.type === 'experiment.approval') {
            const entry = entries.find((x) => x.job === p.job);
            if (!entry || entry.n !== current || phase !== 'awaiting_approval')
                continue;
            if (p.answer === 'approve')
                phase = 'queued';
            else {
                entry.decision = 'refused';
                entry.why = `declined by ${str(p.by)}`;
                current = null;
                phase = 'idle';
            }
        }
        else if (e.type === 'experiment.job_started') {
            if (current === n && phase === 'queued')
                phase = 'running';
        }
        else if (e.type === 'experiment.recorded') {
            const entry = byN.get(n);
            if (!entry || current !== n || (phase !== 'running' && phase !== 'queued'))
                continue;
            Object.assign(entry, { result: p.score ?? null, value: p.value ?? null, decision: p.decision, why: str(p.why), gpu_minutes: p.gpu_minutes, minutes: p.gpu_minutes, waited_s: p.waited_s, step: p.step ?? null, tail: str(p.tail), timings: p.timings ?? null });
            if (p.vs !== undefined)
                entry.vs = p.vs;
            current = null;
            phase = 'idle';
        }
        else if (e.type === 'experiment.judged') {
            const entry = byN.get(n);
            if (!entry)
                continue;
            entry.stage2 = [...(entry.stage2 ?? []), p.stage2];
            entry.decision = p.decision;
            entry.why = str(p.why);
            if (p.value !== undefined)
                entry.value = p.value;
            if (p.after !== undefined)
                entry.after = p.after;
        }
    }
    const since = entries.slice(resumedAt).filter((x) => x.decision !== 'running');
    const tail = since.slice(-BREAKER);
    const broken = tail.length === BREAKER && tail.every((x) => x.decision === 'crash' || x.decision === 'refused' || x.decision === 'stopped');
    return { version, entries, phase, current, paused, archived, broken, best: best(entries) };
}
/** Why no new entry may start now, or null. */
export function sessionHold(s) {
    if (s.archived)
        return 'archived';
    if (s.paused)
        return 'paused';
    if (s.broken)
        return `${BREAKER} jobs in a row crashed, were refused or stopped: resume it to go on`;
    if (s.phase !== 'idle')
        return `entry #${s.current} is ${s.phase.replace('_', ' ')}`;
    const held = s.entries.find((e) => e.decision === 'held');
    if (held)
        return `#${held.n} waits for an owner's review`;
    return null;
}
/** The next entry's number: counted over every version of the study, so a job's id is never used twice. */
export function nextN(events, study) {
    let n = 0;
    for (const e of events)
        if (e.type === 'experiment.session' && e.payload.study === study)
            n = Math.max(n, e.payload.n);
    return n + 1;
}
/** A job's id: the study and the entry's number. */
export const jobId = (study, n) => `${study}-${n}`;
//# sourceMappingURL=state.js.map