// The acceptance tests that need a booted systemd and passwordless sudo: each test under test/ whose options say
// `skip: !systemCi`. In the self-hosted tests runner's container they skip (no systemd as process 1, #1165), so
// ci.yml's `systemd-acceptance` job runs them on GitHub's VM on each push to main. This finds them by that gate,
// runs exactly them, and fails unless every one ran and passed: a skip here is a failure, so none of them can
// quietly run nowhere. Nothing is listed by hand, so a new test with that gate is run here too, in any directory
// under test/ (npm test runs dist/test/**/*.test.js). The gate has one spelling: any other mention of systemCi in a
// test file (`! systemCi`, `!(systemCi)`, a ternary, a check inside a test), or a skip on a flag shaped like it,
// stops the job.
//
// A test that needs systemd under another name is caught two ways (the owner's decision, 2026-11-08: option (b)):
//
// At run time, on the VM (R1169n, R1169p, R1169r, signTests): every test in a *.test.ts file that (a) holds
// systemd's sign (below) in its own function, (b) has a skip, a todo or an early return there whose condition reads
// what carries the sign, one name away (a local from it, an import whose export reads it in its own module, a module
// named at run time), (c) has a name holding the sign, or sits in a suite whose name does, or (d) (R1169v D1, fail
// closed) runs code that reads what carries the sign and mentions skip or todo in any form (a property, a key, a
// string): its own function with every function in it, each same-file function that code names, at any depth, and
// the hooks (before, beforeEach, after, afterEach) of each block around it, so a stop through a helper, a bound or
// computed t.skip, a loop, a label or a hook is judged here too; a function passed by name is its own, and a
// same-file object or class it names brings all its methods (R1169w D1); and code that reads what carries the sign
// and starts subtests (R1169w D4: a loop or an exit around them is the zero-subtest rule's here). Each runs here. Its whole
// file runs at once with no name filter, and each such test must have run and passed with no skip or todo, all of it,
// matched by built file, line and column as a gate is; and one whose function reads `test` on its context (a subtest)
// must have run one (the owner's option (b): no zero subtests). So a test that detects systemd and skips, marks itself
// todo, returns early, is registered only sometimes or sits in a suite that skips, fails here, where systemd is. One
// that legitimately skips here is named in the allowlist's `runtime`, with why.
//
// The guarantee is that run on the VM (the owner's option (b), 2026-11-09): every picked test runs there whole, and
// any skip, todo or zero-subtest result fails the job unless the allowlist's `runtime` excuses that test, pinned by
// its whole text (an edit voids the excuse) and naming where it runs for real. The static rule below is a first-pass
// hint that refuses what it can read early, on every PR; a shape it doesn't read is a named limit, not a defect.
//
// Before that, statically (R1169k, R1169m, R1169n, R1169o, signProblems), on every PR in the normal suite too: in every
// file the build compiles (tsconfig.json's include), the sign (`systemd` or `systemd1` as a word, a name starting
// `systemd_`/`SYSTEMD_`, `systemctl`, `journalctl`, `loginctl`, `/proc/1/`, `is-system-running`, `sd_booted`,
// INVOCATION_ID, NOTIFY_SOCKET, JOURNAL_STREAM), read by typescript's parser in every string (decoded too), template,
// regex and identifier, may be only in systemCi's declaration, a gate's reason, and, in a *.test.ts file, a test's or
// suite's name or a test's own function (which the VM runs). Anywhere else it must be data
// scripts/ci/systemd-acceptance-allow.json names by file and text, with why: each use by its token, the first and last
// lines of the statement around it, and the lines of its text that hold the sign (not every line of a long text, whose
// unrelated edits aren't changes), so a use moved, swapped or wrapped differently is a change. And a test's or suite's
// skip or todo may not read what carries the sign: an import from src/, from a file that holds the sign, or from a
// module named at run time (a non-literal import(), require() or createRequire(...)(...), or a module outside the build
// roots), or a local whose value comes, through any number of that file's own declarations and assignments (read with
// scopes), from one of those, from the sign or from a file read; unless the allowlist's skipImports names it, with
// why, and a local by the text of what makes it carry the sign.
//
// Registration is read by binding, failing closed (R1169u, R1169v): node:test's test, it, describe, suite, its
// default and the module itself (a named, renamed, default or namespace import, require(), import()) are known by what
// each name is bound to. Every reference to one must be a call, or a call of its .skip/.only/.todo (or a hook's,
// mock's), as a statement of its own; any other (an alias, an argument, Reflect.apply or .call, an array or object, a
// computed key, a conditional, a reassignment) stops the job. And what decides whether a registration runs is read as
// a skip is: each if, ?:, &&/||/??, switch or catch around it; each loop around it (its condition or iterable, unless
// it is a fixed table: a const array or object literal with no spread); each earlier statement in any block around it
// (a function's, a label's, the file's) that can return, break, continue or throw under a condition; and through a
// function, the same where it's called (an IIFE, a callback's call and its receiver, a same-file function at each
// call; one used otherwise as a value stops the job; one in a method, a constructor or kept as a property stops it
// too, R1169w D3), and an earlier process.exit()/abort() under a condition, or a
// same-file function that ends the process (R1169w); process.getBuiltinModule() is a load as require() is; a
// 'node:test' string anywhere but an allowlist of places stops the job (R1169z D2): a static import, a loader's first
// argument, a lookup's (`.includes`, `.has`) argument or receiving array, a const or Set read only by lookups, or an
// equality's operand; a function or holder name written anywhere but its declaration (any assignment, destructuring,
// a for...of head, a property, a second `var`) is no one function (R1169y D1, R1169z D1). node:test
// re-exported, or loaded (by name, or a module named at run time) where no declaration binds it (`import(...).then`,
// an argument), stops the job (R1169w D2); a module named at run time is read as node:test for its test/describe
// calls. A registration's function is its own inline, or one this file declares named there; any other (an import,
// a parameter, a call's result) stops the job (R1169w D1). A subtest's (`t.test`, a test() inside a test) is read up to its
// test's function. A parameter is what each call passes in its place; one of a function that is exported, used as a
// value or called with a spread, read by a skip or such a condition, stops the job. Options by name must be a const
// object literal used only as options; any other stops the job (it could be set after: `Object.defineProperty`).
//
// What neither can see (named limits, by the owner's choice, 2026-11-08, option (a): tests whose body holds the sign,
// guarded stops and the name rule): a skip on a proxy with no sign anywhere in its file (`process.getuid() === 0`, a
// cgroup path: R1169n N04); a sign split inside a word (`'sys' + 'temd'`, deliberate); a value carried through a file
// that holds no sign itself, or through more than one module (a src/ helper wrapping a holder's detector); R1169r's
// indirect reach (a property of a shared object, a global, an env variable set from the sign: D2; an aliased
// createRequire: D3; a re-export: D4); a stop inside a catch or a switch (R1169q); a name rule that is lexical (a
// name built at run time, or a test registered through a helper whose own name and body hold no sign, isn't read as
// holding it); the subtest rule's reach (a subtest started through a helper in another module, or through a
// property of an object that holds the context, isn't counted); a registration in another module (a helper module's
// exported function, called from here under a condition, is read only as a call); a skip or todo spelled from
// parts (`t['sk' + 'ip']`, deliberate, as a split sign is); and a throw at load that something catches (one that
// isn't caught fails its file, which isn't silent; a process.exit() before a registration is read, R1169w), or an
// expression in a try that throws on what carries the sign before a registration in it (R1169w R14: any call can
// throw); a module named at run time used other than through its calls (an alias of its test); and a process ending
// not spelled `process.exit()` (or abort, kill), as `const { exit } = process` or `globalThis.process.exit()` (R1169y
// minor 3: any call can end the process, as any can throw). #1250 tracks measuring the
// alternative, the whole suite on the VM.
//
// A test that passes having checked less, on what only this VM answers (an early return, or a subtest started only
// sometimes, on GITHUB_ACTIONS, the uid or PROJECT_SANDBOX_REQUIRED; R1169ab D2), fails here (the owner's decision of
// 2026-11-10, option (2)). Each gate opens with `t.plan(<n>)` (planProblems: refused statically without it), so node
// fails it when it made fewer `t.assert` calls and subtests; no t.assert sits in a try with a catch, and each subtest
// opens with its own count. Each sign test's file runs with V8's block coverage (NODE_V8_COVERAGE; mustRun, the
// owner's option (b) of 2026-11-10, judged by position since R1169ag/ah): in the test's own function and, recursively,
// each subtest's (`t.test`, `t['test']`, an alias; a function given by name is read when this file declares it once,
// else refused), every use of the sign must have run, each function must have run to its end every time it ran
// (the count just before its closing brace equals its own call count, R1169aj D1), and each subtest must have
// started. Each is judged by the innermost range around its own position, never by its line: a branch not taken,
// braced or not, a loop body never entered, an operand of `?:` `&&` `||` `??` never evaluated, a function never called
// that holds the sign, and the code after a `return`, `throw`, `break` or `continue` are ranges of their own. The
// file's coverage must come from one process, its own run (R1169ai D1): a child process or a worker that loads it
// again fails the run.
// Refused before the run (exit 2), where V8 keeps no count of its own (measured, R1169ae/af/ah/aj): a sign in a `try`
// that has a `catch` (a throwing call before it), in an optional call's arguments (a short-circuit), in a default
// value (a parameter's or a destructuring's), on the right of `??=`, `||=` or `&&=`, in a for loop's update, past an
// optional chain's receiver or in a do…while condition; a function whose last statement ends at its closing brace
// (where it ended can't be read); and a test or subtest function given by a name the file declares more than once
// (which one is meant can't be read without scope). Control flow is read before the run, not from coverage (the
// organizer's direction on R1169ak/al: V8 gives a taken `return` no count before an operand or a `try … finally`):
// in the test's function, each subtest's and every function inside them, a `return` that isn't its function's last
// statement (but `return <ctx>.skip(…)`/`.todo(…)`), and a `break` or `continue` whose loop or label holds the sign.
// Named limits of that check, each measured on real block coverage (R1169ac-aj; the r1169ah-block-* fixtures):
// - a call that throws before the sign, when something other than a `try` around the sign takes the throw (a caller's
//   try, assert.throws/rejects, a promise's catch, Promise.allSettled, a `finally` that returns, an unawaited
//   Promise): V8 starts no new count after a call, so the rest of its block reads as run;
// - a generator's body (`function*`, `async function*`) when the generator is made but never iterated;
// - one function run for more than one test or subtest (a loop, a helper that registers, one function given to two
//   subtests) shares its counts: a sign in a branch only some of its runs take reads as run (an early return in any
//   of them doesn't: the end count is per call);
// - a branch, loop, catch or never-called callback around assertions alone (no sign in it), and a `break` or
//   `continue` out of a loop or block that holds assertions alone (R1169ak D2);
// - code in a helper the test calls in another function; and an excused test (it skips here) isn't judged on it.
//
// Results come from node's test events (systemd-acceptance-reporter.mjs, R1169f), not from TAP text: each gate is
// matched by its built file, the line and column its test() call is on, and its name, and the reporter writes to a
// pipe (fd 3) no test process holds. A named limit, by the owner's threat model (2026-11-10: test code is trusted;
// R1169ab D1): those events are not out of a test file's reach. Node's runner reads them from each test file's own process, as frames on that process's stdout, which
// the file's code holds: a test file that rewrites its own stdout (or its exit code) can turn a failure or a skip
// into a pass. The run trusts the test files' code not to forge its own results.
//
//   node scripts/ci/systemd-acceptance.mjs            (after npm ci and the build: it runs dist/test/<file>.js)
//   node scripts/ci/systemd-acceptance.mjs --signs    (each file's uses of the sign, by exact text, for the allowlist)
//
// Exit 1: a gate or a sign test failed, skipped, was a todo, didn't run, (a gate) ran more than once, has a subtest
// that didn't pass, or (one that starts subtests) ran no subtest; a run failed or ran no test; or a test here skipped
// naming systemd. Exit 2: no such test was found, a file couldn't be read, a gate isn't one it reads, or the sign is
// somewhere the rule refuses.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
/** The suite's isolation preload, as every runner of it passes it (test/isolate.ts). */
const PRELOAD = ['--import', './dist/test/isolate.js'];
/** The reporter that writes node's own results as JSON lines (systemd-acceptance-reporter.mjs). */
const REPORTER = fileURLToPath(new URL('./systemd-acceptance-reporter.mjs', import.meta.url));

/** The typescript package (the build's own, a devDependency), which parses each file for the sign rule. */
const typescript = () => {
  try {
    return createRequire(join(root, 'package.json'))('typescript');
  } catch {
    throw new Error('the typescript package (npm ci) is needed to read the build roots for systemd\'s sign');
  }
};

/** A JS string literal's body, unescaped (\\, \', \", \` and \n; the names here use no other escape). */
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * Each `test(<name>, { skip: !systemCi ...` in `text`, as its name. The gate must be the options' first key, as every
 * such test writes it; `gateCount` counts every `skip: !systemCi` so a caller can see none was missed.
 */
export function systemdTests(text) {
  return gatesOf(text).map((g) => g.name);
}

