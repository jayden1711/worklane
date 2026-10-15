// Keep or discard (docs/experiments.md "Keep or discard"). A result is kept only when it beats the best by more than
// the study's min_delta, in the metric's direction. With confirm runs, a beating result is run again (same commit, a
// new seed) and judged on the worse of its runs, so one lucky seed never moves the best. Exploration (which parent a
// session starts from) is decided here too, by the coordinator, never by the agent. The best only ever improves.

export type Direction = 'min' | 'max';
export type EntryKind = 'baseline' | 'exploit' | 'explore' | 'confirm';
export type Decision = 'keep' | 'discard' | 'crash' | 'refused' | 'stopped' | 'pending_confirm' | 'running';

/** One log entry as keep/discard reads it. `of`: the entry a confirm run re-runs. */
export interface Entry {
  n: number;
  kind: EntryKind;
  parent: number | null;
  of?: number;
  result: number | null;
  /** What it was judged on, when that isn't its own result: a confirm run's worse-of-all-runs. */
  value?: number | null;
  decision: Decision;
}

export interface Metric {
  direction: Direction;
  min_delta: number;
}

/** How much `a` improves on `b` (positive is better), in the metric's direction. */
export const gain = (a: number, b: number, d: Direction) => (d === 'min' ? b - a : a - b);
const worse = (a: number, b: number, d: Direction) => (gain(a, b, d) < 0 ? a : b);

/** The kept entry with the best result, or null before the baseline. A kept confirm stands for the entry it re-ran. */
export function best(entries: readonly Entry[], d: Direction): { n: number; value: number } | null {
  let b: { n: number; value: number } | null = null;
  for (const e of entries) {
    const v = e.value ?? e.result;
    if (e.decision !== 'keep' || v === null) continue;
    if (!b || gain(v, b.value, d) > 0) b = { n: e.n, value: v };
  }
  return b;
}

/**
 * The decision for a finished job's result. `entries`: the log so far, without this one. A first result (no best yet)
 * is the baseline and kept. A confirm run is judged on the worse of the original and every confirm of it so far.
 */
export function judge(entries: readonly Entry[], job: { n: number; kind: EntryKind; of?: number; result: number | null }, m: Metric, confirmRuns: number): { decision: Decision; value: number | null; why: string } {
  if (job.result === null || !Number.isFinite(job.result)) return { decision: 'crash', value: null, why: 'no score' };
  const b = best(entries, m.direction);
  if (!b) return { decision: 'keep', value: job.result, why: 'the first result: the baseline' };
  let value = job.result;
  let runs = 1;
  if (job.kind === 'confirm') {
    const orig = entries.find((e) => e.n === job.of);
    if (!orig || orig.result === null) return { decision: 'discard', value: job.result, why: `confirm of a run with no result (#${job.of})` };
    value = worse(value, orig.result, m.direction);
    runs = 2;
    for (const e of entries) {
      if (e.kind === 'confirm' && e.of === job.of && e.result !== null) {
        value = worse(value, e.result, m.direction);
        runs++;
      }
    }
  }
  const g = gain(value, b.value, m.direction);
  if (!(g > m.min_delta)) return { decision: 'discard', value, why: `${fmt(value)} doesn't beat best ${fmt(b.value)} by more than ${m.min_delta}` };
  if (runs <= confirmRuns) return { decision: 'pending_confirm', value, why: `beats best ${fmt(b.value)} by ${fmt(g)}; confirm run ${runs} of ${confirmRuns} next` };
  return { decision: 'keep', value, why: `${runs > 1 ? `the worse of ${runs} runs, ` : ''}${fmt(value)} beats best ${fmt(b.value)} by ${fmt(g)} > ${m.min_delta}` };
}

const fmt = (x: number) => String(Number(x.toPrecision(6)));

/**
 * Whether the next session explores: exactly floor(share x sessions) of them do, counted, never drawn at random. The
 * baseline and confirm runs aren't sessions of either kind.
 */
export function shouldExplore(entries: readonly Entry[], share: number): boolean {
  const sessions = entries.filter((e) => e.kind === 'exploit' || e.kind === 'explore');
  const explores = sessions.filter((e) => e.kind === 'explore').length;
  return explores < Math.floor(share * (sessions.length + 1) + 1e-9);
}

/**
 * An explore session's parent: the newest discarded result within near_miss (relative) of the best that no explore
 * session started from yet; else the oldest kept entry other than the best not yet explored from; else the best.
 */
export function exploreParent(entries: readonly Entry[], m: Metric, nearMiss: number): number | null {
  const b = best(entries, m.direction);
  if (!b) return null;
  const used = new Set(entries.filter((e) => e.kind === 'explore' && e.parent !== null).map((e) => e.parent));
  const tol = Math.abs(b.value) * nearMiss;
  for (const e of [...entries].reverse()) {
    if (e.decision === 'discard' && e.kind !== 'confirm' && e.result !== null && !used.has(e.n) && -gain(e.result, b.value, m.direction) <= tol) return e.n;
  }
  for (const e of entries) if (e.decision === 'keep' && e.n !== b.n && !used.has(e.n)) return e.n;
  return b.n;
}

/**
 * A result waiting for its confirm run: the original entry's number, while no confirm of it ended in keep, discard,
 * crash, stopped or refused. A confirm run comes before any new session.
 */
export function pendingConfirm(entries: readonly Entry[]): number | null {
  const done = new Set(entries.filter((e) => e.kind === 'confirm' && e.of !== undefined && !['pending_confirm', 'running'].includes(e.decision)).map((e) => e.of));
  for (const e of [...entries].reverse()) {
    if (e.decision !== 'pending_confirm') continue;
    const orig = e.kind === 'confirm' ? e.of! : e.n;
    if (!done.has(orig)) return orig;
  }
  return null;
}

/**
 * What runs next: a confirm run of a pending result, else a session (null parent before the baseline: the baseline
 * runs the study's own commit).
 */
export function nextSession(entries: readonly Entry[], m: Metric, exploration: { share: number; near_miss: number }): { kind: EntryKind; parent: number | null } {
  const c = pendingConfirm(entries);
  if (c !== null) return { kind: 'confirm', parent: c };
  const b = best(entries, m.direction);
  if (!b) return { kind: 'baseline', parent: null };
  if (shouldExplore(entries, exploration.share)) return { kind: 'explore', parent: exploreParent(entries, m, exploration.near_miss) };
  return { kind: 'exploit', parent: b.n };
}
