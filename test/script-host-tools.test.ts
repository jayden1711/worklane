// lint-test
// A test of a scripts/ shell script never reaches a real host tool (#991).
//
// The protection is test/script-child-process.ts: its spawn, spawnSync, execFile, execFileSync and execSync put a
// recording stand-in for each host tool the machine has (sudo, systemctl, useradd, claude and the like) ahead of the
// machine's own directories on every child's PATH, so a script under test that reaches one of them reaches the
// stand-in. The lint at the end is a backstop beside it: a test file that runs a scripts/ shell script (or imports a
// test module that does) starts its children through that module, never node:child_process (nor
// src/os/child-process.ts, which adds no stand-ins).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { repoRoot } from './helpers.js';
import { onPath } from './host-tools.js';
import { testMachine } from './isolate.js';
import { execFileSync, execSync, hostCalls, machineTool, SCRIPT_HOST_TOOLS, scriptEnv, scriptPath, spawn, spawnSync, standInRoot } from './script-child-process.js';

const posix = process.platform !== 'win32';
/** The machine's own directories these tests give a child, and whether they hold any host tool to shadow. */
const SYSTEM = '/usr/bin:/bin';
const systemHasHostTools = SCRIPT_HOST_TOOLS.some((t) => onPath(t, SYSTEM) !== null);

/** Each line of `out` (`<tool>=<command -v tool>`): the stand-in where `path` has the tool, nothing where it hasn't. */
function resolvedSafely(out: string, path: string): void {
  const lines = out.trim().split('\n');
  assert.equal(lines.length, SCRIPT_HOST_TOOLS.length, out);
  for (const line of lines) {
    const [t, at] = line.split('=') as [string, string];
    if (onPath(t, path) !== null) assert.ok(at.startsWith(`${standInRoot}/`) && basename(at) === t, `${line}: the machine's ${t}, past the stand-in`);
    else assert.equal(at, '', `${line}: the machine has no ${t}, and none was made up`);
  }
}

test("#991: no host tool on a child's PATH resolves to the machine's own: each it has is a recording stand-in, each it lacks stays missing, through every call form", { skip: !posix && 'POSIX sh' }, async (t) => {
  const which = `for t in ${SCRIPT_HOST_TOOLS.join(' ')}; do printf '%s=%s\\n' "$t" "$(command -v "$t" || true)"; done`;
  // Resolution first, with nothing called: a stand-in missing here fails before anything below could reach a real one.
  for (const [env, path] of [[undefined, process.env.PATH], [{ PATH: SYSTEM }, SYSTEM], [{ PATH: process.env.PATH }, process.env.PATH], [{}, SYSTEM]] as const) {
    const r = spawnSync('bash', ['-c', which], { encoding: 'utf8', ...(env ? { env } : {}) });
    resolvedSafely(r.stdout, path ?? SYSTEM);
  }
  resolvedSafely(String(execFileSync('/bin/bash', ['-c', which], { env: { PATH: SYSTEM } })), SYSTEM);
  resolvedSafely(String(execSync(which, { env: { PATH: SYSTEM }, shell: '/bin/bash' })), SYSTEM);
  resolvedSafely(
    await new Promise<string>((done) => {
      let out = '';
      const c = spawn('/bin/bash', ['-c', which], { env: { PATH: SYSTEM } });
      c.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      c.on('close', () => done(out));
    }),
    SYSTEM,
  );
  // Then a call: recorded, exit 1, nothing else run.
  if (onPath('sudo', SYSTEM) === null) return t.skip('this machine has no sudo to shadow');
  const before = hostCalls().length;
  const r = spawnSync('/bin/bash', ['-c', 'sudo -H -u wl-nobody env true; echo "rc=$?"'], { encoding: 'utf8', env: { PATH: SYSTEM } });
  assert.equal(r.stdout.trim(), 'rc=1');
  assert.deepEqual(hostCalls().slice(before), [{ tool: 'sudo', args: ['-H', '-u', 'wl-nobody', 'env', 'true'] }]);
});

