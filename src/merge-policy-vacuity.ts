// Whether a PR's own tests run the code it changes (#784): the merge gate's use of src/vacuity.ts. Pure: the
// coordinator reads the head and runs the tests (src/coordinator/merge-flow.ts vacuityFor, vacuityRun) and passes
// what it found in.
//
// A PR that changes app code auto-merges only on a measured yes: its tests (the test files it adds or changes, as
// tests.yaml vacuity.test_globs matches them, and the `test:` files its task's agreed done_when names, which the
// coordinator's own verification ran) hold an assertion call (an import of an assertion module is none), and, each run
// with runner.one (`node --test`: coverageRunnerOne) under V8 coverage, they run code on a character the PR changes
// (rounds 8, 9: each hunk aligned by character; V8's innermost block range around a changed code character ran, so an
// untaken branch or arm on a changed line doesn't count, whether the change adds code or reflows lines; a removal
// counts only when the code on both its sides ran and shares one innermost V8 range in every process (round 12);
// never across a block or clause
// boundary, holding a sub-statement or nested function, or at a statement list's end (round 11); the removed side is
// lexed in its base file, and unchanged lines a comment toggle turned are measured with their hunks; the diff is
// git's histogram one; a change too large to align, or a large hunk whose lines don't pair, holds) in at least one of
// its app files
// more often than loading
// accounts for: the same run with every test skipped (what loading
// the test file and its static imports runs), plus, for every script the tests evaluated more often than that run did
// (a dynamic import in a test's body, a copy with a query string, what such a module imports), that script loaded on
// its own, times its extra evaluations (round 7). So what loading runs doesn't count: a module's top level, V8's
// synthetic initializers, and a helper it calls as it loads, even in a file the PR adds (src/vacuity.ts
// measureTouched). Every such script must load on its own within one time budget, or the PR waits. Only a changed line
// that holds code counts: a blank, whitespace-only or comment line, or a rename git pairs, is nothing to measure, and a PR with
// nothing else waits. The PR's lines are measured from where its branch meets the default branch's tip as fetched from
// the remote for the decision (round 8: by the watch pass, off the event loop, bounded; never a cached tip or a ref
// read on its own), so what it merged in or was rebased onto is never its own, and a measurement counts only from the
// base it measured. When that fetch fails, the PR holds, named, at once; a merge that brings in a commit that tip
// doesn't have (another branch) holds. Anything else is a `design:` reason to wait: no
// test, no assertion, a static-only config, no runner.one or another runner, a test path that would need quoting,
// nothing measured after VACUITY_TRIES starts, a run that failed. The one exception is the reason given while the run
// is still to come (VACUITY_UNMEASURED): the gate runs it and decides again.
//
// What it can't see: a test that calls the code and asserts nothing about it (any assertion call passes; inferred); a
// test or module that checks whether it runs in a baseline (inferred); work a module starts as it loads that keeps
// running and that the tests' own run drives, more in the real run than in a baseline: a timer while a test waits, an
// async_hooks listener on the tests' own activity, an exit handler (measured: round-5 final check, round-7 review);
// code after a call that threw, which V8 counts as run once its block was entered (measured, round-7 review). And
// where V8 makes no block range of its own, so a change there counts when the code around it ran (measured, round-8
// reviews): an optional call's arguments, a default parameter, a destructuring default, a logical assignment's right
// side (`??=`, `||=`, `&&=`), code in a string (`new Function('…')`), and built code, which its map places only by line.
// Each of these has a todo test (merge-vacuity-r8, -r9-limits; B1 in -r6). And two where an untested change merges
// (round 13): code moved in a way git doesn't pair (a file renamed and re-indented or edited, a function moved into
// another file or within its file, moved code re-wrapped) reads as added code, so a test that runs it merges the PR
// (measured: todo tests R1, R3, R4 in merge-vacuity-r12; M3, M4b, M5b, R3s in -r13); and deleting an app file, or
// renaming one out of app code (to a data file, a test path, or out of app_paths), leaves no app code to measure, so
// it merges with no test and no run (measured for a deletion, a rename to .json and a rename to a test path; inferred
// for a move out of app_paths, which the same app-code filter drops).
//
// What counts as changed app code: a file the PR changes, under vacuity.app_paths, not matched by a test glob, still
// there at the head, and not one with no runtime code for a test to run (NO_RUNTIME_CODE: types only, config, data,
// docs and assets). Any other kind counts, one it doesn't know included (fail closed). Coverage matches by path; code
// that ran in a build's file (dist/) counts for the source lines its source map maps that code to, source by source.
// A repo with no vacuity section waits too (the owner's decision): with the tamper guard's own test globs
// (FALLBACK_TEST_GLOBS), any other changed file with runtime code holds it, naming the missing section.
import { BRAND } from './brand.js';
import { globToRegExp } from './guardrails/glob.js';
import { shownPath } from './path-text.js';
import { countAssertionCalls, FALLBACK_TEST_GLOBS } from './vacuity.js';

