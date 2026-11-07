// The default branch on a real remote, for the merge gate's tests that build a coordinator and call its gate directly
// (#784 rounds 7, 8: the gate measures a PR's change from the default branch's tip, fetched from the remote for each
// decision, and holds when that fetch fails).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** `dir`'s remote `origin` (a bare repository made for it when there is none) with `main` at `tip`, fetched. */
export function remoteAt(dir: string, tip: string): void {
  if (spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir }).status !== 0) {
    const bare = join(mkdtempSync(join(tmpdir(), 'remote-')), 'origin.git');
    git(tmpdir(), 'init', '-q', '--bare', bare);
    git(dir, 'remote', 'add', 'origin', bare);
  }
  git(dir, 'push', '-q', '--force', 'origin', `${tip}:refs/heads/main`);
  git(dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
}

/**
 * The remote's main at the clone's `origin/main` when a test set it, else at `base`; and the coordinator `c`'s cached
 * ls-remote answer the same (the gate itself fetches; the cache is what other steps read).
 */
export function knownTip(c: unknown, dir: string, base: string): void {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: dir, encoding: 'utf8' });
  const tip = r.status === 0 ? r.stdout.trim() : base;
  remoteAt(dir, tip);
  (c as { defaultTip: string }).defaultTip = tip;
}
