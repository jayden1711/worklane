// Keep or discard, scheduled by the coordinator, never by the agent (docs/experiments.md "Keep or discard"):
//   - Stage 1, the screen: a candidate runs once (one seed). Unless it beats the best by the study's screening margin,
//     it is "screened out, 1 seed" and never run again.
//   - Stage 2: the coordinator runs N seeds of the candidate AND N of the current best, the same budget each (the same
//     minutes, GPUs and size; each run's measured time is recorded). The candidate is better only when its mean beats
//     the best's by more than the seeds' spread (and min_delta). Reported as mean ± spread.
//   - The scale ladder: a winner at one size runs stage 2 again at the next size before it can count.
//   - A winner that beats the best by more than the anomaly margin, or whose session the monitor flagged, is held for
//     an owner's review. A winner from an explore session (not built on the best) isn't promoted alone: a combine
//     session puts its change on the best, and that combination goes through both stages again (re-ablated).
// The best only ever moves to a candidate proven better than it, at every size, on fresh paired runs.

export type Direction = 'min' | 'max';
/** A job's kind: the baseline, a candidate (from an exploit, explore or combine session), or a stage-2 seed. */
export type EntryKind = 'baseline' | 'exploit' | 'explore' | 'combine' | 'seed';
export type Decision = 'running' | 'keep' | 'discard' | 'screened_out' | 'stage2' | 'ladder' | 'held' | 'winner' | 'seed' | 'crash' | 'refused' | 'stopped';
export const CANDIDATE: readonly EntryKind[] = ['exploit', 'explore', 'combine'];
export const isCandidate = (k: EntryKind) => CANDIDATE.includes(k);

/** A candidate's stage-2 numbers at one size. */
export interface Stage2 {
  size: number;
  meanCandidate: number;
  meanBest: number;
  spread: number;
  seeds: number;
  minutesCandidate: number;
  minutesBest: number;
}

export interface Entry {
  n: number;
  kind: EntryKind;
  /** The entry it was built from (null: the study's own commit). */
  parent: number | null;
  /** A seed's candidate, and which arm it runs: the candidate's change, or the best it is measured against. */
  of?: number;
  arm?: 'candidate' | 'best';
  /** The best a candidate's stage 2 is measured against (set when it enters stage 2). */
  vs?: number;
  /** A combine session's winner (the change it puts on the best). */
  combines?: number;
  size: number;
  seed: number;
  result: number | null;
  /** What it counts as when it is the best: its stage-2 mean at the smallest size (the baseline: its result). */
  value?: number | null;
  /** Measured GPU minutes of this run (the budget it used). */
  minutes?: number | null;
  decision: Decision;
  stage2?: Stage2[];
  /** A held winner's fate if accepted: keep, or winner (to combine). */
  after?: 'keep' | 'winner';
}

export interface Metric {
  direction: Direction;
  min_delta: number;
  anomaly_margin: number;
}

export interface Plan {
  metric: Metric;
  screen: { margin: number; seeds: number };
  sizes: number;
  exploration: { share: number; near_miss: number };
}

/** How much `a` improves on `b` (positive is better), in the metric's direction. */
export const gain = (a: number, b: number, d: Direction) => (d === 'min' ? b - a : a - b);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
/** Sample standard deviation (0 for one value). */
const sd = (xs: number[]) => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));
const fmt = (x: number) => String(Number(x.toPrecision(5)));

/** The current best: the latest entry kept (each one was proven better than the one before). */
export function best(entries: readonly Entry[]): { n: number; value: number } | null {
  for (const e of [...entries].reverse()) {
    if (e.decision !== 'keep') continue;
    const v = e.value ?? e.result;
    if (v !== null && v !== undefined) return { n: e.n, value: v };
  }
  return null;
}

/** Stage 1: a candidate's one result against the best. */
export function screen(entries: readonly Entry[], result: number | null, p: Plan): { decision: 'crash' | 'screened_out' | 'stage2'; why: string; vs?: number } {
  if (result === null || !Number.isFinite(result)) return { decision: 'crash', why: 'no score' };
  const b = best(entries);
  if (!b) return { decision: 'crash', why: 'no best to screen against' };
  const g = gain(result, b.value, p.metric.direction);
  if (!(g > p.screen.margin)) return { decision: 'screened_out', why: `screened out, 1 seed: ${fmt(result)} vs best ${fmt(b.value)} (needs more than ${p.screen.margin} better)` };
  return { decision: 'stage2', why: `passed the screen (${fmt(result)} vs best ${fmt(b.value)}): ${p.screen.seeds} seeds each of it and the best next`, vs: b.n };
}

/** A candidate's seeds at one size, by arm. */
export function seedsOf(entries: readonly Entry[], c: number, size: number) {
  const of = entries.filter((e) => e.kind === 'seed' && e.of === c && e.size === size);
  return { candidate: of.filter((e) => e.arm === 'candidate'), best: of.filter((e) => e.arm === 'best') };
}

/** The size a candidate in stage 2 (or on the ladder) is being measured at now. */
export const sizeNow = (c: Entry) => (c.stage2?.length ?? 0);

/**
 * Stage 2 at one size, once every seed of both arms is in: better only when the candidate's mean beats the best's by
 * more than the spread (the larger arm's standard deviation) and min_delta. Then the next size, or a hold, or kept.
 */
