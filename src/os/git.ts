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
//
// #926, an instance's coordinator. WHY: its checkout is agent-writable (the code is, and on installs before #926 so
// was .git/), and so are its worktrees and their gitdir links. A config file there can name a command for git to run
// (a filter, diff or merge driver, a signing program, an ssh or askpass command, a credential helper) or a host for it
// to reach (url.*.insteadOf, a proxy), and an include can pull in any file as config. The coordinator ran git there as
// itself, with its GitHub credential: a planted smudge filter ran during `git worktree add` (measured, #926).
// INVARIANT: in a process marked as an instance's (GIT_GUARD_VAR, set by service.ts instanceEnv and by auto-config to
// the instance's checkout), or for a git whose own environment carries the mark, every git started here
//   - reads no global config (GIT_CONFIG_GLOBAL at the null device). System config (/etc/gitconfig) is root's, no
//     agent's, and is how a machine routes github.com (a mirror, CI's fake GitHub): it is read, as before;
//   - is pinned to the repo the engine knows (pinRepo): in the instance's checkout, GIT_DIR is its .git; in a worktree
//     of it, GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE come from the checkout's own path, never from the worktree's
//     links, and the git is refused unless those links (the worktree's .git file, the admin dir's gitdir and
//     commondir) all point where git worktree add made them point. An agent rewriting a link to a common dir of its
//     own (its config, its remote, its hooks) gets a refusal, not a run (#926 round 2, measured). A repo of its own
//     elsewhere is refused unless this user owns its .git;
//   - gets GIT_GUARD_PAIRS at command scope, which beats every file: no credential helper, fsmonitor, editor, pager,
//     external diff, alternate-refs command, ssh or askpass command, or signing program of a file's; no ext:: transport,
//     no submodule recursion, no bundle URIs. The caller's own pairs come after, so its credential helper and hooks
//     dir (the coordinator's, in instanceEnv and auto-config) are the ones in force;
//   - first reads the config git would read for that very call (`git config --list`, with the call's -C, --git-dir,
//     -c and pinned environment) and, if a repo's own config (local or worktree scope) sets anything REFUSED_KEYS
//     names (keys no command-scope value can take back: includes, URL rewrites, drivers under any name, proxies), runs
//     no git at all: the call fails with status 128 and says which file and key. Fail closed: a config that can't be
//     read is refused too.
// The settings go on last, as #807's do, so no caller's environment turns them off. Other processes (local mode, the
// owner's own commands) keep their git as it was: the owner's own config is theirs to trust.
// LIMIT: the read and the run are two processes, but both are pinned to the same dirs, so a link rewritten between
// them changes nothing; a file in those dirs edited in between is read by the run: the checkout's .git/ is the
// coordinator's alone (scripts/setup/checkout.sh, git-dir-lock.ts), and an agent-writable worktree admin dir holds no
// config git reads unless the checkout's own config turns extensions.worktreeConfig on. remote.<name>.url is the
// checkout's own setting, never refused: the locked .git/config is what keeps it.
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
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
 * The mark of a process (or a git) that runs for an instance, in checkouts agents can write (#926): the instance
 * checkout's absolute path, which a guarded git in a worktree is pinned to; '1' marks one with no checkout named (a
 * worktree's git is then refused, as nothing says which common dir it must have).
 */
export const GIT_GUARD_VAR = `${BRAND.envPrefix}_GIT_GUARD`;

/** A program path that can't exist (as GIT_GRAFT_FILE's): a signing or verifying git fails closed, running nothing. */
const NO_PROGRAM = join(devNull, 'no-program');

/** On every guarded git, over the caller's environment: no global config, no prompts, no pager. */
export const GIT_GUARD_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
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

/** A mark's value that marks: '1', or an absolute path (the checkout). */
const marks = (v: string | undefined): v is string => v === '1' || (!!v && isAbsolute(v));

/** Whether `env`, or this process, is marked as an instance's. Own variables only (#786). */
const marked = (env: NodeJS.ProcessEnv): boolean => marks(ownEnv(env).get(GIT_GUARD_VAR)) || marks(ownEnv(process.env).get(GIT_GUARD_VAR));

/** The instance checkout a marked git is pinned to: this process's mark first (the coordinator's own), then the git's. */
function markedRepo(env: NodeJS.ProcessEnv): string | null {
  for (const v of [ownEnv(process.env).get(GIT_GUARD_VAR), ownEnv(env).get(GIT_GUARD_VAR)]) if (marks(v) && v !== '1') return v;
  return null;
}

/** `env` with the guard's settings: GIT_GUARD_ENV over it, then GIT_GUARD_PAIRS ahead of its own config pairs. */
function guardEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, ...GIT_GUARD_ENV, [GIT_GUARD_VAR]: markedRepo(env) ?? '1' };
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

