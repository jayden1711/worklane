// A run's own read denials (#890): its task's hidden paths and its project's secret paths, as absolute entries for
// the OS sandbox's denyRead and the Read tool's deny rules (src/sandbox.ts, withDeniedReads). The guard hook
// (src/hook.ts) checks them on every call too; these hold when it doesn't run (a timeout, a crash, a bypass).
//
// How the sandbox reads an entry (sandbox-runtime 0.0.78, the library Claude Code's sandbox is built on: its
// README's Linux filesystem notes, and resolveReadPathEntries in dist/sandbox/sandbox-manager.js): a path is hidden
// with everything under it; a trailing `/**` means the directory; any other glob is expanded to what exists each
// time a command is wrapped. A path that doesn't exist then hides nothing, and `[` `]` are glob syntax there.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { loadConfig } from './config/load.js';
import { TaskFile } from './contract.js';
import { globToRegExp } from './guardrails/glob.js';

/** Directory entries listed, at most, to expand one pattern that has an exception; past it the pattern is denied whole. */
export const EXPAND_LIMIT = 5000;

const GLOB = /[*?]/;
/** Glob syntax to the sandbox, a plain character to a guardrail path: a path holding one can't be passed as written. */
const SANDBOX_ONLY_GLOB = /[[\]]/;

const firstLine = (e: unknown) => (e as Error).message.split('\n')[0]!.slice(0, 200);
/** An absolute pattern's regex, matched against an absolute path without its leading "/". */
const absRe = (p: string) => globToRegExp(p.slice(1));

