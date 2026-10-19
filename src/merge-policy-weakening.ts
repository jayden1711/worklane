// Whether a change removes or weakens a test, a lint or a guard (#783): such a change waits for the owner, whatever
// its review level. The owner's rule is that no agent removes or weakens a check without the owner's OK, and an added
// exception, allowlist entry or skip is a loosening (decision guide, principles 7 and 9). This makes that rule part of
// the merge decision: mergeDecision gets a `design:` reason from what the change itself does, never from the
// evaluator's text.
//
// What it reads: the changed files from the one changed-files helper (src/coordinator/change-files.ts changeFiles),
// and, for the files it checks, their text before and after (filesAt there). What counts, kind by kind:
//   - a test file (TEST_PATHS) in JavaScript or TypeScript, when the change also changes code (anything not a test or
//     docs: the issue's "also touches src/", widened): an assertion (assert*, expect, or a local function that
//     asserts) that is gone or changed, read with where it sits (the enclosing calls and blocks, how many
//     return/break/continue/throw come before it); a test whose title is gone. In a change of tests only, fewer
//     assertions or fewer tests than before (there is no code a loosened test could hide, so a reworded one doesn't
//     wait). Either way: an existing test that now runs differently (.skip, .todo, .only, its options, a skip outside
//     its call), and a deleted test file, unless the change adds the same text as a test file in the same folder;
//   - a test file in any other language, or a test fixture (an expected output), when the change also changes code:
//     any line removed and not put back;
//   - a registered table (CHECK_TABLES): an entry removed from a check's rules, bad fixtures or a guard's list
//     (never-shrink), or added to an allowlist, exception list or good-fixture list (never-grow); a table that is gone;
//   - a guard or lint file (GUARD_FILES): any code line removed and not put back in the same file (a refusal branch
//     removed or made conditional, a fail-closed default changed, a rule taken out all remove a line);
//   - an allowlist file (NEVER_GROW_FILES): any line added;
//   - any file: an inline lint or type-check suppression added.
// When it can't tell (a file it can't read, a table it can't find, a test file it can't parse), it holds.
//
// It is a superset on purpose (fail closed): a change that only tightens or reshapes a guard line still waits. A
// change that only adds tests, rules, fixtures or table entries doesn't, and neither does a rename with the same
// content. The engine's own source paths (ENGINE_ONLY) stand aside in a managed app's repo, as the locks do there
// (src/review.ts lockedCategories).
import { BRAND } from './brand.js';
import { filesAt } from './coordinator/change-files.js';
import { globToRegExp } from './guardrails/glob.js';
import { escapedPath, isNonUtf8Path, shownPath } from './path-text.js';
import { engineSourceGlob, LOCKED_CATEGORIES, lockedCategories, type ChangeFile, type LockScope } from './review.js';

/** never-shrink: an entry removed or changed holds (rules, bad fixtures, guard lists). never-grow: an entry added or changed holds (allowlists, exceptions, good fixtures). */
export type TableKind = 'never-shrink' | 'never-grow';

/** A check's table: a `const` (or, in a .json file, a top-level key) in one file, read entry by entry. */
export interface CheckTable {
  path: string;
  table: string;
  kind: TableKind;
}

/**
 * Every check table the hold reads. A lint test's allowlist (OUTSIDE_THE_HELPER, ALLOWED, REVIEWED, ...) is here
 * however its file is locked: a tests-only change that adds an entry would otherwise be L0. test/merge-policy.test.ts
 * fails on a lint-shaped table in test/ or scripts/ that is neither here nor in NOT_A_CHECK, and on an entry here that
 * no longer names a table.
 */
export const CHECK_TABLES: readonly CheckTable[] = [
  // The lints' allowlists and good fixtures: adding to them is a loosening.
  { path: 'test/change-files-renames.test.ts', table: 'OUTSIDE_THE_HELPER', kind: 'never-grow' },
  { path: 'test/no-clock-helpers.test.ts', table: 'ALLOWED', kind: 'never-grow' },
  { path: 'test/no-wall-clock-durations.test.ts', table: 'ALLOWED', kind: 'never-grow' },
  { path: 'test/instance-name.test.ts', table: 'ALLOWED', kind: 'never-grow' },
  { path: 'test/five-part-issues.test.ts', table: 'GOOD', kind: 'never-grow' },
  { path: 'test/plugin-inspect.test.ts', table: 'GOOD', kind: 'never-grow' },
  { path: 'scripts/setup/app-permissions.mjs', table: 'ALLOWED_UP_TO', kind: 'never-grow' },
  { path: 'test/slot-path.test.ts', table: 'SLOT_SOURCES', kind: 'never-grow' },
  { path: 'test/slot-dir-writes.test.ts', table: 'REVIEWED', kind: 'never-grow' },
  { path: 'test/review.test.ts', table: 'LOCK_SCOPE_GOOD', kind: 'never-grow' },
  { path: 'test/merge-policy.test.ts', table: 'NOT_YET_FILES', kind: 'never-grow' },
  { path: 'test/review-packet.test.ts', table: 'PACKET_ALLOWED', kind: 'never-grow' },
  { path: 'test/owner-terminal-rerun.test.ts', table: 'FIRST_TIME_ONLY', kind: 'never-grow' },
  { path: 'scripts/lib/denylist.mjs', table: 'SKIP', kind: 'never-grow' },
  // The lints' rules and bad fixtures: taking one out is a loosening.
  { path: 'test/change-files-renames.test.ts', table: 'READER_WORDS', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'LOCK_SCOPE_BAD', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_MODULES', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_ENTRIES', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'SLOT_NAMES', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'WRITE_CALLS', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'CHMOD_BY_NAME', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'FD_WRITES', kind: 'never-shrink' },
  { path: 'test/slot-path.test.ts', table: 'MAKER_ONLY', kind: 'never-shrink' },
  { path: 'test/add-project.test.ts', table: 'NAMES_BAD', kind: 'never-shrink' },
  { path: 'test/add-project.test.ts', table: 'REPOS_BAD', kind: 'never-shrink' },
  { path: 'test/instance-name.test.ts', table: 'BAD_SHAPE', kind: 'never-shrink' },
  { path: 'scripts/lib/changelog.mjs', table: 'GUARDRAIL_PATHS', kind: 'never-shrink' },
  // The guards' own tables (their files are guard files too; the table names what was taken out).
  { path: 'src/review.ts', table: 'SELF_MODIFICATION_PARTS', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'LOCKED_CATEGORIES', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'ODD_PATH_CATEGORIES', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'ALWAYS_L3', kind: 'never-shrink' },
  { path: 'src/merge-policy.ts', table: 'FLOOR', kind: 'never-shrink' },
  { path: 'src/hook-imports.ts', table: 'HOOK_IMPORTS', kind: 'never-shrink' },
  { path: 'src/delegation.ts', table: 'NEVER_LOOSEN', kind: 'never-shrink' },
  { path: 'src/guardrails/engine.ts', table: 'BUILTIN_PROTECTED', kind: 'never-shrink' },
  { path: 'src/guardrails/engine.ts', table: 'AGENT_EDITABLE', kind: 'never-grow' },
  { path: 'scripts/push-gate-hook.mjs', table: 'GATE_RULES', kind: 'never-shrink' },
  { path: 'scripts/push-gate-hook.mjs', table: 'GATE_CODE', kind: 'never-shrink' },
  { path: 'scripts/push-gate.mjs', table: 'ATTRIBUTION', kind: 'never-shrink' },
  // The commands that run the checks: a script dropped or changed (a lint taken out of `npm test`) waits.
  { path: 'package.json', table: 'scripts', kind: 'never-shrink' },
  // This hold's own lists.
  { path: 'src/merge-policy-weakening.ts', table: 'CHECK_TABLES', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'GUARD_FILES', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'NEVER_GROW_FILES', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'TEST_PATHS', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'SUPPRESSION', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'NOT_A_CHECK', kind: 'never-grow' },
  { path: 'src/merge-policy-weakening.ts', table: 'LINT_TESTS', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'SIZE_CAP', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'PARSE_BUDGET', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'MAX_DEPTH', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'MAX_KEY', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'WORK_PER_CHAR', kind: 'never-shrink' },
  { path: 'src/merge-policy-weakening.ts', table: 'NOT_A_LINT', kind: 'never-grow' },
];

/**
 * Tables in test/ and scripts/ that look like a check's (checkShapedTables) but hold no check, each with why. Adding one is a loosening (it takes a table out of the registry test), so this list never
 * grows without the owner.
 */
export const NOT_A_CHECK: readonly { path: string; table: string; why: string }[] = [
  { path: 'scripts/rename.mjs', table: 'SKIP', why: 'the files the product-rename tool leaves alone; it checks nothing' },
  { path: 'test/decision-fixture.ts', table: 'OWNER_ONLY', why: 'marker strings a decision card shows only the owner; no rule' },
  { path: 'test/decision-fixture.ts', table: 'WRITERS_ONLY', why: 'marker strings a decision card shows writers; no rule' },
  { path: 'test/loop-control.test.ts', table: 'WORDS', why: 'words a scripted agent writes; no rule' },
];

/**
 * Lint tests whose rules live in their code, not (only) in a registered table: any code line removed from one, outside
 * its registered tables, holds. Every one must read as lint-shaped (lintShaped), which test/merge-policy.test.ts
 * checks. Beyond this list, a removed or changed regex line in any lint-shaped test file holds too.
 */
export const LINT_TESTS: readonly string[] = [
  'test/pipefail.test.ts',
  'test/brand.test.ts',
  'test/testrun-gpu.test.ts',
  'test/boundaries.test.ts',
  'test/web-key-in-url.test.ts',
  'test/self-hosted-guard.test.ts',
  'test/package-deps.test.ts',
  'test/no-clock-helpers.test.ts',
  'test/no-wall-clock-durations.test.ts',
  'test/change-files-renames.test.ts',
  'test/slot-dir-writes.test.ts',
  'test/slot-path.test.ts',
  'test/claude-credential-guard.test.ts',
  'test/download-retry.test.ts',
  'test/owner-terminal-removed.test.ts',
  'test/testrun-measure.test.ts',
  'test/update-helpers.test.ts',
  'test/web-buttons.test.ts',
  'test/superfan.test.ts',
];

