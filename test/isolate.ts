// Every test process gets a machine of its own: a temporary home, state dir, agent-slot directory and temporary
// directory, and none of the machine's own engine settings (issues #312, #604). It is removed when the process exits. Every way the suite runs preloads it (TEST_PRELOAD below: npm test,
// the CI shards, the touched-tests check; test/isolate.test.ts checks each), so a test file gets it without importing
// anything, before any of its modules reads the environment. A test file's process without it stops at once
// (test/helpers.ts).
//
// WHY: the suite runs on machines that already run the engine (the release runs `npm test` on one). Through the
// defaults, a test read and wrote the person's own state dir (~/.local/state/<cli>, ~/Library/Application Support/<cli>),
// the machine's slot directory (/var/lib/<cli>/agent-slots when it exists, with its STOP file and cap) and whatever
// <PREFIX>_* the shell had set, so a live instance could change a test's result and a test could change the instance's
// state. Here those all point into a fresh temporary directory, whatever the shell said. So do the machine's own
// locations (src/os/system-paths.ts: /etc/<cli>, /var/lib/<cli>, the root helpers in /usr/local/libexec, /opt/<cli>,
// /run/lock): on a live machine a test read the real machine owners, helper, updates log and settings.
import type * as Cp from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BRAND } from '../src/brand.js';
import { SYSTEMD_MARKERS, SYSTEM_ROOT_VAR, TEST_MACHINE_VAR, TEST_MARK_FILE, TEST_TOKEN_VAR } from '../src/os/system-paths.js';

/** Engine settings that only tune speed, kept from the shell (a slow CI runner scales the browser's timeouts). */
const KEEP = new Set([`${BRAND.envPrefix}_BROWSER_TIMEOUT_SCALE`]);
for (const k of Object.keys(process.env)) {
  if ((k.startsWith(`${BRAND.envPrefix}_`) && !KEEP.has(k)) || k.startsWith('AGENT_SLOTS_')) delete process.env[k];
}

/**
 * This test process's machine: everything below is inside it, the temporary directory too. A test process a test
 * starts (a preloaded runner, a CLI) makes its own inside this one's temporary directory, so its parent's exit
 * removes it even when it was killed.
 *
 * INVARIANT: the name stays short. Each nested level adds `/tm-XXXXXX/t` (12 bytes) to every path under tmpdir(),
 * and a Unix socket's path is at most 107 bytes: Chrome binds one 45 bytes under TMPDIR (test/isolate.test.ts
 * measures both levels).
 */
export const testMachine = mkdtempSync(join(tmpdir(), 'tm-'));
// WHY: a test's own temporary directories (mkdtempSync(join(tmpdir(), …)), in some 300 files) went to the system's,
// and nothing removed them: thousands piled up in /tmp (#604). os.tmpdir() reads these on every call; TMP and TEMP
// are what Windows reads, and what some tools read instead.
const tmp = join(testMachine, 't');
// Another user passes through to what a test makes there, as through /tmp (the separate-users tests have the agent
// user read a task file under tmpdir()): the machine and its temporary directory are traverse-only for others.
// INVARIANT: the home, state, slots and system root stay this user's alone, behind `own` (0700), as the whole
// machine was before (test/isolate.test.ts checks both).
chmodSync(testMachine, 0o711);
mkdirSync(tmp);
chmodSync(tmp, 0o711);
const own = join(testMachine, 'u');
mkdirSync(own, { mode: 0o700 });
const home = join(own, 'home');

/**
 * Whether HOME itself moves. Not on macOS: headless Chrome there never answers a navigation with a fresh home
 * (browser-run and browser-check time out after 90 s), so each default the engine derives from the home is moved
 * one by one instead: XDG_*, the state dir and the tool prefix below.
 */
export const homeMoved = process.platform !== 'darwin';

/** What the isolation sets: each a directory inside testMachine. */
export const isolatedEnv: Readonly<Record<string, string>> = Object.freeze({
  ...(homeMoved ? { HOME: home } : { [`${BRAND.envPrefix}_PREFIX`]: join(home, '.local') }),
  ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  [`${BRAND.envPrefix}_STATE_DIR`]: join(own, 'state'),
  [`${BRAND.envPrefix}_MACHINE_INIT_DIR`]: join(own, 'machine-init'),
  AGENT_SLOTS_DIR: join(own, 'agent-slots'),
  [SYSTEM_ROOT_VAR]: join(own, 'root'),
  TMPDIR: tmp,
  TMP: tmp,
  TEMP: tmp,
});
for (const [k, v] of Object.entries(isolatedEnv)) {
  mkdirSync(v, { recursive: true });
  process.env[k] = v;
}
// The machine itself, for what the engine refuses to use outside it in a test process: the slot directory
// (src/os/index.ts slotsDir, #669). It counts only with the system root below and its mark (testSlotsRefusal).
process.env[TEST_MACHINE_VAR] = testMachine;

