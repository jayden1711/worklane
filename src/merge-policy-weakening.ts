// Whether a change removes or weakens a test, a lint or a guard (#783): such a change waits for the owner, whatever
// its review level. The owner's rule is that no agent removes or weakens a check without the owner's OK. This makes
// it part of the merge decision, a runtime check on the change's own diff: mergeDecision gets a `design:` reason from
// what the change does, never from the evaluator's text.
//
// The rule is the owner's (2026-10-19), read line by line from the diff, with no parser:
//   - a test file (TEST_PATHS): a removed line (a changed line is a removed one and an added one) with an assertion or
//     a test on it (CHECK_LINE); a deleted test file;
//   - a test's expected output (a snapshot, a fixture, any test file that isn't code): any removed line;
//   - a guard or lint file (GUARD_FILES, a lint test by its mark): any removed line;
//   - a registered table (its mark, or CHECK_TABLES), its lines from its declaration to its close: a line gone from a
//     rule list, a bad-fixture list or a guard's list (never-shrink), or new in an allowlist or exception list
//     (never-grow); its name sets a floor its mark can only add to (ALLOW_NAMED, RULE_NAMED);
//   - a data table (#941: `<module>.tables.json`, the engine's own tables), read as parsed data, never run: a table or
//     the file gone, a table's kind changed, an entry lost or changed in a never-shrink table, or added or changed in a
//     never-grow one; a file that doesn't parse; a new one whose name differs only in case from another's; and in any
//     JS or TS file, a removed or changed line that loads one (TABLE_LOAD);
//   - a registration mark the default branch has, gone or changed while what it registers is still there (#869);
//   - in a registered table's file, an added line that could hide the table from the reader (an escaped name, a
//     declaration with its name on the next line);
//   - an allowlist file (NEVER_GROW_FILES): any added line;
//   - any file but docs: an added line with a skip, only or suppression marker on it (MARKERS, owner, 2026-10-19).
// Other pure additions pass: an added assertion, test, rule or guard line never waits.
//
// Every change is measured twice (weakeningOf, #1069): from its base, and as what merging it would change on the
// default branch's tip (a merge that conflicts there is measured from the tree git writes for it, and waits when it
// conflicts in a file read strictly, #1077; elsewhere it is left to the conflict paths, and its resolution measured).
//
// Bounded and fail closed: one pass over each changed line of the files it checks, with substrings and linear
// patterns only (no quantifier); over MAX_CHANGED_CHARS of such lines, a diff that doesn't match its line counts (cut short), a file that
// isn't text, a table it can't find or a git failure, the change waits. The engine's own source paths (ENGINE_ONLY)
// stand aside in a managed app's repo, as the locks do there (src/review.ts lockedCategories).
import { BRAND } from './brand.js';
import { parseTables, TABLES_FILE, type ParsedTable } from './check-tables.js';
import { changedNames, changeFiles, exactMoves, filesAt, filesWithText, mergeBaseOf, mergedTree, presentNames } from './coordinator/change-files.js';
import { globRegExp } from './guardrails/glob.js';
import { escapedPath, isNonUtf8Path, shownPath } from './path-text.js';
import { engineSourceGlob, LOCKED_CATEGORIES, lockedCategories, type ChangeFile, type LockScope } from './review.js';

/** never-shrink: a line gone holds (rules, bad fixtures, guard lists). never-grow: a line new holds (allowlists, exceptions, good fixtures). */
export type TableKind = 'never-shrink' | 'never-grow';

/** A check's table: a top-level `const` (or, in a .json file, a key) in one file, read as its lines. */
export interface CheckTable {
  path: string;
  table: string;
  kind: TableKind;
}

/**
 * A check registers itself where it is declared (#869), so adding one never needs an edit here:
 *   - a table: the line right before its `const`/`let`/`var` declaration is exactly TABLE_MARK and its kind
 *     (`never-grow` for an allowlist, an exception list or good fixtures; `never-shrink` for rules, bad fixtures or a
 *     guard's list);
 *   - a lint test (one whose rules live in its code, so any line taken out of it waits, as from a guard file): a line
 *     that is exactly LINT_MARK, near its top.
 * Marks are read only in JS and TS files (MARKABLE), from the text before the change and from the default branch's
 * current tip (weakeningOf; a PR claimed before a mark landed is held by it too). A mark a change adds holds from the next change on; one it removes, changes or detaches from its table
 * waits for the owner. A line that looks like a mark but isn't one registers nothing (the backstop test fails on it).
 */
export const TABLE_MARK = '// check-table: ';
export const LINT_MARK = '// lint-test';
/** The files a mark is read in. */
export const MARKABLE = /\.[cm]?[jt]sx?$/;
/** A table name that says it allows or exempts something: never-grow, whatever its mark says. */
export const ALLOW_NAMED = /ALLOW|EXEMPT|EXCEPT|SKIP|OUTSIDE|IGNORE|KNOWN|REVIEWED|PERMIT|BASELINE|LEGACY|WAIVE|NOT_YET|GOOD/;
/**
 * A table name that says it holds rules or a guard's list: never-shrink, whatever its mark says. A name of both kinds
 * is held both ways. ONLY is neither (an allowlist of first-time-only files and a guard's maker-only list both use it).
 */
export const RULE_NAMED = /BAD|RULES|WORDS|PATTERNS|DENY|BANNED|FORBIDDEN|NEVER|GUARD/;
/** A line that tries to be a mark (any comment opener, any spacing): it must be one exactly. */
const MARKISH = /^(?:\/\/|\/\*|\*)\s*(?:check-table|lint-test)/;
/** A declaration a table mark registers: its name, a plain identifier (as tableLines reads it). */
const DECLARES = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)(?![\w$])/;

/** What a file's marks register, and the lines that look like marks but register nothing (for the backstop). */
export interface Registrations {
  tables: { table: string; kind: TableKind }[];
  lint: boolean;
  problems: string[];
}

/** The marks in a file's text: the tables they register (with their kinds), whether it is a lint test, and odd marks. */
export function registrationsOf(text: string): Registrations {
  const out: Registrations = { tables: [], lint: false, problems: [] };
  const lines = text.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k]!.trim();
    if (t === LINT_MARK) {
      out.lint = true;
      continue;
    }
    const kind = t.startsWith(TABLE_MARK) ? t.slice(TABLE_MARK.length) : null;
    if (kind === 'never-grow' || kind === 'never-shrink') {
      const name = DECLARES.exec(lines[k + 1]?.trimStart() ?? '')?.[1];
      if (name) out.tables.push({ table: name, kind });
      else out.problems.push(`line ${k + 1}: a table mark with no table declared on the next line`);
    } else if (MARKISH.test(t)) out.problems.push(`line ${k + 1}: not a mark, so it registers nothing: ${t.slice(0, 80)}`);
  }
  return out;
}

/** The kinds a table is held by: its mark's, and its name's floor. A mark only adds to the floor. */
export function heldKinds(table: string, kind: TableKind): Set<TableKind> {
  const held = new Set<TableKind>([kind]);
  if (ALLOW_NAMED.test(table)) held.add('never-grow');
  if (RULE_NAMED.test(table)) held.add('never-shrink');
  return held;
}

/**
 * The check tables that can't carry a mark (not JS or TS): `package.json`'s scripts, the commands that run the checks
 * (a script dropped or changed, a lint taken out of `npm test`, waits). Every other table registers itself by its mark.
 * A backstop test in test/merge-policy.test.ts fails on a check-shaped table in test/ or scripts/ that is neither
 * registered nor in its NOT_A_CHECK, on a registered table the hold can't find, and on an allowlist's name marked
 * never-shrink (a rule list's name may carry either mark: its floor holds it on shrinking whatever the mark says).
 */
export const CHECK_TABLES: readonly CheckTable[] = [{ path: 'package.json', table: 'scripts', kind: 'never-shrink' }];

/**
 * Lint tests that can't carry a mark (not JS or TS). A backstop test in test/merge-policy.test.ts fails on a test that
 * walks the sources and is neither a lint test nor in its NOT_A_LINT.
 */
export const LINT_TESTS: readonly string[] = [];

/**
 * Files whose every removed line waits: the guards and lints themselves, and their configs. ENGINE_ONLY ones are the
 * engine's own source and stand aside in a managed app's repo.
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
  // What install and every script run under (any added line waits too: NEVER_GROW_FILES), and the workspace's settings
  // (only a removed or changed line: ordinary PRs add packages there).
  '**/.npmrc',
  '**/.yarnrc',
  '**/.yarnrc.yml',
  '**/bunfig.toml',
  '**/.bunfig.toml',
  '**/pnpm-workspace.yaml',
  // Shared CI steps, more test runners and linters, who must review, and the project lints of the PR-gate tier.
  '.github/actions/**',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
  '**/vite.config.*',
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
  'src/testrun/affected.ts',
  'src/merge-policy*',
  // The data tables' loader and parser, the scripts' copy of it and the copies' generator, and the test loader's
  // freeze (#941): the hold reads the tables through the parser, and this backstop runs it.
  'src/check-tables.ts',
  'scripts/lib/check-tables.mjs',
  'scripts/lib/table-copies.mjs',
  'scripts/gen-table-copies.mjs',
  'test/table-freeze.ts',
  // The snapshot the freeze's compile step and hook check a table module's source against (R1184at D3).
  'test/table-snapshot.ts',
  'src/coordinator/merge-flow*',
  'src/coordinator/change-files.ts',
  'src/pr-rules*',
  'src/main-watch*',
  'src/push-guard*',
  'src/push-check*',
  'src/review.ts',
  // The look-alike check src/review.ts imports, and its table (#763): they run in the weakening backstop's process.
  'src/confusables.ts',
  'src/confusables-data.ts',
  // What the planners' decisions index reads, and what it leaves out (#920): records committed at the base, never
  // docs/process.md; known routes it doesn't close are under "Open routes into the decisions index" there (#975).
  'src/plan-decisions.ts',
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
  // What else runs in a lint test's process through test/isolate.ts and the weakening module (#746 round 19): one
  // changed line here could make a backstop read another tree, or hide a file from it.
  'src/brand.ts',
  'src/os/system-paths.ts',
  'src/os/own-env.ts',
  'src/os/child-process.ts',
  // The git runner (#927): src/coordinator/change-files.ts reads through it, so it runs in a backstop's process too.
  'src/os/git.ts',
];

/** A package manager's settings: every one changes what install and each script run under (`script-shell=`, `ignore-scripts=`). */
const PACKAGE_MANAGER_SETTINGS: readonly string[] = ['**/.npmrc', '**/.yarnrc', '**/.yarnrc.yml', '**/bunfig.toml', '**/.bunfig.toml'];

/** Files where any line added waits: allowlist files, and a package manager's settings (guard files too). */
export const NEVER_GROW_FILES: readonly string[] = ['.denylist-allow', '.gitleaksignore', '**/.eslintignore', '**/.semgrepignore', ...PACKAGE_MANAGER_SETTINGS];

/**
 * Test files and their expected outputs, whatever the repo's review.yaml calls tests (an own list: narrowing the tests
 * category doesn't narrow this).
 */
export const TEST_PATHS: readonly string[] = [
  'test/**', 'tests/**', 'spec/**', '**/test/**', '**/tests/**', '**/spec/**', 'Tests/**', '**/Tests/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
  '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/*.bats', '**/__snapshots__/**', '**/*.snap', '**/testdata/**',
];

/** The most characters of changed lines, in the files the hold reads, it checks in one change; over it, the change waits. */
export const MAX_CHANGED_CHARS = 4_000_000;
/** The most bytes of a file with a registered table it reads; over it, the change waits. */
export const MAX_TABLE_FILE = 500_000;

/**
 * A line with an assertion or a test on it, in each language whose test files are read as code (TEST_CODE):
 * `assert*` (and `self.assert*`, minitest's `assert_`), `expect`, `should`, `fail(`, a test context's `t.` (node, ava,
 * Go's `t.Error`/`t.Fatal`), testify's `require.`, `pytest.`, a `.toBe`-style or chai `.to.` matcher, xUnit's
 * `Assert.`, `[Fact`, `[Theory`, `[Test`, XCTest's `XCTAssert`/`XCTFail`, minitest's `must_`/`wont_`/`refute`, and a
 * test: `test(`, `it(`, `describe(`, `suite(` (and their `.skip`/`.only` forms), `def test`, `class Test`,
 * `func Test`, `@Test`. Literal alternatives with a one-character look-behind, no quantifier: linear in the line. A word
 * list, not a proof: an assertion through another name (an alias, a helper) gets past it.
 */
