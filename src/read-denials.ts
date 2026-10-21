// A run's own read denials (#890): its task's hidden paths and its project's secret paths, as absolute entries for
// the OS sandbox's denyRead and the Read tool's deny rules (src/sandbox.ts, withDeniedReads). The guard hook
// (src/hook.ts) checks them on every call too; these hold when it doesn't run (a timeout, a crash, a bypass).
//
// How the sandbox reads an entry (sandbox-runtime 0.0.78, the library Claude Code's sandbox is built on: its
// README's Linux filesystem notes, and resolveReadPathEntries in dist/sandbox/sandbox-manager.js): a path is hidden
// with everything under it; a trailing `/**` means the directory; any other glob is expanded to what exists each
// time a command is wrapped, following symlinked directories. A path that doesn't exist then hides nothing, and `[`
// `]` are glob syntax there (`?` is any one character but "/").
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { loadConfig } from './config/load.js';
import { TaskFile } from './contract.js';
import { projectStateDir } from './guardrails/context.js';
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

interface Repository {
  checkouts: string[];
  main: string | null;
  linked: string[];
  stores: string[];
}

/**
 * The git repository around `start`: every checkout of it (this one, the main one, each linked worktree), where a
 * hidden or secret file can also sit, and its object stores (objects, alternates, LFS), which hold every committed
 * file's content whatever the checkout shows. None outside a repository. The stores are read only `withStores`: a
 * run that hides nothing isn't denied them, so a chain of alternates that can't be followed doesn't refuse it.
 * `main` is the main checkout (none for a bare repository), `linked` the linked worktrees.
 */
