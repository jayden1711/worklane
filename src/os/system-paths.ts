// The machine's own locations: everything the engine reads or runs outside a checkout and a user's home, in one place.
// /etc/<cli> (machine owners, network, updates, slots, limits, the watchdog, signers), /var/lib/<cli> (the machine's
// state: changes, updates log, the Claude account, the init lock, the agent slots), /usr/local/libexec/<cli>-* (the
// root helpers), /opt/<cli> (the installed engine), /run/lock (the full-run lock), /run/<cli> (the GPU test runs'
// locks), and the systemd unit directory.
//
// WHY: the release runs `npm test` on a machine that runs the engine (#312). A test that read the real
// /etc/<cli>/machine-owners.json, the real helper, or the real updates log got the machine's answer, not the test's.
// test/isolate.ts sets <PREFIX>_SYSTEM_ROOT to a fresh temporary directory, so under the suite every one of these is
// inside it; test/isolate.test.ts checks every constant built here and that src/ names none of these roots elsewhere.
//
// INVARIANT: every such path in src/ is built by systemPath(); unset (every real machine), each is the path itself.
// Moving the root can only point the engine at files somewhere else: it never widens what root's helpers allow
// (sudo runs only the real helper paths its rules name, with its own environment).
//
// THREAT: whoever can set a coordinator's or the hub's environment (a drop-in unit, a sudo that keeps the
// environment) must not be able to use the variable to swap in another machine owners file, network.json or CA.
// So it is honoured only in a process the test preload marked (systemRootRefusal): never as root, never in a process
// systemd started, and only with the preload's per-run token, which must match the mark file inside the root, a
// directory and file of this user's alone. Everywhere else the engine refuses to run (src/os/system-root-guard.ts:
// a non-zero exit naming the variable, before anything starts), and systemPath() throws, so no import can read a
// moved path either. The service modes refuse it even in a marked process (serviceModeRefusal).
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BRAND } from '../brand.js';

/** The variable that moves every system location under one directory (tests only; test/isolate.ts). */
export const SYSTEM_ROOT_VAR = `${BRAND.envPrefix}_SYSTEM_ROOT`;
/** The test preload's per-run token: 64 hex characters, also written to TEST_MARK_FILE inside the root. */
export const TEST_TOKEN_VAR = `${BRAND.envPrefix}_TEST_ISOLATION`;
export const TEST_MARK_FILE = '.test-isolation';
/** The test preload's machine: the directory that holds this test process's home, state, slots and system root. */
export const TEST_MACHINE_VAR = `${BRAND.envPrefix}_TEST_MACHINE`;
/**
 * Set in the environment of a test run, and so of every process it starts that keeps the environment (markTestRun):
 * a child a test starts is a test run too, even one that drops NODE_TEST_CONTEXT (childEnv) or that node's runner
 * didn't start.
 */
export const TEST_RUN_VAR = `${BRAND.envPrefix}_TEST_RUN`;
/** Set by systemd in every process a unit starts (and inherited by its children). */
export const SYSTEMD_MARKERS = ['INVOCATION_ID', 'JOURNAL_STREAM'] as const;

export class SystemRootRefused extends Error {
  override name = 'SystemRootRefused';
}

/** A slot directory a test run may not use (testSlotsRefusal): thrown by slotsDir() before anything is opened. */
export class TestSlotsRefused extends Error {
  override name = 'TestSlotsRefused';
}

/** A state directory a test run may not use (testStateRefusal): thrown by stateDir() before anything is opened. */
export class TestStateRefused extends Error {
  override name = 'TestStateRefused';
}

const currentUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/**
 * Why <PREFIX>_SYSTEM_ROOT may not be honoured in this process, or null when it may (unset, or a test process the
 * preload marked). INVARIANT: an allowlist: only the preload's mark makes it honoured; root and systemd never.
 */
