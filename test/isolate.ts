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
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// src/os/child-process.ts reads the live exports) start their child with:
//   - first on its PATH, a directory of recording stand-ins for each host tool (HOST_TOOL_NAMES) that PATH would find
//     on the machine: in a directory that isn't the test's own (inside this test machine or the repo), or through a
//     test's own file whose real path leaves them (a link to the machine's tool). Relative and empty entries are
//     resolved against the child's cwd first. A tool the machine lacks stays missing; a test's own stand-in answers;
//   - for a host tool given by path outside the test's own directories: a refusal (thrown) when a test file asked, its
//     stand-in when the engine's own code did (doctor finds gitleaks on PATH and runs it by path);
//   - a refusal for `env -i` (or `-u PATH`) with no PATH, and for `command -p` or a login shell, each when the command
//     line runs a host tool as a command;
//   - the stand-ins first in any PATH handed to `env`.
// Each stand-in records its call (hostCalls()) and exits 1, as a tool that can't answer; it runs nothing else.
// process.binding's spawn_sync and process_wrap are refused. The pinned exceptions, never-grow: the files in
// REAL_HOST_TOOLS_ON_PURPOSE start their children untouched, and machineTool() hands the machine's own tool to the
// CI acceptance runs in MACHINE_TOOLS_ON_PURPOSE; both are checked against the calling file at run time.
//
// LIMIT: what a child does with its own PATH is its own. A script that sets PATH itself (several root scripts export
// /usr/sbin:/usr/bin:...; claude-account.sh appends /usr/sbin; worklane-testrun.sh and ci-runner/reset.sh reset it), a
// login shell or `env -i` whose command line names no host tool (it calls a function that does), or a script that names
// a tool by absolute path, finds the machine's tool past this. So does code that replaces these builtins or patches
// the exports after load, a Worker (its own module instances), child_process.ChildProcess used directly, or a link to a
// tool that is under no host tool's name and on no PATH. `id` and `getent` are not stood in: they only read the user
// database, and scripts use their answers.

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
    machineReal = new Map();
    for (const t of HOST_TOOL_NAMES) {
      const f = findOn(t, machineDirs());
      if (f !== null) machineReal.set(realOr(f), t);
    }
  }
  return machineReal;
};
/** The host tools a non-own directory holds (read once: tests don't write outside their own). */
const dirTools = new Map<string, readonly string[]>();
const toolsIn = (dir: string) => {
  let t = dirTools.get(dir);
  if (!t) dirTools.set(dir, (t = HOST_TOOL_NAMES.filter((n) => executable(join(dir, n)))));
  return t;
};

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
  const left = new Set<string>(HOST_TOOL_NAMES);
  const shadow: string[] = [];
  for (const e of entries) {
    if (left.size === 0) break;
    if (isOwn(e)) {
      for (const t of [...left]) {
        const f = join(e, t);
        if (!executable(f)) continue;
        left.delete(t);
        if (!isOwn(realOr(f))) shadow.push(t);
      }
    } else {
      for (const t of toolsIn(e)) if (left.delete(t)) shadow.push(t);
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
 * The machine's own `tool`, by its absolute path, for a pinned CI acceptance run (MACHINE_TOOLS_ON_PURPOSE: refused
 * from any other file). With none on the machine, the bare name, which a child resolves through the stand-ins (or not
 * at all), so the run skips as on a machine without it.
 */
export function machineTool(tool: string): string;
/**
 * The same pin, for engine code the run calls (it starts `tool` by name): while `run` runs (synchronously), a child
 * started by that name gets the machine's own; every other host tool is still a stand-in. Returns what `run` returns.
 */
export function machineTool<T>(tool: string, run: () => T): T;
export function machineTool<T>(tool: string, run?: () => T): string | T {
  const caller = callerFile();
  if (caller === null || !MACHINE.has(`${caller} ${tool}`)) refuse(`machineTool('${tool}') from ${caller ?? 'an unknown file'}, which MACHINE_TOOLS_ON_PURPOSE doesn't pin`);
  if (!run) return findOn(tool, machineDirs()) ?? tool;
  const had = byName.has(tool);
  byName.add(tool);
  try {
    return run();
  } finally {
    if (!had) byName.delete(tool);
  }
}
/** The tools a pinned machineTool(tool, run) lets through by name, while its run runs. */
const byName = new Set<string>();

/**
 * A host tool as a command in a shell command line: at its start, after ; & | ( ` $( or a quote (a script handed to
 * another shell), or after a word that runs the next one (env with its options and assignments, command, exec, sudo,
 * nohup, time, xargs, then, do, else), by name or by path. A path that only ends in a tool's name as an argument
 * (~/.config/gh) is not one.
 */
const HOST_COMMAND = new RegExp(
  `(?:^|[;&|(\`'"\\n]|\\$\\(|\\b(?:then|do|else|exec|nohup|time|xargs|sudo|command(?:\\s+-[a-zA-Z]+)*|env(?:\\s+-\\S+|\\s+[A-Za-z_]\\w*=\\S*)*))\\s*(?:/\\S*/)?(?:${HOST_TOOL_NAMES.map((t) => t.replace(/-/g, '\\-')).join('|')})(?=$|[\\s;&|)\`'"])`,
);
const namesHostTool = (text: string) => HOST_COMMAND.test(text);

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
function checkShellLine(form: string, text: string, options: readonly string[]): void {
  if (!namesHostTool(text)) return;
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
    if (!out[i]!.startsWith('PATH=')) continue;
    out[i] = `PATH=${withHostStandIns(out[i]!.slice(5), cwd)}`;
    path = true;
  }
  const rest = out.slice(i);
  const text = [split, ...rest].join(' ');
  if (clears && !path && namesHostTool(text)) refuse(`${form} env: a cleared PATH (env -i or -u PATH) and no PATH= for ${rest[0] ?? split}, which names a host tool`);
  if (rest.length && SHELLS.has(basename(rest[0]!))) checkShellLine(form, rest.slice(1).join(' '), shellOptions(rest.slice(1)));
  return out;
}

