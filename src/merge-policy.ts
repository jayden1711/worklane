// Which of the harness's own ready PRs it may merge itself. Pure logic, one
// answer for the watcher and the tests. Everything high-risk, design-level,
// big or in doubt waits for a human; so does everything while the instance's
// kill switch is off or auto-merge is stopped. "Ready" (required checks green
// on the exact evaluated commit, evaluator approved) is decided before this.
import { BRAND } from './brand.js';
import { AGENT_INSTRUCTIONS, CONTROL_CHARACTER_PATH, hasControlCharacter, isNonUtf8Path, LOCKED_CATEGORIES, NON_UTF8_PATH, ODD_PATH_CATEGORIES, SELF_MODIFICATION, selfModificationPart, type LevelResult } from './review.js';

export interface MergeVerdict {
  patch_correct: boolean;
  test_correct: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** Why the confidence isn't high (eval.verdict); absent on an older verdict. */
  confidence_reason?: string | undefined;
  advice?: string | undefined;
  unread?: string[] | undefined;
  design_change?: boolean | undefined;
  design_reason?: string | undefined;
}

/** The branches the harness's revert PRs come from (a red main after an auto-merge, the main watch). */
export const REVERT_BRANCH_PREFIX = `${BRAND.cli}/revert-`;
export const isRevertBranch = (branch: string) => branch.startsWith(REVERT_BRANCH_PREFIX);
/** The branches of checks proposed from repeated feedback (src/checks-from-feedback.ts): a person merges each. */
export const FEEDBACK_CHECK_BRANCH_PREFIX = `${BRAND.cli}/check-from-feedback-`;

/**
 * Why the harness may never merge this PR itself, whatever else holds: one it didn't open (a person's, a bot's: a
 * person merges it), its own revert PRs (a human approves a revert), and checks proposed from feedback. Empty: it
 * may, if the rest allows.
 */
export function neverAutoMerge(o: { branch: string; openedByHarness: boolean }): string[] {
  const out: string[] = [];
  if (!o.openedByHarness) out.push('never auto-merged: the harness did not open this PR; a person merges it');
  if (isRevertBranch(o.branch)) out.push('never auto-merged: a revert the harness opened; a human approves and merges it');
  if (o.branch.startsWith(FEEDBACK_CHECK_BRANCH_PREFIX)) out.push('never auto-merged: a check proposed from repeated feedback; a human reviews and merges it');
  return out;
}

export interface MergeInput {
  /** The PR's branch (its head ref): a revert's never auto-merges. */
  branch: string;
  /** Whether this instance opened the PR (pr.opened): anyone else's never auto-merges. */
  openedByHarness: boolean;
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
  /** A planned task: high-risk or design-level paths changed outside its approved plan (outsidePlanReasons). */
  outsidePlan?: string[];
  /** The worker raised the PR's risk class to protected (src/pr-rules.ts): protected waits for the owner. */
  claimedProtected?: boolean;
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
  /** A role's held-out comparison (decides); null: no held-out cases; absent: the target isn't a role. */
  held_out?: { base: { passed: number; total: number } | null; result: { passed: number; total: number }; dropped: boolean; incomplete: boolean; changes: { id: string; title: string; base: string; head: string }[] } | null | undefined;
  held_out_error?: string | undefined;
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
    if (!r || r.error || !t.startsWith('role ')) continue;
    // A role's held-out score decides: without it, or with it incomplete or lower, the change waits.
    const h = r.held_out;
    if (!h) out.push(`eval: ${t} has no held-out score${r.held_out_error ? `: ${r.held_out_error}` : ' (the visible score alone never passes a role change)'}`);
    else if (h.incomplete) out.push(`eval: ${t} held-out is incomplete: the cost cap was reached, ${score(h.base)} → ${score(h.result)} on the cases that ran`);
    else if (h.dropped) {
      // By number only: a held-out case's text never reaches a PR, where a prompt writer could read it.
      const diff = h.changes.filter((c) => !(c.base === 'pass' && c.head === 'pass')).map((c) => `  - held-out case ${c.id}: ${c.base} → ${c.head}`);
      out.push([`eval: ${t} scored lower on its held-out cases, ${score(h.base)} → ${score(h.result)}:`, ...diff].join('\n'));
    }
  }
  return out;
}

export interface MergeDecision {
  auto: boolean;
  /** Why it waits for a human, grouped by kind (empty when it merges). */
  reasons: string[];
  /** Each high-risk category it touches, said plainly with the first file in it (whyHighRisk); "Waiting on you" shows these. */
  why: WaitWhy[];
  /** The evaluator's advice, when its verdict is one of the reasons it waits (the hold comment shows it). */
  advice?: string;
}

