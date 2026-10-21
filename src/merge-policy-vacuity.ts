// Whether a PR's own tests run the code it changes (#784): the merge gate's use of src/vacuity.ts. Pure: the
// coordinator reads the head and runs the tests (src/coordinator/merge-flow.ts vacuityFor, vacuityRun) and passes
// what it found in.
//
// A PR that changes app code auto-merges only on a measured yes: its tests (the test files it adds or changes, as
// tests.yaml vacuity.test_globs matches them, and the `test:` files its task's agreed done_when names, which the
// coordinator's own verification ran) assert something, and, each run with runner.one under V8 coverage, they
// execute a function (not just the top level) in at least one app file the PR changes. Anything else is a `design:`
// reason to wait: no test, no assertion, a static-only config, no runner.one, a test path that would need quoting,
// nothing measured after VACUITY_TRIES starts, a run that failed. The one exception is the reason given while the
// run is still to come (VACUITY_UNMEASURED): the gate runs it and decides again.
//
// What counts as changed app code: a file the PR changes, under vacuity.app_paths, not matched by a test glob, still
// there at the head, and not one with no runtime code for a test to run (NO_RUNTIME_CODE: types only, config, data,
// docs and assets). Any other kind counts, one it doesn't know included (fail closed). Coverage matches by path, so
// dynamic mode fits tests that run the source files themselves; tests that run a build of them (dist/) touch none.
// A repo with no vacuity section is decided as before: nothing says which of its files are app code or tests.
import { globToRegExp } from './guardrails/glob.js';
import { shownPath } from './path-text.js';
import { countAssertions } from './vacuity.js';

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
  run?: { tests: string[]; appPaths: string[] };
}

const list = (p: string[]) => `${p.slice(0, 3).map(shownPath).join(', ')}${p.length > 3 ? ` and ${p.length - 3} more` : ''}`;

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
  if (!o.cfg) return { reasons: [] };
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
  if (tests.length && tests.every((p) => countAssertions(text.get(p)!, cfg.assertion_pattern) === 0)) reasons.push(`design: vacuity: its tests (${list(tests)}) have no assertion matching /${cfg.assertion_pattern}/`);
  if (!cfg.dynamic) reasons.push(`design: vacuity: tests.yaml vacuity.dynamic is off, so nothing measured whether its tests run the app code it changes (${list(app)})`);
  else if (!o.runOne) reasons.push("design: vacuity: tests.yaml runner.one is not set, so its tests can't be run one by one under coverage");
  if (reasons.length) return { reasons };
  // A run of other tests than this head's (tests.yaml changed since) is not this head's.
  const last = o.runs.last && o.runs.last.tests.join('\0') === tests.join('\0') ? o.runs.last : null;
  if (!last) {
    if (o.runs.started >= VACUITY_TRIES) return { reasons: [`design: vacuity: its coverage run started ${o.runs.started} times at this head and never finished`] };
    return { reasons: [], run: { tests, appPaths: cfg.app_paths } };
  }
  if (last.error !== null) return { reasons: [`design: vacuity: its coverage run failed: ${last.error}`] };
  if (!app.some((p) => last.touched.includes(p))) return { reasons: [`design: vacuity: its tests (${list(tests)}) ran none of the app code it changes (${list(app)})`] };
  return { reasons: [] };
}
