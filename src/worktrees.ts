// Worktrees the coordinator creates and owns. It never lists, touches or
// removes a worktree it didn't create: names carry our prefix AND must be in
// our ownership record, so other sessions' worktrees are always safe.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { projectCommand } from './os/index.js';

export interface WorktreeOptions {
  repo: string;
  root: string; // relative to repo, e.g. .claude/worktrees
  stateDir: string;
  setup: string[];
  /** Setup steps (e.g. npm ci) run the project's own scripts, so they run as the agent user when there is one. */
  runAs?: { user: string; home: string };
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
  mkdirSync(o.stateDir, { recursive: true });
  writeFileSync(ownedFile(o), JSON.stringify([...new Set(list)], null, 2));
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Paths Claude Code's sandbox protects from writes inside the working
 * directory. On Linux it makes a path read-only by mounting over it, so a
 * protected path that doesn't exist yet is first created, empty, as the
 * mount point, and stays in the worktree after the run. Observed with
 * Claude Code 2.1.282 on Linux; extend the list when a version adds more.
 */
export const SANDBOX_PLACEHOLDERS = [
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.profile',
  '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout',
  '.gitconfig', '.gitmodules', '.ripgreprc', '.mcp.json',
  '.vscode', '.idea',
  '.claude/commands', '.claude/agents', '.claude/launch.json', '.claude/loop.md',
];
const EXCLUDE_MARKER = `# ${BRAND.cli}: empty mount points Claude Code's sandbox leaves in worktrees; never commit them`;

/**
 * Keep the sandbox's placeholders out of anything an agent can commit: an
 * exclude block in the repo's shared info/exclude (it covers every
 * worktree). Exclusion only affects untracked files, so a change to a
 * tracked .bashrc or .gitmodules still shows.
 */
export function excludeSandboxPlaceholders(repo: string): void {
  const file = join(resolve(repo, git(repo, 'rev-parse', '--git-common-dir')), 'info', 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.includes(EXCLUDE_MARKER)) return;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${EXCLUDE_MARKER}\n${SANDBOX_PLACEHOLDERS.map((p) => `/${p}`).join('\n')}\n`);
}

/** After a run, remove the sandbox's leftover mount points: only empty, untracked ones. */
export function removeSandboxPlaceholders(worktree: string): string[] {
  const removed: string[] = [];
  for (const p of SANDBOX_PLACEHOLDERS) {
    const full = join(worktree, p);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (git(worktree, 'ls-files', '--', p)) continue; // tracked: the project's own file
    try {
      if (st.isFile() && st.size === 0) unlinkSync(full);
      else if (st.isDirectory() && readdirSync(full).length === 0) rmdirSync(full);
      else continue;
      removed.push(p);
    } catch {
      // not ours to remove (permissions): the exclude still keeps it out of commits
    }
  }
  return removed;
}

export function worktreePath(o: WorktreeOptions, name: string): string {
  return resolve(o.repo, o.root, `${BRAND.cli}-${name}`);
}

/** Create a worktree on a new branch at `base`, then run the project's setup steps. */
export function createWorktree(o: WorktreeOptions, name: string, branch: string, base: string): { path: string; setupErrors: string[] } {
  const path = worktreePath(o, name);
  if (existsSync(path)) removeWorktree(o, name);
  setOwned(o, [...owned(o), path]); // recorded before creation, so a crash mid-way is still cleaned up
  excludeSandboxPlaceholders(o.repo);
  git(o.repo, 'worktree', 'add', '-q', '-B', branch, path, base);
  const setupErrors: string[] = [];
  for (const step of o.setup) {
    const { file, args, env } = projectCommand(step, o.runAs);
    const r = spawnSync(file, args, { cwd: path, encoding: 'utf8', env, timeout: 900_000 });
    if (r.status !== 0) setupErrors.push(`${step}: exit ${r.status} ${(r.stderr || '').trim().split('\n').pop() ?? ''}`);
  }
  return { path, setupErrors };
}

/** Remove one of OUR worktrees; refuses anything not in the ownership record. Verified after. */
export function removeWorktree(o: WorktreeOptions, name: string): boolean {
  const path = worktreePath(o, name);
  if (!owned(o).includes(path)) throw new Error(`refusing to remove ${path}: not created by ${BRAND.cli}`);
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
