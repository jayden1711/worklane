// Which of the harness's own ready PRs it may merge itself. Pure logic, one
// answer for the watcher and the tests. Everything high-risk, design-level,
// big or in doubt waits for a human; so does everything while the instance's
// kill switch is off or auto-merge is stopped. "Ready" (required checks green
// on the exact evaluated commit, evaluator approved) is decided before this.
import type { LevelResult } from './review.js';

export interface MergeVerdict {
  patch_correct: boolean;
  test_correct: boolean;
  confidence: 'high' | 'medium' | 'low';
  unread?: string[] | undefined;
  design_change?: boolean | undefined;
  design_reason?: string | undefined;
}

export interface MergeInput {
  /** The instance policy's auto_merge (the kill switch). */
  policyOn: boolean;
  /** review.yaml merge.auto. */
  repoOn: boolean;
  /** Why auto-merge is stopped for this instance (main went red after one), or null. */
  stopped: string | null;
  /** Review categories of the whole change, with the paths in each (computeLevel). */
  level: LevelResult;
  /** Categories that always wait: L3's, plus ci-config and the repo's merge.wait_categories. */
  waitCategories: string[];
  limits: { max_lines: number; max_files: number };
  lines: number;
  files: number;
  verdict: MergeVerdict | null;
  /** Top-level directories the change creates (a new module or package). */
  newTopLevel: string[];
  /** CI fix runs started on this PR. */
  ciFixRuns: number;
  /** The PR's head isn't the harness's own last push. */
  foreignPush: boolean;
  /** The change ever hit a push limit. */
  pushLimitHit: boolean;
  /** Why the evals of instructions the change touches don't clear it (instructionEvalReasons); empty: they do. */
  instructionEvals?: string[];
}

export interface InstructionEvalResult {
  target: string;
  base: { passed: number; total: number } | null;
  result: { passed: number; total: number } | null;
  dropped: boolean;
  incomplete: boolean;
  changes: { id: string; title: string; base: string; head: string }[];
  cost_usd: number;
  error?: string | undefined;
}

/**
 * For each instructions target the change touches: a reason to wait unless its eval ran to the end without
 * a drop. A drop lists every case whose outcome changed, so the owner sees what got worse.
 */
export function instructionEvalReasons(targets: string[], results: InstructionEvalResult[]): string[] {
  const out: string[] = [];
  const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');
  for (const t of targets) {
    const r = results.find((x) => x.target === t);
    if (!r) out.push(`eval: ${t} changed but was not evaluated`);
    else if (r.error) out.push(`eval: ${t} was not evaluated: ${r.error}`);
    else if (r.incomplete) out.push(`eval: ${t} is incomplete: the cost cap was reached (~$${r.cost_usd.toFixed(2)}), ${score(r.base)} → ${score(r.result)} on the cases that ran`);
    else if (r.dropped) {
      const diff = r.changes.filter((c) => !(c.base === 'pass' && c.head === 'pass')).map((c) => `  - case ${c.id} "${c.title}": ${c.base} → ${c.head}`);
      out.push([`eval: ${t} scored lower, ${score(r.base)} → ${score(r.result)} (~$${r.cost_usd.toFixed(2)}):`, ...diff].join('\n'));
    }
  }
  return out;
}

export interface MergeDecision {
  auto: boolean;
  /** Why it waits for a human, grouped by kind (empty when it merges). */
  reasons: string[];
}

const paths = (p: string[]) => `${p.slice(0, 3).join(', ')}${p.length > 3 ? ` and ${p.length - 3} more` : ''}`;

export function mergeDecision(i: MergeInput): MergeDecision {
  const reasons: string[] = [];
  if (!i.policyOn) reasons.push('auto-merge is off for this instance (policy.yaml auto_merge)');
  if (!i.repoOn) reasons.push("auto-merge is off for this repo (review.yaml merge.auto)");
  if (i.stopped) reasons.push(`auto-merge is stopped: ${i.stopped}`);

  // High-risk paths or categories.
  for (const c of i.waitCategories) {
    const hit = i.level.categories[c];
    if (hit?.length) reasons.push(`high-risk: ${c} (${paths(hit)})`);
  }

  // Design-level: the evaluator's flag is binding; new dependencies and new top-level modules are seen in code too.
  if (i.verdict?.design_change === true) reasons.push(`design: the evaluator flagged a design change${i.verdict.design_reason ? `: ${i.verdict.design_reason}` : ''}`);
  const deps = i.level.categories.dependency;
  if (deps?.length) reasons.push(`design: dependency manifests change (${paths(deps)})`);
  if (i.newTopLevel.length) reasons.push(`design: new top-level module (${paths(i.newTopLevel)})`);

  // Big.
  if (i.lines > i.limits.max_lines) reasons.push(`big: ${i.lines} changed lines (over ${i.limits.max_lines})`);
  if (i.files > i.limits.max_files) reasons.push(`big: ${i.files} files (over ${i.limits.max_files})`);

  // Any doubt.
  const v = i.verdict;
  if (!v) reasons.push('doubt: no evaluator verdict');
  else {
    if (!v.patch_correct) reasons.push('doubt: the evaluator did not approve the patch');
    if (!v.test_correct) reasons.push('doubt: the evaluator doubts the test');
    if (v.confidence !== 'high') reasons.push(`doubt: evaluator confidence ${v.confidence}`);
    if (v.unread?.length) reasons.push(`doubt: the evaluator did not read ${paths(v.unread)}`);
    if (v.design_change === undefined) reasons.push('doubt: the evaluator gave no design-change answer');
  }
  if (i.ciFixRuns) reasons.push(`doubt: ${i.ciFixRuns} CI fix run(s) on this PR`);
  if (i.foreignPush) reasons.push('doubt: someone other than the harness pushed to the branch');
  if (i.pushLimitHit) reasons.push('doubt: the change hit a push limit');
  reasons.push(...(i.instructionEvals ?? []));
  return { auto: reasons.length === 0, reasons };
}
