// The commit secret scan's model of an agent's shell command (#971): which commit it makes, in which checkout, and
// what that commit records. The guard (src/hook.ts) scans that before the command runs, and refuses a command line it
// can't model, so a commit is never let through on a scan of something other than what it records.
// INVARIANT (#785): imports only node built-ins and src/guardrails/** (see src/guard/research.ts); the git queries
// it needs come from its caller.
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { basename, splitCommands, type SimpleCommand } from '../guardrails/shell.js';

/** What one scan of a checkout covers, on top of the staged changes it always covers. */
export interface CommitScope {
  /** Tracked files' unstaged changes. */
  unstaged: boolean;
  /** Untracked files that are not ignored. */
  untracked: boolean;
  /** The current HEAD commit's own changes. */
  head: boolean;
}

export interface CommitScan {
  /** The checkout's top level, where the scan runs. */
  top: string;
  scope: CommitScope;
}

export type CommitPlan = { refuse: string } | { scans: CommitScan[] };

/** A git query the plan needs, run by the caller: argv after `git`, from `cwd`. */
export type GitQuery = (cwd: string, args: string[]) => { status: number | null; stdout: string };

class Unmodelled extends Error {}

const EXPANSION = '\u0000';

interface Word {
  /** The word's text; each expansion in it is EXPANSION. */
  text: string;
  /** Command substitutions in the word (they run before its command). */
  subs: Cmd[][][];
  /** Source spans of each substitution, in order with `subs`. */
  spans: [number, number][];
}

interface Cmd {
  words: Word[];
  /** A redirect writes a file (anything but /dev/null). */
  writes: boolean;
  /** Source spans of the bodies of here-documents this command reads. */
  heredocs: [number, number][];
  /** Its redirects' file words: their substitutions run before it too. */
  targets: Word[];
}

const plain = (w: Word) => !w.text.includes(EXPANSION);

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'function', 'time', 'coproc', '[[', ']]', '!']);
const DELIMS = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * A strict reading of a command line: only the shell syntax whose meaning is the same in bash and zsh and fully known
 * here. Anything else throws Unmodelled. WHY: a commit is let through only when the guard knows exactly what runs.
 */
class Parser {
  private i = 0;
  private pending: { delim: string; cmd: Cmd }[] = [];

  constructor(private readonly s: string) {}

  parse(): Cmd[][] {
    const list = this.list(false);
    if (this.pending.length) throw new Unmodelled('a here-document has no body');
    return list;
  }

  private fail(what: string): never {
    throw new Unmodelled(what);
  }

