// lint-test
// No test reaches a real host tool (#991): test/isolate.ts, the preload every test process runs, wraps
// node:child_process so that every child finds recording stand-ins for the machine's host tools first on its PATH, and
// refuses the ways past them it can see (a host tool by path, env -i, command -p, a login shell). These tests are its
// backstop: the wrappers are there in every test process and hold through every call form, the refusals hold, and
// only the pinned acceptance runs take a real tool (machineTool).
//
// This file imports nothing new from test/isolate.ts: it reads the guard through globalThis, so at a commit without the
// guard it fails at its first assertion, before it starts anything. Every call below that could reach a real tool runs
// only after a resolution check that fails first, or is built so it can't run one (cd or env -C into a missing
// directory first).
import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';
import { spawnSync as engineSpawnSync } from '../src/os/child-process.js';
import { repoRoot } from './helpers.js';
import { HOST_TOOLS } from './host-tools.js';

type Guard = {
  installed: boolean;
  standInRoot: string;
  hostCalls: () => { tool: string; args: string[] }[];
  hostToolPath: (file: string) => boolean;
  withHostStandIns: (path: string | undefined, cwd: string) => string;
  HOST_TOOL_NAMES: readonly string[];
  REAL_HOST_TOOLS_ON_PURPOSE: readonly string[];
  MACHINE_TOOLS_ON_PURPOSE: readonly string[];
  testFile: string | null;
  onCi: boolean;
  machineToolFor: (tool: string, testFile: string | null, onCi: boolean, path: string) => { kind: string; file: string };
};
function guard(): Guard {
  const g = (globalThis as Record<symbol, unknown>)[Symbol.for('test-host-tools')] as Guard | undefined;
  assert.ok(g?.installed, 'the preload (test/isolate.ts) installed no host-tool stand-ins in this test process');
  return g;
}

