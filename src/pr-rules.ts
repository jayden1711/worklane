// Review rules for the harness's own agent PRs: what every PR body starts with (a one-paragraph intent and a
// risk class), the size limit a change is sent back over ("split it", unless it's mechanical), and the docs-only
// fast path (the light checks decide the harness's own merge call). Pure logic (its one git read, sizeFiles, is in
// coordinator/change-files.ts with every other read of what a change touches), shared by the
// coordinator, the merge flow and the tests. Part of the merge policy (a self-modification path, src/review.ts),
// so a change here waits for the owner.
import { globToRegExp } from './guardrails/glob.js';
import { whyHighRisk, type WaitWhy } from './merge-policy.js';
import type { RequiredCheck } from './pr-watch.js';
import type { LevelResult } from './review.js';

/**
 * docs-only: every changed file is documentation (`*.md` anywhere, or under `docs/`). protected: it touches a
 * category the merge policy always leaves to the owner (money path, auth, secrets, CI, setup scripts, the harness's
 * own controls and the agents' instructions, plus the repo's own wait list). logic: anything else.
 */
export type RiskClass = 'docs-only' | 'logic' | 'protected';
export const RISK_CLASSES: RiskClass[] = ['docs-only', 'logic', 'protected'];
const rank = (c: RiskClass) => RISK_CLASSES.indexOf(c);

/** The owner's definition of documentation for the fast path: narrower than review.ts's `docs` category. */
export const DOCS_ONLY_GLOBS = ['**/*.md', 'docs/**'];
const DOCS_RES = DOCS_ONLY_GLOBS.map((g) => globToRegExp(g));
export const isDocPath = (p: string) => DOCS_RES.some((re) => re.test(p));

export interface ClassResult {
  cls: RiskClass;
  /** Why, in plain words: the high-risk categories (protected), or a short note. */
  why: string[];
}

/**
 * The risk class computed from the changed paths: the merge policy's high-risk categories (review.yaml's L3, CI
 * config, the locked self-modification and agent-instructions categories, the repo's wait list) and the money-path
 * config, all already in `level` (computeLevel). Protected wins over docs-only (AGENTS.md is a .md file).
 */
export function riskClassOf(o: { paths: string[]; level: LevelResult; waitCategories: string[] }): ClassResult {
  const risky: WaitWhy[] = whyHighRisk({ level: o.level, waitCategories: o.waitCategories });
  if (risky.length) return { cls: 'protected', why: risky.map((w) => w.text) };
  if (o.paths.length && o.paths.every(isDocPath)) return { cls: 'docs-only', why: ['only documentation changes'] };
  return { cls: 'logic', why: [] };
}

/** The class a PR goes out with: the computed one, raised (never lowered) by the agent's own claim. */
export function effectiveClass(computed: RiskClass, claimed: RiskClass | undefined | null): RiskClass {
  return claimed && rank(claimed) > rank(computed) ? claimed : computed;
}

export const INTENT_PREFIX = '**Intent:** ';
export const CLASS_PREFIX = '**Risk class:** ';

