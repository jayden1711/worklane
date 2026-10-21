// Every child process a test of a scripts/ shell script starts, started here (#991).
//
// WHY: a test of a root script (add-project.sh, credentials.sh, ...) runs it as this user with a PATH that ends in the
// machine's own /usr/bin and /bin, for bash, git and coreutils. Every host tool the script can reach is then the real
// one unless the test stood that tool in itself. #904 gave add-project.sh a second way to another user (run_as_bounded,
// through lib.sh's as_user_argv); test/add-project.test.ts stood in run_as but not that, so its fresh-install runs
// reached the machine's real `sudo -H -u <user>` (issue #991). Standing in each tool in each test is a rule a test can
// forget; here it can't be forgotten.
//
// INVARIANT: spawn, spawnSync, execFile, execFileSync and execSync here are node:child_process's, except that no host
// tool (SCRIPT_HOST_TOOLS: sudo, systemctl, useradd, claude and the like) on the child's PATH resolves to the machine's
// own. Ahead of the first PATH entry that isn't the test's own, a directory of recording stand-ins shadows each host
// tool the rest of that PATH would find; a tool the machine doesn't have stays missing, as it was. The test's own
// directories (inside this test process's machine, test/isolate.ts, or inside the repo) keep their place in front, so a
// test's own stand-in for a tool still answers, and a PATH of only its own directories is left as it is. Each stand-in
// records its call (one JSON line, hostCalls()) and exits 1, as a tool that can't answer; it runs nothing else. A test
// of a scripts/ shell script imports its child_process functions from here, never node:child_process
// (test/script-host-tools.test.ts, the backstop; its one exception is test/setup-scripts.test.ts, whose CI-only
// acceptance runs reach real sudo on purpose; a CI-only acceptance run elsewhere names its one real tool with
// machineTool, each use pinned there).
//
// LIMIT: a script that sets its own PATH (several root scripts export /usr/sbin:/usr/bin:... first thing), or that
// names a tool by its absolute path, finds the real tool past this; a test of those stands in lib.sh's functions
// instead. So does engine code that starts a tool with a fixed PATH of its own (src/testrun/host.ts takes its sudo as an
// argument for that). `id` and `getent` are not stood in: they only read the user database, and scripts use their
// answers.
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HOST_TOOLS, onPath } from './host-tools.js';
import { testMachine } from './isolate.js';
import { repoRoot } from './helpers.js';

export type { ChildProcess, ChildProcessWithoutNullStreams, SpawnSyncReturns } from 'node:child_process';

/** Every host tool a scripts/ shell script can reach that a test of it must never run for real. */
// check-table: never-shrink
export const SCRIPT_HOST_TOOLS = [
  ...HOST_TOOLS,
  'sudo', 'su', 'runuser', 'doas', 'pkexec',
  'useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'gpasswd', 'chpasswd', 'visudo',
  'systemd-run', 'journalctl', 'nft', 'iptables', 'setfacl',
  'claude',
] as const;

/** Where the stand-ins are: inside this test process's machine, made on first use, one directory per set of tools. */
export const standInRoot = join(testMachine, 'script-host-tools');
const record = join(standInRoot, 'calls.log');
const recorder = join(standInRoot, 'record.cjs');

/** The directory of stand-ins for exactly `tools` (made once). */
function standInsFor(tools: readonly string[]): string {
  if (!existsSync(record)) {
    for (const p of [process.execPath, recorder]) if (p.includes("'")) throw new Error(`a stand-in can't name ${p} (a quote in it)`);
    mkdirSync(standInRoot, { recursive: true });
    writeFileSync(
      recorder,
      `require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ tool: process.argv[2], args: process.argv.slice(3) }) + '\\n');\nprocess.exit(1);\n`,
    );
    writeFileSync(record, '');
  }
  const dir = join(standInRoot, createHash('sha256').update(tools.join('\n')).digest('hex').slice(0, 12));
  if (!existsSync(dir)) {
    mkdirSync(`${dir}.tmp`, { recursive: true });
    // /bin/sh and node by its absolute path: a stand-in records even where the child's PATH has no node on it.
    for (const t of tools) {
      writeFileSync(join(`${dir}.tmp`, t), `#!/bin/sh\nexec '${process.execPath}' '${recorder}' '${t}' "$@"\n`);
      chmodSync(join(`${dir}.tmp`, t), 0o755);
    }
    renameSync(`${dir}.tmp`, dir);
  }
  return dir;
}

/** Every call a stand-in took in this test process, in order. */
export function hostCalls(): { tool: string; args: string[] }[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: string[] });
}

