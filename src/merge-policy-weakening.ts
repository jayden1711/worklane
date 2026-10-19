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
export const SUPPRESSION: readonly string[] = [
  '@ts-ignore', '@ts-expect-error', '@ts-nocheck', 'eslint-disable', 'biome-ignore', 'istanbul ignore', 'c8 ignore', 'v8 ignore',
  'noqa', 'type: ignore', 'pragma: no cover', 'nosec', 'NOLINT', 'gitleaks:allow', 'nolint',
];

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
  return { src, code: code.join(''), comment, ok };
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The index of the bracket that closes the one at `at` (in the scanned code), or -1. */
function closeOf(code: string, at: number): number {
  const stack: string[] = [];
  for (let i = at; i < code.length; i++) {
    const c = code[i]!;
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Text compared as it reads: comments out, whitespace collapsed, none around punctuation, no trailing comma. */
function textOf(s: Scanned, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i++) if (!s.comment[i]) out += s.src[i];
  return out
    .replace(/\s+/g, ' ')
    .replace(/ ?([()[\]{},;:.=<>!?&|+*/-]) ?/g, '$1')
    .replace(/,([)\]}])/g, '$1')
    .trim();
}

/** Where code at depth 0 next has one of `stops`, from `from` up to `to` (or `to`). */
function depthZero(code: string, from: number, to: number, stops: string): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = code[i]!;
    if (OPEN[c]) depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && stops.includes(c)) return i;
  }
  return to;
}

/** A call's chain after its `)`: `.toBe(1)`, `.not.toThrow()`, `.to.be.true`. Returns where the chain ends. */
function chainEnd(code: string, at: number): number {
  let end = at;
  for (;;) {
    const m = /^\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)+/.exec(code.slice(end, end + 400));
    if (!m) return end;
    const after = end + m[0].length;
    if (code[after] === '(') {
      const close = closeOf(code, after);
      if (close === -1) return -1;
      end = close + 1;
    } else return after;
  }
}

