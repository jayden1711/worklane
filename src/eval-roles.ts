// The role-prompt eval (scripts/eval-roles.mjs): its options, the run.cost record of every model call, and its
// verdict. Each role is scored on its visible cases and on its held-out cases (src/held-out.ts), 3 samples per
// case unless fewer are asked for (and the report says so). The held-out score decides: a role whose held-out
// score drops, is incomplete or is missing fails the run, whatever its visible score did.
// Base and head each run N times (3 unless asked otherwise, #550): one run's delta is noise (the same base scored
// 33/35 and then 31/35 on identical prompts), so a score "drops" only when head's mean falls below base's mean by
// more than base's min-max spread. The cost cap covers all N runs of a role.
// The fix loop (--fix, #332): when a role's head has a failing case, a fixer proposes a revised prompt from the
// failing VISIBLE cases only, the proposal is rerun (visible and held-out, N runs), and this repeats up to the attempt
// cap. An attempt whose held-out score drops is rejected whatever its visible score did; held-out never ranks
// attempts. The fixer's prompt (fixerPrompt) has no held-out input at all, and the loop's record holds held-out
// scores, ids and outcomes only (titles are blanked on the way in: redactHeldOut). Every attempt is recorded
// (diff, scores, cost) and the report goes start → each attempt → final. The loop only proposes: it never edits
// src/roles.ts or any other file; the owner applies the proposed diff by hand and reruns the eval.
import { rmSync } from 'node:fs';
import { lineDiff } from './line-diff.js';
import { HELD_OUT_ENV } from './held-out-paths.js';
import { CONTRACT_PARTS } from './role-contract.js';
import { HELD_OUT_FROM_STATE_FLAG, heldOutAllowed, spendFromArgs } from './spend-gate.js';
import { assertJudgeDiffers, comparisonDiff, comparisonLine, comparisonPasses, DEFAULT_SAMPLES, failedCost, neutralDir, type Ask, type EvalCase, type EvalComparison, type ScoreComparison } from './skilleval.js';

/** Runs of each of base and head per role, unless another number is asked for. */
export const DEFAULT_RUNS = 3;

/** Fix attempts per role when --fix is given without a number (#332). */
export const DEFAULT_FIX_ATTEMPTS = 3;

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
  /** Fix attempts per role with a failing case (--fix [n]); 0: no fix loop. */
  fixAttempts: number;
  /** The fixer's model (--fixer). */
  fixer: string;
  /** Dollars per role for the whole fix loop: every fixer call and every rerun (--fix-cap). */
  fixCap: number;
  /**
   * --spend: the most this invocation may spend in all (src/spend-gate.ts); null when not given, and then the script
   * prints its plan and makes no model call. It bounds --cap and --fix-cap from above.
   */
  spend: number | null;
  /** --held-out-from-state: read (and with --write-held-out, write) the held-out store in this machine's state. */
  heldOutFromState: boolean;
}

/** Each held-out case writer's budget (one call per role with --write-held-out). */
export const WRITER_BUDGET_USD = 2;

