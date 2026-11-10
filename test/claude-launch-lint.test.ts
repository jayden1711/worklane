// lint-test
// One launch for every Claude Code session the engine starts (#958, the owner's decision, 2026-11-09): src/
// claude-launch.ts's launchClaude, which always loads no setting source, reads no MCP config but its own, takes its
// settings only from --settings and keeps the auto memory off. This holds src/ to it: no other module starts the
// claude binary, or Claude Code's cli.js under node, and the runner's `bin` reaches nothing but launchClaude.
//
// What it reads (typescript's parser, every .ts file under src/):
// - a call of spawn, spawnSync, exec, execSync, execFile, execFileSync or fork, by any name bound to node:child_process,
//   child_process or src/os/child-process.ts (named, renamed, a namespace or default import, a require(), an alias:
//   `const run = spawn`, `const { spawn: s } = cp`, `cp['spawn']`), flagged when any string, template or regex in its
//   arguments (an argv array's, a `sh -c` command's, a `sudo`/`env` wrapper's), or the initializer of a const or a
//   parameter's default it names, is `claude`, ends in `/claude`, runs `claude ...`, or names @anthropic-ai/claude-code
//   or its cli.js (`process.execPath` with that path);
// - any call at all (a helper that forwards its command, as the setup wizard's `p.run('claude', ...)` did: R1185z D1),
//   also through `.call`/`.apply`, whose first argument is the claude binary (a literal, a const, a parameter's
//   default, or a const another src/ module exports, claudeExports) and whose second is an argv (an array, a name, a
//   property or a call): `add('claude', 'warn', ...)` is a report's row, not a launch;
// - `this.bin` (the runner's binary) anywhere but `bin: this.bin` in a launchClaude call, or the three auth-status
//   helpers' binary argument.
//
// Named exceptions, each pinned by file and argv: claude-signin.ts's `claude auth login` and `auth status --json`,
// doctor.ts's `claude --version`, init.ts's `claude auth login` (the terminal's own login) and setup-steps.ts's
// `claude auth status`; and runner.ts's authStatusCommand, which builds only `auth status --json`: none starts a
// session.
//
// What it can't see (named limits, as #1228's are):
// - a binary path built at run time from data with no `claude` in it (a config value, an env variable:
//   `spawn(cfg.agentBin)`), or from parts (`'clau' + 'de'`);
// - an argv given a launch some other way than as its second argument (a conditional, a literal string);
// - a launch through a module outside src/ (scripts/, a package);
// - a child process that itself runs claude (a hook, a project command: the sandbox's job, not this lint's);
// - a call through `Function`, `eval`, `vm` or worker_threads; a dynamic `import()`, `createRequire` or
//   `process.binding` of child_process (test/child-process.test.ts, #846, refuses those outside src/os/);
// - a binary the runner holds under another name than `bin` (the check on `this.bin` is by name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, sep } from 'node:path';
import { repoRoot } from './helpers.js';

type Node = { kind: number; text?: string; parent?: Node; name?: Node; expression?: Node; argumentExpression?: Node; arguments?: Node[]; initializer?: Node; elements?: Node[]; propertyName?: Node; moduleSpecifier?: Node; importClause?: Node & { name?: Node; namedBindings?: Node }; modifiers?: Node[]; getText: () => string; getStart: () => number };
const ts = createRequire(join(repoRoot, 'package.json'))('typescript') as Record<string, (...a: unknown[]) => unknown> & { ScriptTarget: { Latest: number }; createSourceFile: (f: string, t: string, v: number, p: boolean) => Node & { getLineAndCharacterOfPosition: (p: number) => { line: number } } };
const is = (k: string, n: Node | undefined): boolean => !!n && (ts[`is${k}`] as (n: Node) => boolean)(n);
const each = (n: Node, f: (c: Node) => void) => (ts.forEachChild as (n: Node, f: (c: Node) => void) => void)(n, f);

