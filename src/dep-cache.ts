// Dependency caches shared by one instance's tasks, so a new worktree's setup (pip, uv, npm, pnpm, yarn)
// downloads each package once instead of on every task. Per instance, never across instances: the cache
// lives under the instance's own root, in the group its agents share (2770, so their setup steps can fill
// it), and two instances never point at the same directory.
//
// On by default, and why that adds no new trust boundary: the cache is per instance only, never shared
// across instances, and an instance's agents already share one group-writable checkout, so a task that could
// tamper with the cache could already tamper with the code the next task starts from. Within that, npm and
// pnpm check every cached package against its integrity hash; pip's and uv's caches are keyed by URL and file
// hash. A project that would rather pay the downloads sets worktree.dep_cache off.
import { join, relative, resolve, isAbsolute } from 'node:path';
import { agentWritableDir } from './os/index.js';

/** Each tool's cache variable, and its subdirectory in the instance's cache. */
export const CACHE_VARS: Record<string, string> = {
  PIP_CACHE_DIR: 'pip',
  UV_CACHE_DIR: 'uv',
  npm_config_cache: 'npm',
  npm_config_store_dir: 'pnpm-store',
  YARN_CACHE_FOLDER: 'yarn',
};

/** An instance's cache directory: under its own root (beside its checkout), never anywhere shared. */
export function depCacheDir(instanceRoot: string): string {
  return join(instanceRoot, 'cache');
}

/** The variables that point every supported tool at the instance's cache. */
export function depCacheEnv(cacheDir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(CACHE_VARS).map(([v, sub]) => [v, join(cacheDir, sub)]));
}

/**
 * Make the cache ready for the instance's agents: the directory and one per tool, owned by the coordinator,
 * group `gid` (the agents' shared group), 2770. Refuses a cache outside the instance's root.
 */
export function prepareDepCache(instanceRoot: string, gid: number): { dir: string; env: Record<string, string> } {
  const dir = depCacheDir(instanceRoot);
  const rel = relative(resolve(instanceRoot), resolve(dir));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`dependency cache ${dir} is not inside the instance's root ${instanceRoot}`);
  agentWritableDir(dir, gid);
  for (const sub of Object.values(CACHE_VARS)) agentWritableDir(join(dir, sub), gid);
  return { dir, env: depCacheEnv(dir) };
}
