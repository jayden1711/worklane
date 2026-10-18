// The role-prompt eval (scripts/eval-roles.mjs): its options, the run.cost record of every model call, and its
// verdict. Each role is scored on its visible cases and on its held-out cases (src/held-out.ts), 3 samples per
// case unless fewer are asked for (and the report says so). The held-out score decides: a role whose held-out
// score drops, is incomplete or is missing fails the run, whatever its visible score did.
// Base and head each run N times (3 unless asked otherwise, #550): one run's delta is noise (the same base scored
// 33/35 and then 31/35 on identical prompts), so a score "drops" only when head's mean falls below base's mean by
// more than base's min-max spread. The cost cap covers all N runs of a role.
import { comparisonDiff, comparisonLine, comparisonPasses, DEFAULT_SAMPLES, type Ask, type EvalComparison, type ScoreComparison } from './skilleval.js';

/** Runs of each of base and head per role, unless another number is asked for. */
export const DEFAULT_RUNS = 3;

export interface EvalRolesOptions {
  base: string;
  roles: string[];
  model: string;
  judge: string;
  samples: number;
  /** Runs of each of base and head per role (#550); distinct from `samples`, which is samples per case in one run. */
  runs: number;
  /** Dollars per role, the total across its N runs. */
  cap: number;
  /** Write a held-out set for a role that has none (a separate case-writer run per role). */
  writeHeldOut: boolean;
  /** Score the current prompts only (no base): what each role's prompt scores now. */
  scoreOnly: boolean;
}

