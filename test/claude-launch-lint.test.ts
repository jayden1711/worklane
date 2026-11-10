// lint-test
// One launch for every Claude Code session the engine starts (#958, the owner's decision, 2026-11-09): src/
// claude-launch.ts's launchClaude, which always loads no setting source, reads no MCP config but its own, takes its
// settings only from --settings and keeps the auto memory off. This holds src/ to it: no other module starts the
// claude binary, or Claude Code's cli.js under node, and the runner's `bin` reaches nothing but launchClaude.
//
// What it reads (typescript's parser, every .ts file under src/): a call of spawn, spawnSync, exec, execSync,
// execFile, execFileSync or fork, by any name bound to node:child_process, child_process or src/os/child-process.ts
// (named, renamed, a namespace or default import, a require()); flagged when any string, template or regex in its
// arguments (an argv array's, a `sh -c` command's, a `sudo`/`env` wrapper's included), or the initializer of a const
// its command names, is `claude`, ends in `/claude`, runs `claude ...`, or names @anthropic-ai/claude-code or its
// cli.js (`process.execPath` with that path). And `this.bin` (the runner's binary) anywhere but `bin: this.bin` in a
// launchClaude call, or the three auth-status helpers' binary argument.
//
// Named exceptions, each pinned by file and argv: claude-signin.ts's `claude auth login` and `auth status --json`,
// and doctor.ts's `claude --version`: none starts a session.
//
// What it can't see (named limits, as #1228's are): a binary path built at run time from data with no `claude` in it
// (a config value, an env variable: `spawn(cfg.agentBin)`); a launch through a module outside src/ (scripts/, a
// package); a child process that itself runs claude (a hook, a project command: the sandbox's job, not this lint's);
// a call through `Function`, `eval`, `vm` or worker_threads; and a binary the runner holds under another name than
// `bin` (the check on `this.bin` is by name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { repoRoot } from './helpers.js';

type Node = { kind: number; text?: string; parent?: Node; name?: Node; expression?: Node; arguments?: Node[]; initializer?: Node; elements?: Node[]; propertyName?: Node; moduleSpecifier?: Node; importClause?: Node & { name?: Node; namedBindings?: Node }; getText: () => string; getStart: () => number };
const ts = createRequire(join(repoRoot, 'package.json'))('typescript') as Record<string, (...a: unknown[]) => unknown> & { ScriptTarget: { Latest: number }; createSourceFile: (f: string, t: string, v: number, p: boolean) => Node & { getLineAndCharacterOfPosition: (p: number) => { line: number } } };
const is = (k: string, n: Node | undefined): boolean => !!n && (ts[`is${k}`] as (n: Node) => boolean)(n);
const each = (n: Node, f: (c: Node) => void) => (ts.forEachChild as (n: Node, f: (c: Node) => void) => void)(n, f);