/**
 * Whether a test file's text reads as a lint: it walks the repo's own tree (`readdirSync`, `globSync`) from its root
 * into a source folder. A word list, not a proof: a lint that reads one file by name gets past it (register it in
 * LINT_TESTS).
 */
export const lintShaped = (text: string): boolean =>
  /\b(?:readdir|opendir|glob)(?:Sync)?\s*\(|\bwalk\w*\s*\(/.test(text) && /\b(?:repoRoot|repoDir|rootDir)\b|import\.meta\.url|__dirname|process\.cwd\(\)/.test(text) && /['"`/](?:src|scripts|web|test)['"`/]/.test(text);

/**
 * Tests that list `src/` or `scripts/` files but aren't held as lint tests, each with why: a big suite of ordinary
 * tests with one source check among them (that check's regex lines still hold: the file reads as lintShaped), or one
 * locked as a test of the harness controls. test/merge-policy.test.ts fails on a test that lists them and is in
 * neither this list nor LINT_TESTS; adding here takes one out of that test, so this list never grows without the owner.
 */
export const NOT_A_LINT: readonly { path: string; why: string }[] = [
  { path: 'test/avatars.test.ts', why: 'the avatar suite; one test walks web/src (its regex lines hold, lintShaped)' },
  { path: 'test/bench.test.ts', why: 'the bench suite; one test reads scripts/bench for a word (its regex lines hold, lintShaped)' },
  { path: 'test/feature-map.test.ts', why: "the feature map's suite: it lists web/src/pages to match the map, no rule over code" },
  { path: 'test/merge-policy.test.ts', why: 'this hold\'s own tests: fixtures name readdir in strings; locked (the tests of the harness controls)' },
  { path: 'test/package-files.test.ts', why: 'locked (the tests of the harness controls)' },
  { path: 'test/push-check.test.ts', why: 'locked (the tests of the harness controls)' },
  { path: 'test/push-gate-hook.test.ts', why: 'locked (the tests of the harness controls)' },
  { path: 'test/review.test.ts', why: 'locked (the tests of the harness controls); its lock-scope lint tables are registered' },
  { path: 'test/web-render.test.ts', why: 'the web render suite; one test walks web/src (its regex lines hold, lintShaped)' },
];

/** The words in a table's name that say it allows, exempts, skips or rules something. */
const CHECK_TABLE_NAME = /ALLOW|EXEMPT|EXCEPT|SKIP|OUTSIDE|IGNORE|KNOWN|REVIEWED|PERMIT|BASELINE|LEGACY|WAIVE|NOT_YET|ONLY|GOOD|BAD|RULES|WORDS|PATTERNS|DENY|BANNED|FORBIDDEN|NEVER|GUARD/;
const TABLE_DECL = /^(?:export\s+)?(?:const|let)\s+([A-Z][A-Z0-9_]*)\b[^=\n]*=\s*(?:\[|\{|new (?:Set|Map)\()/gm;

/**
 * The tables of a file that look like a check's: a top-level const holding a list, an object, a Set or a Map, whose
 * name says it allows, exempts, skips or rules something. In test/ and scripts/, each must be in CHECK_TABLES or
 * NOT_A_CHECK (test/merge-policy.test.ts). A word list, not a proof: a table named otherwise (`const names = [...]`)
 * gets past it.
 */
export const checkShapedTables = (text: string): string[] => [...text.matchAll(TABLE_DECL)].map((m) => m[1]!).filter((n) => CHECK_TABLE_NAME.test(n));

/**
 * Files whose every removed code line waits: the guards and lints themselves, and their configs. ENGINE_ONLY ones are
 * the engine's own source and stand aside in a managed app's repo.
 */
export const GUARD_FILES: readonly string[] = [
  `${BRAND.configDir}/review.yaml`,
  `${BRAND.configDir}/guardrails.yaml`,
  // The required checks (`required_checks`) and the test-run tiers a land or merge waits on.
  `${BRAND.configDir}/config.yaml`,
  `${BRAND.configDir}/tests.yaml`,
  '.github/workflows/**',
  '.githooks/**',
  '.denylist.json',
  '.gitleaks.toml',
  '.eslintrc*',
  '**/eslint.config.*',
  '**/biome.json*',
  '**/.ruff.toml',
  '**/ruff.toml',
  '**/.flake8',
  '**/.golangci.y*ml',
  '**/tsconfig*.json',
  // What the test runner runs and how much coverage it needs.
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/jest.config.*',
  '**/.mocharc*',
  '**/karma.conf.*',
  '**/playwright.config.*',
  '**/pytest.ini',
  '**/tox.ini',
  '**/conftest.py',
  '**/.nycrc*',
  '**/.c8rc*',
  '**/codecov.y*ml',
  '**/.codecov.y*ml',
  // Git hook managers and other linters' configs.
  '.husky/**',
  '**/.pre-commit-config.y*ml',
  '**/lefthook.y*ml',
  '**/.pylintrc',
  '**/mypy.ini',
  '**/.mypy.ini',
  '**/.stylelintrc*',
  '**/.markdownlint*',
  // Shared CI steps, more test runners and linters, who must review, and the project lints of the PR-gate tier.
  '.github/actions/**',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
  '**/vite.config.*',
  '**/vitest.config.*',
  '**/cypress.config.*',
  '**/.lintstagedrc*',
  '**/lint-staged.config.*',
  '**/.semgrep.y*ml',
  '.semgrep/**',
  '**/.rubocop.yml',
  '**/deno.json*',
  `${BRAND.configDir}/checks/**`,
  // Which test files a PR's CI runs (the engine's).
  'scripts/ci/**',
  'src/merge-policy*',
  'src/coordinator/merge-flow*',
  'src/coordinator/change-files.ts',
  'src/pr-rules*',
  'src/main-watch*',
  'src/push-guard*',
  'src/push-check*',
  'src/review.ts',
  'src/path-text.ts',
  'src/guardrails/**',
  'src/hook*',
  'src/delegation.ts',
  'src/managed-apps.ts',
  'src/sandbox.ts',
  'src/comment-policy.ts',
  'scripts/push-gate*',
  'scripts/check-*',
  'scripts/lib/denylist.mjs',
  'scripts/verify-release-tag*',
  'test/isolate.ts',
];

/** Allowlist files: any line added waits. */
export const NEVER_GROW_FILES: readonly string[] = ['.denylist-allow', '.gitleaksignore', '**/.eslintignore', '**/.semgrepignore'];

/** Test files, whatever the repo's review.yaml calls tests (an own list: narrowing the tests category doesn't narrow this). */
export const TEST_PATHS: readonly string[] = ['test/**', 'tests/**', 'spec/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test_*.py', '**/*_test.py', '**/*_test.go'];

/** Inline marks that turn a lint or type check off for a line or a file. */
/**
 * The most characters of a file the hold reads. Over it, the file holds unread (fail closed): filesAt doesn't even read
 * its blob. Under it, the parse is bounded by steps (WORK_PER_CHAR), nesting (MAX_DEPTH) and key length (MAX_KEY), and
 * a file past any of them holds unread too.
 */
export const SIZE_CAP = 500_000;
/** The most characters the hold parses across one change's test files; past it, the rest hold unread. */
export const PARSE_BUDGET = 2_000_000;

export const SUPPRESSION: readonly string[] = [
  '@ts-ignore', '@ts-expect-error', '@ts-nocheck', 'eslint-disable', 'biome-ignore', 'istanbul ignore', 'c8 ignore', 'v8 ignore',
  'noqa', 'type: ignore', 'pragma: no cover', 'nosec', 'NOLINT', 'gitleaks:allow', 'nolint',
  'pylint: disable', 'mypy: ignore', 'rubocop:disable', 'phpcs:ignore', 'shellcheck disable', 'deno-lint-ignore', '#[allow(',
  '#![allow(', '@SuppressWarnings', 'nosemgrep', 'NOSONAR', 'stylelint-disable', 'tslint:disable', 'oxlint-disable', 'pyright: ignore',
  'yamllint disable', 'hadolint ignore',
];
/** ESLint's inline config that turns a rule off: `/* eslint no-eval: "off" *\/`, `/* eslint eqeqeq: 0 *\/`. */
const ESLINT_OFF = String.raw`\beslint\s+[\w@/-]+\s*:\s*["']?(?:off|0)\b`;

/** Globs that name the engine's own source: they hold only in the engine's repo (as review.ts engineSourceGlob). */
const ENGINE_ONLY = (glob: string) => engineSourceGlob(glob);
/**
 * Whether every glob holds in this scope: review.ts decides which scope is the engine's (its lockedCategories gives
 * back the whole lock there, and an absent or unknown scope is the engine's), so this module never names a scope.
 */
const allHold = (scope: LockScope | undefined) => lockedCategories(scope) === LOCKED_CATEGORIES;
/** Whether a glob or path holds in this scope: everywhere, or only the engine's own source in the engine's repo. */
const holds = (glob: string, scope: LockScope | undefined) => allHold(scope) || !ENGINE_ONLY(glob);

const matcher = (globs: readonly string[], scope: LockScope | undefined) => {
  const res = globs.filter((g) => holds(g, scope)).map((g) => globToRegExp(g));
  return (p: string) => res.some((re) => re.test(p));
};

// ---- Reading JavaScript and TypeScript: the text with every string, regex, template and comment blanked out, so
// brackets match; and which characters were comments, so the text of an entry or assertion leaves them out.

const JS = /\.(?:[cm]?[jt]sx?)$/;
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

interface Scanned {
  src: string;
  /** src with every literal's and comment's characters (newlines kept) as spaces. */
  code: string;
  /** 1 where src is a comment. */
  comment: Uint8Array;
  /** How many regex literals it has. */
  regexes: number;
  /** Its brackets' matches, once found (pairsOf). */
  pairs?: Pairs;
  /** False when a string, template, regex or comment never ends. */
  ok: boolean;
}

function scan(src: string): Scanned {
  const code = src.split('');
  const comment = new Uint8Array(src.length);
  const blank = (i: number) => {
    if (src[i] !== '\n') code[i] = ' ';
  };
  // Each open template `${`: how many braces deep its expression is.
  const templates: number[] = [];
  let i = 0;
  let ok = true;
  let regexes = 0;
  let last = '';
  const template = (): void => {
    // In a template's text, from i (after ` or }): to its end, or into a `${`.
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\\') {
        blank(i);
        blank(i + 1);
        i += 2;
      } else if (c === '`') {
        i++;
        last = '`';
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        templates.push(0);
        last = '{';
        return;
      } else blank(i++);
    }
    ok = false;
  };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        comment[i] = 1;
        blank(i++);
      }
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      if (end === -1) ok = false;
      for (; i < stop; i++) {
        comment[i] = 1;
        blank(i);
      }
    } else if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') blank(i++);
        blank(i++);
      }
      if (src[i] !== c) ok = false;
      i++;
      last = c;
    } else if (c === '`') {
      i++;
      template();
    } else if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || KEYWORD_BEFORE_REGEX.test(src.slice(Math.max(0, i - 12), i).trimEnd()))) {
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n' && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') blank(i++);
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        blank(i++);
      }
      if (src[i] !== '/') ok = false;
      i++;
      while (i < src.length && /[a-z]/.test(src[i]!)) i++;
      last = '/x';
      regexes++;
    } else {
      if (templates.length && c === '{') templates[templates.length - 1]!++;
      else if (templates.length && c === '}') {
        if (templates[templates.length - 1] === 0) {
          templates.pop();
          i++;
          template();
          continue;
        }
        templates[templates.length - 1]!--;
      }
      // TypeScript's postfix `!` (`a[k]! / 3`) leaves what came before it: a `/` after it divides.
      if (!/\s/.test(c)) last = /[\w$]/.test(c) ? 'w' : c === '!' && ['w', ')', ']'].includes(last) ? last : c;
      i++;
    }
  }
  if (templates.length) ok = false;
  return { src, code: code.join(''), comment, regexes, ok };
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Work done parsing, in steps (characters read, brackets jumped): every loop here adds to it. testFacts stops at a
 * budget per file and holds the file unread past it, so no file under SIZE_CAP can keep the merge decision busy.
 */