export function evalRolesOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): EvalRolesOptions {
  const arg = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : fallback;
  };
  const samples = Number(arg('samples', String(DEFAULT_SAMPLES)));
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`--samples must be a whole number of at least 1, not ${arg('samples', '')}`);
  // A bare --runs (no number after it) is refused, not read as the default.
  if (argv.includes('--runs') && !arg('runs', '')) throw new Error('--runs needs a number: --runs N');
  const runs = Number(arg('runs', String(DEFAULT_RUNS)));
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a whole number of at least 1, not ${arg('runs', '')}`);
  const scoreOnly = argv.includes('--score');
  // --score stays what it was: one run of the current prompts, nothing to compare a spread against.
  if (scoreOnly && argv.includes('--runs')) throw new Error('--score scores the current prompts once; --runs applies to a base/head comparison');
  const cap = Number(arg('cap', '10'));
  if (!(cap > 0)) throw new Error('--cap must be a positive number of dollars');
  const roles = arg('roles', '');
  const model = arg('model', 'sonnet');
  const judge = arg('judge', 'opus');
  // Refused here, before any model is asked or any held-out case is written (evalInstructions refuses it again).
  assertJudgeDiffers(model, judge);
  const fixAttempts = argv.includes('--fix') ? Number(arg('fix', String(DEFAULT_FIX_ATTEMPTS))) : 0;
  if (argv.includes('--fix') && (!Number.isInteger(fixAttempts) || fixAttempts < 1)) throw new Error(`--fix takes a whole number of attempts of at least 1, not ${arg('fix', '')}`);
  if (fixAttempts && scoreOnly) throw new Error('--fix needs a base/head comparison; --score has no base');
  const fixCap = Number(arg('fix-cap', '10'));
  if (!(fixCap > 0)) throw new Error('--fix-cap must be a positive number of dollars');
  const spend = spendFromArgs(argv);
  const writeHeldOut = argv.includes('--write-held-out');
  // Writing goes into a held-out store, so it needs one named on purpose, like reading (#612).
  if (writeHeldOut && !heldOutAllowed(argv, env)) throw new Error(`--write-held-out writes into a held-out store: set ${HELD_OUT_ENV} or pass ${HELD_OUT_FROM_STATE_FLAG}`);
  return { base: arg('base', 'origin/main'), roles: roles ? roles.split(',') : [], model, judge, samples, runs, cap, writeHeldOut, scoreOnly, fixAttempts, fixer: arg('fixer', 'opus'), fixCap, spend, heldOutFromState: argv.includes(HELD_OUT_FROM_STATE_FLAG) };
}

/** The most a run with these options could spend on `roles` roles: each role's caps, before --spend bounds them. */
export function evalRolesMaxSpend(o: EvalRolesOptions, roles: number): number {
  return roles * (o.cap + (o.fixAttempts ? o.fixCap : 0) + (o.writeHeldOut ? WRITER_BUDGET_USD : 0));
}

/** An Ask whose every call is recorded as run.cost (role, model, the CLI's estimate). */
export function recordingAsk(ask: Ask, role: string, record: (cost: { role: string; model: string; usd: number; turns: number }) => void): Ask {
  return async (req) => {
    let r;
    try {
      r = await ask(req);
    } catch (e) {
      // A failed call that spent is recorded too (AskFailed carries its cost).
      const usd = failedCost(e);
      if (usd > 0) record({ role, model: req.model, usd, turns: 1 });
      throw e;
    }
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
  const cut = r.runs.findIndex((c) => c.incomplete || Boolean(c.heldOut?.incomplete));
  const samples = `${r.samples} sample(s) per case${r.samples < DEFAULT_SAMPLES ? ` (below the default ${DEFAULT_SAMPLES}, asked for explicitly)` : ''}`;
  // The cap either cut a run short (during it) or left nothing for the next one (after the last that ran).
  const when = cut >= 0 ? `during run ${cut + 1} of ${r.requested}` : `after ${r.runs.length} of ${r.requested} run(s)`;
  const incomplete = cut >= 0 || r.runs.length < r.requested ? `; incomplete: the $${r.capUsd.toFixed(2)} cost cap (total across the runs) was reached ${when}` : '';
  const head = `${r.target}: ${part('visible', visibleSet)}; ${part('held-out', heldOutSet)}; ${r.runs.length} run(s) of ${samples} (~$${r.costUsd.toFixed(2)}, the CLI's estimate)${incomplete}${pass ? '' : '; does not pass'}`;
  const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');
  const one = (name: string, s: ScoreComparison | null) => (s ? `${name} ${score(s.base)} → ${score(s.head)}${s.incomplete ? ' (incomplete)' : ''}` : `${name}: no cases`);
  const perRun = r.runs.flatMap((c, i) => [`  run ${i + 1}: ${one('visible', c)}; ${one('held-out', c.heldOut)}`, ...comparisonDiff(c).map((d) => `    ${d}`)]);
  return { lines: [head, ...perRun], fails: !pass };
}

// ---------------------------------------------------------------- the fix loop (#332)

/** One version's own scores across its runs (head side): rubric items met in each run that completed, per set. */
export interface VersionScores {
  visible: number[];
  heldOut: number[];
  visibleTotal: number;
  heldOutTotal: number;
  /** Every run asked for ran to the end on both sets, and the role has held-out cases. */
  complete: boolean;
}