const posix = process.platform !== 'win32';
/** The machine's own directories these tests give a child. */
const SYSTEM = '/usr/bin:/bin';
const executable = (f: string) => {
  try {
    return statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};
const findOn = (tool: string, path: string) => path.split(':').map((d) => join(d, tool)).find(executable) ?? null;
const MISSING = '/nonexistent-991';

/** `<tool>=<command -v tool>` for each host tool, as a child's shell resolves it. */
const which = (tools: readonly string[]) => `for t in ${tools.join(' ')}; do printf '%s=%s\\n' "$t" "$(command -v "$t" || true)"; done`;
/** Each line: the stand-in where `path` has the tool on the machine, nothing where it hasn't. */
function resolvedSafely(g: Guard, out: string, path: string, form: string, standIns = `${g.standInRoot}/`): void {
  const lines = out.trim().split('\n');
  assert.equal(lines.length, g.HOST_TOOL_NAMES.length, `${form}: ${out}`);
  for (const line of lines) {
    const [t, at] = line.split('=') as [string, string];
    if (findOn(t, path) !== null) assert.ok(at.includes(standIns) && basename(at) === t, `${form}: ${line}: the machine's ${t}, past the stand-ins`);
    else assert.equal(at, '', `${form}: ${line}: the machine has no ${t} there, and none was made up`);
  }
}

test("#991: in every test process, a child's PATH finds a stand-in for each host tool the machine has, through every way to start one", { skip: !posix && 'POSIX' }, async () => {
  const g = guard();
  const w = which(g.HOST_TOOL_NAMES);
  const env = { PATH: SYSTEM };
  const asyncOut = (c: cp.ChildProcess) =>
    new Promise<string>((done) => {
      let out = '';
      c.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
      c.on('close', () => done(out));
    });
  const forms: [string, () => string | Promise<string>][] = [
    ['spawnSync', () => cp.spawnSync('bash', ['-c', w], { encoding: 'utf8', env }).stdout],
    ['spawnSync, no PATH', () => cp.spawnSync('/bin/bash', ['-c', w], { encoding: 'utf8', env: {} }).stdout],
    ['spawnSync, shell: true', () => cp.spawnSync(w, { encoding: 'utf8', env, shell: '/bin/bash' }).stdout],
    ['spawn', () => asyncOut(cp.spawn('bash', ['-c', w], { env }))],
    ['execFileSync', () => String(cp.execFileSync('bash', ['-c', w], { env }))],
    ['execFile', () => new Promise((done, fail) => void cp.execFile('bash', ['-c', w], { env }, (e, out) => (e ? fail(e) : done(String(out)))))],
    ['execFile, promisified', async () => (await promisify(cp.execFile)('bash', ['-c', w], { env })).stdout],
    ['exec', () => new Promise((done, fail) => void cp.exec(w, { env, shell: '/bin/bash' }, (e, out) => (e ? fail(e) : done(String(out)))))],
    ['exec, promisified', async () => (await promisify(cp.exec)(w, { env, shell: '/bin/bash' })).stdout],
    ['execSync', () => String(cp.execSync(w, { env, shell: '/bin/bash' }))],
    ["the engine's src/os/child-process.ts", () => String(engineSpawnSync('bash', ['-c', w], { encoding: 'utf8', env }).stdout)],
    ['a grandchild (node, unwrapped, inheriting the PATH)', () => String(cp.execFileSync(process.execPath, ['-e', `process.stdout.write(require('node:child_process').execFileSync('bash', ['-c', ${JSON.stringify(w)}]))`], { env }))],
  ];
  const forked = join(mkdtempSync(join(tmpdir(), 'host-tools-')), 'fork-child.cjs');
  writeFileSync(forked, `process.stdout.write(require('node:child_process').execFileSync('bash', ['-c', ${JSON.stringify(w)}]));\n`);
  forms.push(['fork', () => asyncOut(cp.fork(forked, [], { execArgv: [], env, stdio: 'pipe' }))]);
  for (const [form, run] of forms) resolvedSafely(g, await run(), SYSTEM, form);
  // A fresh test process: the preload alone installs it (no import of ours); its stand-ins are in its own machine.
  const fresh = cp.spawnSync(process.execPath, ['--import', './dist/test/isolate.js', '-e', `process.stdout.write(require('node:child_process').execFileSync('bash', ['-c', ${JSON.stringify(w)}], { env: { PATH: ${JSON.stringify(SYSTEM)} } }))`], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  resolvedSafely(g, fresh.stdout, SYSTEM, 'a fresh preloaded process', '/host-tools/');
  // Then a call, once resolution held: recorded, exit 1, nothing else run.
  if (findOn('sudo', SYSTEM) === null) return;
  const before = g.hostCalls().length;
  const r = cp.spawnSync('bash', ['-c', 'sudo -H -u wl-nobody env true; echo "rc=$?"'], { encoding: 'utf8', env });
  assert.equal(r.stdout.trim(), 'rc=1');
  assert.deepEqual(g.hostCalls().slice(before), [{ tool: 'sudo', args: ['-H', '-u', 'wl-nobody', 'env', 'true'] }]);
});

test("#991: a test's own stand-in still answers; a link in its own directory that leaves them, and a relative or empty PATH entry, are shadowed", { skip: !posix && 'POSIX' }, () => {
  const g = guard();
  const machine = findOn('sudo', SYSTEM) ?? findOn('systemctl', SYSTEM);
  const root = mkdtempSync(join(tmpdir(), 'host-tools-'));
  const own = join(root, 'own');
  mkdirSync(own);
  writeFileSync(join(own, 'sudo'), '#!/bin/sh\necho own\n');
  chmodSync(join(own, 'sudo'), 0o755);
  const sh = (script: string, o: cp.SpawnSyncOptions) => String(cp.spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', ...o }).stdout).trim();
  assert.equal(sh('sudo', { env: { PATH: `${own}:${SYSTEM}` } }), 'own', "the test's own sudo, ahead of the machine's");
  assert.equal(sh('command -v sudo', { env: { PATH: own } }), join(own, 'sudo'), 'only its own directories: as they are');
  assert.equal(sh('command -v docker || echo none', { env: { PATH: `${own}:${MISSING}` } }), 'none', 'a tool nowhere on it stays missing');
  // A link to something outside the test's own directories, under a host tool's name: shadowed.
  const linked = join(root, 'linked');
  mkdirSync(linked);
  symlinkSync('/bin/true', join(linked, 'docker'));
  if (machine !== null) symlinkSync(machine, join(linked, basename(machine)));
  const tools = machine !== null ? ['docker', basename(machine)] : ['docker'];
  for (const [form, o] of [
    ['a link in its own directory', { env: { PATH: `${linked}:${MISSING}` } }],
    ['a relative entry (the child cwd)', { env: { PATH: `.:${MISSING}` }, cwd: linked }],
    ['an empty entry (the child cwd)', { env: { PATH: `:${MISSING}` }, cwd: linked }],
    ['a PATH naming the stand-ins\' root', { env: { PATH: `${g.standInRoot}:${linked}` } }],
  ] as const) {
    for (const t of tools) assert.ok(sh(`command -v ${t}`, o).startsWith(`${g.standInRoot}/`), `${form}: ${t} is a stand-in`);
  }
});

test('#991: the ways past the stand-ins it can see are refused: a host tool by path, env -i, command -p, a login shell, process.binding', { skip: !posix && 'POSIX' }, async () => {
  const g = guard();
  const refused = (f: () => unknown) => assert.throws(f, /#991: /);
  // Each command below can't run a tool even if the refusal failed: its path doesn't exist, or it changes into a
  // missing directory first.
  refused(() => cp.spawnSync(`${MISSING}/sudo`, ['-V']));
  refused(() => cp.execFileSync(`${MISSING}/systemctl`, ['--version']));
  refused(() => cp.spawn(`${MISSING}/visudo`, ['-c']));
  refused(() => cp.spawnSync('env', ['-i', '-C', MISSING, 'sudo', '-V']));
  refused(() => cp.spawnSync('env', ['-u', 'PATH', '-C', MISSING, 'systemctl', '--version']));
  refused(() => cp.spawnSync('bash', ['-lc', `cd ${MISSING} && sudo -V`]));
  refused(() => cp.spawnSync('bash', ['--login', '-c', `cd ${MISSING} && sudo -V`]));
  refused(() => cp.spawnSync('sh', ['-c', `cd ${MISSING} && command -p sudo -V`]));
  refused(() => cp.execSync(`cd ${MISSING} && env -i sudo -V`));
  refused(() => cp.spawnSync(`cd ${MISSING} && bash -l -c 'sudo -V'`, { shell: true }));
  refused(() => (process as unknown as { binding: (n: string) => unknown }).binding('spawn_sync'));
  refused(() => (process as unknown as { binding: (n: string) => unknown }).binding('process_wrap'));
  // A host tool's name as any word under env -i, a login shell or command -p (#997 round 3: if, !, timeout).
  refused(() => cp.spawnSync('env', ['-i', '-C', MISSING, 'sh', '-c', 'if sudo -V; then :; fi']));
  refused(() => cp.spawnSync('env', ['-i', '-C', MISSING, 'timeout', '5', 'sudo', '-V']));
  refused(() => cp.spawnSync('bash', ['-lc', `cd ${MISSING} && ! sudo -V`]));
  refused(() => cp.spawnSync('bash', ['-lc', `cd ${MISSING} && if sudo -V; then :; fi`]));
  refused(() => cp.execSync(`cd ${MISSING} && env -i sh -c 'type sudo'`));
  refused(() => cp.spawnSync('sh', ['-c', `cd ${MISSING} && command -p timeout 5 sudo -V`]));
  // A host tool by path anywhere in a test's own command: an operand, a word of a command line, a shell, fork's
  // execPath, process.execve (#997 round 3, N2-N4, N6).
  refused(() => cp.spawnSync('env', ['-C', MISSING, `${MISSING}/sudo`, '-V']));
  refused(() => cp.spawnSync('timeout', ['5', `${MISSING}/sudo`, '-V']));
  refused(() => cp.spawnSync('sh', ['-c', `cd ${MISSING} && ${MISSING}/systemctl --version`]));
  refused(() => cp.execSync(`cd ${MISSING} && ${MISSING}/sudo -V`));
  refused(() => cp.spawnSync('-V', { shell: `${MISSING}/sudo` }));
  refused(() => cp.fork(join(tmpdir(), 'none.cjs'), [], { execPath: `${MISSING}/sudo`, execArgv: [] }));
  const execve = (process as unknown as { execve?: (f: string, a: string[], e: Record<string, string>) => void }).execve;
  if (typeof execve === 'function') refused(() => execve(`${MISSING}/sudo`, [`${MISSING}/sudo`, '-V'], {}));
  // The engine's own code naming a host tool by path gets its stand-in (recorded, exit 1), never the tool.
  const before = g.hostCalls().length;
  const byEngine = engineSpawnSync(`${MISSING}/sudo`, ['-n', 'true'], { encoding: 'utf8' });
  assert.equal(byEngine.status, 1, String(byEngine.error ?? ''));
  assert.deepEqual(g.hostCalls().slice(before), [{ tool: 'sudo', args: ['-n', 'true'] }]);
  // A PATH handed to env gets the stand-ins first (resolution only).
  const viaEnv = String(cp.spawnSync('env', ['-i', `PATH=${SYSTEM}`, 'sh', '-c', 'command -v sudo || echo none'], { encoding: 'utf8' }).stdout).trim();
  assert.ok(findOn('sudo', SYSTEM) === null ? viaEnv === 'none' : viaEnv.startsWith(`${g.standInRoot}/`), viaEnv);
  // The predicate behind the by-path refusal: a link in the test's own directory to the machine's tool is the
  // machine's; the test's own file is its own.
  const root = mkdtempSync(join(tmpdir(), 'host-tools-'));
  writeFileSync(join(root, 'sudo'), '#!/bin/sh\nexit 0\n');
  assert.equal(g.hostToolPath(join(root, 'sudo')), false, "the test's own stand-in");
  const machine = findOn('sudo', SYSTEM);
  if (machine !== null) {
    mkdirSync(join(root, 'l'));
    symlinkSync(machine, join(root, 'l', 'x'));
    assert.equal(g.hostToolPath(join(root, 'l', 'x')), true, "a link to the machine's sudo, under another name");
  }
  // machineTool, from a file it doesn't pin (this one), is refused.
  const { machineTool } = (await import('./isolate.js')) as unknown as { machineTool?: (t: string) => string };
  assert.equal(typeof machineTool, 'function');
  refused(() => machineTool!('sudo'));
});

test("#991 round 3: an argument that isn't a string, and a caller named by vm, start nothing untouched; the exceptions are this process's, from its argv", { skip: !posix && 'POSIX' }, () => {
  const g = guard();
  // Resolution only: what the child's shell finds for sudo.
  const sudoIs = (out: string) => (findOn('sudo', SYSTEM) === null ? out === 'none' : out.startsWith(`${g.standInRoot}/`));
  const n1 = String(cp.spawnSync('sh', ['-c', 'command -v sudo || echo none', '_', 1 as unknown as string], { encoding: 'utf8', env: { PATH: SYSTEM } }).stdout).trim();
  assert.ok(sudoIs(n1), `N1, a numeric argument: ${n1}`);
  // N5: a frame that names itself setup-scripts.test.ts (the exempt file) or engine-update.test.ts (pinned for sudo).
  const forged = join(repoRoot, 'dist', 'test', 'setup-scripts.test.js');
  const run = vm.runInThisContext(`(cp, env) => String(cp.spawnSync('sh', ['-c', 'command -v sudo || echo none'], { encoding: 'utf8', env }).stdout).trim()`, { filename: forged }) as (c: typeof cp, e: object) => string;
  const n5 = run(cp, { PATH: SYSTEM });
  assert.ok(sudoIs(n5), `N5, a frame named setup-scripts.test.js: ${n5}`);
  assert.equal(g.testFile, 'test/script-host-tools.test.ts', "the exceptions are keyed to this process's own test file");
});

test('#991 round 3: machineTool finds the tool only on the PATH this process started with, and only on CI; off CI it is the stand-in', () => {
  const g = guard();
  const pinned = 'test/engine-update.test.ts';
  assert.deepEqual(g.machineToolFor('sudo', 'test/script-host-tools.test.ts', true, SYSTEM), { kind: 'refused', file: 'sudo' }, 'a file it doesn\'t pin');
  assert.deepEqual(g.machineToolFor('sudo', null, true, SYSTEM).kind, 'refused', 'a process with no test file');
  // Never MACHINE_DIRS: a PATH without the tool gives the bare name, which a child resolves through the stand-ins.
  assert.deepEqual(g.machineToolFor('sudo', pinned, true, MISSING), { kind: 'machine', file: 'sudo' });
  const there = findOn('sudo', SYSTEM);
  if (there !== null) assert.deepEqual(g.machineToolFor('sudo', pinned, true, SYSTEM), { kind: 'machine', file: there });
  // Off CI, the stand-in: a developer machine never runs the real tool.
  const off = g.machineToolFor('sudo', pinned, false, SYSTEM);
  assert.equal(off.kind, 'stand-in');
  assert.ok(off.file.startsWith(`${g.standInRoot}/`) && basename(off.file) === 'sudo', off.file);
});

test('#991 round 3: the guard and its backstop are engine-guards, and a change to the preload runs the whole suite', async () => {
  const review = readFileSync(join(repoRoot, '.worklane', 'review.yaml'), 'utf8');
  const guards = review.slice(review.indexOf('engine-guards:'), review.indexOf('\nlevels:'));
  for (const f of ['test/isolate.ts', 'test/host-tools.ts', 'test/script-host-tools.test.ts']) assert.match(guards, new RegExp(`^ {4}- ${f.replace(/[.]/g, '\\.')}$`, 'm'), f);
  const affected = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'affected.mjs')).href)) as { forceAll: (f: string) => string | null };
  assert.ok(affected.forceAll('test/isolate.ts'), 'test/isolate.ts forces the whole suite');
});