let work = 0;

/** Each bracket's match, found in one pass per text: the closer of an opener (or -1), and each position's innermost opener. */
interface Pairs {
  close: Int32Array;
  inner: Int32Array;
  maxDepth: number;
}
// Kept on the scanned text itself: keyed by the string, every lookup would compare a long text by its content.
function pairsOf(s: Scanned): Pairs {
  if (s.pairs) return s.pairs;
  const { code } = s;
  const close = new Int32Array(code.length).fill(-1);
  const inner = new Int32Array(code.length + 1).fill(-1);
  const stack: number[] = [];
  let maxDepth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    inner[i] = stack.length ? stack[stack.length - 1]! : -1;
    if (OPEN[c]) {
      stack.push(i);
      if (stack.length > maxDepth) maxDepth = stack.length;
    } else if (c === ')' || c === ']' || c === '}') {
      const o = stack.pop();
      if (o !== undefined && OPEN[code[o]!] === c) close[o] = i;
      else if (o !== undefined) stack.push(o);
    }
  }
  work += code.length;
  return (s.pairs = { close, inner, maxDepth });
}

/** The index of the bracket that closes the one at `at` (in the scanned code), or -1. */
function closeOf(s: Scanned, at: number): number {
  return OPEN[s.code[at] ?? ''] ? pairsOf(s).close[at]! : -1;
}

/** Text compared as it reads: comments out, whitespace collapsed, none around punctuation, no trailing comma. */
function textOf(s: Scanned, from: number, to: number): string {
  work += Math.max(0, to - from);
  let out = '';
  for (let i = from; i < to; i++) if (!s.comment[i]) out += s.src[i];
  return out
    .replace(/\s+/g, ' ')
    .replace(/ ?([()[\]{},;:.=<>!?&|+*/-]) ?/g, '$1')
    .replace(/,([)\]}])/g, '$1')
    .trim();
}

/** Where code at depth 0 next has one of `stops`, from `from` up to `to` (or `to`): a bracketed span is jumped. */
function depthZero(s: Scanned, from: number, to: number, stops: string): number {
  const { code } = s;
  const { close } = pairsOf(s);
  for (let i = from; i < to; i++) {
    work++;
    const c = code[i]!;
    if (OPEN[c]) {
      const j = close[i]!;
      if (j === -1 || j >= to) return to;
      i = j;
    } else if (c === ')' || c === ']' || c === '}') return i;
    else if (stops.includes(c)) return i;
  }
  return to;
}

/** A call's chain after its `)`: `.toBe(1)`, `.not.toThrow()`, `.to.be.true`. Returns where the chain ends. */
function chainEnd(s: Scanned, at: number): number {
  const { code } = s;
  let end = at;
  for (;;) {
    const m = /^\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)+/.exec(code.slice(end, end + 400));
    if (!m) return end;
    const after = end + m[0].length;
    if (code[after] === '(') {
      const close = closeOf(s,after);
      if (close === -1) return -1;
      end = close + 1;
    } else return after;
  }
}