/** The gate regex: `test(<name>, { skip: !systemCi`, `test` with a member's `.` before it (`t.test(`) or not. */
const GATE = /(?<![\w$])test\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*\{\s*skip:\s*!systemCi\b/g;

/**
 * Each gate in `text`: its name, the line its `test(` is on (1-based, as node reports a test's location), and whether
 * it is a subtest's (`t.test(`), which the job refuses (R1169e): the run selects top-level tests by name.
 */
export function gatesOf(text) {
  return [...text.matchAll(GATE)].map((m) => {
    const before = text.slice(0, m.index);
    const lineStart = before.slice(before.lastIndexOf('\n') + 1);
    return {
      name: unescape(m[2]),
      line: before.split('\n').length,
      // Where node reports the test: the `test` token's column, 1-based (R1169h: a namesake on the same line is elsewhere).
      column: lineStart.length + 1,
      // A member call (`t.test(`, `sub.test (`): a `.` right before it on its line.
      member: /\.[ \t]*$/.test(lineStart),
      // The gate must be its line's first statement (only spaces, or `await`, before it), so no other call shares it.
      first: /^[ \t]*(?:await[ \t]+)?$/.test(lineStart),
      // A template name with `${...}` isn't the text the run selects by.
      computed: m[1] === '`' && m[2].includes('${'),
    };
  });
}

/** How many times `text` gates something on systemCi the way systemdTests reads it. */
export const gateCount = (text) => (text.match(/\bskip:\s*!systemCi\b/g) ?? []).length;

/**
 * How many times `text` mentions the identifier systemCi other than to declare it (`const systemCi =`). Each must
 * be a gate systemdTests reads: a gate spelled any other way (`! systemCi`, `!(systemCi)`, `systemCi ? ... : ...`)
 * or a check of it anywhere else is a mention that isn't one, and findAll refuses the file.
 */
export const mentionCount = (text) => (text.match(/\bsystemCi\b/g) ?? []).length - (text.match(/\bconst\s+systemCi\s*=/g) ?? []).length;

/**
 * Each `skip:` option's expression in `text`: from `skip:` to the first `,` or `}` outside brackets, across lines (a
 * value on the line after `skip:`, R1169e), at most 400 characters, comments left out.
 */
export function skipExprs(text) {
  const out = [];
  for (const m of text.matchAll(/\bskip\s*:/g)) {
    let depth = 0;
    let k = m.index + m[0].length;
    const end = Math.min(text.length, k + 400);
    let quote = null;
    for (; k < end; k++) {
      const c = text[k];
      if (quote) {
        if (c === '\\') k++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    out.push(text.slice(m.index + m[0].length, k).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '));
  }
  return out;
}
const unquoted = (e) => e.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''");

/**
 * How many `skip:` options in `text` look like a systemd gate: their expression names a flag like `system…Ci`
 * (`systemdCi`, `isSystemCi`, `SYSTEM_CI`; a string's words don't count, as "needs systemd" in a test that checks for
 * systemctl itself). Each must be a gate systemdTests reads, so a flag renamed (R1169d) stops the job.
 */
export const gateLikeCount = (text) => skipExprs(text).filter((e) => /(?<![\w$])[A-Za-z_$]*system[\w$]*ci(?![\w$])/i.test(unquoted(e))).length;

/**
 * systemd's sign (R1169k, R1169m): what code that asks "is systemd here?" has to read. The program and folder name
 * (`systemd` as a whole word: `/run/systemd`, `'systemd'`, `systemd-run`; and `systemd1`, its D-Bus name), a name
 * that starts `systemd_` or `SYSTEMD_`, `systemctl`, `journalctl`, `loginctl`, `/proc/1/` (process 1: comm, exe,
 * cmdline), `is-system-running`, `sd_booted`, and the variables systemd sets (INVOCATION_ID, NOTIFY_SOCKET, JOURNAL_STREAM). Read in
 * every string, template, regex and identifier the parser sees, as written and as decoded (`'\x73ystemd'` too), so a
 * path built from parts (`'/run' + '/systemd'`) still holds one. Comments don't count.
 */
const SIGN = /(?<![\w$])(?:systemd1?|systemctl|journalctl|loginctl|is-system-running|sd_booted|INVOCATION_ID|NOTIFY_SOCKET|JOURNAL_STREAM)(?![\w$])|(?<![\w$])(?:systemd|SYSTEMD)_|\/proc\/1\//;

/** Whether `text` may hold the sign: as written, or behind an escape the parser decodes (`\x73`, `\u0073`). */
const maySign = (text) => new RegExp(SIGN.source).test(text) || /\\[xu]/.test(text);

/** `path` parsed by typescript, as JS or TS by its name. */
const parsedCache = new Map();
const parsed = (ts, path, text) => {
  const hit = parsedCache.get(path);
  if (hit && hit.text === text) return hit.sf;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  parsedCache.set(path, { text, sf });
  return sf;
};

/** The sign a leaf holds (its first match, as written or as decoded), or null. */
function leafSign(ts, sf, n) {
  const texts = [];
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) texts.push(n.text);
  else if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) texts.push(n.getText(sf), n.text);
  else if (ts.isRegularExpressionLiteral(n) || ts.isNumericLiteral(n) || n.kind === ts.SyntaxKind.JsxText) texts.push(n.getText(sf));
  for (const t of texts) {
    const m = SIGN.exec(t);
    if (m) return m[0];
  }
  return null;
}

/** Whether `node` holds the sign in any leaf. */
function leafSignIn(ts, sf, node) {
  let hit = false;
  const walk = (x) => {
    if (hit) return;
    if (leafSign(ts, sf, x)) hit = true;
    else ts.forEachChild(x, walk);
  };
  walk(node);
  return hit;
}

/** A test call's own function: its last argument, when it is a function (`test(name, fn)`, `test(options, fn)`, `test(fn)`). */
const ownFunction = (ts, n) => {
  const fn = n.arguments[n.arguments.length - 1];
  return fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : null;
};
/** A test's or suite's name: its first argument when that is text (a string or a template), never an options object (R1169p D3). */
const nameArg = (ts, n) => {
  const a = n.arguments[0];
  return a && (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a)) ? a : null;
};

/**
 * Where the sign may be (R1169k; R1169n's runtime check): systemCi's declaration in a *.test.ts file, a gate's reason,
 * a test's or a suite's name, and a test's own function. A test whose own function holds the sign is run on the VM by
 * the acceptance job (signTests), where any skip or todo in it fails, so a detector there can't hide it.
 */
function allowedSpans(ts, sf, testFile, kindOf) {
  const spans = [];
  // What a call registers, by binding as signTests reads it (R1169v D2): an aliased or default test() is a test here too.
  const isTestCall = (_, n) => kindOf(n) === 'test';
  const isSuiteCall = (_, n) => kindOf(n) === 'suite';
  const visit = (n) => {
    if (testFile && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'systemCi' && n.initializer) spans.push([n.initializer.getStart(sf), n.initializer.end]);
    // Only in a *.test.ts file: the run picks tests from those alone, so a helper module's test() is never run on the
    // VM, and its function may not hold the sign (R1169o C1, R1169p D1).
    const name = testFile && (isTestCall(ts, n) || isSuiteCall(ts, n)) ? nameArg(ts, n) : null;
    if (name) spans.push([name.getStart(sf), name.end]);
    if (testFile && isTestCall(ts, n)) {
      const fn = ownFunction(ts, n);
      if (fn) spans.push([fn.getStart(sf), fn.end]);
      // A gate's reason: `{ skip: !systemCi && 'needs systemd' }`.
      const o = n.arguments.length > 2 ? n.arguments[1] : null;
      const first = o && ts.isObjectLiteralExpression(o) ? o.properties[0] : null;
      const e = first && ts.isPropertyAssignment(first) && ts.isIdentifier(first.name) && first.name.text === 'skip' ? first.initializer : null;
      if (e && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && ts.isPrefixUnaryExpression(e.left) && e.left.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(e.left.operand) && e.left.operand.text === 'systemCi' && ts.isStringLiteralLike(e.right)) spans.push([e.right.getStart(sf), e.right.end]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return spans;
}

/**
 * Each place `text` (the file `path`) holds systemd's sign outside the places it may (R1169k), as { at: `line:
 * token`, pin: `token: <the line's text, trimmed>` }. Anywhere but systemCi's declaration, a gate's reason, a test's or
 * suite's name or a test's own function, it's a use: a skip could read it under another name, at any number of steps,
 * so each must be one the allowlist names by its exact text (systemd-acceptance-allow.json). `ts`: typescript.
 */
export function signUseList(ts, path, text) {
  if (!maySign(text)) return [];
  const sf = parsed(ts, path, text);
  const kindOf = fileFlow(ts, path, text, { paths: new Set(), carries: () => false, fileReads: false }).callKind;
  const spans = allowedSpans(ts, sf, path.endsWith('.test.ts'), kindOf);
  const lines = text.split('\n');
  const out = [];
  const visit = (n) => {
    const token = leafSign(ts, sf, n);
    if (token) {
      const at = n.getStart(sf);
      if (!spans.some(([a, b]) => at >= a && n.end <= b)) {
        const line = sf.getLineAndCharacterOfPosition(at).line;
        const last = sf.getLineAndCharacterOfPosition(n.end).line;
        // A leaf over several lines (a template) is pinned by its first line and every line of it that holds the sign
        // (R1169o: a sign on its second line went unpinned). Not by every line: the CLI's usage text is one template
        // of hundreds of lines, and any edit to it would change the pin.
        // And the first and last lines of the statement around it (R1169r D6: the lines around a multi-line stub
        // changed so that it ran as a live check). A line holds the sign as maySign reads it, escapes too (R1169q).
        let st = n;
        while (st.parent && !ts.isSourceFile(st.parent) && !ts.isBlock(st.parent) && !ts.isModuleBlock(st.parent) && !ts.isCaseClause(st.parent) && !ts.isDefaultClause(st.parent)) st = st.parent;
        const first = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line;
        const end = sf.getLineAndCharacterOfPosition(st.end).line;
        const keep = new Set([first, line, end]);
        // A compound statement (an if, a loop, a switch, a try, a function or class) is pinned whole: its body could
        // change freely between its first and last lines (R1169t D5).
        if (ts.isIfStatement(st) || ts.isIterationStatement(st, false) || ts.isSwitchStatement(st) || ts.isTryStatement(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isLabeledStatement(st) || ts.isBlock(st)) for (let k = first; k <= end; k++) keep.add(k);
        for (let k = line; k <= last; k++) if (maySign(lines[k])) keep.add(k);
        out.push({ at: `${line + 1}: ${token}`, pin: `${token}: ${[...keep].sort((a, b) => a - b).map((k) => lines[k].trim()).join('\n')}` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** signUseList's places, as `line: token`. */
export const signUses = (ts, path, text) => signUseList(ts, path, text).map((u) => u.at);

/**
 * A relative specifier from `path`, resolved to a build-root path in `paths` (`./x.js` to `test/x.ts`); `?` for one
 * outside them; a package's name as written.
 */
/** A member access's name: `x.name`, or `x['name']` with a literal key; else null. */
function memberName(ts, x) {
  if (ts.isPropertyAccessExpression(x)) return x.name.text;
  if (ts.isElementAccessExpression(x) && ts.isStringLiteralLike(x.argumentExpression)) return x.argumentExpression.text;
  return null;
}
/** Whether an identifier reads a name: not a declaration's own name, a property's name, a label, or in a type. */
function isRef(ts, id) {
  const p = id.parent;
  if (!p) return false;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isBindingElement(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isEnumDeclaration(p) || ts.isTypeParameterDeclaration(p)) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isExportSpecifier(p) && p.propertyName && p.name === id) return false;
  for (let q = p; q && !ts.isSourceFile(q); q = q.parent) {
    if (ts.isTypeNode(q) && !ts.isExpressionWithTypeArguments(q)) return false;
    if (ts.isBlock(q) || ts.isFunctionLike(q)) break;
  }
  return true;
}

function resolveFrom(path, spec, paths) {
  if (!spec.startsWith('.')) return spec;
  const parts = path.split('/').slice(0, -1);
  for (const x of spec.split('/')) {
    if (x === '..') parts.pop();
    else if (x !== '.') parts.push(x);
  }
  const p = parts.join('/');
  for (const c of [p, p.replace(/\.([cm]?)js$/, '.$1ts'), `${p}.ts`, `${p}/index.ts`]) if (paths.has(c)) return c;
  // A relative module outside what the build compiles (scripts/, a JSON file): not read here, so not known (R1169o C2).
  return '?';
}

/**
 * What `text` (the file `path`) binds from other modules and which of its names carry systemd's sign (R1169k,
 * R1169m, R1169n): `bound`, each imported name (named, renamed, namespace as `*`, default as `default`, or a
 * `require()`/`import()` result) to `<module>: <name>`, `<module>` the build-root path it resolves to, `?` for a
 * specifier that isn't a string literal; and `tainted`, each local name whose value comes, through any number of
 * this file's own declarations and assignments, from the sign, from a binding `source(b)` says is one (src/, a file
 * that holds the sign, a module outside what it can read), or from a file read (`readFileSync`, `readFile`: data
 * outside the scanned code, as a JSON table).
 */
export function fileFlow(ts, path, text, source) {
  const sf = parsed(ts, path, text);
  const unparen = (x) => {
    while (x && ts.isParenthesizedExpression(x)) x = x.expression;
    return x;
  };
  // Scopes: each declaration's name belongs to the nearest block, function, loop or file around it, and a name read is
  // the nearest declaration of it outward, so two functions' own `r` are two names.
  const isScope = (n) => ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseBlock(n) || ts.isCatchClause(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isFunctionLike(n) || ts.isClassLike(n);
  const scopes = new Map();
  const declare = (scope, name, d) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    // A name declared twice in one scope (`var body = ...; var body = ...`, R1169z D1) is no single function.
    const old = scopes.get(scope).get(name);
    if (old) d.redeclares = old;
    scopes.get(scope).set(name, d);
  };
  const scopeOf = (n) => {
    let s = n.parent;
    while (s && !isScope(s)) s = s.parent;
    return s ?? sf;
  };
  const resolve = (id) => {
    for (let s = id.parent; s; s = s.parent) if (isScope(s) && scopes.get(s)?.has(id.text)) return scopes.get(s).get(id.text);
    return null;
  };
  /** Each declaration: { name, binding (`<module>: <name>` for an import, else null), nodes (what its value comes from) }. */
  const decls = [];
  const add = (scope, nameNode, binding, node) => {
    const d = { name: nameNode.text, binding, nodes: node ? [node] : [], texts: node ? [textOf(node)] : [] };
    decls.push(d);
    declare(scope, nameNode.text, d);
    return d;
  };
  const bindAll = (scope, name, module, imported, node) => {
    if (ts.isIdentifier(name)) add(scope, name, `${module}: ${imported}`, null);
    else for (const e of name.elements ?? []) if (!ts.isOmittedExpression(e)) bindAll(scope, e.name, module, e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName.text : ts.isIdentifier(e.name) ? e.name.text : imported, node);
  };
  const declAll = (scope, name, node, acc = []) => {
    if (ts.isIdentifier(name)) acc.push(add(scope, name, null, node));
    else for (const e of name.elements ?? []) if (!ts.isOmittedExpression(e)) declAll(scope, e.name, node, acc);
    return acc;
  };
  /** Each function's parameters, to link them to what its callers pass (R1169v D3). */
  const params = [];
  /** A statement's text, its whitespace runs made one space: what pins a local the allowlist names (R1169o C4). */
  const textOf = (n) => statementOf(n).getText(sf).replace(/\s+/g, ' ').trim();
  /** Names bound to a `createRequire(...)` result, which load a module as `require` does (R1169o C2). */
  const requires = new Set(['require']);
  const isCreateRequire = (x) => ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'createRequire';
  /** The module a `require()`, `import()` or createRequire'd call in `n` loads: its specifier, '?' when it isn't a literal, or null. */
  const loads = (n) => {
    let spec = null;
    const walk = (x) => {
      if (spec) return;
      // process.getBuiltinModule(...) loads a built-in as require() does (R1169w): any getBuiltinModule call.
      const builtin = ts.isCallExpression(x) && ((ts.isIdentifier(x.expression) && x.expression.text === 'getBuiltinModule') || (ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'getBuiltinModule'));
      if (ts.isCallExpression(x) && (builtin || x.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(x.expression) && requires.has(x.expression.text)) || isCreateRequire(x.expression))) spec = x.arguments[0] && ts.isStringLiteralLike(x.arguments[0]) ? x.arguments[0].text : '?';
      else ts.forEachChild(x, walk);
    };
    walk(n);
    return spec;
  };
  const statementOf = (n) => {
    let s = n;
    while (s.parent && !ts.isSourceFile(s.parent) && !ts.isBlock(s.parent) && !ts.isModuleBlock(s.parent) && !ts.isCaseClause(s.parent)) s = s.parent;
    return s;
  };
  const assignments = [];
  /** What the module exports: name to declaration, `*` re-exports' modules, and the default export's node. */
  const exported = new Map();
  const reexportAll = [];
  let defaultNode = null;
  const names = (b, out = []) => {
    if (ts.isIdentifier(b)) out.push(b.text);
    else for (const e of b.elements ?? []) if (!ts.isOmittedExpression(e)) names(e.name, out);
    return out;
  };
  const exportedNow = (n) => !!(ts.getCombinedModifierFlags?.(n) & ts.ModifierFlags.Export);
  const visit = (n) => {
    if (ts.isVariableStatement(n) && exportedNow(n)) for (const d of n.declarationList.declarations) for (const x of names(d.name)) exported.set(x, () => scopes.get(sf)?.get(x));
    else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && exportedNow(n)) {
      if (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) defaultNode = n;
      const x = n.name.text;
      exported.set(x, () => scopes.get(sf)?.get(x));
    } else if (ts.isExportAssignment(n)) defaultNode = n.expression;
    else if (ts.isExportDeclaration(n) && !n.isTypeOnly) {
      const m = n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? resolveFrom(path, n.moduleSpecifier.text, source.paths) : null;
      if (!n.exportClause) reexportAll.push(m ?? '?');
      else if (ts.isNamedExports(n.exportClause)) {
        for (const e of n.exportClause.elements) {
          const local = (e.propertyName ?? e.name).text;
          exported.set(e.name.text, m ? () => ({ binding: `${m}: ${local}`, nodes: [], texts: [] }) : () => scopes.get(sf)?.get(local));
        }
      } else if (m) exported.set(n.exportClause.name.text, () => ({ binding: `${m}: *`, nodes: [], texts: [] }));
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause && !n.importClause.isTypeOnly) {
      const m = resolveFrom(path, n.moduleSpecifier.text, source.paths);
      const c = n.importClause;
      if (c.name) add(sf, c.name, `${m}: default`, null);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) add(sf, nb.name, `${m}: *`, null);
      else if (nb) for (const e of nb.elements) if (!e.isTypeOnly) add(sf, e.name, `${m}: ${(e.propertyName ?? e.name).text}`, null);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      add(sf, n.name, `${resolveFrom(path, n.moduleReference.expression.text, source.paths)}: *`, null);
    } else if (ts.isVariableDeclaration(n)) {
      const scope = scopeOf(n);
      if (n.initializer && isCreateRequire(n.initializer) && ts.isIdentifier(n.name)) requires.add(n.name.text);
      const spec = n.initializer ? loads(n.initializer) : null;
      if (spec) bindAll(scope, n.name, spec === '?' ? '?' : resolveFrom(path, spec, source.paths), '*', n.initializer);
      // systemCi is the gate itself: its declaration is the one place the sign may feed a skip.
      // A for...of or for...in variable's value comes from its loop's expression (R1169t D3).
      else if (!n.initializer && n.parent && ts.isVariableDeclarationList(n.parent) && n.parent.parent && (ts.isForOfStatement(n.parent.parent) || ts.isForInStatement(n.parent.parent))) for (const d of declAll(scope, n.name, n.parent.parent.expression)) d.varDecl = n;
      else if (!(ts.isIdentifier(n.name) && n.name.text === 'systemCi')) {
        for (const d of declAll(scope, n.name, n.initializer ?? null)) {
          d.varDecl = n;
          const init = n.initializer && unparen(n.initializer);
          if (ts.isIdentifier(n.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) d.fnNode = init;
          else if (ts.isIdentifier(n.name) && init && (ts.isObjectLiteralExpression(init) || ts.isClassExpression(init) || ts.isArrayLiteralExpression(init))) d.holder = init;
        }
      } else add(scope, n.name, null, null);
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) {
      const d = add(scopeOf(n), n.name, null, n);
      if (ts.isFunctionDeclaration(n) && n.body) d.fnNode = n;
      else if (ts.isClassDeclaration(n)) d.holder = n;
    } else if (ts.isParameter(n)) {
      const ds = declAll(n.parent, n.name, n.initializer ?? null);
      for (const d of ds) d.param = true;
      params.push({ fn: n.parent, index: n.parent.parameters.indexOf(n), rest: !!n.dotDotDotToken, ds });
    }
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left)) assignments.push([n.left, statementOf(n), n.right]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // An assignment adds where its statement reads from to the declaration it assigns (`if (sign) booted = true`).
  for (const [id, st, right] of assignments) {
    const d = resolve(id);
    if (d) {
      d.nodes.push(st);
      d.texts.push(textOf(st));
    }
  }
  // Every reference to each declaration (a name read, not a declaration, a property name, a label or a type).
  const refs = new Map();
  const walkRefs = (x) => {
    if (ts.isIdentifier(x) && isRef(ts, x)) {
      const d = resolve(x);
      if (d) {
        if (!refs.has(d)) refs.set(d, []);
        refs.get(d).push(x);
      }
    }
    ts.forEachChild(x, walkRefs);
  };
  walkRefs(sf);
  const refsOf = (d) => refs.get(d) ?? [];
  // Every write to a name, from its references (R1169z D1): an assignment of any operator, a destructuring target, a
  // for...of/in head, ++/--, a property written on it (`h.need = ...`), or a second declaration. A name written
  // anywhere but its declaration is no single function: as a test's function it can't be read (refused); as a helper,
  // every function or holder in what it's given is followed (a name there, by its own).
  const writeOf = (r) => {
    let x = r;
    for (;;) {
      const p = x.parent;
      if (!p) return null;
      if (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || (ts.isShorthandPropertyAssignment(p) && p.name === x) || (ts.isPropertyAssignment(p) && p.initializer === x) || ts.isNonNullExpression(p) || ts.isAsExpression(p)) {
        x = p;
        continue;
      }
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === x && x === r) {
        // A property written on it: `h.need = ...`, `h['need'] = ...`.
        const q = p.parent;
        return q && ts.isBinaryExpression(q) && q.left === p && q.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && q.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? { value: q.right } : null;
      }
      if (ts.isBinaryExpression(p) && p.left === x && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return { value: p.right };
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === x) return { value: p.expression };
      if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return { value: null };
      return null;
    }
  };
  const valueFns = (v, acc, seen = new Set()) => {
    const walk = (y) => {
      if (!y) return;
      if (ts.isArrowFunction(y) || ts.isFunctionExpression(y) || ts.isObjectLiteralExpression(y) || ts.isClassExpression(y) || ts.isArrayLiteralExpression(y)) return void acc.push(y);
      if (ts.isIdentifier(y) && isRef(ts, y)) {
        const e = resolve(y);
        if (e && !seen.has(e)) {
          seen.add(e);
          for (const g of [e.fnNode, e.holder, ...(e.allFns ?? [])]) if (g) acc.push(g);
        }
      }
      ts.forEachChild(y, walk);
    };
    walk(v);
    return acc;
  };
  for (const d of decls) {
    const writes = refsOf(d).map(writeOf).filter(Boolean);
    const old = d.redeclares;
    if (!writes.length && !old) continue;
    d.reassigned = true;
    d.allFns = [d.fnNode, d.holder, old?.fnNode, old?.holder].filter(Boolean);
    if (old) old.reassigned = true;
    for (const w of writes) valueFns(w.value, d.allFns);
  }
  /** The declaration of the function `fn` is (a function declaration, or `const f = () => ...`), or null. */
  const fnDecl = (fn) => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return resolve(fn.name);
    let fx = fn;
    while (fx.parent && ts.isParenthesizedExpression(fx.parent)) fx = fx.parent;
    const v = fx.parent;
    return v && ts.isVariableDeclaration(v) && v.initializer === fx && ts.isIdentifier(v.name) ? resolve(v.name) : null;
  };
  /** What a callback's parameters come from: its call's receiver and the call's other arguments (`xs.forEach((x) => ...)`). */
  const callbackSources = (call, fx) => [...(ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression) ? [call.expression.expression] : []), ...call.arguments.filter((a) => a !== fx)];
  // A parameter's value comes from what each call passes in its place (R1169v D3): an IIFE's or a same-file function's
  // arguments; a callback's call's receiver and other arguments. A same-file function that escapes (used as a value
  // other than a callback, exported, or called with a spread) has callers this can't read: its parameters say so.
  const link = (entry, call) => {
    const args = entry.rest ? call.arguments.slice(entry.index) : call.arguments[entry.index] ? [call.arguments[entry.index]] : [];
    for (const d of entry.ds) for (const a of args) (d.nodes.push(a), d.texts.push(textOf(a)));
  };
  const byFn = new Map();
  for (const e of params) byFn.set(e.fn, [...(byFn.get(e.fn) ?? []), e]);
  for (const [fn, entries] of byFn) {
    let fx = fn;
    while (fx.parent && ts.isParenthesizedExpression(fx.parent)) fx = fx.parent;
    const up = fx.parent;
    const escape = () => entries.forEach((e) => e.ds.forEach((d) => (d.escapes = true)));
    if (up && ts.isCallExpression(up) && up.expression === fx) for (const e of entries) link(e, up);
    else if (up && ts.isCallExpression(up) && up.arguments.includes(fx)) {
      for (const e of entries) for (const d of e.ds) for (const a of callbackSources(up, fx)) (d.nodes.push(a), d.texts.push(textOf(a)));
    } else {
      const d = fnDecl(fn);
      if (!d) continue;
      if (exportedNow(ts.isFunctionDeclaration(fn) ? fn : d.varDecl?.parent?.parent ?? fn)) escape();
      for (const r of refsOf(d)) {
        const rp = r.parent;
        if (ts.isCallExpression(rp) && rp.expression === r) {
          if (rp.arguments.some((a) => ts.isSpreadElement(a))) escape();
          else for (const e of entries) link(e, rp);
        } else if (ts.isCallExpression(rp) && rp.arguments.includes(r)) {
          for (const e of entries) for (const x of e.ds) for (const a of callbackSources(rp, r)) (x.nodes.push(a), x.texts.push(textOf(a)));
        } else escape();
      }
    }
  }
  // node:test's values, by what each name is bound to (R1169v D2): `<kind>` for a name bound to node:test's test, it
  // or default (`test`), describe or suite (`suite`), the module itself (`space`: a namespace, require() or import()
  // result, which is test too), or another export (`other`: a hook, mock); null for anything else.
  const NT = 'node:test: ';
  const testValue = (id) => {
    const b = resolve(id)?.binding;
    // A test/describe destructured from a module named at run time could be node:test's (R1169y minor 2).
    if (b?.startsWith('?: ') && /^(?:test|it|describe|suite|default)$/.test(b.slice(3))) return /^(?:describe|suite)$/.test(b.slice(3)) ? 'suite' : 'test';
    if (!b?.startsWith(NT)) return null;
    const x = b.slice(NT.length);
    return /^(?:test|it|default)$/.test(x) ? 'test' : /^(?:describe|suite)$/.test(x) ? 'suite' : x === '*' ? 'space' : 'other';
  };
  /**
   * What a call registers: `test` (a test), `suite`, `sub` (a subtest: a `test` read on another object, `t.test(...)`,
   * `t['test'](...)`), or null. With `.skip`, `.only` or `.todo`. node:test's values by binding (aliases, the default,
   * a namespace); an unbound name by its spelling, unless it names a function this file defines itself.
   */
  const callKind = (n) => {
    if (!ts.isCallExpression(n)) return null;
    let c = unparen(n.expression);
    if (/^(?:only|skip|todo)$/.test(memberName(ts, c) ?? '')) c = unparen(c.expression);
    if (ts.isIdentifier(c)) {
      const v = testValue(c);
      if (v === 'test' || v === 'space') return 'test';
      if (v) return v === 'suite' ? 'suite' : null;
      // Bound to anything else (a local, a parameter, product code's own describe()): not node:test's; unbound (a
      // global), or a test-side module's test/it/describe/suite (a re-export of node:test's), by its name.
      const d = resolve(c);
      const name = !d ? c.text : d.binding?.startsWith('test/') ? d.binding.slice(d.binding.lastIndexOf(': ') + 2) : null;
      return name && /^(?:test|it)$/.test(name) ? 'test' : name && /^(?:describe|suite)$/.test(name) ? 'suite' : null;
    }
    const nm = memberName(ts, c);
    if (!nm) return null;
    const o = unparen(c.expression);
    if (ts.isIdentifier(o) && testValue(o) === 'space') return /^(?:test|it|default)$/.test(nm) ? 'test' : /^(?:describe|suite)$/.test(nm) ? 'suite' : null;
    // Another object's test(name, ..., fn): a subtest (`t.test`, `t['test']`), not a regex's `.test(s)`.
    const last = n.arguments[n.arguments.length - 1];
    // A module named at run time could be node:test (R1169w D2): its test/describe calls are registrations, read in full.
    if (ts.isIdentifier(o) && resolve(o)?.binding?.startsWith('?: ')) return /^(?:test|it|default)$/.test(nm) ? 'test' : /^(?:describe|suite)$/.test(nm) ? 'suite' : null;
    // A function by name counts on a context (a parameter, `t.test(name, body)`), not on product code's own `this.test(...)`.
    const named = !!last && ts.isIdentifier(last) && ts.isIdentifier(o) && (!!resolve(last)?.fnNode || !!resolve(o)?.param);
    return /^(?:test|it|describe|suite)$/.test(nm) && n.arguments.length >= 2 && last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last) || named) ? 'sub' : null;
  };
  const sourceOf = (b) => source.carries(b.slice(0, b.lastIndexOf(': ')), b);
  const tainted = new Set();
  /** Whether `node` reads the sign, a carrying binding, a file, or a name already tainted. */
  const carries = (node) => {
    let hit = false;
    const walk = (x) => {
      if (hit) return;
      if (leafSign(ts, sf, x)) hit = true;
      else if (ts.isIdentifier(x) && !(x.parent && ts.isPropertyAccessExpression(x.parent) && x.parent.name === x) && !(x.parent && ts.isPropertyAssignment(x.parent) && x.parent.name === x)) {
        const d = resolve(x);
        if (d && (tainted.has(d) || (d.binding && sourceOf(d.binding)))) hit = true;
      } else if (source.fileReads !== false && ts.isCallExpression(x) && /^(?:readFileSync|readFile)$/.test(ts.isIdentifier(x.expression) ? x.expression.text : ts.isPropertyAccessExpression(x.expression) ? x.expression.name.text : '')) hit = true;
      if (!hit) ts.forEachChild(x, walk);
    };
    walk(node);
    return hit;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) if (!d.binding && !tainted.has(d) && d.nodes.some((x) => carries(x))) (tainted.add(d), (changed = true));
  }
  /**
   * What makes `d` carry the sign, as text (R1169o C4): its own statements and those of every carrying local it reads,
   * at any depth, and each carrying binding by name, sorted. A change to any of them changes this.
   */
  const chain = (d) => {
    const seen = new Set();
    const out = new Set();
    const go = (x) => {
      if (seen.has(x)) return;
      seen.add(x);
      if (x.binding) return void out.add(`import ${x.binding}`);
      for (const t of x.texts) out.add(t);
      const walk = (y) => {
        if (ts.isIdentifier(y) && !(y.parent && ts.isPropertyAccessExpression(y.parent) && y.parent.name === y)) {
          const e = resolve(y);
          if (e && e !== x && (tainted.has(e) || (e.binding && sourceOf(e.binding)))) go(e);
        }
        ts.forEachChild(y, walk);
      };
      for (const n of x.nodes) walk(n);
    };
    go(d);
    return [...out].sort();
  };
  /** Whether the export `name` (`*`: any; `default`) carries the sign; an export this can't find carries it (fail closed). */
  const exportCarries = (name) => {
    const one = (d) => !d || tainted.has(d) || (d.binding && sourceOf(d.binding)) || (!d.binding && d.nodes.some((x) => carries(x)));
    if (name === '*') return [...exported.values()].some((f) => one(f())) || (defaultNode && carries(defaultNode)) || reexportAll.some((m) => source.carries(m, `${m}: *`));
    if (name === 'default') return defaultNode ? carries(defaultNode) : true;
    if (exported.has(name)) return one(exported.get(name)());
    return reexportAll.length ? reexportAll.some((m) => source.carries(m, `${m}: ${name}`)) : true;
  };
  /**
   * A registration's own function (R1169w D1): its last argument when that is a function, or a function this file
   * defines named there (`test(name, body)`); `null` when it has none (options or a name last: a todo); `undefined`
   * when it is some other value this can't read (an import, a parameter, a call), which the static pass refuses.
   */
  const testFn = (n) => {
    const last = n.arguments[n.arguments.length - 1];
    if (!last || n.arguments.length < 2 && (ts.isStringLiteralLike(last) || ts.isTemplateExpression(last))) return null;
    if (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) return last;
    if (ts.isObjectLiteralExpression(last) || ts.isStringLiteralLike(last) || ts.isTemplateExpression(last)) return null;
    if (ts.isIdentifier(last)) {
      const d = resolve(last);
      if (d?.fnNode && !d.reassigned) return d.fnNode;
      if (!d?.reassigned && d?.varDecl?.initializer && ts.isObjectLiteralExpression(d.varDecl.initializer)) return null;
    }
    return undefined;
  };
  return { sf, resolve, tainted, carries, sourceOf, chain, exportCarries, refsOf, fnDecl, callbackSources, testValue, callKind, testFn };
}

/**
 * What each `skip:` or `todo:` option in `text` reads that carries systemd's sign (R1169k, R1169m): a binding from
 * src/, from a file that holds the sign, or from a module it can't name (`<module>: <name>`), or a local name that
 * comes from one, from the sign or from a file read (`<path>: <name>`). `source(module, binding)`: whether a binding
 * from `module` carries it.
 */
export function skipReads(ts, path, text, source) {
  const done = (out, pins, refused) => Object.defineProperties(out, { pins: { value: pins, enumerable: false }, refused: { value: refused, enumerable: false } });
  if (!/\b(?:skip|todo|test|it|describe|suite)\b|node:test/.test(text)) return done([], new Map(), []);
  const { sf, resolve, tainted, sourceOf, chain, refsOf, fnDecl, callbackSources, testValue, callKind, testFn } = fileFlow(ts, path, text, source);
  const out = new Set();
  const pins = new Map();
  const refused = new Set();
  const at = (n) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const snip = (n) => n.getText(sf).replace(/\s+/g, ' ').slice(0, 100);
  const read = (n) => {
    if (ts.isIdentifier(n) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      const d = resolve(n);
      const b = d?.binding;
      if (b && (sourceOf(b) || source.direct?.(b.slice(0, b.lastIndexOf(': ')), b))) out.add(b);
      else if (d && tainted.has(d)) {
        out.add(`${path}: ${n.text}`);
        pins.set(`${path}: ${n.text}`, chain(d));
      }
      // A parameter whose callers can't all be read (R1169v D3): fail closed.
      if (d?.escapes) refused.add(`${at(n)}: a skip, todo or registration's condition reads \`${n.text}\`, a parameter of a function that is exported, used as a value or called with a spread, so not every value it gets can be read: pass the value where this file calls it`);
    }
    ts.forEachChild(n, read);
  };
  // A test's or suite's options (any argument but a text name and its function, R1169p D3: `test(options, fn)` too):
  // their `skip` and `todo`, or the whole argument when it isn't an object literal.
  const options = (o) => {
    if (ts.isIdentifier(o)) return optionsName(o);
    if (!ts.isObjectLiteralExpression(o)) return read(o);
    for (const x of o.properties) {
      if (ts.isPropertyAssignment(x) && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && /^(?:skip|todo)$/.test(x.name.text)) read(x.initializer);
      else if (ts.isShorthandPropertyAssignment(x) && /^(?:skip|todo)$/.test(x.name.text)) read(x.name);
      else if (ts.isSpreadAssignment(x) || (ts.isPropertyAssignment(x) && ts.isComputedPropertyName(x.name))) read(x);
      // A getter or a method for skip or todo, or any computed one (R1169t D7): its body is what the runner reads.
      else if ((ts.isGetAccessorDeclaration(x) || ts.isMethodDeclaration(x)) && (ts.isComputedPropertyName(x.name) || ((ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && /^(?:skip|todo)$/.test(x.name.text)))) read(x);
    }
  };
  const optionsArg = (r) => {
    const c = r.parent;
    return ts.isCallExpression(c) && !!callKind(c) && c.arguments.includes(r) && r !== ownFunction(ts, c);
  };
  // Options (or a name) by name (R1169v D5): a const object literal, whose skip and todo are read; a const text; a
  // parameter or a loop variable, read whole (through what its callers pass, or what it iterates). Each only if
  // nothing can change it before the test is registered: every other read of it is as a test's name or options, or
  // inside the function of a test it is passed to (which runs after its options are read). Anything else
  // (`Object.defineProperty(o, 'skip', ...)`, `o.skip = ...`, a let) could set its skip where this can't read it.
  const loopVar = (v) => !!v && !v.initializer && ts.isVariableDeclarationList(v.parent) && (ts.isForOfStatement(v.parent.parent) || ts.isForInStatement(v.parent.parent));
  const optionsName = (o) => {
    const d = resolve(o);
    // A function this file defines, passed as a test's or suite's function (`describe('x', body)`): not options; when
    // its tests are registered is read through it (conditionsOf).
    if (d?.fnNode && o === o.parent.arguments?.[o.parent.arguments.length - 1]) return;
    if (!d || d.binding) return read(o);
    const v = d.varDecl;
    const init = v?.initializer && (ts.isAsExpression(v.initializer) ? v.initializer.expression : v.initializer);
    const isConst = !!v && !!(v.parent.flags & ts.NodeFlags.Const) && ts.isIdentifier(v.name);
    const refs = refsOf(d);
    const later = refs.filter(optionsArg).map((r) => ownFunction(ts, r.parent)).filter(Boolean);
    const settled = refs.every((r) => optionsArg(r) || later.some((f) => r.pos >= f.pos && r.end <= f.end));
    if (isConst && init && (ts.isStringLiteralLike(init) || ts.isTemplateExpression(init) || ts.isNumericLiteral(init))) return;
    if (settled && isConst && init && ts.isObjectLiteralExpression(init)) {
      // The literal itself holding the sign (as data the allowlist names) carries it, as any local from the sign does.
      if (tainted.has(d) && leafSignIn(ts, sf, init)) {
        out.add(`${path}: ${o.text}`);
        pins.set(`${path}: ${o.text}`, chain(d));
      }
      return options(init);
    }
    if (settled && (d.param || loopVar(v))) return read(o);
    refused.add(`${at(o)}: a test's options (or name) are \`${o.text}\`, which isn't a const object literal, a const text, a parameter or a loop variable read only as a test's name or options, so its skip or todo could be set where this can't read it: write them inline, or as such a const`);
  };
  // Every reference to node:test's test, it, describe, suite, default or the module (R1169v D2, R1169u condition 1)
  // must register: a call, or a call of its .skip, .only or .todo (or another member: a hook, mock), as a statement.
  // Anything else (an alias, an argument, Reflect.apply or .call, an array or object, a computed key, a conditional,
  // a reassignment) could register a test this can't read: refused, so every registration is one it reads.
  const called = (y) => ts.isCallExpression(y.parent) && y.parent.expression === y;
  const allowed = (id, v) => {
    if (called(id)) return true;
    const p = id.parent;
    const nm = p.expression === id ? memberName(ts, p) : null;
    if (nm === null) return false;
    if (/^(?:only|skip|todo)$/.test(nm)) return called(p);
    if (v === 'space' && /^(?:test|it|describe|suite|default)$/.test(nm)) {
      if (called(p)) return true;
      const q = p.parent;
      return q.expression === p && /^(?:only|skip|todo)$/.test(memberName(ts, q) ?? '') && called(q);
    }
    // Another member: on test/describe, only a hook, mock or snapshot (never .call, .apply or .bind, which register
    // a test this can't read); on the module, any export but those above.
    return v === 'space' ? !/^(?:call|apply|bind)$/.test(nm) : /^(?:before|after|beforeEach|afterEach|mock|snapshot)$/.test(nm);
  };
  // node:test loaded where this can't bind it (R1169w D2): re-exported (`export ... from 'node:test'`), or a load of it
  // (or of a module named at run time, which could be it) whose result no declaration binds directly: `.then`,
  // `Promise.resolve(import(...))`, an argument. A 'node:test' string that loads nothing (data, `.includes(...)`) is
  // no registration.
  const refusedLoad = (n) => {
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier) && n.moduleSpecifier.text === 'node:test') return true;
    if (!ts.isCallExpression(n) || !isLoader(n.expression) || !n.arguments.length) return false;
    const a = n.arguments[0];
    if (ts.isStringLiteralLike(a) && a.text !== 'node:test') return false;
    let x = n;
    const through = (y) => ts.isAwaitExpression(y) || ts.isParenthesizedExpression(y) || ts.isAsExpression(y) || ts.isTypeAssertionExpression?.(y) || ts.isNonNullExpression(y) || ts.isSatisfiesExpression?.(y);
    while (x.parent && (through(x.parent) || (ts.isPropertyAccessExpression(x.parent) && x.parent.expression === x && x.parent.name.text === 'default'))) x = x.parent;
    const p = x.parent;
    const bound = (ts.isVariableDeclaration(p) && p.initializer === x) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === x && ts.isIdentifier(p.left));
    // node:test by name must be bound directly; a module named at run time only escapes the binder through a promise's
    // callback or as an argument (`import(x).then(...)`, `f(import(x))`); a member read of it is a call on it.
    if (ts.isStringLiteralLike(a)) return !bound;
    return !bound && ((ts.isPropertyAccessExpression(p) && p.expression === x && /^(?:then|catch|finally)$/.test(p.name.text)) || (ts.isCallExpression(p) && p.arguments.includes(x)));
  };
  const isLoader = (c) => {
    return c.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(c) && /^(?:require|getBuiltinModule)$/.test(c.text)) || (ts.isPropertyAccessExpression(c) && /^(?:getBuiltinModule|require)$/.test(c.name.text)) || (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'createRequire') || (ts.isIdentifier(c) && !!resolve(c)?.varDecl?.initializer && ts.isCallExpression(resolve(c).varDecl.initializer) && ts.isIdentifier(resolve(c).varDecl.initializer.expression) && resolve(c).varDecl.initializer.expression.text === 'createRequire');
  };
  const LOOKUP = /^(?:includes|indexOf|lastIndexOf|startsWith|endsWith|has)$/;
  const lookupOn = (x) => {
    // `x` is a lookup's receiver: `x.includes(...)`, its argument nowhere else.
    const p = x.parent;
    return ts.isPropertyAccessExpression(p) && p.expression === x && LOOKUP.test(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p;
  };
  const onlyLooked = (decl) => {
    const v = decl.parent;
    if (!ts.isVariableDeclaration(v) || v.initializer !== decl || !ts.isIdentifier(v.name) || !(v.parent.flags & ts.NodeFlags.Const)) return false;
    const d = resolve(v.name);
    return !!d && refsOf(d).every(lookupOn);
  };
  const nodeTestPlace = (lit) => {
    let x = lit;
    while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
    const p = x.parent;
    if ((ts.isImportDeclaration(p) && p.moduleSpecifier === x) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return true;
    if (ts.isCallExpression(p) && p.arguments[0] === x && isLoader(p.expression)) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
    if (ts.isCallExpression(p) && p.arguments.includes(x) && ts.isPropertyAccessExpression(p.expression) && LOOKUP.test(p.expression.name.text)) {
      const r = p.expression.expression;
      if (ts.isStringLiteralLike(r) || ts.isArrayLiteralExpression(r)) return true;
      const d = ts.isIdentifier(r) ? resolve(r) : null;
      // A same-file holder or function could be a loader under a lookup's name (`o.includes = getBuiltinModule`); an
      // array of literals, never written, is data.
      const data = d && !d.reassigned && d.holder && ts.isArrayLiteralExpression(d.holder) && d.holder.elements.every((e) => ts.isStringLiteralLike(e) || ts.isNumericLiteral(e));
      return ts.isIdentifier(r) && (!!data || !(d && (d.fnNode || d.holder || d.allFns)));
    }
    if (ts.isArrayLiteralExpression(p)) {
      let a = p;
      while (ts.isParenthesizedExpression(a.parent)) a = a.parent;
      if (lookupOn(a) || onlyLooked(a)) return true;
      const q = a.parent;
      // `new Set([...])` / `new Map([...])`, itself a const read only as a lookup's receiver.
      return ts.isNewExpression(q) && q.arguments?.[0] === a && ts.isIdentifier(q.expression) && /^(?:Set|Map)$/.test(q.expression.text) && !resolve(q.expression) && onlyLooked(q);
    }
    return false;
  };
  const statement = (call) => {
    let x = call;
    while (ts.isAwaitExpression(x.parent) || ts.isParenthesizedExpression(x.parent) || ts.isVoidExpression(x.parent)) x = x.parent;
    return ts.isExpressionStatement(x.parent);
  };
  // What decides whether a registration runs (R1169t D1/D2, R1169v D4, R1169u condition 1): each `if`, `?:`, `&&`/`||`/`??`,
  // switch or catch around it; each loop around it (its condition or iterable); each earlier statement in any block
  // around it (a function's, a label's, the file's) that can return, break, continue or throw under a condition; and,
  // through a function, the same at each place it's called: an IIFE, a callback's call (and its receiver: `xs.forEach`),
  // a same-file function at each call. A subtest's (`t.test`, a test() inside a test) stops at its test's function:
  // an early return or a loop there runs on the VM, where the zero-subtest rule and the run judge it.
  const LOGICAL = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];
  // What can stop what follows without a failure: a return, break or continue, a throw (as before), and (R1169w) a
  // call that ends the process (`process.exit()`, `abort()`, `kill()`) or of a function this file defines that does, at
  // any depth. Inside such a function (`inFn`), only the process ending or such a call: a return there ends it alone. A
  // throw at load fails its file, which isn't silent, unless something catches it (a named limit). A function in it
  // isn't run by it.
  const ends = (y) => ts.isCallExpression(y) && ts.isPropertyAccessExpression(y.expression) && ts.isIdentifier(y.expression.expression) && y.expression.expression.text === 'process' && /^(?:exit|abort|kill|reallyExit)$/.test(y.expression.name.text);
  const endsFns = new Map();
  const ender = (g, seen = new Set()) => {
    if (endsFns.has(g)) return endsFns.get(g);
    if (seen.has(g)) return false;
    seen.add(g);
    let hit = false;
    const w = (y) => {
      if (hit || (y !== g && ts.isFunctionLike(y))) return;
      if (ends(y)) hit = true;
      else if (ts.isCallExpression(y) && ts.isIdentifier(y.expression)) {
        const h = resolve(y.expression)?.fnNode;
        if (h && ender(h, seen)) hit = true;
      }
      if (!hit) ts.forEachChild(y, w);
    };
    if (g.body) w(g.body);
    endsFns.set(g, hit);
    return hit;
  };
  const exits = (s, inFn = false) => {
    let hit = false;
    const w = (y) => {
      if (hit || (y !== s && ts.isFunctionLike(y))) return;
      if (ends(y) || (!inFn && (ts.isReturnStatement(y) || ts.isThrowStatement(y) || ts.isBreakStatement(y) || ts.isContinueStatement(y)))) hit = true;
      else if (ts.isCallExpression(y) && ts.isIdentifier(y.expression) && resolve(y.expression)?.fnNode && ender(resolve(y.expression).fnNode)) hit = true;
      else ts.forEachChild(y, w);
    };
    w(s);
    return hit;
  };
  const exitConds = (s, acc, inFn = false, seen = new Set()) => {
    const w = (y) => {
      if (ts.isFunctionLike(y)) return;
      if (ts.isIfStatement(y) && (exits(y.thenStatement, inFn) || (y.elseStatement && exits(y.elseStatement, inFn)))) acc.push(y.expression);
      else if ((ts.isForOfStatement(y) || ts.isForInStatement(y)) && !staticTable(y.expression) && exits(y.statement, inFn)) acc.push(y.expression);
      else if ((ts.isWhileStatement(y) || ts.isDoStatement(y)) && exits(y.statement, inFn)) acc.push(y.expression);
      else if (ts.isForStatement(y) && exits(y.statement, inFn)) acc.push(...[y.initializer, y.condition, y.incrementor].filter(Boolean));
      else if (ts.isSwitchStatement(y) && y.caseBlock.clauses.some((c) => c.statements.some((x) => exits(x, inFn)))) acc.push(y.expression, ...y.caseBlock.clauses.filter(ts.isCaseClause).map((c) => c.expression));
      else if (ts.isExpressionStatement(y)) {
        // A statement that is a condition (`c && process.exit()`, `c ? bail() : 0`); not a value a declaration computes.
        let e = y.expression;
        while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isVoidExpression(e)) e = e.expression;
        if (ts.isConditionalExpression(e) && (exits(e.whenTrue, inFn) || exits(e.whenFalse, inFn))) acc.push(e.condition);
        else if (ts.isBinaryExpression(e) && LOGICAL.includes(e.operatorToken.kind) && exits(e.right, inFn)) acc.push(e.left);
      }
      // A function this file defines, called here: what in it can end its caller.
      if (ts.isCallExpression(y) && ts.isIdentifier(y.expression)) {
        const g = resolve(y.expression)?.fnNode;
        if (g?.body && !seen.has(g) && ender(g)) {
          seen.add(g);
          exitConds(g.body, acc, true, seen);
        }
      }
      ts.forEachChild(y, w);
    };
    w(s);
  };
  const insideTest = (call) => {
    for (let p = call.parent; p; p = p.parent) {
      if (!ts.isFunctionLike(p)) continue;
      let fx = p;
      while (fx.parent && ts.isParenthesizedExpression(fx.parent)) fx = fx.parent;
      const c = fx.parent;
      if (c && ts.isCallExpression(c) && c.arguments.includes(fx) && ['test', 'sub'].includes(callKind(c))) return true;
    }
    return false;
  };
  // A loop over a fixed table registers a fixed number of tests: a const array or object literal with no spread (or
  // Object.entries/keys/values of one). What its rows carry reaches each test's options and conditions, read there.
  const staticTable = (e) => {
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    if (e && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'Object' && /^(?:entries|keys|values)$/.test(e.expression.name.text) && e.arguments.length === 1) e = e.arguments[0];
    if (e && ts.isIdentifier(e)) {
      const v = resolve(e)?.varDecl;
      e = v && v.parent.flags & ts.NodeFlags.Const && ts.isIdentifier(v.name) ? v.initializer : null;
      while (e && (ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isParenthesizedExpression(e))) e = e.expression;
    }
    return !!e && ((ts.isArrayLiteralExpression(e) && !e.elements.some(ts.isSpreadElement)) || (ts.isObjectLiteralExpression(e) && !e.properties.some(ts.isSpreadAssignment)));
  };
  const conditionsOf = (call, full, acc = [], seen = new Set()) => {
    let x = call;
    for (;;) {
      const p = x.parent;
      if (!p) break;
      if (ts.isIfStatement(p) && x !== p.expression) acc.push(p.expression);
      else if (ts.isConditionalExpression(p) && x !== p.condition) acc.push(p.condition);
      else if (ts.isBinaryExpression(p) && LOGICAL.includes(p.operatorToken.kind) && x === p.right) acc.push(p.left);
      else if (ts.isCaseClause(p) || ts.isDefaultClause(p)) acc.push(p.parent.parent.expression, ...p.parent.clauses.filter(ts.isCaseClause).map((c) => c.expression));
      else if (ts.isCatchClause(p)) acc.push(p.parent.tryBlock);
      else if (full && ts.isForStatement(p) && x === p.statement) acc.push(...[p.initializer, p.condition, p.incrementor].filter(Boolean));
      else if (full && (ts.isForOfStatement(p) || ts.isForInStatement(p)) && x === p.statement && !staticTable(p.expression)) acc.push(p.expression);
      else if (full && (ts.isWhileStatement(p) || ts.isDoStatement(p)) && x === p.statement) acc.push(p.expression);
      if (full && (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isModuleBlock(p))) {
        for (const st of p.statements) {
          if (st === x) break;
          exitConds(st, acc);
        }
      }
      if (ts.isFunctionLike(p)) {
        if (!full) break;
        let fx = p;
        while (fx.parent && ts.isParenthesizedExpression(fx.parent)) fx = fx.parent;
        const up = fx.parent;
        if (up && ts.isCallExpression(up) && up.expression === fx) {
          x = up;
          continue;
        }
        if (up && ts.isCallExpression(up) && up.arguments.includes(fx)) {
          if (!callKind(up)) acc.push(...callbackSources(up, fx));
          x = up;
          continue;
        }
        const d = fnDecl(p);
        // A method, a constructor, an accessor or a function stored as a property (R1169w D3): its callers can't be
        // followed by name, so it isn't read: refused, failing closed.
        if (!d) refused.add(`${at(call)}: \`${snip(call)}\` registers a test inside a method, a constructor or a function kept as a property, whose callers this can't follow: register it from a function this file declares, or at the top level`);
        if (d && !seen.has(d)) {
          seen.add(d);
          for (const r of refsOf(d)) {
            const rp = r.parent;
            if (ts.isExportSpecifier(rp)) continue;
            if (ts.isCallExpression(rp) && rp.expression === r) conditionsOf(rp, full, acc, seen);
            else if (ts.isCallExpression(rp) && rp.arguments.includes(r)) {
              if (!callKind(rp)) acc.push(...callbackSources(rp, r));
              conditionsOf(rp, full, acc, seen);
            } else refused.add(`${at(r)}: \`${snip(rp)}\` uses ${d.name}, a function that registers tests, as a value: call it (or pass it as a callback), so this can read when its tests are registered`);
          }
        }
        break;
      }
      x = p;
    }
    return acc;
  };
  const visit = (n) => {
    if (ts.isIdentifier(n) && isRef(ts, n)) {
      const v = testValue(n);
      if ((v === 'test' || v === 'suite' || v === 'space') && !allowed(n, v)) refused.add(`${at(n)}: \`${snip(n.parent)}\` uses node:test's ${n.text} as a value: register a test only by calling it (\`${n.text}(...)\`, \`${n.text}.skip(...)\`), so this can read each one`);
    }
    // node:test named where this can't bind it (R1169w D2): a 'node:test' string that isn't a static import's, or a
    // require(), import() or getBuiltinModule() whose result a declaration binds directly (`.then`, a re-export,
    // `module.require`, anything later): refused, failing closed.
    // Where 'node:test' may appear at all (R1169z D2, an allowlist, not a list of callers): a static import's or a type's
    // specifier; a loader's first argument (its binding read just below, as its call); a lookup's argument
    // (`.includes`, `.has`, ...) on a receiver that isn't a same-file holder or function; an element of an array that is
    // such a lookup's receiver, or a const (or a `new Set`/`new Map` of one) read only as one; or an equality's operand.
    // Anywhere else (a tagged template, `new`, an array or object handed to a call, `Reflect.apply`) stops the job.
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'node:test' && !nodeTestPlace(n)) refused.add(`${at(n)}: \`${snip(n.parent)}\` has 'node:test' where this can't read what it does: load node:test only by an import, or a declaration of require(), import() or getBuiltinModule() by name`);
    if (refusedLoad(n)) refused.add(`${at(n)}: \`${snip(n.parent)}\` names node:test where this can't bind it: import it (\`import { test } from 'node:test'\`, or a declaration of require(), import() or getBuiltinModule()), so each registration is read`);
    const kind = callKind(n);
    if (kind) {
      if (testFn(n) === undefined) refused.add(`${at(n)}: \`${snip(n)}\` registers a test whose function isn't one this file defines (an import, a parameter, a call's result), so what it runs can't be read: pass the function inline, or one this file declares`);
      if (kind !== 'sub' && !statement(n)) refused.add(`${at(n)}: \`${snip(n)}\` registers a test inside an expression: register it as a statement of its own, so this can read what decides it`);
      const sub = kind === 'sub' || insideTest(n);
      const conds = conditionsOf(n, !sub);
      for (const c of conds) {
        read(c);
        if (sub && leafSignIn(ts, sf, c)) refused.add(`${at(n)}: a subtest is registered only when \`${snip(c)}\`, which holds systemd's sign: register it always, and let the run on the VM judge it`);
      }
      if (n.arguments.length >= 2) {
        const fn = ownFunction(ts, n);
        n.arguments.forEach((a, k) => {
          if (a !== fn && !(k === 0 && (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a)))) options(a);
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // Each local's pin (chain): what the allowlist must name it by.
  return done([...out], pins, [...refused]);
}

/** Every build-root file's sign uses, and what makes a binding carry the sign (src/, a holder, `?`, not a named import). */
export function signSource(ts, texts, allow, known = null) {
  const okImports = allow.skipImports ?? {};
  const uses = known ?? new Map([...texts].map(([p, t]) => [p, signUseList(ts, p, t)]));
  const holders = new Set([...uses].filter(([, u]) => u.length).map(([p]) => p));
  // A binding carries the sign, for a local derived from it, when its module holds the sign or can't be named; a skip
  // that reads a binding directly is refused for any src/ module too (product code is never a test's gate).
  const base = { uses, holders, paths: new Set(texts.keys()), carries: (m, b) => !(b in okImports) && (m === '?' || holders.has(m)), direct: (m, b) => !(b in okImports) && m.startsWith('src/') };
  // For picking the VM's tests (signTests, R1169p D2), by name: an import carries the sign when the export it names
  // reads it in its own module (its own sign, its own locals from it; a module named at run time carries). One module
  // deep: what that module itself imports isn't followed (else nearly every test is picked: product code reaches the
  // service layer everywhere). File reads aren't a source here either, or every test that reads a fixture would be.
  const memo = new Map();
  const own = { paths: base.paths, fileReads: false, carries: (m) => m === '?' };
  const select = {
    ...base,
    fileReads: false,
    carries: (m, b) => {
      if (b in okImports) return false;
      if (m === '?') return true;
      const t = texts.get(m);
      if (t === undefined || !holders.has(m)) return false;
      if (!memo.has(m)) memo.set(m, fileFlow(ts, m, t, own));
      return !!memo.get(m).exportCarries(b.slice(b.lastIndexOf(': ') + 2));
    },
  };
  return { ...base, select };
}

/**
 * The sign rule over every file the build compiles (R1169k, R1169m, R1169n), as problems ([] when it holds). `texts`:
 * path to text. `allow` (systemd-acceptance-allow.json): `uses`, the files where the sign is data no skip reads, each
 * with why and each use's exact text (`token: <the line, trimmed>`, so a use moved or swapped is a change); and
 * `skipImports`, the `<module>: <name>` bindings (or `<file>: <local>` names) a skip may read though they come from
 * src/, from such a file or from what can't be read, each with why. Any other use, a use whose text changed, a skip
 * reading such a binding unnamed, or an entry with nothing left to name, is a problem.
 */
export function signProblems(ts, texts, allow = {}) {
  const pinned = allow.uses ?? {};
  const okImports = allow.skipImports ?? {};
  const source = signSource(ts, texts, allow);
  const out = [];
  const where = 'scripts/ci/systemd-acceptance-allow.json';
  for (const [p, u] of source.uses) {
    const want = [...(pinned[p]?.uses ?? [])];
    const extra = [];
    for (const x of u) {
      const k = want.indexOf(x.pin);
      if (k >= 0) want.splice(k, 1);
      else extra.push(x);
    }
    if (extra.length) out.push(`${p}: ${extra.length} use(s) of systemd's sign outside a systemCi declaration, a gate's reason, a test's name or a test's own function, not named in ${where} (${extra.slice(0, 4).map((x) => `${x.at} \`${x.pin.slice(x.pin.indexOf(': ') + 2).slice(0, 80)}\``).join('; ')}${extra.length > 4 ? '; ...' : ''}): gate a test that needs systemd on systemCi, as \`test(<name>, { skip: !systemCi ...\`; data no skip reads goes in the allowlist by its exact text, with why (--signs prints it)`);
    if (want.length) out.push(`${p}: ${want.length} use(s) ${where} names aren't there any more (${want.slice(0, 3).map((x) => `\`${x.slice(0, 80)}\``).join('; ')}): take them out of the allowlist`);
  }
  for (const p of Object.keys(pinned)) if (!texts.has(p)) out.push(`${p}: named in ${where}, but the build has no such file`);
  const read = new Set();
  for (const [p, t] of texts) {
    const reads = skipReads(ts, p, t, source);
    // What can't be read at all (R1169v): never allowlisted, since nothing names what it would excuse.
    out.push(...reads.refused);
    for (const b of reads) {
      read.add(b);
      // A local is named by what makes it carry the sign (R1169o C4): its pin must be that text, all of it.
      const pin = reads.pins.get(b);
      if (pin && b in okImports) {
        const want = okImports[b]?.pin;
        if (JSON.stringify(want) !== JSON.stringify(pin)) out.push(`${p}: a skip reads ${b}, named in the allowlist's skipImports, but what makes it carry systemd's sign isn't its pin there (now: ${JSON.stringify(pin).slice(0, 400)}): check it reads no service manager, and pin it again`);
      }
      if (!(b in okImports)) out.push(`${p}: a skip reads ${b}, which carries systemd's sign (${b.startsWith(`${p}: `) ? 'a local from the sign, an import that carries it, or a file read' : b.startsWith('?: ') ? 'from a module named at run time' : b.startsWith('src/') ? 'from src/' : "from a file that holds systemd's sign"}): gate a test that needs systemd on systemCi; another check goes in the allowlist's skipImports with why`);
    }
  }
  // An entry is still needed only while a skip reads it, or (for an import) while it would carry the sign without it.
  const raw = signSource(ts, texts, {}, source.uses);
  const rawReads = new Set([...texts].flatMap(([p, t]) => skipReads(ts, p, t, raw)));
  for (const b of Object.keys(okImports)) if (!rawReads.has(b)) out.push(`${b}: named in the allowlist's skipImports, but no skip reads it`);
  // A runtime excuse is pinned by its test's whole text (the owner's option (b), R1169z): a test edited after it was
  // excused isn't excused any more until someone reads it again and re-pins it.
  for (const [key, entry] of Object.entries(allow.runtime ?? {})) {
    const file = key.slice(0, key.indexOf(': '));
    const text = texts.get(file);
    const items = text === undefined ? [] : signTests(ts, file, text, source.select, true, { text: true }).filter((t) => `${file}: ${t.name ?? t.label}` === key);
    const item = items[0];
    // One excuse covers one test (R1169aa D1, R1169ab D3): a namesake placed after it would otherwise skip under it.
    if (items.length > 1) out.push(`${key}: named in the allowlist's runtime, but ${items.length} tests have that name (at ${items.map((t) => `${t.line}:${t.column}`).join(', ')}): give the excused one its own name`);
    else if (!item) out.push(`${key}: named in the allowlist's runtime, but no such test is in the build`);
    else if (entry?.pin !== item.text) out.push(`${key}: the allowlist's runtime excuses it, but its pin isn't the test's text (now: ${JSON.stringify(item.text).slice(0, 300)}): read the test again, and pin it again`);
  }
  return out;
}