// The mark that lets this process and its children use the system root above (src/os/system-paths.ts
// systemRootRefusal): a fresh token, in the environment and in a file of this user's alone inside the root. A suite
// run inside a service (a coordinator testing a PR) inherits systemd's markers; they say nothing about a test, and
// would refuse the root, so they are dropped here.
for (const k of SYSTEMD_MARKERS) delete process.env[k];
const systemRoot = isolatedEnv[SYSTEM_ROOT_VAR]!;
chmodSync(systemRoot, 0o700);
const token = randomBytes(32).toString('hex');
writeFileSync(join(systemRoot, TEST_MARK_FILE), `${token}\n`, { mode: 0o600 });
// The same mark in the machine itself: a service mode a test starts has no system root (serviceModeEnv), and shows
// its test machine to the state dir's refusal with this one (src/os/system-paths.ts testStateRefusal, #815).
writeFileSync(join(testMachine, TEST_MARK_FILE), `${token}\n`, { mode: 0o600 });
process.env[TEST_TOKEN_VAR] = token;

/**
 * Put these variables back to this process's isolated values, after a test pointed them somewhere of its own.
 * Never `delete` one of them (test/isolate.test.ts checks): unset, it falls back to the machine's own directory.
 */
export function restoreIsolated(...keys: string[]): void {
  for (const k of keys) {
    const v = isolatedEnv[k];
    if (v === undefined) throw new Error(`${k} is not one of the isolated variables`);
    process.env[k] = v;
  }
}

/**
 * A machine location as a real machine has it (/etc/<cli>/…), from the one this process uses (inside the test's
 * system root): for the checks that the engine and the root scripts name the same file.
 */
export function onRealMachine(p: string): string {
  const r = relative(isolatedEnv[SYSTEM_ROOT_VAR]!, p);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) throw new Error(`${p} is not inside the test's system root`);
  return `/${r.split(sep).join('/')}`;
}

process.on('exit', () => {
  try {
    rmSync(testMachine, { recursive: true, force: true });
  } catch {
    // best effort: a temporary directory left behind is harmless
  }
});

/**
 * An environment for a service mode a test starts (`dashboard --hub`, `--hub-setup --service`): those never run
 * with the system root (src/os/system-paths.ts serviceModeRefusal), so it is left out. Only for a mode that reads no
 * machine location. The token stays: with the machine's own mark it shows the state dir's refusal this is still the
 * test machine (testStateRefusal, #815); without the root it moves nothing (systemRootRefusal reads it only with one).
 */
export function serviceModeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out[SYSTEM_ROOT_VAR];
  return out;
}

/** How a runner loads this: node's own flags, before --test (relative to the repo root, where every runner runs). */
export const TEST_PRELOAD = ['--import', './dist/test/isolate.js'] as const;

/** Set in this process once the isolation ran; test/helpers.ts refuses to load in a test file's process without it. */
export const ISOLATED = Symbol.for('test-isolation');
(globalThis as Record<symbol, unknown>)[ISOLATED] = testMachine;

// ---- No test reaches a real host tool (#991) ----
//
// WHY: a test of a root script runs it as this user with a PATH that ends in the machine's /usr/bin, so every host tool
// the script calls that the test forgot to stand in is the real one. Since #904, test/add-project.test.ts asked the
// machine's real `sudo -H -u <coordinator>` on every fresh run (it stood in run_as but not as_user_argv). Standing in
// each tool in each test is a rule a test can forget; an opt-in module with a lint left routes open (#997 round 1). So
// it is done here, in the preload every test process runs, before any test module imports node:child_process.
//
// INVARIANT: in every test process (POSIX), node:child_process's spawn, spawnSync, execFile, execFileSync, exec,
// execSync and fork (execFile's and exec's promisified forms too, and every caller of them: the engine's
// src/os/child-process.ts reads the live exports), and process.execve, start their child with:
//   - first on its PATH, a directory of recording stand-ins for each name that PATH would find a machine host tool
//     under: a host tool's own name (HOST_TOOL_NAMES), or any name whose real path is one (sudoedit -> sudo,
//     reboot -> systemctl), in a directory that isn't the test's own (inside this test machine or the repo), or a
//     test's own file whose real path leaves them. Relative and empty entries are resolved against the child's cwd
//     first. A tool the machine lacks stays missing; a test's own stand-in answers;
//   - for a host tool given by path outside the test's own directories, whoever asked (a test file, the engine's own
//     code, a vm frame, a module outside the repo): as the file, fork's execPath, a `shell` option, process.execve's
//     file, or a whole argument (`env /usr/bin/sudo`, `timeout 5 /usr/bin/sudo`, `X=/usr/bin/sudo`), a refusal
//     (thrown) when the stack names a test file and its stand-in otherwise (doctor runs gitleaks by path); as a word of
//     a command line (a -c script, exec's line), a refusal whoever asked;
//   - a refusal for `env -i` (or `-u PATH`) with no PATH=, `command -p` and a login shell, each when a host tool's name
//     is a word of the command line (a path that only ends in one, ~/.config/gh, is not), and in argument form also
//     behind a wrapper (`timeout 5 env -i sudo`, `nice bash -lc ...`); the stand-ins first in a PATH= given to `env`
//     as an argument, there too;
//   - off CI, no GITHUB_ACTIONS (dropped from its environment, emptied in env's assignments).
// Arguments that aren't strings are made strings, as Node makes them, before any of this.
// Each stand-in records its call (hostCalls()) and exits 1, as a tool that can't answer; it runs nothing else.
// process.binding's spawn_sync and process_wrap are refused. The pinned exceptions, never-grow, hold only while this
// process's environment had GITHUB_ACTIONS=true when this preload ran (the gate main's acceptance runs use), and only
// for process.argv[1]'s test file when node ran no code of its own before it (no -e/-p, no --import, --require or
// loader but this preload, in argv or NODE_OPTIONS); a stack frame's name never keys them. The file in
// REAL_HOST_TOOLS_ON_PURPOSE starts its children untouched, and machineTool() hands the CI acceptance runs in
// MACHINE_TOOLS_ON_PURPOSE the machine's own tool, found on this process's PATH as loaded; off CI it gives the
// stand-in. So a run whose environment lacks GITHUB_ACTIONS=true never takes a real tool through them.
//
// LIMIT: what a child does with its own PATH is its own. A script that sets PATH itself (several root scripts export
// /usr/sbin:/usr/bin:...; claude-account.sh appends /usr/sbin; worklane-testrun.sh and ci-runner/reset.sh reset it),
// an inline PATH= in a command line (`env PATH=/usr/bin sudo` in a shell line, `PATH=/usr/bin:/bin; sudo`), a login
// shell or `env -i` whose command line names no host tool (it calls a function that does), or a tool named by path
// inside a script file, finds the machine's tool past this. A child Node process without this preload inherits the
// stand-ins on its PATH but none of the refusals, and a PATH it sets itself gets no stand-ins. So does code that runs
// before this preload (an --import or --require ahead of it keeps the raw functions), code that replaces these
// builtins or patches the exports after load, a Worker (its own module instances), child_process.ChildProcess used
// directly, or a link to a tool under another name whose real path is no machine host tool's (a copy, not a link).
// The stack decides only whether a by-path argument is refused or stood in. A run whose environment says
// GITHUB_ACTIONS=true (CI, or anyone who sets it) holds the exceptions, as main's acceptance runs do; there a test can
// start `node --import ./dist/test/isolate.js <a pinned test file>` and that file runs with its exceptions, as it would
// on its own. Off CI, a command line that names GITHUB_ACTIONS is refused, but a script file that sets it is its own.
// `id` and `getent` are not stood in: they only read the user database, and scripts use their answers.

