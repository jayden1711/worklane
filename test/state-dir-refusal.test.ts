// #815: in a test run, stateDir() refuses any directory outside the test machine (testStateRefusal), as slotsDir()
// does (#669), so a test that lost its isolation fails loudly instead of reading or writing the person's own state.
// Outside a test run it is what it always was.
//
// RULE (#815): no case here reads, stats or writes a real state dir, /var/lib or /etc. Every directory a case names
// outside the test machine is a stand-in (a path beside the test machine that is never made), and the cases that
// resolve one run in a scratch child behind fs and child_process wrappers that refuse (before the real call) any path
// outside the test machine, and record every one they see. A positive control in each child shows the wrappers see the
// engine's own fs calls (its named imports included) and refuse a path outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { stateDir } from '../src/os/index.js';
import * as systemPaths from '../src/os/system-paths.js';
import { SYSTEM_ROOT_VAR, TEST_MACHINE_VAR, TEST_RUN_VAR, TEST_TOKEN_VAR, testSlotsRefusal } from '../src/os/system-paths.js';
import { repoRoot } from './helpers.js';
import { isolatedEnv, restoreIsolated, serviceModeEnv, testMachine } from './isolate.js';

// Read off the module, not imported by name, so this file still loads (and fails by its assertions) on an engine
// without it: its fail-without run.
const { testStateRefusal } = systemPaths;
const STATE = `${BRAND.envPrefix}_STATE_DIR`;
const linux = process.platform === 'linux';
const inside = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};
/** A directory beside the test machine, never made: what a real home or state dir stands for here. */
const standIn = () => join(dirname(testMachine), `not-the-test-machine-${randomBytes(4).toString('hex')}`);

/**
 * The probe a scratch child runs: it wraps node:fs, node:fs/promises and node:child_process before the engine loads,
 * so each path is recorded and any outside `allowed` is refused before the real call; then it runs the positive
 * controls and stateDir(), and prints what happened.
 */