  /** Pipelines, each a list of commands, until the end (or the `)` closing a substitution). */
  private list(inSub: boolean): Cmd[][] {
    const s = this.s;
    const pipelines: Cmd[][] = [];
    let pipeline: Cmd[] = [];
    let cmd: Cmd | null = null;
    const endCmd = () => {
      if (cmd) {
        if (!cmd.words.length) this.fail('a redirect without a command');
        pipeline.push(cmd);
      }
      cmd = null;
    };
    const endPipeline = (needCommand: boolean) => {
      const had = cmd !== null;
      endCmd();
      if (needCommand && !had) this.fail('an operator without a command before it');
      if (pipeline.length) pipelines.push(pipeline);
      pipeline = [];
    };
    const current = (): Cmd => (cmd ??= { words: [], writes: false, heredocs: [], targets: [] });
    for (;;) {
      if (this.i >= s.length) {
        if (inSub) this.fail('an unclosed substitution');
        endPipeline(false);
        return pipelines;
      }
      const c = s[this.i]!;
      if (c === ' ' || c === '\t') {
        this.i++;
        continue;
      }
      if (c === '\\' && s[this.i + 1] === '\n') {
        if (this.pending.length) this.fail('a line continuation after a here-document');
        this.i += 2;
        continue;
      }
      if (c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '\n') {
        this.i++;
        endPipeline(false);
        this.bodies();
        continue;
      }
      if (c === ')') {
        if (!inSub) this.fail('an unmatched )');
        if (this.pending.length) this.fail('a here-document without its body');
        this.i++;
        endPipeline(false);
        return pipelines;
      }
      if (c === ';') {
        if (s[this.i + 1] === ';') this.fail(';;');
        this.i++;
        endPipeline(true);
        continue;
      }
      if (c === '&') {
        if (s[this.i + 1] === '&') {
          this.i += 2;
          endPipeline(true);
          continue;
        }
        if (s[this.i + 1] === '>') {
          this.i += s[this.i + 2] === '>' ? 3 : 2;
          this.redirectTarget(current());
          continue;
        }
        this.fail('a command run in the background');
      }
      if (c === '|') {
        if (s[this.i + 1] === '|') {
          this.i += 2;
          endPipeline(true);
          continue;
        }
        if (s[this.i + 1] === '&') this.fail('|&');
        this.i++;
        if (!cmd) this.fail('a pipe without a command before it');
        endCmd();
        continue;
      }
      if (c === '>') {
        this.redirect(current());
        continue;
      }
      if (/[0-9]/.test(c)) {
        const m = /^([0-9])(>>?|<)/.exec(s.slice(this.i));
        if (m) {
          this.i += 1;
          if (m[2] === '<') this.inputRedirect(current());
          else this.redirect(current());
          continue;
        }
      }
      if (c === '<') {
        this.inputRedirect(current());
        continue;
      }
      if (c === '(') this.fail('a subshell or function');
      const w = this.word();
      const cm = current();
      if (!cm.words.length && RESERVED.has(w.text)) this.fail(`the shell keyword ${w.text}`);
      if (!cm.words.length && (w.text === '{' || w.text === '}')) this.fail('a command group');
      cm.words.push(w);
    }
  }

  /** `>` or `>>`, then `&N` or a file. */
  private redirect(cmd: Cmd) {
    const s = this.s;
    this.i += s[this.i + 1] === '>' ? 2 : 1;
    if (s[this.i] === '|') this.fail('>|');
    if (s[this.i] === '&') {
      this.i++;
      if (!/[0-9]/.test(s[this.i] ?? '')) this.fail('a redirect to a file descriptor that is not a number');
      while (/[0-9]/.test(s[this.i] ?? '')) this.i++;
      return;
    }
    this.redirectTarget(cmd);
  }

  private redirectTarget(cmd: Cmd) {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
    const w = this.word();
    cmd.targets.push(w);
    if (w.text !== '/dev/null') cmd.writes = true;
  }

