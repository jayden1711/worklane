// Whether a PR's own tests run the code it changes (#784): the merge gate's use of src/vacuity.ts. Pure: the
// coordinator reads the head and runs the tests (src/coordinator/merge-flow.ts vacuityFor, vacuityRun) and passes
// what it found in.
//
// A PR that changes app code auto-merges only on a measured yes: its tests (the test files it adds or changes, as
// tests.yaml vacuity.test_globs matches them, and the `test:` files its task's agreed done_when names, which the
// coordinator's own verification ran) hold an assertion call (an import of an assertion module is none), and, each run
// with runner.one (`node --test`: coverageRunnerOne) under V8 coverage, they run code on a line the PR changes in at
// least one of its app files more often than the same run with every test skipped does (the baseline: what loading the
// test file and its imports runs). So code that runs as a module loads doesn't count: its top level, V8's synthetic
// initializers, and a helper it calls as it loads, even in a file the PR adds (src/vacuity.ts touchedAppFiles). Only a
// changed line that holds code counts: a blank, whitespace-only or comment line, or a rename, is nothing to measure,
// and a PR with nothing else waits. The PR's lines are measured from where its branch meets the default branch's tip,
// so what it merged in from that branch is never its own. Anything else is a `design:` reason to wait: no test, no
// assertion, a static-only config, no runner.one or another runner, a test path that would need quoting, nothing
// measured after VACUITY_TRIES starts, a run that failed. The one exception is the reason given while the run is still
// to come (VACUITY_UNMEASURED): the gate runs it and decides again.
//
// What it can't see (inferred): a test that calls the code and asserts nothing about it (any assertion call passes); a
// test that imports a module inside a test's body (a helper the module calls as it loads then counts, its top level
// doesn't); a test or module that checks whether it runs in the baseline.
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
 * The one runner.one form the coverage run can measure, matched against the WHOLE command: `node --test`, plain option
 * words after it (`--x`, `--x=value`), then `{file}` last. Single spaces only: no newline or tab (a second command), no
 * quote, no shell operator, nothing else before or after. Not tsx, vitest or jest (#784 round 5, measured: code a loader
 * transforms runs other text than the file's, so it counts for nothing), and no option that loads code first
 * (`--import`, `--require`, `-r`, `--loader`, `--experimental-loader`): a loader could transform the same way. Node's own
 * TypeScript type stripping keeps every offset, so a `.ts` file is measured (ranSegments).
 */
const RUNNER_ONE = /^node --test(?: --?[A-Za-z0-9][A-Za-z0-9._:/=@-]*)* \{file\}$/;
const PRELOADS = / (?:--import|--require|-r|--loader|--experimental-loader)(?:[ =]|$)/;

/** A runner.one the coverage run can measure (RUNNER_ONE, with no PRELOADS option). */
export function coverageRunnerOne(one: string | null | undefined): boolean {
  return typeof one === 'string' && RUNNER_ONE.test(one) && !PRELOADS.test(one);
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
  if (!coverageRunnerOne(tests.runner.one)) return how(`runner.one (${tests.runner.one}) isn't \`node --test [options] {file}\` with no --import, --require or loader option, the one form whose coverage the merge gate can measure (code tsx, vitest, jest or a loader transforms counts for nothing)`);
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
  // Its tests: the test files it adds or changes, then those its task's done_when names, each one there at the head.
  const tests = [...new Set([...o.changed.filter(isTest), ...named])].filter((p) => text.get(p) !== null && text.get(p) !== undefined);
  const reasons: string[] = [];
  if (!tests.length) reasons.push(`design: vacuity: it changes app code (${list(app)}) and no test: it adds or changes none, and its task's done_when names none`);
  const odd = tests.filter((p) => !PLAIN_TEST_PATH.test(p));
  if (odd.length) reasons.push(`design: vacuity: a test path has characters other than letters, digits, ".", "_", "-" and "/", so it is never put in a command (${list(odd)})`);
  // An import or require of an assertion module is no assertion (countAssertionCalls, #784 round 4).
  if (tests.length && tests.every((p) => countAssertionCalls(text.get(p)!, cfg.assertion_pattern) === 0)) reasons.push(`design: vacuity: its tests (${list(tests)}) have no assertion matching /${cfg.assertion_pattern}/`);
  if (!cfg.dynamic) reasons.push(`design: vacuity: tests.yaml vacuity.dynamic is off, so nothing measured whether its tests run the app code it changes (${list(app)})`);
  else if (!o.runOne) reasons.push("design: vacuity: tests.yaml runner.one is not set, so its tests can't be run one by one under coverage");
  else if (!coverageRunnerOne(o.runOne)) reasons.push('design: vacuity: tests.yaml runner.one is not `node --test [options] {file}` with no --import, --require or loader option, the one form whose coverage the merge gate can measure');
  if (reasons.length) return { reasons };
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
