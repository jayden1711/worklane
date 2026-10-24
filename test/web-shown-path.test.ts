// Backstop (#768): no page shows a changed path as it is. Every field web/src/api.ts types as ChangedPath (a path
// in the project's repository, raw as the engine read it) reaches a page only through shownPath or shownPaths
// (web/src/path-text.ts), so a bidi override or a zero-width character in a name can't reorder or hide the text
// around it. test/web-render.test.ts renders each place with such a name; this test fails when a new one reads a
// path field another way.
//
// Read with the type checker over web/ (web/tsconfig.json), so a field is found by its declared type, not by its
// name. A path value is a read of a ChangedPath field, a name destructured from one, or the parameter of a `.map`
// over one; each use of it must be one of:
//   - an argument of shownPath or shownPaths, or `.map(shownPath)`;
//   - `.length`, a comparison, `!`, the left of `&&`, or a condition;
//   - a JSX `key`, or a JSX prop itself typed ChangedPath (FileChip's `file`), whose component is checked the same way;
//   - a destructuring, or the parameter of a `.map` callback, whose name is then checked the same way.
// Anything else (a `.join`, a template, an index, a JSX child, a prop typed string) is a finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { repoRoot } from './helpers.js';

const WEB = join(repoRoot, 'web');
const PROBE = join(WEB, 'src', '__shown-path-probe__.tsx');
/** A page that shows paths raw three ways (an index, a join, a JSX child) and safely three ways: the scan must find the three. */
const PROBE_TEXT = `import type { DecisionDetail } from './api';
import { shownPath } from './path-text';
export const Probe = ({ d }: { d: DecisionDetail }) => (
  <p title={d.verdict!.unread[0]}>
    {d.verdict!.unread.join(', ')}
    {d.verdict!.unread.map(shownPath)}
    {d.change!.files.map((f) => <span key={f.path}>{f.path}{shownPath(f.path)}</span>)}
  </p>
);
`;

type Finding = { file: string; line: number; what: string };

