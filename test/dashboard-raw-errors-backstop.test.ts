// lint-test
// #882, the backstop: no dashboard or hub answer is built from a raw error. A route answers a failure with a fixed
// text (or a userFacing() one, src/user-facing-error.ts) and sends the detail to the server's log on the machine
// (logDetail), because an error's message can name a path under the instance home or quote GitHub's own text.
//
// The lint is an allowlist. In the server's route files (SCANNED), a caught error (a catch clause's binding; the
// parameter of a `.catch(...)` callback, of `.then(...)`'s second one, or of an `'error'` listener added with on, once
// or addListener; a parameter named like one, e, err, error, ex, cause or reason, and typed `unknown`, `any` or a type
// whose name ends in Error or Exception) may appear only as: the left of `instanceof`; the object of a `.code` read (an
// errno word, cast or not); an argument of logDetail or errorAnswer called by that bare name (not a method of it, and
// not refusalText, which shows the message); what `throw` throws, `Promise.reject` rejects, or a `new Promise`
// executor's `reject` rejects; the first argument of a function in the same file, called by its bare name, whose first
// parameter the lint takes for an error (so it scans that function too). Anywhere it is narrowed to one of the engine's own error classes (`if (e instanceof
// AskError)`, `e instanceof AskError ? e.message : ...`, `e instanceof AskError && ...`, or after `if (!(e instanceof
// AskError)) throw e`), whose texts the engine writes, any use is allowed. An engine class is one the file declares or
// imports from src/ (a relative import): not a built-in, not a name bound to one (`const Raw = Error`), not a package's
// (`YAMLParseError`). Everything else is reported: `.message`, `.stack`, `.path`, `.stderr`, `.cause` or any other
// property, `String(e)`, `${e}`, `+ e`, destructuring (`const { message } = e`, `catch ({ message })`), passing it to
// any other function (JSON.stringify, inspect, format, a helper, a local function named reject), putting it in an
// object or array, or assigning it to another name.
// Not caught: a raw text that never was an error binding (a child's stderr, a field of a result); an engine error
// class whose message quotes a raw one (each keeps raw text in `cause`, which refusalText logs, but nothing checks a
// throw's message); an error that reaches a route through a value the lint doesn't know is one (a result's `error`
// field, a rejected promise awaited without a catch binding); a parameter holding an error under another name (`x`,
// `failure`) or typed otherwise (a type alias, an object type, `Record<...>`, a generic `T`); a narrowed branch that
// reads a property of an engine error holding raw text; a module of src/ that exports a built-in class under an engine
// name; a local function shadowing logDetail or errorAnswer, or one the lint scans that hands its error on through
// another name; an errno `.code` put in an answer; and text outside these files.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { repoRoot } from './helpers.js';

/** The files whose answers the lint reads: the dashboard, its console, plugin, chat, value-report and avatar routes, the hub, its setup mode, the App manifest, the webhooks. */
const SCANNED = ['src/dashboard.ts', 'src/dashboard-hub.ts', 'src/hub-setup.ts', 'src/plugins/dashboard.ts', 'src/setup/app-manifest.ts', 'src/chat-routes.ts', 'src/value-report-route.ts', 'src/avatars.ts', 'src/automations/webhook.ts', 'src/automations/webhook-gateway.ts', 'src/governance-webhook.ts'];
const SCANNED_DIRS = ['src/console'];
/** src/setup/app-manifest.ts is the hub's half up to this line; the runner's half after it prints to a terminal. */
const RUNNER_HALF = "// The runner's half.";
const TYPED = new Set([ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.AnyKeyword]);
/** `unknown`, `any`, or a type named like an error (`Error`, `NodeJS.ErrnoException`, `FlowError`), alone or in a union. */
const errorTyped = (t: ts.TypeNode | undefined): boolean => {
  if (!t) return false;
  if (TYPED.has(t.kind)) return true;
  if (ts.isUnionTypeNode(t)) return t.types.some(errorTyped);
  if (!ts.isTypeReferenceNode(t)) return false;
  return /(?:Error|Exception)$/.test(ts.isIdentifier(t.typeName) ? t.typeName.text : t.typeName.right.text);
};
/** A typed parameter is taken for an error by its name: an `unknown` request value under another name is not one. */
const ERROR_NAME = /^(?:e|err|error|ex|cause|reason)$/;