export function systemRootRefusal(env: NodeJS.ProcessEnv = process.env, uid: number | null = currentUid()): string | null {
  const root = env[SYSTEM_ROOT_VAR];
  if (!root) return null;
  const no = (why: string) => `${SYSTEM_ROOT_VAR} is set (${root}), and ${why}. It is honoured only in a test process the test preload marked (test/isolate.ts): unset it.`;
  if (uid === 0) return no('this process runs as root');
  const sd = SYSTEMD_MARKERS.find((k) => env[k] !== undefined);
  if (sd) return no(`systemd started this process (${sd} is set)`);
  const token = env[TEST_TOKEN_VAR];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return no(`${TEST_TOKEN_VAR} doesn't carry the test preload's token`);
  if (!isAbsolute(root)) return no('it is not an absolute path');
  const posix = process.platform !== 'win32';
  try {
    const d = lstatSync(root);
    if (!d.isDirectory() || (posix && ((uid !== null && d.uid !== uid) || (d.mode & 0o022) !== 0))) return no("its directory isn't this user's alone");
    const mark = join(root, TEST_MARK_FILE);
    const f = lstatSync(mark);
    if (!f.isFile() || (posix && ((uid !== null && f.uid !== uid) || (f.mode & 0o077) !== 0))) return no("its test mark isn't this user's alone");
    if (readFileSync(mark, 'utf8').trim() !== token) return no(`${TEST_TOKEN_VAR} doesn't match its test mark`);
  } catch {
    return no('it holds no test mark');
  }
  return null;
}

type Proc = { argv: readonly string[]; execArgv: readonly string[] };

/**
 * Why this process counts as a test run, or null when it doesn't (every real machine's engine): node's test runner
 * started it (NODE_TEST_CONTEXT in a file's process, --test in the runner's own), its main module is a test file, the
 * test preload marked it, or a test run started it (TEST_RUN_VAR, markTestRun). The engine never starts itself any of
 * these ways, and never sets one of these variables outside a test run.
 */
export function testRunSign(env: NodeJS.ProcessEnv = process.env, proc: Proc = process): string | null {
  if (env.NODE_TEST_CONTEXT !== undefined) return 'NODE_TEST_CONTEXT is set';
  if (proc.execArgv.includes('--test')) return 'node runs with --test';
  if (/\.test\.[cm]?[jt]s$/.test(proc.argv[1] ?? '')) return `its main module is a test file (${proc.argv[1]})`;
  for (const k of [TEST_RUN_VAR, TEST_TOKEN_VAR, TEST_MACHINE_VAR]) if (env[k] !== undefined) return `${k} is set`;
  return null;
}

/**
 * Marks `env` as a test run's when this process is one (testRunSign), so what is started with it is one too: a child
 * started the engine's way (childEnv drops NODE_TEST_CONTEXT), or by a test file node's runner didn't start (run
 * directly, or --experimental-test-isolation=none, where only the runner's own execArgv says --test). Outside a test
 * run (`sign`, this process's own, null) it changes nothing. Returns `env`.
 *
 * LIMIT: a child started with an environment built from scratch carries no mark, and is a test run only by how node
 * started it.
 */
export function markTestRun(env: NodeJS.ProcessEnv, sign: string | null = testRunSign()): NodeJS.ProcessEnv {
  if (sign !== null) env[TEST_RUN_VAR] = '1';
  return env;
}
// WHY: a child that inherits this process's environment (spawn without `env`) carries the mark from the start.
markTestRun(process.env);

/**
 * Why `dir` may not be this process's slot directory, or null when it may: always null outside a test run
 * (testRunSign). In a test run, only a directory inside the test machine (test/isolate.ts) is: one of this user's alone
 * that the preload names in TEST_MACHINE_VAR, and that holds the preload's system root with its mark for this run's
 * token (systemRootRefusal), so a stray TEST_MACHINE_VAR naming any directory of the user's (say, the home) is no test
 * machine. So a test file that forgot the preload, or a test that pointed AGENT_SLOTS_DIR elsewhere, fails before it
 * opens anything in the machine's own slot directory (#669): slotsDir() throws TestSlotsRefused.
 *
 * THREAT: accidents, not a hostile test: a test that builds a machine of its own (a directory, a root and a mark with
 * a token it chose) on purpose gets it. `dir` is compared as written: it may not exist yet. Each part of it that
 * exists inside the machine is lstat'ed, never followed, and a symlink among them is refused (#818), so no link in the
 * machine leads a test to a directory outside it.
 */
export function testSlotsRefusal(dir: string | undefined, env: NodeJS.ProcessEnv = process.env, proc: Proc = process, uid: number | null = currentUid()): string | null {
  return outsideTestMachine({ what: 'slot directory', unset: "AGENT_SLOTS_DIR is unset, so it would be the machine's own", fix: "pass a directory of the test's own" }, dir, env, proc, uid);
}