  /** `< file`, or a here-document `<<'WORD'` (its delimiter quoted, so its body is text). */
  private inputRedirect(cmd: Cmd) {
    const s = this.s;
    if (s[this.i + 1] !== '<') {
      this.i++;
      while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
      cmd.targets.push(this.word());
      return;
    }
    if (s[this.i + 2] === '<' || s[this.i + 2] === '-') this.fail('a here-string or tab-stripped here-document');
    this.i += 2;
    while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
    const q = s[this.i];
    if (q !== "'" && q !== '"') this.fail('a here-document whose delimiter is not quoted');
    const end = s.indexOf(q, this.i + 1);
    const delim = end < 0 ? '' : s.slice(this.i + 1, end);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(delim)) this.fail('a here-document delimiter');
    this.i = end + 1;
    if (!DELIMS.has(s[this.i] ?? ' ')) this.fail('a here-document delimiter');
    this.pending.push({ delim, cmd });
  }

  /** After a newline: the bodies of the here-documents its line opened, in order. */
  private bodies() {
    const s = this.s;
    for (const { delim, cmd } of this.pending) {
      const start = this.i;
      for (;;) {
        if (this.i >= s.length) this.fail('a here-document without its closing line');
        const nl = s.indexOf('\n', this.i);
        const line = s.slice(this.i, nl < 0 ? s.length : nl);
        const lineStart = this.i;
        this.i = nl < 0 ? s.length : nl + 1;
        if (line === delim) {
          cmd.heredocs.push([start, lineStart]);
          break;
        }
      }
    }
    this.pending = [];
  }

  private word(): Word {
    const s = this.s;
    const w: Word = { text: '', subs: [], spans: [] };
    const start = this.i;
    for (;;) {
      const c = s[this.i];
      if (c === undefined || DELIMS.has(c)) break;
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) this.fail('an unclosed quote');
        w.text += s.slice(this.i + 1, end);
        this.i = end + 1;
        continue;
      }
      if (c === '"') {
        this.i++;
        for (;;) {
          const d = s[this.i];
          if (d === undefined) this.fail('an unclosed quote');
          if (d === '"') {
            this.i++;
            break;
          }
          if (d === '\\') {
            const n = s[this.i + 1];
            if (n === '\n') this.i += 2;
            else if (n === '$' || n === '`' || n === '"' || n === '\\') {
              w.text += n;
              this.i += 2;
            } else {
              w.text += d;
              this.i++;
            }
            continue;
          }
          if (d === '`') this.fail('a backquote substitution');
          if (d === '$') {
            this.dollar(w);
            continue;
          }
          w.text += d;
          this.i++;
        }
        continue;
      }
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === undefined) this.fail('a trailing backslash');
        if (n === '\n') this.fail('a line continuation inside a word');
        w.text += n;
        this.i += 2;
        continue;
      }
      if (c === '$') {
        this.dollar(w);
        continue;
      }
      if (c === '`') this.fail('a backquote substitution');
      if (c === '{' || c === '}' || c === '!' || c === '^') this.fail(`an unquoted ${c}`);
      if ((c === '~' || c === '=') && this.i === start) this.fail(`a word starting with ${c}`);
      if (c === '*' || c === '?' || c === '[') {
        w.text += EXPANSION;
        this.i++;
        continue;
      }
      w.text += c;
      this.i++;
    }
    if (this.i === start) this.fail(`an unexpected ${s[this.i] ?? 'end'}`);
    return w;
  }

  /** `$NAME`, `${NAME}`, a special parameter, or `$( ... )`; `$((`, `$'`, `$"` and other forms are unmodelled. */
  private dollar(w: Word) {
    const s = this.s;
    const rest = s.slice(this.i + 1);
    if (rest.startsWith('((')) this.fail('arithmetic expansion');
    if (rest.startsWith('(')) {
      const from = this.i;
      this.i += 2;
      w.subs.push(this.list(true));
      w.spans.push([from, this.i]);
      w.text += EXPANSION;
      return;
    }
    const brace = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
    if (brace) {
      this.i += 1 + brace[0].length;
      w.text += EXPANSION;
      return;
    }
    const name = NAME.exec(rest) ?? /^[?#@*$!0-9-]/.exec(rest);
    if (name) {
      this.i += 1 + name[0].length;
      w.text += EXPANSION;
      return;
    }
    if (rest === '' || DELIMS.has(rest[0]!) || rest[0] === '"') {
      w.text += '$';
      this.i++;
      return;
    }
    this.fail(`an expansion $${rest[0]}`);
  }
}

/** Every command a list runs, and those in their substitutions. */
function allCommands(list: Cmd[][]): Cmd[] {
  const out: Cmd[] = [];
  const visit = (c: Cmd) => {
    out.push(c);
    for (const w of [...c.words, ...c.targets]) for (const sub of w.subs) for (const p of sub) for (const x of p) visit(x);
  };
  for (const p of list) for (const c of p) visit(c);
  return out;
}

/** The commands a command's substitutions run before it. */
function inner(c: Cmd): Cmd[] {
  return [...c.words, ...c.targets].flatMap((w) => w.subs.flatMap((sub) => allCommands(sub)));
}

