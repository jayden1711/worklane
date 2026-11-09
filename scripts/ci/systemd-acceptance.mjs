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
// At run time, on the VM (R1169n, signTests): every test whose own function holds systemd's sign (below) runs here
// too, its whole file at once with no name filter, and each must have run and passed with no skip or todo, all of it,
// matched by built file, line and column as a gate is. So a test that detects systemd in its body and skips, marks
// itself todo, returns a skip helper's answer, is registered only sometimes or sits in a suite that skips, fails
// here, where systemd is. One that legitimately skips here is named in the allowlist's `runtime`, with why.
//
// Before that, statically (R1169k, R1169m, R1169n, signProblems), on every PR in the normal suite too: in every file
// the build compiles (tsconfig.json's include), the sign (`systemd` or `systemd1` as a word, a name starting
// `systemd_`/`SYSTEMD_`, `systemctl`, `journalctl`, `loginctl`, `/proc/1/`, `is-system-running`, `sd_booted`,
// INVOCATION_ID, NOTIFY_SOCKET), read by typescript's parser in every string (decoded too), template, regex and
// identifier, may be only in systemCi's declaration, a gate's reason, a test's or suite's name, or a test's own
// function (which the VM runs). Anywhere else it must be data scripts/ci/systemd-acceptance-allow.json names by file
// and exact text (`token: <the line, trimmed>`), with why, so a use moved or swapped is a change. And a test's or
// suite's skip or todo may not read what carries the sign: an import from src/, from a file that holds the sign, or
// from a module named at run time, or a local whose value comes, through any number of that file's own declarations
// and assignments (read with scopes), from one of those, from the sign or from a file read; unless the allowlist's
// skipImports names it, with why.
//
// What neither can see: a skip on a proxy with no sign anywhere in its file (`process.getuid() === 0`, a cgroup path:
// R1169n N04); a sign split inside a word (`'sys' + 'temd'`, deliberate); a value carried through another file that
// holds no sign itself (a src/ helper wrapping a holder's detector, read by a local); a test that passes without
// checking (an early return on the VM's answer: it does run on the VM, where it checks for real).
//
// Results come from node's own test events (systemd-acceptance-reporter.mjs, R1169f), never from TAP text a test
// could print: each gate is matched by its built file, the line and column its test() call is on, and its name, and
// the events arrive on a pipe (fd 3) no test process holds.
//
//   node scripts/ci/systemd-acceptance.mjs            (after npm ci and the build: it runs dist/test/<file>.js)
//   node scripts/ci/systemd-acceptance.mjs --signs    (each file's uses of the sign, by exact text, for the allowlist)
//
// Exit 1: a gate or a sign test failed, skipped, was a todo, didn't run, (a gate) ran more than once, or has a
// subtest that didn't pass; a run failed or ran no test; or a test here skipped naming systemd. Exit 2: no such test was found, a file couldn't be read, a gate isn't one it reads, or the
// sign is somewhere the rule refuses.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * cmdline), `is-system-running`, `sd_booted`, and the variables systemd sets (INVOCATION_ID, NOTIFY_SOCKET). Read in
 * every string, template, regex and identifier the parser sees, as written and as decoded (`'\x73ystemd'` too), so a
 * path built from parts (`'/run' + '/systemd'`) still holds one. Comments don't count.
 */
const SIGN = /(?<![\w$])(?:systemd1?|systemctl|journalctl|loginctl|is-system-running|sd_booted|INVOCATION_ID|NOTIFY_SOCKET)(?![\w$])|(?<![\w$])(?:systemd|SYSTEMD)_|\/proc\/1\//;

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