export interface VacuityConfig {
  test_globs: string[];
  assertion_pattern: string;
  app_paths: string[];
  dynamic: boolean;
}

/** A changed file with no runtime code for a test to run: types only, and config, data, docs and assets. */
export const NO_RUNTIME_CODE = /(\.d\.[cm]?ts|\.(json|jsonc|json5|ya?ml|toml|md|txt|csv|css|scss|svg|png|jpe?g|gif|webp|ico))$/i;

/**
 * A test path the gate puts into runner.one's command as it is: letters, digits, `.`, `_`, `-` and `/` only, not
 * starting with `-`, with no `..` segment. So no quoting is needed, and no OS's quoting rules: anything else waits.
 */
export const PLAIN_TEST_PATH = /^(?!-)(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

/** The most characters of one test file the gate reads for its assertion calls (more: the PR holds; #784 round 8). */
export const ASSERTION_TEXT_MAX = 1024 * 1024;

/** The most characters of all of a PR's tests the gate reads for assertion calls (more: the PR holds; round 9). */
export const ASSERTION_TOTAL_MAX = 4 * 1024 * 1024;

/** How many times a coverage run may start at one head without finishing before the PR waits instead. */
export const VACUITY_TRIES = 3;

/**
 * The reason mergeDecision gives while the head's coverage run is still to come (MergeInput.vacuityPending), when
 * nothing else holds the PR: the PR watch runs it, then decides again. Every reason here is a design-level hold (the
 * owner decides), written out whole where it is given so the #741 source scan reads its words.
 */
export const VACUITY_UNMEASURED = 'design: vacuity: its tests have not yet been run under coverage at this head';

/** A finished coverage run: the tests it ran, the app files in which a function ran, or why it couldn't measure. */
export interface VacuityMeasured {
  tests: string[];
  touched: string[];
  error: string | null;
}

/** Why it waits (empty: it doesn't); `run`, with no reasons: the coverage run still to make (it waits until then). */
export interface VacuityCheck {
  reasons: string[];
  /** `app`: the changed app files, the only ones the run records as touched (#784 round 3: bounded by the PR). */
  run?: { tests: string[]; appPaths: string[]; app: string[] };
}

const list = (p: string[]) => `${p.slice(0, 3).map(shownPath).join(', ')}${p.length > 3 ? ` and ${p.length - 3} more` : ''}`;

/**
 * No vacuity section (the owner's decision: it waits too). Nothing says what is app code, so every changed file the
 * tamper guard's own test globs don't match, that has runtime code and is still there at the head, counts; any one
 * holds the PR, saying how to add the section. A head it can't read holds as well.
 */
function noSection(changed: string[], atHead: (path: string) => string | null): VacuityCheck {
  const testRes = FALLBACK_TEST_GLOBS.map((g) => globToRegExp(g));
  let code: string[];
  try {
    code = changed.filter((p) => !testRes.some((re) => re.test(p)) && !NO_RUNTIME_CODE.test(p) && atHead(p) !== null);
  } catch (e) {
    return { reasons: [`design: vacuity: could not be checked: ${(e as Error).message.split('\n')[0]!.slice(0, 300)}`] };
  }
  if (!code.length) return { reasons: [] };
  return { reasons: [`design: vacuity: tests.yaml has no vacuity section, so nothing shows its tests run the code it changes (${list(code)}); \`${BRAND.cli} doctor\` shows the section to add`] };
}

/** The tests.yaml lines that turn the coverage run on: a paste-ready snippet (doctor and the drafted tests.yaml say it). */
export function vacuitySnippet(v: Partial<VacuityConfig> | undefined, runOne: string | undefined): string {
  const q = (s: string) => JSON.stringify(s);
  return [
    'vacuity:',
    `  test_globs: [${(v?.test_globs?.length ? v.test_globs : ['test/**/*.test.js']).map(q).join(', ')}]`,
    `  assertion_pattern: ${q(v?.assertion_pattern ?? '\\b(assert|expect)\\b')}`,
    `  app_paths: [${(v?.app_paths?.length ? v.app_paths : ['src/**']).map(q).join(', ')}]`,
    '  dynamic: true',
    'runner:',
    `  one: ${q(coverageRunnerOne(runOne) ? runOne! : 'node --test {file}')}   # runs ONE test file with node --test; {file} is its path`,
  ].join('\n');
}

/**
 * The one runner.one form the coverage run can measure, matched against the WHOLE command: `node --test`, option words
 * from RUNNER_OPTIONS after it, then `{file}` last. Single spaces only: no newline or tab (a second command), no quote,
 * no shell operator, nothing else before or after. Not tsx, vitest or jest (#784 round 5, measured: code a loader
 * transforms runs other text than the file's, so it counts for nothing).
 */
const RUNNER_ONE = /^node --test((?: [^ ]+)*) \{file\}$/;

/**
 * The only options runner.one may give `node --test` (#784 round 6): an allowlist of the test runner's own options,
 * which neither load code before the tests nor change the text Node runs. Anything else is refused, since a Node
 * option can preload code: measured on Node 22.23, `--env-file` (a NODE_OPTIONS line in the file), the config-file
 * options (a node.config.json `import`), `--import`/`--require`/a loader, `-e`/`--eval`, and
 * `--experimental-transform-types` (other text). Reporters are the built-in ones only: a reporter module is code
 * too. Node's own TypeScript type stripping keeps every offset, so a `.ts` file is measured (ranSegments).
 */
// check-table: never-grow
const RUNNER_OPTIONS: readonly RegExp[] = [
  /^--test-reporter=(?:spec|tap|dot|junit|lcov)$/,
  // A file in the worktree: relative, no `..` segment (#784 round 7: Node writes wherever it points).
  /^--test-reporter-destination=(?:stdout|stderr|(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._/-]*)$/,
  /^--test-(?:timeout|concurrency)=\d+$/,
  /^--test-(?:name|skip)-pattern=[A-Za-z0-9._:/@-]+$/,
  /^--(?:experimental-)?test-isolation=(?:process|none)$/,
  /^--test-(?:force-exit|only)$/,
  /^--test-shard=\d+\/\d+$/,
  /^--(?:no-)?experimental-strip-types$/,
  /^--no-warnings$/,
];

/** A runner.one the coverage run can measure: RUNNER_ONE, each option one of RUNNER_OPTIONS. */
export function coverageRunnerOne(one: string | null | undefined): boolean {
  const m = typeof one === 'string' ? RUNNER_ONE.exec(one) : null;
  if (!m) return false;
  return m[1]!.split(' ').filter((w) => w !== '').every((w) => RUNNER_OPTIONS.some((re) => re.test(w)));
}

/**
 * runner.one for the baseline run (#784 round 5): the same command with every test skipped
 * (`--test-skip-pattern=.`; a test's name is never empty), so the test file and what it imports load and no test runs.
 * Only for a coverageRunnerOne command.
 */
export function baselineRunnerOne(one: string): string {
  return one.replace(/^node --test/, 'node --test --test-skip-pattern=.');
}

/** Doctor's word on the merge gate's vacuity check (#784): whether app-code PRs can auto-merge here, and how if not. */
export function vacuityDoctor(tests: { vacuity?: VacuityConfig | undefined; runner: { one?: string | undefined } }): { level: 'ok' | 'warn'; detail: string } {
  const v = tests.vacuity;
  const how = (why: string) => ({ level: 'warn' as const, detail: `${why}: every PR that changes app code waits for you. To let the harness merge them, its tests must run under coverage. Add to ${BRAND.configDir}/tests.yaml (change the paths to yours):\n${vacuitySnippet(v, tests.runner.one)}` });
  if (!v) return how('tests.yaml has no vacuity section');
  if (!v.dynamic) return how('tests.yaml vacuity.dynamic is false');
  if (!tests.runner.one) return how('tests.yaml runner.one is not set');
  if (!coverageRunnerOne(tests.runner.one)) return how(`runner.one (${tests.runner.one}) isn't \`node --test [options] {file}\` with only the test runner's own options (built-in reporters, timeout, concurrency, name and skip patterns, isolation, shard, force-exit, only, type stripping), the one form whose coverage the merge gate can measure (code tsx, vitest, jest, a loader or a preload transforms or adds counts for nothing, or isn't the test's)`);
  return { level: 'ok', detail: `PRs that change app code (${v.app_paths.join(', ')}) auto-merge only when their tests, run with \`${tests.runner.one}\` under coverage, run code on a line they change more often than loading them does. JavaScript is measured as it is, TypeScript under Node's own type stripping, and a build's code (dist/) through its source maps` };
}

export function vacuityCheck(o: {
  cfg: VacuityConfig | undefined;
  runOne: string | undefined;
  /** The paths the PR changes. */
  changed: string[];
  /** The test files its task's agreed done_when names (`test:` entries): tests its verification ran, changed or not. */
  contractTests?: string[];
  /** A file's text at the PR's head; null: the head doesn't have it. Throws when it can't tell (the PR waits). */
  atHead: (path: string) => string | null;
  /** This head's coverage runs: how many started, and the last that finished (null: none). */
  runs: { started: number; last: VacuityMeasured | null };
  /**
   * Whether a merge between where the change is measured from and the head brings in a commit the default branch's
   * tip here doesn't have (#784 round 6). It then holds.
   */
  foreignMerge?: boolean;
  /** The default branch's tip the change is measured from (#784 rounds 7, 8): 'unknown', its fetch failed. */
  tip?: 'unknown';
}): VacuityCheck {
  if (!o.cfg) return noSection(o.changed, o.atHead);
  const cfg = o.cfg;
  const testRes = cfg.test_globs.map((g) => globToRegExp(g));
  const appRes = cfg.app_paths.map((g) => globToRegExp(g));
  const isTest = (p: string) => testRes.some((re) => re.test(p));
  const named = o.contractTests ?? [];
  let text: Map<string, string | null>;
  try {
    text = new Map([...new Set([...o.changed, ...named])].map((p) => [p, o.atHead(p)] as const));
  } catch (e) {
    // Fail closed: a head it can't read is never taken for one with nothing to check.
    return { reasons: [`design: vacuity: could not be checked: ${(e as Error).message.split('\n')[0]!.slice(0, 300)}`] };
  }
  const app = o.changed.filter((p) => appRes.some((re) => re.test(p)) && !isTest(p) && !NO_RUNTIME_CODE.test(p) && text.get(p) !== null);
  if (!app.length) return { reasons: [] };
  // #784 round 6: a merge the gate can't place on the default branch (fail closed: what it brought in might be counted
  // as the PR's own change, with the tests that came with it).
  if (o.foreignMerge) return { reasons: ["design: vacuity: a merge in it brings in commits the default branch here doesn't have (a fetch of that branch that is behind, or another branch), so its own change can't be told from what it merged in"] };
  // Its tests: the test files it adds or changes, then those its task's done_when names, each one there at the head.
  const tests = [...new Set([...o.changed.filter(isTest), ...named])].filter((p) => text.get(p) !== null && text.get(p) !== undefined);
  const reasons: string[] = [];
  if (!tests.length) reasons.push(`design: vacuity: it changes app code (${list(app)}) and no test: it adds or changes none, and its task's done_when names none`);
  const odd = tests.filter((p) => !PLAIN_TEST_PATH.test(p));
  if (odd.length) reasons.push(`design: vacuity: a test path has characters other than letters, digits, ".", "_", "-" and "/", so it is never put in a command (${list(odd)})`);
  // An import or require of an assertion module is no assertion (countAssertionCalls, #784 round 4).
  // #784 round 8: the count is linear, and bounded too (it runs on the coordinator's thread): a larger test holds.
  const big = tests.filter((p) => text.get(p)!.length > ASSERTION_TEXT_MAX);
  const total = tests.reduce((n, p) => n + text.get(p)!.length, 0);
  if (big.length) reasons.push(`design: vacuity: a test file is over ${ASSERTION_TEXT_MAX} characters, more than the gate reads for its assertions (${list(big)})`);
  // And in all (#784 round 9: 60 files of 1 MiB took 1.5 s on every decision).
  else if (total > ASSERTION_TOTAL_MAX) reasons.push(`design: vacuity: its tests are over ${ASSERTION_TOTAL_MAX} characters in all, more than the gate reads for their assertions (${list(tests)})`);
  else if (tests.length && tests.every((p) => countAssertionCalls(text.get(p)!, cfg.assertion_pattern) === 0)) reasons.push(`design: vacuity: its tests (${list(tests)}) have no assertion matching /${cfg.assertion_pattern}/`);
  if (!cfg.dynamic) reasons.push(`design: vacuity: tests.yaml vacuity.dynamic is off, so nothing measured whether its tests run the app code it changes (${list(app)})`);
  else if (!o.runOne) reasons.push("design: vacuity: tests.yaml runner.one is not set, so its tests can't be run one by one under coverage");
  else if (!coverageRunnerOne(o.runOne)) reasons.push("design: vacuity: tests.yaml runner.one is not `node --test [options] {file}` with only the test runner's own options, the one form whose coverage the merge gate can measure");
  if (reasons.length) return { reasons };
  // #784 rounds 7, 8: what is the PR's own change is measured from the default branch's tip as fetched from the remote
  // for this decision. When that fetch failed (a lock, a refspec, the remote), the PR holds, named, at once: it never
  // waits on it, so no PR can be kept waiting unannounced.
  if (o.tip === 'unknown') return { reasons: ["design: vacuity: the default branch couldn't be fetched from the remote for this decision, so the PR's own change can't be told from the default branch's"] };
  // A run of other tests than this head's (tests.yaml changed since) is not this head's.
  const last = o.runs.last && o.runs.last.tests.join('\0') === tests.join('\0') ? o.runs.last : null;
  if (!last) {
    if (o.runs.started >= VACUITY_TRIES) return { reasons: [`design: vacuity: its coverage run started ${o.runs.started} times at this head and never finished`] };
    return { reasons: [], run: { tests, appPaths: cfg.app_paths, app } };
  }
  if (last.error !== null) return { reasons: [`design: vacuity: its coverage run failed: ${last.error}`] };
  if (!app.some((p) => last.touched.includes(p))) return { reasons: [`design: vacuity: its tests (${list(tests)}) ran none of the app code it changes (${list(app)})`] };
  return { reasons: [] };
}
