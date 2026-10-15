// The research log as the next session reads it (a copy in its bundle, read-only): the fixed template per entry,
// rendered from the study's events. The template is code's, so every entry has the same parts whatever a session
// wrote; text a session wrote is shown as quoted data, never as instructions.
import type { LogEntry, StudyState } from './state.js';
import type { Study } from './study.js';

/** Entries shown whole; older ones get one line each. */
export const LOG_FULL = 40;

const quote = (s: string) => (s ? s.split('\n').map((l) => `> ${l}`).join('\n') : '> (none)');
const cfg = (c: Record<string, string | number>) => (Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k}=${v}`).join(', ') : '(defaults)');
const result = (e: LogEntry) => (e.result === null ? (e.step ? `none (stopped at ${e.step})` : 'none') : String(e.result));

/** One entry in the fixed template. */
export function renderEntry(e: LogEntry): string {
  return [
    `## #${e.n} ${e.kind} - ${e.decision}`,
    `- Motivation (the session's words):`,
    quote(e.motivation),
    `- Hypothesis (the session's words):`,
    quote(e.hypothesis),
    `- Change: ${e.commit ? `commit ${e.commit.slice(0, 12)}` : 'none'}${e.files.length ? `; files ${e.files.join(', ')}` : ''}${e.parent !== null ? `; from #${e.parent}` : ''}`,
    `- Config: ${cfg(e.config)}`,
    `- Budget: ${e.gpu_minutes === null ? 'not run' : `${e.gpu_minutes.toFixed(1)} GPU-min, waited ${e.waited_s ?? 0} s for the GPU`}`,
    `- Result: ${result(e)}`,
    `- Decision: ${e.decision}${e.why ? ` (${e.why})` : ''}`,
    ...(e.tail ? ['- Output (end, redacted):', '```', e.tail, '```'] : []),
  ].join('\n');
}

/** The whole log for a session's bundle: the goal, the best, then the entries (newest last). */
export function renderLog(study: Study, s: StudyState): string {
  const old = s.entries.slice(0, -LOG_FULL);
  const recent = s.entries.slice(-LOG_FULL);
  return [
    `# Research log: ${study.id} (version ${s.version})`,
    `Goal: ${study.goal}`,
    `Metric: ${study.metric.name}, ${study.metric.direction === 'min' ? 'lower' : 'higher'} is better; a result is kept only when it beats the best by more than ${study.metric.min_delta}.`,
    `Best so far: ${s.best ? `${s.best.value} (#${s.best.n})` : 'none yet (the next job is the baseline)'}`,
    '',
    ...(old.length ? ['## Earlier entries (one line each)', ...old.map((e) => `- #${e.n} ${e.kind} ${e.decision} ${result(e)}: ${e.hypothesis.slice(0, 120)}`), ''] : []),
    ...recent.map((e) => `${renderEntry(e)}\n`),
  ].join('\n');
}