/** `test(...)`/`it(...)`, with `.only`, `.skip` or `.todo`. */
function isTestCall(ts, n) {
  if (!ts.isCallExpression(n)) return false;
  let c = n.expression;
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && /^(?:only|skip|todo)$/.test(c.name.text)) c = c.expression;
  return ts.isIdentifier(c) && (c.text === 'test' || c.text === 'it');
}
/** `describe(...)`/`suite(...)`, with `.only`, `.skip` or `.todo`. */
function isSuiteCall(ts, n) {
  if (!ts.isCallExpression(n)) return false;
  let c = n.expression;
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && /^(?:only|skip|todo)$/.test(c.name.text)) c = c.expression;
  return ts.isIdentifier(c) && (c.text === 'describe' || c.text === 'suite');
}
/** A test call's own function: its last argument, when it has a name before it and is a function. */
const ownFunction = (ts, n) => {
  const fn = n.arguments[n.arguments.length - 1];
  return n.arguments.length > 1 && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : null;
};

/**
 * Where the sign may be (R1169k; R1169n's runtime check): systemCi's declaration in a *.test.ts file, a gate's reason,
 * a test's or a suite's name, and a test's own function. A test whose own function holds the sign is run on the VM by
 * the acceptance job (signTests), where any skip or todo in it fails, so a detector there can't hide it.
 */