const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
};
const isName = (e: ts.Expression, name: string) => {
  const s = strip(e);
  return ts.isIdentifier(s) && s.text === name;
};

/** `e instanceof C` (C one of the engine's own classes, `engine`), positively, at the top of `cond` or of one of its `&&` sides. */
function narrows(cond: ts.Expression, name: string, engine: ReadonlySet<string>): boolean {
  const c = strip(cond);
  if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return narrows(c.left, name, engine) || narrows(c.right, name, engine);
  return ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && isName(c.left, name) && ts.isIdentifier(strip(c.right)) && engine.has((strip(c.right) as ts.Identifier).text);
}

/** The classes a file declares, and the names it imports from a module of src/ (a relative specifier): the only classes that narrow. */
function engineClasses(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isClassDeclaration(s) && s.name) out.add(s.name.text);
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.moduleSpecifier.text.startsWith('.')) continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamedImports(b)) for (const el of b.elements) if (!el.isTypeOnly) out.add(el.name.text);
  }
  return out;
}

/** `if (!(e instanceof C)) throw ...` or `... return ...`: after it, `e` is a C. */
function guards(s: ts.Statement, name: string, engine: ReadonlySet<string>): boolean {
  if (!ts.isIfStatement(s) || s.elseStatement) return false;
  const c = strip(s.expression);
  if (!ts.isPrefixUnaryExpression(c) || c.operator !== ts.SyntaxKind.ExclamationToken || !narrows(c.operand, name, engine)) return false;
  const t = s.thenStatement;
  const last = ts.isBlock(t) ? t.statements[t.statements.length - 1] : t;
  return !!last && (ts.isThrowStatement(last) || ts.isReturnStatement(last));
}

/** Whether the use at `n` is narrowed to an engine error class on its way up to `scope`. */
function narrowed(n: ts.Node, scope: ts.Node, name: string, engine: ReadonlySet<string>): boolean {
  for (let child = n, p = n.parent; p && child !== scope; child = p, p = p.parent) {
    if (ts.isIfStatement(p) && child === p.thenStatement && narrows(p.expression, name, engine)) return true;
    if (ts.isConditionalExpression(p) && child === p.whenTrue && narrows(p.condition, name, engine)) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === p.right && narrows(p.left, name, engine)) return true;
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      const i = (p.statements as ts.NodeArray<ts.Statement>).indexOf(child as ts.Statement);
      if (p.statements.slice(0, Math.max(i, 0)).some((s) => guards(s, name, engine))) return true;
    }
    if (p === scope) break;
  }
  return false;
}

/**
 * The functions an error binding may be passed to whole, called by their bare name: they log it, or answer with a
 * fixed text. Not refusalText: it shows the message, so it takes only an error narrowed to an engine class.
 */
const SINKS = new Set(['logDetail', 'errorAnswer']);
/**
 * A rejection, which is a throw: `Promise.reject(e)`, or the `reject` a `new Promise((resolve, reject) => ...)`
 * executor binds (a local function of that name is not one).
 */
function rejects(call: ts.CallExpression): boolean {
  const c = strip(call.expression);
  if (ts.isPropertyAccessExpression(c)) return c.name.text === 'reject' && isName(c.expression, 'Promise');
  if (!ts.isIdentifier(c)) return false;
  for (let p: ts.Node | undefined = call.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p)) continue;
    const i = (p as ts.SignatureDeclaration).parameters.findIndex((q) => ts.isIdentifier(q.name) && q.name.text === c.text);
    if (i < 0) continue;
    return i === 1 && !!p.parent && ts.isNewExpression(p.parent) && isName(p.parent.expression, 'Promise');
  }
  return false;
}