/**
 * `env` (or this process's environment), with the fixed settings on top and the fixed config pairs after its own
 * GIT_CONFIG_COUNT pairs (a later pair wins). A count that isn't a whole number is git's refusal anyway; it is replaced.
 * For an instance's git (#926), the guard's settings too: GIT_GUARD_PAIRS go ahead of all of those.
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
  const files: [string, string, string][] = [];
  for (let i = 0; i + 2 < t.length; i += 3) {
    const key = (t[i + 2]!.split('\n', 1)[0] ?? '').toLowerCase();
    if (t[i] === 'command') ours.add(key);
    else files.push([key, t[i + 1]!, t[i]!]);
  }
  for (const [key, origin, scope] of files) {
    // System config is root's (/etc/gitconfig), global is read as the null device: only a repo's own is suspect.
    if (scope === 'system' || scope === 'global') continue;
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

/**
 * Whether the repo at `dir` sets in its own config (local or worktree scope) a key a guarded git refuses, as a reason;
 * null when nothing does. For scripts/setup/checkout.sh, through the CLI (`git-config-check`), before its own git runs
 * there: the same listing and the same parser as the guard, so the two can never read a config differently.
 */
export function repoConfigRefusal(dir: string): string | null {
  return preflight('git', gitArgs([]), dir, gitEnv());
}

/** Before gitleaks (which runs git itself) on `cwd`: why not, for an instance's process; null when it may run. */
export function gitConfigRefusal(cwd?: string): string | null {
  const env = gitEnv();
  if (!marked(env)) return null;
  const pinned = pinRepo([], cwd, env);
  return 'refused' in pinned ? pinned.refused : preflight('git', [], cwd, pinned.env);
}

/** A path as the file system has it (symlinks resolved), or as given when it doesn't exist. */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The directory a git call starts in: its cwd, then each `-C` before the subcommand, in order. */
function startDir(args: readonly string[], cwd: string | URL | undefined): string {
  let d = resolve(cwd === undefined ? process.cwd() : cwd instanceof URL ? cwd.pathname : cwd);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) break;
    if (a === '-C') d = resolve(d, args[++i] ?? '');
    else if (VALUED.has(a)) i++;
  }
  return d;
}

/** The subcommand: the first argument after the global options. */
function subcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) return a;
    if (VALUED.has(a)) i++;
  }
  return undefined;
}

/** A file's text, trimmed; null when it can't be read. */
const text = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};

/**
 * For a guarded git: the environment pinning it to the repo the engine knows, or why it is refused (#926 round 2).
 *  - A call that names its repo itself (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, --git-dir, --work-tree, --bare), or
 *    makes one (clone, init), or starts outside any repo: as it is.
 *  - In the instance's checkout (the mark's path): GIT_DIR is its .git directory, GIT_WORK_TREE the checkout.
 *  - In a worktree of it: exactly one admin dir under its .git/worktrees names this worktree (its gitdir file), the
 *    worktree's .git file names that admin dir, and the admin dir's commondir names the checkout's .git; then GIT_DIR,
 *    GIT_COMMON_DIR and GIT_WORK_TREE are set from those engine-known paths, so no link rewritten later is followed.
 *    Anything else (a link pointing elsewhere, a worktree's .git turned into a directory) is refused.
 *  - Any other repo: refused unless this user owns its .git (an agent's repo, or a worktree link to an unknown
 *    checkout, is never run in).
 */
