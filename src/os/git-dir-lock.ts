// An instance checkout's .git/, as scripts/setup/checkout.sh leaves it (#926), made so again by its coordinator.
//
// WHY: checkout.sh made the whole checkout group-writable for the agents' group, .git/ included, until #926. An agent
// could then rename its own file over .git/config, or add info/attributes, a hook or a commondir, and the coordinator's
// git, which runs there as itself, would read it. checkout.sh now locks .git/ (as root), but an install only reruns it
// by hand; the engine updater restarts every coordinator, and each one locks its own checkout's .git/ here first.
//
// INVARIANT: on return with no problems, .git/ and everything in it but AGENT_WRITABLE is owned by this user and
// writable by no one else (group and other write bits cleared, setgid kept). A file another user owns (an agent's
// `git push -u` once rewrote .git/config) is taken over: a copy of this user's own, renamed over it, in a directory this
// user owns. Anything it can't make so (a directory another user owns, a symlink, .git/ itself someone else's) is a
// problem, and the coordinator doesn't start (fail closed): checkout.sh, as root, fixes it.
// LIMIT: POSIX modes; on Windows (no instances run there) this does nothing.
import { copyFileSync, chmodSync, constants, lstatSync, readdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** What agents' worktrees write under the main .git/: their objects, refs, reflogs and worktree dirs (measured, #926), and git-lfs's and submodules' stores. */
export const AGENT_WRITABLE: ReadonlySet<string> = new Set(['objects', 'refs', 'logs', 'worktrees', 'lfs', 'modules']);

/** Lock `repo`'s .git/ as above; the problems left (empty: locked). */
export function lockGitDir(repo: string): string[] {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return [];
  const me = process.getuid();
  const top = join(repo, '.git');
  const problems: string[] = [];
  const lock = (p: string, isTop: boolean): void => {
    let s;
    try {
      s = lstatSync(p);
    } catch (e) {
      problems.push(`${p}: ${(e as Error).message}`);
      return;
    }
    if (s.isSymbolicLink()) return void problems.push(`${p} is a symlink (git never makes one there)`);
    if (isTop && !s.isDirectory()) return void problems.push(`${p} is not a directory`);
    const mode = s.mode & 0o7777;
    try {
      if (s.uid !== me) {
        if (isTop || !s.isFile()) return void problems.push(`${p} belongs to uid ${s.uid}, not this user`);
        const tmp = `${p}.${randomBytes(6).toString('hex')}.lock-take`;
        copyFileSync(p, tmp, constants.COPYFILE_EXCL);
        chmodSync(tmp, mode & ~0o022);
        renameSync(tmp, p);
      } else if (mode & 0o022) chmodSync(p, mode & ~0o022);
      if (s.isDirectory()) for (const name of readdirSync(p)) if (!(isTop && AGENT_WRITABLE.has(name))) lock(join(p, name), false);
    } catch (e) {
      problems.push(`${p}: ${(e as Error).message}`);
    }
  };
  lock(top, true);
  return problems;
}
