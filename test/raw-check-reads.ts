// #727: a raw read of GitHub's checks (Backlog.checks, or the main watch API's checkRuns) outside the places that judge
// them by their pinned source. The judging functions take JudgedChecks, which only src/check-source.ts PinnedChecks.of
// makes, so a raw answer can't reach one and compile. This scan covers everything else: any read of those members,
// however it is spelled (an alias, a destructuring, `?.`, `['checks']`, a bound or unbound reference), found from the
// types with TypeScript's own checker, never from the text. It takes its input as data (source text by file name), so
// its fail-without is a fixture test (#771).
import ts from 'typescript';
import { dirname, resolve, relative, sep } from 'node:path';
import { repoRoot } from './helpers.js';

/** The members whose read is GitHub's raw checks, by the type that declares them. */
const RAW: { file: string; owner: string; member: string }[] = [
  { file: 'src/backlog/types.ts', owner: 'Backlog', member: 'checks' },
  { file: 'src/backlog/github.ts', owner: 'GitHubBacklog', member: 'checks' },
  { file: 'src/backlog/file.ts', owner: 'FileBacklog', member: 'checks' },
  { file: 'src/main-watch.ts', owner: 'MainWatchApi', member: 'checkRuns' },
  { file: 'src/github/main-watch-api.ts', owner: 'GitHubMainWatchApi', member: 'checkRuns' },
];
const MEMBERS = new Set(RAW.map((r) => r.member));

/** The files in src/ that may read GitHub's checks raw, and why. */
export const RAW_READS_ALLOWED: Record<string, string> = {
  'src/check-source.ts': 'PinnedChecks.of: the one place that turns them into JudgedChecks',
  'src/main-watch.ts': 'the main watch reads the runs at a merge and judges them by their pins itself (judge)',
  'src/canary.ts':
    "the canary's pass keeps an install (the updater rolls back on its fail), but it requires the PR merged by the canary instance, whose own merge judged the required checks by their pins, and every check on the head green, so a spoofed check can only turn a pass into a fail, never add a pass the merge didn't have",
};

const OPTIONS: ts.CompilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, types: ['node'] };

