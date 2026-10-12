// A test run's workspace: the commit's tree, unpacked fresh for each run (never a shared worktree, never the
// coordinator's .git, which the test user can't read), then wiped with everything else of the run.
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { safeProjectEnv } from '../project-env.js';
import type { RunDatabase, RunHost } from './host.js';

/** `git archive` of `sha` as a tar stream, from the coordinator's clone. Rejects when git fails. */
export function treeTar(repo: string, sha: string): { stream: Readable; done: Promise<void> } {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  const child = spawn('git', ['-C', repo, 'archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git archive ${sha} failed: ${err.trim().slice(0, 500)}`))));
  });
  return { stream: child.stdout, done };
}

/** Make run `id`'s workspace from `sha`. */
export async function createWorkspace(host: RunHost, repo: string, sha: string, id: string): Promise<{ workdir: string }> {
  const tar = treeTar(repo, sha);
  const [ws] = await Promise.all([host.create(id, tar.stream), tar.done]);
  return ws;
}

/**
 * Everything a run's commands get, and nothing else: the project's own variables (the same rules as tests.yaml
 * env: no secret-like or harness names), the caches' directories, and the run's DATABASE_URL. Never this
 * process's environment, so no credential the coordinator holds can reach a run.
 */
export function runEnv(projectEnv: Record<string, string>, caches: Record<string, string>, db: RunDatabase | null): Record<string, string> {
  const env: Record<string, string> = { ...safeProjectEnv(projectEnv), ...safeProjectEnv(caches) };
  delete env.DATABASE_URL;
  if (db) env.DATABASE_URL = db.url;
  return env;
}

/** Wipe run `id`; a wipe that leaves anything behind throws, naming what is left. */
export async function wipeWorkspace(host: RunHost, id: string): Promise<void> {
  const r = await host.wipe(id);
  if (!r.ok) throw new Error(`run ${id} was not wiped: ${r.left.join(', ') || 'unknown'}`);
}
