// lint-test
// #882, the backstop: no dashboard or hub answer is built from a raw error. A route answers a failure with a fixed
// text (or a userFacing() one, src/user-facing-error.ts) and sends the detail to the server's log on the machine
// (logDetail), because an error's message can name a path under the instance home or quote GitHub's own text.
//
// The lint: in the server's route files (SCANNED), every caught error (a catch clause's binding, a `.catch(...)` or
// `.on('error', ...)` callback's parameter, a parameter typed `unknown`, `any` or `Error`) is never read as text:
// not `.message`, `.stack` or `.toString()`, not `String(e)`, not `${e}`, not `'...' + e`, cast or not. A read is
// allowed only where the error is narrowed to one of the engine's own error classes (`if (e instanceof AskError)`,
// `e instanceof AskError ? e.message : ...`, `e instanceof AskError && ...`, or after `if (!(e instanceof AskError))
// throw e`), whose texts the engine writes. Passing the error whole (to logDetail, errorAnswer or `throw`) is fine.
// Not caught: a raw text that never was an error binding (a child's stderr, a field of a result), an engine error
// class whose text quotes a raw one, a binding renamed through another variable, and text outside these files.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { repoRoot } from './helpers.js';

/** The files whose answers the lint reads: the dashboard, its console and plugin routes, the hub, the App manifest. */
const SCANNED = ['src/dashboard.ts', 'src/dashboard-hub.ts', 'src/plugins/dashboard.ts', 'src/setup/app-manifest.ts'];
const SCANNED_DIRS = ['src/console'];
/** src/setup/app-manifest.ts is the hub's half up to this line; the runner's half after it prints to a terminal. */
const RUNNER_HALF = "// The runner's half.";
/** Narrowing to one of these says nothing about who wrote the text. */
const BUILTIN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'Object']);
const TYPED = new Set([ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.AnyKeyword]);

const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
};
const isName = (e: ts.Expression, name: string) => {
  const s = strip(e);
  return ts.isIdentifier(s) && s.text === name;
};

/** `e instanceof C` (C one of the engine's own classes), positively, at the top of `cond` or of one of its `&&` sides. */
function narrows(cond: ts.Expression, name: string): boolean {
  const c = strip(cond);
  if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return narrows(c.left, name) || narrows(c.right, name);
  return ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && isName(c.left, name) && ts.isIdentifier(strip(c.right)) && !BUILTIN_ERRORS.has((strip(c.right) as ts.Identifier).text);
}

/** `if (!(e instanceof C)) throw ...` or `... return ...`: after it, `e` is a C. */
function guards(s: ts.Statement, name: string): boolean {
  if (!ts.isIfStatement(s) || s.elseStatement) return false;
  const c = strip(s.expression);
  if (!ts.isPrefixUnaryExpression(c) || c.operator !== ts.SyntaxKind.ExclamationToken || !narrows(c.operand, name)) return false;
  const t = s.thenStatement;
  const last = ts.isBlock(t) ? t.statements[t.statements.length - 1] : t;
  return !!last && (ts.isThrowStatement(last) || ts.isReturnStatement(last));
}

/** Whether the use at `n` is narrowed to an engine error class on its way up to `scope`. */
function narrowed(n: ts.Node, scope: ts.Node, name: string): boolean {
  for (let child = n, p = n.parent; p && child !== scope; child = p, p = p.parent) {
    if (ts.isIfStatement(p) && child === p.thenStatement && narrows(p.expression, name)) return true;
    if (ts.isConditionalExpression(p) && child === p.whenTrue && narrows(p.condition, name)) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === p.right && narrows(p.left, name)) return true;
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      const i = (p.statements as ts.NodeArray<ts.Statement>).indexOf(child as ts.Statement);
      if (p.statements.slice(0, Math.max(i, 0)).some((s) => guards(s, name))) return true;
    }
    if (p === scope) break;
  }
  return false;
}

/** A use of `name` that reads the error as text: `line: what`, or null. */
function readsText(id: ts.Identifier): string | null {
  let n: ts.Node = id;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isTypeAssertionExpression(n.parent) || ts.isSatisfiesExpression(n.parent))) n = n.parent;
  const p = n.parent;
  if (!p) return null;
  if ((ts.isPropertyAccessExpression(p) && p.expression === n) || (ts.isElementAccessExpression(p) && p.expression === n)) {
    const prop = ts.isPropertyAccessExpression(p) ? p.name.text : ts.isStringLiteralLike(p.argumentExpression) ? p.argumentExpression.text : '[...]';
    return ['message', 'stack', 'toString', '[...]'].includes(prop) ? `.${prop}` : null;
  }
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'String' && p.arguments.includes(n as ts.Expression)) return 'String(...)';
  if (ts.isTemplateSpan(p) && p.expression === n) return '`${...}`';
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return "+ ''";
  return null;
}

/** Every raw read of a caught error in one file: `line: name.what`. */
export function rawErrorReads(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const scan = (scope: ts.Node, name: string, body: ts.Node) => {
    const visit = (n: ts.Node) => {
      // A nested function that binds the same name again shadows it.
      if (n !== body && ts.isFunctionLike(n) && (n as ts.SignatureDeclaration).parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === name)) return;
      if (ts.isCatchClause(n) && n !== scope && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name) && n.variableDeclaration.name.text === name) return;
      if (ts.isIdentifier(n) && n.text === name) {
        const what = readsText(n);
        if (what && !narrowed(n, scope, name)) found.push(`${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${name}${what}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };
  const errorCallback = (f: ts.Node): boolean => {
    const call = f.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(f as ts.Expression) || !ts.isPropertyAccessExpression(call.expression)) return false;
    const m = call.expression.name.text;
    if (m === 'catch') return true;
    const first = call.arguments[0];
    return (m === 'on' || m === 'once') && !!first && ts.isStringLiteralLike(first) && first.text === 'error';
  };
  const visit = (n: ts.Node) => {
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) scan(n, n.variableDeclaration.name.text, n.block);
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.body) {
      for (const q of n.parameters) {
        if (!ts.isIdentifier(q.name)) continue;
        const t = q.type;
        const typed = !!t && (TYPED.has(t.kind) || (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === 'Error'));
        if (typed || (errorCallback(n) && q === n.parameters[0])) scan(n, q.name.text, n.body);
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
];

test('#882 backstop lint: it reports each bad source and no good one', () => {
  assert.deepEqual(BAD_SOURCES.filter((s) => rawErrorReads('fixture.ts', s).length === 0), [], 'a bad source the lint misses');
  assert.deepEqual(GOOD_SOURCES.flatMap((s) => rawErrorReads('fixture.ts', s).map((x) => `${s} -> ${x}`)), [], 'a good source the lint reports');
});

test('#882 backstop: no dashboard, console, plugins, hub or App-manifest route reads a caught error as text (e.message, String(e), ${e}); only engine error classes are shown', () => {
  const files = scannedFiles();
  assert.ok(files.size >= SCANNED.length + 5, `${files.size} files read`);
  const found = [...files].flatMap(([f, text]) => rawErrorReads(f, text).map((x) => `${f}:${x}`));
  assert.deepEqual(found, [], "answer with a fixed text (or userFacing()) and send the error to logDetail (src/user-facing-error.ts)");
});
