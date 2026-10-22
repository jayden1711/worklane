// Worktrees the coordinator creates and owns. It never lists, touches or
// removes a worktree it didn't create: names carry our prefix AND must be in
// our ownership record, so other sessions' worktrees are always safe.
import { execFileSync, spawn, spawnSync } from './os/child-process.js';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
 * The one test of whether a place can't be hidden whole (#890 round 18): it is, or holds, one of `kept` (the main
 * checkout, the common git directory, the task file). worktreeDir and the run's denials (src/read-denials.ts
 * siblingCheckouts) both use it, so they can't disagree on a root.
 */
export function holdsKept(place: string, kept: readonly (string | null | undefined)[]): boolean {
  return kept.some((k) => typeof k === 'string' && k !== '' && holdsPath(place, k));
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
export function worktreeDir(repo: string, root: string): string {
  const base = resolve(repo, root);
  return holdsKept(base, [repo, commonGitDir(repo)]) ? join(base, WORKTREE_DIR_NAME) : base;
}

/**
 * Make one of the coordinator's places if it isn't there, never through a link (round 18, N1): a link there throws
 * before anything is made, since a make, a mount or `git worktree add` would follow it anywhere.
 */
export function makePlace(place: string): void {
  try {
    if (lstatSync(place).isSymbolicLink()) throw new Error(`${place} is a link`);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  mkdirSync(place, { recursive: true });
}

/** Where a new worktree named `name` is made: always in worktreeDir (round 18), never at an old path. */
function newWorktreePath(o: WorktreeOptions, name: string): string {
  return join(worktreeDir(o.repo, o.root), `${WORKTREE_NAME_PREFIX}${name}`);
}

/**
 * Where the worktree named `name` is, to find, reuse or remove it: one made before round 17 directly under a root that
 * holds the main checkout stays at that old path while the ownership record has it; otherwise where a new one goes.
 * Never used to make one (addWorktree makes every worktree at newWorktreePath).
 */
export function worktreePath(o: WorktreeOptions, name: string): string {
  const legacy = resolve(o.repo, o.root, `${WORKTREE_NAME_PREFIX}${name}`);
  const fresh = newWorktreePath(o, name);
  return fresh !== legacy && owned(o).includes(legacy) ? legacy : fresh;
}

/**
 * The coordinator's own places task worktrees are made in (#890): where it makes them (worktreeDir), the engine's own,
 * and, under a root that holds the main checkout, that root itself (its worktrees from before round 17 are hidden by
 * name there). One helper, so the places the coordinator makes at its start (recovery) and the ones every guarded run
 * hides (src/service.ts into the runner) can't differ.
 */
export function worktreePlaces(repo: string, root: string): string[] {
  const base = resolve(repo, root);
  const dir = worktreeDir(repo, root);
  return [...new Set([dir, ...(dir !== base ? [base] : []), join(projectStateDir(repo), 'worktrees')])];
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
  // The place itself is never a link (round 18, N1): git would make the checkout wherever it leads.
  const dir = dirname(path);
  try {
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir}, where ${BRAND.cli} makes its task worktrees, is a link; not making a worktree through it`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
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
 * done in the background (a worktree pool refilling while the coordinator keeps going).
 */
export async function createWorktreeAsync(o: WorktreeOptions, name: string, branch: string, base: string): Promise<{ path: string; setupErrors: string[] }> {
  const path = addWorktree(o, name, branch, base);
  const setupErrors: string[] = [];
  for (const step of o.setup) {
    const { file, args, env } = projectCommand(step, o.runAs, { ...o.env, ...o.cacheEnv });
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      const child = spawn(file, args, { cwd: path, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 900_000);
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ status: null, stderr });
      });
      child.on('close', (status) => {
        clearTimeout(timer);
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
  if (!owned(o).includes(path)) return;
  unlockWorktree(o.repo, path);
  spawnSync('git', ['worktree', 'prune'], { cwd: o.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function removeAt(o: WorktreeOptions, path: string): boolean {
  if (!owned(o).includes(path)) throw new Error(`refusing to remove ${path}: not created by ${BRAND.cli}`);
  unlockWorktree(o.repo, path);
  spawnSync('git', ['worktree', 'remove', '--force', path], { cwd: o.repo, encoding: 'utf8' });
  spawnSync('git', ['worktree', 'prune'], { cwd: o.repo });
  const gone = !existsSync(path) && !git(o.repo, 'worktree', 'list', '--porcelain').includes(`worktree ${path}\n`);
  if (gone) setOwned(o, owned(o).filter((p) => p !== path));
  return gone;
}

/** Our worktrees still on disk (for startup cleanup of terminal tasks). */
export function ownedWorktrees(o: WorktreeOptions): string[] {
  return owned(o).filter((p) => existsSync(p));
}