export function evalRolesOptions(argv: string[]): EvalRolesOptions {
  const arg = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : fallback;
  };
  const samples = Number(arg('samples', String(DEFAULT_SAMPLES)));
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`--samples must be a whole number of at least 1, not ${arg('samples', '')}`);
  const runs = Number(arg('runs', String(DEFAULT_RUNS)));
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a whole number of at least 1, not ${arg('runs', '')}`);
  const scoreOnly = argv.includes('--score');
  // --score stays what it was: one run of the current prompts, nothing to compare a spread against.
  if (scoreOnly && argv.includes('--runs')) throw new Error('--score scores the current prompts once; --runs applies to a base/head comparison');
  const cap = Number(arg('cap', '10'));
  if (!(cap > 0)) throw new Error('--cap must be a positive number of dollars');
  const roles = arg('roles', '');
  return { base: arg('base', 'origin/main'), roles: roles ? roles.split(',') : [], model: arg('model', 'sonnet'), judge: arg('judge', 'opus'), samples, runs, cap, writeHeldOut: argv.includes('--write-held-out'), scoreOnly };
}

/** An Ask whose every call is recorded as run.cost (role, model, the CLI's estimate). */
export function recordingAsk(ask: Ask, role: string, record: (cost: { role: string; model: string; usd: number; turns: number }) => void): Ask {
  return async (req) => {
    const r = await ask(req);
    record({ role, model: req.model, usd: r.costUsd, turns: 1 });
    return r;
  };
}

/** The report for one role (its line, then each case that changed), and whether the run fails for it. */
export function roleReport(c: EvalComparison): { lines: string[]; fails: boolean } {
  return { lines: [comparisonLine(c), ...comparisonDiff(c).map((d) => `  ${d}`)], fails: !comparisonPasses(c) };
}

/** N runs of one role's base/head comparison, under one cost cap for all of them. */
export interface RoleRuns {
  target: string;
  /** Runs asked for; fewer in `runs` means the cap stopped it. */
  requested: number;
  /** Each run's comparison, in order; the last one may be incomplete (the cap was reached during it). */
  runs: EvalComparison[];
  samples: number;
  costUsd: number;
  capUsd: number;
}

/**
 * Run a role's comparison `runs` times. `compare` gets what is left of the cap, so the cap bounds the total; once
 * a run comes back incomplete, or nothing is left, the remaining runs are not started (the role is incomplete).
 */
export async function evalRoleRuns(o: { target: string; runs: number; capUsd: number; samples: number; compare: (capUsd: number) => Promise<EvalComparison> }): Promise<RoleRuns> {
  const out: RoleRuns = { target: o.target, requested: o.runs, runs: [], samples: o.samples, costUsd: 0, capUsd: o.capUsd };
  for (let i = 0; i < o.runs && out.costUsd < o.capUsd; i++) {
    const c = await o.compare(o.capUsd - out.costUsd);
    out.runs.push(c);
    out.costUsd += c.costUsd;
    if (c.incomplete || c.heldOut?.incomplete) break;
  }
  return out;
}

/** Mean, min and max of one side's scores across runs. */
export function scoreSpread(scores: number[]): { mean: number; min: number; max: number } {
  if (!scores.length) throw new Error('no scores');
  return { mean: scores.reduce((a, b) => a + b, 0) / scores.length, min: Math.min(...scores), max: Math.max(...scores) };
}

/** Whether head's mean dropped below base's mean by more than base's min-max spread (no base: nothing to drop). */
export function spreadDropped(base: number[] | null, head: number[]): boolean {
  if (!base) return false;
  const b = scoreSpread(base);
  return b.mean - scoreSpread(head).mean > b.max - b.min;
}

type SetOf = (c: EvalComparison) => ScoreComparison | null;
const visibleSet: SetOf = (c) => c;
const heldOutSet: SetOf = (c) => c.heldOut;

/** One set (visible or held-out) across the runs: the scores of the runs that completed it, and whether every run did. */
function setRuns(r: RoleRuns, of: SetOf) {
  const sets = r.runs.map(of);
  if (sets.some((s) => s === null)) return null;
  const done = (sets as ScoreComparison[]).filter((s) => !s.incomplete);
  const base = done.every((s) => s.base) ? done.map((s) => s.base!.passed) : null;
  const head = done.map((s) => s.head.passed);
  const total = done[0]?.head.total ?? 0;
  const complete = r.runs.length === r.requested && done.length === sets.length && done.length > 0;
  return { base, head, total, complete, dropped: done.length > 0 && spreadDropped(base, head) };
}

/** Whether the role passes across its runs: held-out cases exist and ran to the end in every run, neither set's mean dropped beyond base's spread. */
export function runsPass(r: RoleRuns): boolean {
  const visible = setRuns(r, visibleSet);
  const held = setRuns(r, heldOutSet);
  return held !== null && held.complete && !held.dropped && visible !== null && visible.complete && !visible.dropped;
}

const num = (n: number) => String(Number(n.toFixed(1)));

/** The report for one role across its runs: mean and min-max per set and side, then each run's scores and changed cases. */
export function runsReport(r: RoleRuns): { lines: string[]; fails: boolean } {
  const side = (scores: number[] | null, total: number) => {
    if (!scores) return 'new';
    const s = scoreSpread(scores);
    return `${num(s.mean)}/${total} (${s.min}-${s.max})`;
  };
  const part = (name: string, of: SetOf) => {
    const s = setRuns(r, of);
    if (!s) return `${name}: no cases`;
    if (!s.head.length) return `${name}: no complete run`;
    return `${name} mean ${side(s.base, s.total)} → ${side(s.head, s.total)}${s.dropped ? " (lower: the head's mean dropped by more than the base's spread)" : ''}`;
  };
  const pass = runsPass(r);
  const capped = r.runs.length < r.requested || r.runs.some((c) => c.incomplete || c.heldOut?.incomplete);
  const samples = `${r.samples} sample(s) per case${r.samples < DEFAULT_SAMPLES ? ` (below the default ${DEFAULT_SAMPLES}, asked for explicitly)` : ''}`;
  const incomplete = capped ? `; incomplete: the $${r.capUsd.toFixed(2)} cost cap (total across the runs) was reached after ${r.runs.length} of ${r.requested} run(s)` : '';
  const head = `${r.target}: ${part('visible', visibleSet)}; ${part('held-out', heldOutSet)}; ${r.runs.length} run(s) of ${samples} (~$${r.costUsd.toFixed(2)}, the CLI's estimate)${incomplete}${pass ? '' : '; does not pass'}`;
  const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');
  const one = (name: string, s: ScoreComparison | null) => (s ? `${name} ${score(s.base)} → ${score(s.head)}${s.incomplete ? ' (incomplete)' : ''}` : `${name}: no cases`);
  const perRun = r.runs.flatMap((c, i) => [`  run ${i + 1}: ${one('visible', c)}; ${one('held-out', c.heldOut)}`, ...comparisonDiff(c).map((d) => `    ${d}`)]);
  return { lines: [head, ...perRun], fails: !pass };
}