/** The type errors TypeScript reports in `files` (source text by path from the repo root), as `file:line: message`. */
export function typeErrors(files: Record<string, string>, root = repoRoot): string[] {
  const { program } = programOf(files, root);
  const paths = new Set(Object.keys(files).map((p) => resolve(root, p)));
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && paths.has(resolve(d.file.fileName)))
    .map((d) => `${relative(root, d.file!.fileName)}:${d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

function programOf(files: Record<string, string>, root: string) {
  const byPath = new Map(Object.entries(files).map(([p, text]) => [resolve(root, p), text]));
  const host = ts.createCompilerHost(OPTIONS, true);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const source = host.getSourceFile.bind(host);
  host.readFile = (f) => byPath.get(resolve(f)) ?? read(f);
  host.fileExists = (f) => byPath.has(resolve(f)) || exists(f);
  host.getSourceFile = (f, lang, onError, create) => {
    const text = byPath.get(resolve(f));
    return text !== undefined ? ts.createSourceFile(f, text, lang, true) : source(f, lang, onError, create);
  };
  return { byPath, program: ts.createProgram([...byPath.keys()], OPTIONS, host) };
}

/**
 * Each raw read in `files` (source text by path from the repo root; other imports are read from the repo): its file,
 * its line, and the expression.
 */
export function rawCheckReads(files: Record<string, string>, root = repoRoot): { file: string; line: number; text: string }[] {
  const { byPath, program } = programOf(files, root);
  const checker = program.getTypeChecker();
  const isRaw = (receiver: ts.Node, member: string): boolean => {
    if (!MEMBERS.has(member)) return false;
    const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
    const prop = checker.getPropertyOfType(type, member) ?? type.getProperty(member);
    return (prop?.declarations ?? []).some((d) => {
      const owner = d.parent;
      const name = owner && (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) ? owner.name?.text : undefined;
      const file = relative(root, d.getSourceFile().fileName).split('\\').join('/');
      return RAW.some((r) => r.member === member && r.owner === name && r.file === file);
    });
  };
  // A key known only from its type: `const k = 'checks' as const; backlog[k]`.
  const literal = (e: ts.Expression): string | null => {
    if (ts.isStringLiteralLike(e)) return e.text;
    const t = checker.getTypeAtLocation(e);
    return t.isStringLiteral() ? t.value : null;
  };
  // A target type that hides a raw member of the value put into it: `any` or `unknown` (nothing to trace through), an
  // object type with no members at all ({}, object), or a type that has the member under its own declaration (a
  // structural alias). A type that drops the member (Pick<Backlog, 'comment'>) hides nothing: it can't be read through.
  const opaque = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (!!(t.flags & ts.TypeFlags.Object || t.flags & ts.TypeFlags.NonPrimitive) && checker.getPropertiesOfType(t).length === 0 && !checker.getIndexInfosOfType(t).length && !checker.getSignaturesOfType(t, ts.SignatureKind.Call).length) || (!!(t.flags & ts.TypeFlags.Object) && checker.getIndexInfosOfType(t).length > 0 && checker.getPropertiesOfType(t).length === 0);
  const hidesRaw = (to: ts.Type | undefined, from: ts.Node): boolean => {
    if (!to) return false;
    const t = checker.getNonNullableType(to);
    return [...MEMBERS].some((m) => isRaw(from, m) && (opaque(t) || (!!checker.getPropertyOfType(t, m) && !rawProp(t, m))));
  };
  const rawProp = (type: ts.Type, member: string): boolean =>
    (checker.getPropertyOfType(type, member)?.declarations ?? []).some((d) => {
      const owner = d.parent;
      const name = owner && (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) ? owner.name?.text : undefined;
      return RAW.some((r) => r.member === member && r.owner === name && r.file === relative(root, d.getSourceFile().fileName).split('\\').join('/'));
    });
  const out: { file: string; line: number; text: string }[] = [];
  for (const path of byPath.keys()) {
    const sf = program.getSourceFile(path);
    if (!sf) continue;
    const file = relative(root, path).split('\\').join('/');
    const hit = (node: ts.Node) => out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isRaw(node.expression, node.name.text)) hit(node);
      else if (ts.isElementAccessExpression(node) && literal(node.argumentExpression) !== null && isRaw(node.expression, literal(node.argumentExpression)!)) hit(node);
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && isRaw(node.parent, key.text)) hit(node);
      } else if (ts.isCallExpression(node) && node.expression.getText(sf).replace(/\s+/g, '') === 'Reflect.get' && node.arguments.length >= 2 && literal(node.arguments[1]!) !== null && isRaw(node.arguments[0]!, literal(node.arguments[1]!)!)) hit(node);
      else if (ts.isVariableDeclaration(node) && node.type && node.initializer && hidesRaw(checker.getTypeFromTypeNode(node.type), node.initializer)) hit(node);
      else if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && hidesRaw(checker.getTypeFromTypeNode(node.type), node.expression)) hit(node);
      else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (node.arguments ?? []).some((a) => hidesRaw(checker.getContextualType(a), a))) hit(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** The files in src/ that may assert a type into JudgedChecks: only the one that makes them. */
export const JUDGED_CASTS_ALLOWED: Record<string, string> = { 'src/check-source.ts': 'PinnedChecks.of and withTestRuns make JudgedChecks: the brand is theirs to give' };

/**
 * Each way in `files` around the JudgedChecks brand: a type assertion whose target or expected type is JudgedChecks
 * (`x as JudgedChecks`, `x as never`, `x as unknown as JudgedChecks`); any value typed `any` or `never` where
 * JudgedChecks is expected (`JSON.parse` data, `(b as any).checks(…)`, a `const raw = … as never`); a call of a
 * generic whose return type is a type parameter where JudgedChecks is expected (`id<JudgedChecks>(x)`); and a type
 * predicate or type argument that names JudgedChecks.
 */
export function judgedCasts(files: Record<string, string>, root = repoRoot): { file: string; line: number; text: string }[] {
  const { byPath, program } = programOf(files, root);
  const checker = program.getTypeChecker();
  const judged = (t: ts.Type | undefined, depth = 3): boolean => {
    if (!t || depth < 0) return false;
    if (checker.getPropertiesOfType(t).some((p) => String(p.escapedName).startsWith('__@JUDGED'))) return true;
    if (t.isUnionOrIntersection() && t.types.some((x) => judged(x, depth - 1))) return true;
    const args = (t as ts.TypeReference).target ? checker.getTypeArguments(t as ts.TypeReference) : [];
    return args.some((x) => judged(x, depth - 1));
  };
  const out: { file: string; line: number; text: string }[] = [];
  for (const path of byPath.keys()) {
    const sf = program.getSourceFile(path);
    if (!sf) continue;
    const file = relative(root, path).split('\\').join('/');
    const hit = (node: ts.Node) => out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
    const loose = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never));
    const genericReturn = (call: ts.CallExpression) => {
      const decl = checker.getResolvedSignature(call)?.getDeclaration();
      return !!decl && !!decl.type && !!(checker.getTypeFromTypeNode(decl.type).flags & ts.TypeFlags.TypeParameter);
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && (judged(checker.getTypeFromTypeNode(node.type)) || judged(checker.getContextualType(node)))) hit(node);
      else if (ts.isTypePredicateNode(node) && node.type && judged(checker.getTypeFromTypeNode(node.type))) hit(node);
      else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (node.typeArguments ?? []).some((a) => judged(checker.getTypeFromTypeNode(a)))) hit(node);
      else if (ts.isExpression(node) && !ts.isParenthesizedExpression(node) && judged(checker.getContextualType(node))) {
        if (loose(checker.getTypeAtLocation(node)) || (ts.isCallExpression(node) && genericReturn(node))) hit(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * The JudgedChecks makers and the only src/ files that may use them (besides check-source.ts itself): a caller
 * elsewhere could brand data from anywhere (withTestRuns' `local`, or a PinnedChecks over a stand-in backlog).
 */
export const MAKERS_ALLOWED: Record<string, string[]> = {
  withTestRuns: ['src/ci-none.ts'],
  PinnedChecks: ['src/coordinator/merge-flow.ts'],
};

/** Each reference in `files` to a JudgedChecks maker (withTestRuns, PinnedChecks; aliases and re-exports too) outside the files MAKERS_ALLOWED names. */
export function makerUses(files: Record<string, string>, root = repoRoot): { file: string; line: number; maker: string }[] {
  const { byPath, program } = programOf(files, root);
  const checker = program.getTypeChecker();
  const out: { file: string; line: number; maker: string }[] = [];
  for (const path of byPath.keys()) {
    const sf = program.getSourceFile(path);
    if (!sf) continue;
    const file = relative(root, path).split('\\').join('/');
    if (file === 'src/check-source.ts') continue;
    const visit = (node: ts.Node): void => {
      // A namespace import or a dynamic import of check-source.ts reaches the makers by a string key (`cs['withTestRuns']`), which no identifier names.
      const spec = ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings) ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (spec && (!ts.isStringLiteralLike(spec) || /(^|\/)check-source(\.js)?$/.test(spec.text))) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, maker: '* (namespace or dynamic import)' });
      }
      if (ts.isIdentifier(node)) {
        let sym = checker.getSymbolAtLocation(node);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const decl = sym?.declarations?.[0];
        const from = decl ? relative(root, decl.getSourceFile().fileName).split('\\').join('/') : '';
        const maker = sym?.name;
        if (from === 'src/check-source.ts' && maker && Object.hasOwn(MAKERS_ALLOWED, maker) && !MAKERS_ALLOWED[maker]!.includes(file)) {
          out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, maker });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** Each import in `files` (static, re-export or dynamic) of a module under test/: src/ never ships with test/. */
export function testImports(files: Record<string, string>, root = repoRoot): { file: string; spec: string }[] {
  const testDir = resolve(root, 'test');
  const out: { file: string; spec: string }[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const abs = resolve(root, rel);
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2023, true);
    const check = (spec: string) => {
      if (spec.startsWith('.') && (resolve(dirname(abs), spec) + sep).startsWith(testDir + sep)) out.push({ file: rel, spec });
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) check(node.moduleSpecifier.text);
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) check(node.arguments[0].text);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) check(node.moduleReference.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
