// Risk-based review levels, computed by code from what a change touches.
// The highest matching level wins; a failed or low-confidence evaluator
// verdict bumps it up one; an agent can raise its own level, never lower it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewConfig } from './config/schema.js';
import { globToRegExp } from './guardrails/glob.js';
import { BRAND } from './brand.js';
import { HOOK_IMPORTS } from './hook-imports.js';

export type Level = 'L0' | 'L1' | 'L2' | 'L3';
const ORDER: Level[] = ['L0', 'L1', 'L2', 'L3'];
const up = (l: Level): Level => ORDER[Math.min(3, ORDER.indexOf(l) + 1)]!;

/**
 * The agents' own instructions: the config folder's roles and skills (the one part of it agents may edit), the root
 * AGENTS.md and every CLAUDE.md. Always high-risk, so their PRs never auto-merge (merge-policy.ts
 * waitCategoriesOf), whatever review.yaml says; review.yaml can't redefine, drop or loosen it.
 */
export const AGENT_INSTRUCTIONS = 'agent-instructions';

/**
 * The harness changing its own controls: the merge policy, the main watch and the push guard, the updater, the review
 * levels and guardrails, the machine's setup scripts and CI workflows, sign-in and credentials, who may approve, the
 * evaluator and the agent runner, the sandbox, the push gate, denylist and secret scan, the tests that hold those
 * controls, and the release and design rules.
 * Always L3 and never auto-merged (merge-policy.ts waitCategoriesOf), whatever review.yaml says; review.yaml can't
 * redefine, drop or loosen it. Each part says, in the words "Waiting on you" shows, what such a change changes; the
 * first part a file matches names it. Every glob matches a real file in the engine's repo (a test checks).
 */
export const SELF_MODIFICATION = 'self-modification';
export const SELF_MODIFICATION_PARTS: { what: string; globs: string[] }[] = [
  { what: 'the merge policy', globs: ['src/merge-policy*', 'src/coordinator/merge-flow*', 'src/pr-rules*'] },
  { what: 'the main watch', globs: ['src/main-watch*', 'src/github/main-watch-api*'] },
  { what: 'the push guard', globs: ['src/push-guard*', 'src/push-check*'] },
  { what: 'the updater', globs: ['src/updates*', `scripts/machine/${BRAND.cli}-update*`] },
  { what: 'the review levels', globs: [`${BRAND.configDir}/review.yaml`, 'src/review.ts'] },
  { what: 'the guardrails', globs: [`${BRAND.configDir}/guardrails.yaml`, 'src/guardrails/**'] },
  { what: 'the machine setup', globs: ['scripts/setup/**', 'scripts/machine/**'] },
  { what: 'the CI workflows', globs: ['.github/workflows/**'] },
  // Whose signed tag the release workflow stages on npm, and the check that enforces it (release.yml).
  { what: 'who may sign a release', globs: ['.github/release-signers', 'scripts/verify-release-tag*'] },
  { what: 'sign-in, credentials or secrets', globs: ['src/dashboard-auth*', 'src/github-app*', 'src/github-scope*', 'src/**/*secret*', 'src/console/terminal*', 'src/setup/app-manifest*'] },
  { what: 'who may approve', globs: ['src/decide.ts', 'src/intake/decide.ts', 'src/intake/people.ts', 'src/machine-owners.ts'] },
  // WHY: before this, these were the owner's call only where a repo's own review.yaml listed them (the engine's does, as
  // `engine`); a repo whose review.yaml didn't would have merged a change to the evaluator or the denylist on its own.
  { what: 'the evaluator and the agent runner', globs: ['src/roles.ts', 'src/coordinator.ts', 'src/runner.ts'] },
  { what: 'the sandbox and test runs', globs: ['src/sandbox.ts', 'src/testrun/**'] },
  // The PreToolUse guard (which tool calls an agent may make, the config folder's guard among them) and the post-edit hook,
  // with every module it reaches, directly or through other imports (#655, #665): the deny lists, the read-only agents'
  // tools and refusals, the task file's frozen paths, the guardrail rules' loader, the secret check, and the rest.
  // src/hook-imports.ts holds that tree as the test reads it from the real imports (test/review.test.ts).
  // Its process entry is src/hook-main.ts (under src/hook*), so the tree is read from there too (#665).
  { what: "the agents' tool guard", globs: ['src/hook*', ...HOOK_IMPORTS] },
  // What writes the hook commands that run it (src/install.ts hookCommand, src/instance.ts's research lanes): a change
  // there could point an agent's hooks at another entry, or at none (#665).
  { what: "the agents' tool guard's hook commands", globs: ['src/install.ts', 'src/instance.ts'] },
  // Which repos root says are managed apps, where the engine's own source paths below aren't locked (#665).
  { what: 'where the self-modification locks apply', globs: ['src/managed-apps.ts'] },
  { what: 'the push gate, denylist and secret scan', globs: ['scripts/push-gate*', 'scripts/check-denylist.mjs', 'scripts/lib/denylist.mjs', 'scripts/check-dco.mjs', '.denylist*', '.gitleaks*', '.githooks/**'] },
  // A tests-only change is L0 and merges itself: so the tests that hold the controls above are named here, one by one.
  {
    what: 'the tests of the harness controls',
    globs: [
      'test/review.test.ts', 'test/merge-policy.test.ts', 'test/guardrails.test.ts',
      'test/push-check.test.ts', 'test/push-guard.test.ts', 'test/push-hook-guard.test.ts', 'test/push-gate.test.ts', 'test/push-gate-hook.test.ts',
      'test/main-watch.test.ts', 'test/main-watch-coordinator.test.ts', 'test/denylist.test.ts', 'test/dco.test.ts', 'test/package-files.test.ts',
      // Root's managed-apps reader's fail-closed cases and the script's refusals (#665).
      'test/managed-apps.test.ts',
    ],
  },
  { what: 'the release procedure and the design rules', globs: ['docs/releasing.md', 'docs/design.md'] },
  // After the merge policy's own part above (the first part a file matches names it): the rest of the coordinator.
  { what: 'the coordinator', globs: ['src/coordinator/**'] },
  // A study's definition (docs: the experiments design): its eval, editable paths and budget are what a job may touch.
  { what: 'the experiment studies', globs: [`${BRAND.configDir}/experiments.yaml`] },
];