test('#991 round 4: a host tool by path is refused or stood in for every caller, and behind a wrapper', { skip: !posix && 'POSIX' }, () => {
  const g = guard();
  const refused = (f: () => unknown, what: string) => assert.throws(f, /#991: /, what);
  // Every command below starts in, or changes into, a missing directory first, or names a missing path: nothing real.
  // E1-E3: a test through the engine's own seam (its frame is src/os/child-process.js).
  refused(() => engineSpawnSync('sh', ['-c', `cd ${MISSING} && ${MISSING}/sudo E1`]), 'E1');
  const before = g.hostCalls().length;
  const e2 = engineSpawnSync('env', [`${MISSING}/sudo`, 'E2'], { encoding: 'utf8' });
  const e3 = engineSpawnSync('timeout', ['5', `${MISSING}/systemctl`, 'E3'], { encoding: 'utf8' });
  assert.deepEqual([e2.status, e3.status], [1, 1], 'the stand-ins answered');
  assert.deepEqual(g.hostCalls().slice(before), [{ tool: 'sudo', args: ['E2'] }, { tool: 'systemctl', args: ['E3'] }]);
  // E4, E8, E9: a vm frame named as the engine's; E5: a module outside the repo.
  // The call to child_process is made in the named frame itself, so that frame is the caller the guard sees.
  type Caller = (c: typeof cp, form: 'execSync' | 'spawnSync', a: string, b?: string[]) => unknown;
  const asEngine = vm.runInThisContext('(c, form, a, b) => c[form](a, b)', { filename: join(repoRoot, 'dist', 'src', 'zz-forged.js') }) as Caller;
  const outside = vm.runInThisContext('(c, form, a, b) => c[form](a, b)', { filename: '/nonexistent-991/zz-helper.mjs' }) as Caller;
  refused(() => asEngine(cp, 'execSync', `cd ${MISSING} && ${MISSING}/sudo E4`), 'E4');
  refused(() => outside(cp, 'spawnSync', 'sh', ['-c', `cd ${MISSING} && ${MISSING}/sudo E5`]), 'E5');
  refused(() => asEngine(cp, 'spawnSync', 'sh', ['-c', `cd ${MISSING} && env -i ${MISSING}/sudo E8`]), 'E8');
  refused(() => asEngine(cp, 'spawnSync', 'sh', ['-c', `cd ${MISSING} && command -p ${MISSING}/sudo E9`]), 'E9');
  // Behind a wrapper in argument form: env -i, a login shell, and env's PATH=.
  refused(() => cp.spawnSync('timeout', ['5', 'env', '-i', '-C', MISSING, 'sudo', '-V']), 'timeout env -i');
  refused(() => cp.spawnSync('nice', ['bash', '-lc', `cd ${MISSING} && sudo -V`]), 'nice bash -lc');
  refused(() => cp.spawnSync('setsid', ['env', '-i', '-C', MISSING, 'sh', '-c', 'if sudo -V; then :; fi']), 'setsid env -i sh -c');
  const viaWrapper = String(cp.spawnSync('timeout', ['5', 'env', '-i', `PATH=${SYSTEM}`, 'sh', '-c', 'command -v sudo || echo none'], { encoding: 'utf8' }).stdout).trim();
  assert.ok(findOn('sudo', SYSTEM) === null ? viaWrapper === 'none' : viaWrapper.startsWith(`${g.standInRoot}/`), `timeout env PATH=: ${viaWrapper}`);
});

test("#991 round 4: no child a test starts off CI is on CI, and a pinned file's exceptions need it as the process's own main module", { skip: !posix && 'POSIX' }, () => {
  const g = guard();
  // Each child prints what its own preload decided and exits inside an --import or -e, before any test file loads.
  const report = `const g = globalThis[Symbol.for('test-host-tools')]; process.stdout.write(JSON.stringify({ onCi: g.onCi, testFile: g.testFile })); process.exit(0);`;
  const child = (args: string[]) => {
    const r = cp.spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { onCi: boolean; testFile: string | null };
  };
  const data = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
  // C1: another --import ahead of a pinned file; C5: -e with a pinned file as an operand.
  const c1 = child(['--import', './dist/test/isolate.js', '--import', data(report), 'dist/test/setup-scripts.test.js']);
  const c5 = child(['--import', './dist/test/isolate.js', '-e', report, 'dist/test/setup-scripts.test.js']);
  // C3: machineTool in a process that borrows engine-update.test.js as argv[1].
  const c3code = `import(${JSON.stringify(pathToFileURL(join(repoRoot, 'dist', 'test', 'isolate.js')).href)}).then((m) => { let got; try { got = m.machineTool('sudo'); } catch (e) { got = 'refused'; } process.stdout.write(JSON.stringify({ onCi: globalThis[Symbol.for('test-host-tools')].onCi, testFile: globalThis[Symbol.for('test-host-tools')].testFile, got })); process.exit(0); });`;
  const r3 = cp.spawnSync(process.execPath, ['--import', './dist/test/isolate.js', '--import', data(c3code), 'dist/test/engine-update.test.js'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
  assert.equal(r3.status, 0, r3.stderr);
  const c3 = JSON.parse(r3.stdout) as { onCi: boolean; testFile: string | null; got: string };
  for (const [name, c] of [['C1', c1], ['C3', c3], ['C5', c5]] as const) {
    assert.equal(c.testFile, null, `${name}: no exception keyed to a borrowed argv[1]`);
    if (!g.onCi) assert.equal(c.onCi, false, `${name}: off CI, GITHUB_ACTIONS never reaches a child`);
  }
  assert.equal(c3.got, 'refused', 'C3: machineTool refused');
  if (!g.onCi) assert.throws(() => cp.execSync(`cd ${MISSING} && GITHUB_ACTIONS=true true`), /#991: /, 'off CI, a command line that sets it');
});

test('#991 round 4: a machine host tool under another name (a link) is stood in too', { skip: !posix && 'POSIX' }, () => {
  const g = guard();
  const machine = findOn('sudo', SYSTEM) ?? findOn('systemctl', SYSTEM);
  if (machine === null) return;
  const dir = mkdtempSync(join(tmpdir(), 'host-alias-'));
  symlinkSync(machine, join(dir, 'zz-alias'));
  const at = String(cp.spawnSync('/bin/sh', ['-c', 'command -v zz-alias'], { encoding: 'utf8', env: { PATH: `${dir}:${MISSING}` } }).stdout).trim();
  assert.ok(at.startsWith(`${g.standInRoot}/`), `an own-dir link to the machine's ${basename(machine)}: ${at}`);
  // The machine's own aliases (sudoedit -> sudo on Debian and Ubuntu), where there are any: resolution only.
  for (const alias of ['sudoedit', 'reboot', 'poweroff']) {
    const f = findOn(alias, SYSTEM);
    if (f === null || !g.hostToolPath(f)) continue;
    const found = String(cp.spawnSync('/bin/sh', ['-c', `command -v ${alias}`], { encoding: 'utf8', env: { PATH: SYSTEM } }).stdout).trim();
    assert.ok(found.startsWith(`${g.standInRoot}/`), `${alias}: ${found}`);
  }
});

// ---- The pins: who may take a real tool. ----

/** Every TS file under test/, fixtures included. */
function testFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(c|m)?tsx?$/.test(name)) files.set(relative(repoRoot, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(repoRoot, 'test'));
  return files;
}

/**
 * Each reference to machineTool in `text`: `import` for an unaliased named import, the tool for a direct call with one
 * string literal, `<other>` for anything else (an alias, a namespace access, a computed name, a call without a literal).
 */
function machineToolRefs(file: string, text: string): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (n: ts.Node) => {
    const named = (ts.isIdentifier(n) && n.text === 'machineTool') || (ts.isStringLiteralLike(n) && n.text.includes('machineTool'));
    if (named) {
      const p = n.parent;
      if (ts.isImportSpecifier(p) && !p.propertyName && p.name === n) out.push('import');
      else if (ts.isCallExpression(p) && p.expression === n && p.arguments.length >= 1 && p.arguments.length <= 2 && ts.isStringLiteral(p.arguments[0]!)) out.push(p.arguments[0].text);
      else out.push('<other>');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('#991 pin: every reference to machineTool in test/ is an unaliased import or a call by literal name, and each call is pinned', () => {
  const g = guard();
  const files = testFiles();
  assert.ok(files.has('test/isolate.ts') && files.size > 300, 'read the whole of test/');
  const calls: string[] = [];
  for (const [file, text] of files) {
    // The guard itself, and this file (it names machineTool to test the refusal).
    if (file === 'test/isolate.ts' || file === 'test/script-host-tools.test.ts') continue;
    for (const ref of machineToolRefs(file, text)) if (ref !== 'import') calls.push(`${file} ${ref}`);
  }
  assert.deepEqual([...new Set(calls)].sort(), [...g.MACHINE_TOOLS_ON_PURPOSE].sort());
  // The walker sees what a pin would miss.
  assert.deepEqual(machineToolRefs('x.ts', "import { machineTool as mt } from './isolate.js';\nmt('sudo');"), ['<other>']);
  assert.deepEqual(machineToolRefs('x.ts', "import * as iso from './isolate.js';\niso.machineTool('sudo');"), ['<other>']);
  assert.deepEqual(machineToolRefs('x.ts', "import { machineTool } from './isolate.js';\n(machineTool)('sudo');\nconst t = 'sudo';\nmachineTool(t);"), ['import', '<other>', '<other>']);
  assert.deepEqual(machineToolRefs('x.ts', "const iso = await import('./isolate.js');\niso['machineTool']('sudo');"), ['<other>']);
  assert.deepEqual(machineToolRefs('x.ts', "import { machineTool } from './isolate.js';\nmachineTool('sudo');"), ['import', 'sudo']);
});

test('#991 pin: the one file that starts its children untouched still needs the real sudo, and every host tool of test/host-tools.ts is guarded', () => {
  const g = guard();
  assert.deepEqual([...g.REAL_HOST_TOOLS_ON_PURPOSE], ['test/setup-scripts.test.ts'], 'one file, and it may only go');
  assert.match(readFileSync(join(repoRoot, 'test', 'setup-scripts.test.ts'), 'utf8'), /spawnSync\('sudo', \['-n', /, "its acceptance runs ask real sudo -n, or there's no reason left for the exception");
  // gitleaks only reads, and the secret-scan tests run the real one.
  for (const t of HOST_TOOLS) if (t !== 'gitleaks') assert.ok(g.HOST_TOOL_NAMES.includes(t), t);
});
