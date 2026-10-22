// Worktrees the coordinator creates and owns. It never lists, touches or
// removes a worktree it didn't create: names carry our prefix AND must be in
// our ownership record, so other sessions' worktrees are always safe.
import { execFileSync, spawn, spawnSync } from './os/child-process.js';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { checkoutSparse } from './checkout.js';
import { readRegular } from './config/load.js';
import { redactString } from './events/redact.js';
import { projectStateDir } from './guardrails/context.js';
import { groupOnlyDir, projectCommand, writeGroupOnly, type ProjectRunAs } from './os/index.js';

export interface WorktreeOptions {
  repo: string;
  root: string; // relative to repo, e.g. .claude/worktrees
  stateDir: string;
  setup: string[];
  /** Setup steps (e.g. npm ci) run the project's own scripts, so they run as the agent user when there is one. */
  runAs?: ProjectRunAs;
  /** The project's own variables (tests.yaml env). */
  env?: Record<string, string>;
  /** The instance's dependency-cache variables (dep-cache.ts), set for setup steps after the project's own. */
  cacheEnv?: Record<string, string>;
  /** Directories left out of the worktree (tests.yaml checkout.sparse_exclude, src/checkout.ts). */
  sparseExclude?: readonly string[];
  /**
   * Where task files are written (#890 round 19; null where no task file is written): a root holding it gets the
   * engine's own directory (keptPaths). Required (round 20): options without it don't compile.
   */
  taskDir: string | null;
  /**
   * The root was resolved to its real path once, when these options were built (#890 rounds 19-20, worktreeOptions): a
   * link that appears on the way to a worktree after that refuses the add instead of being followed. Required (round
   * 20: callers that built their own skipped the check, and a worktree was written through a planted link, measured).
   * What the type refuses is only a literal `rootResolved: true` outside this module, and options without the field.
   * A literal that copies `rootResolved` from built options, or `{ ...built, root: other }`, still compiles: build
   * options with worktreeOptions and change no root afterwards.
   */
  rootResolved: RootResolved;
}

declare const builtHere: unique symbol;
/** `true`, typed so a literal `rootResolved: true` outside this module doesn't compile (round 20); a copied one does. */
export type RootResolved = true & { readonly [builtHere]: true };
const ROOT_RESOLVED = true as RootResolved;

/**
 * The one way to build WorktreeOptions (#890 round 20): the root resolved to its real path once, here, and the task
 * directory carried. Build them once (at a coordinator's start, or at the start of the work that uses them) and reuse
 * them, so a link that appears later is refused rather than followed.
 */
export function worktreeOptions(o: Omit<WorktreeOptions, 'rootResolved'>): WorktreeOptions {
  return { ...o, root: resolvedPath(resolve(o.repo, o.root)), rootResolved: ROOT_RESOLVED };
}

/**
 * Options again from a record of ones worktreeOptions built earlier (a queued job's cleanup, #890 round 20): the root as
 * recorded, never resolved again, so a link that appeared since is refused rather than followed. A record from before
 * the upgrade may spell its root through a link; it then fails closed.
 */
export function recordedWorktreeOptions(r: { repo: string; root: string; stateDir: string; taskDir?: string | null }): WorktreeOptions {
  return { repo: r.repo, root: resolve(r.repo, r.root), stateDir: r.stateDir, setup: [], taskDir: r.taskDir ?? null, rootResolved: ROOT_RESOLVED };
}

const ownedFile = (o: WorktreeOptions) => join(o.stateDir, 'worktrees.json');

