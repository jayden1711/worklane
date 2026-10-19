// Where the gated-merge benchmark keeps everything (#748): one root outside every repository and every engine state
// dir, ~/bench unless BENCH_ROOT_ENV names another. Task text, patches and grades are third-party data under each
// task's source licence, and the hidden tests must stay out of every agent's reach, so none of it lives in a repo.
// The bench is Linux-only (rootless Docker Engine in WSL2 or on Linux); it refuses to start elsewhere.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { HELD_OUT_ENV } from '../../src/held-out-paths.js';
import { stateDir } from '../../src/os/index.js';

/** Overrides the bench root (default ~/bench). */
export const BENCH_ROOT_ENV = `${BRAND.envPrefix}_BENCH_ROOT`;

export interface BenchLayout {
  root: string;
  /** The bench's own engine state: what the driver's state and held-out env point at. */
  state: string;
  /** Hidden fields, the dataset copy, the manifest, predictions and grades: 0700, never mounted into a container. */
  heldOut: string;
  /** The pinned dataset download (inside the held-out store: it carries the hidden tests). */
  data: string;
  /** Per run: each task's work dir (its clone, local remote and engine state), exported patches, results. */
  runs: string;
  /** The per-repo test wrappers, copied into each task container (nothing is mounted). */
  toolchain: string;
}

export function benchLayout(root: string): BenchLayout {
  const state = join(root, 'state');
  const heldOut = join(state, 'evals', 'held-out', 'swebench');
  return { root, state, heldOut, data: join(heldOut, 'dataset'), runs: join(root, 'runs'), toolchain: join(root, 'toolchain') };
}

/** Whether `p` is `dir` or inside it. */
export const inside = (p: string, dir: string): boolean => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** Places in a home the bench never reads, writes or mounts: logins and other credential stores. */
export const credentialPlaces = (home: string): string[] => ['.claude', '.claude.json', '.config', '.ssh', '.aws', '.gnupg', '.docker', '.netrc'].map((p) => join(home, p));

/**
 * The bench root, refused when it is inside (or holds) a place the bench must never touch: the engine's real state
 * dir, a held-out store the environment names, a login or credential store in this (the bench user's) home, or a
 * git checkout (the bench user's own clone included). Checked before anything is read or written.
 */
export function benchRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): BenchLayout {
  if (process.platform !== 'linux') throw new Error(`the benchmark runs on Linux only (rootless Docker Engine); this is ${process.platform}`);
  const raw = env[BENCH_ROOT_ENV] || join(home, 'bench');
  if (!isAbsolute(raw)) throw new Error(`${BENCH_ROOT_ENV} must be an absolute path, not ${raw}`);
  const root = resolve(raw);
  const realState = [stateDir(), join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), BRAND.cli), join(home, '.local', 'state', BRAND.cli)];
  const never = [...realState, env[HELD_OUT_ENV], ...credentialPlaces(home)].filter((p): p is string => Boolean(p));
  for (const p of never) {
    if (inside(root, p) || inside(p, root)) throw new Error(`the bench root ${root} overlaps ${p}, which the bench must never touch: set ${BENCH_ROOT_ENV} to a folder of its own (default ~/bench)`);
  }
  for (let d = root; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) throw new Error(`the bench root ${root} is inside a git checkout (${d}): task data and results must stay out of every repository`);
    if (dirname(d) === d) break;
  }
  return benchLayout(root);
}