/**
 * The tests in `text` (a built test file, read as `path`, its source's path) the acceptance job runs on the VM besides
 * the gates (R1169n, the owner's decision; R1169p D2): each test() or it() call, not inside another test's function,
 * whose own function holds systemd's sign or reads a name that carries it (a local from the sign, from an import
 * that carries it or from a file read, or such an import itself: the static pass's own data, fileFlow). With `all`,
 * every such call, carrying or not (a gate's own, for its subtests). Each as { name (a text name, else null), line,
 * column (of its call, as node reports a test's place), label, subtests (its function starts subtests, `x.test(`) }.
 * `source` as for skipReads.
 */
export function signTests(ts, path, text, source, all = false, o = {}) {
  if (!all && !maySign(text) && !/\b(?:import|require)\b/.test(text)) return [];
  const { sf, resolve, tainted, sourceOf, callKind, refsOf, testValue, testFn } = fileFlow(ts, path, text, source);
  const isTestCall = (_, n) => callKind(n) === 'test';
  const isSuiteCall = (_, n) => callKind(n) === 'suite';
  const carriesHere = (node) => {
    let hit = false;
    const walk = (x) => {
      if (hit) return;
      if (leafSign(ts, sf, x)) hit = true;
      else if (ts.isIdentifier(x) && !(x.parent && ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)) {
        const d = resolve(x);
        if (d && (tainted.has(d) || (d.binding && sourceOf(d.binding)))) hit = true;
      }
      if (!hit) ts.forEachChild(x, walk);
    };
    walk(node);
    return hit;
  };
  // Whether a test's function starts subtests: any read of `test` on its own context parameter, or a nested
  // subtest's (`t.test(`, `t['test'](`, `t.test.bind(t)`), never another object's `.test` (`/re/.test(s)`, R1169q C1;
  // R1169r D5).
  // Same-file functions by name, for a context handed to a helper (R1169t D4).
  const localFns = new Map();
  const collectFns = (x) => {
    if (ts.isFunctionDeclaration(x) && x.name && x.body) localFns.set(x.name.text, x);
    else if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.initializer && (ts.isArrowFunction(x.initializer) || ts.isFunctionExpression(x.initializer))) localFns.set(x.name.text, x.initializer);
    ts.forEachChild(x, collectFns);
  };
  collectFns(sf);
  const startsSubtests = (fn, ctxIndex = 0, seen = new Set()) => {
    if (seen.has(fn)) return false;
    seen.add(fn);
    const ctx = new Set();
    const paramAt = (f, k) => f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f) || ts.isFunctionDeclaration(f)) && f.parameters[k] && ts.isIdentifier(f.parameters[k].name) ? f.parameters[k].name.text : null;
    const param = (f) => paramAt(f, 0);
    if (paramAt(fn, ctxIndex)) ctx.add(paramAt(fn, ctxIndex));
    // `test` taken out of the context by destructuring: `({ test: sub }) =>` or `const { test } = t` (R1169t T2c).
    const takesTest = (b) => b && ts.isObjectBindingPattern(b) && b.elements.some((e) => { const k = e.propertyName ?? e.name; return !k || !(ts.isIdentifier(k) || ts.isStringLiteralLike(k)) || k.text === 'test'; });
    const f0 = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) ? fn.parameters[ctxIndex] : null;
    if (f0 && takesTest(f0.name)) return true;
    let hit = false;
    const readsTest = (x) => {
      const base = ts.isPropertyAccessExpression(x) ? (x.name.text === 'test' ? x.expression : null) : ts.isElementAccessExpression(x) && ts.isStringLiteralLike(x.argumentExpression) && x.argumentExpression.text === 'test' ? x.expression : null;
      return base && ts.isIdentifier(base) && ctx.has(base.text);
    };
    const walk = (x) => {
      if (hit) return;
      // A bare test()/it() inside a running test is a subtest of it (node's runner nests it).
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && /^(?:test|it)$/.test(x.expression.text)) hit = true;
      // The context under another name: `const ctx = t`.
      if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.initializer && ts.isIdentifier(x.initializer) && ctx.has(x.initializer.text)) ctx.add(x.name.text);
      if (ts.isVariableDeclaration(x) && x.initializer && ts.isIdentifier(x.initializer) && ctx.has(x.initializer.text) && takesTest(x.name)) hit = true;
      // The context handed to a same-file helper that reads `test` on it.
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && localFns.has(x.expression.text)) {
        x.arguments.forEach((a, k) => {
          if (!hit && ts.isIdentifier(a) && ctx.has(a.text) && startsSubtests(localFns.get(x.expression.text), k, seen)) hit = true;
        });
      }
      if (readsTest(x)) {
        hit = true;
        const call = x.parent && ts.isCallExpression(x.parent) && x.parent.expression === x ? x.parent : null;
        const sub = call ? param(call.arguments[call.arguments.length - 1]) : null;
        if (sub) ctx.add(sub);
      }
      if (!hit) ts.forEachChild(x, walk);
    };
    walk(fn.body ?? fn);
    return hit;
  };
  // A skip, a todo or an early return one name away from the sign (R1169p D2): an `if` whose condition reads what
  // carries it and whose branch returns, skips or marks a todo; or `cond && t.skip()`, `cond ? t.skip() : ...`.
  const stops = (node) => {
    let hit = false;
    const walk = (x) => {
      if (hit || (x !== node && ts.isFunctionLike(x))) return;
      if (ts.isReturnStatement(x)) hit = true;
      else if (ts.isCallExpression(x) && ((ts.isPropertyAccessExpression(x.expression) && /^(?:skip|todo)$/.test(x.expression.name.text)) || (ts.isElementAccessExpression(x.expression) && ts.isStringLiteralLike(x.expression.argumentExpression) && /^(?:skip|todo)$/.test(x.expression.argumentExpression.text)))) hit = true;
      else ts.forEachChild(x, walk);
    };
    walk(node);
    return hit;
  };
  const guarded = (fn) => {
    let hit = false;
    const walk = (x) => {
      if (hit) return;
      if (ts.isIfStatement(x) && carriesHere(x.expression) && (stops(x.thenStatement) || (x.elseStatement && stops(x.elseStatement)))) hit = true;
      else if (ts.isConditionalExpression(x) && carriesHere(x.condition) && (stops(x.whenTrue) || stops(x.whenFalse))) hit = true;
      else if (ts.isBinaryExpression(x) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(x.operatorToken.kind) && carriesHere(x.left) && stops(x.right)) hit = true;
      else ts.forEachChild(x, walk);
    };
    walk(fn);
    return hit;
  };
  const holdsSign = (node) => {
    let hit = false;
    const walk = (x) => {
      if (hit) return;
      if (leafSign(ts, sf, x)) hit = true;
      else ts.forEachChild(x, walk);
    };
    walk(node);
    return hit;
  };
  // R1169v D1, fail closed: a test is picked when the code that runs for it reads what carries the sign and mentions
  // skip or todo in any form (a property, a key, a string, `.bind`): its own function with every function in it, every
  // same-file function that code names (a helper it calls or hands its context to), at any depth, and the hooks
  // (before, beforeEach, after, afterEach) of each block around it. A stop through a helper, a bound or computed
  // t.skip, a loop, a label or a hook is then judged on the VM, as a stop in its own function is.
  const reach = (start) => {
    const seen = new Set(start);
    const stack = [...start];
    while (stack.length) {
      const f = stack.pop();
      const w = (y) => {
        if (ts.isIdentifier(y) && isRef(ts, y)) {
          // A same-file function, or (R1169w D1) a same-file object or class it names: all its methods with it.
          const d = resolve(y);
          for (const g of d?.reassigned ? d.allFns : [d?.fnNode ?? d?.holder]) if (g && !seen.has(g)) (seen.add(g), stack.push(g));
        }
        ts.forEachChild(y, w);
      };
      w(f);
    }
    return [...seen];
  };
  const HOOK = /^(?:before|after|beforeEach|afterEach)$/;
  const hooksAround = (call) => {
    const fns = [];
    for (let p = call.parent; p; p = p.parent) {
      if (!(ts.isBlock(p) || ts.isSourceFile(p))) continue;
      for (const st of p.statements) {
        let e = ts.isExpressionStatement(st) ? st.expression : null;
        while (e && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
        if (!e || !ts.isCallExpression(e)) continue;
        const c = e.expression;
        const nm = ts.isIdentifier(c) ? c.text : memberName(ts, c);
        const bound = ts.isIdentifier(c) && testValue(c) === 'other' && HOOK.test((resolve(c)?.binding ?? '').split(': ').pop());
        if (bound || (nm && HOOK.test(nm))) for (const a of e.arguments) if (ts.isFunctionLike(a)) fns.push(a); else if (ts.isIdentifier(a) && resolve(a)?.fnNode) fns.push(resolve(a).fnNode);
      }
    }
    return fns;
  };
  const mentions = (node) => {
    let hit = false;
    const walk = (x) => {
      if (hit) return;
      if ((ts.isIdentifier(x) || ts.isPrivateIdentifier(x) || ts.isStringLiteralLike(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x)) && /skip|todo/i.test(x.text)) hit = true;
      else ts.forEachChild(x, walk);
    };
    walk(node);
    return hit;
  };
  // R1169w D4: and a test that starts subtests in code reading what carries the sign: whether (or how many) they run
  // may turn on it (a loop, an early return), which the zero-subtest rule and the run judge here.
  const coarse = (call, fn) => {
    const code = reach([fn, ...hooksAround(call)]);
    return code.some(carriesHere) && (code.some(mentions) || startsSubtests(fn));
  };
  const flat = (x) => x.getText(sf).replace(/\s+/g, ' ').trim();
  const pinText = (x) => x.getText(sf).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const stmt = (x) => {
    let y = x;
    while (y.parent && !ts.isSourceFile(y.parent) && !ts.isBlock(y.parent) && !ts.isCaseClause(y.parent)) y = y.parent;
    return y;
  };
  const declOf = (id) => {
    const d = resolve(id);
    const v = d?.varDecl ?? (d?.fnNode && ts.isFunctionDeclaration(d.fnNode) ? d.fnNode : null);
    return v ? { text: flat(stmt(v)), top: ts.isSourceFile(stmt(v).parent) } : null;
  };
  const stopsOf = (call, fn) => {
    const mentions = [];
    for (const code of reach([fn, ...hooksAround(call)])) {
      const walk = (x) => {
        if ((ts.isIdentifier(x) || ts.isPrivateIdentifier(x) || ts.isStringLiteralLike(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x)) && /skip|todo/i.test(x.text)) mentions.push({ text: x.text, statement: flat(stmt(x)), decl: ts.isIdentifier(x) && isRef(ts, x) ? declOf(x) : null });
        ts.forEachChild(x, walk);
      };
      walk(code);
    }
    const opts = call.arguments.length === 3 ? call.arguments[1] : null;
    const short = opts && ts.isObjectLiteralExpression(opts) ? opts.properties.find((p) => ts.isShorthandPropertyAssignment(p) && p.name.text === 'skip') : null;
    return { stops: mentions, skipDecl: short ? declOf(short.name) : null };
  };
  const out = [];
  // A test whose name holds the sign, or any test under a suite whose name does: its function can read the name back
  // (`t.name`, `s.name`, R1169r D1).
  const visit = (n, signSuite = false) => {
    if (isSuiteCall(ts, n)) {
      const name = nameArg(ts, n);
      const signed = signSuite || !!(name && holdsSign(name));
      return ts.forEachChild(n, (x) => visit(x, signed));
    }
    if (isTestCall(ts, n)) {
      // Its own function, inline or a function this file declares, named there (R1169w D1).
      const fn = testFn(n) || null;
      const name = nameArg(ts, n);
      if (fn && (all || holdsSign(fn) || guarded(fn) || signSuite || (name && holdsSign(name)) || coarse(n, fn))) {
        const { line, character } = sf.getLineAndCharacterOfPosition(n.expression.getStart(sf));
        const a = nameArg(ts, n);
        const item = { name: a && ts.isStringLiteralLike(a) ? a.text : null, line: line + 1, column: character + 1, label: (a ?? n.arguments[0])?.getText(sf).slice(0, 120) ?? '', subtests: startsSubtests(fn) };
        // `o.stops` (R1169y D3, for the runtime check): every mention of skip or todo in the code the test runs, as
        // picking reads it (its function, the same-file functions it names, the hooks around it), each with its
        // statement and, for a name, its declaration; and its options' `skip`, with where that is declared.
        if (o.stops) Object.assign(item, stopsOf(n, fn));
        // `o.text`: the whole call's text, each line trimmed and empty lines dropped, the line breaks kept (R1169ab
        // D4: a line break is syntax, as a `//` comment's end and ASI after `return`): what a runtime excuse is pinned by.
        if (o.text) item.text = pinText(n);
        out.push(item);
      }
      return;
    }
    ts.forEachChild(n, (x) => visit(x, signSuite));
  };
  visit(sf);
  return out;
}