export function versionScores(r: RoleRuns): VersionScores {
  const v = setRuns(r, visibleSet);
  const h = setRuns(r, heldOutSet);
  return { visible: v?.head ?? [], heldOut: h?.head ?? [], visibleTotal: v?.total ?? 0, heldOutTotal: h?.total ?? 0, complete: Boolean(v?.complete && h?.complete) };
}

/** Every case, visible and held-out, passed in every run, and every run ran to the end. */
export function allCasesPass(r: RoleRuns): boolean {
  return versionScores(r).complete && r.runs.every((c) => c.changes.every((x) => x.head === 'pass') && (c.heldOut?.changes ?? []).every((x) => x.head === 'pass'));
}

/**
 * The runs with every held-out case's title blanked (ids, outcomes and scores kept): what the fix loop holds. A new
 * object; the caller's runs are untouched. Held-out situations and rubrics are never in a RoleRuns to begin with.
 */
export function redactHeldOut(r: RoleRuns): RoleRuns {
  return { ...r, runs: r.runs.map((c) => (c.heldOut ? { ...c, heldOut: { ...c.heldOut, changes: c.heldOut.changes.map((x) => ({ ...x, title: '' })) } } : c)) };
}

/** The visible cases that failed in at least one run: all the fixer is told. Held-out outcomes are never read here. */
export function visibleFailures(r: RoleRuns, visible: EvalCase[]): EvalCase[] {
  const failing = new Set(r.runs.flatMap((c) => c.changes.filter((x) => x.head !== 'pass').map((x) => x.id)));
  return visible.filter((c) => failing.has(c.id));
}

export const FIXER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'why'],
  properties: {
    prompt: { type: 'string', description: 'The whole revised instructions, every line, ready to replace the current ones.' },
    why: { type: 'string', maxLength: 800, description: 'One short paragraph: what you changed and why.' },
  },
} as const;

/**
 * The fixer's whole input: the role's name, the prompt it fixes and its failing visible cases (situation, correct,
 * wrong). There is no parameter for held-out cases, their scores or their outcomes.
 */
export function fixerPrompt(role: string, prompt: string, failing: EvalCase[]): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  return [
    `You revise the instructions (the system prompt) of an AI agent role named "${role}". In its eval the agent gets only a situation and writes what it would do; a judge then checks the plan against the case's actions. Under the current instructions these cases fail:`,
    '',
    ...failing.flatMap((c) => [`## Case ${c.id}: ${c.title}`, 'Situation:', c.situation, 'The plan must:', list(c.correct), 'The plan must not:', list(c.wrong), '']),
    'The current instructions:',
    '<instructions>',
    prompt,
    '</instructions>',
    '',
    `Return the whole revised instructions in "prompt" and what you changed in "why". Change as little as fixes these cases; keep every other line as it is, and keep the contract lines (${CONTRACT_PARTS.map((p) => `${p}:`).join(' ')}) unless one of them causes a failure. Write general rules the role should follow, never answers to these exact situations: the change is also judged on cases you are not shown, and it is rejected if it does worse on them.`,
  ].join('\n');
}

export type FixVerdict = 'every case passes' | 'better' | 'not better' | 'rejected: held-out dropped' | 'no change' | 'incomplete';
export type FixStop = 'every case passes' | 'attempt cap' | 'fix cost cap' | 'no held-out cases' | 'start incomplete' | 'only held-out cases fail';

/** One fix attempt, as recorded: what it changed, how it scored, what it cost and what was decided. */
export interface FixAttempt {
  n: number;
  /** The version it revised: 0 the starting prompt (the head), else that attempt's. */
  from: number;
  /** The visible cases the fixer was shown, by id. */
  shown: string[];
  prompt: string;
  /** The proposed prompt against the starting one, by line (empty when nothing changed). */
  diff: string;
  why: string;
  /** Its reruns (head only, visible and held-out); null when it wasn't rerun. */
  runs: RoleRuns | null;
  scores: VersionScores | null;
  /** The fixer's call and the reruns together. */
  costUsd: number;
  verdict: FixVerdict;
}

export interface FixLoop {
  target: string;
  role: string;
  fixer: string;
  maxAttempts: number;
  capUsd: number;
  costUsd: number;
  /** The head's runs against the base: where the loop starts. */
  start: RoleRuns;
  attempts: FixAttempt[];
  /** The best version: 0 the start (nothing to propose), else an attempt's number. */
  best: number;
  stopped: FixStop;
}