const ASSERT_CALL = /(?<![\w$.])(?:[A-Za-z_$][\w$]*\s*\.\s*)*?(?:assert|expect)(?:[A-Z][\w$]*)?(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/g;
const TITLE_CALL = /(?<![\w$.])(?:(?:t|s|ctx|context)\s*\.\s*)?(?:test|it|describe|suite)\b(?:\s*\.\s*(?:only|skip|todo))?\s*\(/g;
const SKIP_MARK = /(?<![\w$])(?:test|it|describe|suite|context|t|s|ctx)\s*\.\s*(?:skip|todo|only)\b|(?<![\w$.])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|(?<![\w$.])(?:skip|todo|only)\s*:/g;
const EXIT = /(?<![\w$.])(?:return|continue|break|throw)(?![\w$])/g;
/** How many characters of a header, a lead or a first argument go into an assertion's key. */
const HEAD = 400;
/** A skip or todo called in a test's body: `t.skip()`, `t.todo('x')`, `this.skip()`, `context.skip()`. */
const BODY_SKIP = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(?:skip|todo)\s*\(/g;
/** A block or call header that makes what's inside it conditional: an `if`, a loop, a `try`, `&&`, `||`, `?`. */
const CONTROL = /(?<![\w$.])(?:if|else|for|while|do|switch|case|try|catch|finally)(?![\w$])|&&|\|\||\?\?|\?/;

/** Local functions whose body asserts: a call to one counts as an assertion. */
function assertingFunctions(s: Scanned, assertAt: number[]): Set<string> {
  const out = new Set<string>();
  const decl = /(?<![\w$.])(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*\(|\(|[A-Za-z_$][\w$]*\s*=>))/g;
  const { code } = s;
  for (const m of code.matchAll(decl)) {
    work += 8;
    const name = m[1] ?? m[2]!;
    let at = m.index + m[0].length;
    // Past the parameters, then the body: a block, or an arrow's expression up to its statement's end.
    if (code[at - 1] === '(') {
      const close = closeOf(s,at - 1);
      if (close === -1) continue;
      at = close + 1;
    }
    const arrow = /^[^{;]*?=>\s*/.exec(code.slice(at, at + 400));
    if (arrow) at += arrow[0].length;
    const open = arrow && code[at] !== '{' ? -1 : code.indexOf('{', at);
    const end = open === -1 ? depthZero(s,at, code.length, ';,') : closeOf(s,open);
    // Whether an assertion starts inside the body: a binary search of their sorted starts, not a scan of the body.
    if (end !== -1 && firstAtOrAfter(assertAt, at) < assertAt.length && assertAt[firstAtOrAfter(assertAt, at)]! < end) out.add(name);
  }
  return out;
}

/** The index of the first of the sorted `xs` at or after `at`. */
function firstAtOrAfter(xs: readonly number[], at: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface TestFacts {
  /** Each assertion: where it sits and its text. */
  assertions: string[];
  /** Each test: its title, how it runs (its .skip/.only/.todo, its options, what is around it), and where its call is. */
  tests: { title: string; runs: string; from: number; to: number }[];
  /** The line of each skip, todo or only mark outside any test's call (a `t.skip()` in a body, an options const). */
  looseSkips: string[];
  /** Each name an assertion or a test call is made by, and what binds it (`assert` from `node:assert/strict:default`). */
  imports: Map<string, string>;
  /** Each line that declares, assigns or patches one of those names (a shadow, `assert.equal = () => {}`). */
  rebinds: string[];
  /** The rows of each literal table a test loops over (`for (const c of CASES)`), by its name. */
  caseTables: Map<string, string[]>;
  /** How many times the file exits or aborts the process (`process.exit(`, `process.exitCode =`, ...). */
  aborts: number;
  /** The names it declares (`const x`, `function f`), and every word its code uses (strings and comments out). */
  locals: Set<string>;
  words: Set<string>;
  /** Why it couldn't be read, when ok is false. */
  why?: string;
  ok: boolean;
}

/** The deepest bracket nesting a test file may have; past it, it holds unread (no real test is this deep). */
const MAX_DEPTH = 100;
/** The longest a test's or an assertion's context may read, in characters; past it, the file holds unread. */
const MAX_KEY = 8_000;
/** The parse steps a file may take, per character of it plus a floor; past it, the file holds unread. */
const WORK_PER_CHAR = 40;
const WORK_FLOOR = 2_000_000;
/** The names a test call is made by. */
const TEST_NAMES = /^(?:test|it|describe|suite|context|before|after|beforeEach|afterEach|beforeAll|afterAll)$/;

/** Modules whose every import is an assertion; and those (test runners) where only `expect`, `assert` and `should` are. */
const ASSERT_MODULE = /^(?:node:)?assert(?:\/strict)?$|^(?:chai|power-assert|uvu\/assert|should|expect)$/;
const RUNNER_MODULE = /^(?:vitest|@jest\/globals|bun:test|node:test)$/;
const ABORT = /\bprocess\s*\.\s*(?:exit|abort|reallyExit)\s*\(|\bprocess\s*\.\s*exitCode\s*=(?!=)|\bprocess\s*\.\s*kill\s*\(\s*process\s*\.\s*pid/g;

/**
 * The names an assertion is called by besides `assert*` and `expect*` (an alias, a named or destructured import), and
 * the lines that bind them: imports from assertion modules (also `require`), and any line that declares, assigns or
 * patches one of those names or `assert`/`expect` themselves.
 */
function assertionNames(s: Scanned): { roots: Set<string>; imports: Map<string, string>; rebinds: string[] } {
  const { src, code } = s;
  const roots = new Set(['assert', 'expect']);
  // What binds each assertion or test-call name: `module:imported name`. A name added is new, not a change.
  const imports = new Map<string, string>();
  // Imports: read from the source (a specifier is a string), only where the statement itself is code.
  for (const m of src.matchAll(/(?<![\w$.])import\s+(?!type\b)([^'";]+?)\s+from\s*(['"])([^'"\n]+)\2|(?<![\w$.])(?:const|let|var)\s+([^=;]+?)\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\5\s*\)/g)) {
    work += m[0].length;
    if (code[m.index] !== src[m.index] || s.comment[m.index]) continue;
    const spec = m[3] ?? m[6]!;
    const clause = (m[1] ?? m[4]!).trim();
    const all = ASSERT_MODULE.test(spec);
    const runner = RUNNER_MODULE.test(spec);
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of (named?.[1] ?? '').split(',')) {
      const p = /^\s*(?:type\s+)?([\w$]+)(?:\s*(?:as|:)\s*([\w$]+))?\s*$/.exec(part);
      if (!p) continue;
      const local = p[2] ?? p[1]!;
      // A test-call name from any module (`import { skip as test } from 'node:test'`, or a swap to a local no-op).
      if (TEST_NAMES.test(local) || all || (runner && /^(?:expect|assert|should)$/.test(p[1]!))) imports.set(local, `${spec}:${p[1]}`);
      if (all || (runner && /^(?:expect|assert|should)$/.test(p[1]!))) roots.add(local);
    }
    const plain = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+/, '').split(',').map((x) => x.trim()).filter((x) => /^[\w$]+$/.test(x));
    for (const n of plain) {
      if (all) roots.add(n);
      if (all || TEST_NAMES.test(n)) imports.set(n, `${spec}:default`);
    }
  }
  // Destructured from an assertion: `const { equal, ok: isOk } = assert`.
  const rootRe = () => [...roots].map((r) => r.replace(/\$/g, '\\$')).join('|');
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(${rootRe()})(?![\\w$])`, 'g'))) {
    for (const part of m[1]!.split(',')) {
      const p = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(part);
      if (!p) continue;
      roots.add(p[2] ?? p[1]!);
      imports.set(p[2] ?? p[1]!, `${m[2]}.${p[1]}`);
    }
  }
  // Any line that declares, assigns or patches one of them or a test-call name: a shadow (`const assert = ...`,
  // `function test() {}`), `assert.equal = () => {}`.
  // (A loop's variable, `for (const it of list)`, shadows nothing a test is made by outside the loop.)
  const names = `${rootRe()}|test|it|describe|suite`;
  const rebindRe = new RegExp(
    `(?<![\\w$.])(?<!for\\s*\\(\\s*)(?:const|let|var|function|class)\\s+(?:${names})(?![\\w$])|(?<![\\w$.])(?:${names})(?:\\s*\\.\\s*[\\w$]+)*\\s*=(?![=>])|\\b(?:Object\\s*\\.\\s*(?:assign|defineProperty|setPrototypeOf)|mock\\s*\\.\\s*method|vi\\s*\\.\\s*spyOn|jest\\s*\\.\\s*spyOn|sinon\\s*\\.\\s*(?:stub|replace))\\s*\\(\\s*(?:${names})(?![\\w$])`,
    'g',
  );
  const rebinds = [...code.matchAll(rebindRe)].map((m) => lineAt(src, m.index));
  work += code.length;
  return { roots, imports, rebinds };
}

/** The line of `src` that `at` is on, trimmed. */
const lineAt = (src: string, at: number) => src.slice(src.lastIndexOf('\n', at - 1) + 1, (src.indexOf('\n', at) + 1 || src.length + 1) - 1).trim();

/** The assertions, tests and skip marks of a JavaScript or TypeScript test file. */
export function testFacts(text: string, tableNames: ReadonlySet<string> = new Set()): TestFacts {
  const facts: TestFacts = { assertions: [], tests: [], looseSkips: [], imports: new Map(), rebinds: [], caseTables: new Map(), aborts: 0, locals: new Set(), words: new Set(), ok: true };
  const fail = (why: string): TestFacts => ({ ...facts, ok: false, why });
  // Every step counts against this file's budget: past it, the file holds unread (a crafted file can't stall this).
  const started = work;
  const budget = WORK_FLOOR + WORK_PER_CHAR * text.length;
  const over = () => work - started > budget;
  const s = scan(text);
  work += text.length;
  if (!s.ok) return fail('a string, template, regex or comment never ends');
  const { code } = s;
  const { close, inner, maxDepth } = pairsOf(s);
  if (maxDepth > MAX_DEPTH) return fail(`brackets nest ${maxDepth} deep, over ${MAX_DEPTH}`);
  const { roots, imports, rebinds } = assertionNames(s);
  facts.imports = imports;
  facts.rebinds = rebinds;
  facts.aborts = [...code.matchAll(ABORT)].length;
  facts.words = new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? []);
  facts.locals = new Set([...code.matchAll(/(?<![\w$.])(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));
  work += code.length * 2;

  // The names the file declares (`const X = ...`), and what each holds (read once per declaration, bounded): an
  // assertion carries the literal value of each const it names (`const EXPECTED = 2` changed changes it); how a test
  // runs carries the value of each const its options or the code around it name (`{ skip: SKIP_SLOW }`). Which
  // declaration a name means is scoped: the last before the use inside the same top-level statement, else the file's
  // top-level one; never another test's.
  const declarations = new Map<string, number[]>();
  const topLevel = new Map<string, number>();
  for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=/g)) {
    (declarations.get(m[1]!) ?? declarations.set(m[1]!, []).get(m[1]!)!).push(m.index);
    if (inner[m.index] === -1 && !topLevel.has(m[1]!)) topLevel.set(m[1]!, m.index);
  }
  const outermost = (at: number) => {
    let t = inner[at]!;
    while (t !== -1 && inner[t]! !== -1) t = inner[t]!;
    return t;
  };
  const declFor = (name: string, at: number, top: number): number | undefined => {
    const all = declarations.get(name);
    if (!all) return undefined;
    const k = firstAtOrAfter(all, at) - 1;
    return k >= 0 && all[k]! > top ? all[k] : topLevel.get(name);
  };
  const values = new Map<number, string>();
  const valueOf = (decl: number) => {
    let v = values.get(decl);
    if (v === undefined) {
      const span = spanFrom(s, decl);
      values.set(decl, (v = span ? textOf(s, span[0], Math.min(span[1], span[0] + HEAD)) : ''));
    }
    return v;
  };
  const literal = (v: string) => /^(?:[[{'"`/\d]|-\d|true\b|false\b|null\b|undefined\b|new (?:Set|Map)\()/.test(v);
  const collection = (v: string) => /^(?:[[{]|new (?:Set|Map)\()/.test(v);
  const uses = (t: string, at: number, top: number, onlyLiterals: boolean) => {
    work += t.length;
    const out: string[] = [];
    for (const n of new Set(t.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [])) {
      // A registered check table is the table rule's to judge (an allowlist entry taken out is a tightening).
      if (roots.has(n) || tableNames.has(n)) continue;
      const d = declFor(n, at, top);
      if (d === undefined) continue;
      const v = valueOf(d);
      if (v && (!onlyLiterals || literal(v))) out.push(`${n}=${v}`);
    }
    return out.length ? ` | uses ${out.join(' ')}` : '';
  };

  // Each test call: its title, how it runs on its own (its .skip/.only/.todo; every argument after the title that isn't
  // its function, with the value of each const named there; a generator body, which never runs), and where it is.
  const calls = new Map<number, { start: number; end: number; title: string; own: string }>();
  const headers: number[][] = [];
  for (const m of code.matchAll(TITLE_CALL)) {
    if (over()) return fail('too much to read');
    const open = m.index + m[0].length - 1;
    const end = close[open]!;
    if (end === -1) return fail('a test call never closes');
    const top = outermost(m.index);
    const args: string[] = [];
    let fnAt = end;
    for (let at = open + 1; at < end; ) {
      const e = depthZero(s,at, end, ',');
      if (/=>|^\s*(?:async\s+)?function\b/.test(code.slice(at, Math.min(e, at + 300)))) {
        fnAt = at;
        break;
      }
      const arg = textOf(s, at, Math.min(e, at + HEAD * 4));
      args.push(args.length ? `${arg}${uses(arg, m.index, top, false)}` : arg);
      at = e + 1;
    }
    const mods = /\.\s*(only|skip|todo)\b/.exec(m[0])?.[1] ?? '';
    const generator = /^\s*(?:async\s+)?function\s*\*/.test(code.slice(fnAt, fnAt + 60)) ? 'generator' : '';
    calls.set(open, { start: m.index, end, title: args[0] ?? '', own: [mods, ...args.slice(1), generator].filter(Boolean).join(' ') });
    headers.push([m.index, fnAt]);
  }
  // A skip or todo called in a test's own body (`t.skip()`, `this.skip()`), counted for the innermost test call around
  // it: a new test with a skip of its own changes no other test.
  const bodySkips = new Map<number, number>();
  for (const m of code.matchAll(BODY_SKIP)) {
    if (TEST_NAMES.test(m[1]!)) continue;
    let t = inner[m.index]!;
    while (t !== -1 && !calls.has(t)) t = inner[t]!;
    if (t !== -1) bodySkips.set(t, (bodySkips.get(t) ?? 0) + 1);
  }
  const ownRuns = (open: number) => {
    const c = calls.get(open)!;
    const n = bodySkips.get(open);
    return [c.own, n ? `body skips ${n}` : ''].filter(Boolean).join(' ');
  };
  // A skip, todo or only outside any test call's head (an options const, a `t.skip()` in a body); a `skip:` key counts
  // only in an object (`{ skip: ... }`), not as a parameter's type (`(only: number)`).
  const headStarts = headers.map((h) => h[0]!);
  for (const m of code.matchAll(SKIP_MARK)) {
    const k = firstAtOrAfter(headStarts, m.index + 1) - 1;
    const inHead = k >= 0 && m.index < headers[k]![1]!;
    if (!inHead && (!m[0].endsWith(':') || code[inner[m.index]!] === '{')) facts.looseSkips.push(lineAt(text, m.index));
  }

  // Assertion starts: assert*/expect calls, calls by another name an assertion module gave, and calls to a local
  // function that asserts.
  const aliases = [...roots].filter((r) => r !== 'assert' && r !== 'expect').map((h) => h.replace(/\$/g, '\\$'));
  const anyAssert = new RegExp(aliases.length ? `${ASSERT_CALL.source}|(?<![\\w$.])(?:${aliases.join('|')})(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*\\s*\\(` : ASSERT_CALL.source, 'g');
  const starts: number[] = [...code.matchAll(anyAssert)].map((m) => m.index);
  const helpers = assertingFunctions(s, starts);
  if (helpers.size) {
    for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (helpers.has(m[1]!) && !/(?:function\s*\*?|const|let|var)\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) starts.push(m.index);
    }
    starts.sort((a, b) => a - b);
  }
  work += code.length * 4;
  if (over()) return fail('too much to read');

  // Where each return/break/continue/throw is, to count those before a position by binary search.
  const exitAt = [...code.matchAll(EXIT)].map((m) => m.index);
  // One pass. Each open bracket's context is built once, from its parent's: where (the headers and first arguments
  // around an assertion) and ctx (what is around a test call: every header, with the value of each const named there;
  // a test call around it as a mark filled in at the end with how that test runs). A case table a header names is
  // kept as its rows (facts.caseTables), so a row added changes nothing and a row gone or changed holds.
  interface Open {
    at: number;
    seg: number;
    parent: Open | undefined;
    header?: string;
    where?: string;
    ctx?: string;
  }
  const headerOf = (b: Open) => (b.header ??= textOf(s, Math.max(b.seg, b.at - HEAD), b.at).slice(-200));
  const firstArg = (b: Open) => textOf(s, b.at + 1, Math.min(depthZero(s,b.at + 1, close[b.at]! === -1 ? code.length : close[b.at]!, ','), b.at + 1 + HEAD));
  const whereOf = (b: Open): string => {
    if (b.where === undefined) {
      // A test call around it, and that test's own function, aren't part of it: its title, .skip/.only/.todo, a
      // generator body and a describe around it are how the test runs (the test's own reason), and a renamed or
      // regrouped test changes no assertion.
      const testLevel = calls.has(b.at) || (code[b.at] === '{' && b.parent !== undefined && calls.has(b.parent.at));
      const piece = testLevel ? '' : code[b.at] === '(' ? `${headerOf(b)}(${firstArg(b)}` : `${headerOf(b)}${code[b.at]}`;
      const up = b.parent ? whereOf(b.parent) : '';
      b.where = piece ? (up ? `${up} > ${piece}` : piece) : up;
    }
    return b.where;
  };
  const ctxOf = (b: Open): string => {
    if (b.ctx === undefined) {
      let piece: string;
      if (calls.has(b.at)) piece = `\u0001${b.at}\u0001`;
      else {
        const h = headerOf(b);
        const top = outermost(b.at);
        const named: string[] = [];
        for (const n of new Set(h.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [])) {
          const d = declFor(n, b.at, top);
          if (d === undefined) continue;
          const v = valueOf(d);
          if (!collection(v)) {
            if (v) named.push(`${n}=${v}`);
          } else if (!facts.caseTables.has(n)) {
            // Its rows: the literal's top-level elements, each whole (`[2, 4]` to `[4, 2]` is a row changed).
            const span = spanFrom(s, d);
            const rows: string[] = [];
            const lit = span ? span[0] + (/^new (?:Set|Map)\(\s*/.exec(code.slice(span[0], span[0] + 20))?.[0].length ?? 0) : -1;
            if (span && (code[lit] === '[' || code[lit] === '{') && close[lit]! !== -1) {
              for (let at = lit + 1; at < close[lit]!; ) {
                const e = depthZero(s, at, close[lit]!, ',');
                const row = textOf(s, at, Math.min(e, at + HEAD));
                if (row) rows.push(row);
                at = e + 1;
              }
            }
            facts.caseTables.set(n, rows);
          }
        }
        piece = `${h}${code[b.at]}${named.length ? ` | uses ${named.join(' ')}` : ''}`;
      }
      b.ctx = b.parent ? `${ctxOf(b.parent)} > ${piece}` : piece;
    }
    return b.ctx;
  };
  const raw: { open: number; title: string; ctx: string; lead: string }[] = [];
  let top: Open | undefined;
  let seg = 0;
  let next = 0;
  let coveredTo = -1;
  for (let i = 0; i < code.length; i++) {
    if ((i & 4095) === 0 && over()) return fail('too much to read');
    const call = calls.get(i);
    if (call) {
      const ctx = top ? ctxOf(top) : '';
      if (ctx.length > MAX_KEY) return fail(`a test's context is over ${MAX_KEY} characters`);
      raw.push({ open: i, title: call.title, ctx, lead: textOf(s, Math.max(seg, call.start - HEAD), call.start) });
    }
    while (next < starts.length && starts[next] === i) {
      next++;
      if (i < coveredTo) continue;
      const open = code.indexOf('(', i);
      const end = closeOf(s,open) === -1 ? -1 : chainEnd(s,closeOf(s,open) + 1);
      if (end === -1) return fail('an assertion never closes');
      coveredTo = end;
      const where = top ? whereOf(top) : '';
      if (where.length > MAX_KEY) return fail(`an assertion's context is over ${MAX_KEY} characters`);
      let outer = top;
      while (outer?.parent) outer = outer.parent;
      const exits = firstAtOrAfter(exitAt, i) - firstAtOrAfter(exitAt, outer?.at ?? 0);
      // What leads into it within its own statement: `await`, `void`, `if (x)`, `x &&`, `const later = () =>`.
      const lead = textOf(s, Math.max(seg, i - HEAD), i).slice(-200);
      const body = textOf(s, i, end);
      facts.assertions.push(`${where} | exits ${exits} | ${lead ? `${lead} ` : ''}${body}${uses(body, i, outer?.at ?? -1, true)}`);
    }
    const c = code[i]!;
    if (OPEN[c]) {
      top = { at: i, seg, parent: top };
      seg = i + 1;
    } else if (c === ')' || c === ']' || c === '}') {
      if (!top) return fail('a bracket closes that never opened');
      seg = c === '}' ? i + 1 : top.seg;
      top = top.parent;
    } else if (c === ',' || c === ';') seg = i + 1;
  }
  work += code.length;
  // How each test runs: what is around it (each test call around it filled in with how that one runs on its own),
  // what leads into it (`x && test(...)`), and how it runs on its own.
  for (const r of raw) {
    const around = r.ctx.replace(/\u0001(\d+)\u0001/g, (_, n: string) => ownRuns(Number(n)));
    const runs = [around, r.lead ? `lead ${r.lead}` : '', ownRuns(r.open)].filter(Boolean).join(' > ');
    if (runs.length > MAX_KEY * 2) return fail(`a test's context is over ${MAX_KEY} characters`);
    const c = calls.get(r.open)!;
    facts.tests.push({ title: r.title, runs, from: c.start, to: c.end + 1 });
  }
  return over() ? fail('too much to read') : facts;
}

/** The parse steps testFacts takes on a text (for the budget's tests). */
export function testFactsWork(text: string): { work: number; ok: boolean; why?: string } {
  const before = work;
  const f = testFacts(text);
  return { work: work - before, ok: f.ok, ...(f.why ? { why: f.why } : {}) };
}

// ---- Tables: a `const NAME = <literal>` read as its leaf entries (an object's entries keyed by their path).

/** The text of `const NAME ... = <value>` up to its end, as [from, to) in s, or null when there is none. */
function tableSpan(s: Scanned, name: string): [number, number] | null {
  const m = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}(?![\\w$])`).exec(s.code);
  return m ? spanFrom(s, m.index) : null;
}

/** The value of the declaration (`const NAME ... =`) that starts at `at`, as tableSpan reads it. */
function spanFrom(s: Scanned, at: number): [number, number] | null {
  const m = /^(?:const|let|var)\s+[A-Za-z_$][\w$]*/.exec(s.code.slice(at, at + 300));
  if (!m) return null;
  // The `=` at depth 0 after the name (a type annotation's brackets and `=>` skipped).
  let depth = 0;
  let i = at + m[0].length;
  for (; i < s.code.length; i++) {
    const c = s.code[i]!;
    if (OPEN[c] || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && s.code[i - 1] !== '=')) depth--;
    else if (c === '=' && depth === 0 && s.code[i + 1] !== '>' && s.code[i + 1] !== '=') break;
    else if (c === ';' && depth === 0) return null;
  }
  if (i >= s.code.length) return null;
  // A literal ends at its closing bracket (with any `as const` after it); anything else at the statement's end.
  let start = i + 1;
  while (start < s.code.length && /\s/.test(s.code[start]!)) start++;
  const close = s.code[start] === '[' || s.code[start] === '{' ? closeOf(s,start) : -1;
  if (close === -1) return [start, depthZero(s,start, s.code.length, ';')];
  const tail = /^\s*(?:as\s+const|satisfies\s+[\w$.<>[\], ]+)?/.exec(s.code.slice(close + 1, close + 200))!;
  // The literal goes on into a call or an operator (`[...].slice(1)`, `[...].filter(f)`, `[...] || []`): the whole
  // statement is the value, one entry, so changing what follows the literal changes the table.
  if (/^\s*(?:[.[(?|&+*/%-])/.test(s.code.slice(close + 1 + tail[0].length, close + 220))) return [start, depthZero(s,start, s.code.length, ';')];
  return [start, close + 1 + tail[0].length];
}

/** The leaf entries of the value in [from, to): array elements, object entries keyed by their path, or itself. */
function leaves(s: Scanned, from: number, to: number, prefix: string, out: string[], depth = 0): void {
  const { code } = s;
  while (from < to && /\s/.test(code[from]!)) from++;
  while (to > from && /\s/.test(code[to - 1]!)) to--;
  // `as const`, `satisfies T`: the value is what comes before.
  const tail = /\s+(?:as\s+const|satisfies\s+[\w$.<>[\], ]+)$/.exec(code.slice(from, to));
  if (tail) to -= tail[0].length;
  // A wrapper around one literal: new Set([...]), new Map([...]), Object.freeze({...}).
  const wrap = /^(?:new\s+)?[\w$.]+\s*(?:<[^()]*>)?\s*\(/.exec(code.slice(from, to));
  if (wrap && closeOf(s,from + wrap[0].length - 1) === to - 1) {
    let inner = from + wrap[0].length;
    while (inner < to && /\s/.test(code[inner]!)) inner++;
    const innerEnd = code[inner] === '[' || code[inner] === '{' ? closeOf(s,inner) : -1;
    if (innerEnd !== -1 && !code.slice(innerEnd + 1, to - 1).trim()) return leaves(s, inner, innerEnd + 1, prefix, out, depth);
  }
  const first = code[from];
  if ((first === '[' || first === '{') && closeOf(s,from) === to - 1) {
    for (let at = from + 1; at < to - 1; ) {
      const end = depthZero(s,at, to - 1, ',');
      if (code.slice(at, end).trim()) {
        if (first === '[') leaves(s, at, end, prefix, out, depth);
        else {
          const colon = depthZero(s,at, end, ':');
          if (colon < end && !code.slice(at, colon).trim().startsWith('...')) leaves(s, colon + 1, end, `${prefix}${textOf(s, at, colon)}.`, out, depth);
          else leaves(s, at, end, prefix, out, depth);
        }
      }
      at = end + 1;
    }
    return;
  }
  const text = textOf(s, from, to);
  // A spread or a name of another const in the same file (`...MORE`, `[MAKER, ...]`): its entries, so one can't be
  // added out of the table's sight. Four levels at most (a const can't name itself forever).
  const ref = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)$/.exec(text);
  const span = ref && depth < 4 ? tableSpan(s, ref[1]!) : null;
  if (span) return leaves(s, span[0], span[1], prefix, out, depth + 1);
  if (text) out.push(`${prefix}${text}`);
}

/** The trimmed lines of a file's registered tables, from each one's `const` to its end. */
function tableLines(path: string, text: string | null, tables: readonly CheckTable[]): Set<string> {
  const out = new Set<string>();
  if (text === null) return out;
  const s = scan(text);
  for (const t of tables.filter((x) => x.path === path)) {
    const span = s.ok ? tableSpan(s, t.table) : null;
    if (!span) continue;
    const from = text.lastIndexOf('\n', s.code.lastIndexOf(t.table, span[0])) + 1;
    for (const l of text.slice(from, span[1]).split('\n')) out.add(l.trim());
  }
  return out;
}

/** A table's leaf entries in a file's text, or null when the table isn't there (or can't be read). */
export function tableEntries(path: string, text: string, table: string): string[] | null {
  if (path.endsWith('.json')) {
    let value: unknown;
    try {
      value = (JSON.parse(text) as Record<string, unknown>)[table];
    } catch {
      return null;
    }
    if (value === undefined) return null;
    const out: string[] = [];
    const walk = (v: unknown, prefix: string) => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? prefix : `${prefix}${k}.`);
      else out.push(`${prefix}${JSON.stringify(v)}`);
    };
    walk(value, '');
    return out;
  }
  const s = scan(text);
  if (!s.ok) return null;
  const span = tableSpan(s, table);
  if (!span) return null;
  const out: string[] = [];
  leaves(s, span[0], span[1], '', out);
  return out;
}

// ---- The hold.

export interface WeakeningInput {
  files: ChangeFile[];
  /** A file's text before the change, or null when it wasn't there. */
  before: (path: string) => string | null;
  /** A file's text after the change, or null when it isn't there. */
  after: (path: string) => string | null;
  scope: LockScope | undefined;
}

/** Each kind of weakening, in the words a reason uses, in the order reasons are given. */
const KINDS = {
  unreadable: "can't read a file to check it, so it may weaken a check",
  'test-file-deleted': 'deletes a test file',
  'test-removed': 'removes or renames a test',
  'test-assertion': 'removes or changes a test assertion',
  'test-skip': 'adds a skip, todo or only to a test, or changes how an existing test runs',
  'test-binding': "changes what an existing test file's assertions call: an assert import, or a name that shadows or patches one",
  'test-abort': 'makes an existing test file exit or abort the process',
  'test-lines': 'removes or changes lines of a test or its expected output',
  'table-gone': "removes or renames a check's or guard's table",
  'table-shrunk': "removes or changes an entry in a check's rules or a guard's list",
  'table-grown': 'adds or changes an entry in an allowlist, exception or good-fixture list',
  'table-touched': "narrows, changes or declares again a check's or guard's table where it is used",
  'allow-file': 'adds an entry to an allowlist file',
  'guard-lines': 'removes or changes code in a guard or lint',
  suppression: 'adds an inline lint or type-check suppression',
} as const;

type Kind = keyof typeof KINDS;

/** The reasons' common start: each is a design-level hold. */
export const WEAKENING_REASON = 'design: may weaken a check: ';

const multiset = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
/** What `a` has that `b` hasn't (as multisets). */
const missing = (a: string[], b: string[]): string[] => {
  const left = multiset(b);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
};

/** A code line, trimmed: not blank, not only a comment, with a word in it. */
const codeLine = (l: string) => {
  const t = l.trim();
  return /\w/.test(t) && !/^(?:\/\/|\/\*|\*|#|<!--)/.test(t) ? [t] : [];
};

// Each mark as a whole word where it starts or ends with one (`nosec`, never the start of `noseccomp`).
const MARK = new RegExp(`${SUPPRESSION.map((m) => `${/^\w/.test(m) ? '\\b' : ''}${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${/\w$/.test(m) ? '\\b' : ''}`).join('|')}|${ESLINT_OFF}`, 'g');
/**
 * The suppression marks of one added or removed line. In JavaScript or TypeScript, anywhere but inside a string (a
 * lint's own test fixture names them in strings): a comment, or a bare line inside a block comment that started on an
 * earlier line. In any other language, anywhere (an annotation like `@SuppressWarnings` is no comment).
 */
function marksIn(path: string, line: string): string[] {
  if (JS.test(path)) {
    const s = scan(line);
    const inString = (at: number) => s.code[at] !== s.src[at] && s.comment[at] !== 1;
    return [...line.matchAll(MARK)].filter((m) => !inString(m.index)).map(() => line.trim());
  }
  return new RegExp(MARK.source).test(line) ? [line.trim()] : [];
}
const isRunnerTest = (p: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes('__tests__/');
const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
/** A test file's name from its first `.test.`/`.spec.` on (`.test.ts`), or its extension: what a runner selects it by. */
const runnerSuffix = (p: string) => /(\.(?:test|spec)\..*|\.[^./]*)$/.exec(p.slice(p.lastIndexOf('/') + 1))?.[1] ?? '';
const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\S/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** Names an assertion is made of: never a rename (`equal` to `ok` changes what it checks). */
const ASSERT_WORD = /^(?:assert\w*|expect\w*|should|ok|equal|notEqual|deepEqual|notDeepEqual|strictEqual|notStrictEqual|deepStrictEqual|notDeepStrictEqual|match|doesNotMatch|throws|doesNotThrow|rejects|doesNotReject|fail|ifError|to|not|be|includes?|contains?|equals?|true|false|null|undefined|NaN|Infinity|await|void|return|if|else|try|catch|finally|for|while|do|switch|case|typeof|instanceof|new|delete|in|of|async|function|const|let|var)$/;

/** A matcher by family (`.toBe`, `.isTrue`, `.hasProperty`): an assertion's name only after a `.`, so `total` and `isSum` can be renamed. */
const MATCHER = /^(?:to|is|has)[A-Z]\w*$/;

/** The identifier renames code made: names gone from its removed lines paired with names new in its added lines. */
function codeRenames(files: ChangeFile[]): { gone: Set<string>; came: Set<string> } {
  // Code tokens only: a word in a comment or a string is no rename (`// wanted` to `// got`).
  const ids = (ls: string[] | undefined) => new Set((ls ?? []).flatMap((l) => scan(l).code.match(TOKEN) ?? []).filter((t) => IDENT.test(t)));
  const removed = new Set(files.flatMap((f) => [...ids(f.removedLines)]));
  const added = new Set(files.flatMap((f) => [...ids(f.addedLines)]));
  return { gone: new Set([...removed].filter((x) => !added.has(x))), came: new Set([...added].filter((x) => !removed.has(x))) };
}

/**
 * Whether assertion `b` is assertion `a` with only identifiers renamed, each one a rename the code made (its old name
 * gone from the code, its new one new there), the same old name always to the same new one, and never an assertion's
 * own name. Literals, punctuation and shape are the same.
 */
function renamedOnly(a: string, b: string, r: { gone: Set<string>; came: Set<string> }, stillUsed: (name: string) => boolean): boolean {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  if (ta.length !== tb.length || !r.gone.size) return false;
  // Never a name the old assertion already had (`equal(got, wanted)` to `equal(got, got)`), nor one the test still
  // uses after the change (a real rename leaves no old name behind).
  const before = new Set(ta);
  for (let k = 0; k < ta.length; k++) if (ta[k] !== tb[k] && (before.has(tb[k]!) || stillUsed(ta[k]!))) return false;
  const map = new Map<string, string>();
  let renamed = false;
  for (let k = 0; k < ta.length; k++) {
    const [x, y] = [ta[k]!, tb[k]!];
    if (x === y) continue;
    const member = ta[k - 1] === '.' || tb[k - 1] === '.';
    if (!IDENT.test(x) || !IDENT.test(y) || ASSERT_WORD.test(x) || ASSERT_WORD.test(y) || (member && (MATCHER.test(x) || MATCHER.test(y))) || !r.gone.has(x) || !r.came.has(y)) return false;
    if ((map.get(x) ?? y) !== y) return false;
    map.set(x, y);
    renamed = true;
  }
  return renamed;
}

/** A line added to a guard that can skip or switch something off. */
const BYPASS = /\b(?:return|break|continue|catch|exit|skip|ignore|allow|allowed|disable|disabled|off|false|warn|none|optional)\b|process\.env|\|\||&&|\?\?/;
/**
 * A line added to a lint test that can let a file or a finding through: control flow and filtering only (a value word
 * like `false` or `none` is a lint test's fixture data, not a switch).
 */
const LINT_BYPASS = /(?<![\w$.])(?:return|break|continue|if|skip|ignore|exclude|filter|splice|delete)(?![\w$])|process\.env|\|\||&&|\?\?/;
/** Docs: neither code nor a test. */
const isDoc = (p: string) => /\.(?:md|txt)$/i.test(p) || p.startsWith('docs/');

/**
 * Why a change may weaken a test, lint or guard: one `design:` reason per kind, naming up to three places. Empty: it
 * removes or loosens none of them. Pure: the caller reads the files (weakeningOf).
 */
export function weakeningReasons(i: WeakeningInput): string[] {
  const found = new Map<Kind, string[]>();
  const hit = (kind: Kind, path: string, what?: string) => (found.get(kind) ?? found.set(kind, []).get(kind)!).push(what === undefined ? shownPath(path) : `${shownPath(path)}: ${escapedPath(what.length > 100 ? `${what.slice(0, 100)}...` : what)}`);
  // Tests are tests in every repo: TEST_PATHS isn't the engine's own source.
  const isTest = matcher(TEST_PATHS, undefined);
  const isGuard = matcher(GUARD_FILES, i.scope);
  // Whether the change also changes code (not only tests and docs): then a changed assertion holds too, not only a
  // lost one (the issue's "when the PR also touches src/", widened to any code: a fixture, a config, a script).
  const codeChanged = i.files.some((f) => !isTest(f.path) && !isDoc(f.path));
  // Whether a changed (not only a lost) assertion holds. Owner's decision (2026-10-19): in every change, tests-only ones
  // too, since changing an existing assertion's expected value or matcher is how a regression gets hidden. An added
  // assertion and a pure rename don't wait (renamedOnly). A test's title changed still holds only with code changed.
  const changedHolds = true;
  const isAllowFile = matcher(NEVER_GROW_FILES, i.scope);
  const tables = CHECK_TABLES.filter((t) => holds(t.path, i.scope));
  // A file over SIZE_CAP isn't read (filesAt skips its blob), nor parsed: it holds as unread.
  const read = (side: 'before' | 'after', path: string): string | null | undefined => {
    try {
      const text = i[side](path);
      if (text !== null && text.length > SIZE_CAP) {
        hit('unreadable', path, `over ${SIZE_CAP} characters: not read`);
        return undefined;
      }
      return text;
    } catch (e) {
      hit('unreadable', path, String((e as Error).message ?? e).slice(0, 100));
      return undefined;
    }
  };
  // Each test file's facts, parsed once, within one budget for the whole change: past PARSE_BUDGET characters, the
  // rest hold unread, so a change of many big test files can't keep the merge decision busy.
  let parsed = 0;
  const factsCache = new Map<string, TestFacts | null | undefined>();
  const factsOf = (side: 'before' | 'after', path: string): TestFacts | null | undefined => {
    const k = `${side}\u0000${path}`;
    if (factsCache.has(k)) return factsCache.get(k);
    const text = read(side, path);
    let out: TestFacts | null | undefined = text === undefined ? undefined : text === null ? null : undefined;
    if (typeof text === 'string') {
      parsed += text.length;
      if (parsed > PARSE_BUDGET) hit('unreadable', path, `over the change's parse budget of ${PARSE_BUDGET} characters: not read`);
      else {
        out = testFacts(text, new Set(tables.filter((t) => t.path === path).map((t) => t.table)));
        if (!out.ok) hit('unreadable', path, out.why ?? 'not readable');
      }
    }
    factsCache.set(k, out);
    return out;
  };

  // Tests in JavaScript or TypeScript: pooled over the change, so a test moved between files is the same test.
  type Test = { title: string; runs: string };
  const pools = { before: { assertions: [] as string[], tests: [] as Test[] }, after: { assertions: [] as string[], tests: [] as Test[] } };
  const where = new Map<string, string>();
  const added: { path: string; text: string }[] = [];
  const deleted: { path: string; text: string }[] = [];
  for (const f of i.files) {
    const lines = { added: f.addedLines, removed: f.removedLines };
    const linesKnown = lines.added !== undefined && lines.removed !== undefined;
    if (isNonUtf8Path(f.path) && (isTest(f.path) || isGuard(f.path) || isAllowFile(f.path) || tables.some((t) => t.path === f.path))) {
      hit('unreadable', f.path);
      continue;
    }
    // Suppressions, in any file but docs (a doc may name one): more marks added than removed.
    const marks = (ls: string[] | undefined) => (ls ?? []).flatMap((l) => marksIn(f.path, l));
    const newMarks = isDoc(f.path) ? [] : missing(marks(lines.added), marks(lines.removed));
    if (newMarks.length) hit('suppression', f.path, newMarks[0]);

    if (isAllowFile(f.path)) {
      if (!linesKnown) hit('unreadable', f.path);
      else for (const l of missing((lines.added ?? []).flatMap(codeLine), (lines.removed ?? []).flatMap(codeLine))) hit('allow-file', f.path, l);
      continue;
    }
    // A guard or lint file: a code line removed and not put back, or one added that can skip or switch something off
    // (an early return, `if (process.env.X)`, `"rule": "off"`, `continue-on-error`). A lint test that holds a
    // registered table: a line removed (its logic changed beside its table).
    // A lint test that is new in this change has no rule to loosen yet.
    const lintTest = isTest(f.path) && (tables.some((t) => t.path === f.path) || (holds(f.path, i.scope) && LINT_TESTS.includes(f.path))) && read('before', f.path) != null;
    if (isGuard(f.path) || lintTest) {
      if (!linesKnown) hit('unreadable', f.path);
      else {
        // In a lint test, the lines of its registered tables are the table rule's to judge (an allowlist entry taken
        // out is a tightening).
        const inTables = lintTest ? tableLines(f.path, read('before', f.path) ?? null, tables) : new Set<string>();
        const removed = missing((lines.removed ?? []).flatMap(codeLine), (lines.added ?? []).flatMap(codeLine)).filter((l) => !inTables.has(l));
        // A guard's source (src/, scripts/, test/): an added line with an exit or an off switch. Any other guard file
        // (a config, a workflow, a hook): any added line, since an exclude, an ignore pattern, an allowlist path or an
        // `if:` loosens with no word a list could name (fail closed).
        const newLines = missing((lines.added ?? []).flatMap(codeLine), (lines.removed ?? []).flatMap(codeLine));
        // A lint test: an added line with an exit or an off switch too (`if (f.includes('legacy')) continue;`), unless it
        // sits in a test call the change adds (a new test of the lint, `assert.equal(x, false)`, loosens nothing).
        // Nor in a function the change declares (a new helper: an existing line that starts using it is a line changed).
        let inNewTests: string[] = [];
        if (lintTest && JS.test(f.path)) {
          const before = factsOf('before', f.path);
          const now = factsOf('after', f.path);
          const was = new Set((before?.tests ?? []).map((t) => t.title));
          const text = read('after', f.path) ?? '';
          const spans = (now?.tests ?? []).filter((t) => !was.has(t.title)).map((t): [number, number] => [t.from, t.to]);
          if (now && before) {
            const s = scan(text);
            for (const name of [...now.locals].filter((n) => !before.locals.has(n))) {
              const m = new RegExp(`(?<![\\w$.])(?:function\\s*\\*?\\s*${name.replace(/\$/g, '\\$')}\\s*\\(|(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=;]*)?=)`).exec(s.code);
              if (!m) continue;
              const body = m[0].startsWith('function') ? closeOf(s, s.code.indexOf('{', closeOf(s, m.index + m[0].length - 1) + 1)) + 1 : spanFrom(s, m.index)?.[1];
              if (body && body > m.index) spans.push([m.index, body]);
            }
          }
          inNewTests = spans.flatMap(([a, b]) => text.slice(a, b).split('\n').flatMap(codeLine));
        }
        const bypasses = isGuard(f.path) && !engineSourceGlob(f.path) ? newLines : missing(newLines.filter((l) => (isGuard(f.path) ? BYPASS : LINT_BYPASS).test(l)), inNewTests);
        for (const l of [...removed, ...bypasses].slice(0, 3)) hit('guard-lines', f.path, l);
      }
    }
    for (const t of tables.filter((x) => x.path === f.path)) {
      // The table narrowed, changed or declared again where it's used (`NAME.slice(1)`, `[...NAME].filter(...)`,
      // `NAME.push(x)`, `NAME[k] = v`, `Object.assign(NAME, ...)`, a second `const NAME`), in a line the change adds or
      // removes.
      const n = t.table;
      const touches = new RegExp(
        `(?<![\\w$.])${n}\\b[\\s\\])]*\\.\\s*(?:slice|filter|splice|pop|shift|unshift|push|add|set|delete|clear|fill|sort|reverse|copyWithin)\\s*\\(|(?<![\\w$.])${n}\\s*(?:\\.\\s*length|\\[[^\\]]*\\])\\s*=(?!=)|\\bObject\\s*\\.\\s*(?:assign|defineProperty|setPrototypeOf)\\s*\\(\\s*${n}\\b`,
      );
      for (const l of [...missing(lines.added ?? [], lines.removed ?? []), ...missing(lines.removed ?? [], lines.added ?? [])].filter((x) => touches.test(x)).slice(0, 3)) hit('table-touched', f.path, `${n}: ${l.trim()}`);
      // Declared again (a shadow the code then reads instead): more declarations of its name than before.
      const declarations = (text: string | null | undefined) => (text ? [...scan(text).code.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var|function|class)\\s+${n}(?![\\w$])`, 'g'))].length : 0);
      const declaredBefore = declarations(read('before', f.path));
      if (declaredBefore && declarations(read('after', f.path)) > declaredBefore) hit('table-touched', f.path, `${n}: declared again`);
      const b = read('before', f.path);
      const a = read('after', f.path);
      if (b === undefined || a === undefined || b === null) continue;
      const was = tableEntries(f.path, b, t.table);
      if (!was) continue;
      const now = a === null ? null : tableEntries(f.path, a, t.table);
      if (!now) {
        hit('table-gone', f.path, t.table);
        continue;
      }
      if (t.kind === 'never-shrink') for (const e of missing(was, now).slice(0, 3)) hit('table-shrunk', f.path, `${t.table}: ${e}`);
      else for (const e of missing(now, was).slice(0, 3)) hit('table-grown', f.path, `${t.table}: ${e}`);
    }
    if (!isTest(f.path)) continue;
    if (!JS.test(f.path)) {
      // A test in another language, or an expected output: its lines, when the change also changes code.
      if (!codeChanged) continue;
      if (!linesKnown) hit('unreadable', f.path);
      else for (const l of missing((lines.removed ?? []).flatMap(codeLine), (lines.added ?? []).flatMap(codeLine)).slice(0, 3)) hit('test-lines', f.path, l);
      continue;
    }
    const b = read('before', f.path);
    const a = read('after', f.path);
    if (b === undefined || a === undefined) continue;
    const runner = isRunnerTest(f.path) ? 'test file' : 'helper';
    const facts = { before: factsOf('before', f.path), after: factsOf('after', f.path) };
    // A file it can't read (or parse, or fit in the budget) on either side holds (factsOf said why): it can't tell
    // what went.
    if (facts.before === undefined || facts.after === undefined || facts.before?.ok === false || facts.after?.ok === false) continue;
    // A lint by its shape that isn't registered: a regex line removed or changed (its rule loosened) holds.
    if (!lintTest && b !== null && linesKnown && lintShaped(b)) {
      const regexLines = missing((lines.removed ?? []).flatMap(codeLine), (lines.added ?? []).flatMap(codeLine)).filter((l) => scan(l).regexes > 0 || /\bRegExp\s*\(/.test(l));
      for (const l of regexLines.slice(0, 3)) hit('guard-lines', f.path, l);
    }
    for (const side of ['before', 'after'] as const) {
      for (const x of facts[side]?.assertions ?? []) {
        pools[side].assertions.push(`${runner} | ${x}`);
        if (side === 'before') where.set(`${runner} | ${x}`, f.path);
      }
      for (const x of facts[side]?.tests ?? []) {
        pools[side].tests.push({ title: `${runner} | ${x.title}`, runs: x.runs });
        if (side === 'before') where.set(`title ${runner} | ${x.title}`, f.path);
      }
    }
    // A skip, todo or only outside a test's call (an options const, a `t.skip()`): one that changed holds (an
    // existing test's condition). A new one doesn't by itself: an existing test that starts using it runs
    // differently (above), and a `return t.skip()` before an assertion changes what comes before it.
    for (const l of missing(facts.before?.looseSkips ?? [], facts.after?.looseSkips ?? []).slice(0, 3)) hit('test-skip', f.path, l);
    // An existing file whose assertions now call something else (a changed assert import, a shadow, a patch), or
    // that now exits the process early.
    if (facts.before && facts.after) {
      // An assertion or test-call name bound to something else, or unbound while still called (a name only added, or
      // dropped with its last use, changes nothing); a new line that shadows or patches one.
      for (const [name, from] of facts.before.imports) {
        const to = facts.after.imports.get(name);
        if (to === from) continue;
        if (to !== undefined || new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*[.(]`).test(a ?? '')) hit('test-binding', f.path, `${name}: ${from} -> ${to ?? 'nothing'}`);
      }
      for (const l of missing(facts.after.rebinds, facts.before.rebinds).slice(0, 3)) hit('test-binding', f.path, l);
      // A case table a test loops over that lost or changed a row (a row added runs more).
      for (const [name, rows] of facts.before.caseTables) {
        const now = facts.after.caseTables.get(name);
        if (now) for (const row of missing(rows, now).slice(0, 3)) hit('test-skip', f.path, `${name}: ${row}`);
      }
      // A fixture (a server a test starts, its own process) may exit; a test or its helper may not.
      if (facts.after.aborts > facts.before.aborts && !/(?:^|\/)fixtures\//.test(f.path)) hit('test-abort', f.path);
    }
    if (b !== null && a === null && isRunnerTest(f.path)) deleted.push({ path: f.path, text: b });
    if (b === null && a !== null && isRunnerTest(f.path)) added.push({ path: f.path, text: a });
  }
  // A test file deleted: unless the change adds the same text as another test file in the same folder (a rename).
  // Only its stem may change: the runner picks files by their suffix and extension (`.test.ts` built to `.test.js`),
  // so moving it under `.spec.ts`, `.test.mts` or `.test.tsx` can take it out of the run.
  for (const d of deleted) if (!added.some((x) => x.text === d.text && dir(x.path) === dir(d.path) && runnerSuffix(x.path) === runnerSuffix(d.path))) hit('test-file-deleted', d.path);
  // A test gone (no test of its title after), or one that now runs differently (skipped, todo, only, other options).
  // With code changed, a test whose title is gone and an assertion gone or changed each hold. In a change of tests
  // only, there is no code a loosened test could hide: they hold when there are fewer tests or fewer assertions.
  const key = (t: Test) => `${t.title} | runs ${t.runs}`;
  const titlesAfter = new Set(pools.after.tests.map((t) => t.title));
  const fewerTests = pools.after.tests.length < pools.before.tests.length;
  for (const k of missing(pools.before.tests.map(key), pools.after.tests.map(key))) {
    const title = k.slice(0, k.indexOf(' | runs '));
    const shown = title.slice(title.indexOf(' | ') + 3);
    if (titlesAfter.has(title)) hit('test-skip', where.get(`title ${title}`) ?? '?', shown);
    else if (codeChanged || fewerTests) hit('test-removed', where.get(`title ${title}`) ?? '?', shown);
  }
  if (changedHolds || pools.after.assertions.length < pools.before.assertions.length) {
    // An assertion whose only change is a rename the change also makes in its code (`totalCents` to `totalInCents`
    // in src/ and in the test) is the same assertion: its expectation, literals and shape are as they were.
    // Also a rename of a test's own local (`got` to `actual`), declared in the test before and after: never a name
    // the test imports (swapping the unit under test is no rename).
    const code = codeRenames(i.files.filter((f) => !isTest(f.path) && !isDoc(f.path)));
    const tests = codeRenames(i.files.filter((f) => isTest(f.path) && JS.test(f.path)));
    const locals = (side: 'before' | 'after') => new Set(i.files.filter((f) => isTest(f.path) && JS.test(f.path)).flatMap((f) => [...(factsCache.get(`${side}\u0000${f.path}`)?.locals ?? [])]));
    const [localBefore, localAfter] = [locals('before'), locals('after')];
    const renames = { gone: new Set([...code.gone, ...[...tests.gone].filter((n) => localBefore.has(n))]), came: new Set([...code.came, ...[...tests.came].filter((n) => localAfter.has(n))]) };
    const gone = missing(pools.before.assertions, pools.after.assertions);
    const left = missing(pools.after.assertions, pools.before.assertions);
    // Each test file's code words after the change (strings and comments out), for "is the old name still used".
    const usedAfter = (path: string) => factsCache.get(`after\u0000${path}`)?.words ?? new Set<string>();
    for (const x of gone) {
      const path = where.get(x) ?? '';
      const same = left.findIndex((y) => renamedOnly(x, y, renames, (name) => usedAfter(path).has(name)));
      if (same !== -1) left.splice(same, 1);
      // Shown as the assertion itself: `runner | where | exits n | <assertion>[ | uses ...]`.
      else hit('test-assertion', where.get(x) ?? '?', x.split(' | ')[3] ?? x);
    }
  }

  const out: string[] = [];
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const at = [...new Set(found.get(kind) ?? [])];
    if (at.length) out.push(`${WEAKENING_REASON}${KINDS[kind]} (${at.slice(0, 3).join('; ')}${at.length > 3 ? `; and ${at.length - 3} more` : ''})`);
  }
  return out;
}

/** Whether weakeningReasons reads this file's text (a test, or a file with a registered table). */
const needsText = (path: string, scope: LockScope | undefined) => (matcher(TEST_PATHS, undefined)(path) && JS.test(path)) || CHECK_TABLES.some((t) => t.path === path && holds(t.path, scope));

/**
 * weakeningReasons for the change base..head of the repo at `cwd`, with `files` from changeFiles. When the files
 * can't be read, one reason says so: the change waits (fail closed).
 */
export function weakeningOf(cwd: string, base: string, head: string, files: ChangeFile[], scope: LockScope | undefined): string[] {
  try {
    const paths = files.map((f) => f.path).filter((p) => !isNonUtf8Path(p) && needsText(p, scope));
    // A blob over the cap (in bytes, never fewer than its characters) isn't read at all: it holds unread.
    const side = (rev: string) => {
      const { texts, tooBig } = filesAt(cwd, rev, paths, SIZE_CAP);
      return (p: string) => {
        if (tooBig.has(p)) throw new Error(`${tooBig.get(p)} bytes, over the cap: not read`);
        return texts.get(p) ?? null;
      };
    };
    return weakeningReasons({ files, before: side(base), after: side(head), scope });
  } catch (e) {
    return [`${WEAKENING_REASON}the check for a removed or weakened test, lint or guard could not run (${escapedPath(String((e as Error).message ?? e).slice(0, 200))})`];
  }
}