/**
 * Every host tool a test must never run for real: test/host-tools.ts HOST_TOOLS but gitleaks, and more. gitleaks
 * only reads the files it is given, and the secret-scan tests run the real one (CI installs it).
 */
// check-table: never-shrink
export const HOST_TOOL_NAMES = [
  'systemctl', 'launchctl', 'loginctl', 'systemd-run', 'journalctl',
  'sudo', 'su', 'runuser', 'doas', 'pkexec',
  'useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'gpasswd', 'chpasswd', 'visudo',
  'nft', 'iptables', 'setfacl',
  'gh', 'docker', 'tailscale', 'claude',
] as const;

/**
 * The test files that start their children untouched: setup-scripts.test.ts's CI-only acceptance runs lib.sh's run_as
 * through real passwordless sudo, and creates users and units with it (it skips where `sudo -n` asks for a password).
 * A loosening (#991): it may only shrink.
 */
// check-table: never-grow
export const REAL_HOST_TOOLS_ON_PURPOSE: readonly string[] = Object.freeze(['test/setup-scripts.test.ts']);

/**
 * `<test file> <tool>`: a CI acceptance run that means the machine's own tool, through machineTool(<tool>), skipped
 * where it can't answer. Each was a real call before #991. A loosening: it may only shrink.
 */
// check-table: never-grow
export const MACHINE_TOOLS_ON_PURPOSE: readonly string[] = Object.freeze([
  'test/engine-update.test.ts sudo',
  'test/frozen-guard.test.ts sudo',
  'test/machine-helper.test.ts visudo',
  'test/separate-users.test.ts sudo',
  'test/watchdog.test.ts systemctl',
]);

const POSIX = process.platform !== 'win32';
const SELF = fileURLToPath(import.meta.url);
/** The repo: this file runs as <repo>/dist/test/isolate.js (or <repo>/test/isolate.ts). */
const REPO = (() => {
  const up = dirname(dirname(SELF));
  return basename(up) === 'dist' ? dirname(up) : up;
})();
const TOOLS = new Set<string>(HOST_TOOL_NAMES);
const REAL = new Set(REAL_HOST_TOOLS_ON_PURPOSE);
const MACHINE = new Set(MACHINE_TOOLS_ON_PURPOSE);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);
/** Where a machine keeps its tools, besides any PATH: to know its own tools wherever a test's PATH points. */
const MACHINE_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
/** This process's PATH as the shell gave it, before any test changes it. */
const PATH_AT_LOAD = process.env.PATH ?? '';
/** Whether this process runs on CI, as this preload found it (a test can't turn the exceptions on later). */
const ON_CI = process.env.GITHUB_ACTIONS === 'true';
/** The test file this process runs (test/x.test.ts), from its own argv as this preload found it; null if none. */
const TEST_FILE = (() => {
  const main = process.argv[1];
  if (!main) return null;
  // argv[1] is this process's main module only when node ran no code of its own first: no -e/-p, and no --import,
  // --require or loader but this preload's own (#997 round 4: `node --import isolate --import x.mjs <pinned file>`
  // or `-e '...' <pinned file>` borrowed a pinned file's exceptions). NODE_OPTIONS too.
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)];
  let ours = 0;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    const [name, inline] = f.startsWith('--') && f.includes('=') ? [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)] : [f, undefined];
    if (['-e', '--eval', '-p', '--print', '-i', '--interactive'].includes(name) || /^-[a-zA-Z]*[epi]$/.test(name) && !name.startsWith('--')) return null;
    if (['--import', '--require', '-r', '--loader', '--experimental-loader'].includes(name)) {
      const target = inline ?? flags[++i] ?? '';
      const isSelf = name === '--import' && !/^[a-z]+:/i.test(target) ? resolve(target) === SELF : target.startsWith('file:') && fileURLToPath(target) === SELF;
      if (!isSelf || ++ours > 1) return null;
    }
  }
  const rel = relative(REPO, resolve(main)).split(sep).join('/');
  const built = /^dist\/(test\/.+\.test)\.js$/.exec(rel);
  return built ? `${built[1]}.ts` : null;
})();