test("#991: the stand-ins go first and hold only the machine's tools: a test's own stand-in still answers, a link to the machine's own does not", { skip: (!posix || !systemHasHostTools) && 'no host tool in /usr/bin or /bin to shadow' }, () => {
  const own = join(testMachine, 't', 'own-bin');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'sudo'), '#!/bin/sh\necho own\n');
  chmodSync(join(own, 'sudo'), 0o755);
  const fixture = join(repoRoot, 'test', 'fixtures');
  const first = (p: string) => p.split(delimiter)[0]!;
  const d = first(scriptPath(SYSTEM));
  assert.ok(d.startsWith(`${standInRoot}/`), d);
  assert.equal(scriptPath(SYSTEM), `${d}:${SYSTEM}`);
  assert.equal(scriptPath(undefined), `${d}:${SYSTEM}`, 'no PATH: the one a child would search, behind the stand-ins');
  assert.equal(scriptPath(`/usr/bin:/bin:${own}`), `${d}:/usr/bin:/bin:${own}`, "the machine's first: its own sudo is the one found");
  assert.equal(scriptPath(scriptPath(SYSTEM)), `${d}:${SYSTEM}`, 'once');
  assert.equal(first(scriptPath(`${standInRoot}:${SYSTEM}`)), d, 'naming the stand-ins\' root skips nothing');
  assert.deepEqual(scriptEnv({ PATH: SYSTEM, X: 'y' }), { PATH: `${d}:${SYSTEM}`, X: 'y' });
  for (const path of [`${own}:${SYSTEM}`, `${own}:${fixture}:${SYSTEM}`]) {
    const e = first(scriptPath(path));
    assert.ok(e.startsWith(`${standInRoot}/`), e);
    assert.equal(scriptPath(path), `${e}:${path}`);
    // The test's own sudo answers; every other host tool the machine has is a stand-in.
    const r = spawnSync('/bin/bash', ['-c', `sudo; for t in ${SCRIPT_HOST_TOOLS.join(' ')}; do printf '%s=%s\\n' "$t" "$(command -v "$t" || true)"; done`], { encoding: 'utf8', env: { PATH: path } });
    const [said, ...lines] = r.stdout.split('\n');
    assert.equal(said, 'own');
    for (const l of lines.filter(Boolean)) {
      const [t, at] = l.split('=') as [string, string];
      if (t === 'sudo') assert.equal(at, join(own, 'sudo'));
      else if (onPath(t, SYSTEM) !== null) assert.ok(at.startsWith(`${standInRoot}/`), l);
    }
  }
  // Its own stand-in for a tool the machine lacks answers even behind the machine's directories.
  const lacking = SCRIPT_HOST_TOOLS.find((t) => onPath(t, `${SYSTEM}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin`) === null);
  if (lacking !== undefined) {
    const late = join(testMachine, 't', 'late-bin');
    mkdirSync(late, { recursive: true });
    writeFileSync(join(late, lacking), '#!/bin/sh\necho late\n');
    chmodSync(join(late, lacking), 0o755);
    assert.equal(spawnSync('/bin/sh', ['-c', lacking], { encoding: 'utf8', env: { PATH: `${SYSTEM}:${late}` } }).stdout, 'late\n', lacking);
  }
  assert.equal(scriptPath(own), own, 'only its own directories, with no link to the machine: nothing to shadow');
  assert.equal(scriptPath(`${own}:/nonexistent`), `${own}:/nonexistent`, 'no host tool anywhere on it: nothing made up');
  // A link in its own directory to the machine's own tool is the machine's tool.
  const theirs = onPath('systemctl', SYSTEM) ?? onPath('sudo', SYSTEM);
  if (theirs !== null) {
    const linked = join(testMachine, 't', 'linked-bin');
    mkdirSync(linked, { recursive: true });
    symlinkSync(theirs, join(linked, basename(theirs)));
    symlinkSync('/bin/true', join(linked, 'docker'));
    const path = `${linked}:/nonexistent`;
    const r = spawnSync('/bin/sh', ['-c', `command -v ${basename(theirs)}; command -v docker`], { encoding: 'utf8', env: { PATH: path } });
    const [tool, docker] = r.stdout.trim().split('\n');
    assert.ok(tool!.startsWith(`${standInRoot}/`), `${tool}: a link to the machine's ${basename(theirs)} is shadowed`);
    assert.equal(docker, join(linked, 'docker'), "a link to another tool (true) is the test's own stand-in");
  }
});

