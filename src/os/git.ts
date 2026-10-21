// The one way the engine runs git (#807).
//
// WHY: refs/replace/* and $GIT_DIR/info/grafts live in the repository, and every worktree of a repo shares them. An
// agent in its worktree can write either, and then every git the engine runs on that repo reads the agent's stand-in
// instead of the object asked for: a `git replace` of a pushed commit hid a refused file from the push limits (1
// problem became 0, measured on #802's head), and a graft can give a commit other parents, so a range reads as other
// commits. Both are on by default in git.
//
// INVARIANT: every git process the engine starts goes through a function here, and each one runs with replace refs
// off (`--no-replace-objects` before the subcommand, and GIT_NO_REPLACE_OBJECTS=1, which git passes to every git it
// runs in turn) and with no graft file (GIT_GRAFT_FILE names a path that can't exist, so $GIT_DIR/info/grafts is
// never read; `--no-replace-objects` alone still honours grafts, measured on git 2.43). The settings go on last, over
// whatever environment the caller passes, so no caller can turn them off. test/git-runner.test.ts fails on a git call
// in src/ or scripts/ that doesn't come through here (or scripts/lib/git.cjs, the same settings for scripts).
//
// LIMIT: a shallow clone's `.git/shallow` is still read (it is how a shallow clone works, and git writes it itself).
// A program the engine runs that runs git itself (gitleaks) gets these settings only when it is handed gitEnv().
//
// #926, an instance's coordinator. WHY: its checkout is agent-writable (the code is, and on installs before #926 so
// was .git/), and so are its worktrees and their gitdir links. A config file there can name a command for git to run
// (a filter, diff or merge driver, a signing program, an ssh or askpass command, a credential helper) or a host for it
// to reach (url.*.insteadOf, a proxy), and an include can pull in any file as config. The coordinator ran git there as
// itself, with its GitHub credential: a planted smudge filter ran during `git worktree add` (measured, #926).
// INVARIANT: in a process marked as an instance's (GIT_GUARD_VAR, set by service.ts instanceEnv and by auto-config),
// or for a git whose own environment carries the mark, every git started here
//   - reads no system or global config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL at the null device);
//   - gets GIT_GUARD_PAIRS at command scope, which beats every file: no credential helper, fsmonitor, editor, pager,
//     external diff, alternate-refs command, ssh or askpass command, or signing program of a file's; no ext:: transport,
//     no submodule recursion, no bundle URIs. The caller's own pairs come after, so its credential helper and hooks
//     dir (the coordinator's, in instanceEnv) are the ones in force;
//   - first reads the config git would read for that very call (`git config --list`, with the call's -C, --git-dir,
//     -c and environment) and, if a file sets anything REFUSED_KEYS names (keys no command-scope value can take back:
//     includes, URL rewrites, drivers under any name, proxies), runs no git at all: the call fails with status 128
//     and says which file and key. Fail closed: a config that can't be read is refused too.
// The settings go on last, as #807's do, so no caller's environment turns them off. Other processes (local mode, the
// owner's own commands) keep their git as it was: the owner's own config is theirs to trust.
// LIMIT: the read and the run are two processes. A config file changed in between is read by the run: closed for the
// checkout's own .git/config by scripts/setup/checkout.sh (#926: .git/ and its config are the coordinator's, not the
// agents' group's), and left open for a worktree an agent process still runs in (its .git link). remote.<name>.url is
// the checkout's own setting, never refused: checkout.sh's permissions are what keep it.
import { execFile, execFileSync, spawn, spawnSync } from './child-process.js';
import { BRAND } from '../brand.js';
import { ownEnv } from './own-env.js';
import type {
  ChildProcess,
  ChildProcessByStdio,
  ExecFileException,
  ExecFileOptions,
  ExecFileOptionsWithStringEncoding,
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithBufferEncoding,
  ExecFileSyncOptionsWithStringEncoding,
  SpawnOptions,
  SpawnOptionsWithStdioTuple,
  SpawnSyncOptions,
  SpawnSyncOptionsWithBufferEncoding,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
  StdioNull,
  StdioPipe,
} from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

/** Before every git subcommand: replace refs off for this git (git also sets GIT_NO_REPLACE_OBJECTS for the gits it runs). */
export const GIT_FIXED_ARGS: readonly string[] = Object.freeze(['--no-replace-objects']);

/**
 * On every git process, over the caller's environment. GIT_GRAFT_FILE is a path under the null device, which can't
 * exist (ENOTDIR on Linux and macOS), so git reads no graft file and says nothing about it.
 */
export const GIT_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: join(devNull, 'no-grafts'),
});

/** The mark of a process (or a git) that runs for an instance, in checkouts agents can write (#926). */
export const GIT_GUARD_VAR = `${BRAND.envPrefix}_GIT_GUARD`;

/** A program path that can't exist (as GIT_GRAFT_FILE's): a signing or verifying git fails closed, running nothing. */
const NO_PROGRAM = join(devNull, 'no-program');