/** A use of an error binding the allowlist doesn't take: `what`, or null when it is allowed. */
function disallowed(id: ts.Identifier, scanned: ReadonlySet<string>): string | null {
  let n: ts.Node = id;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isTypeAssertionExpression(n.parent) || ts.isSatisfiesExpression(n.parent))) n = n.parent;
  const p = n.parent;
  if (!p) return null;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.left === n) return null;
  if (ts.isThrowStatement(p)) return null;
  if (ts.isPropertyAccessExpression(p) && p.expression === n) return p.name.text === 'code' ? null : `.${p.name.text}`;
  if (ts.isElementAccessExpression(p) && p.expression === n) return '[...]';
  if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) {
    const callee = strip(p.expression);
    // A bare name only: a method of that name (`h.logDetail(e)`, `ui.reject(e)`) is some other object's.
    const bare = ts.isIdentifier(callee) ? callee.text : null;
    if (rejects(p) || (bare !== null && (SINKS.has(bare) || (scanned.has(bare) && p.arguments[0] === n)))) return null;
    return `passed to ${bare ?? (ts.isPropertyAccessExpression(callee) ? `.${callee.name.text}` : '?')}()`;
  }
  if (ts.isCallExpression(p) && p.expression === n) return '()';
  if (ts.isVariableDeclaration(p) && p.initializer === n) return ts.isIdentifier(p.name) ? `assigned to ${p.name.text}` : 'destructured';
  if (ts.isTemplateSpan(p)) return '`${...}`';
  if (ts.isBinaryExpression(p)) return p.operatorToken.kind === ts.SyntaxKind.PlusToken ? "+ ''" : `in ${ts.tokenToString(p.operatorToken.kind) ?? 'an expression'}`;
  if (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) return 'a value in an object';
  if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) return 'in an array or spread';
  return `in ${ts.SyntaxKind[p.kind]}`;
}

