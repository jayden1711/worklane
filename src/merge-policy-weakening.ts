// Whether a change removes or weakens a test, a lint or a guard (#783): such a change waits for the owner, whatever
// its review level. The owner's rule is that no agent removes or weakens a check without the owner's OK. This makes
// it part of the merge decision, a runtime check on the change's own diff: mergeDecision gets a `design:` reason from
// what the change does, never from the evaluator's text.
//
// The rule is the owner's (2026-10-19), read line by line from the diff, with no parser:
//   - a test file (TEST_PATHS): a removed line (a changed line is a removed one and an added one) with an assertion or
//     a test on it (CHECK_LINE); a deleted test file;
//   - a test's expected output (a snapshot, a fixture, any test file that isn't code): any removed line;
//   - a guard or lint file (GUARD_FILES, LINT_TESTS): any removed line;
//   - a registered table (CHECK_TABLES), its lines from its declaration to its close: a line gone from a rule list, a
//     bad-fixture list or a guard's list (never-shrink), or new in an allowlist or exception list (never-grow);
//   - an allowlist file (NEVER_GROW_FILES): any added line;
//   - any file but docs: an added line with a skip, only or suppression marker on it (MARKERS, owner, 2026-10-19).
// Other pure additions pass: an added assertion, test, rule or guard line never waits.
//
// Bounded and fail closed: one pass over each changed line of the files it checks, with substrings and linear
// patterns only (no quantifier); over MAX_CHANGED_CHARS of such lines, a diff that doesn't match its line counts (cut short), a file that
// isn't text, a table it can't find or a git failure, the change waits. The engine's own source paths (ENGINE_ONLY)
// stand aside in a managed app's repo, as the locks do there (src/review.ts lockedCategories).
import { BRAND } from './brand.js';
import { changedNames, exactMoves, filesAt } from './coordinator/change-files.js';
import { globToRegExp } from './guardrails/glob.js';
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
 * Every check table the hold reads. A lint test's allowlist (OUTSIDE_THE_HELPER, ALLOWED, REVIEWED, ...) is here
 * however its file is locked: a tests-only change that adds an entry would otherwise be L0. A backstop test in
 * test/merge-policy.test.ts fails on a check-shaped table in test/ or scripts/ that is neither here nor in its
 * NOT_A_CHECK, and on an entry here whose table the hold can't find.
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
  { path: 'test/merge-policy.test.ts', table: 'NOT_A_CHECK', kind: 'never-grow' },
  { path: 'test/merge-policy.test.ts', table: 'NOT_A_LINT', kind: 'never-grow' },
  { path: 'test/review-packet.test.ts', table: 'PACKET_ALLOWED', kind: 'never-grow' },
  { path: 'test/raw-check-reads.ts', table: 'RAW_READS_ALLOWED', kind: 'never-grow' },
  { path: 'test/raw-check-reads.ts', table: 'JUDGED_CASTS_ALLOWED', kind: 'never-grow' },
  { path: 'test/raw-check-reads.ts', table: 'MAKERS_ALLOWED', kind: 'never-grow' },
  { path: 'test/owner-terminal-rerun.test.ts', table: 'FIRST_TIME_ONLY', kind: 'never-grow' },
  { path: 'scripts/lib/denylist.mjs', table: 'SKIP', kind: 'never-grow' },
  { path: 'src/guardrails/engine.ts', table: 'AGENT_EDITABLE', kind: 'never-grow' },
  // The lints' rules and bad fixtures, and the guards' lists: taking one out is a loosening.
  { path: 'test/change-files-renames.test.ts', table: 'READER_WORDS', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'LOCK_SCOPE_BAD', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_MODULES', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_ENTRIES', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_TREE', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'SLOT_NAMES', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'WRITE_CALLS', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'CHMOD_BY_NAME', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'FD_WRITES', kind: 'never-shrink' },
  { path: 'test/slot-path.test.ts', table: 'MAKER_ONLY', kind: 'never-shrink' },
  { path: 'test/add-project.test.ts', table: 'NAMES_BAD', kind: 'never-shrink' },
  { path: 'test/add-project.test.ts', table: 'REPOS_BAD', kind: 'never-shrink' },
  { path: 'test/instance-name.test.ts', table: 'BAD_SHAPE', kind: 'never-shrink' },
  { path: 'scripts/lib/changelog.mjs', table: 'GUARDRAIL_PATHS', kind: 'never-shrink' },
  { path: 'test/machine-path-writes.test.ts', table: 'GUARD', kind: 'never-shrink' },
  // The golden runner settings (#856): the deny list and hooks a run's --settings must carry.
  { path: 'test/runner-golden.test.ts', table: 'GUARD', kind: 'never-shrink' },
  // The guards' own tables (their files are guard files too; the table names what was taken out).
  { path: 'src/review.ts', table: 'SELF_MODIFICATION_PARTS', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'LOCKED_CATEGORIES', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'ODD_PATH_CATEGORIES', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'ALWAYS_L3', kind: 'never-shrink' },
  { path: 'src/merge-policy.ts', table: 'FLOOR', kind: 'never-shrink' },
  { path: 'src/hook-imports.ts', table: 'HOOK_IMPORTS', kind: 'never-shrink' },
  { path: 'src/delegation.ts', table: 'NEVER_LOOSEN', kind: 'never-shrink' },
  { path: 'src/guardrails/engine.ts', table: 'BUILTIN_PROTECTED', kind: 'never-shrink' },
  { path: `scripts/machine/${BRAND.cli}-machine.cjs`, table: 'POLICY_ONLY', kind: 'never-shrink' },
  { path: 'scripts/push-gate-hook.mjs', table: 'GATE_RULES', kind: 'never-shrink' },
  { path: 'scripts/push-gate-hook.mjs', table: 'GATE_CODE', kind: 'never-shrink' },
  { path: 'scripts/push-gate.mjs', table: 'ATTRIBUTION', kind: 'never-shrink' },
  // The commands that run the checks: a script dropped or changed (a lint taken out of `npm test`) waits.
  { path: 'package.json', table: 'scripts', kind: 'never-shrink' },
];

