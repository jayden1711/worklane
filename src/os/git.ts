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
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
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

/** `env` (or this process's environment), with the fixed settings on top. */
export function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), ...GIT_FIXED_ENV };
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
  return spawnSync('git', gitArgs(args), { ...options, env: gitEnv(options.env) });
}

/** execFileSync of git. */
export function gitExecFileSync(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function gitExecFileSync(args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function gitExecFileSync(args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function gitExecFileSync(args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  return execFileSync('git', gitArgs(args), { ...options, env: gitEnv(options.env) });
}

/** spawn of git. */
export function gitSpawn(args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>): ChildProcessByStdio<null, Readable, Readable>;
export function gitSpawn(args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioNull>): ChildProcessByStdio<null, Readable, null>;
export function gitSpawn(args: readonly string[], options: SpawnOptions): ChildProcess;
export function gitSpawn(args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn('git', gitArgs(args), { ...options, env: gitEnv(options.env) });
}

/** execFile of git, its output as text. */
export function gitExecFile(
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
  const o: ExecFileOptions = { ...options, env: gitEnv(options.env) };
  return execFile('git', gitArgs(args), o, (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));
}

/**
 * spawnSync of a command a caller names at run time (a probe's or a stand-in-able runner's `run(cmd, args)`): git,
 * by name or path, through gitSpawnSync, so a runner that takes any command can't run git without the settings;
 * anything else as it is.
 */
export function commandSpawnSync(cmd: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  return isGitCommand(cmd)
    ? spawnSync(cmd, gitArgs(args), { ...options, env: gitEnv(options.env) })
    : spawnSync(cmd, args, options);
}
