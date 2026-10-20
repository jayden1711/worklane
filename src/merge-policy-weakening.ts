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
//   - a registration mark the default branch has, gone or changed while what it registers is still there (#869);
//   - an allowlist file (NEVER_GROW_FILES): any added line;
//   - any file but docs: an added line with a skip, only or suppression marker on it (MARKERS, owner, 2026-10-19).
// Other pure additions pass: an added assertion, test, rule or guard line never waits.
//
// Bounded and fail closed: one pass over each changed line of the files it checks, with substrings and linear
// patterns only (no quantifier); over MAX_CHANGED_CHARS of such lines, a diff that doesn't match its line counts (cut short), a file that
// isn't text, a table it can't find or a git failure, the change waits. The engine's own source paths (ENGINE_ONLY)
// stand aside in a managed app's repo, as the locks do there (src/review.ts lockedCategories).
import { BRAND } from './brand.js';
import { changedNames, exactMoves, filesAt, filesWithText } from './coordinator/change-files.js';
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
 * A check registers itself where it is declared (#869), so adding one never needs an edit here:
 *   - a table: the line right before its `const`/`let`/`var` declaration is exactly TABLE_MARK and its kind
 *     (`never-grow` for an allowlist, an exception list or good fixtures; `never-shrink` for rules, bad fixtures or a
 *     guard's list);
 *   - a lint test (one whose rules live in its code, so any line taken out of it waits, as from a guard file): a line
 *     that is exactly LINT_MARK, near its top.
 * Marks are read only in JS and TS files (MARKABLE), from the text before the change: what the default branch
 * registers. A mark a change adds holds from the next change on; one it removes, changes or detaches from its table
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
 * registered nor in its NOT_A_CHECK, on a registered table the hold can't find, and on a kind against its name.
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
}

/** Each kind of weakening, in the words a reason uses, in the order reasons are given. */
const KINDS = {
  unreadable: "can't read a change to check it, so it may weaken a check",
  'test-file-deleted': 'deletes a test file',
  'test-assertion': 'removes or changes a line with an assertion or a test on it',
  'test-lines': "removes or changes a line of a test's expected output or fixture",
  'table-gone': "removes or renames a check's or guard's table",
  'registration-gone': 'removes or changes the mark that registers a check, a check-table or lint-test line',
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
  const guardFile = matcher([...GUARD_FILES, ...LINT_TESTS], i.scope);
  const isAllow = matcher(NEVER_GROW_FILES, i.scope);
  // The marks the default branch has (#869), in each changed file that can hold one, and the same file's marks after
  // the change. Engine-only paths stand aside in a managed app's repo, as the central list's did. A file it can't read
  // for them waits.
  const marks = new Map<string, { was: Registrations; now: Registrations; deleted: boolean }>();
  for (const f of i.files) {
    const p = f.path;
    if (!MARKABLE.test(p) || !holds(p, i.scope) || (i.marked && !i.marked.has(p)) || marks.has(p)) continue;
    try {
      const b = i.before(p);
      if (b === null) continue;
      const a = i.after(p);
      marks.set(p, { was: registrationsOf(b), now: a === null ? { tables: [], lint: false, problems: [] } : registrationsOf(a), deleted: a === null });
    } catch (e) {
      hit('unreadable', p, String((e as Error).message ?? e));
    }
  }
  // A lint test by its mark is a guard file: any line taken out of it waits.
  const lintTests = new Set([...marks].filter(([, m]) => m.was.lint).map(([p]) => p));
  // Its mark gone or changed while the file stays: the next change could take its rules out unseen.
  for (const p of lintTests) if (!marks.get(p)!.now.lint && !marks.get(p)!.deleted) hit('registration-gone', p, LINT_MARK);
  const isGuard = (p: string) => guardFile(p) || lintTests.has(p);
  const tables: (CheckTable & { marked?: boolean })[] = [
    ...CHECK_TABLES.filter((t) => holds(t.path, i.scope)),
    ...[...marks].flatMap(([path, m]) => m.was.tables.map((t) => ({ path, ...t, marked: true }))),
  ];
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
    // next change could loosen it unseen, so this one waits.
    if (t.marked && !marks.get(t.path)?.now.tables.some((x) => x.table === t.table && x.kind === t.kind)) hit('registration-gone', t.path, `${TABLE_MARK}${t.kind} (${t.table})`);
    // The line that declared it, removed or changed: what reads as the table after may not be it (a decoy). It waits.
    const declaring = was[0]!;
    if ((i.files.find((f) => f.path === t.path)?.removedLines ?? []).some((l) => entry(l) === declaring)) {
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
    // The files that held a mark's text before the change (#869): git grep over the base's whole tree, so a mark is
    // found wherever it is; a git failure makes the change wait.
    const withMarks = new Set(filesWithText(cwd, base, [TABLE_MARK.trimEnd(), LINT_MARK]));
    const marked = new Set(files.map((f) => f.path).filter((p) => withMarks.has(p) && MARKABLE.test(p) && !isNonUtf8Path(p)));
    const paths = [...new Set([...CHECK_TABLES.map((t) => t.path), ...marked])].filter((p) => files.some((f) => f.path === p) && !isNonUtf8Path(p));
    // A file over the cap isn't read at all: the change waits.
    const side = (rev: string) => {
      const { texts, tooBig } = filesAt(cwd, rev, paths, MAX_TABLE_FILE);
      return (p: string) => {
        if (tooBig.has(p)) throw new Error(`${tooBig.get(p)} bytes, over ${MAX_TABLE_FILE}: not read`);
        return texts.get(p) ?? null;
      };
    };
    return weakeningReasons({ files, deleted, moved, before: side(base), after: side(head), scope, marked });
  } catch (e) {
    return [`${WEAKENING_REASON}the check for a removed or weakened test, lint or guard could not run (${escapedPath(String((e as Error).message ?? e).slice(0, 200))})`];
  }
}