const PROBE = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [osUrl, pathsUrl, allowedJson, control, outsideControl, pollutionJson] = process.argv.slice(2);
const allowed = JSON.parse(allowedJson);
// #786: names put on Object.prototype just for the stateDir() call, as a polluting dependency would set them.
const pollution = JSON.parse(pollutionJson || '{}');
const touched = [];
const ok = (p) => allowed.some((d) => { const r = relative(d, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); });
const pathOf = (a) => (typeof a === 'string' ? a : a instanceof URL ? fileURLToPath(a) : Buffer.isBuffer(a) ? a.toString() : null);
const TWO = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync']);
const seen = new Set();
for (const [kind, mod] of [['fs', fs], ['fsp', fsp], ['fsp', fs.promises]]) {
  for (const name of Object.keys(mod)) {
    const real = mod[name];
    if (typeof real !== 'function' || /^[A-Z]/.test(name) || seen.has(real)) continue;
    const wrapped = function (...args) {
      const at = name.startsWith('symlink') ? [1] : TWO.has(name) ? [0, 1] : [0];
      for (const i of at) {
        const p = pathOf(args[i]);
        if (p === null) continue;
        const abs = resolve(p);
        touched.push(abs);
        if (!ok(abs)) throw Object.assign(new Error('refused by the probe: ' + kind + '.' + name + ' ' + abs), { code: 'EACCES' });
      }
      return real.apply(this, args);
    };
    seen.add(wrapped);
    mod[name] = wrapped;
  }
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[name] = (...args) => { touched.push('child_process.' + name + ' ' + String(args[0])); throw new Error('refused by the probe: child_process.' + name); };
}
syncBuiltinESMExports();
const os = await import(osUrl);
const paths = await import(pathsUrl);
// Positive controls: a call of this probe's, and one of the engine's own (fileAccess: statSync, a named import).
fs.existsSync(control);
os.fileAccess(control);
let refusedOutside = false;
try { fs.existsSync(outsideControl); } catch { refusedOutside = true; }
let result = null, error = null;
for (const [k, v] of Object.entries(pollution)) Object.prototype[k] = v;
try { result = os.stateDir(); } catch (e) { error = { name: e.name, message: e.message }; }
for (const k of Object.keys(pollution)) delete Object.prototype[k];
console.log(JSON.stringify({ sign: paths.testRunSign(), result, error, touched, refusedOutside }));
`;

interface Probe {
  sign: string | null;
  result: string | null;
  error: { name: string; message: string } | null;
  touched: string[];
  refusedOutside: boolean;
}

/**
 * Runs stateDir() in a scratch child with `env` (and `pollution` on Object.prototype for the call); checks the
 * controls and that nothing outside the test machine was touched.
 */
function probe(env: NodeJS.ProcessEnv, outside: string, pollution: Record<string, string> = {}): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'state-probe-'));
  writeFileSync(join(dir, 'probe.mjs'), PROBE);
  const control = join(dir, 'control');
  const url = (p: string) => pathToFileURL(join(repoRoot, 'dist', 'src', 'os', p)).href;
  // Allowed: the test machine, and the engine's own built modules (node's loader reads them through node:fs).
  const dist = join(repoRoot, 'dist', 'src');
  const r = spawnSync(process.execPath, [join(dir, 'probe.mjs'), url('index.js'), url('system-paths.js'), JSON.stringify([testMachine, dist]), control, join(outside, 'control'), JSON.stringify(pollution)], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout) as Probe;
  // The controls: the wrappers saw this probe's call and the engine's own, and refused a path outside.
  assert.equal(out.touched.filter((p) => p === control).length, 2, `both controls recorded: ${out.touched.join(', ')}`);
  assert.equal(out.refusedOutside, true, 'a path outside the test machine is refused by the probe');
  // Nothing outside the test machine was touched but the engine's modules, loaded (the refused control is recorded,
  // never run).
  assert.deepEqual(out.touched.filter((p) => p !== testMachine && !inside(testMachine, p) && !(inside(dist, p) && p.endsWith('.js')) && p !== join(outside, 'control')), [], 'nothing outside the test machine');
  out.touched = out.touched.filter((p) => !inside(dist, p));
  return out;
}

/**
 * A test run's child, as the engine starts one (childEnv: no NODE_TEST_CONTEXT, so it is a test run by TEST_RUN_VAR
 * alone): this process's environment (its test machine, root and mark), with `set` applied.
 */
const testRunEnv = (set: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
};

test('in a test run, every fall-through of stateDir() that lands outside the test machine is refused before anything is opened; inside it is not (#815)', { skip: !linux && 'the HOME fall-through checked here is the Linux one' }, () => {
  const outside = standIn();
  const home = join(outside, 'home');
  const cases: [string, Record<string, string | undefined>, string][] = [
    [`${STATE} outside the test machine`, { [STATE]: join(outside, 'state') }, join(outside, 'state')],
    [`${STATE} unset, XDG_STATE_HOME outside`, { [STATE]: undefined, XDG_STATE_HOME: join(outside, 'xdg') }, join(outside, 'xdg', BRAND.cli)],
    [`${STATE} and XDG_STATE_HOME unset, HOME a real home's`, { [STATE]: undefined, XDG_STATE_HOME: undefined, HOME: home }, join(home, '.local', 'state', BRAND.cli)],
  ];
  for (const [what, set, dir] of cases) {
    const r = probe(testRunEnv(set), outside);
    assert.notEqual(r.sign, null, `${what}: a test run`);
    assert.equal(r.result, null, `${what}: no state dir`);
    assert.equal(r.error?.name, 'TestStateRefused', what);
    assert.ok(r.error!.message.includes(`${dir} is outside ${testMachine}`), `${what}: ${r.error!.message}`);
    assert.match(r.error!.message, new RegExp(`set ${STATE} to a directory of the test's own`), what);
    assert.equal(r.touched.some((p) => p.startsWith(outside) && p !== join(outside, 'control')), false, `${what}: never opened`);
  }
  // The same fall-throughs inside the test machine resolve as before.
  const ownHome = isolatedEnv.HOME!;
  const allowed: [string, Record<string, string | undefined>, string][] = [
    [`${STATE} inside`, {}, isolatedEnv[STATE]!],
    [`${STATE} unset, XDG_STATE_HOME inside`, { [STATE]: undefined }, join(isolatedEnv.XDG_STATE_HOME!, BRAND.cli)],
    [`${STATE} and XDG_STATE_HOME unset, the test's HOME`, { [STATE]: undefined, XDG_STATE_HOME: undefined, HOME: ownHome }, join(ownHome, '.local', 'state', BRAND.cli)],
  ];
  for (const [what, set, dir] of allowed) {
    const r = probe(testRunEnv(set), outside);
    assert.equal(r.error, null, `${what}: ${r.error?.message}`);
    assert.equal(r.result, dir, what);
  }
  // A service mode's child (no system root, serviceModeEnv): its state dir inside the test machine, as before; outside it, refused.
  const service = probe(serviceModeEnv(testRunEnv({})), outside);
  assert.equal(service.error, null, service.error?.message);
  assert.equal(service.result, isolatedEnv[STATE]);
  const serviceOut = probe(serviceModeEnv(testRunEnv({ [STATE]: join(outside, 'state') })), outside);
  assert.equal(serviceOut.error?.name, 'TestStateRefused');
  // A test run whose child lost the test machine (a stray environment): refused, even for a directory inside it.
  const stray = probe(testRunEnv({ [TEST_MACHINE_VAR]: undefined }), outside);
  assert.equal(stray.error?.name, 'TestStateRefused');
  assert.match(stray.error!.message, new RegExp(`${TEST_MACHINE_VAR} is unset`));
});