/** Code that can register a test under a location it makes up (R1169h: `vm.runInThisContext` with a filename). */
const FORGES = /\bfrom\s+['"](?:node:)?vm['"]|\brequire\s*\(\s*['"](?:node:)?vm['"]\s*\)|\bnew\s+Function\b|(?<![\w$.])eval\s*\(/;

/**
 * Every gated test under `dir` (test/), at any depth, by its path from `dir` ('/'-separated). Throws when a mention
 * of systemCi isn't a gate in a test() call this can read, when a skip that looks like a systemd gate isn't one, or
 * when any of that is in a file under test/ that isn't a `*.test.ts` (a helper module that registers tests, R1169d):
 * the run is by file, so a gated test must be in one. systemd's sign under another name is signProblems' (R1169k).
 */
export function findAll(dir, prefix = 'test/') {
  const found = [];
  const files = readdirSync(dir, { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).sort();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const names = systemdTests(text);
    const mentions = mentionCount(text);
    const like = gateLikeCount(text);
    if (!f.endsWith('.test.ts')) {
      if (names.length || mentions || like) throw new Error(`${prefix}${f}: a systemd gate outside a *.test.ts file (a helper that registers tests): write the gated test in the test file itself, as \`test(<name>, { skip: !systemCi ...\``);
      continue;
    }
    if (names.length !== mentions) throw new Error(`${prefix}${f}: ${mentions} use(s) of systemCi, ${names.length} a gate in a test() call this reads (write it as \`test(<name>, { skip: !systemCi ...\`)`);
    if (like !== names.length) throw new Error(`${prefix}${f}: ${like} skip(s) that look like a systemd gate, ${names.length} a gate this reads (the flag must be named systemCi: \`test(<name>, { skip: !systemCi ...\`)`);
    const member = gatesOf(text).filter((g) => g.member);
    if (member.length) throw new Error(`${prefix}${f}: a gate on a subtest (\`t.test(\`: ${JSON.stringify(member[0].name)}); gate a top-level test(), which the run selects by name`);
    const gates = gatesOf(text);
    const notFirst = gates.find((g) => !g.first && !g.member);
    if (notFirst) throw new Error(`${prefix}${f}: the gate ${JSON.stringify(notFirst.name)} isn't its line's first statement (line ${notFirst.line}): put it on a line of its own, so no other call shares its place`);
    const computed = gates.find((g) => g.computed);
    if (computed) throw new Error(`${prefix}${f}: the gate ${JSON.stringify(computed.name)} has a computed (template) name: name it with a literal`);
    if (gates.length && FORGES.test(text)) throw new Error(`${prefix}${f}: a gated file that uses node:vm, new Function or eval, which can register a test under a place it makes up`);
    if (names.length) found.push({ file: f, names });
  }
  return found;
}

/** The test() call in `sf` whose `test` token is at `line`:`column` (1-based, as node reports a test's place). */
function callAt(ts, sf, line, column) {
  let hit = null;
  const visit = (n) => {
    if (hit) return;
    if (ts.isCallExpression(n)) {
      const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      if (p.line + 1 === line && p.character + 1 === column) {
        hit = n;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hit;
}

/**
 * Each gate in `text` (a built test file, `path` its source) that doesn't open with node's own count of what it checks
 * (R1169ab D2, the owner's decision of 2026-11-10): its function's first statement must be `<t>.plan(<n>)`, `<t>` its
 * first parameter and `<n>` a whole-number literal of 1 or more, alone. Node then fails the gate, on the VM, when it
 * made fewer (or more) `t.assert` calls and subtests than that: an early return, or a subtest started only sometimes,
 * can't pass there having checked less. `gates` as gatesOf gives them.
 */
export function planProblems(ts, path, text, gates) {
  const sf = parsed(ts, path, text);
  return gates.flatMap((g) => {
    const at = `${path}: ${g.name}`;
    const call = callAt(ts, sf, g.line, g.column);
    const fn = call?.arguments.at(-1);
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return [`${at}: its function isn't inline, so its count can't be read`];
    const p = fn.parameters[0]?.name;
    const first = fn.body && ts.isBlock(fn.body) ? fn.body.statements[0] : null;
    const c = first && ts.isExpressionStatement(first) ? first.expression : null;
    const ok =
      p && ts.isIdentifier(p) && c && ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && ts.isIdentifier(c.expression.expression) &&
      c.expression.expression.text === p.text && c.expression.name.text === 'plan' && c.arguments.length === 1 && ts.isNumericLiteral(c.arguments[0]) &&
      /^[1-9]\d*$/.test(c.arguments[0].text);
    if (!ok) return [`${at}: its first statement isn't \`t.plan(<n>)\` (its context's own count, a literal of 1 or more, alone): node then fails it when it checks less, as an early return does`];
    const out = [];
    // A try whose catch swallows a failed check counts the check and passes (R1169ad D6): no t.assert in a try with a
    // catch, in the gate or any function in it.
    const assertsIn = (n) => {
      let hit = false;
      const v = (x) => {
        if (hit) return;
        if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ts.isPropertyAccessExpression(x.expression.expression) && x.expression.expression.name.text === 'assert') hit = true;
        else ts.forEachChild(x, v);
      };
      v(n);
      return hit;
    };
    const tries = (n) => {
      if (ts.isTryStatement(n) && n.catchClause && assertsIn(n.tryBlock)) out.push(`${at}: a t.assert inside a try with a catch (line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}): a catch that swallows its failure passes the gate; check outside the try`);
      ts.forEachChild(n, tries);
    };
    tries(fn.body);
    // Each subtest opens with its own count (R1169ad D2): the gate's count sees a subtest start, not what it checked.
    const plans = (f) => {
      for (const c of subtestCalls(ts, f)) {
        const sub = functionOf(ts, sf, c.arguments.at(-1));
        const where = sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1;
        const q = sub?.parameters[0]?.name;
        const s0 = sub?.body && ts.isBlock(sub.body) ? sub.body.statements[0] : null;
        const e0 = s0 && ts.isExpressionStatement(s0) ? s0.expression : null;
        const planned = q && ts.isIdentifier(q) && e0 && ts.isCallExpression(e0) && ts.isPropertyAccessExpression(e0.expression) && ts.isIdentifier(e0.expression.expression) && e0.expression.expression.text === q.text && e0.expression.name.text === 'plan' && e0.arguments.length === 1 && ts.isNumericLiteral(e0.arguments[0]) && /^[1-9]\d*$/.test(e0.arguments[0].text);
        if (!planned) out.push(`${at}: the subtest at line ${where} doesn't open with its own \`t.plan(<n>)\` (an inline or same-file function): the gate's count sees it start, not what it checked`);
        else plans(sub);
      }
    };
    plans(fn);
    return out;
  });
}

/**
 * A test's or a subtest's function, from its registration's last argument (R1169ac D1): inline, or a function this
 * file declares by that name (`function body(t) {}`, `const body = (t) => {}`). null when it is neither: a function
 * from another module, or a value made at run time, isn't readable here.
 */
function functionOf(ts, sf, arg) {
  if (!arg) return null;
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg;
  if (!ts.isIdentifier(arg)) return null;
  // Every declaration of the name in the file, at any depth (R1169ae D1): more than one, and which is meant can't be
  // read without the scope, so none is taken.
  const hits = [];
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === arg.text) hits.push(n.body ? n : null);
    else if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name) && n.name.text === arg.text) hits.push(n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) ? n.initializer : null);
    else if ((ts.isClassDeclaration(n) || ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === arg.text) hits.push(null);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The calls in `fn` that start a subtest of its context (R1169ac D2): `<t>.test(...)`, `<t>['test'](...)`, or a name
 * bound to either (`const sub = t.test`, `t.test.bind(t)`, `const { test: sub } = t`), `<t>` its first parameter.
 */
function subtestCalls(ts, fn) {
  const p = fn.parameters?.[0]?.name;
  if (!p || !ts.isIdentifier(p)) return [];
  const ctx = (x) => ts.isIdentifier(x) && x.text === p.text;
  const isTestOf = (x) => (ts.isPropertyAccessExpression(x) && ctx(x.expression) && x.name.text === 'test') || (ts.isElementAccessExpression(x) && ctx(x.expression) && ts.isStringLiteralLike(x.argumentExpression) && x.argumentExpression.text === 'test');
  const aliases = new Set();
  const bind = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const i = n.initializer;
      const bound = isTestOf(i) || (ts.isCallExpression(i) && ts.isPropertyAccessExpression(i.expression) && i.expression.name.text === 'bind' && isTestOf(i.expression.expression));
      if (bound && ts.isIdentifier(n.name)) aliases.add(n.name.text);
      if (ts.isObjectBindingPattern(n.name) && ctx(i)) for (const e of n.name.elements) if ((e.propertyName ?? e.name).getText() === 'test' && ts.isIdentifier(e.name)) aliases.add(e.name.text);
    }
    ts.forEachChild(n, bind);
  };
  bind(fn.body);
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && (isTestOf(n.expression) || (ts.isIdentifier(n.expression) && aliases.has(n.expression.text)))) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

