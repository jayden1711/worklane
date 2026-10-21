// A run's own read denials (#890): its task's hidden paths and its project's secret paths, as absolute entries for
// the OS sandbox's denyRead and the Read tool's deny rules (src/sandbox.ts, withDeniedReads). The guard hook
// (src/hook.ts) checks them on every call too; these hold when it doesn't run (a timeout, a crash, a bypass).
//
// How the sandbox reads an entry (sandbox-runtime 0.0.78, the library Claude Code's sandbox is built on: its
// README's Linux filesystem notes, and resolveReadPathEntries in dist/sandbox/sandbox-manager.js): a path is hidden
// with everything under it; a trailing `/**` means the directory; any other glob is expanded to what exists each
// time a command is wrapped, following symlinked directories. A path that doesn't exist then hides nothing, and `[`
// `]` are glob syntax there (`?` is any one character but "/").
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig, loadConfigAt } from './config/load.js';
import { TaskFile } from './contract.js';
import { projectStateDir } from './guardrails/context.js';
import { globToRegExp } from './guardrails/glob.js';
import { spawnSync } from './os/child-process.js';

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

/**
 * The nearest directory at or above `start` holding the config folder, found exactly as the hook finds its project
 * root (src/hook.ts findProjectRoot: existsSync, which follows a symlinked folder). The hook takes CLAUDE_PROJECT_DIR
 * first, which Claude Code sets to the run's cwd, the `start` here (inferred).
 */
function projectRoot(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, BRAND.configDir))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

interface Repository {
  checkouts: string[];
  /** The main checkout; null for a bare repository, and when it can't be found (`mainUnknown`). */
  main: string | null;
  /** The git directory isn't <checkout>/.git, records no core.worktree, and the repository isn't bare. */
  mainUnknown: boolean;
  linked: string[];
  stores: string[];
}

/**
 * The git repository around `start`: every checkout of it (this one, the main one, each linked worktree), where a
 * hidden or secret file can also sit, and its object stores (objects, alternates, LFS, and every submodule's store
 * under modules/), which hold every committed file's content whatever the checkout shows. None outside a repository.
 * The stores are read only `withStores`: a run that hides nothing isn't denied them, so a chain of alternates that
 * can't be followed doesn't refuse it.
 *
 * The main checkout is the common git directory's parent when that is ".git". Otherwise it is what git records
 * (core.worktree, which a submodule's git directory holds); a bare repository has none. A git directory made apart
 * from its checkout (`git init --separate-git-dir`) records nothing that leads back (measured, git 2.43.0), so
 * `mainUnknown` is set, and the caller needs the checkout from elsewhere or refuses.
 */