const SPAWNERS = /^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/;
const MODULES = (spec: string, path: string) => spec === 'node:child_process' || spec === 'child_process' || (/(?:^|\/)os\/child-process\.js$/.test(spec) || (path.startsWith('src/os/') && spec === './child-process.js'));
/** A text that names the claude binary or Claude Code's cli.js. */
const CLAUDE = /^claude$|\/claude$|(?:^|[\s;&|(])claude(?:\s|$)|@anthropic-ai\/claude-code|claude-code\/cli\.js/;
const LAUNCHER = 'src/claude-launch.ts';
/** Pinned exceptions: file, then the argv (its literal elements, in order) the call passes. */
const EXCEPTIONS: [string, string[]][] = [
  ['src/claude-signin.ts', ['auth', 'login']],
  ['src/claude-signin.ts', ['auth', 'status', '--json']],
  ['src/doctor.ts', ['--version']],
];
const AUTH_HELPERS = /^(?:claudeAuthStatus|claudeAuthMethod|claudeAuthStatusJson)$/;

/** Each launch of claude in `text` (the file `path`) outside the one launch function, as `<path>:<line>: <why>`. */
export function launchProblems(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const at = (n: Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const out: string[] = [];
  // The names bound to child_process's spawners here, and its namespaces.
  const fns = new Set<string>();
  const spaces = new Set<string>();
  const consts = new Map<string, Node>();
  const bind = (n: Node) => {
    if (is('ImportDeclaration', n) && n.moduleSpecifier && is('StringLiteral', n.moduleSpecifier) && MODULES(n.moduleSpecifier.text!, path)) {
      const c = n.importClause;
      if (c?.name) spaces.add(c.name.text!);
      const nb = c?.namedBindings;
      if (nb && is('NamespaceImport', nb)) spaces.add(nb.name!.text!);
      else if (nb) for (const e of (nb as unknown as { elements: Node[] }).elements) if (SPAWNERS.test((e.propertyName ?? e.name)!.text!)) fns.add(e.name!.text!);
    }
    if (is('VariableDeclaration', n) && n.initializer) {
      const init = n.initializer.getText();
      if (/require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(init)) {
        if (is('Identifier', n.name)) spaces.add(n.name!.text!);
        else for (const e of n.name!.elements ?? []) if (SPAWNERS.test((e.propertyName ?? e.name)!.text!)) fns.add(e.name!.text!);
      } else if (is('Identifier', n.name)) consts.set(n.name!.text!, n.initializer);
    }
    each(n, bind);
  };
  bind(sf);
  const spawner = (c: Node | undefined): boolean => {
    if (is('Identifier', c)) return fns.has(c!.text!);
    if (is('PropertyAccessExpression', c)) return SPAWNERS.test(c!.name!.text!) && is('Identifier', c!.expression) && spaces.has(c!.expression!.text!);
    return false;
  };
  // Whether a node holds a text naming claude: its strings, templates and regexes, and a const's initializer it names.
  const names = (n: Node, seen = new Set<Node>()): boolean => {
    let hit = false;
    const walk = (x: Node) => {
      if (hit) return;
      if ((is('StringLiteral', x) || is('NoSubstitutionTemplateLiteral', x) || is('TemplateHead', x) || is('TemplateMiddle', x) || is('TemplateTail', x)) && CLAUDE.test(x.text!)) hit = true;
      else if (is('Identifier', x) && consts.has(x.text!) && !seen.has(x)) {
        seen.add(x);
        if (names(consts.get(x.text!)!, seen)) hit = true;
      } else each(x, walk);
    };
    walk(n);
    return hit;
  };
  const literalArgv = (call: Node) => {
    const a = call.arguments?.[1];
    return a && is('ArrayLiteralExpression', a) ? a.elements!.map((e) => (is('StringLiteral', e) ? e.text! : '?')) : [];
  };
  const visit = (n: Node) => {
    if (is('CallExpression', n) && spawner(n.expression) && (n.arguments ?? []).some((a) => names(a))) {
      const argv = literalArgv(n);
      const excepted = EXCEPTIONS.some(([f, want]) => f === path && JSON.stringify(want) === JSON.stringify(argv));
      if (path !== LAUNCHER && !excepted) out.push(`${at(n)}: starts claude (\`${n.getText().replace(/\s+/g, ' ').slice(0, 100)}\`) outside ${LAUNCHER}: start every session with launchClaude, which always loads no setting source`);
    }
    // The runner's binary reaches nothing but launchClaude (and the auth-status helpers, which start no session).
    if (is('PropertyAccessExpression', n) && n.expression?.kind === (ts.SyntaxKind as unknown as Record<string, number>).ThisKeyword && n.name!.text === 'bin' && path !== LAUNCHER) {
      const p = n.parent!;
      let call = p.parent;
      while (call && (is('AsExpression', call.parent) || is('SatisfiesExpression', call.parent) || is('ParenthesizedExpression', call.parent))) call = call.parent;
      const intoLaunch = is('PropertyAssignment', p) && p.name!.text === 'bin' && is('ObjectLiteralExpression', p.parent) && is('CallExpression', call?.parent) && call!.parent!.expression!.getText() === 'launchClaude';
      const intoAuth = is('CallExpression', p) && AUTH_HELPERS.test(p.expression!.getText()) && p.arguments!.includes(n);
      if (!intoLaunch && !intoAuth) out.push(`${at(n)}: the runner's binary (\`${p.getText().replace(/\s+/g, ' ').slice(0, 100)}\`) goes somewhere but launchClaude`);
    }
    each(n, visit);
  };
  visit(sf);
  return out;
}

const srcFiles = () => readdirSync(join(repoRoot, 'src'), { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => x.endsWith('.ts') && !x.endsWith('.d.ts')).map((x) => `src/${x}`);

test('#958: no module in src/ starts Claude Code but src/claude-launch.ts (the named exceptions start no session)', () => {
  const problems = srcFiles().flatMap((p) => launchProblems(p, readFileSync(join(repoRoot, p), 'utf8')));
  assert.deepEqual(problems, []);
  // It reads the real launches: the one launch function's spawn, and each exception.
  assert.match(readFileSync(join(repoRoot, LAUNCHER), 'utf8'), /return spawn\(w\.file, w\.args/);
  for (const [f, argv] of EXCEPTIONS) assert.ok(readFileSync(join(repoRoot, f), 'utf8').includes(JSON.stringify(argv).replace(/"/g, "'").replace(/,/g, ', ')), `${f}: ${argv.join(' ')} is still there`);
});

test('#958: every way of starting claude outside the launch function is refused (fixtures), and the controls pass', () => {
  const dir = join(repoRoot, 'test', 'fixtures', 'claude-launch');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts.txt')).sort();
  assert.ok(files.length >= 12, 'the fixtures are there');
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    // A fixture names where it stands in its first line: `// as src/<path>`.
    const as = /^\/\/ as (\S+)/.exec(text)?.[1] ?? `src/${f.replace(/\.txt$/, '')}`;
    const problems = launchProblems(as, text);
    if (f.startsWith('ok-')) assert.deepEqual(problems, [], `${f}: a control passes`);
    else assert.ok(problems.length > 0, `${f}: refused`);
  }
});
