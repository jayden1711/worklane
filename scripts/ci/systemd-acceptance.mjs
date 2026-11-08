// The acceptance tests that need a booted systemd and passwordless sudo: each test under test/ whose options say
// `skip: !systemCi`. In the self-hosted tests runner's container they skip (no systemd as process 1, #1165), so
// ci.yml's `systemd-acceptance` job runs them on GitHub's VM on each push to main. This finds them by that gate,
// runs exactly them, and fails unless every one ran and passed: a skip here is a failure, so none of them can
// quietly run nowhere. Nothing is listed by hand, so a new test with that gate is run here too, in any directory
// under test/ (npm test runs dist/test/**/*.test.js). The gate has one spelling: any other mention of systemCi in a
// test file (`! systemCi`, `!(systemCi)`, a ternary, a check inside a test), or a skip on a flag shaped like it,
// stops the job.
//
// A test gated on systemd under another name is found by systemd's sign, not by the name (R1169k, signProblems):
// in every file the build compiles (tsconfig.json's include), the sign (`systemd` or `systemd1` as a word, a name
// starting `systemd_`/`SYSTEMD_`, `systemctl`, `journalctl`, `loginctl`, `/proc/1/`, `is-system-running`, `sd_booted`,
// INVOCATION_ID, NOTIFY_SOCKET), read by typescript's parser in every string,
// template, regex and identifier, may be only in systemCi's declaration, a gate's reason, a test's name or a test's
// own function that skips nothing. Anywhere else it must be data scripts/ci/systemd-acceptance-allow.json names, by
// file, count and why; and a skip may read a binding from src/ or from such a file only as that list names it. So
// however many steps, names or imports lie between the sign and a skip, the sign is somewhere the rule refuses.
// What it can't see: a sign spelled so no word of it is whole (`'sys' + 'temd'`, deliberate, out of scope), and a
// value an allowlisted file computes, reached by a skip through another file (each allowlisted use is reviewed as
// data no skip reads).
//
// Results come from node's own test events (systemd-acceptance-reporter.mjs, R1169f), never from TAP text a test
// could print: each gate is matched by its built file, the line and column its test() call is on, and its name, and
// the events arrive on a pipe (fd 3) no test process holds.
//
//   node scripts/ci/systemd-acceptance.mjs            (after npm ci and the build: it runs dist/test/<file>.js)
//   node scripts/ci/systemd-acceptance.mjs --signs    (each file's uses of the sign, to update the allowlist)
//
// Exit 1: a test failed, skipped, didn't run, ran more than once or has a subtest that didn't pass, or a test here
// skipped naming systemd. Exit 2: no such test was found, a file couldn't be read, a gate isn't one it reads, or the
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
 * every string, template, regex and identifier the parser sees, so a path built from parts (`'/run' + '/systemd'`)
 * still holds one. Comments don't count.
 */
const SIGN = /(?<![\w$])(?:systemd1?|systemctl|journalctl|loginctl|is-system-running|sd_booted|INVOCATION_ID|NOTIFY_SOCKET)(?![\w$])|(?<![\w$])(?:systemd|SYSTEMD)_|\/proc\/1\//;