/** On every guarded git, over the caller's environment: no system or global config, no prompts, no pager. */
export const GIT_GUARD_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  [GIT_GUARD_VAR]: '1',
});

/**
 * Command scope (GIT_CONFIG_COUNT), ahead of the caller's own pairs: each key a config file could set to a command,
 * set over here. credential.helper's empty value clears every helper a file named (URL-scoped ones too, measured), so
 * only one the caller adds after it is used.
 */
export const GIT_GUARD_PAIRS: readonly (readonly [string, string])[] = Object.freeze([
  ['credential.helper', ''],
  ['core.fsmonitor', 'false'],
  ['core.sshCommand', 'ssh'],
  ['core.askPass', ''],
  ['core.editor', ':'],
  ['sequence.editor', ':'],
  ['core.pager', 'cat'],
  ['core.alternateRefsCommand', ''],
  ['diff.external', ''],
  ['gpg.program', NO_PROGRAM],
  ['gpg.openpgp.program', NO_PROGRAM],
  ['gpg.x509.program', NO_PROGRAM],
  ['gpg.ssh.program', NO_PROGRAM],
  ['gpg.ssh.defaultKeyCommand', NO_PROGRAM],
  ['protocol.ext.allow', 'never'],
  ['submodule.recurse', 'false'],
  ['fetch.recurseSubmodules', 'false'],
  ['push.recurseSubmodules', 'no'],
  ['transfer.bundleURI', 'false'],
] as const);

/**
 * Keys a config file may not set at all for a guarded git, with why: no command-scope value takes them back (an
 * include adds a file, insteadOf and gitProxy are lists, a driver or remote has any name, a URL-scoped http key beats
 * the plain one). Matched on git's own spelling of the key, folded to lower case.
 */
export const REFUSED_KEYS: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/^include\.path$|^includeif\..*\.path$/, 'which reads another file in as config'],
  [/^filter\..*\.(?:clean|smudge|process)$/, 'a filter driver, a command git runs on checkout and add'],
  [/^diff\..*\.(?:command|textconv)$/, 'a diff driver, a command git runs to show a diff'],
  [/^merge\..*\.driver$/, 'a merge driver, a command git runs to merge'],
  [/^(?:mergetool|difftool)\..*\.cmd$/, 'a tool command'],
  [/^url\..*\.(?:insteadof|pushinsteadof)$/, 'which sends a remote URL somewhere else'],
  [/^remote\..*\.(?:uploadpack|receivepack|proxy|proxyauthmethod|vcs)$/, "a remote's command, helper or proxy"],
  [/^http\.(?:.*\.)?(?:ssl[a-z]*|proxy[a-z]*|schannel[a-z]*|pinnedpubkey|curloptresolve|extraheader|cookiefile|savecookies|followredirects)$/, 'which changes the host git reaches, or what it trusts or sends there'],
  [/^core\.(?:worktree|gitproxy)$/, 'which moves the work tree, or runs a proxy command'],
  [/^core\.hookspath$/, 'which names the hooks git runs'],
  [/^submodule\..*\.update$/, "a submodule's update command"],
] as const);

/** Whether `env`, or this process, is marked as an instance's. Own variables only (#786). */
const marked = (env: NodeJS.ProcessEnv): boolean => ownEnv(env).get(GIT_GUARD_VAR) === '1' || ownEnv(process.env).get(GIT_GUARD_VAR) === '1';

/** `env` with the guard's settings: GIT_GUARD_ENV over it, then GIT_GUARD_PAIRS ahead of its own config pairs. */
function guardEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, ...GIT_GUARD_ENV };
  const raw = out.GIT_CONFIG_COUNT;
  const theirs: [string, string][] = [];
  if (raw !== undefined) {
    // A count git can't read, or a pair missing: left as it is, and git refuses to start (fail closed).
    if (!/^\d{1,4}$/.test(raw)) return out;
    for (let i = 0; i < Number(raw); i++) {
      const k = out[`GIT_CONFIG_KEY_${i}`];
      const v = out[`GIT_CONFIG_VALUE_${i}`];
      if (k === undefined || v === undefined) return out;
      theirs.push([k, v]);
    }
    for (let i = 0; i < theirs.length; i++) {
      delete out[`GIT_CONFIG_KEY_${i}`];
      delete out[`GIT_CONFIG_VALUE_${i}`];
    }
  }
  const pairs = [...GIT_GUARD_PAIRS, ...theirs];
  out.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k;
    out[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return out;
}

/** `env` (or this process's environment), with the fixed settings on top; for an instance's git, the guard's too (#926). */
export function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...(env ?? process.env), ...GIT_FIXED_ENV };
  return marked(out) ? guardEnv(out) : out;
}

/** git's options before the subcommand that say which repo and config a call reads: kept for the config read. */
const KEPT = new Set(['-C', '-c', '--git-dir', '--work-tree', '--config-env', '--bare', '--no-replace-objects']);
/** Those that take the next argument as their value. */
const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--config-env', '--namespace', '--super-prefix', '--attr-source']);