/**
 * What must have run of a sign test, on the VM (R1169ab D2; R1169ac/ad, the owner's option (b) of 2026-11-10), read
 * from `text` (a built test file) at the test's `line`:`column`, in its own function and, recursively, in the function
 * of each subtest it starts:
 * - `ends`: each function's last statement (in a trailing `try`, its block's last; an expression body: its own line),
 *   which an early return never reaches;
 * - `subtests`: the line of each subtest it starts, which one started only sometimes never reaches;
 * - `sign`: each line that holds systemd's sign (the static pass's SIGN, in a string, a name or a regex), the
 *   systemd work itself, which a branch, a loop over nothing or a catch that swallows can leave unrun.
 * Lines are the built file's, 1-based, as node's coverage reports them. `refused`: a function given by a name this
 * file doesn't declare (it can't be read, so what must run of it can't be said).
 */
export function mustRun(ts, path, text, line, column) {
  const sf = parsed(ts, path, text);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const at = (n) => ({ line: lineOf(n), pos: n.getStart(sf) });
  const sign = new RegExp(SIGN.source);
  const out = { ends: [], subtests: [], sign: [], refused: null };
  const seen = new Set();
  const walk = (fn, what) => {
    if (seen.has(fn)) return;
    seen.add(fn);
    // Whether it ran to its end (R1169aj D1): read just before its body's closing brace, where only a run that got
    // there counts (a trailing helper's own range, or a loop that returned in a later turn, isn't that point), and
    // judged against the function's own call count, read at the brace that opens its body. An expression body: its
    // own position, as it has no early return.
    if (fn.body && ts.isBlock(fn.body)) {
      const last = fn.body.statements.at(-1);
      if (last && last.end >= fn.body.end - 1) out.refused ??= `${what}'s last statement (line ${lineOf(last)}) ends at its closing brace, so whether it was reached can't be read: put the brace after it, apart`;
      out.ends.push({ line: last ? lineOf(last) : lineOf(fn.body), pos: fn.body.end - 2, calls: fn.body.getStart(sf), what });
    } else if (fn.body) out.ends.push({ ...at(fn.body), what });
    const signs = (n) => {
      if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isIdentifier(n) || ts.isRegularExpressionLiteral(n)) && sign.test(ts.isIdentifier(n) ? n.text : n.getText(sf))) {
        out.sign.push(at(n));
        // Where V8's block coverage counts the sign as run though it wasn't (measured, R1169ag/ah): after a call
        // that throws in a try whose catch takes it (V8 starts no counter after a call), and in the arguments of an
        // optional call that short-circuits (V8 has no counter there). Refused, not judged: 0 picked tests have either.
        for (let x = n; x.parent && x !== fn; x = x.parent) {
          const p = x.parent;
          // Where V8 keeps no count of its own (measured, R1169ag/ah/aj): a default value (a parameter's, a
          // destructuring's), the right side of a logical assignment, a for loop's update. 0 picked tests have one.
          const noCount = (ts.isParameter(p) && x === p.initializer) ? "a parameter's default value"
            : (ts.isBindingElement(p) && x === p.initializer) || (ts.isShorthandPropertyAssignment(p) && x === p.objectAssignmentInitializer) || (ts.isBinaryExpression(p) && x === p.right && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && assignedPattern(ts, p)) ? 'a destructuring default'
            : ts.isBinaryExpression(p) && x === p.right && [ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(p.operatorToken.kind) ? 'the right side of `??=`, `||=` or `&&=`'
            : ts.isForStatement(p) && x === p.incrementor ? "a for loop's update" : null;
          if (noCount) out.refused ??= `line ${lineOf(n)} holds systemd's sign in ${noCount}, where V8 keeps no count of its own: do the systemd work in a statement of its own`;
          // R1169al D3, D4: past an optional chain's first segment, and in a do…while condition, V8 keeps no count.
          if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && ts.isOptionalChain(p) && x !== p.expression && !(ts.isCallExpression(p) && p.arguments.includes(x))) out.refused ??= `line ${lineOf(n)} holds systemd's sign in an optional chain past its receiver (a short-circuit leaves no count): call it plainly`;
          if (ts.isDoStatement(p) && x === p.expression) out.refused ??= `line ${lineOf(n)} holds systemd's sign in a do…while condition, where V8 keeps no count of its own: do the systemd work in the body`;
          if (ts.isTryStatement(p) && x === p.tryBlock && p.catchClause) out.refused ??= `line ${lineOf(n)} holds systemd's sign in a try whose catch would take a throw before it (coverage would count it as run): keep the systemd work out of the try`;
          if ((ts.isCallExpression(p) || ts.isElementAccessExpression(p)) && (p.questionDotToken || ts.isOptionalChain(p)) && x !== p.expression) out.refused ??= `line ${lineOf(n)} holds systemd's sign in an optional call's arguments (a short-circuit leaves no count): call it plainly`;
        }
      }
      ts.forEachChild(n, signs);
    };
    signs(fn.body);
    for (const c of subtestCalls(ts, fn)) {
      out.subtests.push(at(c));
      const sub = functionOf(ts, sf, c.arguments.at(-1));
      if (!sub) out.refused ??= `the subtest at line ${lineOf(c)} is given a function this file doesn't declare once`;
      else walk(sub, `the subtest at line ${lineOf(c)}`);
    }
    // After the subtests, so a refusal of what can't be read comes first.
    const flow = flowProblem(ts, sf, fn, (x) => holdsSign(ts, sf, x, sign));
    if (flow) out.refused ??= `${what}: ${flow}`;
  };
  const call = callAt(ts, sf, line, column);
  const fn = functionOf(ts, sf, call?.arguments.at(-1));
  if (!fn) return { ...out, refused: "its function is given by a name this file doesn't declare once" };
  walk(fn, 'its function');
  out.sign = [...new Map(out.sign.map((s) => [s.pos, s])).values()].sort((a, b) => a.pos - b.pos);
  return out;
}