/** The nearest directory at or above `start` holding the config folder: the hook's project root. */
function projectRoot(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    try {
      if (lstatSync(join(dir, BRAND.configDir)).isDirectory()) return dir;
    } catch {
      // not here
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The git repository around `start`: every checkout of it (this one, the main one, each linked worktree), where a
 * hidden or secret file can also sit, and its object stores (objects, alternates, LFS), which hold every committed
 * file's content whatever the checkout shows. None outside a repository.
 */
export function gitStores(start: string): { checkouts: string[]; stores: string[] } | { error: string } {
  let dir = resolve(start);
  let dotGit = join(dir, '.git');
  for (;;) {
    try {
      lstatSync(dotGit);
      break;
    } catch {
      if (dirname(dir) === dir) return { checkouts: [], stores: [] };
      dir = dirname(dir);
      dotGit = join(dir, '.git');
    }
  }
  try {
    let gitDir = dotGit;
    if (!lstatSync(dotGit).isDirectory()) {
      const m = /^gitdir: *(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!m) return { error: `${dotGit} names no git directory` };
      gitDir = resolve(dir, m[1]!.trim());
    }
    const common = resolve(gitDir, optional(join(gitDir, 'commondir'))?.trim() || '.');
    const checkouts = [dir, ...(basename(common) === '.git' ? [dirname(common)] : [])];
    for (const n of listing(join(common, 'worktrees'))) {
      const g = optional(join(common, 'worktrees', n, 'gitdir'))?.trim();
      if (g) checkouts.push(dirname(resolve(common, 'worktrees', n, g)));
    }
    const objects = join(common, 'objects');
    const alternates = (optional(join(objects, 'info', 'alternates')) ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => resolve(objects, l));
    return { checkouts: [...new Set(checkouts)], stores: [objects, ...alternates, join(common, 'lfs')] };
  } catch (e) {
    return { error: `the git repository at ${dotGit} can't be read (${firstLine(e)})` };
  }
}

/** A file's text, or null when there is none; any other failure throws. */
function optional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** A guardrail path, absolute: "~/" the run's home, "/" as is, anything else under each checkout. */
function anchor(p: string, roots: string[], home: string | undefined): string[] | { error: string } {
  let out: string[];
  if (p === '~' || p.startsWith('~/')) {
    if (!home) return { error: `"${p}" needs the run's home, and it has none` };
    out = [posix.join(home, p.slice(1))];
  } else if (isAbsolute(p)) out = [posix.normalize(p)];
  else out = roots.map((r) => posix.join(r, p));
  // A trailing "/" is "everything under", as the hook reads it.
  return out.map((a) => (p.endsWith('/') ? `${a.replace(/\/+$/, '')}/**` : a));
}

/**
 * What an absolute glob matches now, listed from its fixed directory down, without following links. Null when that
 * can't be done in full (a directory that can't be listed, or more than EXPAND_LIMIT entries).
 */
function expand(glob: string): string[] | null {
  const re = absRe(glob);
  const fixed = glob.split(/[*?]/)[0]!;
  const base = fixed.endsWith('/') ? fixed.slice(0, -1) : dirname(fixed);
  const depth = glob.includes('**') ? Infinity : glob.slice(base.length).split('/').length - 1;
  const found: string[] = [];
  let seen = 0;
  const stack: [string, number][] = [[base, 1]];
  while (stack.length) {
    const [dir, level] = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (dir === base && (e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return null;
    }
    for (const e of entries) {
      if (++seen > EXPAND_LIMIT) return null;
      const p = `${dir === '/' ? '' : dir}/${e.name}`;
      if (re.test(p.slice(1))) found.push(p);
      else if (e.isDirectory() && level < depth) stack.push([p, level + 1]);
    }
  }
  return found;
}

/**
 * The entries one run is denied for its task and project: the task file's hidden paths and the project's
 * secret_paths, under every checkout of the run's repository, "~/" under the run's home; and, when the task hides
 * anything, the repository's object stores, so `git show <rev>:<hidden>` has nothing to read.
 *
 * An exception ("!./.env.example") is kept as the hook keeps it: a pattern it overlaps is passed as what it matches
 * now, the exception left out, and as the whole pattern when that can't be listed in full (stricter, never looser).
 *
 * Fail closed: a task file or project config that can't be read, or a path the sandbox can't take as written, is an
 * error, and the run doesn't start.
 */
export function runReadDenials(o: { cwd: string; home: string | undefined; taskFile?: string }): { paths: string[] } | { error: string } {
  let hidden: string[] = [];
  if (o.taskFile) {
    try {
      hidden = TaskFile.parse(JSON.parse(readFileSync(o.taskFile, 'utf8'))).hidden;
    } catch (e) {
      return { error: `the task file ${o.taskFile} can't be read (${firstLine(e)}), so its hidden paths can't be denied` };
    }
  }
  const root = projectRoot(o.cwd);
  let secret: string[] = [];
  if (root) {
    try {
      secret = loadConfig(root).guardrails.secret_paths;
    } catch (e) {
      return { error: `the guardrails in ${root} can't load (${firstLine(e)}), so its secret paths can't be denied` };
    }
  }
  const patterns = [...secret, ...hidden];
  if (!patterns.length) return { paths: [] };
  const repo = gitStores(root ?? o.cwd);
  if ('error' in repo) return repo;
  const roots = [...new Set([root ?? resolve(o.cwd), ...repo.checkouts])];
  const anchored = (ps: string[]) => {
    const out: string[] = [];
    for (const p of ps) {
      const a = anchor(p, roots, o.home);
      if ('error' in a) return a;
      out.push(...a);
    }
    return out;
  };
  const pos = anchored(patterns.filter((p) => !p.startsWith('!')));
  const neg = anchored(patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)));
  if ('error' in pos) return pos;
  if ('error' in neg) return neg;
  const negRes = neg.map(absRe);
  const excepted = (p: string) => negRes.some((re) => re.test(p.slice(1)));
  const out = new Set<string>();
  for (const a of pos) {
    // "dir/**" is the directory itself to the sandbox: one mount, whatever is created in it later.
    const p = a.endsWith('/**') && !GLOB.test(a.slice(0, -3)) ? a.slice(0, -3) || '/' : a;
    if (!GLOB.test(p)) {
      if (!excepted(p)) out.add(p);
      continue;
    }
    const re = absRe(p);
    const overlapped = neg.some((n) => GLOB.test(n) || re.test(n.slice(1)));
    const now = overlapped ? expand(p) : null;
    if (now) for (const m of now.filter((m) => !excepted(m))) out.add(m);
    else out.add(p);
  }
  if (hidden.length) for (const s of repo.stores) out.add(s);
  for (const p of out) {
    if (SANDBOX_ONLY_GLOB.test(p)) return { error: `${p} has "[" or "]", which the sandbox reads as a pattern; it can't be denied as written` };
    if (GLOB.test(p)) {
      const fixed = p.split(/[*?]/)[0]!;
      const base = fixed.endsWith('/') ? fixed.slice(0, -1) : dirname(fixed);
      if (base === '' || base === '/') return { error: `${p} starts with a pattern; the sandbox needs a directory to start from, so it can't be denied` };
    }
  }
  return { paths: [...out] };
}