/** The stand-ins: inside this test machine, made on first use, one directory per set of tools. */
export const standInRoot = join(testMachine, 'host-tools');
const callLog = join(standInRoot, 'calls.log');
const recorder = join(standInRoot, 'record.cjs');

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const within = (p: string, root: string) => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const OWN_ROOTS = [...new Set([testMachine, REPO].flatMap((r) => [r, realOr(r)]))];
/** A path that is the test's own: inside this test machine or the repo. */
const isOwn = (p: string) => isAbsolute(p) && OWN_ROOTS.some((r) => within(resolve(p), r));
const executable = (f: string) => {
  try {
    if (!statSync(f).isFile()) return false;
    accessSync(f, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const findOn = (tool: string, dirs: readonly string[]) => {
  for (const d of dirs) if (executable(join(d, tool))) return join(d, tool);
  return null;
};
/** The machine's own directories: this process's PATH as loaded (not the test's own), then MACHINE_DIRS. */
const machineDirs = () => [...new Set([...PATH_AT_LOAD.split(':').filter((d) => isAbsolute(d) && !isOwn(d)), ...MACHINE_DIRS])];
let machineReal: Map<string, string> | null = null;
/** The real path of each host tool the machine has, to its name. */
const machineTools = () => {
  if (!machineReal) {
    // Every copy the machine's directories hold, not only the first a PATH finds.
    machineReal = new Map();
    for (const d of machineDirs()) {
      for (const t of HOST_TOOL_NAMES) if (executable(join(d, t))) machineReal.set(realOr(join(d, t)), t);
    }
  }
  return machineReal;
};
/** The host tools a non-own directory holds (read once: tests don't write outside their own). */
const dirTools = new Map<string, readonly string[]>();
const toolsIn = (dir: string) => {
  let t = dirTools.get(dir);
  if (!t) dirTools.set(dir, (t = [...new Set([...HOST_TOOL_NAMES.filter((n) => executable(join(dir, n))), ...aliasesIn(dir)])]));
  return t;
};
/**
 * The names in `dir` that are a machine host tool under another name (sudoedit -> sudo, reboot -> systemctl): an
 * executable link whose real path is one (#997 round 4). Read again whenever the directory changes.
 */
const aliasCache = new Map<string, { mtime: number; names: readonly string[] }>();
function aliasesIn(dir: string): readonly string[] {
  let mtime: number;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const hit = aliasCache.get(dir);
  if (hit && hit.mtime === mtime) return hit.names;
  const machine = machineTools();
  const names: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    // unreadable: none known
  }
  for (const n of entries) {
    if (TOOLS.has(n) || /[\s'"\\]/.test(n)) continue;
    const f = join(dir, n);
    try {
      if (!lstatSync(f).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (machine.has(realOr(f)) && executable(f)) names.push(n);
  }
  aliasCache.set(dir, { mtime, names });
  return names;
}

/** Whether `file` (absolute) is a host tool outside the test's own directories: by its name or its real path. */
export function hostToolPath(file: string): boolean {
  const r = realOr(file);
  if (isOwn(file) && isOwn(r)) return false;
  return TOOLS.has(basename(file)) || TOOLS.has(basename(r)) || machineTools().has(r);
}

/** The directory of stand-ins for exactly `tools` (made once). */
function standInsFor(tools: readonly string[]): string {
  if (!existsSync(callLog)) {
    for (const p of [process.execPath, recorder]) if (p.includes("'")) throw new Error(`#991: a stand-in can't name ${p} (a quote in it)`);
    mkdirSync(standInRoot, { recursive: true });
    writeFileSync(recorder, `require('node:fs').appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ tool: process.argv[2], args: process.argv.slice(3) }) + '\\n');\nprocess.exit(1);\n`);
    writeFileSync(callLog, '');
  }
  const dir = join(standInRoot, createHash('sha256').update(tools.join('\n')).digest('hex').slice(0, 12));
  if (!existsSync(dir)) {
    const tmp = `${dir}.${process.pid}.tmp`;
    mkdirSync(tmp, { recursive: true });
    // /bin/sh and node by its absolute path: a stand-in records even where the child's PATH has no node on it.
    for (const t of tools) {
      writeFileSync(join(tmp, t), `#!/bin/sh\nexec '${process.execPath}' '${recorder}' '${t}' "$@"\n`);
      chmodSync(join(tmp, t), 0o755);
    }
    renameSync(tmp, dir);
  }
  return dir;
}

/** Every call a stand-in took in this test process, in order. */
export function hostCalls(): { tool: string; args: string[] }[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: string[] });
}

/**
 * The PATH a child gets for `path` (none: the default a child searches, /usr/bin:/bin) started in `cwd`: relative and
 * empty entries resolved against `cwd`, and first, stand-ins for each host tool it would find on the machine.
 */
export function withHostStandIns(path: string | undefined, cwd: string): string {
  const entries = (path ?? '/usr/bin:/bin').split(':').map((e) => (e === '' ? cwd : resolve(cwd, e)));
  // Each name a host tool goes by here (its own, or an alias's), as the first entry that has it finds it.
  const seen = new Set<string>();
  const shadow: string[] = [];
  for (const e of entries) {
    if (isOwn(e)) {
      for (const t of new Set([...HOST_TOOL_NAMES, ...aliasesIn(e)])) {
        const f = join(e, t);
        if (seen.has(t) || !executable(f)) continue;
        seen.add(t);
        if (!isOwn(realOr(f))) shadow.push(t);
      }
    } else {
      for (const t of toolsIn(e)) if (!seen.has(t)) (seen.add(t), shadow.push(t));
    }
  }
  return (shadow.length ? [standInsFor(shadow.sort()), ...entries] : entries).join(':');
}

function refuse(what: string): never {
  throw new Error(`#991: ${what}. A test never reaches the machine's own host tools (test/isolate.ts); a CI acceptance run that means one names it with machineTool, pinned in MACHINE_TOOLS_ON_PURPOSE.`);
}

/** The test file that called in (test/x.test.ts), or the repo path of the first caller outside this file; null if none. */
function callerFile(): string | null {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 50;
    Error.prepareStackTrace = (_e, sites) => sites;
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder, callerFile);
    for (const s of (holder.stack as NodeJS.CallSite[] | undefined) ?? []) {
      const f = s.getFileName();
      if (!f || f.startsWith('node:')) continue;
      const p = f.startsWith('file:') ? fileURLToPath(f) : f;
      if (p === SELF) continue;
      const rel = relative(REPO, p).split(sep).join('/');
      const built = /^dist\/(test\/.+)\.js$/.exec(rel);
      return built ? `${built[1]}.ts` : rel;
    }
    return null;
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
}

/**
 * What machineTool(`tool`) gives in a process running `testFile`, on CI or not, with `path` as its PATH when the
 * preload ran: a refusal for a file MACHINE_TOOLS_ON_PURPOSE doesn't pin; off CI, the tool's stand-in; on CI, the
 * machine's own, found on that PATH alone (its entries that aren't the test's own, as a bare name found it before
 * #991: never more), or the bare name where it has none, which a child resolves through the stand-ins.
 */
export function machineToolFor(tool: string, testFile: string | null, onCi: boolean, path: string): { kind: 'refused' | 'stand-in' | 'machine'; file: string } {
  if (testFile === null || !MACHINE.has(`${testFile} ${tool}`)) return { kind: 'refused', file: tool };
  if (!onCi || !TOOLS.has(tool)) return { kind: 'stand-in', file: join(standInsFor([...HOST_TOOL_NAMES].sort()), TOOLS.has(tool) ? tool : 'sudo') };
  return { kind: 'machine', file: findOn(tool, path.split(':').filter((d) => isAbsolute(d) && !isOwn(d))) ?? tool };
}
/** The machine's own paths machineTool handed out: started untouched (on CI, in the pinned file's process). */
const issued = new Set<string>();

/**
 * The machine's own `tool`, by its absolute path, for a pinned CI acceptance run (MACHINE_TOOLS_ON_PURPOSE, keyed to
 * this process's test file; refused for any other). Off CI, its stand-in. On CI with none on this process's PATH, the
 * bare name, so the run skips as on a machine without it.
 */
export function machineTool(tool: string): string;
/**
 * The same pin, for engine code the run calls (it starts `tool` by name): while `run` runs (synchronously), a child
 * started by that name gets the machine's own (on CI); every other host tool is still a stand-in. Returns what `run`
 * returns.
 */
export function machineTool<T>(tool: string, run: () => T): T;
export function machineTool<T>(tool: string, run?: () => T): string | T {
  const got = machineToolFor(tool, TEST_FILE, ON_CI, PATH_AT_LOAD);
  if (got.kind === 'refused') refuse(`machineTool('${tool}') in ${TEST_FILE ?? 'a process with no test file'}, which MACHINE_TOOLS_ON_PURPOSE doesn't pin`);
  if (got.kind === 'machine' && got.file.includes('/')) issued.add(got.file);
  if (!run) return got.file;
  if (got.kind !== 'machine') return run();
  const had = byName.has(tool);
  byName.add(tool);
  try {
    return run();
  } finally {
    if (!had) byName.delete(tool);
  }
}
/** The tools a pinned machineTool(tool, run) lets through by name, while its run runs (on CI). */
const byName = new Set<string>();

/** A shell option word that takes the script next (-c, -lc, -ec ...). */
const SCRIPT_OPTION = /^-[a-zA-Z]*c[a-zA-Z]*$/;
/**
 * A command line's words, as a shell splits them: on blanks and its operators, a quoted part staying in its word (a
 * message that mentions `sudo -u` is one word). The quoted script after -c is a command line of its own: its words
 * too. $( and ` split as operators, so `$(sudo x)` gives `sudo`.
 */
function shellWords(text: string): string[] {
  const out: string[] = [];
  let word = '';
  const flush = () => {
    if (word) out.push(word);
    word = '';
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      const body = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      if (word === '' && SCRIPT_OPTION.test(out.at(-1) ?? '')) out.push(...shellWords(body));
      else word += body;
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (/[\s;&|()<>`!{}]/.test(c)) flush();
    else word += c;
    i++;
  }
  flush();
  return out;
}
/** The words of an argument list: each argument one word, but the script after -c split as a command line. */
const argWords = (argv: readonly string[]) => argv.flatMap((a, i) => (i > 0 && SCRIPT_OPTION.test(argv[i - 1]!) ? shellWords(a) : [a]));
/**
 * Whether a host tool's name is a word of a command line, wherever it stands (`if sudo`, `! sudo`, `timeout 5 sudo`,
 * `env -i sudo`). A path that only ends in one (~/.config/gh) is not: its word is the whole path.
 */
const namesHostTool = (ws: readonly string[]) => ws.some((w) => TOOLS.has(w.replace(/^\$/, '')));
/** The words (or an assignment's value) that are a host tool by path outside the test's own directories. */
const hostToolPaths = (ws: readonly string[], cwd: string) =>
  ws.map((w) => w.replace(/^[A-Za-z_]\w*=/, '')).filter((w) => w.includes('/') && !/\s/.test(w) && hostToolPath(resolve(cwd, w)));

/** A shell's own options, up to its script (-c's argument) or its first operand. */
function shellOptions(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (/^[-+]o$/.test(a) || /^-[a-zA-Z]*o$/.test(a)) {
      out.push(a);
      i++;
      continue;
    }
    if (!/^(-[a-zA-Z]+|--[a-z-]+)$/.test(a)) break;
    out.push(a);
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) break;
  }
  return out;
}

/** Refuses a shell command line that would search past the stand-ins for a host tool it names. */
function checkShellLine(form: string, text: string, options: readonly string[], ws: readonly string[]): void {
  if (!namesHostTool(ws)) return;
  const at = '(^|[\\s;&|(`\'"])';
  const login = options.some((o) => o === '--login' || /^-[a-zA-Z]*l[a-zA-Z]*$/.test(o)) || new RegExp(`${at}(\\S*/)?(ba|da|z|k|a)?sh\\s+(-[a-zA-Z]+\\s+)*(-[a-zA-Z]*l[a-zA-Z]*|--login)(\\s|$)`).test(text);
  const pathless = new RegExp(`${at}command\\s+-[a-zA-Z]*p`).test(text);
  const envI = new RegExp(`${at}(\\S*/)?env\\s+(-\\S+\\s+)*(-[a-zA-Z]*i[a-zA-Z]*|--ignore-environment|-)(\\s|$)`).test(text) && !/(^|\s)PATH=/.test(text);
  if (login) refuse(`${form}: a login shell (its profile sets PATH) for a command line that names a host tool`);
  if (pathless) refuse(`${form}: command -p (the default PATH) for a command line that names a host tool`);
  if (envI) refuse(`${form}: env -i with no PATH for a command line that names a host tool`);
}

/** env's arguments, each PATH= given the stand-ins; refuses a cleared PATH for a command that names a host tool. */
function envArguments(form: string, argv: string[], cwd: string): string[] {
  const out = [...argv];
  let i = 0;
  let clears = false;
  let split = '';
  while (i < out.length) {
    const a = out[i]!;
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-' || a === '-i' || a === '--ignore-environment') clears = true;
    else if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(a)) {
      if ((a === '-u' || a === '--unset') && out[i + 1] === 'PATH') clears = true;
      if (a === '-S' || a === '--split-string') split = out[i + 1] ?? '';
      i += 2;
      continue;
    } else if (a === '-uPATH' || a === '--unset=PATH') clears = true;
    else if (a.startsWith('--split-string=') || /^-S./.test(a)) split = a.replace(/^(--split-string=|-S)/, '');
    else if (/^-[a-zA-Z]+$/.test(a)) clears ||= a.includes('i');
    else if (!a.startsWith('--')) break;
    i++;
  }
  let path = false;
  for (; i < out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[i]!); i++) {
    // Off CI, env can't tell its command it is on CI either.
    if (!ON_CI && out[i]!.startsWith('GITHUB_ACTIONS=')) out[i] = 'GITHUB_ACTIONS=';
    if (!out[i]!.startsWith('PATH=')) continue;
    out[i] = `PATH=${withHostStandIns(out[i]!.slice(5), cwd)}`;
    path = true;
  }
  const rest = out.slice(i);
  const text = [split, ...rest].join(' ');
  if (clears && !path && namesHostTool([...shellWords(split), ...argWords(rest)])) refuse(`${form} env: a cleared PATH (env -i or -u PATH) and no PATH= for ${rest[0] ?? split}, which names a host tool`);
  if (rest.length && SHELLS.has(basename(rest[0]!))) checkShellLine(form, rest.slice(1).join(' '), shellOptions(rest.slice(1)), argWords(rest.slice(1)));
  return out;
}

type Options = Record<string, unknown>;

/**
 * What a child starts with, or null to start it untouched (a file in REAL_HOST_TOOLS_ON_PURPOSE, or a pinned
 * machineTool run). `line`: `command` is a shell command line (exec, execSync), not a file.
 */
function guard(form: string, command: unknown, args: readonly unknown[], options: unknown, line: boolean): { file: string; args: string[]; options: Options } | null {
  if (typeof command !== 'string') return null; // Node refuses a file that isn't a string, as before
  if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) return null;
  // The pinned file's own process, on CI: untouched, as before #991 (keyed to the process, not to a stack frame).
  if (ON_CI && TEST_FILE !== null && REAL.has(TEST_FILE)) return null;
  // Arguments as Node makes them: never left untouched for not being strings (a numeric uid, a port).
  let argv = args.map((a) => (typeof a === 'string' ? a : String(a)));
  const caller = callerFile();
  const fromTest = caller === null || caller.startsWith('test/');
  const o = (options ?? {}) as Options;
  if (!line && ON_CI && byName.size && byName.has(command) && !o.shell) return null;
  const cwd = typeof o.cwd === 'string' ? resolve(o.cwd) : o.cwd instanceof URL ? fileURLToPath(o.cwd) : process.cwd();
  /** A host tool by path: null when it is none; the pinned machine path, untouched; else refused, or its stand-in. */
  const byPath = (given: string): string | null => {
    const path = resolve(cwd, given);
    if (!hostToolPath(path)) return null;
    if (ON_CI && issued.has(given)) return given;
    const real = realOr(path);
    const tool = [basename(path), basename(real)].find((n) => TOOLS.has(n)) ?? machineTools().get(real) ?? basename(path);
    // A test file is told; the engine's own code (doctor resolving gitleaks on PATH, say) gets the stand-in, as it
    // would by name.
    if (fromTest || !TOOLS.has(tool)) refuse(`${form} ${given}: the machine's own ${tool}, by path`);
    return join(standInsFor([...HOST_TOOL_NAMES].sort()), tool);
  };
  let file = command;
  const shellOption = typeof o.shell === 'string' && o.shell.includes('/') ? byPath(o.shell) : null;
  if (shellOption !== null && issued.has(shellOption)) return null;
  const shell = line || Boolean(o.shell);
  /** Refuses a command line (a -c script, exec's line) with a host tool by path among its words, whoever asked. */
  const lineByPath = (text: string) => {
    const named = hostToolPaths(shellWords(text), cwd);
    if (named.length) refuse(`${form}: ${named[0]} in its command line: the machine's own ${basename(named[0]!)}, by path`);
    // Off CI, a command line can't tell what it starts that it is on CI (the CI-only exceptions).
    if (!ON_CI && /\bGITHUB_ACTIONS\b/.test(text)) refuse(`${form}: a command line that sets GITHUB_ACTIONS, off CI`);
  };
  if (shell) {
    const text = [command, ...argv].join(' ');
    checkShellLine(form, text, [], shellWords(text));
    lineByPath(text);
  } else {
    if (command.includes('/')) {
      const swapped = byPath(command);
      if (swapped !== null && issued.has(swapped)) return null; // the pinned acceptance run, as it was
      if (swapped !== null) file = swapped;
    }
    // env or a shell anywhere in the argument list, behind timeout, nice, setsid or the like, as at its head: each
    // checked, and a PATH= handed to env given the stand-ins (#997 round 4).
    let all = [command, ...argv];
    for (let i = 0; i < all.length; i++) {
      const name = basename(all[i]!);
      const rest = all.slice(i + 1);
      if (name === 'env') all = [...all.slice(0, i + 1), ...envArguments(form, rest, cwd)];
      else if (SHELLS.has(name)) checkShellLine(form, rest.join(' '), shellOptions(rest), argWords(rest));
    }
    // A host tool by path in the arguments, for every caller (#997 round 4): inside a -c script, refused; as a whole
    // argument (env <path>, timeout 5 <path>, X=<path>), refused for a test file and its stand-in for the engine.
    argv = all.slice(1).map((a, i, list) => {
      if (i > 0 && SCRIPT_OPTION.test(list[i - 1]!)) {
        lineByPath(a);
        return a;
      }
      const prefix = /^[A-Za-z_]\w*=/.exec(a)?.[0] ?? '';
      const value = a.slice(prefix.length);
      if (!value.includes('/') || /\s/.test(value)) return a;
      const swapped = byPath(value);
      return swapped === null ? a : `${prefix}${swapped}`;
    });
  }
  const env = (o.env || process.env) as Record<string, string | undefined>;
  const childEnv = Object.assign(Object.create(Object.getPrototypeOf(env) as object | null) as Record<string, string | undefined>, env);
  childEnv.PATH = withHostStandIns(env.PATH, cwd);
  // Off CI, no child is told it is on CI: none of the CI-only exceptions can start in a process a test starts here.
  if (!ON_CI && env.GITHUB_ACTIONS !== undefined) childEnv.GITHUB_ACTIONS = undefined;
  const extra: Options = { env: childEnv };
  if (shellOption !== null) extra.shell = shellOption;
  const childOptions = Object.assign(Object.create(Object.getPrototypeOf(o) as object | null) as Options, o, extra);
  return { file, args: argv, options: childOptions };
}

/** (args?, options?) as Node reads them; null when Node would refuse them (then the call goes to Node untouched). */
function argsAndOptions(a: unknown, b: unknown): [readonly unknown[], unknown] | null {
  if (Array.isArray(a)) return [a, b];
  if (a == null) return [[], b];
  if (typeof a === 'object') return [[], a];
  return null;
}
/** (args?, options?, callback?) as execFile reads them. */
function execFileArgs(a: unknown, b: unknown, c: unknown): [readonly unknown[], unknown, unknown] | null {
  if (typeof a === 'function') return [[], undefined, a];
  if (a != null && typeof a === 'object' && !Array.isArray(a)) return [[], a, b];
  if (typeof b === 'function') return Array.isArray(a) || a == null ? [a ?? [], undefined, b] : null;
  return Array.isArray(a) || a == null ? [a ?? [], b, c] : null;
}

type Fn = (this: unknown, ...a: unknown[]) => unknown;
if (POSIX) {
  const cp = createRequire(import.meta.url)('node:child_process') as typeof Cp & Record<string, unknown>;
  const raw = { spawn: cp.spawn as Fn, spawnSync: cp.spawnSync as Fn, execFile: cp.execFile as Fn, execFileSync: cp.execFileSync as Fn, exec: cp.exec as Fn, execSync: cp.execSync as Fn, fork: cp.fork as Fn };
  const custom = promisify.custom as symbol;
  // Node's own promisified forms ({ stdout, stderr }, the child on the promise), from the real functions.
  const rawExecFileP = promisify(cp.execFile) as unknown as Fn;
  const rawExecP = promisify(cp.exec) as unknown as Fn;
  const byArgs = (form: 'spawn' | 'spawnSync' | 'execFileSync') =>
    function (this: unknown, command: unknown, a?: unknown, b?: unknown) {
      const n = argsAndOptions(a, b);
      // Null options: spawn and spawnSync refuse them (left to Node, untouched); execFileSync reads them as none.
      const g = n && !(form !== 'execFileSync' && n[1] === null) && guard(form, command, n[0], n[1] ?? undefined, false);
      return g ? raw[form].call(this, g.file, g.args, g.options) : raw[form].call(this, command, a, b);
    };
  // `promised`: the promisified form, which takes no callback (an extra argument would hide promisify's own).
  const execFileWith = (to: Fn, promised: boolean) =>
    function (this: unknown, file: unknown, a?: unknown, b?: unknown, c?: unknown) {
      const n = execFileArgs(a, b, c);
      const g = n && guard('execFile', file, n[0], n[1], false);
      if (!g) return promised ? to.call(this, file, ...[a, b].filter((x) => x !== undefined)) : to.call(this, file, a, b, c);
      return promised ? to.call(this, g.file, g.args, g.options) : to.call(this, g.file, g.args, g.options, n![2]);
    };
  const execWith = (to: Fn, promised: boolean) =>
    function (this: unknown, command: unknown, a?: unknown, b?: unknown) {
      const [options, callback] = typeof a === 'function' ? [undefined, a] : [a, b];
      const g = guard('exec', command, [], options, true);
      if (!g) return promised ? to.call(this, command, ...[a].filter((x) => x !== undefined)) : to.call(this, command, a, b);
      return promised ? to.call(this, command, g.options) : to.call(this, command, g.options, callback);
    };
  const execFile = execFileWith(raw.execFile, false);
  Object.defineProperty(execFile, custom, { value: execFileWith(rawExecFileP, true), enumerable: false });
  const exec = execWith(raw.exec, false);
  Object.defineProperty(exec, custom, { value: execWith(rawExecP, true), enumerable: false });
  Object.assign(cp, {
    spawn: byArgs('spawn'),
    spawnSync: byArgs('spawnSync'),
    execFileSync: byArgs('execFileSync'),
    execFile,
    exec,
    execSync: function (this: unknown, command: unknown, options?: unknown) {
      const g = guard('execSync', command, [], options, true);
      return g ? raw.execSync.call(this, command, g.options) : raw.execSync.call(this, command, options);
    },
    fork: function (this: unknown, modulePath: unknown, a?: unknown, b?: unknown) {
      const n = argsAndOptions(a, b);
      // fork starts options.execPath (node by default): judged as the command.
      const execPath = (n?.[1] as Options | undefined)?.execPath;
      const g = n && guard('fork', typeof execPath === 'string' ? execPath : process.execPath, [], n[1], false);
      if (!g) return raw.fork.call(this, modulePath, a, b);
      if (typeof execPath === 'string' && g.file !== execPath) g.options.execPath = g.file;
      return raw.fork.call(this, modulePath, n![0], g.options);
    },
  });
  syncBuiltinESMExports();
  // process.execve (Node 22.15+) replaces this process with another program: judged as a spawn would be.
  const proc = process as unknown as { execve?: (file: string, args?: readonly string[], env?: Record<string, string | undefined>) => never };
  const rawExecve = proc.execve;
  if (typeof rawExecve === 'function') {
    proc.execve = function (file: string, args: readonly string[] = [], env: Record<string, string | undefined> = process.env) {
      const g = guard('process.execve', file, args, { env }, false);
      if (!g) return rawExecve.call(process, file, args, env);
      return rawExecve.call(process, g.file, g.args, g.options.env as Record<string, string | undefined>);
    };
  }
  const binding = process as unknown as { binding: (name: string) => unknown };
  const rawBinding = binding.binding;
  binding.binding = function (name: string) {
    if (name === 'spawn_sync' || name === 'process_wrap') refuse(`process.binding('${name}') starts a process past the stand-ins`);
    return rawBinding.call(process, name);
  };
}

/** For a test that must not import this module's names (test/script-host-tools.test.ts runs at commits without them). */
(globalThis as Record<symbol, unknown>)[Symbol.for('test-host-tools')] = Object.freeze({
  installed: POSIX,
  onCi: ON_CI,
  testFile: TEST_FILE,
  machineToolFor,
  standInRoot,
  hostCalls,
  hostToolPath,
  withHostStandIns,
  HOST_TOOL_NAMES,
  REAL_HOST_TOOLS_ON_PURPOSE,
  MACHINE_TOOLS_ON_PURPOSE,
});