const inside = (dir: string, root: string) => {
  const r = relative(root, dir);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
/** A PATH entry that is the test's own: an absolute directory inside this test process's machine or the repo. */
const own = (entry: string) => isAbsolute(entry) && (inside(resolve(entry), testMachine) || inside(resolve(entry), repoRoot));

/**
 * `path` with stand-ins, ahead of its first entry that isn't the test's own, for each host tool the entries from there
 * on would find. No PATH at all is the one a child would search then (libuv's and bash's default, /usr/bin:/bin).
 */
export function scriptPath(path: string | undefined): string {
  const entries = (path ?? '/usr/bin:/bin').split(delimiter);
  if (entries.some((e) => isAbsolute(e) && inside(resolve(e), standInRoot))) return entries.join(delimiter);
  const at = entries.findIndex((e) => !own(e));
  if (at === -1) return entries.join(delimiter);
  const rest = entries.slice(at).join(delimiter);
  const found = SCRIPT_HOST_TOOLS.filter((t) => onPath(t, rest) !== null);
  if (found.length === 0) return entries.join(delimiter);
  return [...entries.slice(0, at), standInsFor(found), ...entries.slice(at)].join(delimiter);
}

/**
 * The machine's own `tool`, by its absolute path, for a test that means the real one: an acceptance run on a disposable
 * CI runner (passwordless sudo, systemd). Found on this process's own PATH, never a stand-in. With none there, the bare
 * name, which the child's PATH resolves as for any other call (a stand-in, or nothing), so the test skips as on a
 * machine without it. A loosening: each use is pinned in test/script-host-tools.test.ts, and may only go.
 */
export function machineTool(tool: string): string {
  const machine = (process.env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d) && !inside(resolve(d), standInRoot));
  return onPath(tool, machine.join(delimiter)) ?? tool;
}

/** `env` (process.env when none) for a child: the same variables, PATH through scriptPath. */
export function scriptEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: scriptPath(env.PATH) };
}

/** `options` as Node reads them, with env through scriptEnv (Node reads `options.env || process.env`). */
function withStandIns(options: unknown): unknown {
  if (options != null && (typeof options !== 'object' || Array.isArray(options))) return options;
  const o = (options ?? {}) as { env?: NodeJS.ProcessEnv };
  return { ...o, env: scriptEnv(o.env || process.env) };
}

/** (args?, options?) as Node reads them: an object (not an array) where the arguments go is the options. */
function argsAndOptions(a: unknown, b: unknown): [unknown, unknown] {
  if (a != null && typeof a === 'object' && !Array.isArray(a)) return [[], a];
  return [a ?? [], b];
}

/** (args?, options?, callback?) as execFile reads them: a function in any of the three places is the callback. */
function execFileArgs(a: unknown, b: unknown, c: unknown): [unknown, unknown, unknown] {
  if (typeof a === 'function') return [[], undefined, a];
  if (a != null && typeof a === 'object' && !Array.isArray(a)) return [[], a, b];
  if (typeof b === 'function') return [a ?? [], undefined, b];
  return [a ?? [], b, c];
}

type Untyped = (...args: unknown[]) => unknown;

/** node:child_process's spawn, with the stand-ins on the child's PATH. */
export const spawn = ((command: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.spawn as Untyped)(command, args, withStandIns(options));
}) as unknown as typeof cp.spawn;

/** node:child_process's spawnSync, with the stand-ins on the child's PATH. */
export const spawnSync = ((command: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.spawnSync as Untyped)(command, args, withStandIns(options));
}) as unknown as typeof cp.spawnSync;

/** node:child_process's execFileSync, with the stand-ins on the child's PATH. */
export const execFileSync = ((file: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.execFileSync as Untyped)(file, args, withStandIns(options));
}) as unknown as typeof cp.execFileSync;

/** node:child_process's execFile (promisify gives { stdout, stderr }, as Node's does), with the stand-ins. */
export const execFile = ((file: string, a?: unknown, b?: unknown, c?: unknown) => {
  const [args, options, callback] = execFileArgs(a, b, c);
  return (cp.execFile as Untyped)(file, args, withStandIns(options), callback);
}) as unknown as typeof cp.execFile;
Object.defineProperty(execFile, promisify.custom, {
  enumerable: false,
  value: (file: string, a?: unknown, b?: unknown) => {
    const [args, options] = execFileArgs(a, b, undefined);
    return ((cp.execFile as unknown as Record<symbol, Untyped>)[promisify.custom]!)(file, args, withStandIns(options));
  },
});

/** node:child_process's execSync (a shell command line), with the stand-ins on the shell's PATH. */
export const execSync = ((command: string, options?: unknown) => (cp.execSync as Untyped)(command, withStandIns(options))) as unknown as typeof cp.execSync;