/** One high-risk category a change touches, in plain words: e.g. "changes the merge policy: src/merge-policy.ts". */
export interface WaitWhy {
  category: string;
  text: string;
}

/** What touching each built-in high-risk category means, in plain words; the repo's own categories are named as they are. */
const CATEGORY_WORDS: Record<string, string> = {
  [AGENT_INSTRUCTIONS]: "changes the agents' instructions",
  'harness-config': "changes the harness's config",
  'guardrail-config': 'changes the guardrails',
  'ci-config': 'changes the CI config',
  'deploy-config': 'changes the deploy config',
  'release-config': 'changes the release config',
  auth: 'changes sign-in or auth',
  secrets: 'touches secrets',
  migration: 'changes a database migration',
  'money-path': 'touches the money path',
  'deletes-data': 'deletes data',
  [CONTROL_CHARACTER_PATH]: 'has a path with a control character',
  [NON_UTF8_PATH]: "has a path that isn't valid UTF-8",
};

/**
 * A path as a reason shows it: quoted (JSON) when it holds a control character, so a newline can't start a line of its
 * own, or a U+FFFD (a name that isn't valid UTF-8), so it reads as the odd name it is.
 */
const shown = (p: string) => (hasControlCharacter(p) || isNonUtf8Path(p) ? JSON.stringify(p) : p);
const paths = (p: string[]) => `${p.slice(0, 3).map(shown).join(', ')}${p.length > 3 ? ` and ${p.length - 3} more` : ''}`;

/**
 * The floor: the locked categories, a path with a control character and a path that isn't valid UTF-8 (review.ts),
 * whatever any list says.
 */
const FLOOR = [...Object.keys(LOCKED_CATEGORIES), ...ODD_PATH_CATEGORIES];

/**
 * The categories that always wait for a human: review.yaml's L3, CI config, the agents' own instructions (built in;
 * no review.yaml removes it), a path with a control character or one that isn't valid UTF-8, and the repo's
 * merge.wait_categories.
 */
export function waitCategoriesOf(review: { levels: { L3_human: { when: string[] } }; merge: { wait_categories: string[] } }): string[] {
  return [...new Set([...review.levels.L3_human.when, 'ci-config', ...FLOOR, ...review.merge.wait_categories])];
}

/** The categories a change waits on: the caller's list plus the floor (whatever list a caller passes). */
const waitingOn = (waitCategories: string[]) => new Set([...waitCategories, ...FLOOR]);

/**
 * Why a change is high-risk, plainly, one line per category it touches, naming the first file in it: "changes the
 * merge policy: src/merge-policy.ts" (self-modification says which part of the harness), "changes a database
 * migration: db/001.sql", or for the repo's own category "touches pricing: src/price.js".
 */
export function whyHighRisk(o: { level: LevelResult; waitCategories: string[] }): WaitWhy[] {
  const out: WaitWhy[] = [];
  for (const c of waitingOn(o.waitCategories)) {
    const hit = o.level.categories[c];
    if (!hit?.length) continue;
    const first = hit[0]!;
    const words = c === SELF_MODIFICATION ? `changes ${selfModificationPart(first) ?? 'the harness itself'}` : (CATEGORY_WORDS[c] ?? `touches ${c}`);
    out.push({ category: c, text: `${words}: ${shown(first)}${hit.length > 1 ? ` and ${hit.length - 1} more` : ''}` });
  }
  return out;
}

/**
 * THE mark of a high-risk reason (a category that always waits for a human: money path, auth, secrets, deploy and
 * release config, the harness's own controls, CI, a worker's protected claim). Every high-risk reason the merge
 * policy and plan mode give starts with it, and the one test of whether a reason is high-risk is isHighRiskReason:
 * a held plan with one is never approvable by voice (src/voice.ts).
 */
export const HIGH_RISK_REASON = 'high-risk: ';
export const isHighRiskReason = (reason: string): boolean => reason.startsWith(HIGH_RISK_REASON);

/**
 * Why files (changed, or planned to change) need a human: high-risk categories, and design-level changes,
 * meaning a binding design flag (`design.by`: who raised it), dependency manifests, or a new top-level
 * module. One answer for the merge policy and for plan mode.
 */
