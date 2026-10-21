// Cache keys: the sha256 of the files that pin what a cache holds (the lockfile), read at the run's commit from the
// coordinator's clone. A changed lockfile is a new key and so a new, empty cache, never a stale one; a key file the
// commit doesn't have is part of the key too ("missing"), so adding one later changes it.
import { gitExecFileSync } from '../os/git.js';
import { createHash } from 'node:crypto';
import type { TestRunCache } from './config.js';

export function cacheKey(repo: string, sha: string, files: readonly string[]): string {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0`);
    try {
      h.update(gitExecFileSync(['-C', repo, 'show', `${sha}:${f}`], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      h.update('\0missing\0');
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 32);
}

/** Each cache's variable -> its directory for this commit's key. */
export async function cacheDirs(caches: readonly TestRunCache[], repo: string, sha: string, dir: (name: string, key: string) => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of caches) out[c.env] = await dir(c.name, cacheKey(repo, sha, c.key));
  return out;
}