function pinRepo(args: readonly string[], cwd: string | URL | undefined, env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv } | { refused: string } {
  const own = ownEnv(env);
  if (own.get('GIT_DIR') !== undefined || own.get('GIT_WORK_TREE') !== undefined || own.get('GIT_COMMON_DIR') !== undefined) return { env };
  if (globalOptions(args).some((a) => /^--(?:git-dir|work-tree|bare)(?:=|$)/.test(a))) return { env };
  const sub = subcommand(args);
  if (sub === 'clone' || sub === 'init') return { env };
  let top: string | null = null;
  let kind: 'dir' | 'file' | 'other' = 'other';
  for (let d = startDir(args, cwd); ; d = dirname(d)) {
    try {
      const s = lstatSync(join(d, '.git'));
      top = d;
      kind = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
      break;
    } catch {
      if (dirname(d) === d) break;
    }
  }
  if (top === null) return { env };
  if (kind === 'other') return { refused: `${join(top, '.git')} is neither git's directory nor a worktree's link file` };
  const repo = markedRepo(env);
  const realTop = real(top);
  const dotgit = join(realTop, '.git');
  if (repo) {
    const checkout = real(repo);
    const common = join(checkout, '.git');
    if (realTop === checkout) {
      if (kind !== 'dir') return { refused: `${common} is not a directory` };
      return { env: { ...env, GIT_DIR: common, GIT_WORK_TREE: checkout } };
    }
    let ids: string[] = [];
    try {
      ids = readdirSync(join(common, 'worktrees'));
    } catch {
      ids = [];
    }
    const claims = ids.filter((id) => {
      const admin = join(common, 'worktrees', id);
      const g = text(join(admin, 'gitdir'));
      return g !== null && real(resolve(admin, g)) === dotgit;
    });
    if (kind === 'file' || claims.length) {
      if (kind !== 'file') return { refused: `${dotgit} was a worktree link of ${checkout} and isn't one now` };
      if (claims.length !== 1) return { refused: `${claims.length ? 'more than one' : 'no'} worktree of ${checkout} names ${realTop}: it isn't one the engine made` };
      const admin = join(common, 'worktrees', claims[0]!);
      const link = /^gitdir: (.+)$/.exec(text(dotgit) ?? '')?.[1];
      if (!link || real(resolve(realTop, link.trim())) !== real(admin)) return { refused: `${dotgit} doesn't point at ${admin}, where git worktree add made it point` };
      const cd = text(join(admin, 'commondir'));
      if (cd === null || real(resolve(admin, cd)) !== real(common)) return { refused: `${join(admin, 'commondir')} doesn't point at ${common}` };
      return { env: { ...env, GIT_DIR: admin, GIT_COMMON_DIR: common, GIT_WORK_TREE: realTop } };
    }
  }
  if (kind === 'file') return { refused: `${realTop} is a worktree of a repo other than the instance's checkout${repo ? '' : ' (none is named)'}` };
  if (kind === 'dir' && typeof process.getuid === 'function') {
    const uid = lstatSync(dotgit).uid;
    if (uid !== process.getuid()) return { refused: `${dotgit} belongs to uid ${uid}, not this user: a repo another user made` };
  }
  return { env };
}

/** In place of a refused git: this node, printing why on stderr and ending with git's own status for a fatal error. */
const REFUSE = "process.stderr.write(process.argv[1] + '\\n'); process.exitCode = 128;";

/** The command, arguments and options a git call runs with: the fixed settings, and for a guarded git the guard's. */
function prepare<O extends { cwd?: string | URL | undefined; env?: NodeJS.ProcessEnv | undefined; shell?: unknown }>(file: string, args: readonly string[], options: O): [string, string[], O] {
  const env = gitEnv(options.env);
  const full = gitArgs(args);
  if (!marked(env)) return [file, full, { ...options, env }];
  const pinned = options.shell ? { refused: 'a shell would run it, which this guard does not read' } : pinRepo(full, options.cwd, env);
  const why = 'refused' in pinned ? pinned.refused : preflight(file, full, options.cwd, pinned.env);
  if (!why && !('refused' in pinned)) return [file, full, { ...options, env: pinned.env }];
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

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The commits a `shallow` file lists, or null when any line isn't exactly a full lowercase object id. git reads the
 * file more loosely (an uppercase id, text after the id, a line over 1 KB: each measured to cut a range on git 2.43),
 * so a line this can't read the way git might is never taken as "no cut".
 */
export function shallowIds(text: string): string[] | null {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.every((l) => OBJECT_ID.test(l)) ? lines : null;
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
  const ids = shallowIds(text);
  if (ids === null) throw new Error('its shallow file has a line that isn\'t exactly a full lowercase object id, which git may still read as a cut');
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