/** One paragraph: the worker's intent with blank lines and runs of whitespace folded into single spaces. */
export function oneParagraph(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** The head of every agent PR body: the intent paragraph, then the risk class (and why). */
export function prBodyHead(o: { intent: string; cls: RiskClass; why: string[] }): string {
  const why = o.why.length ? ` (${o.why.slice(0, 4).join('; ')}${o.why.length > 4 ? `; and ${o.why.length - 4} more` : ''})` : '';
  return `${INTENT_PREFIX}${oneParagraph(o.intent)}\n\n${CLASS_PREFIX}${o.cls}${why}`;
}

/**
 * Why an agent PR body is refused (empty: it's fine). It must start with a one-paragraph intent and then a risk
 * class, and that class may not be lower than the one computed from the changed paths.
 */
export function prBodyProblems(body: string, computed: RiskClass): string[] {
  const [first = '', second = ''] = body.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const out: string[] = [];
  if (!first.startsWith(INTENT_PREFIX) || !first.slice(INTENT_PREFIX.length).trim()) out.push(`the body does not start with a one-paragraph intent ("${INTENT_PREFIX.trim()} ...")`);
  const m = second.startsWith(CLASS_PREFIX) ? /^(docs-only|logic|protected)\b/.exec(second.slice(CLASS_PREFIX.length)) : null;
  if (!m) out.push(`the intent is not followed by a risk class ("${CLASS_PREFIX.trim()} docs-only | logic | protected")`);
  else if (rank(m[1] as RiskClass) < rank(computed)) out.push(`the risk class ${m[1]} is lower than the one its changed paths give (${computed}); a class can be raised, never lowered`);
  return out;
}

// ---------------------------------------------------------------- size

/** Lockfiles: never counted toward the size limit. */
export const LOCKFILE_GLOBS = [
  '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb', '**/poetry.lock', '**/uv.lock',
  '**/Pipfile.lock', '**/Cargo.lock', '**/go.sum', '**/Gemfile.lock', '**/composer.lock',
];

/** One file of a change (git diff -M): its added and removed lines. A pure rename has none, a binary file none. */
export interface SizeFile {
  path: string;
  /** A rename's old path. */
  from?: string;
  added: string[];
  removed: string[];
}

export type SizeVerdict = { ok: true; lines: number; why: string } | { ok: false; lines: number; why: string };

/** A line with all its whitespace taken out: what formatting can't change. */
const bare = (l: string) => l.replace(/\s+/g, '');

/**
 * The counted lines that aren't mechanical: with whitespace ignored and blank lines dropped, the added lines that
 * no removed line matches and the removed lines no added line matches, across the whole change. A reindent, a
 * reflow into other lines' whitespace, or a file moved (even reformatted on the way) leaves none.
 */
function nonMechanical(files: SizeFile[]): number {
  const pool = new Map<string, number>();
  for (const f of files) for (const l of f.removed.map(bare).filter(Boolean)) pool.set(l, (pool.get(l) ?? 0) + 1);
  let unmatched = 0;
  for (const f of files)
    for (const l of f.added.map(bare).filter(Boolean)) {
      const n = pool.get(l) ?? 0;
      if (n) pool.set(l, n - 1);
      else unmatched++;
    }
  for (const n of pool.values()) unmatched += n;
  return unmatched;
}

/**
 * Over `maxLines` changed lines (added plus removed; lockfiles and generated files not counted), a change is sent
 * back to be split, unless it's mechanical: whitespace ignored and blank lines dropped, its added lines are exactly
 * its removed lines (renames, moves, reindents, formatting). A pure rename counts 0 lines (rename detection).
 */
export function sizeVerdict(files: SizeFile[], o: { maxLines: number; generated: string[] }): SizeVerdict {
  const skip = [...LOCKFILE_GLOBS, ...o.generated].map((g) => globToRegExp(g));
  // A rename is left out only when both its paths are: an edit moved into a generated path still counts (#683).
  const counted = files.filter((f) => ![f.path, ...(f.from === undefined ? [] : [f.from])].every((p) => skip.some((re) => re.test(p))));
  const lines = counted.reduce((s, f) => s + f.added.length + f.removed.length, 0);
  if (lines <= o.maxLines) return { ok: true, lines, why: `${lines} changed lines (limit ${o.maxLines})` };
  const real = nonMechanical(counted);
  if (real === 0) return { ok: true, lines, why: `${lines} changed lines, all mechanical (renames, moves or formatting)` };
  return {
    ok: false,
    lines,
    why: `split it: ${lines} changed lines (over review.yaml max_pr_lines ${o.maxLines}, lockfiles and generated files not counted), and not mechanical (${real} of them are more than renames, moves or formatting)`,
  };
}

/** The change base..head as sizeVerdict reads it. The git read lives with every other one (coordinator/change-files.ts). */
export { sizeFiles } from './coordinator/change-files.js';

// ---------------------------------------------------------------- docs-only fast path

/**
 * The required checks the harness's own merge call waits on for a PR: every required check, or for a docs-only PR
 * the light ones (review.yaml docs_only_checks, those of them that are required). Empty docs_only_checks: no fast path.
 * GitHub's ruleset still requires every required check before it lets the merge through (see docs).
 */
export function checksFor(o: { cls: RiskClass; required: string[]; docsOnlyChecks: string[] }): { checks: string[]; fast: boolean } {
  const light = o.required.filter((c) => o.docsOnlyChecks.includes(c));
  if (o.cls !== 'docs-only' || !light.length) return { checks: o.required, fast: false };
  return { checks: light, fast: true };
}

/**
 * A docs-only PR the harness decided on its light checks, while GitHub reports it blocked: the ruleset still
 * requires every required check. Those still running (or not reported yet): wait, and look again on the next poll.
 * One that failed: a human looks (the light checks don't speak for it). None outstanding: blocked for another
 * reason, which the merge policy reports as usual.
 */
export function rulesetHold(full: RequiredCheck[]): { act: 'wait' } | { act: 'hold'; why: string } | { act: 'none' } {
  const failed = full.filter((c) => c.outcome === 'fail' || c.outcome === 'cancelled');
  if (failed.length) return { act: 'hold', why: `docs-only fast path: the ruleset's required check(s) ${failed.map((c) => `${c.name} (${c.outcome})`).join(', ')} did not pass on GitHub` };
  if (full.some((c) => c.outcome === 'pending' || c.outcome === 'missing')) return { act: 'wait' };
  return { act: 'none' };
}