/** Whether `node` holds systemd's sign (as mustRun reads one: a string, a name or a regex). */
function holdsSign(ts, sf, node, sign) {
  let hit = false;
  const v = (n) => {
    if (hit) return;
    if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isIdentifier(n) || ts.isRegularExpressionLiteral(n)) && sign.test(ts.isIdentifier(n) ? n.text : n.getText(sf))) hit = true;
    else ts.forEachChild(n, v);
  };
  v(node);
  return hit;
}

/**
 * Control flow, read before the run (the organizer's direction on R1169ak/al, 2026-11-11: V8 gives a taken `return`
 * no range of its own before an operand or a `try … finally`, so coverage can't be trusted to see it). In `fn`, and in
 * each function inside it (a callback the test passes, R1169al D2, holding the sign or only the checks on it): a `return` that isn't its
 * function's last statement (but `return <ctx>.skip(…)` or `.todo(…)`, which the run reads as a skip), and a `break` or
 * `continue` whose loop or label holds the sign (it can skip that work). null when there's none.
 */
function flowProblem(ts, sf, fn, hasSign) {
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const fns = [fn];
  const nested = (n) => {
    if (n !== fn && ts.isFunctionLike(n) && n.body) fns.push(n);
    ts.forEachChild(n, nested);
  };
  if (fn.body) nested(fn.body);
  for (const f of fns) {
    if (!f.body || !ts.isBlock(f.body)) continue;
    const last = f.body.statements.at(-1);
    let found = null;
    const visit = (n) => {
      if (found || (n !== f && ts.isFunctionLike(n))) return;
      if (ts.isReturnStatement(n) && n !== last) {
        const e = n.expression;
        const skip = e && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['skip', 'todo'].includes(e.expression.name.text);
        if (!skip) found = `line ${lineOf(n)} returns before its function's end (only its last statement may: an early return skips what follows, which coverage can't always see), so make the rest conditional instead`;
      }
      if ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && !found) {
        let target = null;
        for (let p = n.parent; p && p !== f; p = p.parent) {
          if (n.label ? ts.isLabeledStatement(p) && p.label.text === n.label.text : ts.isIterationStatement(p, false) || (ts.isBreakStatement(n) && ts.isSwitchStatement(p))) {
            target = ts.isLabeledStatement(p) ? p.statement : p;
            break;
          }
        }
        if (target && !ts.isSwitchStatement(target) && hasSign(target)) found = `line ${lineOf(n)}'s ${ts.isBreakStatement(n) ? 'break' : 'continue'} can skip systemd's sign in its ${ts.isIterationStatement(target, false) ? 'loop' : 'block'} (coverage can't always see that), so make the rest conditional instead`;
      }
      ts.forEachChild(n, visit);
    };
    visit(f.body);
    if (found) return f === fn ? found : `a function inside it (line ${lineOf(f)}): ${found}`;
  }
  return null;
}