test('#786: a state-dir variable or a test-run mark on Object.prototype neither moves the state dir nor un-refuses it', { skip: !linux && 'the Linux fall-throughs' }, () => {
  const outside = standIn();
  const ownHome = isolatedEnv.HOME!;
  // Each polluted value names a place inside the test machine, so the engine would accept it there, and nothing
  // outside the machine is ever touched (the probe's wrappers refuse that).
  const forged = join(testMachine, `polluted-${randomBytes(4).toString('hex')}`);
  const run = (set: Record<string, string | undefined>, pollution: Record<string, string>) => {
    const r = probe(testRunEnv(set), outside, pollution);
    return r.error ? `refused: ${r.error.name}` : r.result;
  };
  const seen = {
    // <PREFIX>_STATE_DIR unset: the XDG_STATE_HOME fall-through, not the prototype's value.
    stateVar: run({ [STATE]: undefined }, { [STATE]: forged }),
    // Both unset: the test's HOME, not the prototype's XDG_STATE_HOME.
    xdgVar: run({ [STATE]: undefined, XDG_STATE_HOME: undefined, HOME: ownHome }, { XDG_STATE_HOME: forged }),
    // A test run's child (TEST_RUN_VAR, its own) that lost its test machine stays refused when the prototype names one.
    machineMark: run({ [TEST_RUN_VAR]: '1', [TEST_MACHINE_VAR]: undefined }, { [TEST_MACHINE_VAR]: testMachine }),
    // Nor when the prototype carries the machine, its root and this run's token, none of them set.
    allMarks: run({ [TEST_RUN_VAR]: '1', [TEST_MACHINE_VAR]: undefined, [SYSTEM_ROOT_VAR]: undefined, [TEST_TOKEN_VAR]: undefined }, { [TEST_MACHINE_VAR]: testMachine, [SYSTEM_ROOT_VAR]: isolatedEnv[SYSTEM_ROOT_VAR]!, [TEST_TOKEN_VAR]: process.env[TEST_TOKEN_VAR]! }),
  };
  assert.deepEqual(seen, {
    stateVar: join(isolatedEnv.XDG_STATE_HOME!, BRAND.cli),
    xdgVar: join(ownHome, '.local', 'state', BRAND.cli),
    machineMark: 'refused: TestStateRefused',
    allMarks: 'refused: TestStateRefused',
  });
});

test('outside a test run stateDir() is what it always was: each fall-through as before, nothing refused and nothing opened (#815)', { skip: !linux && 'the Linux fall-throughs' }, () => {
  const outside = standIn();
  const home = join(outside, 'home');
  // A service's environment: built from scratch, nothing of a test run in it.
  const clean = { PATH: process.env.PATH, HOME: home };
  const cases: [string, NodeJS.ProcessEnv, string][] = [
    [STATE, { ...clean, [STATE]: join(outside, 'state') }, join(outside, 'state')],
    ['XDG_STATE_HOME', { ...clean, XDG_STATE_HOME: join(outside, 'xdg') }, join(outside, 'xdg', BRAND.cli)],
    ['HOME', clean, join(home, '.local', 'state', BRAND.cli)],
  ];
  for (const [what, env, dir] of cases) {
    const r = probe(env, outside);
    assert.equal(r.sign, null, `${what}: not a test run`);
    assert.equal(r.error, null, `${what}: ${r.error?.message}`);
    assert.equal(r.result, dir, what);
    // Only the controls: resolving the state dir opened nothing at all.
    assert.equal(r.touched.length, 3, `${what}: ${r.touched.join(', ')}`);
  }
});