/**
 * Lint tests whose rules live in their code, not (only) in a registered table: any line removed from one holds, as
 * from a guard file. A backstop test in test/merge-policy.test.ts fails on a test that walks the sources and is in
 * neither this list nor its NOT_A_LINT.
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
  'test/policy-edit.test.ts',
  'test/testrun-measure.test.ts',
  'test/update-helpers.test.ts',
  'test/web-buttons.test.ts',
  'test/superfan.test.ts',
  'test/claude-accounts-retired.test.ts',
];

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
  const res = globs.filter((g) => holds(g, scope)).map((g) => globToRegExp(g));
  return (p: string) => res.some((re) => re.test(p));
};

export interface WeakeningInput {
  files: ChangeFile[];
  /** The paths the change deletes. */
  deleted: ReadonlySet<string>;
  /** Deleted paths whose exact blob the change adds at a new path, old path to new (a pure rename). */
  moved?: ReadonlyMap<string, string>;
  /** A file's text before the change (null: it wasn't there), for the files with a registered table only. */
  before: (path: string) => string | null;
  /** A file's text after the change (null: it isn't there), for the files with a registered table only. */
  after: (path: string) => string | null;
  scope: LockScope | undefined;
}

/** Each kind of weakening, in the words a reason uses, in the order reasons are given. */
const KINDS = {
  unreadable: "can't read a change to check it, so it may weaken a check",
  'test-file-deleted': 'deletes a test file',
  'test-assertion': 'removes or changes a line with an assertion or a test on it',
  'test-lines': "removes or changes a line of a test's expected output or fixture",
  'table-gone': "removes or renames a check's or guard's table",
  'table-shrunk': "removes or changes an entry in a check's rules or a guard's list",
  'table-grown': 'adds or changes an entry in an allowlist, exception or good-fixture list',
  'allow-file': "adds a line to an allowlist file or a package manager's settings file",
  'table-used': "changes a check's or guard's table outside its own list",
  'guard-lines': 'removes or changes a line of a guard or lint',
  marker: 'adds a line with a skip, only or lint or type-check suppression mark',
} as const;

type Kind = keyof typeof KINDS;

/** The reasons' common start: each is a design-level hold. */
export const WEAKENING_REASON = 'design: may weaken a check: ';

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

/**
 * A registered table's lines (as entries, blanks left out), or null when the text doesn't declare it. It is declared
 * by a line that starts `const NAME`, `export const NAME`, `let NAME` or `"NAME":`. It is that line alone when the line
 * closes every bracket it opens; else it runs to the first later line at the declaration's indent or less, which must
 * close it (`]`, `}`, `)`). Lines, not a parse, and never read around a surprise: a name declared twice (a decoy in a
 * comment), a line at the table's indent inside it (an entry or a comment at column 0), or no close throws, and the
 * change waits.
 */
export function tableLines(text: string, table: string): string[] | null {
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
    return [entry(first)];
  }
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (!l.trim() || indent(l) > at) continue;
    if (!']})'.includes(l.trim().charAt(0))) throw new Error(`${table}: line ${k + 1} is at its indent but doesn't close it`);
    return lines.slice(start, k + 1).filter((x) => x.trim()).map(entry);
  }
  throw new Error(`${table} never closes`);
}

/**
 * Why a change may weaken a test, lint or guard: one `design:` reason per kind, naming up to three places (a file, and
 * the line). Empty: it removes or loosens none of them. Pure: the caller reads the diff and the files (weakeningOf).
 */