export function gitStores(start: string, withStores = true): Repository | { error: string } {
  let dir = resolve(start);
  let dotGit = join(dir, '.git');
  for (;;) {
    try {
      lstatSync(dotGit);
      break;
    } catch {
      if (dirname(dir) === dir) return { checkouts: [], main: null, mainUnknown: false, linked: [], stores: [] };
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
    let main: string | null = null;
    let mainUnknown = false;
    if (basename(common) === '.git') main = dirname(common);
    else {
      const worktree = git(common, ['config', '--get', 'core.worktree'], [0, 1]);
      if ('error' in worktree) return worktree;
      if (worktree.out.trim()) main = resolve(common, worktree.out.trim());
      else {
        const bare = git(common, ['rev-parse', '--is-bare-repository']);
        if ('error' in bare) return bare;
        mainUnknown = bare.out.trim() !== 'true';
      }
    }
    const linked: string[] = [];
    const named = listing(join(common, 'worktrees'));
    for (const n of named) {
      const g = optional(join(common, 'worktrees', n, 'gitdir'))?.trim();
      if (g) linked.push(dirname(resolve(common, 'worktrees', n, g)));
    }
    const repo = { checkouts: [...new Set([dir, ...(main ? [main] : []), ...linked])], main, mainUnknown, linked };
    if (!withStores) return { ...repo, stores: [] };
    const borrowed = alternates(common);
    if ('error' in borrowed) return borrowed;
    // The whole common git directory, not only its objects: rerere's preimages, rebase patches, lost-found, LFS and
    // every submodule's store (modules/, worktrees/<name>/modules/) hold committed or hidden content too, and git can't
    // work in such a run anyway once its objects are gone.
    const stores = [common, ...borrowed.stores];
    // A link out of a store (packs on another disk, say) is hidden by the mount over the store, its target isn't:
    // each link's real place is denied too. git-lfs's own storage may be set anywhere (lfs.storage, read against
    // the git directory when relative).
    const storeDirs = [join(common, 'objects'), ...borrowed.stores];
    const out = linkTargets([common, ...storeDirs.flatMap((s) => [s, join(s, 'pack'), join(s, 'info')])]);
    const lfs = git(common, ['config', '--get', 'lfs.storage'], [0, 1]);
    if ('error' in lfs) return lfs;
    if (lfs.out.trim()) out.push(resolve(common, lfs.out.trim()));
    return { ...repo, stores: [...new Set([...stores, ...out])] };
  } catch (e) {
    return { error: `the git repository at ${dotGit} can't be read (${firstLine(e)})` };
  }
}

/**
 * git, run on the git directory `common` alone: with none of this process's GIT_* variables, a C locale, no prompt,
 * stdin closed, and paths C-quoted whatever the repository's config says (core.quotePath on the command line). The
 * commands used here run no program a repository's config names (count-objects measured with a hostile config, git
 * 2.43.0; config --get and rev-parse --is-bare-repository likewise, round 5). Fail closed: git failing, an exit
 * status not in `ok`, or any stderr line `benign` doesn't match, is an error.
 */
function git(common: string, args: string[], ok: number[] = [0], benign?: RegExp): { out: string } | { error: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && k !== 'LANGUAGE') env[k] = v;
  const r = spawnSync('git', ['-c', 'core.quotePath=true', '--git-dir', common, ...args], {
    env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const said = (r.stderr ?? '').split('\n').find((l) => l.trim() && !benign?.test(l));
  const why = r.error ? firstLine(r.error) : r.status === null || !ok.includes(r.status) ? `exit ${r.status ?? r.signal}: ${said ?? ''}` : said;
  if (why !== undefined) return { error: `git ${args.join(' ')} in ${common}: ${why.slice(0, 200)}` };
  return { out: r.stdout ?? '' };
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
  const r = git(common, ['count-objects', '-v'], [0], STRAY_FILE_WARNING);
  if ('error' in r) return { error: `the chain of git alternates of ${common} can't be read in full (git: ${r.error}), so its stores can't all be denied` };
  const stores: string[] = [];
  for (const line of r.out.split('\n')) {
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

/**
 * The real places the symlinks directly in these directories lead to. A link that leads nowhere hides nothing and
 * is skipped; a directory that isn't there is skipped; anything else that can't be read throws (the run refuses).
 */
function linkTargets(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw e;
    }
    for (const e of entries) {
      if (!e.isSymbolicLink()) continue;
      try {
        const to = realpathSync(join(d, e.name));
        if (to === '/') throw new Error(`${join(d, e.name)} leads to /, which can't be denied`);
        out.push(to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
  return out;
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
 * An exception ("!./.env.example") is kept as the hook keeps it, within its own source only (one config, or the task):
 * a pattern it overlaps is passed as what it matches now, the exception left out, and as the whole pattern when that
 * can't be listed in full (stricter, never looser). It never subtracts from another source.
 *
 * `repo` is the instance's repository path, the coordinator's own record of the main checkout: always a checkout here,
 * whatever the run's `.git` says.
 *
 * Fail closed: a task file or project config that can't be read, a pattern the sandbox can't take as written, an
 * object store chain that can't be followed in full, or a main checkout that can't be found (no `repo`, and a git
 * directory that leads nowhere back), is an error, and the run doesn't start.
 */
export function runReadDenials(o: { cwd: string; home: string | undefined; taskFile?: string; repo?: string }): { paths: string[] } | { error: string } {
  let hidden: string[] = [];
  if (o.taskFile) {
    try {
      hidden = TaskFile.parse(JSON.parse(readFileSync(o.taskFile, 'utf8'))).hidden;
    } catch (e) {
      return { error: `the task file ${o.taskFile} can't be read (${firstLine(e)}), so its hidden paths can't be denied` };
    }
  }
  // A guarded run with no project root has every call denied by the hook (`no <config> found`): it doesn't start.
  const root = projectRoot(o.cwd);
  if (!root) return { error: `no ${BRAND.configDir} folder found at or above ${o.cwd}, so its project root (and secret paths) can't be found` };
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    return { error: `the guardrails in ${root} can't load (${firstLine(e)}), so its secret paths can't be denied` };
  }
  const repo = gitStores(root, hidden.length > 0);
  if ('error' in repo) return repo;
  const main = o.repo ? resolve(o.repo) : repo.main;
  if (!main && repo.mainUnknown) return { error: `the main checkout of the repository around ${o.cwd} can't be found (its git directory isn't <checkout>/.git and records no core.worktree), so its hidden and secret paths can't be denied` };
  // The run's own checkout's config is what its hook reads, and its agent can write it. The main checkout's and the
  // default branch's committed config (as src/config/live.ts reads it) count too, each worked out on its own (below):
  // emptying secret_paths in a worktree, or adding an exception there, drops nothing the others deny.
  const configs = [cfg];
  if (main && resolve(main) !== resolve(root) && existsSync(join(main, BRAND.configDir))) {
    try {
      configs.push(loadConfig(main));
    } catch (e) {
      return { error: `the guardrails in ${main} can't load (${firstLine(e)}), so its secret paths can't be denied` };
    }
  }
  const branch = configs[configs.length - 1]!.project.project.default_branch;
  try {
    configs.push(loadConfigAt(main ?? root, `refs/remotes/origin/${branch}`));
  } catch (e) {
    const missing = e instanceof ConfigInvalid && e.errors.every((x) => x.message.startsWith('missing at'));
    if (!missing) return { error: `the guardrails on the default branch (origin/${branch}) can't load (${firstLine(e)}), so its secret paths can't be denied` };
  }
  // Each source is worked out on its own, its exceptions applied to its own patterns only, and the results unioned:
  // an exception ("!/**", "!./.env") one source adds, the run's own checkout's above all (its agent can write it),
  // never subtracts what another denies. The task's hidden paths take no exception from any config (stricter than the
  // hook, which applies the config's exceptions to them too).
  const sources = [...new Map([...configs.map((c) => c.guardrails.secret_paths), hidden].map((s) => [JSON.stringify(s), s])).values()].filter((s) => s.length);
  const worktreeRoots = [...new Set(configs.map((c) => c.tests.worktree.root))];
  const all = sources.flat();
  if (!all.length) return { paths: [] };
  // A bracket the project or the task wrote is a character to the hook and a class to the sandbox: no entry means
  // the same to both. One in a path the runner resolved is written as "?" instead (asEntry).
  const written = all.find((p) => !p.startsWith('!') && SANDBOX_ONLY_GLOB.test(p));
  if (written) return { error: `${written} has "[" or "]", which the sandbox reads as a pattern; it can't be denied as written` };
  const roots = [...new Set([root, ...(main ? [main] : []), ...repo.checkouts])];
  const anchored = (ps: string[], under = roots) => {
    const out: string[] = [];
    for (const p of ps) {
      const a = anchor(p, under, o.home);
      if ('error' in a) return a;
      out.push(...a);
    }
    return out;
  };
  // Worked out on the real paths (a bracket in them is a plain character to globToRegExp, as to the hook); written
  // for the sandbox only as they're added.
  const entries = new Set<string>();
  const out = { add: (p: string) => entries.add(asEntry(p)) };
  // A checkout created after the run starts (a worker's worktree, made while an experiment runs): the hook matches a
  // relative pattern only inside the run's own checkout, so nothing else covers it. Each relative pattern is also a
  // glob over every place worktrees are made (the project's worktree root, the engine's own, and each existing
  // worktree's parent), which the sandbox expands each time a command is wrapped and a Read rule matches at call
  // time. Not for a command already running when the worktree appears: its mounts were fixed when it was wrapped.
  // A pattern an exception overlaps is listed at the start instead, in every directory under each parent (a checkout
  // git no longer lists among them), the exception left out: over a parent, a glob would hide the exception in every
  // worktree, the run's own among them.
  const base = main ?? root;
  const parents = new Set([...worktreeRoots.map((w) => resolve(base, w)), join(projectStateDir(base), 'worktrees'), ...repo.linked.map((l) => dirname(l))]);
  parents.delete('/');
  const under = [...parents].map((d) => join(d, '*'));
  const relative = (p: string) => !(p === '~' || p.startsWith('~/') || isAbsolute(p));
  for (const patterns of sources) {
    const added = addSource(patterns);
    if (added) return added;
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

  /** One source's entries, its own exceptions applied to its own patterns only; an error stops the run. */
  function addSource(patterns: string[]): { error: string } | null {
    const pos = anchored(patterns.filter((p) => !p.startsWith('!')));
    const neg = anchored(patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)));
    if ('error' in pos) return pos;
    if ('error' in neg) return neg;
    const negRes = neg.map(absRe);
    const excepted = (p: string) => negRes.some((re) => re.test(p.slice(1)));
    for (const a of pos) {
      const dir = dirForm(a);
      if (dir !== null) {
        // "dir/**" is the directory itself to the sandbox: one mount, whatever is created in it later. An exception
        // that names the directory itself excepts nothing beneath it, to the hook as here; only one that can match
        // beneath it makes the pattern overlapped.
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
    // The late-worktree globs (see above), with this source's exceptions only.
    const relNegs = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)).filter(relative);
    const relNeg = anchored(relNegs, ['/r']);
    if ('error' in relNeg) return relNeg;
    const lateNeg = anchored(relNegs, under);
    if ('error' in lateNeg) return lateNeg;
    const lateNegRes = lateNeg.map(absRe);
    const exceptedLate = (p: string) => excepted(p) || lateNegRes.some((re) => re.test(p.slice(1)));
    for (const p of patterns.filter((p) => !p.startsWith('!') && relative(p))) {
      const probe = anchored([p], ['/r']);
      if ('error' in probe) return probe;
      const late = anchored([p], under);
      if ('error' in late) return late;
      if (!probe.some((a) => overlaps(a, relNeg))) {
        for (const a of late) out.add(a);
        continue;
      }
      for (const a of late) {
        const now = expand(a);
        if (now) for (const m of now.filter((m) => !exceptedLate(m))) out.add(m);
        else out.add(a);
      }
    }
    return null;
  }
}
