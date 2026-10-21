// A run's own read denials (#890): its task's hidden paths and its project's secret paths, as absolute entries for
// the OS sandbox's denyRead and the Read tool's deny rules (src/sandbox.ts, withDeniedReads). The guard hook
// (src/hook.ts) checks them on every call too; these hold when it doesn't run (a timeout, a crash, a bypass).
//
// How the sandbox reads an entry (sandbox-runtime 0.0.78, the library Claude Code's sandbox is built on: its
// README's Linux filesystem notes, and resolveReadPathEntries in dist/sandbox/sandbox-manager.js): a path is hidden
// with everything under it; a trailing `/**` means the directory; any other glob is expanded to what exists each
// time a command is wrapped, following symlinked directories. A path that doesn't exist then hides nothing, and `[`
// `]` are glob syntax there (`?` is any one character but "/").
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { loadConfig } from './config/load.js';
import { TaskFile } from './contract.js';
import { globToRegExp } from './guardrails/glob.js';

/** Directory entries listed, at most, to expand one pattern that has an exception; past it the pattern is denied whole. */
export const EXPAND_LIMIT = 5000;

const GLOB = /[*?]/;
/** Glob syntax to the sandbox, a plain character to a guardrail path: a pattern holding one can't be passed as written. */
const SANDBOX_ONLY_GLOB = /[[\]]/;

/**
 * A path the runner resolved itself (a checkout, the home, a store, a file a glob matched), as the sandbox takes it:
 * each "[" or "]" written as "?". The sandbox reads "?" as any one character, the bracket among them, so the entry
 * still hides that path, and at most a few same-length siblings with it: stricter, never looser.
 */
const asEntry = (p: string) => p.replace(/[[\]]/g, '?');

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
 * file's content whatever the checkout shows. None outside a repository. The stores are read only `withStores`: a
 * run that hides nothing isn't denied them, so a chain of alternates that can't be followed doesn't refuse it.
 */
export function gitStores(start: string, withStores = true): { checkouts: string[]; stores: string[] } | { error: string } {
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
    if (!withStores) return { checkouts: [...new Set(checkouts)], stores: [] };
    const objects = join(common, 'objects');
    const borrowed = alternates(objects);
    if ('error' in borrowed) return borrowed;
    return { checkouts: [...new Set(checkouts)], stores: [objects, ...borrowed.stores, join(common, 'lfs')] };
  } catch (e) {
    return { error: `the git repository at ${dotGit} can't be read (${firstLine(e)})` };
  }
}

/**
 * How many stores down a chain of alternates git reads: the repository's own alternates, and theirs, 6 levels in all
 * (measured, git 2.43: a blob 6 stores down is read, 7 down isn't, "ignoring alternate object stores, nesting too deep").
 */
export const ALTERNATES_DEPTH = 6;

/**
 * Every object store `objects` borrows from through info/alternates, down the chain as git follows it: each relative
 * path read against the store that names it, a store already listed not followed again. Fail closed: a chain deeper
 * than git follows, or a quoted line (git unquotes it; this doesn't), is an error; a file that can't be read throws.
 */
function alternates(objects: string): { stores: string[] } | { error: string } {
  const stores: string[] = [];
  const seen = new Set([objects]);
  let level = [objects];
  for (let depth = 1; level.length; depth++) {
    const next: string[] = [];
    for (const store of level) {
      const file = join(store, 'info', 'alternates');
      for (const line of (optional(file) ?? '').split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#')) continue;
        if (l.startsWith('"')) return { error: `${file} names a quoted path, which can't be followed, so the stores behind it can't be denied` };
        const s = resolve(store, l);
        if (seen.has(s)) continue;
        if (depth > ALTERNATES_DEPTH) return { error: `${file} borrows from ${s}, deeper than git follows alternates (${ALTERNATES_DEPTH} stores), so the chain can't be denied in full` };
        seen.add(s);
        stores.push(s);
        next.push(s);
      }
    }
    level = next;
  }
  return { stores };
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
 * What an absolute glob matches now, listed from its fixed directory down. Null when that can't be done in full: a
 * directory that can't be listed, more than EXPAND_LIMIT entries, or a symlinked directory it would descend into. The
 * hook matches what is behind such a link under the link's name, and the sandbox follows it when it expands the glob
 * as written, so the whole glob is passed (stricter, never looser).
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
      else if (level < depth) {
        if (e.isDirectory()) stack.push([p, level + 1]);
        else if (e.isSymbolicLink() && linksToDirectory(p)) return null;
      }
    }
  }
  return found;
}

/** Whether a symlink leads to a directory; one that leads nowhere doesn't, and one that can't be followed counts as one. */
function linksToDirectory(link: string): boolean {
  try {
    return statSync(link).isDirectory();
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * The entries one run is denied for its task and project: the task file's hidden paths and the project's
 * secret_paths, under every checkout of the run's repository, "~/" under the run's home; and, when the task hides
 * anything, the repository's object stores, so `git show <rev>:<hidden>` has nothing to read.
 *
 * An exception ("!./.env.example") is kept as the hook keeps it: a pattern it overlaps is passed as what it matches
 * now, the exception left out, and as the whole pattern when that can't be listed in full (stricter, never looser).
 *
 * Fail closed: a task file or project config that can't be read, a pattern the sandbox can't take as written, or an
 * object store chain that can't be followed in full, is an error, and the run doesn't start.
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
  // A bracket the project or the task wrote is a character to the hook and a class to the sandbox: no entry means
  // the same to both. One in a path the runner resolved is written as "?" instead (asEntry).
  const written = patterns.find((p) => !p.startsWith('!') && SANDBOX_ONLY_GLOB.test(p));
  if (written) return { error: `${written} has "[" or "]", which the sandbox reads as a pattern; it can't be denied as written` };
  const repo = gitStores(root ?? o.cwd, hidden.length > 0);
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
  // Worked out on the real paths (a bracket in them is a plain character to globToRegExp, as to the hook); written
  // for the sandbox only as they're added.
  const entries = new Set<string>();
  const out = { add: (p: string) => entries.add(asEntry(p)) };
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
  for (const p of entries) {
    if (GLOB.test(p)) {
      const fixed = p.split(/[*?]/)[0]!;
      const base = fixed.endsWith('/') ? fixed.slice(0, -1) : dirname(fixed);
      if (base === '' || base === '/') return { error: `${p} starts with a pattern; the sandbox needs a directory to start from, so it can't be denied` };
    }
  }
  return { paths: [...entries] };
}