function globalOptions(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) break;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (eq < 0 && VALUED.has(a)) {
      if (KEPT.has(a)) out.push(a, args[i + 1] ?? '');
      i++;
    } else if (KEPT.has(name)) out.push(a);
  }
  return out;
}

/**
 * What a `git config --list --show-scope --show-origin --includes -z` listing sets that a guarded git refuses, as a
 * reason; null when nothing. A key set at command scope is the engine's own; core.hooksPath in a file is fine when
 * the command scope sets it over (the coordinator's own hooks dir).
 */
export function configRefusal(listing: string): string | null {
  const t = listing.split('\0');
  const ours = new Set<string>();
  const files: [string, string][] = [];
  for (let i = 0; i + 2 < t.length; i += 3) {
    const key = (t[i + 2]!.split('\n', 1)[0] ?? '').toLowerCase();
    if (t[i] === 'command') ours.add(key);
    else files.push([key, t[i + 1]!]);
  }
  for (const [key, origin] of files) {
    if (key === 'core.hookspath' && ours.has(key)) continue;
    const hit = REFUSED_KEYS.find(([re]) => re.test(key));
    if (hit) return `the git config ${origin.replace(/^file:/, '')} sets ${key}, ${hit[1]}; an instance's coordinator runs nothing a checkout's config names. Take it out of that file`;
  }
  return null;
}

/** For a guarded git: the config this call would read, refused or not (see the header). Null when it may run. */
function preflight(file: string, args: readonly string[], cwd: string | URL | undefined, env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync(file, [...globalOptions(args), 'config', '--list', '--show-scope', '--show-origin', '--includes', '-z'], {
    ...(cwd !== undefined ? { cwd } : {}),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) return `its git config couldn't be read (${r.error.message})`;
  if (r.status !== 0) return `its git config couldn't be read (${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`})`;
  return configRefusal(r.stdout);
}

/** Before gitleaks (which runs git itself) on `cwd`: why not, for an instance's process; null when it may run. */
export function gitConfigRefusal(cwd?: string): string | null {
  const env = gitEnv();
  return marked(env) ? preflight('git', [], cwd, env) : null;
}

/** In place of a refused git: this node, printing why on stderr and ending with git's own status for a fatal error. */
const REFUSE = "process.stderr.write(process.argv[1] + '\\n'); process.exitCode = 128;";

/** The command, arguments and options a git call runs with: the fixed settings, and for a guarded git the guard's. */
function prepare<O extends { cwd?: string | URL | undefined; env?: NodeJS.ProcessEnv | undefined; shell?: unknown }>(file: string, args: readonly string[], options: O): [string, string[], O] {
  const env = gitEnv(options.env);
  const full = gitArgs(args);
  if (!marked(env)) return [file, full, { ...options, env }];
  const why = options.shell ? 'a shell would run it, which this guard does not read' : preflight(file, full, options.cwd, env);
  if (!why) return [file, full, { ...options, env }];
  return [process.execPath, ['-e', REFUSE, `${BRAND.cli}: refusing to run git here: ${why} (#926)`], { ...options, env: {}, shell: false }];
}

/** The argument list a git process gets: the fixed arguments, then `args`. */
export function gitArgs(args: readonly string[]): string[] {
  return [...GIT_FIXED_ARGS, ...args];
}

/** True for a command that runs git: `git`, or a path to it (`/usr/bin/git`, `C:\...\git.exe`), in any case. */
export function isGitCommand(cmd: string): boolean {
  const name = (cmd.split(/[\\/]/).pop() ?? '').toLowerCase();
  return name === 'git' || name === 'git.exe';
}

/** spawnSync of git. */
export function gitSpawnSync(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function gitSpawnSync(args: readonly string[], options?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function gitSpawnSync(args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
export function gitSpawnSync(args: readonly string[], options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  return spawnSync(...prepare('git', args, options));
}

/** execFileSync of git. */
export function gitExecFileSync(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function gitExecFileSync(args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function gitExecFileSync(args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function gitExecFileSync(args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  return execFileSync(...prepare('git', args, options));
}

/** spawn of git. */
export function gitSpawn(args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>): ChildProcessByStdio<null, Readable, Readable>;
export function gitSpawn(args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioNull>): ChildProcessByStdio<null, Readable, null>;
export function gitSpawn(args: readonly string[], options: SpawnOptions): ChildProcess;
export function gitSpawn(args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn(...prepare('git', args, options));
}

/** execFile of git, its output as text. */
export function gitExecFile(
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
  const [file, full, o] = prepare<ExecFileOptions>('git', args, options);
  return execFile(file, full, o, (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));
}

/**
 * spawnSync of a command a caller names at run time (a probe's or a stand-in-able runner's `run(cmd, args)`): git,
 * by name or path, through gitSpawnSync, so a runner that takes any command can't run git without the settings;
 * anything else as it is.
 */
export function commandSpawnSync(cmd: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  return isGitCommand(cmd)
    ? spawnSync(...prepare(cmd, args, options))
    : spawnSync(cmd, args, options);
}