export function weakeningReasons(i: WeakeningInput): string[] {
  // Each kind's first three places and how many there are: nothing kept per line.
  const found = new Map<Kind, { first: string[]; n: number }>();
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
  const isGuard = matcher([...GUARD_FILES, ...LINT_TESTS], i.scope);
  const isAllow = matcher(NEVER_GROW_FILES, i.scope);
  const tables = CHECK_TABLES.filter((t) => holds(t.path, i.scope));
  // A test, guard, lint, allowlist or table file: its removed lines count, so its diff must be whole and text.
  const strict = (p: string) => isTest(p) || isGuard(p) || isAllow(p) || tables.some((t) => t.path === p);
  // A pure rename of a test (#783's deliverable): the same blob at a new path that the same runner still runs. Both
  // paths count as nothing when the two names match the same runner's pattern with the same suffix, under the same
  // test-folder root, the new one under no fixtures, snapshots, testdata or docs folder, and neither is a guard, lint,
  // allowlist or table file. Any other move is a delete and an add.
  const renamed = new Set<string>();
  const checkFile = (p: string) => isGuard(p) || isAllow(p) || tables.some((t) => t.path === p);
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
  if (chars > MAX_CHANGED_CHARS) return [`${WEAKENING_REASON}${KINDS.unreadable} (the changed lines pass ${MAX_CHANGED_CHARS} characters)`];

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
    const [test, fixture, guard, bats] = [isTest(f.path), isFixture(f.path), isGuard(f.path), f.path.endsWith('.bats')];
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
    // A table only after the change is new (a new lint and its list): nothing was loosened. The backstop test keeps
    // every registered table on the default branch.
    if (was === null) continue;
    if (now === null) {
      hit('table-gone', t.path, t.table);
      continue;
    }
    // The line that declared it, removed or changed: what reads as the table after may not be it (a decoy). It waits.
    const declaring = was[0]!;
    if ((i.files.find((f) => f.path === t.path)?.removedLines ?? []).some((l) => entry(l) === declaring)) {
      hit('unreadable', t.path, `${t.table}: the line that declares it is removed or changed`);
      continue;
    }
    if (t.kind === 'never-grow') for (const l of missing(now, was)) hit('table-grown', t.path, `${t.table}: ${l}`);
    else for (const l of missing(was, now)) hit('table-shrunk', t.path, `${t.table}: ${l}`);
    // An added line that names the table outside its own lines (`NAME[k] = v`, `Object.assign(NAME, ...)`,
    // `NAME.push(...)`, `{ ...NAME, ... }`) can grow or narrow it where the reader doesn't look: it waits. A plain
    // identifier match; a JSON table is data, never used by name in its file.
    if (t.path.endsWith('.json')) continue;
    const names = new RegExp(`(?<![\\w$])${t.table}(?![\\w$])`);
    const own = new Set(now);
    for (const l of i.files.find((f) => f.path === t.path)?.addedLines ?? []) {
      // A name built at run time (`eval('ALL' + 'OWED')`, `Function(...)`) has no identifier to match: it waits too.
      const built = BUILT_NAME.test(l);
      if ((names.test(l) && !own.has(entry(l))) || built) hit('table-used', t.path, `${t.table}: ${l.trim()}`);
    }
  }

  const out: string[] = [];
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const at = found.get(kind);
    if (!at?.n) continue;
    out.push(`${WEAKENING_REASON}${KINDS[kind]} (${at.first.join('; ')}${at.n > at.first.length ? `; and ${at.n - at.first.length} more` : ''})`);
  }
  return out;
}

/**
 * weakeningReasons for the change base..head of the repo at `cwd`, with `files` from changeFiles. When the change
 * can't be read, one reason says so: the change waits (fail closed).
 */
export function weakeningOf(cwd: string, base: string, head: string, files: ChangeFile[], scope: LockScope | undefined): string[] {
  try {
    const deleted = new Set(changedNames(cwd, ['--diff-filter=D', `${base}..${head}`]));
    const moved = exactMoves(cwd, base, head);
    const paths = [...new Set(CHECK_TABLES.map((t) => t.path))].filter((p) => files.some((f) => f.path === p) && !isNonUtf8Path(p));
    // A file over the cap isn't read at all: the change waits.
    const side = (rev: string) => {
      const { texts, tooBig } = filesAt(cwd, rev, paths, MAX_TABLE_FILE);
      return (p: string) => {
        if (tooBig.has(p)) throw new Error(`${tooBig.get(p)} bytes, over ${MAX_TABLE_FILE}: not read`);
        return texts.get(p) ?? null;
      };
    };
    return weakeningReasons({ files, deleted, moved, before: side(base), after: side(head), scope });
  } catch (e) {
    return [`${WEAKENING_REASON}the check for a removed or weakened test, lint or guard could not run (${escapedPath(String((e as Error).message ?? e).slice(0, 200))})`];
  }
}