const isGitName = (t: string) => basename(t) === 'git' || basename(t) === 'git.exe';
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

// WHY: git options before the subcommand that change nothing the commit records. Every other one is unmodelled.
const SAFE_GLOBALS = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice']);
// WHY: config a git command may be given with -c in a commit's line: who commits and how it is signed or shown,
// never config that changes which files or content git reads.
const SAFE_CONFIG = /^(user\.(name|email|signingkey)|author\.(name|email)|committer\.(name|email)|commit\.gpgsign|color\.ui|advice\.[a-z]+)$/i;

interface GitWords {
  /** -C directories, in order. */
  dirs: string[];
  sub: string | undefined;
  /** The words after the subcommand. */
  rest: Word[];
}

/** A git command's global options and subcommand; throws Unmodelled on an option this model doesn't know. */
function gitWords(words: Word[]): GitWords {
  const dirs: string[] = [];
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (!plain(w)) throw new Unmodelled('an expansion among git options');
    const t = w.text;
    if (!t.startsWith('-')) return { dirs, sub: t, rest: words.slice(i + 1) };
    if (t === '-C' || t === '-c') {
      const v = words[++i];
      if (!v || !plain(v)) throw new Unmodelled(`git ${t} without a literal value`);
      if (t === '-C') dirs.push(v.text);
      else if (!SAFE_CONFIG.test(v.text.split('=')[0]!)) throw new Unmodelled(`git -c ${v.text.split('=')[0]}`);
    } else if (!SAFE_GLOBALS.has(t)) throw new Unmodelled(`the git option ${t.split('=')[0]}`);
  }
  return { dirs, sub: undefined, rest: [] };
}

type Arg = 'flag' | 'value' | 'optional';
// WHY: git commit's options, by name: whether each takes a value, and whether it makes the commit take working-tree
// content (w) or rewrite the current commit (amend). A name is matched as git matches it (longOption).
type Opt = [Arg, ('w' | 'amend')?];
const COMMIT_LONG: Record<string, Opt> = {
  all: ['flag', 'w'], include: ['flag', 'w'], only: ['flag', 'w'], patch: ['flag', 'w'], interactive: ['flag', 'w'],
  'pathspec-from-file': ['value', 'w'], amend: ['flag', 'amend'],
  'pathspec-file-nul': ['flag'], message: ['value'], file: ['value'], 'reuse-message': ['value'], 'reedit-message': ['value'],
  fixup: ['value'], squash: ['value'], author: ['value'], date: ['value'], template: ['value'], cleanup: ['value'], trailer: ['value'],
  'untracked-files': ['optional'], 'gpg-sign': ['optional'], signoff: ['flag'], verify: ['flag'], 'no-verify': ['flag'],
  'allow-empty': ['flag'], 'allow-empty-message': ['flag'], edit: ['flag'], 'no-edit': ['flag'], 'reset-author': ['flag'],
  short: ['flag'], branch: ['flag'], porcelain: ['flag'], long: ['flag'], null: ['flag'], 'dry-run': ['flag'], status: ['flag'],
  'no-status': ['flag'], verbose: ['flag'], quiet: ['flag'], 'no-post-rewrite': ['flag'],
};
const SHORT_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
const SHORT_OPTIONAL = new Set(['u', 'S']);
const SHORT_WORKTREE = new Set(['a', 'i', 'o', 'p']);
const SHORT_FLAG = new Set(['n', 'q', 'v', 's', 'e', 'z']);

