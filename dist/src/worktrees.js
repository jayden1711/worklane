// Worktrees the coordinator creates and owns. It never lists, touches or
// removes a worktree it didn't create: names carry our prefix AND must be in
// our ownership record, so other sessions' worktrees are always safe.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { childEnv, shellCommand } from './os/index.js';
const ownedFile = (o) => join(o.stateDir, 'worktrees.json');
function owned(o) {
    try {
        return JSON.parse(readFileSync(ownedFile(o), 'utf8'));
    }
    catch {
        return [];
    }
}
function setOwned(o, list) {
    mkdirSync(o.stateDir, { recursive: true });
    writeFileSync(ownedFile(o), JSON.stringify([...new Set(list)], null, 2));
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function worktreePath(o, name) {
    return resolve(o.repo, o.root, `${BRAND.cli}-${name}`);
}
/** Create a worktree on a new branch at `base`, then run the project's setup steps. */
export function createWorktree(o, name, branch, base) {
    const path = worktreePath(o, name);
    if (existsSync(path))
        removeWorktree(o, name);
    setOwned(o, [...owned(o), path]); // recorded before creation, so a crash mid-way is still cleaned up
    git(o.repo, 'worktree', 'add', '-q', '-B', branch, path, base);
    const setupErrors = [];
    for (const step of o.setup) {
        const [file, args] = shellCommand(step);
        const r = spawnSync(file, args, { cwd: path, encoding: 'utf8', env: childEnv(), timeout: 900_000 });
        if (r.status !== 0)
            setupErrors.push(`${step}: exit ${r.status} ${(r.stderr || '').trim().split('\n').pop() ?? ''}`);
    }
    return { path, setupErrors };
}
/** Remove one of OUR worktrees; refuses anything not in the ownership record. Verified after. */
export function removeWorktree(o, name) {
    const path = worktreePath(o, name);
    if (!owned(o).includes(path))
        throw new Error(`refusing to remove ${path}: not created by ${BRAND.cli}`);
    spawnSync('git', ['worktree', 'remove', '--force', path], { cwd: o.repo, encoding: 'utf8' });
    spawnSync('git', ['worktree', 'prune'], { cwd: o.repo });
    const gone = !existsSync(path) && !git(o.repo, 'worktree', 'list', '--porcelain').includes(`worktree ${path}\n`);
    if (gone)
        setOwned(o, owned(o).filter((p) => p !== path));
    return gone;
}
/** Our worktrees still on disk (for startup cleanup of terminal tasks). */
export function ownedWorktrees(o) {
    return owned(o).filter((p) => existsSync(p));
}
//# sourceMappingURL=worktrees.js.map