export function judgeStage2(entries: readonly Entry[], c: Entry, p: Plan, flagged: boolean): { decision: Decision; why: string; stage2: Stage2; value?: number; after?: 'keep' | 'winner' } {
  const size = sizeNow(c);
  const s = seedsOf(entries, c.n, size);
  const rc = s.candidate.map((e) => e.result);
  const rb = s.best.map((e) => e.result);
  const minutes = (xs: Entry[]) => xs.reduce((t, e) => t + (e.minutes ?? 0), 0);
  const ok = (xs: (number | null)[]): xs is number[] => xs.every((x) => x !== null && Number.isFinite(x));
  const stage2 = (mc: number, mb: number, spread: number): Stage2 => ({ size, meanCandidate: mc, meanBest: mb, spread, seeds: p.screen.seeds, minutesCandidate: minutes(s.candidate), minutesBest: minutes(s.best) });
  if (!ok(rc) || !ok(rb)) return { decision: 'discard', why: 'a stage-2 seed crashed: no fair comparison', stage2: stage2(NaN, NaN, NaN) };
  const mc = mean(rc);
  const mb = mean(rb);
  const spread = Math.max(sd(rc), sd(rb));
  const st = stage2(mc, mb, spread);
  const g = gain(mc, mb, p.metric.direction);
  const line = `${fmt(mc)} ± ${fmt(sd(rc))} vs best ${fmt(mb)} ± ${fmt(sd(rb))} (${p.screen.seeds} seeds each, size ${size + 1})`;
  if (!(g > Math.max(spread, p.metric.min_delta))) return { decision: 'discard', why: `within the spread: ${line}`, stage2: st };
  if (size + 1 < p.sizes) return { decision: 'ladder', why: `better at size ${size + 1}: ${line}; next, size ${size + 2}`, stage2: st };
  const value = (c.stage2?.[0] ?? st).meanCandidate;
  const after: 'keep' | 'winner' = c.kind === 'explore' && c.parent !== c.vs ? 'winner' : 'keep';
  if (flagged || Math.abs(g) > p.metric.anomaly_margin * Math.abs(mb)) return { decision: 'held', why: `held for an owner's review: ${line}`, stage2: st, value, after };
  return { decision: after, why: after === 'winner' ? `better: ${line}; built on a near miss, so a combine session puts it on the best next` : `better: ${line}`, stage2: st, value, after };
}

/** Whether the next session explores: exactly floor(share x sessions) of them do, counted, never drawn at random. */
export function shouldExplore(entries: readonly Entry[], share: number): boolean {
  const sessions = entries.filter((e) => e.kind === 'exploit' || e.kind === 'explore');
  const explores = sessions.filter((e) => e.kind === 'explore').length;
  return explores < Math.floor(share * (sessions.length + 1) + 1e-9);
}

/** An explore session's parent: the newest near miss (screened out within near_miss of the best) not explored from yet. */
export function exploreParent(entries: readonly Entry[], p: Plan): number | null {
  const b = best(entries);
  if (!b) return null;
  const used = new Set(entries.filter((e) => e.kind === 'explore' && e.parent !== null).map((e) => e.parent));
  const tol = Math.abs(b.value) * p.exploration.near_miss;
  for (const e of [...entries].reverse()) {
    if ((e.decision === 'screened_out' || e.decision === 'discard') && isCandidate(e.kind) && e.result !== null && !used.has(e.n) && -gain(e.result, b.value, p.metric.direction) <= tol) return e.n;
  }
  return b.n;
}

/** What the coordinator runs next. */
export type Next =
  | { do: 'baseline' }
  | { do: 'seed'; of: number; arm: 'candidate' | 'best'; source: number; size: number; seed: number }
  | { do: 'judge'; of: number }
  | { do: 'session'; kind: 'exploit' | 'explore' | 'combine'; parent: number | null; combines?: number }
  | { do: 'wait'; why: string };

export function nextStep(entries: readonly Entry[], p: Plan): Next {
  if (!entries.some((e) => e.kind === 'baseline' && (e.decision === 'keep' || e.decision === 'running'))) return entries.length ? { do: 'wait', why: 'the baseline has no result' } : { do: 'baseline' };
  const held = entries.find((e) => e.decision === 'held');
  if (held) return { do: 'wait', why: `#${held.n} waits for an owner's review` };
  // A candidate in stage 2 (or on the ladder) first: its missing seeds one at a time, alternating arms, then its judgment.
  const c = entries.find((e) => isCandidate(e.kind) && (e.decision === 'stage2' || e.decision === 'ladder'));
  if (c) {
    const size = sizeNow(c);
    const s = seedsOf(entries, c.n, size);
    const n = p.screen.seeds;
    if (s.candidate.length + s.best.length >= 2 * n) return { do: 'judge', of: c.n };
    const arm = s.best.length < s.candidate.length ? 'best' : 'candidate';
    return { do: 'seed', of: c.n, arm, source: arm === 'candidate' ? c.n : c.vs!, size, seed: (arm === 'candidate' ? s.candidate.length : s.best.length) + 1 };
  }
  const b = best(entries)!;
  const winner = entries.find((e) => e.decision === 'winner' && !entries.some((x) => x.kind === 'combine' && x.combines === e.n));
  if (winner) return { do: 'session', kind: 'combine', parent: b.n, combines: winner.n };
  if (shouldExplore(entries, p.exploration.share)) return { do: 'session', kind: 'explore', parent: exploreParent(entries, p) };
  return { do: 'session', kind: 'exploit', parent: b.n };
}

/** One variable per hypothesis: the knobs it changed against its parent's config, and whether it changed code too. */
export function variablesChanged(config: Record<string, string | number>, parentConfig: Record<string, string | number>, codeChanged: boolean): string[] {
  const keys = new Set([...Object.keys(config), ...Object.keys(parentConfig)]);
  const knobs = [...keys].filter((k) => config[k] !== parentConfig[k]).map((k) => `knob ${k}`);
  return [...knobs, ...(codeChanged ? ['code'] : [])];
}