/** The long options a (possibly abbreviated, possibly negated) name can mean. */
function longOption(name: string): Opt[] {
  const lookup = (n: string) => {
    if (COMMIT_LONG[n]) return [COMMIT_LONG[n]!];
    const hits = Object.keys(COMMIT_LONG).filter((k) => k.startsWith(n));
    return hits.length === 1 ? [COMMIT_LONG[hits[0]!]!] : [];
  };
  const found = [...lookup(name), ...(name.startsWith('no-') ? lookup(name.slice(3)).map(([, e]): Opt => (e ? ['flag', e] : ['flag'])) : [])];
  if (!found.length) throw new Unmodelled(`the commit option --${name}`);
  if (new Set(found.map(([a]) => a)).size > 1) throw new Unmodelled(`the commit option --${name}`);
  return found;
}

/** What a commit's own words make it record, beyond the staged changes; throws Unmodelled on anything unknown. */
function commitEffects(rest: Word[]): { worktree: boolean; amend: boolean } {
  let worktree = false;
  let amend = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    const t = w.text;
    const head = t.split(EXPANSION)[0]!;
    if (t === '--') {
      if (i + 1 < rest.length) worktree = true;
      break;
    }
    // WHY: an expansion at a word's start can become any option, so only a word that starts literally is a path.
    if (head === '' && !plain(w)) throw new Unmodelled('an expansion among the commit options');
    if (!t.startsWith('-') || t === '-') {
      worktree = true;
      continue;
    }
    if (t.startsWith('--')) {
      const eq = head.indexOf('=');
      const name = eq >= 0 ? head.slice(2, eq) : head.slice(2);
      if (!plain(w) && eq < 0) throw new Unmodelled('an expansion in a commit option');
      for (const [arg, effect] of longOption(name)) {
        if (effect === 'w') worktree = true;
        if (effect === 'amend') amend = true;
        if (arg === 'value' && eq < 0) i++;
      }
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const ch = t[j]!;
      if (SHORT_VALUE.has(ch)) {
        if (j === t.length - 1) i++;
        break;
      }
      if (SHORT_OPTIONAL.has(ch)) break;
      if (SHORT_WORKTREE.has(ch)) worktree = true;
      else if (!SHORT_FLAG.has(ch)) throw new Unmodelled(ch === EXPANSION ? 'an expansion in a commit option' : `the commit option -${ch}`);
    }
  }
  return { worktree, amend };
}

const STAGING = new Set(['add', 'rm', 'mv']);
const READ_ONLY_GIT = new Set(['status', 'rev-parse', 'ls-files']);
const READ_ONLY = new Set(['true', ':', 'pwd', 'echo', 'cat']);
const PIPE_SAFE = new Set(['echo', 'cat', 'head', 'tail', 'grep', 'true']);

/**
 * Why a command that runs before the commit (or beside it in its pipeline) can't be modelled, or null. It may move
 * between directories, stage, or only read: nothing that writes a file or runs a program whose effect isn't known.
 */
function beforeRefusal(c: Cmd, names: Set<string>, git: boolean): string | null {
  if (c.writes) return 'a command before the commit writes a file';
  const name = c.words[0]!;
  if (!plain(name)) return 'a command before the commit has a name that is expanded';
  if (ASSIGNMENT.test(name.text)) return 'a variable set before the commit';
  for (const x of inner(c)) {
    const why = beforeRefusal(x, READ_ONLY, false);
    if (why) return why;
  }
  if (isGitName(name.text)) {
    const g = git ? gitWords(c.words) : null;
    if (!g?.sub || !(STAGING.has(g.sub) || READ_ONLY_GIT.has(g.sub))) return `git ${g?.sub ?? ''} before the commit`.replace('  ', ' ');
    if (g.rest.some((w) => w.text.startsWith(EXPANSION))) return `an expansion among git ${g.sub}'s options`;
    if (g.sub === 'add' && g.rest.some((w) => /^-[a-zA-Z]*[fe]/.test(w.text) || /^--(f|fo|for|forc|force|e|ed|edi|edit)$/.test(w.text))) return 'a staging option that adds ignored or edited content';
    return null;
  }
  return names.has(name.text) ? null : `${name.text} before the commit`;
}
const CHANGE_DIR_OR_READ = new Set(['cd', 'pushd', 'popd', ...READ_ONLY]);