function program(): ts.Program {
  const c = ts.getParsedCommandLineOfConfigFile(join(WEB, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
  assert.ok(c, 'web/tsconfig.json');
  const host = ts.createCompilerHost(c.options, true);
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => (f === PROBE ? ts.createSourceFile(f, PROBE_TEXT, lang, true, ts.ScriptKind.TSX) : get(f, lang, onError, create));
  host.fileExists = (f) => f === PROBE || ts.sys.fileExists(f);
  host.readFile = (f) => (f === PROBE ? PROBE_TEXT : ts.sys.readFile(f));
  return ts.createProgram({ rootNames: [...c.fileNames, PROBE], options: c.options, host });
}

/** Every path value in web/src and every use of one that isn't safe; `checked` counts the uses read. */
function scan(p: ts.Program): { findings: Finding[]; checked: number; fields: number } {
  const checker = p.getTypeChecker();
  const findings: Finding[] = [];
  let checked = 0;
  const fields = new Set<ts.Node>();
  /** `ChangedPath` or `ChangedPath[]`, optionally `| null` or `| undefined`: not a type that merely holds one. */
  const isPathType = (t: ts.TypeNode): boolean => {
    if (ts.isUnionTypeNode(t)) {
      const rest = t.types.filter((x) => !(ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword) && x.kind !== ts.SyntaxKind.UndefinedKeyword);
      return rest.length === 1 && isPathType(rest[0]!);
    }
    if (ts.isArrayTypeNode(t)) return isPathType(t.elementType);
    return ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === 'ChangedPath';
  };
  const isPathField = (sym: ts.Symbol | undefined): boolean =>
    !!sym?.declarations?.some((d) => {
      const ok = (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && !!d.type && isPathType(d.type);
      if (ok) fields.add(d);
      return ok;
    });
  const sources = p.getSourceFiles().filter((s) => !s.isDeclarationFile && s.fileName.startsWith(join(WEB, 'src') + sep));

  /** Every use of the name a declaration binds, in its file. */
  const usesOf = (name: ts.Identifier, sf: ts.SourceFile) => {
    const sym = checker.getSymbolAtLocation(name);
    if (!sym) return;
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n !== name && checker.getSymbolAtLocation(n) === sym) use(n, sf);
      ts.forEachChild(n, walk);
    };
    walk(sf);
  };
  /** A name bound to a path: each of its uses checked; a pattern (a path is a string) is a finding. */
  const bound = (b: ts.BindingName, sf: ts.SourceFile, at: ts.Node) => {
    if (ts.isIdentifier(b)) usesOf(b, sf);
    else report(at, sf);
  };
  const report = (n: ts.Node, sf: ts.SourceFile) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    findings.push({ file: relative(repoRoot, sf.fileName).split(sep).join('/'), line: line + 1, what: n.parent.getText(sf).slice(0, 160) });
  };
  const SAFE_CALLS = new Set(['shownPath', 'shownPaths']);
  const COMPARE = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
  /** One use of a path value: safe, a name to follow, or a finding. */
  function use(e: ts.Node, sf: ts.SourceFile): void {
    checked++;
    let n: ts.Node = e;
    while (ts.isNonNullExpression(n.parent) || ts.isParenthesizedExpression(n.parent)) n = n.parent;
    const at = n.parent;
    if (ts.isCallExpression(at) && at.arguments.includes(n as ts.Expression) && ts.isIdentifier(at.expression) && SAFE_CALLS.has(at.expression.text)) return;
    if (ts.isPropertyAccessExpression(at) && at.expression === n) {
      if (at.name.text === 'length') return;
      if (at.name.text === 'map' && ts.isCallExpression(at.parent) && at.parent.expression === at) {
        const cb = at.parent.arguments[0];
        if (cb && ts.isIdentifier(cb) && cb.text === 'shownPath') return;
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) return bound(cb.parameters[0].name, sf, cb);
      }
      return report(n, sf);
    }
    if (ts.isJsxExpression(at) && ts.isJsxAttribute(at.parent)) {
      const attr = at.parent;
      const name = attr.name.getText(sf);
      if (name === 'key') return;
      if (isPathField(checker.getContextualType(attr.parent)?.getProperty(name))) return;
      return report(n, sf);
    }
    if (ts.isBinaryExpression(at) && (COMPARE.has(at.operatorToken.kind) || (at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && at.left === n))) return;
    if (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.ExclamationToken) return;
    if ((ts.isConditionalExpression(at) && at.condition === n) || (ts.isIfStatement(at) && at.expression === n)) return;
    if (ts.isVariableDeclaration(at) && at.initializer === n) return bound(at.name, sf, at);
    report(n, sf);
  }

  for (const sf of sources) {
    const walk = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && isPathField(checker.getSymbolAtLocation(n.name))) use(n, sf);
      else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
        const key = n.propertyName ?? n.name;
        const prop = ts.isIdentifier(key) ? checker.getTypeAtLocation(n.parent).getProperty(key.text) : undefined;
        if (isPathField(prop)) {
          checked++;
          bound(n.name, sf, n);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return { findings, checked, fields: fields.size };
}

test('backstop: every changed path a web page shows goes through shownPath (web/src/path-text.ts)', () => {
  const { findings, checked, fields } = scan(program());
  const probe = findings.filter((f) => f.file === 'web/src/__shown-path-probe__.tsx');
  const pages = findings.filter((f) => !probe.includes(f));
  assert.equal(probe.length, 3, `the scan finds the probe's three raw paths (an index, a join, a JSX child), and only those:\n${probe.map((f) => `${f.line}: ${f.what}`).join('\n')}`);
  assert.deepEqual(pages.map((f) => `${f.file}:${f.line}: ${f.what}`), [], 'a page shows a changed path without shownPath: show it through shownPath, shownPaths or FileChip');
  // Not vacuous: the fields are found by their declared type, and the pages read them.
  assert.ok(fields >= 10, `ChangedPath fields found: ${fields}`);
  assert.ok(checked >= 30, `path uses read: ${checked}`);
});

test('the web display helper is the engine\'s own shownPath (imported, not a copy)', () => {
  const src = ts.sys.readFile(join(WEB, 'src', 'path-text.ts')) ?? '';
  assert.match(src, /^export \{ shownPath, shownPaths \} from '\.\.\/\.\.\/src\/path-text';$/m);
});