function owned(o: WorktreeOptions): string[] {
  try {
    return JSON.parse(readFileSync(ownedFile(o), 'utf8')) as string[];
  } catch {
    return [];
  }
}
function setOwned(o: WorktreeOptions, list: string[]) {
  groupOnlyDir(o.stateDir);
  writeGroupOnly(ownedFile(o), JSON.stringify([...new Set(list)], null, 2));
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * What Claude Code's sandbox leaves in a worktree: on Linux it protects paths by mounting over them, so a missing one
 * is created empty as the mount point and stays. Root files from its list (.gitconfig, .gitmodules, shell startup
 * files, .ripgreprc, .mcp.json, .vscode, .idea), and anything under .claude/ as a whole (harness config: agents edit
 * tracked files there through review and never add new ones).
 */
export const SANDBOX_ROOT_PLACEHOLDERS = [
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.vscode', '.idea',
  '.bash_login', '.bash_logout', '.bash_aliases', '.zshenv', '.zlogin', '.zlogout',
];
const PROTECTED_DIR = '.claude';
const EXCLUDE_MARKER = `# ${BRAND.cli}: empty mount points Claude Code's sandbox leaves in worktrees; never commit them`;
const EXCLUDE_END = `# ${BRAND.cli}: end`;

/** Keep the sandbox's placeholders out of commits: a block in the shared info/exclude (untracked files only). */
export function excludeSandboxPlaceholders(repo: string): void {
  const file = join(resolve(repo, git(repo, 'rev-parse', '--git-common-dir')), 'info', 'exclude');
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== EXCLUDE_MARKER) {
      kept.push(lines[i]!);
      continue;
    }
    // Drop our previous block: through its end line, or (older blocks) through its patterns.
    while (i + 1 < lines.length && (lines[i + 1] === EXCLUDE_END || lines[i + 1]!.startsWith('/'))) if (lines[++i] === EXCLUDE_END) break;
  }
  const before = kept.join('\n').replace(/\n*$/, '');
  const block = [EXCLUDE_MARKER, ...SANDBOX_ROOT_PLACEHOLDERS.map((p) => `/${p}`), `/${PROTECTED_DIR}/`, EXCLUDE_END].join('\n');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${before ? `${before}\n` : ''}${block}\n`);
}

/** After a run, remove the sandbox's leftover mount points: only empty, untracked ones. */
export function removeSandboxPlaceholders(worktree: string): string[] {
  const removed: string[] = [];
  const tracked = (p: string) => git(worktree, 'ls-files', '--', p) !== '';
  const remove = (p: string): boolean => {
    const full = join(worktree, p);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      return false;
    }
    if (tracked(p)) return false; // the project's own file
    try {
      if (st.isFile() && st.size === 0) unlinkSync(full);
      else if (st.isDirectory()) {
        // Children first: a folder of empty placeholders is itself a placeholder.
        for (const child of readdirSync(full)) remove(`${p}/${child}`);
        if (readdirSync(full).length) return false;
        rmdirSync(full);
      } else return false;
      removed.push(p);
      return true;
    } catch {
      return false; // not ours to remove (permissions): the exclude still keeps it out of commits
    }
  };
  for (const p of SANDBOX_ROOT_PLACEHOLDERS) remove(p);
  if (existsSync(join(worktree, PROTECTED_DIR))) for (const child of readdirSync(join(worktree, PROTECTED_DIR))) remove(`${PROTECTED_DIR}/${child}`);
  return removed;
}

/** How every worktree the engine makes is named in its place (worktreePath): read-denials hides them by it (#890). */
export const WORKTREE_NAME_PREFIX = `${BRAND.cli}-`;

/** The directory of its own the engine makes its worktrees in under a root that holds the main checkout (#890 r17). */
export const WORKTREE_DIR_NAME = `${BRAND.cli}-worktrees`;

const pathForms = (p: string) => {
  const forms = [resolve(p)];
  try {
    forms.push(realpathSync(p));
  } catch {
    // not there (yet): as written only
  }
  return [...new Set(forms)];
};

/** Whether `dir` is, or holds, `p`, compared as written and by real path. */
export function holdsPath(dir: string, p: string): boolean {
  return pathForms(dir).some((d) => pathForms(p).some((f) => f === d || f.startsWith(`${d === '/' ? '' : d}/`)));
}

/**
 * The one test of whether a place can't be hidden whole (#890 round 18): it is, or holds, one of `kept`. Both
 * worktreeDir and the run's denials (src/read-denials.ts siblingCheckouts) call it with keptPaths (round 19: one list
 * too, not only one predicate; round 18 passed different lists, and a root holding only the task directory got new
 * worktrees directly under it, measured).
 */
export function holdsKept(place: string, kept: readonly (string | null | undefined)[]): boolean {
  return kept.some((k) => typeof k === 'string' && k !== '' && holdsPath(place, k));
}

/** The paths a worktree place must never hide (round 19, the one list): the main checkout, its common git dir, the task directory. */
export function keptPaths(repo: string, taskDir?: string | null): string[] {
  return [repo, commonGitDir(repo), taskDir].filter((p): p is string => typeof p === 'string' && p !== '');
}

/** The common git directory of the checkout at `repo` (its `.git`, or the one a `.git` file leads to); null when unknown. */
export function commonGitDir(repo: string): string | null {
  const dotGit = join(repo, '.git');
  try {
    if (lstatSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir: *(.+)$/m.exec(readRegular(dotGit) ?? '');
    if (!m) return null;
    const gitDir = resolve(repo, m[1]!.trim());
    return resolve(gitDir, readRegular(join(gitDir, 'commondir'))?.trim() || '.');
  } catch {
    return null;
  }
}

/**
 * Where new worktrees are made: the worktree root, or, when the root is or holds the main checkout or the common git
 * directory (`..`, `.`, "", a separate git dir's parent), a directory of the engine's own in it, `<root>/<cli>-worktrees`.
 * WHY (#890 rounds 17-18): such a root can't be hidden from a run whole, and a name pattern over it is expanded only
 * when a command is wrapped, so a command already running read a worktree made later (measured). The directory is
 * hidden whole like any other place, so its mount covers commands already running too.
 */
export function worktreeDir(repo: string, root: string, taskDir?: string | null): string {
  const base = resolve(repo, root);
  return holdsKept(base, keptPaths(repo, taskDir)) ? join(base, WORKTREE_DIR_NAME) : base;
}

/**
 * Make one of the coordinator's places if it isn't there, never through a link (round 18, N1): a link there throws
 * before anything is made, since a make, a mount or `git worktree add` would follow it anywhere.
 */
export function makePlace(place: string): void {
  // `place` was resolved to its real path at the start (worktreePlaces): a link at it, or anywhere on the way to it,
  // since then refuses (round 19), before anything is made.
  const linked = linkOnTheWay(place);
  if (linked) throw new Error(`${place}: ${linked}, so nothing is made through it`);
  mkdirSync(place, { recursive: true });
  const after = linkOnTheWay(place);
  if (after) throw new Error(`${place}: ${after}`);
}

/**
 * Why the path to `p` (an absolute path resolved to its real path earlier) no longer is its real path: a link at `p`,
 * or a link that appeared at any part on the way (the real path of its nearest existing part isn't that part). Null
 * while it still is.
 */
export function linkOnTheWay(p: string): string | null {
  let at = resolve(p);
  for (;;) {
    try {
      if (lstatSync(at).isSymbolicLink()) return `${at} is a link`;
      const real = realpathSync(at);
      return real === at ? null : `${at} now leads to ${real} (a link on the way)`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (dirname(at) === at) return null;
      at = dirname(at);
    }
  }
}

/** `p` resolved to its real path: its nearest existing part's real path, and the rest as written. */
export function resolvedPath(p: string): string {
  const abs = resolve(p);
  let at = abs;
  for (;;) {
    try {
      const real = realpathSync(at);
      // relative(), not a slice by length: when only `/` exists, a slice dropped the first letter (round 20, measured).
      return at === abs ? real : join(real, relative(at, abs));
    } catch {
      if (dirname(at) === at) return abs;
      at = dirname(at);
    }
  }
}

/** Where a new worktree named `name` is made: always in worktreeDir (round 18), never at an old path. */
function newWorktreePath(o: WorktreeOptions, name: string): string {
  return join(worktreeDir(o.repo, o.root, o.taskDir), `${WORKTREE_NAME_PREFIX}${name}`);
}

/**
 * Where the worktree named `name` is, to find, reuse or remove it: one made before round 17 directly under a root that
 * holds the main checkout stays at that old path while the ownership record has it; otherwise where a new one goes.
 * Never used to make one (addWorktree makes every worktree at newWorktreePath).
 */
export function worktreePath(o: WorktreeOptions, name: string): string {
  const legacy = resolve(o.repo, o.root, `${WORKTREE_NAME_PREFIX}${name}`);
  const fresh = newWorktreePath(o, name);
  return fresh !== legacy && ownedAs(o, legacy) ? legacy : fresh;
}

/**
 * The ownership record that is `p`, as written or by real path (round 19): a record written through a link (a root
 * that is a link, before the coordinator resolved it at its start) still names the same worktree.
 */
function ownedAs(o: WorktreeOptions, p: string): string | undefined {
  return owned(o).find((r) => r === p || (holdsPath(r, p) && holdsPath(p, r)));
}

/** Whether `path` is a worktree's old place: directly in a root that holds a kept path (before round 17). */
function isOldPlace(o: WorktreeOptions, path: string): boolean {
  const base = resolve(o.repo, o.root);
  return worktreeDir(o.repo, o.root, o.taskDir) !== base && dirname(path) === base;
}

/**
 * The coordinator's own places task worktrees are made in (#890): where it makes them (worktreeDir), the engine's own,
 * and, under a root that holds the main checkout, that root itself (its worktrees from before round 17 are hidden by
 * name there). One helper, so the places the coordinator makes at its start (recovery) and the ones every guarded run
 * hides (src/service.ts into the runner) can't differ.
 */
export function worktreePlaces(repo: string, root: string, taskDir?: string | null): string[] {
  // Resolved to real paths here, once, at the start (round 19): a configured root that is a link (or has one on its
  // way) is used where it leads, as main did; a link that appears on the way later refuses (makePlace, the denials).
  const base = resolvedPath(resolve(repo, root));
  const dir = worktreeDir(repo, base, taskDir);
  return [...new Set([dir, ...(dir !== base ? [base] : []), resolvedPath(join(projectStateDir(repo), 'worktrees'))])];
}

/**
 * Why each worktree the coordinator makes is locked (`git worktree lock`), as git records it.
 * WHY (#890 round 12): every run's sandbox hides every other task checkout whole, so inside it a sibling's `.git`
 * looks missing, and `git worktree prune` (or gc) run there removed every sibling's record, breaking each running task
 * (measured). git never prunes a locked worktree. Only the coordinator's own removal unlocks one, just before removing
 * it. A write deny on the records instead would break every worker's own commit (measured, round 11).
 */
export const WORKTREE_LOCK_REASON = `${BRAND.cli} task worktree: removed only by its coordinator`;

/** Lock the worktree at `path` against pruning; throws when git can't. */
export function lockWorktree(repo: string, path: string): void {
  git(repo, 'worktree', 'lock', '--reason', WORKTREE_LOCK_REASON, path);
}

/** Unlock the worktree at `path` for its removal; one that isn't locked, or isn't there, is left as it is. */
export function unlockWorktree(repo: string, path: string): void {
  spawnSync('git', ['worktree', 'unlock', path], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Every worktree in our ownership record that is still on disk, locked: one made before locking came in (round 12),
 * on an existing install. Called when the coordinator starts (its recovery), and again whenever it makes a worktree.
 */
export function lockOwnedWorktrees(o: WorktreeOptions): void {
  // Best effort: git refuses one already locked, and a record it can't lock (broken by hand) never stops a new
  // worktree being made.
  for (const p of owned(o)) if (existsSync(p)) spawnSync('git', ['worktree', 'lock', '--reason', WORKTREE_LOCK_REASON, p], { cwd: o.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The worktree itself, before any setup: on a new branch at `base`, recorded as ours first, and locked. */
function addWorktree(o: WorktreeOptions, name: string, branch: string, base: string): string {
  // Made only at the new path (round 18): an owned one at the old path under such a root is removed first, never made
  // again there, where only its whole entry at a run's start (not a mount over its place) would cover it.
  const path = newWorktreePath(o, name);
  const old = worktreePath(o, name);
  if (old !== path) {
    if (existsSync(old)) removeAt(o, old);
    else clearStale(o, old);
  }
  if (existsSync(path)) removeAt(o, path);
  else clearStale(o, path);
  // The root was resolved when these options were built (worktreeOptions, for every caller since round 20): a link that
  // appeared since, at the place or anywhere on the way, refuses the add, since git would make the checkout wherever
  // it leads. A configured root that is a link was resolved then, so it works as on main (round 18 refused it).
  {
    const linked = linkOnTheWay(dirname(path));
    if (linked) throw new Error(`${dirname(path)}, where ${BRAND.cli} makes its task worktrees: ${linked}; not making a worktree through it`);
  }
  lockOwnedWorktrees(o);
  setOwned(o, [...owned(o), path]); // recorded before creation, so a crash mid-way is still cleaned up
  excludeSandboxPlaceholders(o.repo);
  const sparse = o.sparseExclude ?? [];
  git(o.repo, 'worktree', 'add', '-q', ...(sparse.length ? ['--no-checkout'] : []), '-B', branch, path, base);
  lockWorktree(o.repo, path);
  if (sparse.length) checkoutSparse(o.repo, path, sparse);
  return path;
}

/**
 * createWorktree without blocking: the setup steps run as child processes the event loop waits on, for work
 * done in the background (a worktree pool refilling while the coordinator keeps going). A leftover of ours at the path
 * is removed the same way first. `signal` (a shutdown) kills a running step and skips the rest: a setup error.
 */
export async function createWorktreeAsync(o: WorktreeOptions, name: string, branch: string, base: string, signal?: AbortSignal): Promise<{ path: string; setupErrors: string[] }> {
  if (existsSync(worktreePath(o, name)) && owned(o).includes(worktreePath(o, name))) await removeWorktreeAsync(o, name);
  const path = addWorktree(o, name, branch, base);
  const setupErrors: string[] = [];
  for (const step of o.setup) {
    if (signal?.aborted) {
      setupErrors.push(`${step}: not run (stopped)`);
      break;
    }
    const { file, args, env } = projectCommand(step, o.runAs, { ...o.env, ...o.cacheEnv });
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      const child = spawn(file, args, { cwd: path, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const stop = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, 900_000);
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
      child.on('error', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve({ status: null, stderr });
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve({ status, stderr });
      });
    });
    if (r.status !== 0) setupErrors.push(`${step}: exit ${r.status} ${redactString(r.stderr).trim().split('\n').pop() ?? ''}`);
  }
  return { path, setupErrors };
}

/** Create a worktree on a new branch at `base`, then run the project's setup steps. */
export function createWorktree(o: WorktreeOptions, name: string, branch: string, base: string): { path: string; setupErrors: string[] } {
  const path = addWorktree(o, name, branch, base);
  const setupErrors: string[] = [];
  for (const step of o.setup) {
    const { file, args, env } = projectCommand(step, o.runAs, { ...o.env, ...o.cacheEnv });
    // No stdin (a setup step reads none): never a socket, which bash's rshd check treats as a remote login.
    const r = spawnSync(file, args, { cwd: path, encoding: 'utf8', env, timeout: 900_000, stdio: ['ignore', 'pipe', 'pipe'] });
    // A setup step's words go into events and prompts: credential-shaped text redacted (#713).
    if (r.status !== 0) setupErrors.push(`${step}: exit ${r.status} ${redactString(r.stderr || '').trim().split('\n').pop() ?? ''}`);
  }
  return { path, setupErrors };
}

/** Remove one of OUR worktrees; refuses anything not in the ownership record. Verified after. */
export function removeWorktree(o: WorktreeOptions, name: string): boolean {
  return removeAt(o, worktreePath(o, name));
}

/**
 * Ours at `path`, its directory deleted some other way: its locked record would refuse an add there ("missing but
 * locked"), where before locking any prune cleared it. Unlocked and pruned, ours only (a record still locked is kept).
 */
function clearStale(o: WorktreeOptions, path: string): void {
  const rec = ownedAs(o, path);
  if (!rec) return;
  unlockWorktree(o.repo, rec);
  spawnSync('git', ['worktree', 'prune'], { cwd: o.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function removeAt(o: WorktreeOptions, path: string): boolean {
  const rec = ownedAs(o, path);
  if (!rec) throw new Error(`refusing to remove ${path}: not created by ${BRAND.cli}`);
  unlockWorktree(o.repo, rec);
  if (isOldPlace(o, path)) return emptyInPlace(o, rec, path);
  spawnSync('git', ['worktree', 'remove', '--force', rec], { cwd: o.repo, encoding: 'utf8' });
  spawnSync('git', ['worktree', 'prune'], { cwd: o.repo });
  return dropWhenGone(o, rec, !existsSync(path));
}

/**
 * Whether git lists `rec` as a worktree of the repository, compared as real paths (round 20, the second review's N1,
 * measured): git prints real paths, and a record made under a repository path through a link spells it through the
 * link, so a text match called a listed worktree unlisted. resolvedPath resolves the nearest existing part, so a
 * removed directory still compares by its real parent.
 */
function listedWorktree(o: WorktreeOptions, rec: string): boolean {
  const real = resolvedPath(rec);
  return git(o.repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .some((l) => l.startsWith('worktree ') && resolvedPath(l.slice('worktree '.length)) === real);
}

/** Drop `rec` from the ownership record once its directory is dealt with (`done`) and git no longer lists it. */
function dropWhenGone(o: WorktreeOptions, rec: string, done: boolean): boolean {
  const gone = done && !listedWorktree(o, rec);
  if (gone) setOwned(o, owned(o).filter((p) => p !== rec));
  return gone;
}

/**
 * removeWorktree without blocking (#784: the merge gate's coverage run): `git worktree remove` (which deletes
 * everything the worktree holds, however much a test left in it) and the prune run as child processes the event loop
 * waits on. The same rules as removeAt (#890): ours by real path (ownedAs), unlocked first (every worktree of ours is
 * locked), an old one emptied in place without freeing its name (emptyInPlace), and the record dropped by dropWhenGone.
 */
export async function removeWorktreeAsync(o: WorktreeOptions, name: string): Promise<boolean> {
  const path = worktreePath(o, name);
  const rec = ownedAs(o, path);
  if (!rec) throw new Error(`refusing to remove ${path}: not created by ${BRAND.cli}`);
  unlockWorktree(o.repo, rec);
  if (isOldPlace(o, path)) return emptyInPlace(o, rec, path);
  const run = (args: string[]) => new Promise<void>((done) => {
    const child = spawn('git', args, { cwd: o.repo, stdio: 'ignore' });
    child.on('error', () => done());
    child.on('close', () => done());
  });
  await run(['worktree', 'remove', '--force', rec]);
  await run(['worktree', 'prune']);
  return dropWhenGone(o, rec, !existsSync(path));
}

/**
 * Remove an old worktree (one directly in a root that holds a kept path, from before round 17) without ever freeing
 * its name (#890 round 20, G1): a run that started while it existed holds it as an entry, and srt follows a link at an
 * entry's name on every command. Round 19 removed the directory and made an empty one again, and in that gap a command
 * already running planted a link to /usr (by polling `ln -sT`, or by `rmdir` and then `ln`: those runs lost Bash,
 * measured). Now its contents are removed in place (a link inside is removed, never followed), the directory stays,
 * and git's record is dropped by `git worktree prune` once its `.git` is gone. The directory is checked to be a real
 * directory before and after: anything else fails closed.
 */
function emptyInPlace(o: WorktreeOptions, rec: string, path: string): boolean {
  const realDir = () => {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${path}, an old ${BRAND.cli} worktree, isn't a real directory any more; not touching it`);
  };
  realDir();
  // Data kept, as on main (round 20, the second review's FU1, measured): main's `git worktree remove` refused a
  // directory git no longer lists as a worktree, and kept it. So only a listed one, or one already empty, is emptied;
  // anything else is kept, logged, and reported as not removed.
  if (!listedWorktree(o, rec) && readdirSync(path).length > 0) {
    process.stderr.write(`${BRAND.cli}: kept ${path}: an old worktree of ours that git no longer lists, with files in it; not emptied\n`);
    return false;
  }
  for (const name of readdirSync(path)) rmSync(join(path, name), { recursive: true, force: true });
  realDir();
  spawnSync('git', ['worktree', 'prune'], { cwd: o.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  realDir();
  return dropWhenGone(o, rec, readdirSync(path).length === 0);
}

/** Our worktrees still on disk (for startup cleanup of terminal tasks). */
export function ownedWorktrees(o: WorktreeOptions): string[] {
  return owned(o).filter((p) => existsSync(p));
}