/**
 * Why `dir` may not be this process's state directory, or null when it may: the same rule as the slot directory's
 * (testSlotsRefusal), so stateDir() throws TestStateRefused in a test run for anything outside the test machine
 * (#815): <PREFIX>_STATE_DIR pointed elsewhere, or unset with the home's (XDG_STATE_HOME, or HOME's .local/state)
 * outside it, as in a test file run without the preload, or a test's child that inherited a real HOME. Always null
 * outside a test run: the engine's state dir is what it always was. Nothing outside the test machine is looked at:
 * the only paths lstat'ed or read are the machine's own (its directory, its system root and mark, the parts of `dir`
 * inside it).
 *
 * EXCEPTION (owner-accepted, 2026-10-19, #818): a service mode a test starts (`dashboard --hub`, `--hub-setup`) runs
 * without the system root (serviceModeRefusal; test/isolate.ts serviceModeEnv), so it can't show its test machine
 * through the root's mark. Then, and only for the state dir, the machine shows it with its own mark: the same token
 * in TEST_MARK_FILE in the machine directory itself, a file of this user's alone (test/isolate.ts writes both). As
 * with the root's mark, never as root or in a process systemd started. Without either mark: refused.
 */
export function testStateRefusal(dir: string, env: NodeJS.ProcessEnv = process.env, proc: Proc = process, uid: number | null = currentUid()): string | null {
  return outsideTestMachine({ what: 'state directory', unset: `${BRAND.envPrefix}_STATE_DIR is unset`, fix: `set ${BRAND.envPrefix}_STATE_DIR to a directory of the test's own`, rootless: true }, dir, env, proc, uid);
}

/**
 * Why `machine` doesn't carry this run's mark itself (TEST_MARK_FILE in it, of this user's alone, holding the token in
 * TEST_TOKEN_VAR), or null when it does.
 */
function machineMarkRefusal(machine: string, env: NodeJS.ProcessEnv, uid: number | null): string | null {
  const token = env[TEST_TOKEN_VAR];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return `${SYSTEM_ROOT_VAR} is unset, and ${TEST_TOKEN_VAR} doesn't carry the test preload's token`;
  const mark = join(machine, TEST_MARK_FILE);
  try {
    const f = lstatSync(mark);
    if (!f.isFile() || (process.platform !== 'win32' && ((uid !== null && f.uid !== uid) || (f.mode & 0o077) !== 0))) return `${SYSTEM_ROOT_VAR} is unset, and its own test mark isn't this user's alone`;
    if (readFileSync(mark, 'utf8').trim() !== token) return `${SYSTEM_ROOT_VAR} is unset, and ${TEST_TOKEN_VAR} doesn't match its own test mark`;
  } catch {
    return `${SYSTEM_ROOT_VAR} is unset, and it holds no test mark of its own`;
  }
  return null;
}