test('in this test process the state dir is the test machine\'s, and one pointed outside it is refused (#815)', () => {
  assert.equal(stateDir(), isolatedEnv[STATE]);
  const elsewhere = standIn();
  try {
    process.env[STATE] = elsewhere;
    assert.throws(() => stateDir(), (e: Error) => e.name === 'TestStateRefused' && e.message.includes(`${elsewhere} is outside ${testMachine}`));
    process.env[STATE] = testMachine;
    assert.throws(() => stateDir(), (e: Error) => e.name === 'TestStateRefused', 'the machine directory itself is not a state dir inside it');
  } finally {
    restoreIsolated(STATE);
  }
  assert.equal(stateDir(), isolatedEnv[STATE]);
});

test('a symlink inside the test machine never leads the state or slot dir out of it: refused, the link never followed (#818)', { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
  const engine = { argv: [process.execPath, join(repoRoot, 'dist', 'src', 'cli.js')], execArgv: [] as string[] };
  const uid = process.getuid!();
  const marked = { PATH: '/usr/bin', NODE_TEST_CONTEXT: 'child-v8', [TEST_MACHINE_VAR]: testMachine, [SYSTEM_ROOT_VAR]: isolatedEnv[SYSTEM_ROOT_VAR], [TEST_TOKEN_VAR]: process.env[TEST_TOKEN_VAR] };
  const base = mkdtempSync(join(tmpdir(), 'link-'));
  // A dangling link to a stand-in outside the machine (never made), and one to a directory inside it.
  symlinkSync(join(standIn(), 'state'), join(base, 'out'));
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'in'));
  for (const [what, dir] of [['a link out, then below it', join(base, 'out', 'state')], ['the link itself', join(base, 'out')], ['a link to inside', join(base, 'in', 'state')]] as const) {
    assert.match(testStateRefusal(dir, marked, engine, uid) ?? '', /is a symlink: no path inside the test machine may lead out of it/, what);
    assert.match(testSlotsRefusal(dir, marked, engine, uid) ?? '', /is a symlink: no path inside the test machine may lead out of it/, `slots: ${what}`);
  }
  // A `..` after a link goes up from the link's target: written with one, the dir is refused, whatever follows (#818
  // round 3). Built as raw strings: join() would fold the `..` away.
  for (const dir of [`${join(base, 'out')}/../state`, `${join(base, 'in')}/../slots`, `${join(base, 'real')}/../real`]) {
    assert.match(testStateRefusal(dir, marked, engine, uid) ?? '', /has a '\.\.' part/, dir);
    assert.match(testSlotsRefusal(dir, marked, engine, uid) ?? '', /has a '\.\.' part/, `slots: ${dir}`);
  }
  // No link on the way: as before, whether the dir exists or not.
  assert.equal(testStateRefusal(join(base, 'real', 'state'), marked, engine, uid), null);
  assert.equal(testSlotsRefusal(join(base, 'real'), marked, engine, uid), null);
  // stateDir() itself, in a scratch child behind the probe's wrappers: refused, and nothing outside the machine touched.
  const r = probe(testRunEnv({ [STATE]: join(base, 'out', 'state') }), dirname(readlinkSync(join(base, 'out'))));
  assert.equal(r.error?.name, 'TestStateRefused');
  assert.match(r.error!.message, /is a symlink/);
});

