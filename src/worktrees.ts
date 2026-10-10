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
  /** The project's own variables (tests.yaml env). */
  env?: Record<string, string>;
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
 * What Claude Code's sandbox leaves in a worktree. It protects some paths
 * from writes inside the working directory; on Linux it does that by
 * mounting over them, so a protected path that doesn't exist yet is first
 * created, empty, as the mount point, and stays after the run.
 *
 * Two kinds:
 * - Files and folders at the worktree root, from the sandbox's own list
 *   (in Claude Code 2.1.282: .gitconfig, .gitmodules, shell startup files,
 *   .ripgreprc, .mcp.json, .vscode, .idea), plus the other shell files.
 * - Anything under .claude/. Claude Code protects more of it with each
 *   version (commands, agents, launch.json, loop.md, output-styles,
 *   routines, scheduled_tasks.json, ...), so it is covered as a whole
 *   rather than by name. .claude/ is harness config: agents edit tracked
 *   files there through review, and never add new ones.
 */
export const SANDBOX_ROOT_PLACEHOLDERS = [
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.vscode', '.idea',
  '.bash_login', '.bash_logout', '.bash_aliases', '.zshenv', '.zlogin', '.zlogout',
];
const PROTECTED_DIR = '.claude';
const EXCLUDE_MARKER = `# ${BRAND.cli}: empty mount points Claude Code's sandbox leaves in worktrees; never commit them`;
const EXCLUDE_END = `# ${BRAND.cli}: end`;

/**
 * Keep the sandbox's placeholders out of anything an agent can commit: an
 * exclude block in the repo's shared info/exclude (it covers every
 * worktree), rewritten each time so it follows this list. Exclusion only
 * affects untracked files: changes to tracked ones still show.
 */
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
    const { file, args, env } = projectCommand(step, o.runAs, o.env);
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