// ---- The lint (a backstop beside test/script-child-process.ts). ----

const SEAM = 'test/script-child-process.ts';
/**
 * The one test file that runs a scripts/ shell script with node:child_process itself: its acceptance tests run
 * lib.sh's run_as through real passwordless sudo, and create users and units with it, on CI's disposable runners only
 * (they skip where `sudo -n` asks for a password). A loosening (#991): it may only shrink.
 */
// check-table: never-grow
const REAL_HOST_TOOLS_ON_PURPOSE = new Set(['test/setup-scripts.test.ts']);
// check-table: never-shrink
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
/** The engine's own seam: it starts children with no stand-ins. */
const ENGINE_SEAM = /(^|\/)src\/os\/child-process(\.js)?$/;
type Finding = { file: string; line: number; what: string };

const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Every string a file spells out: its literals and the fixed parts of its templates. */
function strings(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The name of every shell script under scripts/ (add-project.sh, lib.sh, worklane-testrun.sh, ...). */
function scriptNames(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.sh')) out.add(name);
    }
  };
  walk(join(repoRoot, 'scripts'));
  return out;
}

/**
 * Whether a file names a shell script under scripts/: a path (a string with no space) through the scripts directory,
 * and a path to a .sh file that has the name of one there. A message that mentions them in words is not a path.
 */
function namesScriptsShell(sf: ts.SourceFile, names: Set<string>): boolean {
  const s = strings(sf);
  return s.some((t) => /^(\S*\/)?scripts(\/\S*)?$/.test(t)) && s.some((t) => /^\S*\.sh$/.test(t) && names.has(t.split('/').pop()!));
}

/** The test modules a file imports from (relative specifiers, as test/ paths). */
function importsOf(file: string, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
    if (spec?.startsWith('./')) out.push(join(file, '..', spec.replace(/\.js$/, '.ts')).split('\\').join('/'));
  }
  return out;
}

/** Each place a file starts a process past the seam: node:child_process, or the engine's seam, for a value. */
function childProcessReach(file: string, sf: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  const at = (n: ts.Node, what: string) => out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      if (!CHILD_PROCESS.has(spec) && !ENGINE_SEAM.test(spec)) return;
      const typeOnly = ts.isImportDeclaration(n)
        ? !n.importClause || n.importClause.isTypeOnly || (!n.importClause.name && !!n.importClause.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && n.importClause.namedBindings.elements.every((e) => e.isTypeOnly))
        : n.isTypeOnly || (!!n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) at(n, `${ts.isImportDeclaration(n) ? 'imports' : 're-exports'} ${spec}: start a scripts/ test's children through ${SEAM} (import type is fine)`);
      return;
    }
    // A type: `typeof import('node:child_process').spawn` starts nothing.
    if (ts.isImportTypeNode(n)) return;
    if (ts.isImportEqualsDeclaration(n)) at(n, 'import = require(…): import a module statically');
    if (ts.isStringLiteralLike(n) && (CHILD_PROCESS.has(n.text) || ENGINE_SEAM.test(n.text))) at(n, `${JSON.stringify(n.text)}: only ${SEAM} names it for a value`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The lint over `files` (test/ path -> text): every file that names a scripts/ shell script, or imports a test module
 * that does (or one that imports one, and so on), and starts a process past the seam. The seam itself and the one
 * file above are not checked.
 */
function scriptTestReach(files: Map<string, string>, names = scriptNames()): Finding[] {
  const parsed = new Map([...files].map(([f, t]) => [f, parse(f, t)] as const));
  const runs = new Set([...parsed].filter(([, sf]) => namesScriptsShell(sf, names)).map(([f]) => f));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, sf] of parsed) if (!runs.has(f) && f !== SEAM && importsOf(f, sf).some((i) => runs.has(i))) (runs.add(f), (grew = true));
  }
  return [...runs].filter((f) => f !== SEAM && !REAL_HOST_TOOLS_ON_PURPOSE.has(f)).sort().flatMap((f) => childProcessReach(f, parsed.get(f)!));
}

function testFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'fixtures') walk(p);
      } else if (/\.(c|m)?tsx?$/.test(name)) files.set(relative(repoRoot, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(repoRoot, 'test'));
  return files;
}

test('#991 backstop: every test that runs a scripts/ shell script starts its children through test/script-child-process.ts', () => {
  const files = testFiles();
  assert.ok(files.has(SEAM) && files.has('test/add-project.test.ts') && files.size > 300, 'read the whole of test/');
  assert.deepEqual(scriptTestReach(files), []);
});

test('#991 backstop: the one file that reaches real sudo on purpose still runs scripts/ shell scripts, and still needs it', () => {
  assert.deepEqual([...REAL_HOST_TOOLS_ON_PURPOSE], ['test/setup-scripts.test.ts'], 'one file, and it may only go');
  const text = readFileSync(join(repoRoot, 'test', 'setup-scripts.test.ts'), 'utf8');
  assert.ok(namesScriptsShell(parse('x.ts', text), scriptNames()));
  assert.match(text, /spawnSync\('sudo', \['-n', /, "its acceptance runs ask real sudo -n, or there's no reason left for the exception");
});

/**
 * Each test that means a real host tool (machineTool): an acceptance run on a disposable CI runner, skipped where the
 * tool can't answer. A loosening (#991): the list may only shrink, and each entry names its file and tool.
 */
// check-table: never-grow
const MACHINE_TOOLS_ON_PURPOSE = [
  'test/engine-update.test.ts sudo', // the engine built by a DynamicUser and installed, as root (systemCi)
  'test/frozen-guard.test.ts sudo', // the agent's hook run as another user, nobody (canSwitch)
  'test/machine-helper.test.ts visudo', // the machine helper's sudoers rule, checked by the real visudo -cf
];

test('#991 backstop: only the pinned acceptance runs take a real host tool (machineTool), each by a literal name', () => {
  const uses: string[] = [];
  for (const [file, text] of testFiles()) {
    // The seam, and this file's own test of machineTool below.
    if (file === SEAM || file === 'test/script-host-tools.test.ts') continue;
    const sf = parse(file, text);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'machineTool') {
        const a = n.arguments[0];
        uses.push(`${file} ${n.arguments.length === 1 && a && ts.isStringLiteral(a) ? a.text : '<not one literal name>'}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual([...new Set(uses)].sort(), MACHINE_TOOLS_ON_PURPOSE);
});

test("#991: machineTool finds the tool on this process's own PATH, never a stand-in; with none, the child's PATH decides, through the stand-ins", { skip: !posix && 'POSIX sh' }, () => {
  const saved = process.env.PATH;
  const d = scriptPath(SYSTEM).split(delimiter)[0]!;
  try {
    process.env.PATH = [d, '/nonexistent'].join(delimiter);
    assert.equal(machineTool('sudo'), 'sudo', 'only a stand-in on this PATH: the bare name');
    process.env.PATH = [d, dirname(process.execPath)].join(delimiter);
    assert.equal(machineTool('node'), process.execPath);
  } finally {
    process.env.PATH = saved;
  }
  if (onPath('sudo', SYSTEM) === null) return;
  const before = hostCalls().length;
  const r = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', env: { PATH: SYSTEM } });
  assert.equal(r.status, 1, 'the bare name, on a PATH with the machine\'s sudo: the stand-in answered');
  assert.deepEqual(hostCalls().slice(before), [{ tool: 'sudo', args: ['-n', 'true'] }]);
});

test('#991 backstop: the lint finds each way past the seam (fixtures, never a planted file in test/)', () => {
  const runs = "const setupDir = join(repoRoot, 'scripts', 'setup');\nconst lib = join(setupDir, 'lib.sh');\n";
  const found = (text: string, file = 'test/x.test.ts') => scriptTestReach(new Map([[file, text]])).map((f) => f.what.split(': ')[0]);
  assert.deepEqual(found(`import { spawnSync } from 'node:child_process';\n${runs}`), ['imports node:child_process']);
  assert.deepEqual(found(`import { spawn, type ChildProcess } from 'child_process';\n${runs}`), ['imports child_process']);
  assert.deepEqual(found(`import * as cp from 'node:child_process';\n${runs}`), ['imports node:child_process']);
  assert.deepEqual(found(`import cp from 'node:child_process';\n${runs}`), ['imports node:child_process']);
  assert.deepEqual(found(`export { spawn } from 'node:child_process';\n${runs}`), ['re-exports node:child_process']);
  assert.deepEqual(found(`const cp = await import('node:child_process');\n${runs}`), ['"node:child_process"']);
  assert.deepEqual(found(`const cp = createRequire(import.meta.url)('child_process');\n${runs}`), ['"child_process"']);
  assert.deepEqual(found(`const cp = process.getBuiltinModule(\`node:child_process\`);\n${runs}`), ['"node:child_process"']);
  assert.deepEqual(found(`import cp = require('node:child_process');\n${runs}`), ['import = require(…)', '"node:child_process"']);
  assert.deepEqual(found(`import { spawnSync } from '../src/os/child-process.js';\n${runs}`), ['imports ../src/os/child-process.js'], "the engine's seam adds no stand-ins");
  // The ways a file names a script: a path string, a template, a join of parts.
  assert.deepEqual(found("import { spawnSync } from 'node:child_process';\nspawnSync('bash', ['scripts/setup/add-project.sh']);"), ['imports node:child_process']);
  assert.deepEqual(found("import { spawnSync } from 'node:child_process';\nspawnSync('bash', [`${repoRoot}/scripts/ci/slow-jobs.sh`]);"), ['imports node:child_process']);
  // Fine: type-only, through the seam, or no scripts/ shell script at all.
  assert.deepEqual(found(`import type { ChildProcess } from 'node:child_process';\n${runs}`), []);
  assert.deepEqual(found(`import { type ChildProcess } from 'node:child_process';\n${runs}`), []);
  assert.deepEqual(found(`const f = (() => 0) as unknown as typeof import('node:child_process').spawn;\n${runs}`), [], 'a type');
  assert.deepEqual(found(`import { spawnSync } from './script-child-process.js';\n${runs}`), []);
  assert.deepEqual(found("import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);"), []);
  assert.deepEqual(found("import { spawnSync } from 'node:child_process';\nconst f = join(repoRoot, 'scripts', 'pin-engine.mjs');"), [], 'no shell script');
  assert.deepEqual(found("import { spawnSync } from 'node:child_process';\nconst f = join(repoRoot, 'scripts', 'x');\nconst g = 'evil.sh';"), [], 'no shell script of scripts/ by that name');
  assert.deepEqual(found("import { spawnSync } from 'node:child_process';\nassert.match(out, 'run sudo bash scripts/setup/add-project.sh to retry');"), [], 'named in words, not a path');
  // A file that uses a fixture module that runs one (api-key-fixtures.ts, dashboards-root.ts), even two modules away.
  const fixture = `import { spawnSync } from './script-child-process.js';\n${runs}export const s = setupDir;\n`;
  const via = scriptTestReach(new Map([
    ['test/fx.ts', fixture],
    ['test/mid.ts', "export { s } from './fx.js';\n"],
    ['test/a.test.ts', "import { spawnSync } from 'node:child_process';\nimport { s } from './mid.js';\nspawnSync('bash', [s]);"],
    ['test/b.test.ts', "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);"],
  ]));
  assert.deepEqual(via.map((f) => f.file), ['test/a.test.ts']);
  // The seam itself, and the one exception, are not checked.
  assert.deepEqual(found(`import * as cp from 'node:child_process';\n${runs}`, SEAM), []);
  assert.deepEqual(found(`import { spawnSync } from 'node:child_process';\n${runs}`, 'test/setup-scripts.test.ts'), []);
  // #991 itself: add-project.test.ts as it was (its own lib.sh overrides with no as_user_argv, node:child_process).
  const before = "import { spawn, spawnSync } from 'node:child_process';\nconst setupDir = join(repoRoot, 'scripts', 'setup');\ncopyFileSync(join(setupDir, 'add-project.sh'), join(s, 'add-project.sh'));\n";
  assert.deepEqual(found(before, 'test/add-project.test.ts'), ['imports node:child_process']);
});