export interface PlanEnv {
  cwd: string;
  env: NodeJS.ProcessEnv;
  git: GitQuery;
}

const refuse = (what: string): CommitPlan => ({
  refuse: `the commit secret scan can't tell what this command line commits (${what}), so it isn't let through unscanned. Stage your changes in one call, then run a plain git commit in a call of its own`,
});

/** The candidate directories after a cd/pushd/popd, given the ones before it; null when it can't be modelled. */
function changeDir(c: Cmd, dirs: Set<string>, env: NodeJS.ProcessEnv): Set<string> | string {
  const name = c.words[0]!.text;
  const args = c.words.slice(1);
  if (args.some((w) => !plain(w))) return `${name} to an expanded path`;
  const ops = args.map((w) => w.text).filter((t) => t !== '-P' && t !== '-L');
  if (name === 'popd' || (name === 'pushd' && (!ops.length || /^[+-][0-9]+$/.test(ops[0]!)))) return dirs;
  if (ops.length !== 1) return `${name} without exactly one directory`;
  const t = ops[0]!;
  if (t === '-') return dirs;
  if (t.startsWith('-')) return `${name} ${t}`;
  if (!isAbsolute(t) && !t.startsWith('.') && env.CDPATH) return `${name} with CDPATH set`;
  const out = new Set(dirs);
  for (const d of dirs) {
    out.add(resolve(d, t));
    try {
      out.add(realpathSync(isAbsolute(t) ? t : join(d, t)));
    } catch {
      // WHY: a directory that doesn't exist can't be entered; the logical path above stands for it.
    }
  }
  return out.size > 32 ? `too many directory changes` : out;
}

/** git's own commands (an alias can't shadow one), so only another name is looked up as an alias. */
const GIT_BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap ' +
  'check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects ' +
  'credential describe diagnose diff diff-files diff-index diff-tree difftool fetch fetch-pack filter-branch fmt-merge-msg for-each-ref ' +
  'for-each-repo format-patch fsck gc get-tar-commit-id grep hash-object help hook index-pack init instaweb interpret-trailers log ' +
  'ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree ' +
  'multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog ' +
  'remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm send-email shortlog show show-branch ' +
  'show-index show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects ' +
  'update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree').split(' '));

interface LooseGit {
  configs: string[];
  dirs: string[];
  sub: string | undefined;
}

/** A git command as the guard's general matcher sees it; null when it isn't one. */
function looseGit(c: SimpleCommand): LooseGit | null {
  const a = c.argv;
  if (!isGitName(a[0] ?? '')) return null;
  const configs: string[] = [];
  const dirs: string[] = [];
  let i = 1;
  for (; i < a.length && a[i]!.startsWith('-'); i++) {
    const t = a[i]!;
    if (t === '-c' || t === '--config-env') configs.push(a[++i] ?? '');
    else if (t === '-C') dirs.push(a[++i] ?? '');
    else if (['--git-dir', '--work-tree', '--namespace', '--super-prefix'].includes(t)) i++;
    else if (t.startsWith('--config-env=')) configs.push(t.slice(13));
    else if (/^-c./.test(t)) configs.push(t.slice(2));
  }
  return { configs, dirs, sub: a[i] };
}

const setsGitEnv = (c: SimpleCommand) => Object.keys(c.assignments).some((k) => /^GIT_/i.test(k)) || c.argv.some((t) => /^GIT_[A-Za-z0-9_]*\+?=/i.test(t));