/** testSlotsRefusal and testStateRefusal: in a test run, a directory the engine resolved must be inside the test machine. */
function outsideTestMachine(o: { what: string; unset: string; fix: string; rootless?: boolean }, dir: string | undefined, env: NodeJS.ProcessEnv, proc: Proc, uid: number | null): string | null {
  const sign = testRunSign(env, proc);
  if (!sign) return null;
  const machine = env[TEST_MACHINE_VAR];
  const no = (why: string) => `this is a test run (${sign}), and the ${o.what} isn't the test machine's: ${why}. Run tests with the isolation preloaded (node --import ./dist/test/isolate.js --test <file>, or npm test), or ${o.fix}.`;
  if (!machine) return no(`${TEST_MACHINE_VAR} is unset, so the test isolation isn't loaded`);
  if (!isAbsolute(machine)) return no(`${TEST_MACHINE_VAR} (${machine}) is not an absolute path`);
  const root = env[SYSTEM_ROOT_VAR];
  // Before anything is looked at: the machine's own mark is never honoured as root, nor in a process systemd started,
  // as the root's mark isn't (systemRootRefusal). Native Windows has no uid: there, as on the root's route, no root check.
  if (!root && o.rootless) {
    const sd = SYSTEMD_MARKERS.find((k) => env[k] !== undefined);
    if (uid === 0) return no(`${TEST_MACHINE_VAR} (${machine}) isn't this run's test machine: ${SYSTEM_ROOT_VAR} is unset, and this process runs as root`);
    if (sd) return no(`${TEST_MACHINE_VAR} (${machine}) isn't this run's test machine: ${SYSTEM_ROOT_VAR} is unset, and systemd started this process (${sd} is set)`);
  }
  try {
    const d = lstatSync(machine);
    if (!d.isDirectory() || (process.platform !== 'win32' && ((uid !== null && d.uid !== uid) || (d.mode & 0o022) !== 0))) return no(`${TEST_MACHINE_VAR} (${machine}) isn't a directory of this user's alone`);
  } catch {
    return no(`${TEST_MACHINE_VAR} (${machine}) doesn't exist`);
  }
  if (!root && o.rootless) {
    const unmarked = machineMarkRefusal(machine, env, uid);
    if (unmarked) return no(`${TEST_MACHINE_VAR} (${machine}) isn't this run's test machine: ${unmarked}`);
  } else {
    if (!root || !inside(machine, root)) return no(`${TEST_MACHINE_VAR} (${machine}) doesn't hold the test preload's system root (${SYSTEM_ROOT_VAR})`);
    const unmarked = systemRootRefusal(env, uid);
    if (unmarked) return no(`${TEST_MACHINE_VAR} (${machine}) isn't this run's test machine: ${unmarked}`);
  }
  if (!dir) return no(o.unset);
  // A `..` after a link goes up from where the link points, not where it is written; resolve() would hide that.
  if (dir.split(/[\\/]/).includes('..')) return no(`${dir} has a '..' part: written with one, a link before it could lead out of the machine`);
  if (!inside(machine, dir)) return no(`${dir} is outside ${machine}`);
  const link = linkInside(machine, dir);
  if (link) return no(link);
  return null;
}

/**
 * Why a path inside `machine` may lead out of it, or null: a symlink at any part of it from the machine down, or a
 * part that can't be looked at. Each part is lstat'ed (never followed), only inside the machine, stopping at the
 * first one that doesn't exist yet (#818: fail closed on a link to the person's own state).
 */
function linkInside(machine: string, dir: string): string | null {
  let p = machine;
  for (const part of relative(machine, resolve(dir)).split(sep)) {
    p = join(p, part);
    try {
      if (lstatSync(p).isSymbolicLink()) return `${p} is a symlink: no path inside the test machine may lead out of it`;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      return `${p} can't be looked at (${code ?? 'error'})`;
    }
  }
  return null;
}

/** Whether `p` is strictly inside `dir`, as written (no symlink followed). */
function inside(dir: string, p: string): boolean {
  const r = relative(dir, resolve(p));
  return !(r === '' || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r));
}

let decided: { key: string; refusal: string | null } | null = null;

/** `p` (an absolute system path) on this machine: itself, or under <PREFIX>_SYSTEM_ROOT when that is honoured here. */
export function systemPath(p: string): string {
  if (!p.startsWith('/')) throw new Error(`systemPath: ${p} is not absolute`);
  const root = process.env[SYSTEM_ROOT_VAR];
  if (!root) return p;
  const key = [root, process.env[TEST_TOKEN_VAR], ...SYSTEMD_MARKERS.map((k) => process.env[k])].join('\0');
  if (decided?.key !== key) decided = { key, refusal: systemRootRefusal() };
  if (decided.refusal) throw new SystemRootRefused(decided.refusal);
  return join(root, p);
}

/**
 * Why this command line may not run with <PREFIX>_SYSTEM_ROOT set at all, marked or not: the long-lived modes the
 * machine's units run (scripts/setup/service.sh, dashboards.sh, and `up`'s user units): `coordinator run` (one pass,
 * --once, is a command that ends, which tests run), an instance's dashboard (--instance … --service), the hub (--hub)
 * and its setup mode (--hub-setup). Null for any
 * other command. A checkout's dashboard (`dashboard --service --root <dir>`, which `dashboard --detach` starts in the
 * person's own session) is none: every unit's dashboard is an instance's (--instance) or the hub's.
 */
export function serviceModeRefusal(argv: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env[SYSTEM_ROOT_VAR]) return null;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' || argv[i] === '--instance') i++;
    else args.push(argv[i]!);
  }
  const [cmd, sub] = args;
  const mode = cmd === 'coordinator' && sub === 'run' && !args.includes('--once') ? 'coordinator run' : cmd === 'dashboard' ? (['--hub', '--hub-setup'].find((f) => args.includes(f)) ?? (args.includes('--service') && argv.includes('--instance') ? '--instance --service' : undefined)) : undefined;
  return mode ? `${SYSTEM_ROOT_VAR} is set, and \`${cmd === 'dashboard' ? `dashboard ${mode}` : mode}\` is a service mode, which never runs with it: unset it.` : null;
}