export function riskAndDesignReasons(o: { level: LevelResult; waitCategories: string[]; design?: { flag: boolean | undefined; reason?: string | undefined; by: string }; newTopLevel: string[] }): string[] {
  const reasons: string[] = [];
  // The locked categories (the agents' own instructions, the harness's own controls) always count, whatever list a caller passes (the floor).
  for (const c of waitingOn(o.waitCategories)) {
    const hit = o.level.categories[c];
    if (hit?.length) reasons.push(`${HIGH_RISK_REASON}${c} (${paths(hit)})`);
  }
  if (o.design?.flag === true) reasons.push(`design: ${o.design.by} flagged a design change${o.design.reason ? `: ${o.design.reason}` : ''}`);
  const deps = o.level.categories.dependency;
  if (deps?.length) reasons.push(`design: dependency manifests change (${paths(deps)})`);
  if (o.newTopLevel.length) reasons.push(`design: new top-level module (${paths(o.newTopLevel)})`);
  return reasons;
}

/**
 * A planned task's PR: the high-risk and design-level paths it changes that its approved plan didn't list.
 * The same matchers as riskAndDesignReasons (the change's own categories), with the planned files taken out.
 */
export function outsidePlanReasons(o: { planFiles: string[]; level: LevelResult; waitCategories: string[]; newTopLevel: string[] }): string[] {
  const planned = new Set(o.planFiles.map((p) => p.replace(/^\.\//, '')));
  const level: LevelResult = { ...o.level, categories: Object.fromEntries(Object.entries(o.level.categories).map(([c, ps]) => [c, ps.filter((p) => !planned.has(p))])) };
  const newTopLevel = o.newTopLevel.filter((d) => ![...planned].some((p) => p.startsWith(d)));
  return riskAndDesignReasons({ level, waitCategories: o.waitCategories, newTopLevel }).map((r) => `not in the approved plan: ${r}`);
}

export function mergeDecision(i: MergeInput): MergeDecision {
  const reasons: string[] = [...neverAutoMerge({ branch: i.branch, openedByHarness: i.openedByHarness })];
  if (!i.policyOn) reasons.push('auto-merge is off for this instance (policy.yaml auto_merge)');
  if (!i.repoOn) reasons.push("auto-merge is off for this repo (review.yaml merge.auto)");
  if (i.stopped) reasons.push(`auto-merge is stopped: ${i.stopped}`);

  // High-risk paths or categories, and design-level: the evaluator's flag is binding; new dependencies and new
  // top-level modules are seen in code too.
  reasons.push(...riskAndDesignReasons({ level: i.level, waitCategories: i.waitCategories, design: { flag: i.verdict?.design_change, reason: i.verdict?.design_reason, by: 'the evaluator' }, newTopLevel: i.newTopLevel }));
  if (i.claimedProtected) reasons.push(`${HIGH_RISK_REASON}the worker marked the change protected (a risk class can be raised, never lowered)`);

  // Big.
  if (i.lines > i.limits.max_lines) reasons.push(`big: ${i.lines} changed lines (over ${i.limits.max_lines})`);
  if (i.files > i.limits.max_files) reasons.push(`big: ${i.files} files (over ${i.limits.max_files})`);

  // Any doubt.
  const v = i.verdict;
  if (!v) reasons.push('doubt: no evaluator verdict');
  const before = reasons.length;
  if (v) {
    if (!v.patch_correct) reasons.push('doubt: the evaluator did not approve the patch');
    if (!v.test_correct) reasons.push('doubt: the evaluator doubts the test');
    if (v.confidence !== 'high') reasons.push(`doubt: evaluator confidence ${v.confidence}: ${v.confidence_reason?.trim() || 'no reason recorded'}`);
    if (v.unread?.length) reasons.push(`doubt: the evaluator did not read ${paths(v.unread)}`);
    if (v.design_change === undefined) reasons.push('doubt: the evaluator gave no design-change answer');
  }
  const advice = reasons.length > before ? v?.advice?.trim() : undefined;
  if (i.ciFixRuns) reasons.push(`doubt: ${i.ciFixRuns} CI fix run(s) on this PR`);
  if (i.foreignPush) reasons.push('doubt: someone other than the harness pushed to the branch');
  if (i.pushLimitHit) reasons.push('doubt: the change hit a push limit');
  reasons.push(...(i.instructionEvals ?? []));
  reasons.push(...(i.outsidePlan ?? []));
  return { auto: reasons.length === 0, reasons, why: whyHighRisk({ level: i.level, waitCategories: i.waitCategories }), ...(advice ? { advice } : {}) };
}