export const LOCKED_CATEGORIES: Record<string, string[]> = {
  [AGENT_INSTRUCTIONS]: [`${BRAND.configDir}/roles/**`, `${BRAND.configDir}/skills/**`, 'AGENTS.md', '**/CLAUDE.md'],
  [SELF_MODIFICATION]: SELF_MODIFICATION_PARTS.flatMap((p) => p.globs),
};

/**
 * Whose repo a change is in, for the locks above (#665). 'engine': the engine's own, where every lock applies. The
 * other value, a managed app's, comes only from root's word on this machine (src/managed-apps.ts readLockScope), never
 * from anything in a repo; there the globs that name the engine's own source tree (ENGINE_TREE) stand aside, and the
 * rest (the config folder's review.yaml, guardrails.yaml and experiments.yaml, CI workflows, the push gate's and
 * secret scan's files, the agents' instructions) still hold: each changes the harness's rules for that repo.
 * INVARIANT: absent, unknown or unreadable is 'engine' (fails closed).
 */
export type LockScope = 'engine' | 'managed-app';

/** The engine's own source tree: a self-modification glob under it names an engine file, not a managed app's. */
const ENGINE_TREE = ['src/', 'scripts/', 'test/', 'docs/'];
/** Whether a locked glob names the engine's own source (so it holds only in the engine's repo). */
export const engineSourceGlob = (glob: string): boolean => ENGINE_TREE.some((d) => glob.startsWith(d));

/** The locked categories in this scope: all of them in the engine's repo; in a managed app's, those that hold in every repo. */
export function lockedCategories(scope: LockScope | undefined): Record<string, string[]> {
  if (scope !== 'managed-app') return LOCKED_CATEGORIES;
  return Object.fromEntries(Object.entries(LOCKED_CATEGORIES).map(([c, globs]) => [c, globs.filter((g) => !engineSourceGlob(g))]));
}

