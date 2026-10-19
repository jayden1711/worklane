// Where the gated-merge benchmark keeps everything (#748): one root outside every repository and every engine state
// dir, ~/bench unless BENCH_ROOT_ENV names another. Task text, patches and grades are third-party data under each
// task's source licence, and the hidden tests must stay out of every agent's reach, so none of it lives in a repo.
// The bench is Linux-only (rootless Docker Engine in WSL2 or on Linux); it refuses to start elsewhere.
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

/** Whether something (a file, a folder or a link, dangling or not) is at `p`. */
const present = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * `p` with every symlink resolved: its longest existing ancestor through realpath, and the rest (not created yet)
 * appended. So a root that is, or sits under, a link into ~/.claude or a checkout is checked where it really is.
 * A component that exists but doesn't resolve (a dangling link, or a loop) is refused (`dangling: 'refuse'`, the
 * default: a link into a place that doesn't exist yet would be checked where it isn't), or, for the places the bench
 * must never touch (`'follow'`), followed through readlink so the place it names is checked even before it exists.
 */
export function realPath(p: string, dangling: 'refuse' | 'follow' = 'refuse', depth = 0): string {
  const rest: string[] = [];
  for (let d = resolve(p); ; d = dirname(d)) {
    try {
      return join(realpathSync(d), ...rest);
    } catch {
      if (present(d)) {
        if (dangling === 'refuse' || depth >= 40 || !lstatSync(d).isSymbolicLink()) throw new Error(`${d} is a link that doesn't resolve (dangling, or a loop): refusing ${p}; point it at a folder that exists, or remove it`);
        return realPath(join(resolve(dirname(d), readlinkSync(d)), ...rest), 'follow', depth + 1);
      }
      if (dirname(d) === d) return resolve(p);
      rest.unshift(basename(d));
    }
  }
}

/**
 * The bench user's home, from the user database (its passwd entry), never from $HOME (owner, 2026-10-18): a $HOME
 * moved elsewhere would put claude on another login and the bench's checks on another home. Refuses (throws) when
 * `env.HOME` is set and isn't that home (compared on real paths), rather than ignoring it: claude itself follows $HOME.
 */
export function benchHome(env: NodeJS.ProcessEnv = process.env, passwdHome: () => string = () => userInfo().homedir): string {
  const home = passwdHome();
  if (!home || !isAbsolute(home)) throw new Error(`the user database gives no absolute home for this user (${home || 'none'}): not starting`);
  if (env.HOME !== undefined && realPath(env.HOME) !== realPath(home)) {
    throw new Error(`HOME is ${env.HOME || '(empty)'}, not this user's home ${home} from the user database: not starting (log in with sudo -iu, or unset HOME)`);
  }
  return home;
}

/** Places in a home the bench never reads, writes or mounts: logins and other credential stores. */
export const credentialPlaces = (home: string): string[] => ['.claude', '.claude.json', '.config', '.ssh', '.aws', '.gnupg', '.docker', '.netrc'].map((p) => join(home, p));

/**
 * The bench root, refused when it is inside (or holds) a place the bench must never touch: the engine's real state
 * dir, a held-out store the environment names, a login or credential store in this (the bench user's) home, or a
 * git checkout (the bench user's own clone included). Checked before anything is read or written, on real paths (every
 * symlink resolved, on both sides; a root through a dangling link is refused): the layout is built on the resolved
 * root. The home is the bench user's passwd entry (benchHome), never $HOME.
 */
export function benchRoot(env: NodeJS.ProcessEnv = process.env, home = benchHome(env)): BenchLayout {
  if (process.platform !== 'linux') throw new Error(`the benchmark runs on Linux only (rootless Docker Engine); this is ${process.platform}`);
  const raw = env[BENCH_ROOT_ENV] || join(home, 'bench');
  benchHome(env, () => home);
  if (!isAbsolute(raw)) throw new Error(`${BENCH_ROOT_ENV} must be an absolute path, not ${raw}`);
  const root = realPath(raw);
  const realState = [stateDir(), join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), BRAND.cli), join(home, '.local', 'state', BRAND.cli)];
  const never = [...realState, env[HELD_OUT_ENV], ...credentialPlaces(home)].filter((p): p is string => Boolean(p)).flatMap((p) => [resolve(p), realPath(p, 'follow')]);
  for (const p of never) {
    if (inside(root, p) || inside(p, root)) throw new Error(`the bench root ${root} overlaps ${p}, which the bench must never touch: set ${BENCH_ROOT_ENV} to a folder of its own (default ~/bench)`);
  }
  for (let d = root; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) throw new Error(`the bench root ${root} is inside a git checkout (${d}): task data and results must stay out of every repository`);
    if (dirname(d) === d) break;
  }
  return benchLayout(root);
}