type Options = Record<string, unknown>;

/**
 * What a child starts with, or null to start it untouched (a file in REAL_HOST_TOOLS_ON_PURPOSE, or a pinned
 * machineTool run). `line`: `command` is a shell command line (exec, execSync), not a file.
 */
function guard(form: string, command: unknown, args: readonly unknown[], options: unknown, line: boolean): { file: string; args: string[]; options: Options } | null {
  if (typeof command !== 'string' || !args.every((a) => typeof a === 'string')) return null; // Node refuses it as before
  if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) return null;
  const caller = callerFile();
  if (caller !== null && REAL.has(caller)) return null;
  if (!line && byName.size && byName.has(command) && !(options as Options | undefined)?.shell) return null;
  const o = (options ?? {}) as Options;
  const cwd = typeof o.cwd === 'string' ? resolve(o.cwd) : o.cwd instanceof URL ? fileURLToPath(o.cwd) : process.cwd();
  const shell = line || Boolean(o.shell);
  let argv = args as string[];
  let file = command;
  if (shell) checkShellLine(form, [command, ...argv].join(' '), []);
  else {
    if (command.includes('/')) {
      const path = resolve(cwd, command);
      if (hostToolPath(path)) {
        const real = realOr(path);
        const tool = [basename(path), basename(real)].find((n) => TOOLS.has(n)) ?? machineTools().get(real) ?? basename(path);
        if (caller !== null && MACHINE.has(`${caller} ${tool}`)) return null;
        // A test file is told; the engine's own code (doctor resolving gitleaks on PATH, say) gets the stand-in, as it
        // would by name.
        if (caller === null || caller.startsWith('test/') || !TOOLS.has(tool)) refuse(`${form} ${command}: the machine's own ${tool}, by path`);
        file = join(standInsFor([...HOST_TOOL_NAMES].sort()), tool);
      }
    }
    const name = basename(command);
    if (name === 'env') argv = envArguments(form, argv, cwd);
    else if (SHELLS.has(name)) checkShellLine(form, argv.join(' '), shellOptions(argv));
  }
  const env = (o.env || process.env) as Record<string, string | undefined>;
  const childEnv = Object.assign(Object.create(Object.getPrototypeOf(env) as object | null) as Record<string, string | undefined>, env);
  childEnv.PATH = withHostStandIns(env.PATH, cwd);
  const childOptions = Object.assign(Object.create(Object.getPrototypeOf(o) as object | null) as Options, o, { env: childEnv });
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
      const g = n && guard('fork', process.execPath, [], n[1], false);
      return g ? raw.fork.call(this, modulePath, n![0], g.options) : raw.fork.call(this, modulePath, a, b);
    },
  });
  syncBuiltinESMExports();
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
  standInRoot,
  hostCalls,
  hostToolPath,
  withHostStandIns,
  HOST_TOOL_NAMES,
  REAL_HOST_TOOLS_ON_PURPOSE,
  MACHINE_TOOLS_ON_PURPOSE,
});