/** Whether `e`, an `a = b`, is a default inside a destructuring assignment's pattern (`[a = b] = x`, `({ k: a = b } = x)`). */
function assignedPattern(ts, e) {
  let lit = e.parent;
  if (ts.isPropertyAssignment(lit)) lit = lit.parent;
  if (!ts.isArrayLiteralExpression(lit) && !ts.isObjectLiteralExpression(lit)) return false;
  while (lit.parent && (ts.isArrayLiteralExpression(lit.parent) || ts.isObjectLiteralExpression(lit.parent) || ts.isPropertyAssignment(lit.parent) || ts.isSpreadElement(lit.parent) || ts.isParenthesizedExpression(lit.parent))) lit = lit.parent;
  const q = lit.parent;
  return !!q && ((ts.isBinaryExpression(q) && q.operatorToken.kind === ts.SyntaxKind.EqualsToken && q.left === lit) || ((ts.isForOfStatement(q) || ts.isForInStatement(q)) && q.initializer === lit));
}

/**
 * V8's block coverage of one built file (`url`), from a NODE_V8_COVERAGE folder (the owner's direction on R1169ag/ah,
 * 2026-11-11): for each process that loaded it, its ranges (function ranges and the block ranges nested in them, each
 * with how many times it ran). null when no process reported the file.
 */
export function blockCoverage(dir, url) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    for (const s of JSON.parse(readFileSync(join(dir, f), 'utf8')).result ?? []) {
      if (s.url === url) out.push(s.functions.flatMap((fn) => fn.ranges));
    }
  }
  return out.length ? out : null;
}

/**
 * How many times the code at character offset `pos` ran: the count of the innermost range around it, in the one
 * process that reported the file (problems() judges no other: R1169ai D1). A branch not taken, a loop body never entered, a function never called and the code after a
 * `return`, `throw`, `break` or `continue` are each a range of their own, braced or not (the precision line coverage
 * lacked: R1169ah D1).
 */
export function countAt(ranges, pos) {
  let best = null;
  for (const r of ranges) if (r.startOffset <= pos && pos < r.endOffset && (!best || r.endOffset - r.startOffset <= best.endOffset - best.startOffset)) best = r;
  return best ? best.count : 0;
}

/**
 * What's wrong with each gate in `runs`, one entry per file: { file, gates: [{ name, line }], events }, where `events`
 * are node's own results from running that file alone (systemd-acceptance-reporter.mjs: { type, name, nesting, file,
 * line, column, skip, todo }, in the order they finished). A gate's result is the event of its file
 * (`dist/test/<file>.js`), its line, its column (the `test` token's, R1169h) and its name, so a namesake elsewhere, a gate registered only sometimes (under an env var), or a line a
 * test prints can't stand in for it (R1169e, R1169f). Each problem is a gate with no result, more than one, a failure,
 * a skip or a todo, or a subtest (the deeper events just before it) that didn't pass. And a floor: any test in the
 * run that skipped with a reason naming systemd. [] when every gate ran once and passed, all of it.
 */