/** The roots below, as the real machine has them (the lint in test/isolate.test.ts looks for these in src/). */
export const SYSTEM_ROOTS = {
  etc: `/etc/${BRAND.cli}`,
  varLib: `/var/lib/${BRAND.cli}`,
  libexec: '/usr/local/libexec',
  opt: `/opt/${BRAND.cli}`,
  runLock: '/run/lock',
  run: `/run/${BRAND.cli}`,
  units: '/etc/systemd/system',
  varTmp: '/var/tmp',
} as const;

/** /etc/<cli>/<name> */
export const etcPath = (name: string) => systemPath(`${SYSTEM_ROOTS.etc}/${name}`);
/** /var/lib/<cli>/<name> */
export const varLibPath = (name: string) => systemPath(`${SYSTEM_ROOTS.varLib}/${name}`);
/** /usr/local/libexec/<cli>-<name>: a root helper. */
export const libexecPath = (name: string) => systemPath(`${SYSTEM_ROOTS.libexec}/${BRAND.cli}-${name}`);
/** /opt/<cli>/<name>: the installed engine. */
export const optPath = (name: string) => systemPath(`${SYSTEM_ROOTS.opt}/${name}`);
/** /run/lock/<cli>-<name> */
export const runLockPath = (name: string) => systemPath(`${SYSTEM_ROOTS.runLock}/${BRAND.cli}-${name}`);
/** /run/<cli>/<name>: root's runtime files every user may read (the GPU test runs' locks). */
export const runPath = (name: string) => systemPath(`${SYSTEM_ROOTS.run}/${name}`);
/** /run/<cli>-mcp-<instance>: the instance's MCP broker's sockets (its unit's RuntimeDirectory). */
export const mcpRunPath = (instance: string, name: string) => systemPath(`/run/${BRAND.cli}-mcp-${instance}/${name}`);
/** /var/lib/<cli>-mcp-<instance>: the broker's own state (blocked servers, the call log): its unit's StateDirectory. */
export const mcpStatePath = (instance: string, name: string) => systemPath(`/var/lib/${BRAND.cli}-mcp-${instance}/${name}`);
/** /etc/systemd/system/<unit> */
export const unitPath = (unit: string) => systemPath(`${SYSTEM_ROOTS.units}/${unit}`);
/** /srv/<cli>/<instance>/<repo name>: a server instance's checkout (scripts/setup/lib.sh SRV_ROOT, add-project.sh). */
export const srvCheckoutPath = (instance: string, repoName: string) => systemPath(`/srv/${BRAND.cli}/${instance}/${repoName}`);
/** The test-run sandbox's base (scripts/setup/testrun-sandbox.sh): beside /var/lib/<cli>, its own directory. */
export const testRunBasePath = () => systemPath(`/var/lib/${BRAND.cli}-test`);
/** /var/lib/<cli>-exp: experiment jobs' state (scripts/setup/experiments.sh), root's. */
export const expBasePath = () => systemPath(`/var/lib/${BRAND.cli}-exp`);
/** Single-user and development machines' slot directory (unbranded: every agent harness on the box shares it). */
export const devSlotsPath = () => systemPath(`${SYSTEM_ROOTS.varTmp}/agent-slots`);

/**
 * The same locations as root sees them, never moved: only for text that tells a person what to run as root, or what
 * root's helper changes (a root shell and the helper are outside the engine, so they always mean the real files). The
 * engine never opens or runs one of these; what it opens or runs is built by the functions above.
 */
export const asRoot = {
  etc: (name: string) => `${SYSTEM_ROOTS.etc}/${name}`,
  varLib: (name: string) => `${SYSTEM_ROOTS.varLib}/${name}`,
  libexec: (name: string) => `${SYSTEM_ROOTS.libexec}/${BRAND.cli}-${name}`,
  opt: (name: string) => `${SYSTEM_ROOTS.opt}/${name}`,
  run: (name: string) => `${SYSTEM_ROOTS.run}/${name}`,
} as const;