const SPAWNERS = /^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/;
const MODULES = (spec: string, path: string) => spec === 'node:child_process' || spec === 'child_process' || (/(?:^|\/)os\/child-process\.js$/.test(spec) || (path.startsWith('src/os/') && spec === './child-process.js'));
/** A text that names the claude binary or Claude Code's cli.js. */
const CLAUDE = /^claude$|\/claude$|(?:^|[\s;&|(])claude(?:\s|$)|@anthropic-ai\/claude-code|claude-code\/cli\.js/;
/** A text that is the claude binary itself (a command's first argument), or Claude Code's package or cli.js. */
const BINARY = /^claude$|\/claude$|@anthropic-ai\/claude-code|claude-code\/cli\.js/;
const LAUNCHER = 'src/claude-launch.ts';
/** Pinned exceptions: file, then the argv (its literal elements, in order) the call passes. */
// check-table: never-grow
const EXCEPTIONS: [string, string[]][] = [
  ['src/claude-signin.ts', ['auth', 'login']],
  ['src/claude-signin.ts', ['auth', 'status', '--json']],
  ['src/doctor.ts', ['--version']],
  ['src/init.ts', ['auth', 'login']],
  ['src/setup-steps.ts', ['auth', 'status']],
];
/**
 * Pinned command builders: file, the builder, and the one argv it builds (the real-tree test holds it there). A launch
 * whose command is `<x>.file`, `<x>` a const that builder's call made, is that argv.
 */
// check-table: never-grow
const BUILDERS: [string, string, string[]][] = [['src/runner.ts', 'authStatusCommand', ['auth', 'status', '--json']]];
const AUTH_HELPERS = /^(?:claudeAuthStatus|claudeAuthMethod|claudeAuthStatusJson)$/;

/**
 * The consts each module in `files` ([path, text]) exports whose value is the claude binary (`export const CLAUDE_BIN =
 * 'claude'`), as `<path>#<name>`: an import of one names claude as its value would (R1185z D2).
 */
export function claudeExports(files: [string, string][]): Set<string> {
  const out = new Set<string>();
  for (const [path, text] of files) {
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (n: Node) => {
      if (is('VariableStatement', n) && (n.modifiers ?? []).some((m) => m.getText() === 'export'))
        for (const d of (n as unknown as { declarationList: { declarations: Node[] } }).declarationList.declarations)
          if (is('Identifier', d.name) && d.initializer && (is('StringLiteral', d.initializer) || is('NoSubstitutionTemplateLiteral', d.initializer)) && BINARY.test(d.initializer.text!)) out.add(`${path}#${d.name!.text}`);
      each(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Each launch of claude in `text` (the file `path`) outside the one launch function, as `<path>:<line>: <why>`. */
export function launchProblems(path: string, text: string, exported: Set<string> = new Set()): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const at = (n: Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const out: string[] = [];
  // The names bound to child_process's spawners here, and its namespaces.
  const fns = new Set<string>();
  const spaces = new Set<string>();
  const consts = new Map<string, Node>();
  // Names whose value is the claude binary, imported from another src/ module that exports it (claudeExports).
  const imported = new Set<string>();
  const bind = (n: Node) => {
    if (is('ImportDeclaration', n) && n.moduleSpecifier && is('StringLiteral', n.moduleSpecifier) && MODULES(n.moduleSpecifier.text!, path)) {
      const c = n.importClause;
      if (c?.name) spaces.add(c.name.text!);
      const nb = c?.namedBindings;
      if (nb && is('NamespaceImport', nb)) spaces.add(nb.name!.text!);
      else if (nb) for (const e of (nb as unknown as { elements: Node[] }).elements) if (SPAWNERS.test((e.propertyName ?? e.name)!.text!)) fns.add(e.name!.text!);
    } else if (is('ImportDeclaration', n) && n.moduleSpecifier && is('StringLiteral', n.moduleSpecifier) && n.moduleSpecifier.text!.startsWith('.')) {
      const from = posix.join(posix.dirname(path), n.moduleSpecifier.text!).replace(/\.js$/, '.ts');
      const nb = n.importClause?.namedBindings;
      if (nb && !is('NamespaceImport', nb)) for (const e of (nb as unknown as { elements: Node[] }).elements) if (exported.has(`${from}#${(e.propertyName ?? e.name)!.text}`)) imported.add(e.name!.text!);
    }
    if (is('VariableDeclaration', n) && n.initializer) {
      const init = n.initializer.getText();
      if (/require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(init)) {
        if (is('Identifier', n.name)) spaces.add(n.name!.text!);
        else for (const e of n.name!.elements ?? []) if (SPAWNERS.test((e.propertyName ?? e.name)!.text!)) fns.add(e.name!.text!);
      } else if (is('Identifier', n.name)) consts.set(n.name!.text!, n.initializer);
    }
    // A parameter's default (`function go(bin = 'claude')`): its value when the caller passes none.
    if (is('Parameter', n) && n.initializer && is('Identifier', n.name)) consts.set(n.name!.text!, n.initializer);
    each(n, bind);
  };
  bind(sf);
  // Aliases of a spawner (R1185z D2, R1185aa D2), until none is new: `const run = spawn`, `const { spawn: s } = cp`
  // (cp a namespace), `const s = cp.spawn` or `cp['spawn']`.
  for (let grew = true; grew; ) {
    grew = false;
    const alias = (n: Node) => {
      if (is('VariableDeclaration', n) && n.initializer) {
        const i = n.initializer;
        if (is('Identifier', n.name) && !fns.has(n.name!.text!) && spawner(i)) (fns.add(n.name!.text!), (grew = true));
        if (is('ObjectBindingPattern', n.name) && is('Identifier', i) && spaces.has(i.text!))
          for (const e of n.name!.elements ?? []) if (SPAWNERS.test((e.propertyName ?? e.name)!.text!) && !fns.has(e.name!.text!)) (fns.add(e.name!.text!), (grew = true));
      }
      each(n, alias);
    };
    alias(sf);
  }
  function spawner(c: Node | undefined): boolean {
    if (is('Identifier', c)) return fns.has(c!.text!);
    if (is('PropertyAccessExpression', c)) return SPAWNERS.test(c!.name!.text!) && is('Identifier', c!.expression) && spaces.has(c!.expression!.text!);
    if (is('ElementAccessExpression', c)) return is('StringLiteral', c!.argumentExpression) && SPAWNERS.test(c!.argumentExpression!.text!) && is('Identifier', c!.expression) && spaces.has(c!.expression!.text!);
    return false;
  }
  // Whether a node is the claude binary itself: a literal, a const or parameter default, or an import that is one.
  const isBinary = (n: Node | undefined, seen = new Set<Node>()): boolean => {
    if (!n) return false;
    if (is('StringLiteral', n) || is('NoSubstitutionTemplateLiteral', n)) return BINARY.test(n.text!);
    if (is('Identifier', n)) {
      if (imported.has(n.text!)) return true;
      const v = consts.get(n.text!);
      if (!v || seen.has(n)) return false;
      seen.add(n);
      return isBinary(v, seen);
    }
    if (is('ParenthesizedExpression', n) || is('AsExpression', n)) return isBinary(n.expression, seen);
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
  const visit = (n: Node) => {
    // `f.call(this, ...)`/`f.apply(this, [...])`: the call of f with the rest.
    const viaCall = is('CallExpression', n) && is('PropertyAccessExpression', n.expression) && /^(?:call|apply)$/.test(n.expression!.name!.text!);
    const callee = viaCall ? n.expression!.expression : n.expression;
    const args = viaCall ? (n.arguments ?? []).slice(1) : (n.arguments ?? []);
    const argvLike = (a: Node | undefined) => !!a && (is('ArrayLiteralExpression', a) || is('Identifier', a) || is('PropertyAccessExpression', a) || is('CallExpression', a) || is('SpreadElement', a));
    // A spawner given claude anywhere in its arguments; or any call (a helper that forwards its command, R1185z D1)
    // whose command is the claude binary and that passes an argv.
    const launch = is('CallExpression', n) && ((spawner(callee) && args.some((a) => names(a))) || (isBinary(args[0]) && argvLike(args[1])));
    if (launch) {
      const a = args[1];
      const argv = a && is('ArrayLiteralExpression', a) ? a.elements!.map((e) => (is('StringLiteral', e) ? e.text! : '?')) : [];
      const c0 = args[0];
      const built = c0 && is('PropertyAccessExpression', c0) && c0.name!.text === 'file' && is('Identifier', c0.expression) ? consts.get(c0.expression!.text!) : undefined;
      const byBuilder = !!built && is('CallExpression', built) && BUILDERS.some(([f, b]) => f === path && built.expression!.getText() === b);
      const excepted = byBuilder || EXCEPTIONS.some(([f, want]) => f === path && JSON.stringify(want) === JSON.stringify(argv));
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
  const files = srcFiles().map((p): [string, string] => [p, readFileSync(join(repoRoot, p), 'utf8')]);
  const exported = claudeExports(files);
  const problems = files.flatMap(([p, t]) => launchProblems(p, t, exported));
  assert.deepEqual(problems, []);
  // It reads the real launches: the one launch function's spawn, and each exception.
  assert.match(readFileSync(join(repoRoot, LAUNCHER), 'utf8'), /return spawn\(w\.file, w\.args/);
  for (const [f, b, argv] of BUILDERS) assert.match(readFileSync(join(repoRoot, f), 'utf8'), new RegExp(`function ${b}\\([^]*?\\n  const argv = ${JSON.stringify(argv).replace(/"/g, "'").replace(/,/g, ', ').replace(/[[\]]/g, '\\$&')};`), `${f}: ${b} still builds only ${argv.join(' ')}`);
  for (const [f, argv] of EXCEPTIONS) assert.ok(readFileSync(join(repoRoot, f), 'utf8').includes(JSON.stringify(argv).replace(/"/g, "'").replace(/,/g, ', ')), `${f}: ${argv.join(' ')} is still there`);
});

test('#958: every way of starting claude outside the launch function is refused (fixtures), and the controls pass', () => {
  const dir = join(repoRoot, 'test', 'fixtures', 'claude-launch');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts.txt')).sort();
  // Every fixture by name (R1185z D2): one deleted fails here, as the probe's wrapper list is held.
  // check-table: never-shrink
  const MUST_FAIL = ['absolute-path', 'alias-assign', 'const-bin', 'default-import', 'destructure-namespace', 'direct-spawn', 'element-access', 'exec-string', 'execpath-cli-js', 'fn-call', 'imported-const', 'namespace-import', 'os-wrapper', 'param-default', 'renamed-import', 'require-destructured', 'runner-bin-escapes', 'runner-bin-spawn', 'sh-c', 'signin-session', 'src-helper', 'sudo-wrapper'];
  // check-table: never-shrink
  const CONTROLS = ['ok-doctor', 'ok-launch-bin', 'ok-launcher', 'ok-names', 'ok-other-tool', 'ok-report-row', 'ok-signin'];
  assert.deepEqual(files.map((f) => f.replace(/\.ts\.txt$/, '')), [...MUST_FAIL, ...CONTROLS].sort(), 'every fixture, by name');
  // A fixture names where it stands in its first line: `// as src/<path>`; the exports of all of them are read together.
  const all = files.map((f): [string, string] => {
    const text = readFileSync(join(dir, f), 'utf8');
    return [/^\/\/ as (\S+)/.exec(text)?.[1] ?? `src/${f.replace(/\.txt$/, '')}`, text];
  });
  const exported = claudeExports(all);
  for (const [i, f] of files.entries()) {
    const [as, text] = all[i]!;
    const problems = launchProblems(as, text, exported);
    if (f.startsWith('ok-')) assert.deepEqual(problems, [], `${f}: a control passes`);
    else assert.ok(problems.length > 0, `${f}: refused`);
  }
});