const meanOf = (xs: number[]) => (xs.length ? scoreSpread(xs).mean : -Infinity);
/**
 * A higher visible mean; nothing else. Held-out never ranks attempts (a tie broken on it would pick the proposal, and
 * the next fixer call's input, by held-out score): it only vetoes a drop and decides "every case passes".
 */
const beats = (a: VersionScores, b: VersionScores) => meanOf(a.visible) > meanOf(b.visible);

/**
 * Fix → rerun, up to `maxAttempts` times, within `capUsd` for the fixer's calls and the reruns together. Each attempt
 * revises the best version so far from its failing visible cases. An attempt whose held-out mean dropped below the
 * start's or the version it revised (by more than that version's spread) is rejected, whatever its visible score did.
 * It stops when every case passes, at the attempt cap or at the cost cap, and returns every attempt and the best one.
 * It proposes only: it writes no file. The held-out cases themselves (situations, rubrics) never reach it: `rerun`
 * holds them. Its runs carry held-out scores, ids and outcomes; their titles are blanked on the way in
 * (redactHeldOut), so the loop's record holds no held-out text. Held-out decides only the veto and "every case
 * passes"; which attempt is better, and so what the next fixer call revises, is the visible score's alone.
 */
export async function fixLoop(o: { role: string; prompt: string; start: RoleRuns; visible: EvalCase[]; rerun: (prompt: string, capUsd: number) => Promise<RoleRuns>; fixer: Ask; fixerModel: string; maxAttempts: number; capUsd: number }): Promise<FixLoop> {
  const start = redactHeldOut(o.start);
  const out: FixLoop = { target: start.target, role: o.role, fixer: o.fixerModel, maxAttempts: o.maxAttempts, capUsd: o.capUsd, costUsd: 0, start, attempts: [], best: 0, stopped: 'attempt cap' };
  const startScores = versionScores(start);
  // Without held-out cases nothing guards a fix against overfitting the visible ones: no loop.
  if (!start.runs.length || start.runs.some((c) => c.heldOut === null)) return { ...out, stopped: 'no held-out cases' };
  if (!startScores.complete) return { ...out, stopped: 'start incomplete' };
  if (allCasesPass(start)) return { ...out, stopped: 'every case passes' };
  const version = (n: number) => (n === 0 ? { prompt: o.prompt, runs: start, scores: startScores } : { prompt: out.attempts[n - 1]!.prompt, runs: out.attempts[n - 1]!.runs!, scores: out.attempts[n - 1]!.scores! });
  for (let n = 1; n <= o.maxAttempts; n++) {
    const from = version(out.best);
    const failing = visibleFailures(from.runs, o.visible);
    if (!failing.length) {
      out.stopped = 'only held-out cases fail';
      break;
    }
    const left = o.capUsd - out.costUsd;
    if (left <= 0) {
      out.stopped = 'fix cost cap';
      break;
    }
    const cwd = neutralDir();
    let r: { structured: unknown; costUsd: number };
    try {
      r = await o.fixer({ prompt: fixerPrompt(o.role, from.prompt, failing), model: o.fixerModel, schema: FIXER_SCHEMA, cwd, maxBudgetUsd: Math.max(0.05, Math.min(left, 2)) });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    out.costUsd += r.costUsd;
    const s = (r.structured ?? {}) as { prompt?: unknown; why?: unknown };
    const prompt = typeof s.prompt === 'string' ? s.prompt.trim() : '';
    const a: FixAttempt = { n, from: out.best, shown: failing.map((c) => c.id), prompt, diff: '', why: typeof s.why === 'string' ? s.why.trim() : '', runs: null, scores: null, costUsd: r.costUsd, verdict: 'no change' };
    out.attempts.push(a);
    if (!prompt || prompt === from.prompt.trim()) continue;
    a.diff = lineDiff(o.prompt, prompt, `role ${o.role} prompt`);
    if (o.capUsd - out.costUsd <= 0) {
      a.verdict = 'incomplete';
      out.stopped = 'fix cost cap';
      break;
    }
    a.runs = redactHeldOut(await o.rerun(prompt, o.capUsd - out.costUsd));
    a.costUsd += a.runs.costUsd;
    out.costUsd += a.runs.costUsd;
    a.scores = versionScores(a.runs);
    if (!a.scores.complete) {
      a.verdict = 'incomplete';
      out.stopped = 'fix cost cap';
      break;
    }
    if ([startScores, from.scores].some((ref) => spreadDropped(ref.heldOut, a.scores!.heldOut))) a.verdict = 'rejected: held-out dropped';
    else if (allCasesPass(a.runs)) a.verdict = 'every case passes';
    else a.verdict = beats(a.scores, from.scores) ? 'better' : 'not better';
    if (a.verdict === 'every case passes' || a.verdict === 'better') out.best = n;
    if (a.verdict === 'every case passes') {
      out.stopped = 'every case passes';
      break;
    }
  }
  return out;
}

const STOPPED: Record<FixStop, string> = {
  'every case passes': 'every case passes',
  'attempt cap': 'the attempt cap was reached',
  'fix cost cap': 'the fix cost cap was reached',
  'no held-out cases': 'not run: no held-out cases, so nothing could reject a fix that only fits the visible cases',
  'start incomplete': "not run: the head's eval was incomplete",
  'only held-out cases fail': 'only held-out cases fail, and the fixer is never shown those',
};

/** The loop's report: the base and the start, each attempt (scores, cost, verdict, diff), then the final proposal. */
export function fixReport(l: FixLoop): string[] {
  const spread = (xs: number[] | null, total: number) => {
    if (!xs) return 'new';
    if (!xs.length) return 'none';
    const s = scoreSpread(xs);
    return `${num(s.mean)}/${total} (${s.min}-${s.max})`;
  };
  const scores = (s: VersionScores) => `visible mean ${spread(s.visible, s.visibleTotal)}; held-out mean ${spread(s.heldOut, s.heldOutTotal)}`;
  const head = `${l.target}: fix loop, ${l.attempts.length} of ${l.maxAttempts} attempt(s), fixer ${l.fixer}, ~$${l.costUsd.toFixed(2)} of the $${l.capUsd.toFixed(2)} fix cap (the CLI's estimate); stopped: ${STOPPED[l.stopped]}`;
  if (!l.attempts.length) return [head];
  const start = versionScores(l.start);
  const base = { visible: setRuns(l.start, visibleSet)?.base ?? null, heldOut: setRuns(l.start, heldOutSet)?.base ?? null };
  const lines = [head, `  base: visible mean ${spread(base.visible, start.visibleTotal)}; held-out mean ${spread(base.heldOut, start.heldOutTotal)}`, `  start (the head): ${scores(start)}`];
  for (const a of l.attempts) {
    const from = a.from === 0 ? start : l.attempts[a.from - 1]!.scores!;
    const raised = a.scores && meanOf(a.scores.visible) > meanOf(from.visible) ? 'raised the visible score but ' : '';
    const verdict = a.verdict === 'rejected: held-out dropped' ? `rejected: it ${raised}dropped the held-out score` : a.verdict;
    lines.push(`  attempt ${a.n} (revising ${a.from ? `attempt ${a.from}` : 'the start'}; shown visible case(s) ${a.shown.join(', ')}): ${a.scores ? scores(a.scores) : 'not rerun'}; ~$${a.costUsd.toFixed(2)}; ${verdict}`);
    if (a.why) lines.push(`    why: ${a.why.replace(/\s+/g, ' ')}`);
    if (a.diff) lines.push(...a.diff.split('\n').map((d) => `    ${d}`));
  }
  if (!l.best) {
    lines.push('  final: no attempt beat the start; nothing proposed');
    return lines;
  }
  const best = l.attempts[l.best - 1]!;
  const s = best.scores!;
  const passes = !spreadDropped(base.visible, s.visible) && !spreadDropped(base.heldOut, s.heldOut);
  lines.push(`  final: attempt ${best.n}, ${scores(s)}; against the base it ${passes ? 'passes' : 'does not pass'}`);
  lines.push(`  proposed, not applied: attempt ${best.n}'s diff above is the edit to role ${l.role}'s prompt in src/roles.ts; apply it by hand and rerun this eval`);
  return lines;
}
