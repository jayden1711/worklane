// What a tool call reads, lists or searches, and whether any of it is a secret path (a task's hidden ones among them).
// INVARIANT (#847): the guard's secret check takes every call's paths from callAccesses alone. A tool it doesn't know,
// and a field of a known tool it doesn't name, is read as a path (and, when it names a directory, as a search of it)
// on every string it holds, so a new tool or field is checked from the start, never let through.
import { lstatSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { globToRegExp } from './glob.js';
import type { SimpleCommand } from './shell.js';

/**
 * One place a call reaches. `path`: a file or directory it reads or writes (a directory counts for what is under it).
 * `tree`: a directory it lists or searches, every entry under it that one of `filter` matches (globs relative to it;
 * null: every entry; `expand: 'word'`: as the shell expands a word, where a wildcard never starts a dot-name).
 * `unchecked`: a request the guard can't place, refused.
 */
export type Access = { kind: 'path'; target: string } | { kind: 'tree'; target: string; filter: string[] | null; expand?: 'word' } | { kind: 'unchecked'; why: string };

/** The most entries one call's secret check walks, over all its accesses; past that, the call is refused. */
export const WALK_LIMIT = 20_000;
/**
 * WHY (#887 review): the most time one call's walks take, well under the agent hook's 30 s timeout (src/install.ts),
 * past which the call is refused: a hook that times out doesn't block the call.
 */
export const WALK_MS = 5_000;

/** The known tools' fields that hold only text, or that Glob, Grep and LS place themselves. Every other string a call holds is a path. */
const TEXT_FIELDS: Record<string, readonly string[]> = {
  Edit: ['old_string', 'new_string'],
  MultiEdit: ['edits'],
  Write: ['content'],
  NotebookEdit: ['new_source', 'cell_id', 'cell_type', 'edit_mode'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path', 'glob', 'type', 'output_mode'],
  LS: ['path', 'ignore'],
  Bash: ['command', 'description'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
  TodoWrite: ['todos'],
  Task: ['description', 'prompt', 'subagent_type'],
};
/** More strings than this in one field: refused, not half-checked. */
const MAX_STRINGS = 1000;

const str = (x: unknown) => (typeof x === 'string' && x.length > 0 ? x : null);

/** Every string in a value (an object's keys too), depth first; null past MAX_STRINGS of them or 20 levels deep. */
function strings(v: unknown, out: string[] = [], depth = 0): string[] | null {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') {
    if (depth > 20) return null;
    if (!Array.isArray(v)) out.push(...Object.keys(v));
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (!strings(x, out, depth + 1)) return null;
  }
  return out.length > MAX_STRINGS ? null : out;
}

/**
 * `{a,b}` alternatives, nested ones too, each with a class read as any one character; null past 64 of them. A brace
 * with no partner stays as it is (the shell leaves it so), and the word as written is always among them.
 */
function expandBraces(glob: string): string[] | null {
  const todo = [glob];
  const done = new Set<string>([glob]);
  while (todo.length) {
    const g = todo.pop()!;
    const close = g.indexOf('}');
    const open = close < 0 ? -1 : g.lastIndexOf('{', close);
    if (open < 0) done.add(g);
    else todo.push(...g.slice(open + 1, close).split(',').map((p) => g.slice(0, open) + p + g.slice(close + 1)));
    if (done.size + todo.length > 64) return null;
  }
  return [...done].map((a) => a.replace(/\[[^\]/]*\]/g, '?'));
}

/** A glob's alternatives in the guard's glob syntax; null: any path. */
function alternatives(glob: string): string[] | null {
  return glob.startsWith('!') ? null : expandBraces(glob);
}

const WILD = /[*?]/;

/** A path's segments: the literal ones up to the first wildcard, and the rest. */
function split(path: string): { literal: string[]; rest: string[] } {
  const segs = path.split(/[\\/]+/).filter(Boolean);
  const i = segs.findIndex((s) => WILD.test(s));
  return i < 0 ? { literal: segs, rest: [] } : { literal: segs.slice(0, i), rest: segs.slice(i) };
}

/**
 * A pattern relative to `base`: its literal segments join the base (so `..` and an absolute pattern land where they
 * point), the rest filters under it. With no base (a shell word), the target stays as written, for the check to
 * resolve against the call's directory and the home directory.
 */
function patternAccess(base: string | null, alt: string, asShell = false): Access {
  const { literal, rest } = split(alt);
  const target = isAbsolute(alt) ? resolve('/', ...literal) : base === null ? literal.join('/') || '.' : resolve(base, ...literal);
  if (rest.includes('..')) return { kind: 'unchecked', why: `a pattern with .. after a wildcard (${alt}) can't be checked for secret files; name the directory instead` };
  if (!rest.length) return { kind: 'path', target };
  return asShell ? { kind: 'tree', target, filter: [rest.join('/')], expand: 'word' } : { kind: 'tree', target, filter: [rest.join('/')] };
}

/** WHY (#887 review): glob and ripgrep read a backslash as an escape, which the guard's globs don't; so it's refused, not misread. */
const escaped = (pattern: string, field: string): Access | null =>
  pattern.includes('\\') ? { kind: 'unchecked', why: `a ${field} with a backslash (${pattern}) can't be checked for secret files; write it without one` } : null;

function globAccesses(input: Record<string, unknown>, cwd: string): Access[] {
  const path = str(input.path);
  const base = resolve(cwd, path ?? '.');
  // The path is checked as a path too, whatever the pattern points at: an absolute or `..` pattern leaves it (#887 review).
  const own: Access[] = path ? [{ kind: 'path', target: base }] : [];
  const pattern = str(input.pattern) ?? '**';
  const bad = escaped(pattern, 'Glob pattern');
  if (bad) return [...own, bad];
  const alts = alternatives(pattern);
  return [...own, ...(alts ? alts.map((a) => patternAccess(base, a)) : [{ kind: 'tree' as const, target: base, filter: null }])];
}

/** A comma outside braces, or whitespace: a glob some reader may split into several. */
function mayBeSeveral(glob: string): boolean {
  let depth = 0;
  for (const c of glob) {
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if ((c === ',' && depth === 0) || /\s/.test(c)) return true;
  }
  return false;
}

function grepAccesses(input: Record<string, unknown>, cwd: string): Access[] {
  const base = resolve(cwd, str(input.path) ?? '.');
  const glob = str(input.glob);
  const bad = glob ? escaped(glob, 'Grep glob') : null;
  if (bad) return [bad];
  // WHY (#887 review): whether the glob reaches ripgrep as one --glob or several is undocumented, so such a glob filters nothing.
  const alts = glob && !mayBeSeveral(glob) ? alternatives(glob) : null;
  if (!alts) return [{ kind: 'tree', target: base, filter: null }];
  // ripgrep matches a glob without a slash against each name at any depth, and one with a slash against the path
  // under the searched directory. Both readings are checked, so neither is the one that slips through.
  const out: Access[] = [{ kind: 'tree', target: base, filter: alts.map((a) => `**/${a.replace(/^\/+/, '')}`) }];
  for (const a of alts) if (a.includes('/')) out.push(patternAccess(base, a.replace(/^\/+/, '')));
  return out;
}

/** A shell word as the places it names: itself, and what the shell would expand it to (braces, wildcards, classes). */
function wordAccesses(w: string): Access[] {
  const out: Access[] = [{ kind: 'path', target: w }];
  if (!/[*?[{]/.test(w)) return out;
  const alts = expandBraces(w);
  if (!alts) return [...out, { kind: 'unchecked', why: `the shell word ${w} expands to too many paths to check for secret files` }];
  for (const a of alts) out.push(WILD.test(a) ? patternAccess(null, a, true) : { kind: 'path', target: a });
  return out;
}

/**
 * Every place a tool call reaches: the one classification the guard's secret check reads (see the INVARIANT above).
 * Bash: every word of every command (an option's value after `=` too, and what a wildcard or brace expands to) and
 * every file it redirects from or to.
 */
export function callAccesses(tool: string, input: Record<string, unknown>, cwd: string, commands: SimpleCommand[]): Access[] {
  const out: Access[] = [];
  if (tool === 'Glob') out.push(...globAccesses(input, cwd));
  else if (tool === 'Grep') out.push(...grepAccesses(input, cwd));
  else if (tool === 'LS') out.push({ kind: 'tree', target: resolve(cwd, str(input.path) ?? '.'), filter: null });
  for (const c of commands) {
    for (const w of [...c.argv, ...c.reads, ...c.writes]) {
      out.push(...wordAccesses(w));
      const eq = w.indexOf('=');
      if (eq >= 0 && eq < w.length - 1) out.push(...wordAccesses(w.slice(eq + 1)));
    }
  }
  const text = TEXT_FIELDS[tool] ?? [];
  for (const [k, v] of Object.entries(input)) {
    if (text.includes(k)) continue;
    const found = strings(v);
    if (!found) out.push({ kind: 'unchecked', why: `${tool}'s ${k} holds too many values to check for secret files` });
    // A path; and when it names a directory, a listing of all of it (a tool the guard doesn't know may list it).
    else for (const s of found) out.push({ kind: 'path', target: s }, { kind: 'tree', target: s, filter: null });
  }
  return out;
}

export interface SecretContext {
  projectRoot: string;
  /** For "~/" globs. */
  home?: string;
}

/** A glob's segments, each as a pattern for one name; null for `**` (any number of them). */
type Segs = (RegExp | null)[];
const segsOf = (segs: string[]): Segs => segs.map((s) => (s.includes('**') ? null : globToRegExp(s)));

/** Could a path strictly under `rel` (segments) match the glob segments `pat`? */
function reachesUnder(pat: Segs, rel: string[]): boolean {
  if (!rel.length) return pat.length > 0;
  if (!pat.length) return false;
  const [p, ...more] = pat;
  if (p === null) return reachesUnder(more, rel) || reachesUnder(pat, rel.slice(1));
  return p!.test(rel[0]!) && reachesUnder(more, rel.slice(1));
}

/** What a search keeps: a path's pattern, and its segments (to tell which directories could hold a match). */
interface Filter {
  re: RegExp;
  segs: Segs;
}

/** A filter glob; `shell`: as the shell expands a word (no `**`, and a wildcard never starts a dot-name). */
function filterOf(glob: string, shell: boolean): Filter {
  const parts = glob.split('/').filter(Boolean);
  if (!shell) return { re: globToRegExp(glob), segs: segsOf(parts) };
  const flat = parts.map((s) => s.replace(/\*\*+/g, '*'));
  const res = flat.map((s) => `${/^[*?]/.test(s) ? '(?!\\.)' : ''}${globToRegExp(s).source.slice(1, -1)}`);
  return { re: new RegExp(`^${res.join('/')}$`, 's'), segs: segsOf(flat) };
}

const posixRel = (from: string, to: string) => relative(from, to).split('\\').join('/');
/** Is `p` `dir` or under it? */
const within = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const SKIPPED = new Set(['.git', 'node_modules']);

/** The real path of `p` (its nearest existing parent's, for a path that doesn't exist), so a symlink can't hide where it leads. */
function real(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      if (dirname(cur) === cur) return p;
      rest.unshift(basename(cur));
    }
  }
}

/** A walked entry: whether it is a symlink, and a directory (where it leads, for a symlink). */
interface Entry {
  p: string;
  link: boolean;
  isDir: boolean;
  inSecret: boolean;
}

function dirAt(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function entryAt(p: string): Entry | null {
  try {
    const link = lstatSync(p).isSymbolicLink();
    return { p, link, isDir: dirAt(p), inSecret: false };
  } catch {
    return null;
  }
}

interface Glob {
  /** The directory paths are taken relative to: the project root, the home directory, or "/". */
  base: string;
  /** A home glob matches only under the home directory; a project glob is tested on the path relative to the root, `..` and all (as before #847). */
  homeOnly: boolean;
  re: RegExp;
  /** Where its matches start (the literal directories it names; "/" for a project glob that starts with `**`), and the glob segments under that. */
  at: string;
  rest: Segs;
  /** It names a directory to start from: a walk for it never skips .git or node_modules (#887 review). */
  literalStart: boolean;
}

function parseGlob(g: string, ctx: SecretContext): Glob | null {
  const home = g.startsWith('~/');
  const base = home ? ctx.home : isAbsolute(g) ? '/' : ctx.projectRoot;
  if (base === undefined) return null;
  let rest = home ? g.slice(2) : isAbsolute(g) ? g.slice(1) : g.replace(/^\.\//, '');
  if (rest.endsWith('/')) rest += '**';
  const s = split(rest);
  const anywhere = !home && !s.literal.length && (s.rest[0] ?? '').includes('**');
  return { base, homeOnly: home, re: globToRegExp(rest), at: anywhere ? '/' : resolve(base, ...s.literal), rest: segsOf(s.rest), literalStart: s.literal.length > 0 };
}

/**
 * The secret globs as the guard reads them: "~/" is the home directory, "./" or a bare path the project root, "/"
 * absolute; a leading "!" excludes (e.g. "!./.env.example").
 */
export class Secrets {
  private readonly pos: Glob[];
  private readonly neg: Glob[];
  /** One budget for every walk of the call this instance checks (WALK_LIMIT entries, WALK_MS); spent, every later walk refuses. */
  private seen = 0;
  private readonly deadline: number;

  /** One instance per tool call: its walk budget is the call's. */
  constructor(globs: string[], private readonly ctx: SecretContext, limits: { ms?: number } = {}) {
    this.deadline = Date.now() + (limits.ms ?? WALK_MS);
    const parse = (g: string) => {
      const p = parseGlob(g, ctx);
      return p ? [p] : [];
    };
    this.pos = globs.filter((g) => !g.startsWith('!')).flatMap(parse);
    this.neg = globs.filter((g) => g.startsWith('!')).flatMap((g) => parse(g.slice(1)));
  }

  private static hit(g: Glob, abs: string, dirToo: boolean): boolean {
    const rel = posixRel(g.base, abs);
    if (g.homeOnly && rel.startsWith('..')) return false;
    return g.re.test(rel) || (dirToo && g.re.test(`${rel}/`));
  }

  /** Is this absolute path a secret, or (`dirToo`) a directory every path under which is one? */
  at(abs: string, dirToo = true): boolean {
    return this.pos.some((g) => Secrets.hit(g, abs, dirToo)) && !this.neg.some((g) => Secrets.hit(g, abs, false));
  }

  /** A path as the call names it, made absolute ("~" is the home directory). */
  absolute(target: string, cwd: string): string {
    const home = this.ctx.home;
    const expanded = home && (target === '~' || target.startsWith('~/')) ? resolve(home, target.slice(2)) : target;
    return resolve(cwd, expanded);
  }

  /**
   * Where a search of `dir` has to walk to see every secret it could reach: a glob's start under `dir` (walked whole),
   * or `dir` itself for a glob that can match under it from above. Only a glob with no literal start (one that starts with `**`, or `.env.*`)
   * lets that walk skip .git and node_modules, as the chat lane's walk does. A root inside another walked one adds
   * nothing, unless that one skips what this one must not.
   */
  private walkRoots(dir: string): { root: string; skip: boolean }[] {
    const roots = new Map<string, boolean>();
    for (const g of this.pos) {
      if (g.at !== dir && within(dir, g.at)) roots.set(g.at, false);
      else if (within(g.at, dir) && reachesUnder(g.rest, posixRel(g.at, dir).split('/').filter(Boolean))) roots.set(dir, (roots.get(dir) ?? true) && !g.literalStart);
    }
    const all = [...roots].map(([root, skip]) => ({ root, skip }));
    const covered = (r: { root: string; skip: boolean }, o: { root: string; skip: boolean }) =>
      o.root !== r.root && within(o.root, r.root) && (!o.skip || (r.skip && !posixRel(o.root, r.root).split('/').some((s) => SKIPPED.has(s))));
    return all.filter((r) => !all.some((o) => covered(r, o)));
  }

  /** Whether the call's walk budget is spent (counting one more entry). */
  private spent(): boolean {
    return ++this.seen > WALK_LIMIT || (this.seen % 64 === 0 && Date.now() > this.deadline);
  }

  /**
   * The first secret a listing or search of `dir` reaches (an entry one of `filter` matches, relative to `dir`),
   * 'too-large' once the call's walk budget is spent, or null. It goes down only into directories that could hold a match.
   */
  private inTree(dir: string, filter: Filter[] | null): string | 'too-large' | null {
    if (Date.now() > this.deadline) return 'too-large';
    const wanted = (rel: string, isDir: boolean) => !filter || filter.some((f) => f.re.test(rel) || (isDir && f.re.test(`${rel}/`)));
    const holds = (rel: string) => !filter || filter.some((f) => reachesUnder(f.segs, rel.split('/').filter(Boolean)));
    for (const { root, skip } of this.walkRoots(dir)) {
      // `inSecret`: reached through a symlink that leads into a secret, so a secret wherever its own path points.
      const stack: Entry[] = [];
      const first = entryAt(root);
      if (first) stack.push(first);
      while (stack.length) {
        const { p, link, isDir, inSecret: above } = stack.pop()!;
        if (this.spent()) return 'too-large';
        const inSecret = above || (link && this.at(real(p)));
        const rel = posixRel(dir, p);
        if (p !== dir && (inSecret || this.at(p)) && wanted(rel, isDir)) return p;
        // A symlink is followed only into a secret (to test the filter on what is there); a loop ends at WALK_LIMIT.
        if (!isDir || (link && p !== root && !inSecret) || !holds(rel)) continue;
        let names: Dirent[];
        try {
          names = readdirSync(p, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of names) {
          if (skip && SKIPPED.has(d.name)) continue;
          const c = join(p, d.name);
          const l = d.isSymbolicLink();
          stack.push({ p: c, link: l, isDir: l ? dirAt(c) : d.isDirectory(), inSecret });
        }
      }
    }
    return null;
  }

  /** Why an access reaches a secret, or null. `tool` names it in the reason. */
  reached(a: Access, cwd: string, tool: string): string | null {
    if (a.kind === 'unchecked') return a.why;
    const abs = this.absolute(a.target, cwd);
    if (this.at(abs) || this.at(real(abs))) return `${a.target} holds credentials; agents never read them`;
    if (a.kind === 'path') return null;
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      return null;
    }
    if (!isDir) return null;
    const filter = a.filter?.map((f) => filterOf(f, a.expand === 'word')) ?? null;
    for (const dir of new Set([abs, real(abs)])) {
      const hit = this.inTree(dir, filter);
      if (hit === 'too-large') return `${a.target}: this call is too large to check for secret or hidden files (over ${WALK_LIMIT} entries or ${WALK_MS / 1000} s in all); give ${tool} a narrower path, or fewer patterns`;
      if (hit) return `a ${tool} of ${a.target}${a.filter ? ` (${a.filter.join(', ')})` : ''} would reach ${hit}, a secret or hidden path; agents never read them. Give it a narrower path, or a glob that leaves it out`;
    }
    return null;
  }
}