/** Why a git command run by another name may commit: an alias that is a commit or a shell command. */
function aliasRefusal(loose: SimpleCommand[], p: PlanEnv): string | null {
  for (const c of loose) {
    const g = looseGit(c);
    if (!g?.sub || g.sub.startsWith('-') || GIT_BUILTINS.has(g.sub)) continue;
    if (g.configs.some((k) => /^alias\./i.test(k))) return `git ${g.sub} with an alias given on its command line`;
    if (loose.some((x) => looseGit(x)?.sub === 'config')) return `git ${g.sub} in a line that also changes git config`;
    if (loose.some(setsGitEnv)) return `git ${g.sub} in a line that sets git's environment`;
    if (loose.some((x) => ['cd', 'pushd', 'popd'].includes(basename(x.argv[0] ?? '')))) return `git ${g.sub} in a line that changes directory`;
    let sub = g.sub;
    for (let depth = 0; ; depth++) {
      if (depth > 10) return `git ${g.sub}: an alias loop`;
      const r = p.git(p.cwd, [...g.dirs.flatMap((d) => ['-C', d]), 'config', '--get', `alias.${sub}`]);
      if (r.status !== 0) break;
      const value = r.stdout.trim();
      if (value.startsWith('!')) return `git ${g.sub} is an alias for a shell command`;
      sub = value.split(/\s+/)[0] ?? '';
      if (sub === 'commit') return `git ${g.sub} is an alias for git commit`;
      if (GIT_BUILTINS.has(sub)) break;
    }
  }
  return null;
}

/** Is this a git commit, as the guard's general matcher sees it (or a git run through another program to commit)? */
function looseCommits(loose: SimpleCommand[]): { commits: number; indirect: boolean } {
  let commits = 0;
  let indirect = false;
  for (const c of loose) {
    const g = looseGit(c);
    if (g?.sub === 'commit') commits++;
    const at = c.argv.findIndex((t, k) => k > 0 && isGitName(t));
    if (!g && at > 0 && c.argv.slice(at + 1).includes('commit')) indirect = true;
  }
  return { commits, indirect };
}

// WHY: where the text of a message is a quoted here-document's body (a commit's message, a PR's title or body), the
// general matcher reads its lines as commands; the model drops them first so a message line can't look like a commit.
function messageWords(c: Cmd): Word[] {
  const t = c.words.map((w) => w.text);
  const out: Word[] = [];
  const takeAfter = (opts: string[], from: number) => {
    for (let k = from; k < t.length; k++) {
      if (opts.includes(t[k]!) && c.words[k + 1]) out.push(c.words[k + 1]!);
      else if (opts.some((o) => o.startsWith('--') && t[k]!.startsWith(`${o}=`))) out.push(c.words[k]!);
    }
  };
  if (isGitName(t[0] ?? '')) {
    try {
      const g = gitWords(c.words);
      if (g.sub === 'commit') takeAfter(['-m', '--message'], c.words.length - g.rest.length);
    } catch {
      // WHY: a git command this model can't read has no message words; its substitutions stay as they are.
    }
  } else if (t[0] === 'gh' && (t[1] === 'pr' || t[1] === 'issue')) takeAfter(['--body', '-b', '--title', '-t'], 2);
  return out;
}

