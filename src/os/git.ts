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
// The commit-graph file (objects/info/commit-graph, in the shared objects dir) is the same kind of state: git trusts
// its parent links, and a forged one skipped a commit in a range (measured, #927's round-2 check). It is off for every
// git here too (`-c core.commitGraph=false`, and the same pair in the environment for gits a program runs itself).
//
// A shallow clone's `shallow` file is read (it is how a shallow clone works). A reader that must see a range whole
// takes a gitSnapshot: one copy of that file, checked, that every walk it runs reads, however the shared file changes.
//
// LIMIT: a program the engine runs that runs git itself (gitleaks) gets these settings only when it is handed gitEnv().
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync, spawn, spawnSync } from './child-process.js';
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
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Before every git subcommand: replace refs off for this git (git also sets GIT_NO_REPLACE_OBJECTS for the gits it
 * runs), and the commit-graph off.
 */
export const GIT_FIXED_ARGS: readonly string[] = Object.freeze(['--no-replace-objects', '-c', 'core.commitGraph=false']);

/** git config every git also gets through its environment (GIT_CONFIG_COUNT pairs), after the caller's own pairs. */
export const GIT_FIXED_CONFIG: readonly (readonly [string, string])[] = Object.freeze([Object.freeze(['core.commitGraph', 'false'] as const)]);

/**
 * On every git process, over the caller's environment. GIT_GRAFT_FILE is a path under the null device, which can't
 * exist (ENOTDIR on Linux and macOS), so git reads no graft file and says nothing about it.
 */
export const GIT_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: join(devNull, 'no-grafts'),
});

/**
 * `env` (or this process's environment), with the fixed settings on top and the fixed config pairs after its own
 * GIT_CONFIG_COUNT pairs (a later pair wins). A count that isn't a whole number is git's refusal anyway; it is replaced.
 */
export function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...(env ?? process.env), ...GIT_FIXED_ENV };
  // Own keys only: an unset count must never be read through Object.prototype (#846).
  let n = Number(Object.hasOwn(out, 'GIT_CONFIG_COUNT') ? out.GIT_CONFIG_COUNT : '0');
  if (!Number.isSafeInteger(n) || n < 0) n = 0;
  for (const [k, v] of GIT_FIXED_CONFIG) {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
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

/** A full lowercase object id of each object format git names (`rev-parse --show-object-format`): nothing else. */
const OBJECT_ID = new Map([['sha1', /^[0-9a-f]{40}$/], ['sha256', /^[0-9a-f]{64}$/]]);

/**
 * The commits a `shallow` file lists, or null when any line isn't exactly one full lowercase object id of the repo's
 * own `format`, or the format is one this doesn't know. git reads the file more loosely: an uppercase id, text after
 * the id, a line over 1 KB, and in a sha1 repo a 64-hex line, read as its first 40 (each measured to cut a range on
 * git 2.43; the last got a refused file onto the remote in 34 of 80 pushes, #927 round 3). So a line this can't read
 * the way git might is never taken as "no cut".
 */
export function shallowIds(text: string, format: string): string[] | null {
  const id = OBJECT_ID.get(format);
  if (!id) return null;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.every((l) => id.test(l)) ? lines : null;
}

/** Variables that would point a git at another repo, worktree, index or shallow file than the snapshot's own. */
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_SHALLOW_FILE', 'GIT_NAMESPACE'];

/** One fixed view of a repo's history: what every walk of one check reads (#927). */
export interface GitSnapshot {
  /** The environment a git (or a program that runs git, through gitEnv) reads the snapshot with. */
  readonly env: NodeJS.ProcessEnv;
  /** The commits the snapshot's shallow file cuts at (empty: not shallow). */
  readonly cut: ReadonlySet<string>;
  /** The cut commits inside base..head (object ids): each hides what is below it. */
  cutInRange(base: string, head: string): string[];
  /** Removes the snapshot's directory. */
  dispose(): void;
}

/**
 * A private git directory over `cwd`'s repo: its objects (GIT_OBJECT_DIRECTORY, with their alternates) and one copy
 * of its `shallow` file, read once and checked (shallowIds). No refs, no config but its own, no replace refs and no
 * grafts. A walk through `env` reads that copy, so writing or removing the repo's own shallow file mid-check changes
 * nothing (an agent toggling it every ~3 ms got a refused file past the old before-and-after checks: 23 of 150 runs,
 * measured). Documented environment only, not git's internal --shallow-file. Commit ids only: the snapshot has no
 * refs, so resolve names in the repo first. Throws, saying why, when the repo or its shallow file can't be read.
 */
export function gitSnapshot(cwd: string): GitSnapshot {
  const clean = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    for (const k of REPO_VARS) delete e[k];
    return e;
  };
  const [format, objectsPath, shallowPath] = gitExecFileSync(['rev-parse', '--show-object-format', '--git-path', 'objects', '--git-path', 'shallow'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n');
  if (!format || !objectsPath || !shallowPath) throw new Error('git rev-parse gave no object format or paths');
  let text = '';
  try {
    text = readFileSync(resolve(cwd, shallowPath), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`can't read its shallow file: ${(e as Error).message}`);
  }
  const ids = shallowIds(text, format);
  if (ids === null) throw new Error(`its shallow file has a line that isn't exactly a full lowercase object id of this repo's format (${format}), which git may still read as a cut`);
  const dir = mkdtempSync(join(tmpdir(), 'git-snapshot-'));
  try {
    gitExecFileSync(['init', '-q', '--bare', `--object-format=${format}`, dir], { env: clean(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (ids.length) writeFileSync(join(dir, 'shallow'), `${ids.join('\n')}\n`);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const env: NodeJS.ProcessEnv = { ...clean(), GIT_DIR: dir, GIT_OBJECT_DIRECTORY: resolve(cwd, objectsPath) };
  const cut = new Set(ids);
  return {
    env,
    cut,
    cutInRange: (base, head) => {
      if (!cut.size) return [];
      const listed = gitExecFileSync(['rev-list', `${base}..${head}`], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return listed.split('\n').filter((c) => cut.has(c));
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