export function gitStores(start: string, withStores = true): Repository | { error: string } {
  let dir = resolve(start);
  let dotGit = join(dir, '.git');
  for (;;) {
    try {
      lstatSync(dotGit);
      break;
    } catch {
      if (dirname(dir) === dir) return { checkouts: [], main: null, linked: [], stores: [] };
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
    const main = basename(common) === '.git' ? dirname(common) : null;
    const linked: string[] = [];
    for (const n of listing(join(common, 'worktrees'))) {
      const g = optional(join(common, 'worktrees', n, 'gitdir'))?.trim();
      if (g) linked.push(dirname(resolve(common, 'worktrees', n, g)));
    }
    const repo = { checkouts: [...new Set([dir, ...(main ? [main] : []), ...linked])], main, linked };
    if (!withStores) return { ...repo, stores: [] };
    const borrowed = alternates(common);
    if ('error' in borrowed) return borrowed;
    return { ...repo, stores: [join(common, 'objects'), ...borrowed.stores, join(common, 'lfs')] };
  } catch (e) {
    return { error: `the git repository at ${dotGit} can't be read (${firstLine(e)})` };
  }
}

/** What `git count-objects -v` may say on stderr about a store's own stray files: nothing about which stores it reads. */
const STRAY_FILE_WARNING = /^warning: (garbage found|no corresponding \.(pack|idx)): /;

/**
 * Every object store the repository whose git directory is `common` borrows from, as git itself reads the chain of
 * alternates: `git count-objects -v` prints one "alternate:" line per store, at the real path git opened. Taken
 * from git, not parsed here, so it can't be read differently from git (a relative line against the store's real
 * path, an untrimmed line, a quoted line, the depth git stops at).
 *
 * git runs with none of this process's GIT_* variables and a C locale; the paths it prints are C-quoted whatever the
 * repository's config says (core.quotePath on the command line). count-objects runs no program the repository's
 * config names (measured, git 2.43.0: fsmonitor, pager, hooksPath, editor, askPass, sshCommand, credential helper,
 * gpg, diff.external, include.path, alias; none ran).
 *
 * Fail closed: git failing, any stderr line other than a stray file in a store (a chain deeper than git follows, an
 * alternates file it can't read, a store that isn't there), or a line that can't be parsed, is an error.
 */
function alternates(common: string): { stores: string[] } | { error: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && k !== 'LANGUAGE') env[k] = v;
  const r = spawnSync('git', ['-c', 'core.quotePath=true', '--git-dir', common, 'count-objects', '-v'], {
    env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const said = (r.stderr ?? '').split('\n').find((l) => l.trim() && !STRAY_FILE_WARNING.test(l));
  const why = r.error ? firstLine(r.error) : r.status !== 0 ? `exit ${r.status ?? r.signal}: ${said ?? ''}` : said;
  if (why !== undefined) return { error: `the chain of git alternates of ${common} can't be read in full (git: ${why.slice(0, 200)}), so its stores can't all be denied` };
  const stores: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('alternate:')) continue;
    const text = line.slice('alternate:'.length).replace(/^ /, '');
    const p = text.startsWith('"') ? unquote(text) : text;
    if (p === null || !isAbsolute(p)) return { error: `git lists an object store of ${common} as ${text.slice(0, 200)}, which can't be read as a path, so it can't be denied` };
    stores.push(p);
  }
  return { stores };
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path git printed C-quoted ("…" with \n, \", \\, \303\251 and the like), or null when it isn't one or isn't UTF-8. */
function unquote(q: string): string | null {
  if (q.length < 2 || !q.startsWith('"') || !q.endsWith('"')) return null;
  const s = q.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return null;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[i + 1];
    if (n !== undefined && n in C_ESCAPES) {
      bytes.push(C_ESCAPES[n]!);
      i += 1;
    } else if (/^[0-3][0-7]{2}$/.test(s.slice(i + 1, i + 4))) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else return null;
  }
  const text = Buffer.from(bytes).toString('utf8');
  return Buffer.from(text, 'utf8').equals(Buffer.from(bytes)) ? text : null;
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

/** The directory a "dir/**" entry with no other glob in it stands for; null for any other entry. */
function dirForm(a: string): string | null {
  return a.endsWith('/**') && !GLOB.test(a.slice(0, -3)) ? a.slice(0, -3) || '/' : null;
}

/**
 * Whether an exception (an absolute pattern) can match a path under `dir`; true when that can't be ruled out. "*" and
 * "?" never match "/", so without "**" an exception matches only paths with as many parts as it has.
 */
function mayMatchBeneath(n: string, dir: string): boolean {
  const under = `${dir === '/' ? '' : dir}/`;
  if (!GLOB.test(n)) return n.startsWith(under);
  const fixed = n.split(/[*?]/)[0]!;
  if (fixed.startsWith(under)) return true;
  if (!under.startsWith(fixed)) return false;
  return n.includes('**') || n.split('/').length > dir.split('/').length;
}

/** Whether one of these exceptions can except something the absolute pattern `a` matches (true when unsure). */
function overlaps(a: string, neg: string[]): boolean {
  const dir = dirForm(a);
  if (dir !== null) return neg.some((n) => mayMatchBeneath(n, dir));
  const re = absRe(a);
  return neg.some((n) => GLOB.test(n) || re.test(n.slice(1)));
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
  let worktreeRoot: string | null = null;
  if (root) {
    try {
      const cfg = loadConfig(root);
      secret = cfg.guardrails.secret_paths;
      worktreeRoot = cfg.tests.worktree.root;
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
  const anchored = (ps: string[], under = roots) => {
    const out: string[] = [];
    for (const p of ps) {
      const a = anchor(p, under, o.home);
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
    const dir = dirForm(a);
    if (dir !== null) {
      // "dir/**" is the directory itself to the sandbox: one mount, whatever is created in it later. An exception that
      // names the directory itself excepts nothing beneath it, to the hook as here; only one that can match beneath it
      // makes the pattern overlapped.
      const now = overlaps(a, neg) ? expand(a) : null;
      if (now) for (const m of now.filter((m) => !excepted(m))) out.add(m);
      else out.add(dir);
      continue;
    }
    if (!GLOB.test(a)) {
      if (!excepted(a)) out.add(a);
      continue;
    }
    const now = overlaps(a, neg) ? expand(a) : null;
    if (now) for (const m of now.filter((m) => !excepted(m))) out.add(m);
    else out.add(a);
  }
  // A checkout created after the run starts (a worker's worktree, made while an experiment runs): the hook matches a
  // relative pattern only inside the run's own checkout, so nothing else covers it. Each relative pattern is also a
  // glob over every place worktrees are made (the project's worktree root, the engine's own, and each existing
  // worktree's parent), which the sandbox expands on every command and a Read rule matches at call time. A pattern an
  // exception overlaps is left to what it matches now (above): over a parent, the exception would be hidden in every
  // worktree, the run's own among them.
  const base = repo.main ?? root ?? resolve(o.cwd);
  const parents = new Set([...(worktreeRoot ? [resolve(base, worktreeRoot)] : []), join(projectStateDir(base), 'worktrees'), ...repo.linked.map((l) => dirname(l))]);
  parents.delete('/');
  const relative = (p: string) => !(p === '~' || p.startsWith('~/') || isAbsolute(p));
  const relNeg = anchored(patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)).filter(relative), ['/r']);
  if ('error' in relNeg) return relNeg;
  for (const p of patterns.filter((p) => !p.startsWith('!') && relative(p))) {
    const probe = anchored([p], ['/r']);
    if ('error' in probe || probe.some((a) => overlaps(a, relNeg))) continue;
    const late = anchored([p], [...parents].map((d) => join(d, '*')));
    if ('error' in late) return late;
    for (const a of late) out.add(a);
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