export function problems(runs) {
  return runs.flatMap(({ file, gates, events, signTests = [], excused = new Set(), coverage = null }) => {
    const built = `dist/test/${file.replace(/\.ts$/, '.js')}`;
    const inFile = (e) => typeof e.file === 'string' && (e.file.split(sep).join('/').endsWith(`/${built}`) || e.file === built);
    const out = [];
    const matched = new Set();
    // How many results came just before event `k`, deeper than it: its subtests (the owner's option (b): a test that
    // starts subtests and ran none, as a loop over nothing, passed having checked nothing, so it fails here).
    const subtestsOf = (k) => {
      let c = 0;
      for (let j = k - 1; j >= 0 && events[j].nesting > events[k].nesting; j--) c++;
      return c;
    };
    for (const g of gates) {
      const at = `test/${file}: ${g.name}`;
      const ks = events.flatMap((e, k) => (inFile(e) && e.line === g.line && e.column === g.column && e.name === g.name ? [k] : []));
      ks.forEach((k) => matched.add(k));
      if (!ks.length) {
        out.push(`${at}: didn't run`);
        continue;
      }
      if (ks.length > 1) {
        out.push(`${at}: ran ${ks.length} times`);
        continue;
      }
      const r = events[ks[0]];
      if (r.type !== 'test:pass') out.push(`${at}: failed`);
      else if (r.skip !== null && r.skip !== false) out.push(`${at}: SKIP${typeof r.skip === 'string' ? ` ${r.skip}` : ''} (it must run here: this is the one place it does)`);
      else if (r.todo !== null && r.todo !== false) out.push(`${at}: TODO${typeof r.todo === 'string' ? ` ${r.todo}` : ''} (it must run here: this is the one place it does)`);
      else if (g.subtests && !subtestsOf(ks[0])) out.push(`${at}: ran no subtest (its function starts subtests, and none ran: it checked nothing)`);
      else {
        // Its subtests: the events just before it, deeper than it, until one at its depth or shallower.
        for (let k = ks[0] - 1; k >= 0 && events[k].nesting > r.nesting; k--) {
          matched.add(k);
          const c = events[k];
          const bad = c.type !== 'test:pass' ? 'failed' : c.skip !== null && c.skip !== false ? `SKIP${typeof c.skip === 'string' ? ` ${c.skip}` : ''}` : c.todo !== null && c.todo !== false ? `TODO${typeof c.todo === 'string' ? ` ${c.todo}` : ''}` : null;
          if (bad) {
            out.push(`${at}: its subtest "${c.name}" ${bad} (all of it must run here)`);
            break;
          }
        }
      }
    }
    // The tests whose own function holds systemd's sign (signTests, R1169n): run here, where systemd is, each must
    // have run, and passed with no skip or todo, all of it, unless the allowlist's `runtime` excuses it: by its place
    // (R1169aa D1, R1169ab D3), the one test its key names, never a namesake.
    for (const t of signTests) {
      const at = `test/${file}: ${t.name ?? t.label}`;
      const ks = events.flatMap((e, k) => (inFile(e) && e.line === t.line && e.column === t.column && (t.name === null || e.name === t.name) ? [k] : []));
      ks.forEach((k) => matched.add(k));
      const why = excused.has(`${t.line}:${t.column}`);
      if (!ks.length) {
        if (!why) out.push(`${at}: didn't run (it reads systemd's sign: its function, a guarded stop or its name; so it must run here. Registered only sometimes, or under a skipped suite?)`);
        continue;
      }
      for (const k of ks) {
        const r = events[k];
        const bad = r.type !== 'test:pass' ? 'failed' : r.skip !== null && r.skip !== false ? `SKIP${typeof r.skip === 'string' ? ` ${r.skip}` : ''}` : r.todo !== null && r.todo !== false ? `TODO${typeof r.todo === 'string' ? ` ${r.todo}` : ''}` : null;
        if (bad && (bad === 'failed' || !why)) {
          out.push(`${at}: ${bad} (it reads systemd's sign: its function, a guarded stop or its name; so it must run here, where systemd is)`);
          continue;
        }
        if (!bad && t.subtests && !subtestsOf(k) && !why) {
          out.push(`${at}: ran no subtest (its function starts subtests, and none ran: it checked nothing)`);
          continue;
        }
        // Its own function ran to its end, and started every subtest it names (R1169ab D2, the owner's decision of
        // 2026-11-10): V8's block coverage of the built file, each point judged by the innermost range around its own
        // position, never by its line (R1169ag/ah). An early return, or a subtest started only sometimes, on what only
        // this VM answers (GITHUB_ACTIONS, the uid, PROJECT_SANDBOX_REQUIRED) passes having checked less.
        if (!bad && !why && t.mustRun) {
          if (!coverage) {
            out.push(`${at}: no coverage of its file came back, so what of it ran can't be read`);
            continue;
          }
          // One process's run, the test's own (R1169ai D1): a child process or a worker that loads the file again
          // reports it too, and its run would count as this one's.
          if (coverage.length !== 1) {
            out.push(`${at}: its file was loaded by ${coverage.length} processes (a child process or a worker running it again), so whose run counts can't be read`);
            continue;
          }
          const ranges = coverage[0];
          const ran = (p) => countAt(ranges, p.pos) > 0;
          const lines = (ps) => [...new Set(ps.map((p) => p.line))].join(', ');
          // Ran to its end every time it ran (R1169aj D1, D2: a function run for two tests, or two subtests, too).
          const ended = (e) => (e.calls === undefined ? ran(e) : countAt(ranges, e.calls) > 0 && countAt(ranges, e.pos) === countAt(ranges, e.calls));
          for (const e of t.mustRun.ends) if (!ended(e)) out.push(`${at}: ${e.what}'s last statement (line ${e.line}) never ran: it returned early, having checked less`);
          const notStarted = t.mustRun.subtests.filter((p) => !ran(p));
          if (notStarted.length) out.push(`${at}: the subtest at line ${lines(notStarted)} never started: started only sometimes, it checked less`);
          const unrun = t.mustRun.sign.filter((p) => !ran(p));
          if (unrun.length) out.push(`${at}: line ${lines(unrun)}, holding systemd's sign, never ran: a branch, a loop over nothing or a catch left the systemd work unchecked`);
        }
        for (let j = k - 1; j >= 0 && events[j].nesting > r.nesting; j--) {
          matched.add(j);
          const c = events[j];
          const sub = c.type !== 'test:pass' ? 'failed' : c.skip !== null && c.skip !== false ? `SKIP${typeof c.skip === 'string' ? ` ${c.skip}` : ''}` : c.todo !== null && c.todo !== false ? `TODO${typeof c.todo === 'string' ? ` ${c.todo}` : ''}` : null;
          if (sub && (sub === 'failed' || !why)) {
            out.push(`${at}: its subtest "${c.name}" ${sub} (all of it must run here)`);
            break;
          }
        }
      }
    }
    // The floor: any other test in this file's run (the run selects only gate names, so that is a gate's namesake or a
    // subtest) skipped with a reason naming systemd. It doesn't see a test the name filter left out: the static rules
    // above and the sign rule (signProblems, R1169k) are what find a gate spelled another way.
    events.forEach((e, k) => {
      if (!matched.has(k) && typeof e.skip === 'string' && /systemd/i.test(e.skip)) out.push(`test/${file}: ${e.name}: SKIP ${e.skip} (a test skipped for systemd here, where systemd is)`);
    });
    return out;
  });
}

/**
 * What node's TAP summary for one file's run says against a clean run (R1169g): its `# fail`, `# cancelled`,
 * `# skipped` and `# todo` all 0, and its `# tests` at least the file's gates. A second count of the same results, from
 * the runner's own reporter (stdout), beside the events. [] when it agrees; a summary it can't find is a problem.
 */
export function summaryProblems(tap, file, gates, whole = false) {
  const n = (k) => {
    const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(tap);
    return m ? Number(m[1]) : null;
  };
  const out = [];
  // A whole file's run (one holding a sign test, R1169n) may skip its other tests: each judged test is read from its
  // own events instead. It must still fail and cancel nothing, and run something.
  for (const k of whole ? ['fail', 'cancelled'] : ['fail', 'cancelled', 'skipped', 'todo']) {
    const v = n(k);
    if (v === null) out.push(`test/${file}: its TAP summary has no "# ${k}" line`);
    else if (v !== 0) out.push(`test/${file}: its TAP summary says ${v} ${k}`);
  }
  const tests = n('tests');
  if (tests !== null && tests < gates) out.push(`test/${file}: its TAP summary counts ${tests} test(s), fewer than its ${gates} gate(s)`);
  if (tests === 0) out.push(`test/${file}: its TAP summary counts no test at all`);
  return out;
}

/** The reporter's JSON lines, read; a line that isn't one is a problem (fail closed). */
export function eventsOf(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** The folders the build compiles: tsconfig.json's include, each glob's part before its first wildcard. */
export function buildRoots(dir) {
  // No tsconfig.json (a bare fixture): the roots this repo's names.
  if (!existsSync(join(dir, 'tsconfig.json'))) return ['src', 'test', 'scripts/bench'];
  const config = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  return [...new Set((config.include ?? []).map((g) => g.split('/').filter((x, k, a) => !a.slice(0, k + 1).some((y) => /[*?{[]/.test(y))).join('/')).filter(Boolean))];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--signs')) {
    const texts = new Map(buildRoots(root).filter((r) => existsSync(join(root, r))).flatMap((r) => readdirSync(join(root, r), { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).map((x) => [`${r}/${x}`, readFileSync(join(root, r, x), 'utf8')])));
    const ts = typescript();
    console.log(JSON.stringify(Object.fromEntries([...texts].map(([p, t]) => [p, signUseList(ts, p, t).map((u) => u.pin)]).filter(([, u]) => u.length)), null, 2));
    process.exit(0);
  }
  let found;
  let signTotal = 0;
  try {
    // systemd's sign, in every file the build compiles (R1169k): only systemCi's declaration, a gate's reason or a
    // test's own function may hold it, and the allowlist's named data, so no skip reads it under another name.
    const roots = buildRoots(root).filter((r) => existsSync(join(root, r)));
    const texts = new Map(roots.flatMap((r) => readdirSync(join(root, r), { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).map((x) => [`${r}/${x}`, readFileSync(join(root, r, x), 'utf8')])));
    const allowFile = join(root, 'scripts', 'ci', 'systemd-acceptance-allow.json');
    const allow = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : {};
    const ts = typescript();
    const sign = signProblems(ts, texts, allow);
    if (sign.length) throw new Error(sign.join('\n'));
    found = findAll(join(root, 'test'), 'test/');
    // The tests whose own function holds the sign (R1169n): read from the built files, as the gates are, by the
    // source's path. Each runs here too, its whole file at once, so a test registered only sometimes is seen.
    // Picked from the static pass's own data (R1169p D2): a test whose function reads a local or an import that
    // carries the sign is one too. Built text, read as its source's path, so imports resolve against the build roots.
    const excused = allow.runtime ?? {};
    const source = signSource(ts, texts, allow);
    for (const [p] of texts) {
      if (!p.startsWith('test/') || !p.endsWith('.test.ts')) continue;
      const file = p.slice('test/'.length);
      const built = join(root, 'dist', 'test', file.replace(/\.ts$/, '.js'));
      if (!existsSync(built)) continue;
      const g = found.find((x) => x.file === file);
      const builtText = readFileSync(built, 'utf8');
      // A gate is excluded by its place, never by its name: a namesake elsewhere is its own test (R1169p D4).
      const gatePlaces = g ? gatesOf(builtText).filter((x) => !x.member).map((x) => `${x.line}:${x.column}`) : [];
      const st = signTests(ts, p, builtText, source.select).filter((t) => !gatePlaces.includes(`${t.line}:${t.column}`));
      if (g) g.calls = signTests(ts, p, builtText, source.select, true);
      if (!st.length) continue;
      const f = g ?? (found.push({ file, names: [] }), found.at(-1));
      f.signTests = st;
    }
    signTotal = found.reduce((a, f) => a + (f.signTests?.length ?? 0), 0);
    const keyed = (f, k) => (f.signTests ?? []).filter((t) => `test/${f.file}: ${t.name ?? t.label}` === k);
    for (const k of Object.keys(excused)) {
      const n = found.reduce((a, f) => a + keyed(f, k).length, 0);
      if (!n) throw new Error(`${k}: named in the allowlist's runtime, but no test whose own function holds systemd's sign has that name`);
      if (n > 1) throw new Error(`${k}: named in the allowlist's runtime, but ${n} tests have that name: give the excused one its own name`);
    }
    // Each excuse is the place of the one test it names (its built line and column, as node reports it).
    for (const f of found) f.excused = new Set(Object.keys(excused).flatMap((k) => keyed(f, k).map((t) => `${t.line}:${t.column}`)));
    // Every other root the build compiles (tsconfig.json's include, read from it so a new root is never missed:
    // src/, scripts/bench/, R1169g) holds no gate: one there, re-exported through a test helper, would run nowhere.
    for (const r of roots.filter((x) => x !== 'test')) findAll(join(root, r), `${r}/`).forEach((f) => {
      throw new Error(`${r}/${f.file}: a systemd gate outside test/: write the gated test in test/`);
    });
    // The built files are what runs: each gate's line is read there, and its names must be the source's.
    for (const f of found) {
      const built = readFileSync(join(root, 'dist', 'test', f.file.replace(/\.ts$/, '.js')), 'utf8');
      // Each gate with whether its function starts subtests (zero subtests run is a failure, the owner's option (b)).
      f.gates = f.names.length ? gatesOf(built).filter((g) => !g.member).map((g) => ({ ...g, subtests: (f.calls ?? []).some((c) => c.line === g.line && c.column === g.column && c.subtests) })) : [];
      const a = [...f.names].sort();
      const b = f.gates.map((g) => g.name).sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`test/${f.file}: its gates ${JSON.stringify(a)} aren't the built file's ${JSON.stringify(b)} (build again)`);
      // Each gate opens with node's own count (R1169ab D2): fewer checks than that fails it here.
      const unplanned = planProblems(ts, `test/${f.file}`, built, f.gates);
      if (unplanned.length) throw new Error(unplanned.join('\n'));
      // Each sign test: what of its own function must have run (R1169ab D2), read on the coverage of its run.
      for (const t of f.signTests ?? []) {
        t.mustRun = mustRun(ts, `test/${f.file}`, built, t.line, t.column);
        // What can't be read can't be judged (R1169ac D1): refused here, unless the allowlist excuses the test.
        // The advice to inline or declare fits only a function that can't be read (R1169ag D3, R1169ah D6).
        if (t.mustRun.refused && !excused[`test/${f.file}: ${t.name ?? t.label}`]) throw new Error(`test/${f.file}: ${t.name ?? t.label}: ${t.mustRun.refused}${/declare once/.test(t.mustRun.refused) ? ': inline it, or declare it in this file once, so what of it must run on the VM can be read' : ''}`);
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const names = found.flatMap((f) => f.names);
  if (!names.length) {
    console.error('no test in test/ is gated on systemCi: nothing to run');
    process.exit(2);
  }
  console.log(`${names.length} systemd acceptance test(s):\n${found.flatMap((f) => f.names.map((n) => `  test/${f.file}: ${n}`)).join('\n')}`);
  console.log(`${signTotal} other test(s) whose own function holds systemd's sign, run here with their whole files:\n${found.flatMap((f) => (f.signTests ?? []).map((t) => `  test/${f.file}:${t.line}: ${t.name ?? t.label}`)).join('\n')}`);
  // One run per file; TAP to the log, node's own results on fd 3 (systemd-acceptance-reporter.mjs).
  const runs = [];
  const exits = [];
  {
    for (const f of found) {
      // node's own results arrive on fd 3, a pipe only this process and the runner's reporter hold (R1169g, R1169h).
      // A file with a sign test runs whole (R1169n): no name filter, so a test registered only sometimes, or under a
      // suite that skips, shows as not run. A file of gates alone runs only its gates, by name, as before.
      const whole = !!f.signTests?.length;
      // A file with sign tests runs with V8's block coverage (NODE_V8_COVERAGE, a fresh folder of this run's alone;
      // R1169ab D2, R1169ag/ah): what of each test's own function ran, read from that file's ranges.
      const covDir = whole ? mkdtempSync(join(tmpdir(), 'systemd-acceptance-cov-')) : null;
      const args = [...PRELOAD, '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', ...(whole ? [] : f.names.map((n) => `--test-name-pattern=^${escapeRe(n)}$`)), `dist/test/${f.file.replace(/\.ts$/, '.js')}`];
      // Never a child of another test run (NODE_TEST_CONTEXT), and no NODE_OPTIONS (an --enable-source-maps there would
      // report TS lines, so every gate would read as not run).
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS' && k !== 'NODE_V8_COVERAGE'));
      if (covDir) env.NODE_V8_COVERAGE = covDir;
      const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
      process.stdout.write(r.stdout ?? '');
      let events;
      try {
        events = eventsOf(r.output?.[3] ?? '');
      } catch (e) {
        console.error(`test/${f.file}: its results couldn't be read (${e.message})`);
        process.exit(1);
      }
      let coverage = null;
      if (covDir) {
        try {
          coverage = blockCoverage(covDir, pathToFileURL(join(root, 'dist', 'test', f.file.replace(/\.ts$/, '.js'))).href);
        } finally {
          rmSync(covDir, { recursive: true, force: true });
        }
      }
      runs.push({ file: f.file, gates: f.gates, events, signTests: f.signTests ?? [], excused: f.excused ?? new Set(), coverage });
      exits.push(...summaryProblems(r.stdout ?? '', f.file, f.gates.length + (f.signTests?.length ?? 0), whole));
      if (r.status !== 0) exits.push(`test/${f.file}: the test run exited ${r.status ?? r.signal}`);
    }
  }
  const bad = problems(runs);
  if (!bad.length) bad.push(...exits);
  if (bad.length) {
    console.error(`systemd acceptance tests that didn't pass here:\n${bad.map((b) => `  ${b}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`all ${names.length} gate(s) and ${signTotal} sign test(s) ran and passed`);
}