/** Locked categories that are always L3, whatever review.yaml's levels list. */
const ALWAYS_L3 = [SELF_MODIFICATION];

/** What a change to this path changes, in plain words (the self-modification part it falls in, in this scope), or null. */
export function selfModificationPart(path: string, scope?: LockScope): string | null {
  const holds = (g: string) => scope !== 'managed-app' || !engineSourceGlob(g);
  return SELF_MODIFICATION_PARTS.find((p) => p.globs.some((g) => holds(g) && globToRegExp(g).test(path)))?.what ?? null;
}

/** Built-in categories; review.yaml `categories` adds to them or replaces one by name. */

export const DEFAULT_CATEGORIES: Record<string, string[]> = {
  docs: ['**/*.md', 'docs/**', '**/*.txt', 'art/**', 'assets/**'],
  tests: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
  dependency: [
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '**/package.json', '**/package-lock.json',
    '**/pyproject.toml', '**/requirements*.txt', '**/setup.py', '**/setup.cfg', '**/poetry.lock', '**/uv.lock', '**/Pipfile', '**/Pipfile.lock',
    '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum', '**/Gemfile', '**/Gemfile.lock',
  ],
  'ci-config': ['.github/**', '.gitlab-ci.yml', '.circleci/**'],
  'harness-config': [`${BRAND.configDir}/**`, '.claude/**', 'CLAUDE.md'],
  'guardrail-config': [`${BRAND.configDir}/guardrails.yaml`],
  migration: ['**/migrations/**', '**/*.sql', 'prisma/schema.prisma'],
  'deploy-config': ['.github/workflows/**', 'railway.json', 'railway.toml', 'deploy/**', 'Dockerfile', 'fly.toml', 'render.yaml'],
  'release-config': ['scripts/release*', '.github/workflows/release*', '.github/release-signers', 'scripts/verify-release-tag*'],
  secrets: ['.env*', '**/*.pem', '**/*secret*', '**/*credential*'],
  auth: ['**/auth/**', '**/*auth*.*', '**/session*.*', '**/totp*.*'],
  'test-machinery': ['scripts/**', 'test/harness*', 'test/run-*'],
};

export interface ChangeFile {
  path: string;
  added: number;
  removed: number;
  /** Added lines, for content checks (data deletion). */
  addedLines?: string[];
  /** Removed lines, for telling a comment-only change from a code change. */
  removedLines?: string[];
}

export interface LevelInput {
  files: ChangeFile[];
  labels: string[];
  /** Money-path regexes or globs (from money_path_source). */
  moneyPaths: RegExp[];
  verdict?: { patch_correct: boolean; test_correct: boolean; confidence: 'high' | 'medium' | 'low' };
  /** An agent may ask for more review, never less. */
  requested?: Level;
  /**
   * Whose repo this is, for the locked categories (LockScope); undefined: the engine's, every lock applies. A required
   * key (#665): every caller says which scope it means, so a call site can't leave it out by accident.
   */
  scope: LockScope | undefined;
}

export interface LevelResult {
  level: Level;
  reasons: string[];
  categories: Record<string, string[]>;
}

/**
 * Money paths from the project's source of truth. A pattern containing
 * regex literals (/.../) yields those; otherwise each line is a glob.
 */
export function loadMoneyPaths(root: string, src: ReviewConfig['money_path_source']): RegExp[] {
  if (!src) return [];
  let text = readFileSync(join(root, src.file), 'utf8');
  if (src.pattern) {
    const m = text.match(new RegExp(src.pattern));
    if (!m) throw new Error(`money_path_source: pattern not found in ${src.file}`);
    text = m[1] ?? m[0];
  }
  const literals = [...text.matchAll(/\/((?:\\\/|[^/\n])+)\/([gimsuy]*)/g)].map((m) => new RegExp(m[1]!, m[2]!.replace('g', '')));
  if (literals.length) return literals;
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((g) => globToRegExp(g));
}

