// #727: a raw read of GitHub's checks (Backlog.checks, or the main watch API's checkRuns) outside the places that judge
// them by their pinned source. The judging functions take JudgedChecks, which only src/check-source.ts PinnedChecks.of
// makes, so a raw answer can't reach one and compile. This scan covers everything else: any read of those members,
// however it is spelled (an alias, a destructuring, `?.`, `['checks']`, a bound or unbound reference), found from the
// types with TypeScript's own checker, never from the text. It takes its input as data (source text by file name), so
// its fail-without is a fixture test (#771).
import ts from 'typescript';
import { resolve, relative } from 'node:path';
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
  const out: { file: string; line: number; text: string }[] = [];
  for (const path of byPath.keys()) {
    const sf = program.getSourceFile(path);
    if (!sf) continue;
    const file = relative(root, path).split('\\').join('/');
    const hit = (node: ts.Node) => out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isRaw(node.expression, node.name.text)) hit(node);
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && isRaw(node.expression, node.argumentExpression.text)) hit(node);
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && isRaw(node.parent, key.text)) hit(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
