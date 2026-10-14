// Tiered evaluation, decided in code: the review level a change computes to picks the model that judges it,
// and a cheap verdict that isn't a confident pass is judged once more by the stronger model. No model is
// asked which model should judge.
import type { Level } from './review.js';
import { ROUTING, route } from './routing.js';

export interface EvalRouting {
  /** Judges changes at `cheap_levels` (docs-only, tests-only, comment-only by default). */
  cheap_model: string;
  cheap_levels: Level[];
  /** A failed or uncertain verdict from the cheap model goes to the stronger model once. */
  escalate: boolean;
}

export const DEFAULT_EVAL_ROUTING: EvalRouting = { cheap_model: ROUTING.eval_cheap.default, cheap_levels: ROUTING.eval_cheap_levels.default, escalate: ROUTING.eval_escalate.default };

export function evalRouting(agents: Parameters<typeof route>[0]): EvalRouting {
  return { cheap_model: route(agents, 'eval_cheap').value, cheap_levels: route(agents, 'eval_cheap_levels').value, escalate: route(agents, 'eval_escalate').value };
}

/**
 * The level used to route the evaluation: the computed review level, except that a comment-only change routes
 * as L0 (it can't change behavior). Only routing; the change's review level for merging is untouched.
 */
export function routingLevel(level: Level, files: { path: string; addedLines: string[]; removedLines: string[] }[]): Level {
  return commentOnly(files) ? 'L0' : level;
}

/** The model that judges a change at `level`: the cheap model for its levels, else the evaluator role's model. */
export function evaluatorModel(level: Level, strongModel: string, r: EvalRouting = DEFAULT_EVAL_ROUTING): string {
  return r.cheap_levels.includes(level) ? r.cheap_model : strongModel;
}

export interface Verdict {
  patch_correct: boolean;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Whether a verdict goes to the stronger model before it counts: only a verdict from the cheap model (never one
 * the stronger model gave), and only when it isn't a confident pass: a rejection, an uncertain approval, or no
 * verdict at all. One escalation; the stronger model's verdict is final.
 */
export function shouldEscalate(o: { usedModel: string; strongModel: string; verdict: Verdict | null; escalated: boolean; routing?: EvalRouting }): boolean {
  const r = o.routing ?? DEFAULT_EVAL_ROUTING;
  if (!r.escalate || o.escalated || o.usedModel === o.strongModel) return false;
  return !o.verdict || !o.verdict.patch_correct || o.verdict.confidence !== 'high';
}

/** Comment markers by file extension, for telling a comment-only change from a code change. */
const COMMENT: [RegExp, RegExp][] = [
  [/\.(ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|hpp|cs|java|kt|kts|go|rs|swift|scala|dart|php|css|scss|less)$/i, /^\s*(\/\/|\/\*|\*\/|\*(?!\*\/)|\/\*\*)/],
  [/\.(py|pyi|sh|bash|zsh|rb|pl|r|yaml|yml|toml|cfg|ini|conf|ps1|tf|Dockerfile|mk)$/i, /^\s*#(?!!)/],
  [/(^|\/)(Makefile|Dockerfile)$/, /^\s*#/],
  [/\.(sql|lua|hs|elm)$/i, /^\s*--/],
  [/\.(html|xml|svg|vue)$/i, /^\s*(<!--|-->)/],
];

/**
 * A change that only adds, edits or removes comments (and blank lines): every changed line, both sides, is a
 * comment or blank in a file whose comment syntax is known. Unknown file types are never comment-only.
 */
export function commentOnly(files: { path: string; addedLines: string[]; removedLines: string[] }[]): boolean {
  if (!files.length) return false;
  return files.every((f) => {
    const syntax = COMMENT.find(([ext]) => ext.test(f.path));
    if (!syntax) return false;
    return [...f.addedLines, ...f.removedLines].every((l) => l.trim() === '' || syntax[1].test(l));
  });
}
