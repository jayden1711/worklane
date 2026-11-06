// The repository's other checkouts, as the guard hook finds them at call time (#939): the main checkout, each linked
// worktree git lists, and each directory in a place task worktrees are made. The run's relative secret and hidden
// patterns hold in each of them too, exceptions applied relative to that checkout's own root (access.ts Secrets).
// WHY: a worktree made after a run starts gets the run's read-denials only as globs over the places (read-denials.ts),
// and none for a pattern an exception overlaps (`./.env.*` with `!./.env.example`), so its `.env.local` stayed
// readable to the Read tool and to paths a shell command names. Found again on every call, so a late one counts.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readRegular } from '../config/load.js';
import { WORKTREE_NAME_PREFIX } from '../worktrees.js';
import { projectStateDir } from './context.js';

/** Directories listed, at most, in one place for a search of a directory above it; past it the search is refused. */
export const PLACE_LIST_LIMIT = 1000;

export interface OtherCheckouts {
  /** The other checkout `abs` lies in (the deepest one holding it); null when it lies in none, or in the run's own. */
  of(abs: string): string | null;
  /** Every other checkout at or under `dir`, for a search of it; 'too-many' past PLACE_LIST_LIMIT in one place. */
  under(dir: string): string[] | 'too-many';
}

/** Is `p` `dir` or under it? */
const within = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

const realOr = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** A path as written (resolved) and by its real path. */
const forms = (p: string) => [...new Set([resolve(p), realOr(p)])];

/**
 * The common git directory `<dir>/.git` leads to, or null. The run's agent can write a worktree's `.git` file: each
 * file is read with readRegular (never a read that waits on a FIFO), and nothing here runs git. A `.git` that leads
 * elsewhere only hides linked worktrees from this list; the places below are found without it.
 */
function commonDir(dir: string): string | null {
  try {
    const dotGit = join(dir, '.git');
    if (lstatSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir: *(.+)$/m.exec(readRegular(dotGit) ?? '');
    if (!m) return null;
    const gitDir = resolve(dir, m[1]!.trim());
    return resolve(gitDir, readRegular(join(gitDir, 'commondir'))?.trim() || '.');
  } catch {
    return null;
  }
}

/** Each linked worktree the common git directory lists (worktrees/<name>/gitdir). */
function linkedWorktrees(common: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(common, 'worktrees'));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const g = readRegular(join(common, 'worktrees', n, 'gitdir'))?.trim();
      if (g) out.push(dirname(resolve(common, 'worktrees', n, g)));
    } catch {
      // Not a regular file: no checkout named.
    }
  }
  return out;
}

/**
 * The other checkouts of the repository around `root` (the run's own checkout). `worktreeRoot`: the project's
 * tests.worktree.root, resolved against the main checkout as the runner does (read-denials.ts).
 */
export function otherCheckouts(root: string, worktreeRoot: string): OtherCheckouts {
  const own = forms(root);
  const common = commonDir(root);
  const main = common && basename(common) === '.git' ? dirname(common) : null;
  const base = main ?? root;
  const fixed = [...(main ? [main] : []), ...(common ? linkedWorktrees(common) : [])].flatMap(forms);
  // A place that holds the main checkout (a worktree root of ".."): only the engine's own worktrees there count, by
  // name, as read-denials.ts does; any other directory there is not a task checkout.
  const places = [...new Set([resolve(base, worktreeRoot), join(projectStateDir(base), 'worktrees'), join(base, '.claude', 'worktrees')].flatMap(forms))];
  const mains = main ? forms(main) : [];
  const holdsMain = (place: string) => mains.some((m) => within(place, m));
  const counts = (place: string, name: string) => !holdsMain(place) || name.startsWith(WORKTREE_NAME_PREFIX);
  const isOwn = (c: string) => own.includes(c);

  return {
    of(abs) {
      let best = '';
      for (const c of [...own, ...fixed]) if (within(c, abs) && c.length > best.length) best = c;
      for (const place of places) {
        if (!within(place, abs) || place === abs) continue;
        const name = relative(place, abs).split(/[\\/]/)[0]!;
        const c = join(place, name);
        if (counts(place, name) && c.length > best.length) best = c;
      }
      return best && !isOwn(best) ? best : null;
    },
    under(dir) {
      const found = new Set(fixed.filter((c) => within(dir, c) && !isOwn(c)));
      for (const place of places) {
        if (!within(dir, place)) continue;
        let names: string[];
        try {
          names = readdirSync(place, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
          continue;
        }
        if (names.length > PLACE_LIST_LIMIT) return 'too-many';
        for (const n of names) if (counts(place, n) && !isOwn(join(place, n))) found.add(join(place, n));
      }
      return [...found];
    },
  };
}