export const CHECK_LINE = /(?<![\w$])(?:assert|expect|should|fail\(|require\.|pytest\.|@Test|def test|class Test|func Test|func Benchmark|func Fuzz|func Example|Assert\.|\[Fact|\[Theory|\[Test|XCTAssert|XCTFail|must_|wont_|refute)|(?<![\w$.])(?:t\.[A-Za-z]|test\(|test\.[a-z]|it\(|it\.[a-z]|describe\(|describe\.[a-z]|suite\(|suite\.[a-z])|\.to[A-Z.]/;
/** In a bats file, also a test (`@test`), a command it checks (`run `) and a check (`[ `). */
const BATS_LINE = /(?<![\w$])(?:@test|run )|\[ /;

/**
 * Marks that make a test run less or turn a lint or type check off: an added line holding one waits, in any file but
 * docs. Plain substrings, so a word that only holds one (`profit(` holds `fit(`) waits too (owner, 2026-10-19: the
 * false holds are accepted). Each line is read with a space before it, so ` xit ` and ` skip ` (RSpec's forms with no
 * parentheses) also match at the start of a line. The one list of them; the long tail of other runners' and linters'
 * forms is a named gap.
 */
export const MARKERS: readonly string[] = [
  // A test run alone, the rest not run.
  '.only(', 'test.only', 'it.only', 'describe.only', 'fit(', 'fdescribe(', '.runIf(',
  // A test skipped or left to do.
  '.skip(', '.skip.', 'skip:', 't.skip', 'test.skip', 'it.skip', 'xit(', 'xtest(', 'xdescribe(', 'xcontext(', '.todo(', 'todo:', 'pending(', '.skipIf(',
  ' xit ', '\txit ', ' skip ', '\tskip ',
  '@pytest.mark.skip', '@pytest.mark.xfail', '@unittest.skip', 'skipTest(', 'SkipTest', 'pytest.importorskip',
  't.Skip(', 't.Skipf(', 't.SkipNow(', '#[ignore', '@Disabled', '@Ignore', 'XCTSkip', 'Skip =', 'Skip=',
  // A lint or type check off for a line, a block or a file.
  'eslint-disable', 'eslint ', '@ts-ignore', '@ts-expect-error', '@ts-nocheck', 'biome-ignore', 'oxlint-disable', 'tslint:disable', 'deno-lint-ignore',
  'NOLINT', 'nolint', 'noqa', 'type: ignore', 'type:ignore', 'pyright: ignore', 'mypy: ignore', 'pylint: disable', 'pylint:disable', '#[allow(', '#![allow(', '#[expect(',
  'swiftlint:disable', 'rubocop:disable', 'rubocop:todo', 'istanbul ignore', 'c8 ignore', 'v8 ignore', 'pragma: no cover',
  'nosec', 'nosemgrep', 'NOSONAR', 'gitleaks:allow', '@SuppressWarnings', '@Suppress(', '#pragma warning disable', 'phpcs:ignore', '@phpstan-ignore', '@psalm-suppress',
  'shellcheck disable', 'stylelint-disable', 'yamllint disable', 'hadolint ignore',
  // A test selected less: a declared runtime import turns tests that ran on every change into selected ones
  // (src/testrun/affected.ts, #881).
  'runtime-import:',
];
/** MARKERS as one regex of escaped literal alternatives (no quantifier): the same substrings, in one pass per line. */
const MARK = new RegExp(MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
const marked = (line: string) => MARK.test(` ${line}`);

/** Docs: neither code nor a test; a doc that names a marker adds none. A test file under docs/ is a test file. */
const isDoc = (p: string) => /\.(?:md|txt)$/i.test(p) || p.startsWith('docs/');
/** A file that isn't text by its kind (an image, an archive, a font, a binary): skipped, never read for marks. */
const ASSET = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|jar|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|mov|wasm|so|dylib|dll|exe|bin|sqlite|db)$/i;

/** Test code, read by CHECK_LINE; any other test file (JSON, text, a shell script, a snapshot) is an expected output, every line held. */
const TEST_CODE = /\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kt|swift|php|cs|bats)$/;
/** A test file's name from its first `.test.`/`.spec.` on (`.test.ts`), or its extension: what a runner selects it by. */
const runnerSuffix = (p: string) => /(\.(?:test|spec)\..*|\.[^./]*)$/.exec(p.slice(p.lastIndexOf('/') + 1))?.[1] ?? '';
/**
 * The file names each runner selects by default: jest, vitest, mocha and node (`*.test.ts`, `*.spec.js`), pytest
 * (`test_*.py`, `*_test.py`), go test, rspec and minitest, Surefire (`Test*.java`, `*Test.java`, `*Tests.java`,
 * `*TestCase.java`, and Kotlin's), xUnit, XCTest and bats. A rename keeps a test running only within one of them.
 */
const RUNNER_NAMES: readonly RegExp[] = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/, /^test_.*\.py$/, /_test\.py$/, /_test\.go$/, /_spec\.rb$/, /_test\.rb$/, /^test_.*\.rb$/,
  /^Test.*\.(?:java|kt)$/, /Tests?\.(?:java|kt)$/, /TestCase\.(?:java|kt)$/, /Tests?\.cs$/, /Tests?\.swift$/, /\.bats$/,
];
const runnerOf = (p: string) => RUNNER_NAMES.findIndex((re) => re.test(p.slice(p.lastIndexOf('/') + 1)));
/** The path up to its first test folder (`test/`, `tests/`, `spec/`, `Tests/`, `__tests__/`), or '' with none. */
const testRoot = (p: string) => {
  const parts = p.split('/');
  const at = parts.findIndex((s, k) => k < parts.length - 1 && ['test', 'tests', 'spec', 'Tests', '__tests__'].includes(s));
  return at === -1 ? '' : parts.slice(0, at + 1).join('/');
};
/** A folder a runner doesn't run tests from: fixtures, snapshots, mocks, test data, docs, node_modules, a dot folder. */
const NOT_RUN = /(?:^|\/)(?:fixtures|__fixtures__|__snapshots__|__mocks__|testdata|docs|node_modules|\.[^/]+)\//;
/** An expected output or fixture, whatever its extension. */
const isFixture = (p: string) => /(?:^|\/)(?:fixtures|__snapshots__|testdata)\//.test(p) || p.endsWith('.snap') || !TEST_CODE.test(p);

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
  const res = globs.filter((g) => holds(g, scope)).map((g) => globRegExp(g, 'deny'));
  return (p: string) => res.some((re) => re.test(p));
};

export interface WeakeningInput {
  files: ChangeFile[];
  /** The paths the change deletes. */
  deleted: ReadonlySet<string>;
  /** Deleted paths whose exact blob the change adds at a new path, old path to new (a pure rename). */
  moved?: ReadonlyMap<string, string>;
  /** A file's text before the change (null: it wasn't there), for the files with a registered table or a mark only. */
  before: (path: string) => string | null;
  /** A file's text after the change (null: it isn't there), for the files with a registered table or a mark only. */
  after: (path: string) => string | null;
  scope: LockScope | undefined;
  /**
   * The changed files whose text before the change holds a mark's text (weakeningOf finds them with git grep): their
   * marks are read. Absent: every changed JS or TS file's text before the change is read for marks.
   */
  marked?: ReadonlySet<string>;
  /**
   * A file's text at the default branch's current tip (null: it isn't there), for the files whose text there holds a
   * mark's text (tipMarked). A registration on the default branch holds whatever the change's base is: a PR claimed
   * before a mark landed is held by it too (#886's round-4 review). Absent: only the base's marks are read (a pure test).
   */
  tip?: (path: string) => string | null;
  /** The changed files whose text at the tip holds a mark's text. Absent with `tip`: every changed JS or TS file. */
  tipMarked?: ReadonlySet<string>;
  /**
   * A file's text where the change meets the tip (git merge-base): a tip mark the head lacks was taken out by the
   * change only when this text has it; otherwise the head is older than the mark and the merge keeps it. Absent: a tip
   * mark the head lacks always waits.
   */
  meet?: (path: string) => string | null;
  /**
   * The paths a merge into the default branch's tip conflicts on, for the change from the tip to the tree git writes
   * for that merge (weakeningOf, #1077). One the hold reads strictly waits: GitHub's own merge may complete there, and
   * what it makes is never read. Absent: the change isn't a merge.
   */
  conflicts?: readonly string[];
  /**
   * Every tables file (`<module>.tables.json`) the change's base has, for the case-folded name check (#941). Absent:
   * only the changed files are compared with each other.
   */
  tablesFiles?: ReadonlySet<string>;
}

/** Each kind of weakening, in the words a reason uses, in the order reasons are given. */
const KINDS = {
  unreadable: "can't read a change to check it, so it may weaken a check",
  'tip-conflict': "conflicts with the default branch's current tip on where a test, lint, guard, allowlist or table file goes or whether it stays, so what merging it makes there can't be read",
  'test-file-deleted': 'deletes a test file',
  'test-assertion': 'removes or changes a line with an assertion or a test on it',
  'test-lines': "removes or changes a line of a test's expected output or fixture",
  'table-gone': "removes or renames a check's or guard's table",
  'registration-gone': 'removes or changes the mark that registers a check, a check-table or lint-test line',
  'table-shrunk': "removes or changes an entry in a check's rules or a guard's list",
  'table-grown': 'adds or changes an entry in an allowlist, exception or good-fixture list',
  'allow-file': "adds a line to an allowlist file or a package manager's settings file",
  'table-used': "changes a check's or guard's table outside its own list",
  'table-hidden': "adds a line that could hide a check's table from the line reader, an escaped name, a name on the next line or a global binding",
  'table-load-gone': "removes or changes the line that loads a check's table from its data",
  'table-load-added': "adds a line that loads a check's table some other way than its module's one load",
  'guard-lines': 'removes or changes a line of a guard or lint',
  marker: 'adds a line with a skip, only or lint or type-check suppression mark',
} as const;

type Kind = keyof typeof KINDS;

/** The reasons' common start: each is a design-level hold. */
export const WEAKENING_REASON = 'design: may weaken a check: ';

/** Whether a reason is the hold on a conflict with the tip in a check's file (GitHub's own conflict state may send it to the conflict fix first). */
export const isTipConflict = (reason: string): boolean => reason.startsWith(`${WEAKENING_REASON}${KINDS['tip-conflict']} (`);

/**
 * A line that loads a table (#941): a module's own load, any `.tables.json` name, or a generated copy's marker line
 * (scripts/lib/table-copies.mjs, scripts/lib/redact-vendor.mjs). A removed or changed one waits.
 */
export const TABLE_LOAD = /\btablesOf\s*\(\s*import\s*\.\s*meta\s*\.\s*url\b|\bTABLES\s*(?:\?\s*)?\.\s*get\b|\.tables\.json\b|\/\/ (?:BEGIN|END) tables from |TABLES_DATA = /;

/**
 * The one way a module may import the loader (#941, R1184n N3): a plain named import of the names a load site uses
 * (`import type` too), none of them under another name, on one line. Any other added line naming the loader's module
 * (an alias, a namespace, a dynamic import, `tablesFrom` or `parseTables`, an import split over lines) waits; so does a
 * line that uses `import.meta` other than in one of its listed reads (metaUse). Lines are read as text, and the backstop
 * (test/merge-policy.test.ts loadSiteProblems) reads them parsed: a specifier written with escapes is caught there.
 * Neither follows a specifier computed at run time (`import('./check' + '-tables.js')`): a named limit (R1184o 3), since
 * scripts/ci imports by computed URLs by design; a second load of a real tables file gets the same frozen data, and a
 * decoy loaded that way is the open class.
 */
export const LOADER_IMPORT = /^\s*import\s+(?:type\s+)?\{\s*(?:(?:type\s+)?(?:tablesOf|frozenSet|regExpOf|regExpsOf|FrozenSet|Pattern|Tables|TableKind)\s*,?\s*)+\}\s*from\s*['"](?:\.\.?\/)+(?:[\w-]+\/)*check-tables\.(?:js|mjs)['"];?\s*$/;
const LOADER_NAMED = /check-tables/;
/** The loader, the parser, the copy generators and this hold: the only code that loads tables some other way. */
export const LOADER_CODE: ReadonlySet<string> = new Set(['src/check-tables.ts', 'src/merge-policy-weakening.ts', 'scripts/lib/check-tables.mjs', 'scripts/lib/table-copies.mjs', 'scripts/gen-table-copies.mjs', 'scripts/lib/redact-vendor.mjs']);
/**
 * The reads of `import.meta` a line may hold (R1184ae: an allowlist, fail closed, in place of rules that named each way
 * of writing it, which a `!`, an `as`, a `satisfies`, a parenthesis or a line break got past each round). Each is a
 * whole expression that only reads `import.meta.url`: a URL resolved against it from a plain string, its path, the
 * module's own table load, and a comparison with it. The string is path characters only, so it can't be the ends of
 * two strings or comments with code between them (R1184af D1); a comparison counts only after a token that can't make
 * its left side a write, never at a line's start (R1184af D2: `delete import.meta.url !== 0`, `++import.meta.url`). A require rooted at it is not listed (R1184ae: the word is one
 * test/desktop-removed.test.ts LOADER_WORDS keeps out of the modules the backstop runs, this one among them), so such a
 * line waits when it changes.
 */
const META_READS =
  /new\s+URL\(\s*(?:(?:'[\w./@-]*'|"[\w./@-]*")\s*,\s*)?import\.meta\.url\s*\)|fileURLToPath\(\s*import\.meta\.url\s*\)|tablesOf\(\s*import\.meta\.url\s*\)|(?<=(?:[(,=?:!&|]|\breturn)\s*)import\.meta\.url\s*[!=]==(?!=)/g;

/**
 * Whether an added line uses `import.meta` other than in one of META_READS (R1184ae): once those reads are taken out,
 * any `import` still followed on the line by `meta` (through spaces, comments, parentheses or a TypeScript wrapper),
 * or a line that ends at `import`, `import.` or `import.meta…`, or starts at `.meta` (a use split over lines), waits.
 * A string or a comment that names `import.meta` waits too. A module's load reads its path from `import.meta.url`, and
 * the loader (src/check-tables.ts callerScript) refuses a URL that isn't its caller's own file at run time.
 */
export function metaUse(l: string): boolean {
  // Read twice: as written, and with its comments cut out (R1184af D3, R1184ag D2: `import /*` then `*/.meta.url = …`,
  // `import. // c` then `meta.url = …`). Cutting can only join what a comment split, so a hit on either reading waits.
  const bare = l
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/^.*?\*\//, ' ')
    .replace(/\/\*.*$/, ' ')
    .replace(/\/\/.*$/, ' ');
  return [l, bare].some((x) => {
    const rest = x.replace(META_READS, ' R ');
    return /\bimport\b[\s\S]*\bmeta\b/.test(rest) || /\bimport\s*(?:\.\s*(?:meta\b[\s\S]*)?)?$/.test(rest) || /^\s*\.?\s*meta\s*\./.test(rest) || /^\s*\.\s*meta\b/.test(rest);
  });
}

/**
 * A line terminator inside what git calls one line (R1184w D1): U+2028, U+2029, or a CR not at its end (CRLF's CR is).
 * JS and TS end a `//` comment there, so the text after it is code the line readers would take for comment. A line
 * holding one is never a comment to the hold, and an added REPLACERS line holding one waits.
 */
export const LINE_BREAK = /\r(?!$)|[\u2028\u2029]/;

/**
 * A line cut at its commas outside brackets, with brackets and commas counted in code only (R1184v D1): the text of
 * `'…'`, `"…"`, a template and a block comment is skipped, and a template's `${…}` is code. Null, so the line waits,
 * when the line can't be read alone: a quote, a backtick, a `${`, a block comment or a bracket it doesn't close, or a
 * `/` that isn't a comment (a regexp and a division look alike here). A `//` comment ends the line's code.
 */
export function topLevelParts(l: string): string[] | null {
  if (LINE_BREAK.test(l)) return null;
  const parts = [''];
  const add = (s: string) => {
    parts[parts.length - 1] += s;
  };
  let depth = 0;
  const opened: number[] = []; // the depth each open `${` was at
  let template = false;
  for (let i = 0; i < l.length; ) {
    const c = l[i]!;
    if (template) {
      if (c === '\\') {
        add(l.slice(i, i + 2));
        i += 2;
      } else if (c === '`') {
        template = false;
        add(c);
        i++;
      } else if (c === '$' && l[i + 1] === '{') {
        opened.push(depth++);
        template = false;
        add('${');
        i += 2;
      } else {
        add(c);
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < l.length && l[j] !== c) j += l[j] === '\\' ? 2 : 1;
      if (j >= l.length) return null;
      add(l.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      template = true;
      add(c);
      i++;
      continue;
    }
    if (c === '/') {
      if (l[i + 1] === '/') break;
      if (l[i + 1] !== '*') return null;
      const end = l.indexOf('*/', i + 2);
      if (end < 0) return null;
      add(' ');
      i = end + 2;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (c === '}' && opened.length && depth === opened[opened.length - 1]) {
        opened.pop();
        template = true;
        add(c);
        i++;
        continue;
      }
    }
    if (c === ',' && depth === 0) parts.push('');
    else add(c);
    i++;
  }
  return template || opened.length || depth !== 0 ? null : parts;
}

/** The tables file beside the module or script at `path` (`scripts/push-gate.mjs` → `scripts/push-gate.tables.json`). */
export const tablesFileFor = (path: string): string => `${path.replace(/\.[cm]?[jt]s$/, '')}.tables.json`;

/** `s` with identifier escapes undone (`A`, `\u{41}` → `A`), so a name written with them is the same name (R1184ah D1). */
export const unescapeIds = (s: string): string =>
  s.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (m, a: string | undefined, b: string | undefined) => {
    const n = parseInt(a ?? b ?? '', 16);
    return n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });

/**
 * A text's code, for the copy rules (R1184ai D2): comments, strings and templates blanked (line breaks kept), with
 * where each line starts ('code', 'comment' or 'string') and the brace depth there. `sure` is false when the reading
 * may be wrong: a line terminator other than \n or CRLF, a `\u` or `\x` escape, a template holding `${`, a string not closed on its line, or a
 * `/` in code (a regexp or a division, which a quote or a brace after it could be read through). The caller fails
 * closed on it.
 */
export function copyCodeOf(text: string): { code: string; starts: { state: 'code' | 'comment' | 'string'; depth: number }[]; slash: Set<number>; sure: boolean } {
  let out = '';
  let state: 'code' | 'comment' | 'string' = 'code';
  let depth = 0;
  let line = 0;
  let sure = true;
  const slash = new Set<number>();
  const starts: { state: 'code' | 'comment' | 'string'; depth: number }[] = [{ state, depth }];
  const blank = (c: string) => (c === '\n' ? '\n' : ' ');
  // A lone CR, U+2028 or U+2029 ends a line (and a `//` comment) for JS and TypeScript but not for this reading, which
  // splits at \n (R1184aj D1: `// note<CR>/*` opens a comment the reading doesn't see): not sure, so the caller waits.
  if (/\r(?!\n)|[\u2028\u2029]/.test(text)) sure = false;
  // A `\u` or `\x` escape may be a quote or a line break in a string or comment, which this reading takes as written
  // (R1184am D1): not sure.
  if (/\\[ux]/.test(text)) sure = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '\n') {
      out += '\n';
      line++;
      starts.push({ state, depth });
      i++;
      continue;
    }
    if (state === 'comment') {
      if (text.startsWith('*/', i)) {
        state = 'code';
        out += '  ';
        i += 2;
      } else {
        out += ' ';
        i++;
      }
      continue;
    }
    if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (text.startsWith('/*', i)) {
      state = 'comment';
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (text[j] !== c) sure = false;
      for (let k = i; k <= Math.min(j, text.length - 1); k++) out += blank(text[k]!);
      for (let k = i; k <= Math.min(j, text.length - 1); k++) if (text[k] === '\n') (line++, starts.push({ state: 'string', depth }));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== '`') {
        if (text.startsWith('${', j)) sure = false;
        j += text[j] === '\\' ? 2 : 1;
      }
      for (let k = i; k <= Math.min(j, text.length - 1); k++) {
        out += blank(text[k]!);
        if (text[k] === '\n' && k > i) (line++, starts.push({ state: 'string', depth }));
      }
      i = j + 1;
      continue;
    }
    if (c === '/') slash.add(line);
    if (c === '{') depth++;
    else if (c === '}') depth--;
    out += c;
    i++;
  }
  return { code: out, starts, slash, sure };
}

/** A global object reached, `with`, eval or Function (R1184ah D1: a weaker table bound where a copy's name resolves). */
const GLOBAL_REACH = /(?<![\w$.])(?:globalThis|global|window|self)(?![\w$])|(?<![\w$.])with\s*\(|(?<![\w$.])(?:eval|Function)\s*\(/;

/** The tables a generated copy in `text` declares: each `const NAME =` (or `export const`) line between its markers. */
export function copyNames(text: string | null): string[] {
  return [...copyLines(text)].flatMap((l) => /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/.exec(l)?.[1] ?? []);
}

/** How many lines of `text` declare, import or assign `name` (R1184ag D1, main's "declared N times"). */
export function declarations(text: string, name: string): number {
  // In code only (R1184ai D2: a block in a comment is no declaration), names unescaped (R1184ah D1).
  // Lexed as written, names un-escaped after (R1184am D1: an escape in a string or comment isn't a name's).
  text = copyCodeOf(text).code.split('\n').map(unescapeIds).join('\n');
  const n = name.replace(/\$/g, '\\$');
  const decl = new RegExp(`(?<![\\w$])(?:const|let|var|function|class)\\s+${n}(?![\\w$])|(?<![\\w$])import\\b[^;]*[{,\\s]${n}(?![\\w$])|(?<![\\w$.])${n}\\s*=(?![=>])`);
  return text.split('\n').filter((l) => decl.test(l)).length;
}

/** The lines of `text` between a generated copy's `// BEGIN tables from ` and `// END tables from ` markers. */
export function copyLines(text: string | null): Set<string> {
  const out = new Set<string>();
  let inside = false;
  for (const l of (text ?? '').split('\n')) {
    if (l.startsWith('// BEGIN tables from ')) inside = true;
    else if (l.startsWith('// END tables from ')) inside = false;
    else if (inside) out.add(l);
  }
  return out;
}

/** The files whose REPLACERS block is a table's code-held entries: the redactor and the root updater's copy of it. */
export const REPLACER_FILES = /^(?:src\/events\/redact\.ts|scripts\/machine\/[^/]+-update\.cjs)$/;

/**
 * The lines of `text`'s REPLACERS block: from the line that declares `const REPLACERS` to the first later line that is
 * `});` at the declaration's indent. None when the text has no block; throws when it has a declaration that never
 * closes, or two (a decoy), so the change waits.
 */
export function replacerLines(text: string | null): string[] {
  if (text === null) return [];
  const lines = text.split('\n');
  const starts = lines.flatMap((l, k) => (/^\s*const REPLACERS\b/.test(l) ? [k] : []));
  if (!starts.length) return [];
  if (starts.length > 1) throw new Error(`REPLACERS is declared ${starts.length} times`);
  const at = lines[starts[0]!]!.length - lines[starts[0]!]!.trimStart().length;
  for (let k = starts[0]! + 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (l.trim() === '});' && l.length - l.trimStart().length === at) return lines.slice(starts[0]!, k + 1);
  }
  throw new Error('REPLACERS never closes');
}

/** A JSON value as text, its keys sorted at every depth: the same data gives the same text. */
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
};

/**
 * A data table's entries (#941), as parseTables gives its value: one per thing that can be lost or added.
 *   - An object: one for each key (that the key is there), and its value's entries under that key.
 *   - A list (`[]`) or a set (`$set`): one for being a list or a set, and one for each element. An element that is an
 *     object is known by its other fields (its strings, numbers and `$regexp`s, as `{"what": "the merge policy"}`):
 *     that is its entry, and its lists and objects give their entries under it, so a glob added to a part is an entry
 *     added, a glob taken out one lost, and a field changed takes every entry under it away. Any other element (a
 *     string, a list as a tuple) is an entry whole: a tuple changed is one lost and another added.
 *   - Anything else (a string, a number, a `$regexp`): itself.
 * So a key, an element or a value taken out or changed, or a list turned into a set or a string, is an entry lost.
 */
export function tableEntries(value: unknown): string[] {
  const out: string[] = [];
  const objectOf = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const itemsOf = (v: unknown) => {
    const o = objectOf(v);
    return Array.isArray(v) ? { tag: '[]', list: v } : o && Array.isArray(o.$set) && Object.keys(o).length === 1 ? { tag: '$set', list: o.$set as unknown[] } : null;
  };
  // A leaf: not a list, a set, or an object other than a `$regexp`.
  const leaf = (v: unknown) => !itemsOf(v) && !(objectOf(v) && !('$regexp' in objectOf(v)!));
  const walk = (v: unknown, at: string) => {
    const o = objectOf(v);
    const items = itemsOf(v);
    if (items) {
      out.push(`${at}${items.tag}`);
      for (const x of items.list) {
        const e = objectOf(x);
        if (!e || '$regexp' in e || itemsOf(x)) {
          out.push(`${at}${items.tag} ${canonical(x)}`);
          continue;
        }
        const id = `${at}${items.tag} ${canonical(Object.fromEntries(Object.entries(e).filter(([, f]) => leaf(f))))}`;
        out.push(id);
        for (const k of Object.keys(e).sort()) if (!leaf(e[k])) walk(e[k], `${id} ${JSON.stringify(k)}: `);
      }
    } else if (o && !('$regexp' in o)) {
      for (const k of Object.keys(o).sort()) {
        out.push(`${at}${JSON.stringify(k)}`);
        walk(o[k], `${at}${JSON.stringify(k)}: `);
      }
    } else out.push(`${at}${canonical(v)}`);
  };
  walk(value, '');
  return out;
}

/** What `a` has that `b` hasn't (as multisets). */
const missing = (a: string[], b: string[]): string[] => {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
};

const indent = (l: string) => l.length - l.trimStart().length;
/** A line as a table entry: trimmed, without a trailing comma (an entry added after the last one adds its comma). */
const entry = (l: string) => {
  const t = l.trim();
  return t.endsWith(',') ? t.slice(0, -1).trimEnd() : t;
};

/** `eval` or `Function` as a whole word (`eval (` with a space too): a name built at run time. */
const BUILT_NAME = /(?<![\w$])(?:eval|Function)(?![\w$])/;
const brackets = (l: string, set: string) => [...l].filter((c) => set.includes(c)).length;
/** A line without its `//` and `/* *\/` comments (never inside a string): one pass, so a bracket in a comment opens nothing. */
export function withoutComments(l: string): string {
  let out = '';
  let quote = '';
  for (let k = 0; k < l.length; k++) {
    const c = l[k]!;
    if (quote) {
      out += c;
      if (c === '\\') out += l[++k] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '\\') out += c + (l[++k] ?? ''); // an escape, as in a regex literal's `\/`
    else if (c === '/' && l[k + 1] === '/') break;
    else if (c === '/' && l[k + 1] === '*') {
      const end = l.indexOf('*/', k + 2);
      if (end === -1) break;
      k = end + 1;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
    }
  }
  return out;
}

/** Reserved words that can only come before an expression: a `/` after one starts a regex literal. */
const EXPRESSION_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'default', 'extends']);
/**
 * Other reserved words, and the contextual ones that can also be names (`of`, `await`, `yield`, TS's `as`): a `/` after
 * one of them is one it can't place (unsure). Any other word (a name, a number, `this`, `null`, `true`) ends an operand.
 */
const UNPLACED_WORD = new Set(['break', 'catch', 'class', 'const', 'continue', 'debugger', 'enum', 'export', 'finally', 'for', 'function', 'if', 'import', 'let', 'static', 'switch', 'try', 'var', 'while', 'with', 'of', 'yield', 'await', 'async', 'as', 'satisfies', 'keyof', 'infer', 'is', 'asserts', 'from', 'get', 'set', 'type', 'interface', 'declare', 'namespace', 'module', 'abstract', 'readonly', 'public', 'private', 'protected', 'implements', 'package', 'override', 'accessor', 'unique', 'out']);
/** Line terminators besides `\n`: each ends a `//` comment, and a quoted string or regex literal can't hold one unescaped. */
const OTHER_LINE_END = new Set([String.fromCharCode(13), String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);
/** Keywords whose `( ... )` is a condition, so a `/` after its `)` starts a regex literal (`if (x) /re/.test(s)`). */
const CONDITION_WORD = new Set(['if', 'while', 'for', 'with']);
const isWordChar = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$';

/**
 * Each line's code, read over the whole file at once (#886's round-5 review): the state (a string, a template and its
 * `${...}`, a regex literal, a comment) carries from line to line, so a line that closes a template, or a regex
 * literal that holds a quote, is read as what it is. Comments and the text of strings, templates and regex literals are
 * left out (the quotes and slashes are kept).
 *
 * It aims to decide a regex literal against a division only where that is certain (#886's rounds 6 and 7), and each
 * round's review has found a shape where it wasn't: what it reads is hardened by its tests, not proven. A `/` starts a
 * regex literal where an operand must come next (after `(`, `,`, `=`, `=>`, `:`, `;`, `[`, `{`, `?`, `&`, `|`, `*`,
 * `%`, `^`, `<`, a binary `+` or `-`, a unary `+`, `-`, `!` or `~` where an operand was expected, the `)` of `if`,
 * `while`, `for`, `for await` or `with`, or a reserved word that only comes before an expression), and is a division
 * right after an operand ends on the same line (a name, a number, a string, a regex literal, `]`). A word after a
 * member `.` or `#` is a name, never a keyword; one after a spread's `...` is read as it stands. Everywhere else, it
 * can't place it: after `}`, any other `)` or one with no `(`, a `>` that may close type arguments, `++` or `--`, TS's
 * non-null `x!`, a contextual word, `.`, or an operand on an earlier line (a semicolon may be inserted). It also
 * can't read a character outside printable ASCII, or whitespace other than a space, tab, CR or LF, outside a string
 * or comment. There, and where a string or regex runs off its line, it stops reading and every later character, of
 * every later line, and the whole line it gave up on, is the raw text (comments and strings included). From that line
 * on (`unsureFrom`) the checks that read it pair and skip nothing (#886's rounds 8 and 9). A hand-written reader of JS
 * can still be fooled by shapes not yet found: #941 replaces it with data-only JSON tables. One pass, no regex.
 */
export function codeLinesOf(text: string): string[] {
  return codeOf(text).lines;
}

/** codeLinesOf's lines, and the first line it gave up on (-1: it read the whole file). */
export function codeOf(text: string): { lines: string[]; unsureFrom: number } {
  const out: string[] = [];
  let line = '';
  let mode: 'code' | 'line-comment' | 'block-comment' | "'" | '"' | 'template' | 'regex' | 'class' = 'code';
  let unsure = false;
  let unsureFrom = -1;
  // It gives up on the line being read (or, for a string that ran off its line, the one just ended).
  const giveUp = (at = out.length) => {
    unsure = true;
    if (unsureFrom === -1) unsureFrom = at;
  };
  // The brace depth at each open template expression's `${`, and the code's brace depth.
  const holes: number[] = [];
  let depth = 0;
  // Each open `(`: whether it is a condition's; and whether the last `)` closed one (false: another, or none open).
  const parens: boolean[] = [];
  let lastParenCondition = false;
  // The last significant code character, the word ending at it (if it ends one), and the word before that one (`for`
  // in `for await`). What a `/` there would be: `expected` (an operand comes next: a regex literal), `ended` (an
  // operand just ended: a division, on the same line) or `unknown`; and whether a line ended since (a semicolon may be
  // inserted).
  let last = '';
  let word = '';
  let wordBefore = '';
  let wordAfterDot = false;
  let lastDotSpread = false;
  // Whether the `..` being read follows a number with no `.` of its own (`1..x`).
  let numberDots = false;
  // (Asserted, so the checks below read what sig set, not the start value.)
  let state = 'expected' as 'expected' | 'ended' | 'unknown';
  let lineSince = false;
  const sig = (c: string, w: string, s: typeof state) => {
    last = c;
    word = w;
    state = s;
    lineSince = false;
  };
  const newline = () => {
    out.push(line);
    line = '';
  };
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if (unsure) {
      if (c === '\n') newline();
      else line += c;
      continue;
    }
    if (c === '\n') {
      newline();
      if (mode === 'code' || mode === 'line-comment' || mode === 'block-comment') lineSince = true;
      if (mode === 'line-comment') mode = 'code';
      // A quoted string or a regex literal never runs past its line (an escaped newline is skipped below).
      else if (mode === "'" || mode === '"' || mode === 'regex' || mode === 'class') giveUp(out.length - 1);
      continue;
    }
    // The other line terminators end a `//` comment too, mid-line by this file's lines; one unescaped in a quoted
    // string or a regex literal is one it can't place.
    if (OTHER_LINE_END.has(c)) {
      if (mode === 'code' || mode === 'line-comment' || mode === 'block-comment') lineSince = true;
      if (mode === 'line-comment') mode = 'code';
      else if (mode === 'regex' || mode === 'class' || ((mode === "'" || mode === '"') && c === String.fromCharCode(13)) || (mode === 'code' && c !== String.fromCharCode(13))) {
        giveUp();
        line += c;
      }
      continue;
    }
    // A backslash in a string, template or regex escapes the next character (a newline included).
    if (c === '\\' && mode !== 'code' && mode !== 'line-comment' && mode !== 'block-comment') {
      const n = text[k + 1];
      if (n === undefined) continue;
      k++;
      if (n === '\n') newline();
      continue;
    }
    if (mode === 'line-comment') continue;
    if (mode === 'block-comment') {
      if (c === '*' && text[k + 1] === '/') {
        k++;
        mode = 'code';
      }
      continue;
    }
    if (mode === "'" || mode === '"') {
      if (c === mode) {
        line += c;
        mode = 'code';
        sig('"', '', 'ended');
      }
      continue;
    }
    if (mode === 'template') {
      if (c === '`') {
        line += c;
        mode = 'code';
        sig('"', '', 'ended');
      } else if (c === '$' && text[k + 1] === '{') {
        k++;
        line += '${';
        holes.push(depth);
        mode = 'code';
        sig('{', '', 'expected');
      }
      continue;
    }
    // A regex literal is only ever entered where it is certain, so its text is left out like a string's.
    if (mode === 'regex' || mode === 'class') {
      if (mode === 'class' && c === ']') mode = 'regex';
      else if (mode === 'regex' && c === '[') mode = 'class';
      else if (mode === 'regex' && c === '/') {
        line += c;
        mode = 'code';
        sig('"', '', 'ended');
      }
      continue;
    }
    // Code. A hashbang line is a comment; `<!--` and `-->` are comments in a script and code in a module: unsure.
    if (k === 0 && c === '#' && text[1] === '!') {
      mode = 'line-comment';
      continue;
    }
    // A character it doesn't read (#886's round 7): one outside printable ASCII (a name with a letter outside ASCII, a zero-width
    // joiner, a no-break space, a byte order mark), or whitespace other than a space or tab (a form feed, a vertical
    // tab). It can't tell what such a name or space makes of the words around it: unsure.
    const code = c.charCodeAt(0);
    if (code > 0x7e || (code < 0x20 && c !== '\t')) {
      giveUp();
      line += c;
      continue;
    }
    if (text.startsWith('<!--', k) || text.startsWith('-->', k)) {
      giveUp();
      line += c;
      continue;
    }
    if (c === '/' && text[k + 1] === '/') {
      mode = 'line-comment';
      k++;
      continue;
    }
    if (c === '/' && text[k + 1] === '*') {
      mode = 'block-comment';
      k++;
      continue;
    }
    if (c === '/') {
      // A regex literal where an operand must come next; a division right after one ends on the same line. Anything
      // else it can't place: unsure.
      const regex = state === 'expected' ? true : state === 'ended' && !lineSince ? false : null;
      line += c;
      if (regex === null) giveUp();
      else if (regex) mode = 'regex';
      else sig('/', '', 'expected');
      continue;
    }
    line += c;
    if (c === "'" || c === '"') mode = c;
    else if (c === '`') mode = 'template';
    else if (c === '{') {
      depth++;
      sig(c, '', 'expected');
    } else if (c === '}') {
      if (holes.length && holes[holes.length - 1] === depth) {
        holes.pop();
        mode = 'template';
        line = line.slice(0, -1);
      } else {
        depth--;
        // The end of a block or of an object literal: which, it can't tell.
        sig(c, '', 'unknown');
      }
    } else if (c === '(') {
      parens.push(isWordChar(last) && !wordAfterDot && (CONDITION_WORD.has(word) || (word === 'await' && wordBefore === 'for')));
      sig(c, '', 'expected');
    } else if (c === ')') {
      // A condition's `)`: a statement comes next. Any other, or one with no `(`: it can't place what follows.
      lastParenCondition = parens.pop() ?? false;
      sig(c, '', lastParenCondition ? 'expected' : 'unknown');
    } else if (c === ']') sig(c, '', 'ended');
    else if (isWordChar(c)) {
      const extends_ = k > 0 && isWordChar(text[k - 1]!) && isWordChar(last);
      // A word after a member `.` is a property (`x.in / 2`, `o.if(4)`), and one after `#` a private name
      // (`this.#if(4)`): never a keyword. One after a spread's `...` is read as it stands (`[...typeof /re/]`).
      if (!extends_) {
        wordAfterDot = (last === '.' && !lastDotSpread) || last === '#';
        wordBefore = isWordChar(last) ? word : '';
      }
      const w = extends_ ? word + c : c;
      sig(c, w, wordAfterDot ? 'ended' : EXPRESSION_KEYWORD.has(w) ? 'expected' : UNPLACED_WORD.has(w) ? 'unknown' : 'ended');
    } else if (c === '+' || c === '-') {
      // `++` or `--`: prefix or postfix, it can't tell. Otherwise binary after an operand, and unary where an operand
      // was expected: either way an operand comes next. After anything else (`}`, another `)`): it can't tell.
      sig(c, '', text[k - 1] === c ? 'unknown' : state === 'ended' || state === 'expected' ? 'expected' : 'unknown');
    } else if (c === '!' || c === '~') {
      // A unary operator where an operand was expected: one still is. After an operand (TS's non-null `x!`), or after
      // anything it can't place: it can't tell.
      sig(c, '', state === 'expected' ? 'expected' : 'unknown');
    } else if (c === '.') {
      // A `.` is a spread's only as part of exactly `...`: what follows a spread is read as it stands. A lone `.` is a
      // member's (or a number's own). In `1..x` the first is the number's own and the second a member's (#886's round
      // 8). Any other run of dots: it can't place it. A `/` right after any `.` can't be placed either.
      let s = k;
      while (text[s - 1] === '.') s--;
      let e = k;
      while (text[e + 1] === '.') e++;
      const run = e - s + 1;
      if (run === 2 && k === s) numberDots = isWordChar(last) && !wordAfterDot && word !== '' && [...word].every((d) => d >= '0' && d <= '9') && text[k - 1] === last;
      if (run === 3) lastDotSpread = true;
      else if (run === 1 || (run === 2 && numberDots)) lastDotSpread = false;
      else {
        giveUp();
        line += text.slice(k + 1, e + 1);
        k = e;
        continue;
      }
      sig(c, '', 'unknown');
    } else if (c === '>') {
      // `=>`: a body comes next. Any other `>` may close type arguments (`N<string> / 2`).
      sig(c, '', text[k - 1] === '=' ? 'expected' : 'unknown');
    } else if ('(,=:;[{?&|*%^<'.includes(c)) sig(c, '', 'expected');
    else if (c !== ' ' && c !== '\t') sig(c, '', 'unknown');
  }
  out.push(line);
  // The line it gave up on is read raw too, whole (a string or regex that ran off it may have hidden part of it as
  // text, #886's round 9).
  if (unsureFrom !== -1) out[unsureFrom] = text.split('\n')[unsureFrom] ?? out[unsureFrom]!;
  return { lines: out, unsureFrom };
}

/** A name for the global object (`globalThis`, `global`, `self`, `window`), each place it stands in a line's code. */
const GLOBAL_NAME = /(?<![\w$])(?:globalThis|global|self|window)(?![\w$])/g;
/** A declaration of `self` or `window` as a local, in a line's code. */
const LOCAL_SELF = /(?<![\w$])(?:const|let|var|function|class) (self|window)(?![\w$])/g;
/** A word that declares the name after it. */
const DECLARES_NEXT = /(?<![\w$])(?:const|let|var|function|class)$/;

/**
 * Whether a line's code uses a name for the global object (#886's round 5). Not as a property (`x.self`), a key
 * (`{ self: 1 }`), or the name a declaration declares; and not `self` or `window` where the file declares them as
 * locals (`localNames`: Node has neither global, and a file's own `const self` is common). `global` and `globalThis`
 * always count.
 */
function usesGlobalName(code: string, localNames: ReadonlySet<string>, previous: string, unsure: boolean): boolean {
  for (const m of code.matchAll(GLOBAL_NAME)) {
    // On a line the reader gave up on, the text is raw (comments and strings in it): no skip applies (#886's round 8).
    if (unsure) return true;
    const name = m[0];
    const before = code.slice(0, m.index).trimEnd();
    const after = code.slice(m.index + name.length).trimStart();
    if (before.endsWith('.') && !before.endsWith('...')) continue;
    // A key after `{` or `,`; first on its line, only when the code line before ends in one (a ternary's middle
    // operand `? \n globalThis : 0` is no key, #886's round 7).
    const keyPlace = before === '' ? previous.endsWith('{') || previous.endsWith(',') : before.endsWith('{') || before.endsWith(',');
    if (keyPlace && after.startsWith(':')) continue;
    if (DECLARES_NEXT.test(before)) continue;
    if ((name === 'self' || name === 'window') && localNames.has(name)) continue;
    return true;
  }
  return false;
}

/**
 * Whether a line's code has a computed key built from strings (`{ ['CHE' + 'CKS']: x }`): a `[...]` holding a quote,
 * where a key stands (after `{` or `,`, or first on its line), then `:`. A ternary's `? ['a'] : []` is no key.
 */
function computedStringKey(code: string, unsure: boolean): boolean {
  // A raw line: nothing paired (a `]` in a string or comment can't end the brackets early).
  if (unsure) return rawStringKey(code);
  for (let k = code.indexOf('['); k !== -1; k = code.indexOf('[', k + 1)) {
    const end = code.indexOf(']', k + 1);
    if (end === -1) return false;
    const inner = code.slice(k + 1, end);
    if (!(inner.includes("'") || inner.includes('"') || inner.includes('`'))) continue;
    const before = code.slice(0, k).trimEnd();
    const after = code.slice(end + 1).trimStart();
    // A bracket assignment of a name built from strings (`module.exports['CHE' + 'CKS'] = x`, #886's round 9), on
    // whatever object: it can bind the live table where the reader doesn't look.
    if ((inner.includes('+') || inner.includes('${')) && after.startsWith('=') && !after.startsWith('==') && !after.startsWith('=>')) return true;
    if (!(before === '' || before.endsWith('{') || before.endsWith(','))) continue;
    if (after.startsWith(':')) return true;
  }
  return false;
}

/** Whether a line's code ends with `const`, `let` or `var` and no name after it: the name is on another line. */
function namelessDeclaration(code: string): boolean {
  const t = code.trimEnd();
  return ['const', 'let', 'var'].some((w) => t.endsWith(w) && !/[\w$.]/.test(t.charAt(t.length - w.length - 1)));
}

/**
 * On a raw line (one the reader gave up on, or any line of a .jsx or .tsx file), what the line checks look for, with
 * nothing paired or skipped (#886's round 9): a `[` with a quote after it and then a `:` or `=` anywhere later (a key
 * or a bracket assignment of a string-built name, whatever a `]` in a string or comment does); a nameless declaration
 * with the line's comments taken out too.
 */
function rawStringKey(line: string): boolean {
  const open = line.indexOf('[');
  if (open === -1) return false;
  const quote = Math.min(...["'", '"', '`'].map((q) => line.indexOf(q, open + 1)).filter((n) => n !== -1));
  if (!Number.isFinite(quote)) return false;
  return line.indexOf(':', quote + 1) !== -1 || line.indexOf('=', quote + 1) !== -1;
}

/** A `with (` statement in a line's code: it binds an object's keys as names, so a table's name could read another list. */
const WITH_STATEMENT = /(?<![\w$.])with\s*\(/;

/**
 * A registered table's lines (as entries, blanks left out), or null when the text doesn't declare it. It is declared
 * by a line that starts `const NAME`, `export const NAME`, `let NAME` or `"NAME":`. It is that line alone when the line
 * closes every bracket it opens; else it runs to the first later line at the declaration's indent or less, which must
 * close it (`]`, `}`, `)`). Lines, not a parse, and never read around a surprise: a name declared twice (a decoy in a
 * comment), a line at the table's indent inside it (an entry or a comment at column 0), or no close throws, and the
 * change waits.
 */
export function tableLines(text: string, table: string): string[] | null {
  const span = tableSpan(text, table);
  return span === null ? null : text.split('\n').slice(span[0], span[1] + 1).filter((x) => x.trim()).map(entry);
}

/** Where tableLines reads a table: its first and last line numbers (0-based, inclusive), or null. Throws as tableLines does. */
export function tableSpan(text: string, table: string): [number, number] | null {
  const lines = text.split('\n');
  // `const`, `let` or `var` with any spacing, or a JSON key; table names are plain identifiers.
  const head = new RegExp(`^(?:export\\s+)?(?:(?:const|let|var)\\s+${table}|"${table}"\\s*:)(?![\\w$])`);
  const declares = (l: string) => head.test(l.trimStart());
  const starts = lines.flatMap((l, k) => (declares(l) ? [k] : []));
  if (!starts.length) return null;
  if (starts.length > 1) throw new Error(`${table} is declared ${starts.length} times`);
  const start = starts[0]!;
  const first = lines[start]!;
  const at = indent(first);
  // Its value: what follows the `=` (not an arrow's `=>`), or a JSON key's `:`. The list's opening bracket must be
  // there: a declaring line with none after it (a type, `= // see [docs]` with the list below) isn't read.
  const json = first.trimStart().startsWith('"');
  const code = json ? first : withoutComments(first);
  const eq = json ? code.indexOf('":') + 1 : code.search(/=(?!>)/);
  const value = eq < 1 ? '' : code.slice(eq + 1);
  if (!brackets(value, '[({')) throw new Error(`${table}: no bracket opens its list on the line that declares it`);
  if (brackets(value, '[({') === brackets(value, '])}')) {
    // A one-line table: nothing of it may follow on a deeper line (`= new Set()` with `.add(...)` below).
    const next = lines.slice(start + 1).find((l) => l.trim());
    if (next !== undefined && indent(next) > at) throw new Error(`${table}: its line closes, but the next line is deeper`);
    return [start, start];
  }
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (!l.trim() || indent(l) > at) continue;
    if (!']})'.includes(l.trim().charAt(0))) throw new Error(`${table}: line ${k + 1} is at its indent but doesn't close it`);
    return [start, k];
  }
  throw new Error(`${table} never closes`);
}

/** Each kind's first three places and how many there are: nothing kept per line. */
type Found = Map<Kind, { first: string[]; n: number }>;

/**
 * Why a change may weaken a test, lint or guard: one `design:` reason per kind, naming up to three places (a file, and
 * the line). Empty: it removes or loosens none of them. Pure: the caller reads the diff and the files (weakeningOf).
 * With `more`, each is measured too and a reason from any of them counts (weakeningOf's second measurement, #1069):
 * still one reason per kind, its places from all of them (a place named once), its count the largest one's. One over
 * MAX_CHANGED_CHARS gives only the reason that says so, beside the others' reasons (#1077).
 */
export function weakeningReasons(i: WeakeningInput, ...more: WeakeningInput[]): string[] {
  const all: Found = new Map();
  for (const one of [i, ...more]) {
    for (const [kind, at] of findings(one)) {
      const into = all.get(kind) ?? all.set(kind, { first: [], n: 0 }).get(kind)!;
      for (const p of at.first) if (into.first.length < 3 && !into.first.includes(p)) into.first.push(p);
      into.n = Math.max(into.n, at.n, into.first.length);
    }
  }
  const out: string[] = [];
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const at = all.get(kind);
    if (!at?.n) continue;
    out.push(`${WEAKENING_REASON}${KINDS[kind]} (${at.first.join('; ')}${at.n > at.first.length ? `; and ${at.n - at.first.length} more` : ''})`);
  }
  return out;
}

/** One change's findings, by kind; over MAX_CHANGED_CHARS, only the finding that says so. */
function findings(i: WeakeningInput): Found {
  const found: Found = new Map();
  const hit = (kind: Kind, path: string, what?: string) => {
    const at = found.get(kind) ?? found.set(kind, { first: [], n: 0 }).get(kind)!;
    at.n++;
    if (at.first.length < 3) {
      const place = what === undefined ? shownPath(path) : `${shownPath(path)}: ${escapedPath(what.length > 100 ? `${what.slice(0, 100)}...` : what)}`;
      if (!at.first.includes(place)) at.first.push(place);
      else at.n--;
    }
  };
  // Tests are tests in every repo: TEST_PATHS isn't the engine's own source.
  const isTest = matcher(TEST_PATHS, undefined);
  const guardFile = matcher([...GUARD_FILES, ...LINT_TESTS], i.scope);
  const isAllow = matcher(NEVER_GROW_FILES, i.scope);
  // The marks in each changed file that can hold one: at the change's base and at the default branch's current tip
  // (#869; a mark on the default branch holds whatever the base), and the same file's marks after the change.
  // Engine-only paths stand aside in a managed app's repo, as the central list's did. A file it can't read for them waits.
  const none = (): Registrations => ({ tables: [], lint: false, problems: [] });
  const marks = new Map<string, { was: Registrations; tip: Registrations; now: Registrations; deleted: boolean; inBase: boolean }>();
  for (const f of i.files) {
    const p = f.path;
    if (!MARKABLE.test(p) || !holds(p, i.scope) || marks.has(p)) continue;
    const fromBase = !i.marked || i.marked.has(p);
    const fromTip = i.tip !== undefined && (!i.tipMarked || i.tipMarked.has(p));
    if (!fromBase && !fromTip) continue;
    try {
      const b = fromBase ? i.before(p) : null;
      const t = fromTip ? i.tip!(p) : null;
      if (b === null && t === null) continue;
      const a = i.after(p);
      marks.set(p, { was: b === null ? none() : registrationsOf(b), tip: t === null ? none() : registrationsOf(t), now: a === null ? none() : registrationsOf(a), deleted: a === null, inBase: i.before(p) !== null });
    } catch (e) {
      hit('unreadable', p, String((e as Error).message ?? e));
    }
  }
  /** Whether a tip mark the head lacks was taken out by the change: the text where the change meets the tip has it. */
  const tookOut = (p: string, has: (r: Registrations) => boolean): boolean => {
    if (!i.meet) return true;
    try {
      const m = i.meet(p);
      return m !== null && has(registrationsOf(m));
    } catch {
      return true;
    }
  };
  // A lint test by its mark (at the base or the tip) is a guard file: any line taken out of it waits.
  const lintTests = new Set([...marks].filter(([, m]) => m.was.lint || m.tip.lint).map(([p]) => p));
  // Its mark gone or changed while the file stays: the next change could take its rules out unseen.
  for (const p of lintTests) {
    const m = marks.get(p)!;
    if (m.now.lint || m.deleted) continue;
    if (m.was.lint || tookOut(p, (r) => r.lint)) hit('registration-gone', p, LINT_MARK);
  }
  // A lint test registered on the default branch after the base, in a file the base doesn't have: the tip's lines
  // against the head's (the head merged it in), each one gone waits.
  for (const p of lintTests) {
    const m = marks.get(p)!;
    if (m.inBase || !m.tip.lint || m.deleted) continue;
    try {
      const [t, a] = [i.tip!(p), i.after(p)];
      if (t !== null && a !== null) for (const l of missing(t.split('\n'), a.split('\n'))) if (l.trim()) hit('guard-lines', p, l.trim());
    } catch (e) {
      hit('unreadable', p, String((e as Error).message ?? e));
    }
  }
  const isGuard = (p: string) => guardFile(p) || lintTests.has(p);
  const tables: (CheckTable & { marked?: boolean; atTip?: boolean })[] = [
    ...CHECK_TABLES.filter((t) => holds(t.path, i.scope)),
    ...[...marks].flatMap(([path, m]) => m.was.tables.map((t) => ({ path, ...t, marked: true }))),
    // The tip's marks the base hasn't (a table marked, or a marked table made, on the default branch after the base).
    ...[...marks].flatMap(([path, m]) => m.tip.tables.filter((t) => !m.was.tables.some((x) => x.table === t.table && x.kind === t.kind)).map((t) => ({ path, ...t, marked: true, atTip: true }))),
  ];
  // A tables file (#941): its tables are data, compared parsed (jsonTableFindings).
  const dataTables = (p: string) => TABLES_FILE.test(p) && holds(p, i.scope);
  // A test, guard, lint, allowlist or table file: its removed lines count, so its diff must be whole and text.
  const strict = (p: string) => isTest(p) || isGuard(p) || isAllow(p) || dataTables(p) || tables.some((t) => t.path === p);
  // A pure rename of a test (#783's deliverable): the same blob at a new path that the same runner still runs. Both
  // paths count as nothing when the two names match the same runner's pattern with the same suffix, under the same
  // test-folder root, the new one under no fixtures, snapshots, testdata or docs folder, and neither is a guard, lint,
  // allowlist or table file. Any other move is a delete and an add.
  const renamed = new Set<string>();
  const checkFile = (p: string) => isGuard(p) || isAllow(p) || dataTables(p) || tables.some((t) => t.path === p);
  for (const [from, to] of i.moved ?? []) {
    const runner = runnerOf(from);
    if (runner === -1 || runnerOf(to) !== runner || runnerSuffix(from) !== runnerSuffix(to)) continue;
    if (!isTest(from) || !isTest(to) || testRoot(from) !== testRoot(to) || NOT_RUN.test(to) || checkFile(from) || checkFile(to)) continue;
    // A leading-dot name, like a dot folder: compilers and runners' globs skip it.
    if (to.slice(to.lastIndexOf('/') + 1).startsWith('.')) continue;
    renamed.add(from).add(to);
  }
  const text = (l: string) => !l.includes('\0') && !l.includes('�');
  // Read: every file but a doc, a pure rename, and an asset that isn't text.
  const asset = (f: ChangeFile) => ASSET.test(f.path) && !strict(f.path) && !(f.addedLines ?? []).concat(f.removedLines ?? []).every(text);
  const read = i.files.filter((f) => !renamed.has(f.path) && (!isDoc(f.path) || strict(f.path)) && !asset(f));

  // The bound, before any line is read: over it, one reason and nothing else.
  let chars = 0;
  for (const f of read) for (const ls of [f.addedLines ?? [], f.removedLines ?? []]) for (const l of ls) chars += l.length + 1;
  if (chars > MAX_CHANGED_CHARS) return new Map([['unreadable', { first: [`the changed lines pass ${MAX_CHANGED_CHARS} characters`], n: 1 }]]);

  // A merge into the tip that conflicts in a file read strictly (or in one whose name it can't match): what GitHub's
  // merge makes there may not be the tree git wrote, so it waits. A conflict elsewhere is left to the conflict paths.
  for (const p of i.conflicts ?? []) if (strict(p) || isNonUtf8Path(p) || (MARKABLE.test(p) && holds(p, i.scope) && (!i.marked || i.marked.has(p)))) hit('tip-conflict', p);

  for (const f of read) {
    const added = f.addedLines ?? [];
    const removed = f.removedLines ?? [];
    // Marks are read on every added line, whatever else the file holds.
    for (const l of added) if (marked(l)) hit('marker', f.path, l.trim());
    // A file that isn't text (a NUL, or bytes that aren't UTF-8) can't be read line by line: it waits.
    if (!added.every(text) || !removed.every(text)) {
      hit('unreadable', f.path, 'not text');
      continue;
    }
    if (!strict(f.path)) continue;
    // The diff's lines against git's own counts: fewer means it was cut short or not read (a name git can't be handed).
    if (added.length !== f.added || removed.length !== f.removed) {
      hit('unreadable', f.path, `its diff has ${added.length} added and ${removed.length} removed lines, git counts ${f.added} and ${f.removed}`);
      continue;
    }
    // A tables file is judged by its parsed compare alone (#941, R1184l): an entry appended to a JSON list rewrites the
    // old last line (no trailing comma), so the removed-line rule would hold an addition the compare lets pass.
    const [test, fixture, guard, bats] = [isTest(f.path), isFixture(f.path), isGuard(f.path) && !dataTables(f.path), f.path.endsWith('.bats')];
    if (test && i.deleted.has(f.path)) hit('test-file-deleted', f.path);
    for (const l of removed) {
      const t = l.trim();
      if (!t) continue;
      if (test && fixture) hit('test-lines', f.path, t);
      else if (test && (CHECK_LINE.test(l) || (bats && BATS_LINE.test(l)))) hit('test-assertion', f.path, t);
      if (guard) hit('guard-lines', f.path, t);
    }
    if (isAllow(f.path)) for (const l of added) if (l.trim()) hit('allow-file', f.path, l.trim());
  }

  // The redaction replacers (R1184r D1): the data names each by key (`{"replacer": "stripe"}`), so each function body
  // is an entry of the table in code. A removed or changed line of the REPLACERS block, in the module or the updater's
  // generated copy, waits as a table's entry did when the function sat in the table (main).
  for (const f of i.files) {
    if (!REPLACER_FILES.test(f.path) || !holds(f.path, i.scope)) continue;
    let was: string[];
    let now: string[];
    try {
      [was, now] = [replacerLines(i.before(f.path)), replacerLines(i.after(f.path))];
    } catch (e) {
      hit('unreadable', f.path, String((e as Error).message ?? e));
      continue;
    }
    const block = new Set(was.map((l) => l.trim()));
    for (const l of f.removedLines ?? []) if (l.trim() && block.has(l.trim())) hit('table-shrunk', f.path, `REPLACERS: ${l.trim()}`);
    // An added line in the block (R1184s D2: `...({ stripe: … } as Partial<…>),` overrides a replacer and removes no
    // line): it passes only as a comment, or as one new replacer on one line, its name in neither the old block nor
    // anywhere else in the new one. Anything else (a spread, a computed or quoted key, get/set, a name used before, a
    // second property on the line, a replacer over several lines) waits.
    const keyOf = (l: string) => /^\s*([A-Za-z_$][\w$]*)\s*(?::|,\s*$|\()/.exec(l)?.[1];
    // Each line read as JS reads it: cut at a line terminator other than \n first (R1184w D1: a key after a `//` comment's
    // U+2028 is a key).
    const keys = (ls: string[]) => ls.slice(1, -1).flatMap((l) => l.split(LINE_BREAK).flatMap((s) => (/^\s*(?:\/\/|\/\*|\*)/.test(s) ? [] : [keyOf(s) ?? ''])));
    const [old, fresh] = [new Set(keys(was)), keys(now)];
    const inBlock = new Set(now.slice(1, -1));
    for (const l of f.addedLines ?? []) {
      if (!inBlock.has(l) || !l.trim()) continue;
      // A line terminator other than \n waits before any comment is skipped (R1184w D1: `// note<U+2028>...({ … }),`).
      if (LINE_BREAK.test(l)) {
        hit('table-shrunk', f.path, `REPLACERS: a line terminator inside a line: ${JSON.stringify(l.trim()).slice(0, 120)}`);
        continue;
      }
      if (/^\s*\/\//.test(l)) continue;
      // Exactly one property (R1184t D1: `zz: (m) => m, ...({ stripe: … }),` is a new key and then a spread): cut at its
      // commas outside brackets, the line is one part and an empty one after its last `,`, and it closes every bracket
      // it opens (a replacer over several lines waits from its first line). The part is `name: …`, `name(…) {…}` or
      // `name`: no spread, computed or quoted key, and no get/set. Brackets and commas count in code only (R1184v D1: a
      // `'('` or a `/* ( */` hid a spread at "depth 1"); a line with a regexp or a division, or a string, template or
      // comment it doesn't close, waits (topLevelParts). A comma in type arguments makes it wait too: fail closed.
      const parts = topLevelParts(l);
      const one = !!parts && parts.length === 2 && parts[1]!.trim() === '' && /^\s*[A-Za-z_$][\w$]*\s*(?::|\(|$)/.test(parts[0]!);
      const k = one ? keyOf(l) : undefined;
      const lone = !!k && !old.has(k) && fresh.filter((x) => x === k).length === 1;
      if (!lone) hit('table-shrunk', f.path, `REPLACERS: ${l.trim()}`);
    }
  }

  // A script's generated copy of its tables (R1184y Y6a): a line between its BEGIN and END markers changed while the
  // data it copies didn't is drift, never a regeneration, so it waits (main held the marked table so). The data is
  // judged as parsed (R1184aa D2: a blank line or keys reordered in the tables file is no change of data). With the
  // data changed too, the compare judges the data and test/table-copies.test.ts holds the copy to it.
  const sameData = (own: string): boolean => {
    if (!i.files.some((g) => g.path === own)) return true;
    try {
      const [b, a] = [i.before(own), i.after(own)];
      if (b === null || a === null) return false;
      const data = (text: string) => canonical([...parseTables(text, own)].map(([name, x]) => [name, x.kind, x.value]).sort((m, n) => (m[0] as string).localeCompare(n[0] as string)));
      return data(b) === data(a);
    } catch {
      return false; // a tables file that can't be read is held by the compare (unreadable)
    }
  };
  for (const f of i.files) {
    const own = tablesFileFor(f.path);
    if (!MARKABLE.test(f.path) || !i.tablesFiles?.has(own) || isTest(f.path) || !holds(f.path, i.scope) || !sameData(own)) continue;
    let was: Set<string>;
    let now: Set<string>;
    try {
      [was, now] = [copyLines(i.before(f.path)), copyLines(i.after(f.path))];
    } catch (e) {
      hit('unreadable', f.path, String((e as Error).message ?? e));
      continue;
    }
    for (const l of f.removedLines ?? []) if (was.has(l)) hit('table-shrunk', f.path, `a generated copy changed without its data: ${l.trim().slice(0, 120)}`);
    for (const l of f.addedLines ?? []) if (now.has(l)) hit('table-shrunk', f.path, `a generated copy changed without its data: ${l.trim().slice(0, 120)}`);
  }
  // R1184ag D1: a copy turned off by lines around it (the block in a comment or braces, a weaker table declared after
  // it), so no line of the block changes. Each table the base's copy declares is declared once after the change, as
  // main held for its marked tables ("declared N times"); and a changed line outside the block that names one of the
  // copy's tables (a use pointed elsewhere, a second declaration) waits.
  for (const f of i.files) {
    if (!MARKABLE.test(f.path) || !i.tablesFiles?.has(tablesFileFor(f.path)) || isTest(f.path) || !holds(f.path, i.scope)) continue;
    let b: string | null;
    let a: string | null;
    try {
      [b, a] = [i.before(f.path), i.after(f.path)];
    } catch (e) {
      hit('unreadable', f.path, String((e as Error).message ?? e));
      continue;
    }
    const names = [...new Set([...copyNames(b), ...copyNames(a)])];
    if (!names.length) continue;
    const [was, now] = [copyLines(b), copyLines(a)];
    for (const name of copyNames(b)) {
      const n = a === null ? 0 : declarations(a, name);
      if (n !== 1) hit('table-shrunk', f.path, `${name} is declared ${n} times`);
    }
    const named = new RegExp(`(?<![\\w$])(?:${names.join('|')})(?![\\w$])`);
    // R1184ah D1, R1184ai D1: a name written with escapes is the same name; a global, `with`, eval or Function can
    // answer a name the block no longer binds, so a changed line outside the block that uses one waits.
    const outside = (l: string) => named.test(unescapeIds(l)) || GLOBAL_REACH.test(unescapeIds(l));
    for (const l of f.removedLines ?? []) if (!was.has(l) && outside(l)) hit('table-used', f.path, `a copy's table named, or a global reached, outside its block: ${l.trim().slice(0, 120)}`);
    for (const l of f.addedLines ?? []) if (!now.has(l) && outside(l)) hit('table-used', f.path, `a copy's table named, or a global reached, outside its block: ${l.trim().slice(0, 120)}`);
    // R1184ai D2: the block is top-level code at the head as in the base (not put in a comment, a string or braces).
    // Read fail closed: a changed line before the block that holds a `/` in code, or a text the reading isn't sure of,
    // waits too.
    if (b !== null && a !== null) {
      const at = (text: string) => text.split('\n').findIndex((l) => l.startsWith('// BEGIN tables from '));
      const [kb, ka] = [at(b), at(a)];
      // Only the text before the block decides where it stands, so only that is read.
      // Read as written (R1184am D1: un-escaping first turned `\u0027` in a string into a quote, and `\u000a` in a comment
      // into a line break); an escape anywhere in it makes the reading unsure (copyCodeOf).
      const prefix = (text: string, k: number) => text.split('\n').slice(0, k + 1).join('\n');
      const [cb, ca] = [copyCodeOf(prefix(b, kb)), copyCodeOf(prefix(a, ka))];
      const same = kb >= 0 && ka >= 0 && JSON.stringify(cb.starts[kb]) === JSON.stringify(ca.starts[ka]);
      const before = a.split('\n').slice(0, Math.max(ka, 0));
      const changed = (k: number) => (f.addedLines ?? []).includes(before[k]!);
      const removedBefore = (f.removedLines ?? []).some((l) => b.split('\n').slice(0, Math.max(kb, 0)).includes(l) && !before.includes(l));
      // Unsure of the head's reading, or a changed line before the block holding a `/` in code, or (where even the
      // base's reading isn't sure) any changed line before it: it waits.
      const unsure = !ca.sure || before.some((_, k) => changed(k) && ca.slash.has(k)) || (!cb.sure && (before.some((_, k) => changed(k)) || removedBefore));
      if (!same || unsure) hit('table-shrunk', f.path, "the copy's block is not read as top-level code, as it is in the base");
    }
  }

  // The data tables (#941), compared before and after as parsed data.
  for (const f of i.files) if (dataTables(f.path)) jsonTableFindings(f.path, i.before, i.after, hit);
  // A tables file the change adds whose name differs only in case from another's (R1184l #4): on a checkout that folds
  // case, one is written over the other, and the module reads data the compare never saw. Folded as a file system may
  // fold it: NFKC first (U+017F, the long s, is an s), then lower case (R1184n N5).
  const fold = (p: string) => p.normalize('NFKC').toLowerCase();
  // The suffix is folded too (R1184r D3: `x.tables.JSON`, `x.Tables.json`, `x.tableſ.json` beside `x.tables.json`).
  const foldedTables = (p: string) => TABLES_FILE.test(fold(p)) && holds(p, i.scope);
  const tablesFiles = [...new Set([...(i.tablesFiles ?? []), ...i.files.map((f) => f.path).filter((p) => foldedTables(p) && !i.deleted.has(p))])];
  for (const f of i.files) {
    if (!foldedTables(f.path) || i.deleted.has(f.path) || i.tablesFiles?.has(f.path)) continue;
    const twin = tablesFiles.find((p) => p !== f.path && fold(p) === fold(f.path));
    if (twin) hit('table-gone', f.path, `its name differs only in case from ${twin}`);
    else if (!TABLES_FILE.test(f.path)) hit('unreadable', f.path, 'a tables file named in another case: the build and the loader read only `.tables.json`');
  }
  // A line that loads a table, removed or changed (#941, the owner's rule of 2026-11-08): the module's load
  // (`tablesOf(import.meta.url)`), any `.tables.json` name (an import, a require, a read), or a generated copy's marker.
  // It waits whatever replaces it: what the code reads after may not be the table the compare reads.
  // A test's lines are held by the test rules.
  // No line is skipped as a comment (R1184z Z1/Z2, R1184aa D1): whether a line that starts like one (`//`, `/*`, `*`)
  // is a comment or a template literal's text, a string's or a regexp's takes a full JS/TS lexer, and every hand-written
  // reading of it was wrong in some valid shape. So a load rule reads every changed line, a comment's included: a
  // comment that names the loader, a load line or an import.meta write waits for the owner, as code does (fail closed).
  for (const f of i.files) {
    if (!MARKABLE.test(f.path) || !holds(f.path, i.scope) || isTest(f.path)) continue;
    for (const l of f.removedLines ?? []) if (TABLE_LOAD.test(l)) hit('table-load-gone', f.path, l.trim());
    if (LOADER_CODE.has(f.path)) continue;
    for (const l of f.addedLines ?? []) {
      // A trailing comment is forgiven only for the plain import (R1184o); the other rules read the whole line (R1184q 2: a
      // `//` inside a template literal would cut the rest of the line off).
      const plainImport = LOADER_IMPORT.test(l) || LOADER_IMPORT.test(l.replace(/\s*\/\/[^'"`]*$/, ''));
      if ((LOADER_NAMED.test(l) && !plainImport) || metaUse(l)) hit('table-load-added', f.path, l.trim());
    }
  }

  // The registered tables, compared before and after, line by line.
  for (const t of tables) {
    if (!i.files.some((f) => f.path === t.path)) continue;
    let b: string | null;
    let a: string | null;
    try {
      [b, a] = [i.before(t.path), i.after(t.path)];
    } catch (e) {
      hit('unreadable', t.path, String((e as Error).message ?? e));
      continue;
    }
    let was: string[] | null;
    let now: string[] | null;
    try {
      [was, now] = [b === null ? null : tableLines(b, t.table), a === null ? null : tableLines(a, t.table)];
    } catch (e) {
      hit('unreadable', t.path, String((e as Error).message ?? e));
      continue;
    }
    const sameMark = (r: Registrations) => r.tables.some((x) => x.table === t.table && x.kind === t.kind);
    // A table registered on the default branch after the base, in a file whose base hasn't it: the tip's table against
    // the head's. Not in the head and never merged into it: only the default branch has it, and the merge keeps it.
    let fromTip = false;
    if (was === null && t.atTip) {
      if (now === null) {
        if (tookOut(t.path, sameMark)) hit('table-gone', t.path, t.table);
        continue;
      }
      try {
        const tt = i.tip!(t.path);
        was = tt === null ? null : tableLines(tt, t.table);
      } catch (e) {
        hit('unreadable', t.path, String((e as Error).message ?? e));
        continue;
      }
      fromTip = true;
    }
    // A table only after the change is new (a new lint and its list): nothing was loosened. The backstop test keeps
    // every registered table on the default branch. A mark stands right before its table's declaration, so its table
    // is always there before the change: one that isn't makes the change wait.
    if (was === null) {
      if (t.marked) hit('unreadable', t.path, `${t.table}: its mark stands before no table it can read`);
      continue;
    }
    if (now === null) {
      hit('table-gone', t.path, t.table);
      continue;
    }
    // Still there, no longer registered as it was (its mark removed, its kind changed, a line put between them): the
    // next change could loosen it unseen, so this one waits. A tip mark the head lacks waits only when the change took
    // it out (it is where the change meets the tip); a head older than the mark keeps it through the merge.
    const nowMarks = marks.get(t.path)?.now;
    if (t.marked && !(nowMarks && sameMark(nowMarks)) && (!t.atTip || tookOut(t.path, sameMark))) hit('registration-gone', t.path, `${TABLE_MARK}${t.kind} (${t.table})`);
    // The line that declared it, removed or changed: what reads as the table after may not be it (a decoy). It waits.
    const declaring = was[0]!;
    if (fromTip ? now[0] !== declaring : (i.files.find((f) => f.path === t.path)?.removedLines ?? []).some((l) => entry(l) === declaring)) {
      hit('unreadable', t.path, `${t.table}: the line that declares it is removed or changed`);
      continue;
    }
    const held = heldKinds(t.table, t.kind);
    if (held.has('never-grow')) for (const l of missing(now, was)) hit('table-grown', t.path, `${t.table}: ${l}`);
    if (held.has('never-shrink')) for (const l of missing(was, now)) hit('table-shrunk', t.path, `${t.table}: ${l}`);
    // An added line that names the table outside its own lines (`NAME[k] = v`, `Object.assign(NAME, ...)`,
    // `NAME.push(...)`, `{ ...NAME, ... }`) can grow or narrow it where the reader doesn't look: it waits. A plain
    // identifier match; a JSON table is data, never used by name in its file.
    if (t.path.endsWith('.json')) continue;
    const names = new RegExp(`(?<![\\w$])${t.table}(?![\\w$])`);
    // A line is the table's own only when every line of the file with its text is inside the table's lines: a copy of
    // an entry kept in a decoy table, then used outside it (`export const` with the name on the next line), isn't.
    const afterLines = a!.split('\n');
    let span: [number, number] | null = null;
    try {
      span = tableSpan(a!, t.table);
    } catch {
      span = null;
    }
    const own = (l: string) => span !== null && afterLines.every((x, k) => entry(x) !== entry(l) || (k >= span![0] && k <= span![1]));
    for (const l of i.files.find((f) => f.path === t.path)?.addedLines ?? []) {
      // A name built at run time (`eval('ALL' + 'OWED')`, `Function(...)`) has no identifier to match: it waits too.
      const built = BUILT_NAME.test(l);
      if ((names.test(l) && !own(l)) || built) hit('table-used', t.path, `${t.table}: ${l.trim()}`);
    }
  }

  // In a registered table's file, an added line that could give the live table a binding the line reader never matches
  // waits (#886's rounds 4 to 6): with the table's old lines kept as dead text (in a comment or a template), the live
  // one could be declared under a name written with a `\u` escape, or with its name on the next line, or bound on the
  // global object. So, in the line's code as codeLinesOf reads the whole file after the change (all of the file after
  // anything it can't place counts as code): a `\u`; a `const`, `let` or `var` with no name after it; a name for the
  // global object (usesGlobalName); or a computed key built from strings where a key stands.
  const tableFiles = new Set(tables.filter((t) => !t.path.endsWith('.json') && i.files.some((f) => f.path === t.path)).map((t) => t.path));
  for (const p of tableFiles) {
    const added = new Set(i.files.find((f) => f.path === p)?.addedLines ?? []);
    let text: string | null;
    try {
      text = i.after(p);
    } catch (e) {
      hit('unreadable', p, String((e as Error).message ?? e));
      continue;
    }
    if (text === null || !added.size) continue;
    const lines = text.split('\n');
    // JSX text isn't JS: in a .jsx or .tsx file every line reads as code.
    const read = /\.[jt]sx$/.test(p) ? { lines, unsureFrom: 0 } : codeOf(text);
    const code = read.lines;
    // From the first line the reader gave up on (that line included), the text is raw: the global-name check skips
    // nothing there, the computed-key check pairs no brackets, and a nameless declaration is also looked for with the
    // line's comments taken out (#886's rounds 8 and 9).
    const unsureAt = (k: number) => read.unsureFrom !== -1 && k >= read.unsureFrom;
    const localNames = new Set(code.filter((_, k) => !unsureAt(k)).flatMap((c) => [...c.matchAll(LOCAL_SELF)].map((m) => m[1]!)));
    // The code line before each line that has code (for a key first on its line).
    let previous = '';
    lines.forEach((l, k) => {
      const c = code[k] ?? l;
      const unsure = unsureAt(k);
      const nameless = namelessDeclaration(c) || (unsure && namelessDeclaration(withoutComments(c)));
      if (added.has(l) && (c.includes('\\u') || nameless || WITH_STATEMENT.test(c) || usesGlobalName(c, localNames, previous, unsure) || computedStringKey(c, unsure))) hit('table-hidden', p, l.trim());
      if (c.trim()) previous = c.trimEnd();
    });
  }
  return found;
}

/**
 * A tables file's change (#941), read as data with the loader's own parser (src/check-tables.ts parseTables), never
 * run: the file gone takes each of its tables with it; a table gone, or its kind changed, waits; a never-shrink table
 * waits on an entry lost or changed (tableEntries), a never-grow one on an entry added or changed, each by its kind
 * and its name's floor (heldKinds). A new file, or a new table, adds nothing to hold. A file that doesn't parse, before
 * or after, or can't be read, waits.
 */
export function jsonTableFindings(path: string, before: (p: string) => string | null, after: (p: string) => string | null, hit: (kind: Kind, path: string, what?: string) => void): void {
  let was: Map<string, ParsedTable> | null;
  let now: Map<string, ParsedTable> | null;
  try {
    const [b, a] = [before(path), after(path)];
    was = b === null ? null : parseTables(b, path);
    now = a === null ? null : parseTables(a, path);
  } catch (e) {
    hit('unreadable', path, String((e as Error).message ?? e));
    return;
  }
  if (was === null) return;
  for (const [name, t] of was) {
    const n = now?.get(name);
    if (!n) {
      hit('table-gone', path, name);
      continue;
    }
    if (n.kind !== t.kind) hit('registration-gone', path, `${name}: ${t.kind} -> ${n.kind}`);
    const [b, a] = [tableEntries(t.value), tableEntries(n.value)];
    // exact (#941, R1184n): an entry added, lost or changed waits, as for a table whose any change loosens it.
    const held = t.kind === 'exact' ? new Set<TableKind>(['never-shrink', 'never-grow']) : heldKinds(name, t.kind);
    if (held.has('never-shrink')) for (const e of missing(b, a)) hit('table-shrunk', path, `${name}: ${e}`);
    if (held.has('never-grow')) for (const e of missing(a, b)) hit('table-grown', path, `${name}: ${e}`);
  }
}

/**
 * weakeningReasons for the change base..head of the repo at `cwd`, with `files` from changeFiles. When the change
 * can't be read, one reason says so: the change waits (fail closed).
 *
 * base..head alone doesn't say what merging the PR does to the default branch (#1069). A head that merged in commits of
 * the default branch (the tip, or an older one, also one that reached it through a merge commit) can take out again a
 * line or a file the tip added, or put back a line the tip took out, and no removed or added line shows. And git
 * carries a stale PR's change onto a table or lint test the tip has since renamed or moved and marked (#1056's round
 * 16 review). So the change merging the PR makes to the default branch is measured too, for every PR: from the tip to
 * the tree of the tip merged with the head (git merge-tree, no worktree), and a reason from either measurement holds
 * it. A merge that conflicts is measured the same way, from the tip to the tree git writes for it, its conflicted
 * files left out (#1077): their markers aren't lines either side wrote. A conflict on where a file goes or whether it
 * stays (not on its lines) in a file the hold reads strictly waits instead: GitHub's own merge may complete there (a
 * file added under a folder the tip renamed), and what it makes is never read. A conflict on a file's lines, and any
 * conflict elsewhere, is left to the conflict paths (GitHub, merging the same commits, reports it; the conflict fix,
 * or the combined check's capped wait), and the head that resolves it is measured again, both ways. When the second
 * measurement can't run, its reason is given beside the first one's.
 */
export function weakeningOf(cwd: string, base: string, head: string, files: ChangeFile[], scope: LockScope | undefined, tip: string | null): string[] {
  const couldNotRun = (e: unknown) => `${WEAKENING_REASON}the check for a removed or weakened test, lint or guard could not run (${escapedPath(String((e as Error).message ?? e).slice(0, 200))})`;
  try {
    // The default branch's current tip, fetched by the caller at decision time: its marks hold whatever the base. One
    // it couldn't read makes the change wait.
    if (tip === null) throw new Error(`the default branch's current tip couldn't be read, so its registered checks can't be`);
    // Where the change meets the tip: a tip mark the head lacks was taken out by the change only if it is there.
    const meet = mergeBaseOf(cwd, tip, head);
    const own = measured(cwd, base, head, files, scope, { tip, meet });
    let merged: WeakeningInput | { failed: unknown };
    try {
      const { tree, conflicts, contentOnly } = mergedTree(cwd, tip, head);
      const conflicted = new Set(conflicts);
      merged = measured(cwd, tip, tree, changeFiles(cwd, tip, tree).filter((f) => !conflicted.has(f.path)), scope, undefined, conflicts.filter((p) => !contentOnly.has(p)));
    } catch (e) {
      merged = { failed: e };
    }
    return 'failed' in merged ? [...weakeningReasons(own), couldNotRun(merged.failed)] : weakeningReasons(own, merged);
  } catch (e) {
    return [couldNotRun(e)];
  }
}

/**
 * The input weakeningReasons reads for the change from..to (commits or trees), read from git; throws when git fails.
 * With `at`, the default branch's tip and where `to` meets it: their marks are read as well as `from`'s (#869). With
 * `conflicts`, the paths a merge `to` is the tree of conflicts on (their marks at `from` are read too).
 */
function measured(cwd: string, from: string, to: string, files: ChangeFile[], scope: LockScope | undefined, at?: { tip: string; meet: string }, conflicts?: string[]): WeakeningInput {
  const deleted = new Set(changedNames(cwd, ['--diff-filter=D', `${from}..${to}`]));
  const moved = exactMoves(cwd, from, to);
  // The files that hold a mark's text before the change and at the tip (#869): git grep over each whole tree, so a
  // mark is found wherever it is; a git failure makes the change wait.
  const markable = (set: Set<string>) => new Set([...files.map((f) => f.path), ...(conflicts ?? [])].filter((p) => set.has(p) && MARKABLE.test(p) && !isNonUtf8Path(p)));
  const marked = markable(new Set(filesWithText(cwd, from, [TABLE_MARK.trimEnd(), LINT_MARK])));
  const tipMarked = at ? markable(new Set(filesWithText(cwd, at.tip, [TABLE_MARK.trimEnd(), LINT_MARK]))) : new Set<string>();
  // The base's tables files, for the case-folded name check: by path, from its tree (R1184n N4: by text, a file
  // spelling its keys with escapes wasn't one).
  const tablesFiles = new Set([...presentNames(cwd, from)].filter((p) => TABLES_FILE.test(p)));
  // A file with a tables file of its own beside it is read too: a script's generated copy (R1184y Y6a).
  const ownData = (f: ChangeFile) => MARKABLE.test(f.path) && tablesFiles.has(tablesFileFor(f.path));
  const paths = [...new Set([...CHECK_TABLES.map((t) => t.path), ...marked, ...tipMarked, ...files.filter((f) => TABLES_FILE.test(f.path) || REPLACER_FILES.test(f.path) || ownData(f)).map((f) => f.path)])].filter((p) => files.some((f) => f.path === p) && !isNonUtf8Path(p));
  // A file over the cap isn't read at all: the change waits.
  const side = (rev: string) => {
    const { texts, tooBig } = filesAt(cwd, rev, paths, MAX_TABLE_FILE);
    return (p: string) => {
      if (tooBig.has(p)) throw new Error(`${tooBig.get(p)} bytes, over ${MAX_TABLE_FILE}: not read`);
      return texts.get(p) ?? null;
    };
  };
  const input: WeakeningInput = { files, deleted, moved, before: side(from), after: side(to), scope, marked, tablesFiles, ...(conflicts ? { conflicts } : {}) };
  return at ? { ...input, tip: side(at.tip), tipMarked, meet: side(at.meet) } : input;
}