export function computeLevel(input: LevelInput, cfg: ReviewConfig, extraCategories: Record<string, string[]> = {}): LevelResult {
  const defs = { ...DEFAULT_CATEGORIES, ...cfg.categories, ...extraCategories, ...lockedCategories(input.scope) };
  const res = Object.fromEntries(Object.entries(defs).map(([k, globs]) => [k, globs.map((g) => globToRegExp(g))]));
  const categories: Record<string, string[]> = {};
  const add = (cat: string, path: string) => (categories[cat] ??= []).push(path);

  for (const f of input.files) {
    for (const [cat, list] of Object.entries(res)) if (list.some((re) => re.test(f.path))) add(cat, f.path);
    if (input.moneyPaths.some((re) => re.test(f.path))) add('money-path', f.path);
    if ((f.addedLines ?? []).some((l) => /\b(DROP\s+(TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b/i.test(l))) add('deletes-data', f.path);
  }
  const lines = input.files.reduce((n, f) => n + f.added + f.removed, 0);
  const isDocOrTest = (p: string) => (categories.docs ?? []).includes(p) || (categories.tests ?? []).includes(p);
  const app = input.files.filter((f) => !isDocOrTest(f.path) && !(categories['harness-config'] ?? []).includes(f.path));
  for (const f of app) if (!(categories['money-path'] ?? []).includes(f.path)) add('app-non-money', f.path);
  if (input.labels.includes('ui')) for (const f of app) add('ui', f.path);
  if (input.labels.includes('money-path')) for (const f of input.files) if (!(categories['money-path'] ?? []).includes(f.path)) add('money-path', f.path);

  const L = cfg.levels;
  const reasons: string[] = [];
  let level: Level = 'L0';
  const raise = (to: Level, why: string) => {
    if (ORDER.indexOf(to) > ORDER.indexOf(level)) level = to;
    reasons.push(why);
  };
  const allLow = input.files.length > 0 && input.files.every((f) => isDocOrTest(f.path));
  if (allLow && lines <= (L.L0_auto.max_lines ?? Infinity)) reasons.push(`only docs/tests, ${lines} lines`);
  else raise('L1', allLow ? `docs/tests but ${lines} lines (> ${L.L0_auto.max_lines})` : 'touches app code');
  // A category listed for L1 (e.g. docs, for a site whose docs are its product) always gets the evaluator.
  if (level === 'L0') for (const c of L.L1_evaluator.when) if (categories[c]?.length) raise('L1', `${c}: ${(categories[c] ?? []).slice(0, 3).join(', ')}`);

  const l1Limits = (L.L1_evaluator.max_lines !== undefined && lines > L.L1_evaluator.max_lines) || (L.L1_evaluator.max_files !== undefined && input.files.length > L.L1_evaluator.max_files);
  if (l1Limits && (categories['app-non-money'] ?? []).length) {
    add('app-non-money-large', '*');
    raise('L2', `large app change: ${lines} lines, ${input.files.length} files`);
  }
  for (const c of L.L2_notify.when) if (c !== 'app-non-money-large' && categories[c]?.length) raise('L2', `${c}: ${(categories[c] ?? []).slice(0, 3).join(', ')}`);
  for (const c of L.L3_human.when) if (categories[c]?.length) raise('L3', `${c}: ${(categories[c] ?? []).slice(0, 3).join(', ')}`);
  for (const c of ALWAYS_L3) if (!L.L3_human.when.includes(c) && categories[c]?.length) raise('L3', `${c}: ${(categories[c] ?? []).slice(0, 3).join(', ')}`);
  if (L.L3_human.over_lines !== undefined && lines > L.L3_human.over_lines) raise('L3', `${lines} lines (> ${L.L3_human.over_lines})`);

  if (input.verdict && (!input.verdict.patch_correct || !input.verdict.test_correct || input.verdict.confidence === 'low')) {
    const from = level;
    level = up(level);
    reasons.push(`evaluator ${input.verdict.patch_correct ? '' : 'rejected the patch, '}${input.verdict.test_correct ? '' : 'doubts the test, '}confidence ${input.verdict.confidence}: ${from} -> ${level}`);
  }
  if (input.requested && ORDER.indexOf(input.requested) > ORDER.indexOf(level)) {
    reasons.push(`agent asked for ${input.requested}`);
    level = input.requested;
  }
  return { level, reasons, categories };
}