const ASSERT_CALL = /(?<![\w$.])(?:[A-Za-z_$][\w$]*\s*\.\s*)*?(?:assert|expect)(?:[A-Z][\w$]*)?(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/g;
const TITLE_CALL = /(?<![\w$.])(?:(?:t|s|ctx|context)\s*\.\s*)?(?:test|it|describe|suite)\b(?:\s*\.\s*(?:only|skip|todo))?\s*\(/g;
const SKIP_MARK = /(?<![\w$])(?:test|it|describe|suite|context|t|s|ctx)\s*\.\s*(?:skip|todo|only)\b|(?<![\w$.])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|(?<![\w$.])(?:skip|todo|only)\s*:/g;
const EXIT = /(?<![\w$.])(?:return|continue|break|throw)(?![\w$])/g;

/** Local functions whose body asserts: a call to one counts as an assertion. */
function assertingFunctions(s: Scanned, asserts: RegExp): Set<string> {
  const out = new Set<string>();
  const decl = /(?<![\w$.])(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*\(|\(|[A-Za-z_$][\w$]*\s*=>))/g;
  const { code } = s;
  for (const m of code.matchAll(decl)) {
    const name = m[1] ?? m[2]!;
    let at = m.index + m[0].length;
    // Past the parameters, then the body: a block, or an arrow's expression up to its statement's end.
    if (code[at - 1] === '(') {
      const close = closeOf(code, at - 1);
      if (close === -1) continue;
      at = close + 1;
    }
    const arrow = /^[^{;]*?=>\s*/.exec(code.slice(at, at + 400));
    if (arrow) at += arrow[0].length;
    const open = arrow && code[at] !== '{' ? -1 : code.indexOf('{', at);
    const end = open === -1 ? depthZero(code, at, code.length, ';,') : closeOf(code, open);
    if (end !== -1 && new RegExp(asserts.source).test(code.slice(at, Math.min(end, at + 20_000)))) out.add(name);
  }
  return out;
}

interface TestFacts {
  /** Each assertion: where it sits and its text. */
  assertions: string[];
  /** Each test: its title, and how it runs (its .skip/.only/.todo and its options, and those of the tests around it). */
  tests: { title: string; runs: string }[];
  /** The line of each skip, todo or only mark outside any test's call (a `t.skip()` in a body, an options const). */
  looseSkips: string[];
  /** What the assertions call: each import from an assertion module, and each line that declares, assigns or patches one of their names. */
  bindings: string[];
  /** How many times the file exits or aborts the process (`process.exit(`, `process.exitCode =`, ...). */
  aborts: number;
  ok: boolean;
}

/** Modules whose every import is an assertion; and those (test runners) where only `expect`, `assert` and `should` are. */
const ASSERT_MODULE = /^(?:node:)?assert(?:\/strict)?$|^(?:chai|power-assert|uvu\/assert|should|expect)$/;
const RUNNER_MODULE = /^(?:vitest|@jest\/globals|bun:test|node:test)$/;
const ABORT = /\bprocess\s*\.\s*(?:exit|abort|reallyExit)\s*\(|\bprocess\s*\.\s*exitCode\s*=(?!=)|\bprocess\s*\.\s*kill\s*\(\s*process\s*\.\s*pid/g;

/**
 * The names an assertion is called by besides `assert*` and `expect*` (an alias, a named or destructured import), and
 * the lines that bind them: imports from assertion modules (also `require`), and any line that declares, assigns or
 * patches one of those names or `assert`/`expect` themselves.
 */
function assertionNames(s: Scanned): { roots: Set<string>; bindings: string[] } {
  const { src, code } = s;
  const roots = new Set(['assert', 'expect']);
  const bindings: string[] = [];
  // Imports: read from the source (a specifier is a string), only where the statement itself is code.
  for (const m of src.matchAll(/(?<![\w$.])import\s+(?!type\b)([^'";]+?)\s+from\s*(['"])([^'"\n]+)\2|(?<![\w$.])(?:const|let|var)\s+([^=;]+?)\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\5\s*\)/g)) {
    if (code[m.index] !== src[m.index] || s.comment[m.index]) continue;
    const spec = m[3] ?? m[6]!;
    const clause = (m[1] ?? m[4]!).trim();
    const all = ASSERT_MODULE.test(spec);
    if (!all && !RUNNER_MODULE.test(spec)) continue;
    const names: string[] = [];
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of (named?.[1] ?? '').split(',')) {
      const p = /^\s*(?:type\s+)?([\w$]+)(?:\s*(?:as|:)\s*([\w$]+))?\s*$/.exec(part);
      if (p && (all || /^(?:expect|assert|should)$/.test(p[1]!))) names.push(p[2] ?? p[1]!);
    }
    const plain = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+/, '').split(',').map((x) => x.trim()).filter((x) => /^[\w$]+$/.test(x));
    if (all) names.push(...plain);
    for (const n of names) roots.add(n);
    if (names.length || all) bindings.push(textOf(s, m.index, m.index + m[0].length));
  }
  // Destructured from an assertion: `const { equal, ok: isOk } = assert`.
  const rootRe = () => [...roots].map((r) => r.replace(/\$/g, '\\$')).join('|');
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:${rootRe()})(?![\\w$])`, 'g'))) {
    for (const part of m[1]!.split(',')) {
      const p = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(part);
      if (p) roots.add(p[2] ?? p[1]!);
    }
    bindings.push(textOf(s, m.index, m.index + m[0].length));
  }
  // Any line that declares, assigns or patches one of them: a shadow (`const assert = ...`), `assert.equal = () => {}`.
  const names = rootRe();
  const rebinds = new RegExp(
    `(?<![\\w$.])(?:const|let|var|function|class)\\s+(?:${names})(?![\\w$])|(?<![\\w$.])(?:${names})(?:\\s*\\.\\s*[\\w$]+)*\\s*=(?![=>])|\\b(?:Object\\s*\\.\\s*(?:assign|defineProperty|setPrototypeOf)|mock\\s*\\.\\s*method|vi\\s*\\.\\s*spyOn|jest\\s*\\.\\s*spyOn|sinon\\s*\\.\\s*(?:stub|replace))\\s*\\(\\s*(?:${names})(?![\\w$])`,
    'g',
  );
  for (const m of code.matchAll(rebinds)) bindings.push(lineAt(src, m.index));
  return { roots, bindings };
}

/** The line of `src` that `at` is on, trimmed. */
const lineAt = (src: string, at: number) => src.slice(src.lastIndexOf('\n', at - 1) + 1, (src.indexOf('\n', at) + 1 || src.length + 1) - 1).trim();

/** The assertions, tests and skip marks of a JavaScript or TypeScript test file. */
export function testFacts(text: string): TestFacts {
  const s = scan(text);
  const facts: TestFacts = { assertions: [], tests: [], looseSkips: [], bindings: [], aborts: 0, ok: s.ok };
  if (!s.ok) return facts;
  const { code } = s;
  const { roots, bindings } = assertionNames(s);
  facts.bindings = bindings;
  facts.aborts = [...code.matchAll(ABORT)].length;
  // Each test call: where its `(` is, its title, and how it runs: the call's modifiers and every argument after the
  // title that isn't its function (an options object, or a const holding one).
  const calls = new Map<number, { title: string; runs: string }>();
  const headers: [number, number][] = [];
  for (const m of code.matchAll(TITLE_CALL)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    if (close === -1) {
      facts.ok = false;
      return facts;
    }
    const args: string[] = [];
    let fnAt = close;
    for (let at = open + 1; at < close; ) {
      const end = depthZero(code, at, close, ',');
      if (/=>|^\s*(?:async\s+)?function\b/.test(code.slice(at, end))) {
        fnAt = Math.min(fnAt, at);
        break;
      }
      args.push(textOf(s, at, end));
      at = end + 1;
    }
    const mods = /\.\s*(only|skip|todo)\b/.exec(m[0])?.[1] ?? '';
    calls.set(open, { title: args[0] ?? '', runs: [mods, ...args.slice(1)].filter(Boolean).join(' ') });
    headers.push([m.index, fnAt]);
  }
  // A `skip:` key counts only in an object (`{ skip: ... }`), not as a parameter's type (`(only: number)`).
  const inObject = (at: number) => {
    let depth = 0;
    for (let j = at - 1; j >= 0; j--) {
      const c = code[j]!;
      if (c === ')' || c === ']' || c === '}') depth++;
      else if (OPEN[c] && depth-- === 0) return c === '{';
    }
    return false;
  };
  facts.looseSkips = [...code.matchAll(SKIP_MARK)]
    .filter((m) => !headers.some(([a, b]) => m.index >= a && m.index < b) && (!m[0].endsWith(':') || inObject(m.index)))
    .map((m) => lineAt(text, m.index));
  // Assertion starts: assert*/expect calls, calls by another name an assertion module gave, and calls to a local
  // function that asserts.
  const aliases = [...roots].filter((r) => r !== 'assert' && r !== 'expect').map((h) => h.replace(/\$/g, '\\$'));
  const anyAssert = new RegExp(aliases.length ? `${ASSERT_CALL.source}|(?<![\\w$.])(?:${aliases.join('|')})(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*\\s*\\(` : ASSERT_CALL.source, 'g');
  const helpers = assertingFunctions(s, anyAssert);
  const starts: number[] = [...code.matchAll(anyAssert)].map((m) => m.index);
  if (helpers.size) {
    const names = [...helpers].map((h) => h.replace(/\$/g, '\\$')).join('|');
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:${names})\\s*\\(`, 'g'))) {
      if (!/(?:function\s*\*?|const|let|var)\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) starts.push(m.index);
    }
  }
  starts.sort((a, b) => a - b);
  // One pass: the brackets open at each start, each with the text before it (its header).
  const stack: { at: number; header: string; seg: number }[] = [];
  let seg = 0;
  let next = 0;
  let coveredTo = -1;
  for (let i = 0; i < code.length; i++) {
    const call = calls.get(i);
    if (call) {
      // A test inside a skipped describe is skipped too: how the tests around it run is part of how it runs.
      const around = stack.map((b) => calls.get(b.at)?.runs).filter(Boolean);
      facts.tests.push({ title: call.title, runs: [...around, call.runs].join(' > ') });
    }
    while (next < starts.length && starts[next] === i) {
      next++;
      if (i < coveredTo) continue;
      const open = code.indexOf('(', i);
      const close = closeOf(code, open);
      const end = close === -1 ? -1 : chainEnd(code, close + 1);
      if (end === -1) {
        facts.ok = false;
        return facts;
      }
      coveredTo = end;
      const where = stack.map((b) => (code[b.at] === '(' ? `${b.header}(${textOf(s, b.at + 1, depthZero(code, b.at + 1, i, ','))}` : `${b.header}${code[b.at]}`));
      const from = stack[0]?.at ?? 0;
      const exits = [...code.slice(from, i).matchAll(EXIT)].length;
      // What leads into it within its own statement: `await`, `void`, `if (x)`, `x &&`, `const later = () =>`.
      const lead = textOf(s, seg, i).slice(-200);
      facts.assertions.push(`${where.join(' > ')} | exits ${exits} | ${lead ? `${lead} ` : ''}${textOf(s, i, end)}`);
    }
    const c = code[i]!;
    if (OPEN[c]) {
      stack.push({ at: i, header: textOf(s, seg, i).slice(-200), seg });
      seg = i + 1;
    } else if (c === ')' || c === ']' || c === '}') {
      const b = stack.pop();
      if (!b) {
        facts.ok = false;
        return facts;
      }
      seg = c === '}' ? i + 1 : b.seg;
    } else if (c === ',' || c === ';') seg = i + 1;
  }
  return facts;
}

// ---- Tables: a `const NAME = <literal>` read as its leaf entries (an object's entries keyed by their path).

/** The text of `const NAME ... = <value>` up to its end, as [from, to) in s, or null when there is none. */
function tableSpan(s: Scanned, name: string): [number, number] | null {
  const m = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}(?![\\w$])`).exec(s.code);
  if (!m) return null;
  // The `=` at depth 0 after the name (a type annotation's brackets and `=>` skipped).
  let depth = 0;
  let i = m.index + m[0].length;
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
  const close = s.code[start] === '[' || s.code[start] === '{' ? closeOf(s.code, start) : -1;
  if (close === -1) return [start, depthZero(s.code, start, s.code.length, ';')];
  const tail = /^\s*(?:as\s+const|satisfies\s+[\w$.<>[\], ]+)?/.exec(s.code.slice(close + 1, close + 200))!;
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
  if (wrap && closeOf(code, from + wrap[0].length - 1) === to - 1) {
    let inner = from + wrap[0].length;
    while (inner < to && /\s/.test(code[inner]!)) inner++;
    const innerEnd = code[inner] === '[' || code[inner] === '{' ? closeOf(code, inner) : -1;
    if (innerEnd !== -1 && !code.slice(innerEnd + 1, to - 1).trim()) return leaves(s, inner, innerEnd + 1, prefix, out, depth);
  }
  const first = code[from];
  if ((first === '[' || first === '{') && closeOf(code, from) === to - 1) {
    for (let at = from + 1; at < to - 1; ) {
      const end = depthZero(code, at, to - 1, ',');
      if (code.slice(at, end).trim()) {
        if (first === '[') leaves(s, at, end, prefix, out, depth);
        else {
          const colon = depthZero(code, at, end, ':');
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
const MARK = new RegExp(SUPPRESSION.map((m) => `${/^\w/.test(m) ? '\\b' : ''}${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${/\w$/.test(m) ? '\\b' : ''}`).join('|'), 'g');
/**
 * The suppression marks of one added or removed line: in a comment. In JavaScript or TypeScript, only where the line
 * read alone has a comment (a mark inside a string, a lint's own test fixture, isn't one); elsewhere after a comment
 * start of any common language.
 */
function marksIn(path: string, line: string): string[] {
  if (JS.test(path)) {
    const s = scan(line);
    return [...line.matchAll(MARK)].filter((m) => s.comment[m.index] === 1 || /^\s*\*/.test(line)).map(() => line.trim());
  }
  return /(?:\/\/|\/\*|^\s*\*|#|<!--|--|;)/.test(line) && new RegExp(MARK.source).test(line) ? [line.trim()] : [];
}
const isRunnerTest = (p: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes('__tests__/');
const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
/** A line added to a guard that can skip or switch something off. */
const BYPASS = /\b(?:return|break|continue|catch|exit|skip|ignore|allow|allowed|disable|disabled|off|false|warn|none|optional)\b|process\.env|\|\||&&|\?\?/;
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
  const isAllowFile = matcher(NEVER_GROW_FILES, i.scope);
  const tables = CHECK_TABLES.filter((t) => holds(t.path, i.scope));
  const read = (side: 'before' | 'after', path: string): string | null | undefined => {
    try {
      return i[side](path);
    } catch {
      hit('unreadable', path);
      return undefined;
    }
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
    // Suppressions, in any file: more marks added than removed.
    const marks = (ls: string[] | undefined) => (ls ?? []).flatMap((l) => marksIn(f.path, l));
    const newMarks = missing(marks(lines.added), marks(lines.removed));
    if (newMarks.length) hit('suppression', f.path, newMarks[0]);

    if (isAllowFile(f.path)) {
      if (!linesKnown) hit('unreadable', f.path);
      else for (const l of missing((lines.added ?? []).flatMap(codeLine), (lines.removed ?? []).flatMap(codeLine))) hit('allow-file', f.path, l);
      continue;
    }
    // A guard or lint file: a code line removed and not put back, or one added that can skip or switch something off
    // (an early return, `if (process.env.X)`, `"rule": "off"`, `continue-on-error`). A lint test that holds a
    // registered table: a line removed (its logic changed beside its table).
    const lintTest = isTest(f.path) && tables.some((t) => t.path === f.path);
    if (isGuard(f.path) || lintTest) {
      if (!linesKnown) hit('unreadable', f.path);
      else {
        // In a lint test, the lines of its registered tables are the table rule's to judge (an allowlist entry taken
        // out is a tightening).
        const inTables = lintTest ? tableLines(f.path, read('before', f.path) ?? null, tables) : new Set<string>();
        const removed = missing((lines.removed ?? []).flatMap(codeLine), (lines.added ?? []).flatMap(codeLine)).filter((l) => !inTables.has(l));
        const bypasses = isGuard(f.path) ? missing((lines.added ?? []).flatMap(codeLine), (lines.removed ?? []).flatMap(codeLine)).filter((l) => BYPASS.test(l)) : [];
        for (const l of [...removed, ...bypasses].slice(0, 3)) hit('guard-lines', f.path, l);
      }
    }
    for (const t of tables.filter((x) => x.path === f.path)) {
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
    const facts = { before: b === null ? null : testFacts(b), after: a === null ? null : testFacts(a) };
    // A file it can't read after the change holds, and so does one it couldn't read before: it can't tell what went.
    if (facts.before?.ok === false || facts.after?.ok === false) {
      hit('unreadable', f.path);
      continue;
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
      const changed = [...missing(facts.before.bindings, facts.after.bindings), ...missing(facts.after.bindings, facts.before.bindings)];
      for (const l of changed.slice(0, 3)) hit('test-binding', f.path, l);
      // A fixture (a server a test starts, its own process) may exit; a test or its helper may not.
      if (facts.after.aborts > facts.before.aborts && !/(?:^|\/)fixtures\//.test(f.path)) hit('test-abort', f.path);
    }
    if (b !== null && a === null && isRunnerTest(f.path)) deleted.push({ path: f.path, text: b });
    if (b === null && a !== null && isRunnerTest(f.path)) added.push({ path: f.path, text: a });
  }
  // A test file deleted: unless the change adds the same text as another test file in the same folder (a rename).
  for (const d of deleted) if (!added.some((x) => x.text === d.text && dir(x.path) === dir(d.path))) hit('test-file-deleted', d.path);
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
  if (codeChanged || pools.after.assertions.length < pools.before.assertions.length) {
    for (const x of missing(pools.before.assertions, pools.after.assertions)) hit('test-assertion', where.get(x) ?? '?', x.slice(x.lastIndexOf(' | ') + 3));
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
    const before = filesAt(cwd, base, paths);
    const after = filesAt(cwd, head, paths);
    return weakeningReasons({ files, before: (p) => before.get(p) ?? null, after: (p) => after.get(p) ?? null, scope });
  } catch (e) {
    return [`${WEAKENING_REASON}the check for a removed or weakened test, lint or guard could not run (${escapedPath(String((e as Error).message ?? e).slice(0, 200))})`];
  }
}