/** Where the sign may be, as the only places a skip can't read it from (signUses). */
function allowedSpans(ts, sf, testFile) {
  const spans = [];
  const isTestCall = (n) => {
    if (!ts.isCallExpression(n)) return false;
    let c = n.expression;
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && /^(?:only|skip|todo)$/.test(c.name.text)) c = c.expression;
    return ts.isIdentifier(c) && (c.text === 'test' || c.text === 'it');
  };
  const hasSkip = (n) => {
    let found = false;
    const walk = (x) => {
      if (found) return;
      if (ts.isIdentifier(x) && x.text === 'skip') found = true;
      else ts.forEachChild(x, walk);
    };
    walk(n);
    return found;
  };
  const visit = (n) => {
    // The flag itself: `const systemCi = ...` in a *.test.ts file, its whole initializer.
    if (testFile && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'systemCi' && n.initializer) spans.push([n.initializer.getStart(sf), n.initializer.end]);
    if (isTestCall(n)) {
      const args = n.arguments;
      // A test's name: text, never a flag.
      if (args.length) spans.push([args[0].getStart(sf), args[0].end]);
      // A test's own function: data a running test uses, unless it skips anything (a skip there reading the sign
      // would hide that test, or a subtest, as a gate under another name would).
      const fn = args[args.length - 1];
      if (args.length > 1 && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !hasSkip(fn)) spans.push([fn.getStart(sf), fn.end]);
      // A gate's reason: `{ skip: !systemCi && 'needs systemd' }`.
      const o = args.length > 2 ? args[1] : null;
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
 * Each place `text` (the file `path`) holds systemd's sign outside the places it may (R1169k), as `line: token`. It
 * may be only in a `const systemCi =` declaration's value in a *.test.ts file, a gate's reason, a test()'s or it()'s
 * name, or that test's own function when it skips nothing. Anywhere else (a constant, a helper, a function, an
 * import, src/) it's a use: a skip could read it under another name, at any number of steps, so each use must be
 * one the allowlist names (systemd-acceptance-allow.json). `ts`: the typescript package, which parses the file.
 */
export function signUses(ts, path, text) {
  if (!new RegExp(SIGN.source).test(text)) return [];
  const kind = /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const spans = allowedSpans(ts, sf, path.endsWith('.test.ts'));
  const out = [];
  const leafText = (n) => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
    if (ts.isStringLiteralLike(n) || ts.isRegularExpressionLiteral(n) || ts.isTemplateLiteralToken?.(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isNumericLiteral(n) || n.kind === ts.SyntaxKind.JsxText) return n.getText(sf);
    return null;
  };
  const visit = (n) => {
    const t = leafText(n);
    if (t !== null) {
      const m = SIGN.exec(t);
      const at = n.getStart(sf);
      if (m && !spans.some(([a, b]) => at >= a && n.end <= b)) out.push(`${sf.getLineAndCharacterOfPosition(at).line + 1}: ${m[0]}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Each binding a `skip:` option in `text` (the file `path`) reads from another module, as `<module>: <name>` (R1169k):
 * an import of any form (named, renamed, namespace as `*`, default as `default`), or a `require()` or `import()`'s
 * result. `<module>` is the build-root path it resolves to (`./x.js` to `test/x.ts`), or the specifier as written when
 * it isn't one of `paths`.
 */
export function skipImports(ts, path, text, paths) {
  if (!/\bskip\b/.test(text)) return [];
  const kind = /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const dir = path.split('/').slice(0, -1);
  const resolve = (spec) => {
    if (!spec.startsWith('.')) return spec;
    const parts = [...dir];
    for (const x of spec.split('/')) {
      if (x === '..') parts.pop();
      else if (x !== '.') parts.push(x);
    }
    const p = parts.join('/');
    for (const c of [p, p.replace(/\.([cm]?)js$/, '.$1ts'), `${p}.ts`, `${p}/index.ts`]) if (paths.has(c)) return c;
    return p;
  };
  const bound = new Map();
  const bindAll = (name, module, imported) => {
    if (ts.isIdentifier(name)) bound.set(name.text, `${module}: ${imported}`);
    else for (const e of name.elements ?? []) if (!ts.isOmittedExpression(e)) bindAll(e.name, module, e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName.text : ts.isIdentifier(e.name) ? e.name.text : imported);
  };
  const loads = (n) => {
    let spec = null;
    const walk = (x) => {
      if (spec) return;
      if (ts.isCallExpression(x) && (x.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(x.expression) && x.expression.text === 'require')) && x.arguments[0] && ts.isStringLiteralLike(x.arguments[0])) spec = x.arguments[0].text;
      else ts.forEachChild(x, walk);
    };
    walk(n);
    return spec;
  };
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
      const m = resolve(n.moduleSpecifier.text);
      const c = n.importClause;
      if (c.name) bound.set(c.name.text, `${m}: default`);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bound.set(nb.name.text, `${m}: *`);
      else if (nb) for (const e of nb.elements) bound.set(e.name.text, `${m}: ${(e.propertyName ?? e.name).text}`);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      bound.set(n.name.text, `${resolve(n.moduleReference.expression.text)}: *`);
    } else if (ts.isVariableDeclaration(n) && n.initializer) {
      const spec = loads(n.initializer);
      if (spec) bindAll(n.name, resolve(spec), '*');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const out = new Set();
  const read = (n) => {
    if (ts.isIdentifier(n) && bound.has(n.text) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) out.add(bound.get(n.text));
    ts.forEachChild(n, read);
  };
  const skips = (n) => {
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === 'skip') read(n.initializer);
    else if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'skip') read(n.name);
    ts.forEachChild(n, skips);
  };
  skips(sf);
  return [...out];
}

/**
 * The sign rule over every file the build compiles (R1169k), as problems ([] when it holds). `texts`: path to text.
 * `allow` (systemd-acceptance-allow.json): `uses`, the files where the sign is data no skip reads, each with its count
 * of uses and why; `skipImports`, the `<module>: <name>` bindings a skip may read from src/ or from a file in `uses`,
 * each with why. Any other use, a count that changed, a skip reading such a binding unnamed, or an entry with nothing
 * left to name, is a problem.
 */
export function signProblems(ts, texts, allow = {}) {
  const uses = allow.uses ?? {};
  const okImports = allow.skipImports ?? {};
  const out = [];
  const holders = new Set();
  const paths = new Set(texts.keys());
  for (const [p, t] of texts) {
    const u = signUses(ts, p, t);
    if (u.length) holders.add(p);
    const want = uses[p]?.n ?? 0;
    if (u.length !== want) out.push(`${p}: ${u.length} use(s) of systemd's sign outside a systemCi declaration, a gate's reason or a test's own function, ${want} named in scripts/ci/systemd-acceptance-allow.json (${u.slice(0, 6).join(', ')}${u.length > 6 ? ', ...' : ''}): gate a test that needs systemd on systemCi, as \`test(<name>, { skip: !systemCi ...\`; data no skip reads goes in the allowlist with its count and why`);
  }
  for (const p of Object.keys(uses)) if (!texts.has(p)) out.push(`${p}: named in scripts/ci/systemd-acceptance-allow.json, but the build has no such file`);
  for (const [p, t] of texts) {
    for (const b of skipImports(ts, p, t, paths)) {
      const m = b.slice(0, b.lastIndexOf(': '));
      if ((m.startsWith('src/') || holders.has(m)) && !(b in okImports)) out.push(`${p}: a skip reads ${b}, from ${m.startsWith('src/') ? 'src/' : 'a file that holds systemd\'s sign'}: gate a test that needs systemd on systemCi; another check goes in the allowlist's skipImports with why`);
    }
  }
  for (const b of Object.keys(okImports)) if (![...texts].some(([p, t]) => skipImports(ts, p, t, paths).includes(b))) out.push(`${b}: named in the allowlist's skipImports, but no skip reads it`);
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
  return runs.flatMap(({ file, gates, events }) => {
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
export function summaryProblems(tap, file, gates) {
  const n = (k) => {
    const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(tap);
    return m ? Number(m[1]) : null;
  };
  const out = [];
  for (const k of ['fail', 'cancelled', 'skipped', 'todo']) {
    const v = n(k);
    if (v === null) out.push(`test/${file}: its TAP summary has no "# ${k}" line`);
    else if (v !== 0) out.push(`test/${file}: its TAP summary says ${v} ${k}`);
  }
  const tests = n('tests');
  if (tests !== null && tests < gates) out.push(`test/${file}: its TAP summary counts ${tests} test(s), fewer than its ${gates} gate(s)`);
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
    console.log(JSON.stringify(Object.fromEntries([...texts].map(([p, t]) => [p, signUses(ts, p, t)]).filter(([, u]) => u.length)), null, 2));
    process.exit(0);
  }
  let found;
  try {
    // systemd's sign, in every file the build compiles (R1169k): only systemCi's declaration, a gate's reason or a
    // test's own function may hold it, and the allowlist's named data, so no skip reads it under another name.
    const roots = buildRoots(root).filter((r) => existsSync(join(root, r)));
    const texts = new Map(roots.flatMap((r) => readdirSync(join(root, r), { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).map((x) => [`${r}/${x}`, readFileSync(join(root, r, x), 'utf8')])));
    const allowFile = join(root, 'scripts', 'ci', 'systemd-acceptance-allow.json');
    const allow = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : {};
    const sign = signProblems(typescript(), texts, allow);
    if (sign.length) throw new Error(sign.join('\n'));
    found = findAll(join(root, 'test'), 'test/');
    // Every other root the build compiles (tsconfig.json's include, read from it so a new root is never missed:
    // src/, scripts/bench/, R1169g) holds no gate: one there, re-exported through a test helper, would run nowhere.
    for (const r of roots.filter((x) => x !== 'test')) findAll(join(root, r), `${r}/`).forEach((f) => {
      throw new Error(`${r}/${f.file}: a systemd gate outside test/: write the gated test in test/`);
    });
    // The built files are what runs: each gate's line is read there, and its names must be the source's.
    for (const f of found) {
      const built = readFileSync(join(root, 'dist', 'test', f.file.replace(/\.ts$/, '.js')), 'utf8');
      f.gates = gatesOf(built).filter((g) => !g.member);
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
  // One run per file; TAP to the log, node's own results on fd 3 (systemd-acceptance-reporter.mjs).
  const runs = [];
  const exits = [];
  {
    for (const f of found) {
      // node's own results arrive on fd 3, a pipe only this process and the runner's reporter hold (R1169g, R1169h).
      const args = [...PRELOAD, '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', ...f.names.map((n) => `--test-name-pattern=^${escapeRe(n)}$`), `dist/test/${f.file.replace(/\.ts$/, '.js')}`];
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
      runs.push({ file: f.file, gates: f.gates, events });
      exits.push(...summaryProblems(r.stdout ?? '', f.file, f.gates.length));
      if (r.status !== 0) exits.push(`test/${f.file}: the test run exited ${r.status ?? r.signal}`);
    }
  }
  const bad = problems(runs);
  if (!bad.length) bad.push(...exits);
  if (bad.length) {
    console.error(`systemd acceptance tests that didn't pass here:\n${bad.map((b) => `  ${b}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`all ${names.length} ran and passed`);
}