/** The source with each here-document that is only text (fed to a lone `cat`) taken out. */
function sanitized(src: string, list: Cmd[][]): string {
  const cut: [number, number][] = [];
  const loneCat = (p: Cmd[]) => p.length === 1 && p[0]!.words.length === 1 && p[0]!.words[0]!.text === 'cat' ? p[0]! : null;
  for (const p of list) cut.push(...(loneCat(p)?.heredocs ?? []));
  for (const c of allCommands(list)) {
    for (const w of messageWords(c)) {
      for (const sub of w.subs) {
        const cat = sub.length === 1 ? loneCat(sub[0]!) : null;
        if (cat) cut.push(...cat.heredocs);
      }
    }
  }
  let out = src;
  for (const [a, b] of cut.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out;
}

/**
 * The scans that cover what a command line's git commit records, or why it is refused; null when it doesn't commit.
 * INVARIANT: covers at least what the commit records (more is allowed, less never): the staged changes in every
 * checkout the commit can land in; with working-tree content, every tracked change; with staging earlier in the line,
 * every untracked file too; on an amend, the current commit as well.
 */
export function commitPlan(command: string, p: PlanEnv): CommitPlan | null {
  const raw = splitCommands(command);
  let list: Cmd[][] | null = null;
  let why = '';
  try {
    list = new Parser(command).parse();
  } catch (e) {
    if (!(e instanceof Unmodelled)) throw e;
    why = e.message;
  }
  const loose = list ? splitCommands(sanitized(command, list)) : raw;
  const alias = aliasRefusal(loose, p);
  if (alias) return refuse(alias);
  const rawCommits = looseCommits(raw);
  const mentions = command.includes('<<') && command.replace(/["'\\]/g, '').includes('commit');
  if (!list) return rawCommits.commits || rawCommits.indirect || mentions ? refuse(why) : null;

  const all = allCommands(list);
  let commits: Cmd[];
  try {
    commits = all.filter((c) => isGitName(c.words[0]!.text) && plain(c.words[0]!) && gitWords(c.words).sub === 'commit');
  } catch (e) {
    if (!(e instanceof Unmodelled)) throw e;
    const named = all.some((c) => isGitName(c.words[0]!.text) && c.words.some((w) => w.text === 'commit'));
    return named || rawCommits.commits ? refuse(e.message) : null;
  }
  const hidden = looseCommits(loose);
  if (hidden.indirect) return refuse('a git commit run through another program');
  if (all.some((c) => !plain(c.words[0]!) && c.words.some((w) => w.text === 'commit'))) return refuse('a command whose name is expanded');
  if (hidden.commits !== commits.length) return refuse('a commit inside a script, substitution or wrapper');
  if (!commits.length) return null;
  if (commits.length > 1) return refuse('more than one commit');
  const commit = commits[0]!;
  const top = list.findIndex((pl) => pl.includes(commit));
  if (top < 0) return refuse('a commit inside a substitution');

  let dirs = new Set([p.cwd]);
  let staging = false;
  try {
    for (const pl of list.slice(0, top)) {
      for (const c of pl) {
        const r = beforeRefusal(c, CHANGE_DIR_OR_READ, true);
        if (r) return refuse(r);
        const name = c.words[0]!.text;
        if (name === 'cd' || name === 'pushd' || name === 'popd') {
          const next = changeDir(c, dirs, p.env);
          if (typeof next === 'string') return refuse(next);
          dirs = next;
        }
        if (isGitName(name) && STAGING.has(gitWords(c.words).sub ?? '')) staging = true;
      }
    }
    for (const c of list[top]!) {
      if (c === commit) continue;
      const r = beforeRefusal(c, PIPE_SAFE, false);
      if (r) return refuse(r.replace('before the commit', 'beside the commit'));
    }
    if (commit.writes) return refuse('the commit writes its output to a file');
    if (ASSIGNMENT.test(commit.words[0]!.text)) return refuse('a variable set for the commit');
    for (const x of inner(commit)) {
      const r = beforeRefusal(x, READ_ONLY, false);
      if (r) return refuse(r.replace('before the commit', "in the commit's arguments"));
    }
    const g = gitWords(commit.words);
    const { worktree, amend } = commitEffects(g.rest);
    const scope: CommitScope = { unstaged: worktree || staging, untracked: staging, head: amend };
    const tops = new Set<string>();
    for (const d of dirs) {
      const r = p.git(d, [...g.dirs.flatMap((x) => ['-C', x]), 'rev-parse', '--show-toplevel']);
      if (r.status === 0 && r.stdout.trim()) tops.add(r.stdout.trim());
    }
    return { scans: [...tops].map((t) => ({ top: t, scope })) };
  } catch (e) {
    if (e instanceof Unmodelled) return refuse(e.message);
    throw e;
  }
}