test('testStateRefusal: never outside a test run, whatever the directory; in one, only inside a marked test machine (#815)', { skip: process.platform === 'win32' && 'POSIX owners and modes' }, () => {
  const engine = { argv: [process.execPath, join(repoRoot, 'dist', 'src', 'cli.js'), 'coordinator', 'run'], execArgv: [] as string[] };
  // Strings only: outside a test run nothing is looked at.
  const clean: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/example' };
  for (const dir of ['/home/example/.local/state/x', '/var/lib/x', '/']) assert.equal(testStateRefusal(dir, clean, engine), null, dir);
  // A test run without the isolation: refused before the machine is looked at.
  const inTest = { ...clean, NODE_TEST_CONTEXT: 'child-v8' };
  assert.match(testStateRefusal('/home/example/.local/state/x', inTest, engine) ?? '', new RegExp(`${TEST_MACHINE_VAR} is unset`));
  const uid = process.getuid!();
  const marked = { ...inTest, [TEST_MACHINE_VAR]: testMachine, [SYSTEM_ROOT_VAR]: isolatedEnv[SYSTEM_ROOT_VAR], [TEST_TOKEN_VAR]: process.env[TEST_TOKEN_VAR] };
  assert.equal(testStateRefusal(join(testMachine, 'u', 'state'), marked, engine, uid), null);
  assert.match(testStateRefusal(join(testMachine, '..', 'x'), marked, engine, uid) ?? '', /is outside/);
  assert.match(testStateRefusal(testMachine, marked, engine, uid) ?? '', /is outside/, 'the machine itself');
  assert.match(testStateRefusal(join(testMachine, 'u', 'state'), { ...marked, [TEST_TOKEN_VAR]: 'b'.repeat(64) }, engine, uid) ?? '', /isn't this run's test machine: .*doesn't match its test mark/);
  // A service mode a test starts runs without the system root (serviceModeEnv): the machine's own mark shows it is the
  // test machine, for the state dir only.
  const rootless = { ...marked, [SYSTEM_ROOT_VAR]: undefined };
  assert.equal(testStateRefusal(join(testMachine, 'u', 'state'), rootless, engine, uid), null);
  assert.match(testStateRefusal(join(testMachine, '..', 'x'), rootless, engine, uid) ?? '', /is outside/);
  assert.match(testStateRefusal(join(testMachine, 'u', 'state'), { ...rootless, [TEST_TOKEN_VAR]: 'b'.repeat(64) }, engine, uid) ?? '', /doesn't match its own test mark/);
  assert.match(testStateRefusal(join(testMachine, 'u', 'state'), { ...rootless, [TEST_TOKEN_VAR]: undefined }, engine, uid) ?? '', /doesn't carry the test preload's token/);
  // As the root's mark: never in a process systemd started, never as root (#818 round 2).
  for (const k of ['INVOCATION_ID', 'JOURNAL_STREAM']) {
    assert.match(testStateRefusal(join(testMachine, 'u', 'state'), { ...rootless, [k]: 'c'.repeat(32) }, engine, uid) ?? '', new RegExp(`systemd started this process \\(${k} is set\\)`), k);
  }
  // Checked before the machine is looked at, so it is this refusal, not the machine's owner, that says no (#818 round 3).
  assert.match(testStateRefusal(join(testMachine, 'u', 'state'), rootless, engine, 0) ?? '', new RegExp(`isn't this run's test machine: ${SYSTEM_ROOT_VAR} is unset, and this process runs as root`), 'as root');
  // A stray value naming a directory of this user's alone (as a home is), with no mark of its own, is no machine.
  const stray = mkdtempSync(join(tmpdir(), 'stray-machine-'));
  chmodSync(stray, 0o700);
  assert.match(testStateRefusal(join(stray, 'state'), { ...rootless, [TEST_MACHINE_VAR]: stray }, engine, uid) ?? '', /holds no test mark of its own/);
  assert.match(testStateRefusal(join(stray, 'state'), { ...marked, [TEST_MACHINE_VAR]: stray }, engine, uid) ?? '', /doesn't hold the test preload's system root/);
  // The slot dir never takes the machine's own mark: without the root it is refused, as before.
  assert.match(testSlotsRefusal(join(testMachine, 'u', 'agent-slots'), rootless, engine, uid) ?? '', /doesn't hold the test preload's system root/);
  // The slot refusal, which now shares this code, says exactly what it said before.
  assert.equal(
    testSlotsRefusal('/var/lib/agent-slots', inTest, engine),
    `this is a test run (NODE_TEST_CONTEXT is set), and the slot directory isn't the test machine's: ${TEST_MACHINE_VAR} is unset, so the test isolation isn't loaded. Run tests with the isolation preloaded (node --import ./dist/test/isolate.js --test <file>, or npm test), or pass a directory of the test's own.`,
  );
  assert.match(testSlotsRefusal(undefined, marked, engine, uid) ?? '', /: AGENT_SLOTS_DIR is unset, so it would be the machine's own\. Run tests/);
});