/** Every raw read of a caught error in one file: `line: name.what`. */
export function rawErrorReads(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const engine = engineClasses(sf);
  const scan = (scope: ts.Node, name: string, body: ts.Node) => {
    const visit = (n: ts.Node) => {
      // A nested function that binds the same name again shadows it.
      if (n !== body && ts.isFunctionLike(n) && (n as ts.SignatureDeclaration).parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === name)) return;
      if (ts.isCatchClause(n) && n !== scope && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name) && n.variableDeclaration.name.text === name) return;
      // A property name (`x.e`, `{ e: 1 }`) is not the binding.
      const isRef = ts.isIdentifier(n) && n.text === name && !(n.parent && ((ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) || (ts.isPropertyAssignment(n.parent) && n.parent.name === n)));
      if (isRef && !narrowed(n, scope, name, engine)) {
        const what = disallowed(n as ts.Identifier, scanned);
        if (what) found.push(`${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${name} ${what}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };
  // A function of this file whose first parameter the lint takes for an error is scanned itself: passing one to it is fine.
  const scanned = new Set<string>();
  const firstIsError = (f: ts.SignatureDeclaration) => {
    const q = f.parameters[0];
    const t = q?.type;
    return !!q && ts.isIdentifier(q.name) && ERROR_NAME.test(q.name.text) && errorTyped(t);
  };
  const collect = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && firstIsError(n)) scanned.add(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && firstIsError(n.initializer)) scanned.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const errorCallback = (f: ts.Node): boolean => {
    const call = f.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(f as ts.Expression) || !ts.isPropertyAccessExpression(call.expression)) return false;
    const m = call.expression.name.text;
    if (m === 'catch') return true;
    if (m === 'then') return call.arguments[1] === f;
    const first = call.arguments[0];
    return ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'].includes(m) && !!first && ts.isStringLiteralLike(first) && first.text === 'error';
  };
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      if (ts.isIdentifier(n.variableDeclaration.name)) scan(n, n.variableDeclaration.name.text, n.block);
      else found.push(`${at(n.variableDeclaration)}: catch binding destructured`);
    }
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.body) {
      for (const q of n.parameters) {
        const t = q.type;
        const typed = errorTyped(t);
        if (!(typed && (!ts.isIdentifier(q.name) || ERROR_NAME.test(q.name.text))) && !(errorCallback(n) && q === n.parameters[0])) continue;
        if (ts.isIdentifier(q.name)) scan(n, q.name.text, n.body);
        else found.push(`${at(q)}: error parameter destructured`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(found)];
}

function scannedFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of SCANNED) out.set(f, readFileSync(join(repoRoot, f), 'utf8'));
  for (const d of SCANNED_DIRS) for (const e of readdirSync(join(repoRoot, d))) if (e.endsWith('.ts')) out.set(`${d}/${e}`, readFileSync(join(repoRoot, d, e), 'utf8'));
  const manifest = out.get('src/setup/app-manifest.ts')!;
  const half = manifest.indexOf(`\n${RUNNER_HALF}\n`);
  assert.ok(half > 0, `src/setup/app-manifest.ts keeps its "${RUNNER_HALF}" line, where the lint stops reading it`);
  out.set('src/setup/app-manifest.ts', manifest.slice(0, half));
  return out;
}

/** Bad sources: each reads a caught error as text, so the lint must report it. */
// check-table: never-shrink
const BAD_SOURCES: readonly string[] = [
  'try { f(); } catch (e) { return refused(500, (e as Error).message.split("\\n")[0] ?? "failed"); }',
  'try { f(); } catch (e) { json(res, 500, { error: String(e) }); }',
  'try { f(); } catch (err) { json(res, 500, { error: `failed: ${err}` }); }',
  'try { f(); } catch (e) { json(res, 500, { error: "failed: " + e }); }',
  'try { f(); } catch (e) { const why = (e as NodeJS.ErrnoException).stack; json(res, 500, { why }); }',
  "try { f(); } catch (e) { json(res, 500, { error: (e as Error)['message'] }); }",
  'p.catch((e: Error) => ({ ok: false, detail: e.message }));',
  "up.on('error', (e) => json(res, 502, { error: e.message }));",
  'const answer = (e: unknown) => json(res, 500, { error: String((e as Error).message) });',
  // Narrowed the wrong way round, or to a built-in class: says nothing about who wrote it.
  'try { f(); } catch (e) { if (!(e instanceof AskError)) json(res, 500, { error: (e as Error).message }); }',
  'try { f(); } catch (e) { if (e instanceof Error) json(res, 500, { error: e.message }); }',
  'try { f(); } catch (e) { json(res, 500, { error: e instanceof AskError ? "x" : (e as Error).message }); }',
  // #882 round 2, the wrong fixes a review found passing: destructured, or another property than the message.
  "try { f(); } catch (e) { const { message } = e as Error; return refused(404, `can't read ${(e as NodeJS.ErrnoException).path}: ${message}`); }",
  'try { f(); } catch ({ message }) { json(res, 500, { error: message }); }',
  'p.catch(({ message }: Error) => json(res, 500, { error: message }));',
  'try { f(); } catch (e) { const { stderr } = e as { stderr: string }; json(res, 500, { error: stderr }); }',
  'try { f(); } catch (e) { json(res, 500, { error: (e as { stderr: string }).stderr }); }',
  'try { f(); } catch (e) { json(res, 500, { error: (e as Error).cause }); }',
  'try { f(); } catch (e) { json(res, 500, { error: JSON.stringify(e) }); }',
  'try { f(); } catch (e) { json(res, 500, { error: inspect(e) }); }',
  'try { f(); } catch (e) { json(res, 500, { error: format("%s", e) }); }',
  'try { f(); } catch (e) { json(res, 500, { error: e }); }',
  'try { f(); } catch (e) { json(res, 500, { e }); }',
  'try { f(); } catch (e) { const x = e as Error; json(res, 500, { error: x.message }); }',
  // A helper that isn't scanned as taking an error.
  'const show = (x: string) => x;\ntry { f(); } catch (e) { json(res, 500, { error: show(e as string) }); }',
  // #882 round 3: a class that isn't the engine's (a built-in under another name, a package's), and other error callbacks.
  'const Raw = Error;\ntry { f(); } catch (e) { if (e instanceof Raw) return refused(404, e.message); }',
  "import { YAMLParseError } from 'yaml';\ntry { f(); } catch (e) { if (e instanceof YAMLParseError) return refused(400, e.message); }",
  'p.then((v) => v, (e) => json(res, 500, { error: e.message }));',
  "up.addListener('error', (e) => json(res, 502, { error: e.message }));",
  'const reject = (x: unknown) => json(res, 500, { error: x });\ntry { f(); } catch (e) { reject(e); }',
  // #882 round 4 (R11d): a parameter typed as an error class by name, and a sink's name called as a method.
  'const show = (e: NodeJS.ErrnoException) => json(res, 500, { error: e.message });',
  'function show(err: FlowError | null) { return json(res, 400, { error: err?.message }); }',
  'try { f(); } catch (e) { ui.reject(e); }',
  'try { f(); } catch (e) { h.logDetail(e); }',
  'try { f(); } catch (e) { this.errorAnswer(e); }',
  "try { f(); } catch (e) { return refused(400, refusalText('x', e as Error)); }",
];
/** Good sources: none reads a raw error as text. */
// check-table: never-grow
const GOOD_SOURCES: readonly string[] = [
  'try { f(); } catch (e) { if (e instanceof AskError) return json(res, e.status, { error: e.message }); logDetail("x", e); return json(res, 500, { error: "fixed" }); }',
  'try { f(); } catch (e) { send(res, 500, { error: e instanceof AskError ? e.message : "fixed" }); }',
  'const consoleError = (e: unknown) => { if (!(e instanceof ConsoleError)) throw e; return json(res, 400, { error: e.message }); };',
  'try { f(); } catch (e) { throw e; }',
  'try { f(); } catch (e) { const code = (e as NodeJS.ErrnoException).code; json(res, 500, { error: `failed (${code})` }); }',
  'try { f(); } catch (e) { r.errors.map((e) => e.message); }',
  'try { f(); } catch (e) { if (e instanceof SettingsError) { audit({ why: e.message }); return json(res, 400, { error: e.message }); } throw e; }',
  'try { f(); } catch (e) { const a = errorAnswer(e, req, url.pathname); json(res, a.status, a.body); }',
  "up.on('error', (e: NodeJS.ErrnoException) => done({ up: false, error: `not answering (${e.code ?? 'error'})` }));",
  'const check = (value: unknown) => typeof value === "string" ? value : String(value);',
  'const consoleError = (e: unknown) => { if (!(e instanceof ConsoleError)) throw e; return json(res, 400, { error: e.message }); };\ntry { f(); } catch (e) { return consoleError(e); }',
  'try { f(); } catch (e) { return Promise.reject(e); }',
  'new Promise((resolve, reject) => { f().catch((e) => reject(e)); });',
  'class FlowError extends Error {}\ntry { f(); } catch (e) { if (e instanceof FlowError) json(res, 400, { error: e.message }); }',
];

/** The engine classes the fixtures narrow to, imported as a route file imports them. */
const FIXTURE_IMPORTS = "import { AskError, ConsoleError, SettingsError } from './errors.js';\n";

test('#882 backstop lint: it reports each bad source and no good one', () => {
  assert.deepEqual(BAD_SOURCES.filter((s) => rawErrorReads('fixture.ts', FIXTURE_IMPORTS + s).length === 0), [], 'a bad source the lint misses');
  assert.deepEqual(GOOD_SOURCES.flatMap((s) => rawErrorReads('fixture.ts', FIXTURE_IMPORTS + s).map((x) => `${s} -> ${x}`)), [], 'a good source the lint reports');
});

test('#882 backstop: no dashboard, console, plugins, hub or App-manifest route reads a caught error as text (e.message, String(e), ${e}); only engine error classes are shown', () => {
  const files = scannedFiles();
  assert.ok(files.size >= SCANNED.length + 5, `${files.size} files read`);
  const found = [...files].flatMap(([f, text]) => rawErrorReads(f, text).map((x) => `${f}:${x}`));
  assert.deepEqual(found, [], "answer with a fixed text (or userFacing()) and send the error to logDetail (src/user-facing-error.ts)");
});