function allowedSpans(ts, sf, testFile) {
  const spans = [];
  const visit = (n) => {
    if (testFile && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'systemCi' && n.initializer) spans.push([n.initializer.getStart(sf), n.initializer.end]);
    if ((isTestCall(ts, n) || isSuiteCall(ts, n)) && n.arguments.length) spans.push([n.arguments[0].getStart(sf), n.arguments[0].end]);
    if (isTestCall(ts, n)) {
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
  const spans = allowedSpans(ts, sf, path.endsWith('.test.ts'));
  const lines = text.split('\n');
  const out = [];
  const visit = (n) => {
    const token = leafSign(ts, sf, n);
    if (token) {
      const at = n.getStart(sf);
      if (!spans.some(([a, b]) => at >= a && n.end <= b)) {
        const line = sf.getLineAndCharacterOfPosition(at).line;
        out.push({ at: `${line + 1}: ${token}`, pin: `${token}: ${lines[line].trim()}` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** signUseList's places, as `line: token`. */
export const signUses = (ts, path, text) => signUseList(ts, path, text).map((u) => u.at);

/** A relative specifier from `path`, resolved to a build-root path in `paths` (`./x.js` to `test/x.ts`); else as written. */
function resolveFrom(path, spec, paths) {
  if (!spec.startsWith('.')) return spec;
  const parts = path.split('/').slice(0, -1);
  for (const x of spec.split('/')) {
    if (x === '..') parts.pop();
    else if (x !== '.') parts.push(x);
  }
  const p = parts.join('/');
  for (const c of [p, p.replace(/\.([cm]?)js$/, '.$1ts'), `${p}.ts`, `${p}/index.ts`]) if (paths.has(c)) return c;
  return p;
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
  // Scopes: each declaration's name belongs to the nearest block, function, loop or file around it, and a name read is
  // the nearest declaration of it outward, so two functions' own `r` are two names.
  const isScope = (n) => ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseBlock(n) || ts.isCatchClause(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isFunctionLike(n) || ts.isClassLike(n);
  const scopes = new Map();
  const declare = (scope, name, d) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
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
    const d = { name: nameNode.text, binding, nodes: node ? [node] : [] };
    decls.push(d);
    declare(scope, nameNode.text, d);
    return d;
  };
  const bindAll = (scope, name, module, imported, node) => {
    if (ts.isIdentifier(name)) add(scope, name, `${module}: ${imported}`, null);
    else for (const e of name.elements ?? []) if (!ts.isOmittedExpression(e)) bindAll(scope, e.name, module, e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName.text : ts.isIdentifier(e.name) ? e.name.text : imported, node);
  };
  const declAll = (scope, name, node) => {
    if (ts.isIdentifier(name)) add(scope, name, null, node);
    else for (const e of name.elements ?? []) if (!ts.isOmittedExpression(e)) declAll(scope, e.name, node);
  };
  /** The module a `require()` or `import()` in `n` loads: its specifier, '?' when it isn't a literal, or null. */
  const loads = (n) => {
    let spec = null;
    const walk = (x) => {
      if (spec) return;
      if (ts.isCallExpression(x) && (x.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(x.expression) && x.expression.text === 'require'))) spec = x.arguments[0] && ts.isStringLiteralLike(x.arguments[0]) ? x.arguments[0].text : '?';
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
  const visit = (n) => {
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
      const spec = n.initializer ? loads(n.initializer) : null;
      if (spec) bindAll(scope, n.name, spec === '?' ? '?' : resolveFrom(path, spec, source.paths), '*', n.initializer);
      // systemCi is the gate itself: its declaration is the one place the sign may feed a skip.
      else if (!(ts.isIdentifier(n.name) && n.name.text === 'systemCi')) declAll(scope, n.name, n.initializer ?? null);
      else add(scope, n.name, null, null);
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) add(scopeOf(n), n.name, null, n);
    else if (ts.isParameter(n)) declAll(n.parent, n.name, n.initializer ?? null);
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left)) assignments.push([n.left, statementOf(n)]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // An assignment adds where its statement reads from to the declaration it assigns (`if (sign) booted = true`).
  for (const [id, st] of assignments) resolve(id)?.nodes.push(st);
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
      } else if (ts.isCallExpression(x) && /^(?:readFileSync|readFile)$/.test(ts.isIdentifier(x.expression) ? x.expression.text : ts.isPropertyAccessExpression(x.expression) ? x.expression.name.text : '')) hit = true;
      if (!hit) ts.forEachChild(x, walk);
    };
    walk(node);
    return hit;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) if (!d.binding && !tainted.has(d) && d.nodes.some((x) => carries(x))) (tainted.add(d), (changed = true));
  }
  return { sf, resolve, tainted, carries, sourceOf };
}

/**
 * What each `skip:` or `todo:` option in `text` reads that carries systemd's sign (R1169k, R1169m): a binding from
 * src/, from a file that holds the sign, or from a module it can't name (`<module>: <name>`), or a local name that
 * comes from one, from the sign or from a file read (`<path>: <name>`). `source(module, binding)`: whether a binding
 * from `module` carries it.
 */
export function skipReads(ts, path, text, source) {
  if (!/\b(?:skip|todo)\b/.test(text)) return [];
  const { sf, resolve, tainted, sourceOf } = fileFlow(ts, path, text, source);
  const out = new Set();
  const read = (n) => {
    if (ts.isIdentifier(n) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      const d = resolve(n);
      const b = d?.binding;
      if (b && (sourceOf(b) || source.direct?.(b.slice(0, b.lastIndexOf(': ')), b))) out.add(b);
      else if (d && tainted.has(d)) out.add(`${path}: ${n.text}`);
    }
    ts.forEachChild(n, read);
  };
  // A test's or suite's options (its argument between the name and the function), `t.test(...)`'s included: their
  // `skip` and `todo`, or the whole argument when it isn't an object literal (`test(name, opts, fn)`).
  const isCall = (n) => {
    if (!ts.isCallExpression(n) || n.arguments.length < 3) return false;
    const c = n.expression;
    const last = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : '';
    const base = ts.isPropertyAccessExpression(c) && ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : '';
    return /^(?:test|it|describe|suite)$/.test(last) || (/^(?:only|skip|todo)$/.test(last) && /^(?:test|it|describe|suite)$/.test(base));
  };
  const options = (o) => {
    if (!ts.isObjectLiteralExpression(o)) return read(o);
    for (const x of o.properties) {
      if (ts.isPropertyAssignment(x) && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && /^(?:skip|todo)$/.test(x.name.text)) read(x.initializer);
      else if (ts.isShorthandPropertyAssignment(x) && /^(?:skip|todo)$/.test(x.name.text)) read(x.name);
      else if (ts.isSpreadAssignment(x) || (ts.isPropertyAssignment(x) && ts.isComputedPropertyName(x.name))) read(x);
    }
  };
  const skips = (n) => {
    if (isCall(n)) options(n.arguments[1]);
    ts.forEachChild(n, skips);
  };
  skips(sf);
  return [...out];
}

/** Every build-root file's sign uses, and what makes a binding carry the sign (src/, a holder, `?`, not a named import). */
function signSource(ts, texts, allow, known = null) {
  const okImports = allow.skipImports ?? {};
  const uses = known ?? new Map([...texts].map(([p, t]) => [p, signUseList(ts, p, t)]));
  const holders = new Set([...uses].filter(([, u]) => u.length).map(([p]) => p));
  // A binding carries the sign, for a local derived from it, when its module holds the sign or can't be named; a skip
  // that reads a binding directly is refused for any src/ module too (product code is never a test's gate).
  return { uses, holders, paths: new Set(texts.keys()), carries: (m, b) => !(b in okImports) && (m === '?' || holders.has(m)), direct: (m, b) => !(b in okImports) && m.startsWith('src/') };
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
    for (const b of skipReads(ts, p, t, source)) {
      read.add(b);
      if (!(b in okImports)) out.push(`${p}: a skip reads ${b}, which carries systemd's sign (${b.startsWith(`${p}: `) ? 'a local from the sign, an import that carries it, or a file read' : b.startsWith('?: ') ? 'from a module named at run time' : b.startsWith('src/') ? 'from src/' : "from a file that holds systemd's sign"}): gate a test that needs systemd on systemCi; another check goes in the allowlist's skipImports with why`);
    }
  }
  // An entry is still needed only while a skip reads it, or (for an import) while it would carry the sign without it.
  const raw = signSource(ts, texts, {}, source.uses);
  const rawReads = new Set([...texts].flatMap(([p, t]) => skipReads(ts, p, t, raw)));
  for (const b of Object.keys(okImports)) if (!rawReads.has(b)) out.push(`${b}: named in the allowlist's skipImports, but no skip reads it`);
  return out;
}

/**
 * The tests in `text` (a built test file, read as `path`, its source's path) the acceptance job runs on the VM besides
 * the gates (R1169n, the owner's decision): each test() or it() call, not inside another test's function, whose own
 * function holds systemd's sign itself. Each as { name (a literal, else null), line, column } of its call, as node
 * reports a test's place. (A skip option reading a name that carries the sign is refused statically, skipReads.)
 */
export function signTests(ts, path, text) {
  if (!maySign(text)) return [];
  const sf = parsed(ts, path, text);
  const holds = (node) => {
    let hit = false;
    const walk = (x) => {
      if (hit) return;
      if (leafSign(ts, sf, x)) hit = true;
      else ts.forEachChild(x, walk);
    };
    walk(node);
    return hit;
  };
  const out = [];
  const visit = (n) => {
    if (isTestCall(ts, n)) {
      const fn = ownFunction(ts, n);
      if (fn && holds(fn)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(n.expression.getStart(sf));
        const a = n.arguments[0];
        out.push({ name: a && ts.isStringLiteralLike(a) ? a.text : null, line: line + 1, column: character + 1, label: a ? a.getText(sf).slice(0, 120) : '' });
      }
      return;
    }
    ts.forEachChild(n, visit);
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
  return runs.flatMap(({ file, gates, events, signTests = [], excused = new Set() }) => {
    const built = `dist/test/${file.replace(/\.ts$/, '.js')}`;
    const inFile = (e) => typeof e.file === 'string' && (e.file.split(sep).join('/').endsWith(`/${built}`) || e.file === built);
    const out = [];
    const matched = new Set();
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
    // have run, and passed with no skip or todo, all of it, unless the allowlist's `runtime` excuses it by name.
    for (const t of signTests) {
      const at = `test/${file}: ${t.name ?? t.label}`;
      const ks = events.flatMap((e, k) => (inFile(e) && e.line === t.line && e.column === t.column && (t.name === null || e.name === t.name) ? [k] : []));
      ks.forEach((k) => matched.add(k));
      const why = excused.has(t.name ?? t.label);
      if (!ks.length) {
        if (!why) out.push(`${at}: didn't run (its own function holds systemd's sign, so it must run here; registered only sometimes, or under a skipped suite?)`);
        continue;
      }
      for (const k of ks) {
        const r = events[k];
        const bad = r.type !== 'test:pass' ? 'failed' : r.skip !== null && r.skip !== false ? `SKIP${typeof r.skip === 'string' ? ` ${r.skip}` : ''}` : r.todo !== null && r.todo !== false ? `TODO${typeof r.todo === 'string' ? ` ${r.todo}` : ''}` : null;
        if (bad && (bad === 'failed' || !why)) {
          out.push(`${at}: ${bad} (its own function holds systemd's sign: it must run here, where systemd is)`);
          continue;
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
    const excused = allow.runtime ?? {};
    for (const [p] of texts) {
      if (!p.startsWith('test/') || !p.endsWith('.test.ts')) continue;
      const file = p.slice('test/'.length);
      const built = join(root, 'dist', 'test', file.replace(/\.ts$/, '.js'));
      if (!existsSync(built)) continue;
      const g = found.find((x) => x.file === file);
      const st = signTests(ts, `dist/test/${file.replace(/\.ts$/, '.js')}`, readFileSync(built, 'utf8')).filter((t) => !g || !g.names.includes(t.name));
      if (!st.length) continue;
      const f = g ?? (found.push({ file, names: [] }), found.at(-1));
      f.signTests = st;
    }
    signTotal = found.reduce((a, f) => a + (f.signTests?.length ?? 0), 0);
    for (const k of Object.keys(excused)) if (!found.some((f) => (f.signTests ?? []).some((t) => `test/${f.file}: ${t.name ?? t.label}` === k))) throw new Error(`${k}: named in the allowlist's runtime, but no test whose own function holds systemd's sign has that name`);
    for (const f of found) f.excused = new Set(Object.keys(excused).filter((k) => k.startsWith(`test/${f.file}: `)).map((k) => k.slice(`test/${f.file}: `.length)));
    // Every other root the build compiles (tsconfig.json's include, read from it so a new root is never missed:
    // src/, scripts/bench/, R1169g) holds no gate: one there, re-exported through a test helper, would run nowhere.
    for (const r of roots.filter((x) => x !== 'test')) findAll(join(root, r), `${r}/`).forEach((f) => {
      throw new Error(`${r}/${f.file}: a systemd gate outside test/: write the gated test in test/`);
    });
    // The built files are what runs: each gate's line is read there, and its names must be the source's.
    for (const f of found) {
      const built = readFileSync(join(root, 'dist', 'test', f.file.replace(/\.ts$/, '.js')), 'utf8');
      f.gates = f.names.length ? gatesOf(built).filter((g) => !g.member) : [];
      const a = [...f.names].sort();
      const b = f.gates.map((g) => g.name).sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`test/${f.file}: its gates ${JSON.stringify(a)} aren't the built file's ${JSON.stringify(b)} (build again)`);
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
      const args = [...PRELOAD, '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', ...(whole ? [] : f.names.map((n) => `--test-name-pattern=^${escapeRe(n)}$`)), `dist/test/${f.file.replace(/\.ts$/, '.js')}`];
      // Never a child of another test run (NODE_TEST_CONTEXT), and no NODE_OPTIONS (an --enable-source-maps there would
      // report TS lines, so every gate would read as not run).
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS'));
      const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
      process.stdout.write(r.stdout ?? '');
      let events;
      try {
        events = eventsOf(r.output?.[3] ?? '');
      } catch (e) {
        console.error(`test/${f.file}: its results couldn't be read (${e.message})`);
        process.exit(1);
      }
      runs.push({ file: f.file, gates: f.gates, events, signTests: f.signTests ?? [], excused: f.excused ?? new Set() });
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
