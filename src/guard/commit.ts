// The commit secret scan's model of an agent's shell command (#971): which commit it makes, in which checkout, and
// what that commit records. The guard (src/hook.ts) scans that before the command runs, and refuses a command line it
// can't model, so a commit is never let through on a scan of something other than what it records.
// INVARIANT (#785): imports only node built-ins and src/guardrails/** (see src/guard/research.ts); the git queries
// it needs come from its caller.
import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { basename, splitCommands, type SimpleCommand } from '../guardrails/shell.js';
import { ATTRIBUTES_FILE } from '../scan/secrets.js';

/** What one scan of a checkout covers, on top of the staged changes it always covers. */
export interface CommitScope {
  /** Tracked files' unstaged changes. */
  unstaged: boolean;
  /** Untracked files that are not ignored. */
  untracked: boolean;
  /** The current HEAD commit's own changes. */
  head: boolean;
  /** The line shows changes as diffs before the commit. */
  diffReads?: boolean;
  /** The line shows commits (log or show) before the commit. */
  logReads?: boolean;
  /** The line asks for signatures to be shown. */
  signatureReads?: boolean;
  /** A git mv before the commit names an attributes file, so a file may become one after the scan has looked. */
  moves?: boolean;
}

export interface CommitScan {
  /** The checkout's top level, where the scan runs. */
  top: string;
  scope: CommitScope;
}

/**
 * The scans, and `reads`: the other checkouts the line's reads before the commit run in, whose config is checked for
 * programs git runs while reading (src/scan/secrets.ts checkReadPrograms) though nothing there is committed.
 */
export type CommitPlan = { refuse: string } | { scans: CommitScan[]; reads?: string[] };

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
  /** An expansion or glob outside quotes: the shell may split it into other words, options among them. */
  bare: boolean;
}

interface Cmd {
  words: Word[];
  /** A redirect writes a file (anything but /dev/null). */
  writes: boolean;
  /** Source spans of the bodies of here-documents this command reads. */
  heredocs: [number, number][];
  /** Its redirects' file words: their substitutions run before it too. */
  targets: Word[];
  /** It reads the output of the command before it in a pipeline. */
  piped: boolean;
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
  private pending: { delim: string; cmd: Cmd; expand: boolean }[] = [];

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
        cmd.piped = pipeline.length > 0;
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
    const current = (): Cmd => (cmd ??= { words: [], writes: false, heredocs: [], targets: [], piped: false });
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

  /**
   * `< file`, or a here-document: `<<'WORD'` (its delimiter quoted, so its body is text) or `<<WORD` (its body
   * expanded as a double-quoted string is, so its substitutions run before its command).
   */
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
    const quoted = q === "'" || q === '"';
    const from = quoted ? this.i + 1 : this.i;
    const end = quoted ? s.indexOf(q, from) : from + (NAME.exec(s.slice(from))?.[0].length ?? 0);
    const delim = end < 0 ? '' : s.slice(from, end);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(delim)) this.fail('a here-document delimiter');
    this.i = quoted ? end + 1 : end;
    if (!DELIMS.has(s[this.i] ?? ' ')) this.fail('a here-document delimiter');
    this.pending.push({ delim, cmd, expand: !quoted });
  }

  /** After a newline: the bodies of the here-documents its line opened, in order. */
  private bodies() {
    const s = this.s;
    const pending = this.pending;
    this.pending = [];
    for (const { delim, cmd, expand } of pending) {
      const start = this.i;
      for (;;) {
        if (this.i >= s.length) this.fail('a here-document without its closing line');
        const nl = s.indexOf('\n', this.i);
        const line = s.slice(this.i, nl < 0 ? s.length : nl);
        const lineStart = this.i;
        this.i = nl < 0 ? s.length : nl + 1;
        if (line === delim) {
          cmd.heredocs.push([start, lineStart]);
          if (expand) cmd.targets.push(this.expandedBody(start, lineStart));
          break;
        }
      }
    }
  }

  /** An unquoted delimiter's body, read as a double-quoted string is: its substitutions, as a word of its command. */
  private expandedBody(start: number, end: number): Word {
    const s = this.s;
    const resume = this.i;
    const w: Word = { text: '', subs: [], spans: [], bare: false };
    this.i = start;
    while (this.i < end) {
      const d = s[this.i]!;
      if (d === '\\') this.i += 2;
      else if (d === '`') this.fail('a backquote substitution in a here-document');
      else if (d === '$') {
        this.dollar(w, true);
        if (this.i > end || this.pending.length) this.fail('a substitution across a here-document\'s end');
      } else this.i++;
    }
    this.i = resume;
    return w;
  }

  private word(): Word {
    const s = this.s;
    const w: Word = { text: '', subs: [], spans: [], bare: false };
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
            this.dollar(w, true);
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
        const n = w.text.length;
        this.dollar(w, false);
        if (w.text.slice(n).includes(EXPANSION)) w.bare = true;
        continue;
      }
      if (c === '`') this.fail('a backquote substitution');
      if (c === '{' || c === '}' || c === '!' || c === '^') this.fail(`an unquoted ${c}`);
      if ((c === '~' || c === '=') && this.i === start) this.fail(`a word starting with ${c}`);
      // WHY: a `[` is a pattern only with a `]` after it in the word; alone (as the test command `[`) it is a letter.
      if (c === '*' || c === '?' || (c === '[' && this.closesLater())) {
        w.text += EXPANSION;
        w.bare = true;
        this.i++;
        continue;
      }
      w.text += c;
      this.i++;
    }
    if (this.i === start) this.fail(`an unexpected ${s[this.i] ?? 'end'}`);
    return w;
  }

  /**
   * Whether a `]` comes later in the word that holds the `[` at this.i. The word runs to the first unquoted, unescaped
   * separator: an escaped or quoted separator is part of it, and any `]` in it counts (more is treated as a pattern).
   */
  private closesLater(): boolean {
    const s = this.s;
    let q: string | null = null;
    for (let j = this.i + 1; j < s.length; j++) {
      const d = s[j]!;
      if (d === ']') return true;
      if (q) {
        if (d === '\\' && q === '"') j++;
        else if (d === q) q = null;
        continue;
      }
      if (d === '\\') {
        if (s[j + 1] === ']') return true;
        j++;
      } else if (d === "'" || d === '"') q = d;
      else if (DELIMS.has(d)) return false;
    }
    return false;
  }

  /** `$NAME`, `${NAME}`, a special parameter, or `$( ... )`; `$((`, `$'`, `$"` and other forms are unmodelled. */
  private dollar(w: Word, quoted: boolean) {
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
    // WHY: outside quotes, a `$` before a quote is a quoting form of its own, not a `$`.
    if (rest === '' || DELIMS.has(rest[0]!) || (quoted && rest[0] === '"')) {
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
// content (w), rewrite the current commit (amend) or skip git's pre-commit hook (skip). A name is matched as git
// matches it (longOption).
type Opt = [Arg, ('w' | 'amend' | 'interactive' | 'skip')?];
const COMMIT_LONG: Record<string, Opt> = {
  all: ['flag', 'w'], include: ['flag', 'w'], only: ['flag', 'w'], patch: ['flag', 'interactive'], interactive: ['flag', 'interactive'],
  'pathspec-from-file': ['value', 'w'], amend: ['flag', 'amend'],
  'pathspec-file-nul': ['flag'], message: ['value'], file: ['value'], 'reuse-message': ['value'], 'reedit-message': ['value'],
  fixup: ['value'], squash: ['value'], author: ['value'], date: ['value'], template: ['value'], cleanup: ['value'], trailer: ['value'],
  'untracked-files': ['optional'], 'gpg-sign': ['optional'], signoff: ['flag'], verify: ['flag'], 'no-verify': ['flag', 'skip'],
  'allow-empty': ['flag'], 'allow-empty-message': ['flag'], edit: ['flag'], 'no-edit': ['flag'], 'reset-author': ['flag'],
  short: ['flag'], branch: ['flag'], long: ['flag'], null: ['flag'], 'dry-run': ['flag'], status: ['flag'],
  'no-status': ['flag'], verbose: ['flag'], quiet: ['flag'], 'no-post-rewrite': ['flag'],
};
const SHORT_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
const SHORT_OPTIONAL = new Set(['u', 'S']);
const SHORT_WORKTREE = new Set(['a', 'i', 'o']);
/** Long options that start interactive staging (any prefix git might take for them). */
const INTERACTIVE_LONG = /^--(pa(t(c(h)?)?)?|in(t(e(r(a(c(t(i(v(e)?)?)?)?)?)?)?)?)?)(=|$)/;
const SHORT_FLAG = new Set(['q', 'v', 's', 'e', 'z']);

/**
 * A commit that skips git's pre-commit hook, the commit scan's second layer (#983), which scans the index the commit
 * records whatever this model reads from its line. INVARIANT (#983): refused in any spelling (-n alone or bundled,
 * --no-verify or a prefix git takes for it), even with a --verify after it.
 */
class SkipsHook extends Error {}

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
        if (effect === 'interactive') throw new Unmodelled('an interactive commit, which can edit what is committed after the scan');
        if (effect === 'amend') amend = true;
        if (effect === 'skip') throw new SkipsHook(`--${name}`);
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
      if (ch === 'p') throw new Unmodelled('an interactive commit, which can edit what is committed after the scan');
      if (ch === 'n') throw new SkipsHook(t);
      if (SHORT_WORKTREE.has(ch)) worktree = true;
      else if (!SHORT_FLAG.has(ch)) throw new Unmodelled(ch === EXPANSION ? 'an expansion in a commit option' : `the commit option -${ch}`);
    }
  }
  return { worktree, amend };
}

const STAGING = new Set(['add', 'rm', 'mv']);
/**
 * git log options that show no diff and never take the next word as their value. INVARIANT (#971): any other option
 * may show a diff (or hide a word that does), and a diff runs the programs that render it, so it counts as one.
 */
const LOG_NO_DIFF = /^(--oneline|-[0-9]+|-n[0-9]+|--max-count=[0-9]+|--(format|pretty)=.*|--graph|--(no-)?decorate|--all|--reverse|--(since|after|until|before|author|committer|grep|date)=.*|--first-parent|--(no-)?merges|--abbrev-commit|-s|--no-patch|--no-color)$/;
/** git status options that show no diff and take no separate value; any other one counts as showing one. */
const STATUS_NO_DIFF = /^(-s|--short|-b|--branch|-sb|-bs|-u(no|normal|all)?|--untracked-files=(no|normal|all)|--no-ahead-behind|--ahead-behind)$/;

/** Whether `git log` with these words (after the subcommand) may show a diff. */
function logShowsDiffs(words: string[]): boolean {
  return words.some((t) => t.startsWith('-') && !LOG_NO_DIFF.test(t));
}

// WHY: git commands that only read, which ordinary work runs before a commit; none may write a file (see beforeRefusal).
const READ_ONLY_GIT = new Set(['status', 'rev-parse', 'diff', 'log', 'show']);
const READ_ONLY = new Set(['true', ':', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'grep', 'ls']);
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
    // WHY: a read that writes its output to a file, or runs a program the config names, isn't only a read.
    const risky = (t: string) => {
      const name = t.startsWith('--') ? t.slice(2).split('=')[0]! : '';
      return !!name && (name.startsWith('output') || ['output', 'ext-diff', 'textconv'].some((o) => o.startsWith(name)));
    };
    if (READ_ONLY_GIT.has(g.sub) && g.rest.some((w) => risky(w.text))) return `git ${g.sub} with an option that writes a file or runs a program`;
    if (g.sub === 'add' && g.rest.some((w) => /^-[a-zA-Z]*[fe]/.test(w.text) || /^--(f|fo|for|forc|force|e|ed|edi|edit)$/.test(w.text))) return 'a staging option that adds ignored or edited content';
    // WHY (#971): interactive staging can open an editor (from config or the environment) after the scan has read.
    if (g.sub === 'add' && g.rest.some((w) => /^-[a-zA-Z]*[pi]/.test(w.text) || INTERACTIVE_LONG.test(w.text))) return 'interactive staging, which can edit what is staged after the scan';
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
/** A line with no commit the model can see, that may still make one. */
const refuseUnread = (what: string): CommitPlan => ({
  refuse: `the commit secret scan can't read this command line (${what}), and it may make a commit, so it isn't run unscanned. Run git with literal words, and a commit in a call of its own`,
});

/**
 * The candidate directories after a cd or pushd, given the ones before it, or why it can't be modelled.
 * INVARIANT (#971): a change is modelled only where the shell's and the model's answer can't differ, and refused
 * otherwise. Every directory before it stays a candidate too.
 */
function changeDir(c: Cmd, dirs: Set<string>, env: NodeJS.ProcessEnv): Set<string> | string {
  const name = c.words[0]!.text;
  const args = c.words.slice(1);
  if (name === 'popd') return 'popd';
  if (args.some((w) => !plain(w))) return `${name} to an expanded path`;
  const ops = args.map((w) => w.text);
  if (ops.length !== 1 || !ops[0]) return `${name} without exactly one directory`;
  const t = ops[0];
  if (t.startsWith('-') || t.startsWith('+')) return `${name} ${t}`;
  const parts = t.split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) return `${name} through ..`;
  if (!isAbsolute(t) && env.CDPATH && !t.startsWith('./')) return `${name} with CDPATH set`;
  const out = new Set(dirs);
  for (const d of dirs) {
    let cur = isAbsolute(t) ? '/' : d;
    for (const p of parts) {
      cur = join(cur, p);
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        return `${name} to a directory that doesn't exist yet`;
      }
      if (st.isSymbolicLink()) return `${name} through a link`;
      if (!st.isDirectory()) return `${name} to something that isn't a directory`;
    }
    out.add(cur);
  }
  return out.size > 32 ? `too many directory changes` : out;
}

/**
 * git's own everyday commands (an alias can't shadow one), so only another name is looked up as an alias. A command
 * left off is only looked up too: a lookup that finds no alias lets it through.
 */
const GIT_BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap ' +
  'check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects ' +
  'credential describe diagnose diff difftool fetch fetch-pack filter-branch fmt-merge-msg for-each-ref ' +
  'for-each-repo format-patch fsck gc get-tar-commit-id grep hash-object help hook index-pack init instaweb interpret-trailers log ' +
  'ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree ' +
  'multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog ' +
  'remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm send-email shortlog show show-branch ' +
  'show-index show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects ' +
  'update-index update-ref update-server-info var verify-commit verify-pack verify-tag version worktree write-tree').split(' '));

interface LooseGit {
  configs: string[];
  dirs: string[];
  sub: string | undefined;
}

/** A git command as the guard's general matcher sees it; null when it isn't one. */
function looseGit(c: SimpleCommand): LooseGit | null {
  const a = c.argv.slice(keywordsBefore(c.argv));
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

/**
 * Why a git command run by another name may commit: an alias that is a commit or a shell command. It is looked up in
 * every directory the line may run it in (`dirs`, or why those can't be known); a lookup that fails refuses.
 */
function aliasRefusal(loose: SimpleCommand[], p: PlanEnv, dirs: Set<string> | string): string | null {
  for (const c of loose) {
    const g = looseGit(c);
    if (!g?.sub || g.sub.startsWith('-') || GIT_BUILTINS.has(g.sub)) continue;
    if (g.configs.some((k) => /^alias\./i.test(k))) return `git ${g.sub} with an alias given on its command line`;
    if (loose.some((x) => looseGit(x)?.sub === 'config')) return `git ${g.sub} in a line that also changes git config`;
    if (loose.some(setsGitEnv)) return `git ${g.sub} in a line that sets git's environment`;
    if (typeof dirs === 'string') return `git ${g.sub} after ${dirs}`;
    for (const dir of dirs) {
      let sub = g.sub;
      for (let depth = 0; ; depth++) {
        if (depth > 10) return `git ${g.sub}: an alias loop`;
        const r = p.git(dir, [...g.dirs.flatMap((d) => ['-C', d]), 'config', '--get', `alias.${sub}`]);
        // WHY: git config exits 1 for "no such key"; anything else (an error, a timeout) is not an answer.
        if (r.status === 1) break;
        if (r.status !== 0) return `git ${g.sub}: its alias lookup failed`;
        const value = r.stdout.trim();
        if (value.startsWith('!')) return `git ${g.sub} is an alias for a shell command`;
        sub = value.split(/\s+/)[0] ?? '';
        if (sub === 'commit') return `git ${g.sub} is an alias for git commit`;
        if (GIT_BUILTINS.has(sub)) break;
      }
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
    if (!g && at > 0 && !NON_EXEC.has(basename(c.argv[0]!)) && c.argv.slice(at + 1).includes('commit')) indirect = true;
  }
  return { commits, indirect };
}

/**
 * Whether a word, read as a command line, may run a git commit: a commit, git with no subcommand, or a git name that
 * isn't one of git's commands (an alias). A word with no space in it is a name, never a command line.
 */
function mayCommit(text: string): boolean {
  if (!/\s/.test(text)) return false;
  const parts = splitCommands(text);
  return looseCommits(parts).indirect || parts.some((x) => {
    const g = looseGit(x);
    return g !== null && (g.sub === undefined || g.sub === 'commit' || !GIT_BUILTINS.has(g.sub));
  });
}
const UNREAD_STRING = 'a git commit in a command string another program may run';

// WHY: programs that never run their arguments as a command, so a word `git` among them is only a word.
// WHY: the general matcher keeps a shell keyword as a command's first word; the command is the word after it.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'time', '{', '}', 'case', 'esac', 'for', 'select', 'in', 'function', 'coproc']);
const keywordsBefore = (argv: string[]) => {
  let i = 0;
  while (i < argv.length && KEYWORDS.has(argv[i]!)) i++;
  // WHY: after a keyword the matcher also keeps a command's own VAR=value words; the command comes after them.
  while (i < argv.length && ASSIGNMENT.test(argv[i]!)) i++;
  return i;
};

/**
 * unseenProgram for a line the strict reader can't parse, as far as the general matcher and the text show it. WHY
 * (#971): such a line still runs; what can't be read there is refused the same way.
 */
function unseenInUnread(command: string, raw: SimpleCommand[]): string | null {
  const NONLITERAL = /[$`*?[\]{}]/;
  for (const c of raw) {
    const argv = c.argv.slice(keywordsBefore(c.argv));
    const run = argv[0] ?? '';
    // WHY: the test commands `[` and `[[` are names, not patterns.
    if (run !== '[' && run !== '[[' && NONLITERAL.test(run)) return 'a command whose name is expanded';
    const at = argv.findIndex((t, k) => k > 0 && isGitName(t));
    if (at > 0 && !NON_EXEC.has(basename(run))) {
      const sub = argv.slice(at + 1).find((t) => !t.startsWith('-'));
      if (sub === undefined || sub === 'commit' || NONLITERAL.test(sub)) return 'git run through another program';
    }
    if (!NON_EXEC.has(basename(run)) && argv.slice(1).some(mayCommit)) return UNREAD_STRING;
  }
  const sh = String.raw`(?:\S*/)?(?:ba|z|da|k|mk|tc|c|fi|a)?sh|busybox`;
  if (new RegExp(String.raw`\|&?\s*(?:(?:sudo|env|exec|command|nohup|nice|time)\s+)*(?:${sh})(?![\w.-])`).test(command)) return 'text fed to a shell';
  if (new RegExp(String.raw`(?:^|[\s;&|(])(?:${sh})(?![\w.-])[^\n;&|]*<<`).test(command)) return 'text fed to a shell';
  if (/\benv\b[^\n;&|]*\s(?:-[a-zA-Z]*S|--sp)/.test(command)) return 'a program that splits a string into a command';
  for (const m of command.matchAll(/(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?xargs((?:[ \t]+[^\s;&|)]+)*)/g)) {
    if (xargsReplaces(m[1]!.trim().split(/[ \t]+/))) return 'a program that builds a command from its input';
  }
  return null;
}

/**
 * Whether xargs, given the words after it, builds its command from its input (a replace string). Only its own options
 * count: they end at the first word that isn't one, the command it runs.
 */
function xargsReplaces(args: string[]): boolean {
  // WHY: only options whose value is the next word; -l, -e, -i and their long forms take theirs attached, if at all.
  const VALUE = new Set(['-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--max-chars', '--delimiter', '--arg-file', '--process-slot-var']);
  for (let i = 0; i < args.length; i++) {
    const o = args[i]!;
    if (o === '--') return false;
    if (!o.startsWith('-') || o === '-') return false;
    if (/^--repl/.test(o) || /^-[0prtx]*[iIJ]/.test(o)) return true;
    if (VALUE.has(o)) i++;
  }
  return false;
}

// INVARIANT (#971): only programs with no option or setting that runs another program (no pager, preprocessor,
// alias or hook): print or test text, list or move files, or report on them. A program that can run one is not here.
const NON_EXEC = new Set(['echo', 'which', 'type', 'whereis', 'help',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'cd', 'pushd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'stat',
  'file', 'du', 'realpath', 'readlink', 'basename', 'dirname']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox']);
/** Stands for a word the shell expands, in a line rebuilt for the general matcher. */
const UNSEEN = '$__unseen__';
const quoteWord = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;

/**
 * Why a line may run a program the model can't name, or hand a shell text it can't read; null when it doesn't.
 * INVARIANT (#971): every word in command position is literal, after any wrapper too; no wrapper builds a command
 * from its input; no shell reads its script from a pipe, a here-document or an expanded `-c`.
 */
function unseenProgram(list: Cmd[][]): string | null {
  for (const c of allCommands(list)) {
    const name = c.words[0]!;
    if (!plain(name)) return 'a command whose name is expanded';
    // WHY: the general matcher knows the wrappers (and how each takes its options); a rebuilt line shows it which
    // words are expanded, so a wrapped command's name is checked the same way.
    const rebuilt = c.words.map((w) => (plain(w) ? quoteWord(w.text) : UNSEEN)).join(' ');
    const parts = splitCommands(rebuilt);
    for (const x of parts) {
      const run = x.argv[0] ?? '';
      if (run.includes(UNSEEN)) return 'a command run by another program whose name is expanded';
      if (!SHELLS.has(basename(run))) continue;
      const args = x.argv.slice(1);
      const ci = args.findIndex((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
      if (ci >= 0) {
        if ((args[ci + 1] ?? UNSEEN).includes(UNSEEN)) return 'a shell given an expanded script';
        continue;
      }
      // WHY: with no script file (or with -s) a shell runs what it reads; options that take a value don't name one.
      const operands = args.filter((t, k) => !t.startsWith('-') && !t.startsWith('+') && !/^[-+][oO]$/.test(args[k - 1] ?? ''));
      const readsInput = !operands.length || args.some((t) => /^-[a-zA-Z]*s/.test(t));
      if (readsInput && x === parts[0] && (c.piped || c.heredocs.length)) return 'text fed to a shell';
    }
    const words = c.words.map((w) => w.text);
    for (const [k, t] of words.entries()) {
      const b = basename(t);
      if (b === 'xargs' && xargsReplaces(words.slice(k + 1))) return 'a program that builds a command from its input';
      if (b === 'env') {
        for (const o of words.slice(k + 1)) {
          if (!o.startsWith('-') && !ASSIGNMENT.test(o)) break;
          if (/^-[a-zA-Z]*S/.test(o) || /^--sp/.test(o)) return 'a program that splits a string into a command';
        }
      }
      if (b === 'find') {
        for (let j = k + 1; j < words.length; j++) {
          if (!/^-(exec|execdir|ok|okdir)$/.test(words[j]!)) continue;
          const run = c.words[j + 1];
          if (!run || !plain(run) || run.text.includes('{}')) return 'a program that builds a command from its input';
        }
      }
    }
    // INVARIANT (#983): a word that reads as a command line that may commit is refused, read or not: a program the
    // guard doesn't know may run it as one (watch, su -c, git rebase -x). A message is only text.
    if (!NON_EXEC.has(name.text)) {
      const messages = new Set(messageWords(c));
      if (c.words.slice(1).some((w) => !messages.has(w) && mayCommit(w.text))) return UNREAD_STRING;
    }
  }
  return null;
}
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);

/** A git command's subcommand (words[0] is git): its text, EXPANSION when it isn't literal, undefined when none. */
function gitSubcommand(words: Word[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (!plain(w)) return EXPANSION;
    if (GIT_VALUE_OPTIONS.has(w.text)) i++;
    else if (!w.text.startsWith('-')) return w.text;
  }
  return undefined;
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
 * every untracked file too; on an amend, the current commit as well. LIMIT: content that a program git itself runs
 * during the commit adds is not seen here (it doesn't exist yet when this runs).
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
  // WHY: every directory a git command in the line may run in, for its alias lookups (or why they can't be known).
  let lineDirs: Set<string> | string = new Set([p.cwd]);
  const changesDir = (n: string) => n === 'cd' || n === 'pushd' || n === 'popd';
  if (list) {
    for (const c of allCommands(list)) {
      const n = c.words[0]!;
      if (typeof lineDirs !== 'string' && plain(n) && changesDir(n.text)) lineDirs = changeDir(c, lineDirs, p.env);
    }
  } else if (raw.some((c) => changesDir(basename(c.argv[0] ?? '')))) lineDirs = 'a directory change in a line the scan can\'t read';
  const alias = aliasRefusal(loose, p, lineDirs);
  if (alias) return refuseUnread(alias);
  const rawCommits = looseCommits(raw);
  const mentions = command.includes('<<') && command.replace(/["'\\]/g, '').includes('commit');
  // WHY (#971): in a line the model can't read, a git command whose subcommand isn't a literal word, or git left with
  // none (as a program that runs it leaves it), may be a commit too.
  const unread = raw.some((c) => {
    const g = looseGit(c);
    return g !== null && (g.sub === undefined ? c.argv.length === 1 : /[$`{}*?[\]]/.test(g.sub));
  });
  if (!list) {
    if (rawCommits.commits || rawCommits.indirect) return refuse(why);
    if (mentions || unread) return refuseUnread(why);
    const unseen = unseenInUnread(command, raw);
    return unseen ? refuseUnread(`${why}; ${unseen}`) : null;
  }
  const unseen = unseenProgram(list);
  if (unseen) return refuseUnread(unseen);

  const all = allCommands(list);
  const commits: Cmd[] = [];
  for (const c of all) {
    const name = c.words[0]!;
    const at = isGitName(name.text) ? 0 : c.words.findIndex((w, k) => k > 0 && isGitName(w.text));
    if (at < 0) continue;
    if (at > 0 && (NON_EXEC.has(name.text) || (name.text === 'command' && /^-[vV]$/.test(c.words[1]?.text ?? '')))) continue;
    const sub = gitSubcommand(c.words.slice(at));
    // INVARIANT (#971): no shell evaluation inside a git command's words. A git command is modelled only when its
    // subcommand is a literal word and the shell can't turn any of its words into others; one run by another program
    // only when a literal subcommand follows it there, and never a commit.
    if (sub === EXPANSION) return refuseUnread('a git subcommand that is expanded');
    if (c.words.slice(at).some((w) => w.bare)) return (sub === 'commit' ? refuse : refuseUnread)('an unquoted expansion or pattern in a git command');
    if (at > 0 && (sub === undefined || sub === 'commit' || sub.includes('{}'))) return refuseUnread('git run through another program');
    if (sub === 'commit') commits.push(c);
  }
  const hidden = looseCommits(loose);
  if (hidden.indirect) return refuseUnread('a git commit run through another program');
  if (hidden.commits !== commits.length) return (commits.length ? refuse : refuseUnread)('a commit inside a script, substitution or wrapper');
  if (!commits.length) return null;
  if (commits.length > 1) return refuse('more than one commit');
  const commit = commits[0]!;
  const top = list.findIndex((pl) => pl.includes(commit));
  if (top < 0) return refuse('a commit inside a substitution');

  let dirs = new Set([p.cwd]);
  let staging = false;
  const reads: Pick<CommitScope, 'diffReads' | 'logReads' | 'signatureReads' | 'moves'> = {};
  const readTops = new Set<string>();
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
        if (!isGitName(name)) continue;
        const read = gitWords(c.words);
        if (STAGING.has(read.sub ?? '')) staging = true;
        const words = read.rest.map((w) => w.text);
        if (read.sub === 'mv' && words.some((t) => ATTRIBUTES_FILE.test(t))) reads.moves = true;
        // WHY: an interactive staging step shows each change as a diff (through any filter the config names) first.
        const interactive = read.sub === 'add' && words.some((t) => /^-[a-zA-Z]*[pi]/.test(t) || /^--(p|pa|pat|patc|patch|i|in|int|inte|inter|intera|interac|interact|interacti|interactiv|interactive)$/.test(t));
        if (interactive || read.sub === 'diff' || read.sub === 'show' || (read.sub === 'log' && logShowsDiffs(words)) || (read.sub === 'status' && words.some((t) => t.startsWith('-') && !STATUS_NO_DIFF.test(t)))) reads.diffReads = true;
        if (read.sub === 'log' || read.sub === 'show') reads.logReads = true;
        if (words.some((t) => t.includes('%G') || /^--show-sig/.test(t))) reads.signatureReads = true;
        // WHY: a read in another checkout runs under that checkout's config; its programs are checked there too.
        if (read.dirs.length) {
          for (const d of dirs) {
            const r = p.git(d, [...read.dirs.flatMap((x) => ['-C', x]), 'rev-parse', '--show-toplevel']);
            const at = r.stdout.trim();
            if (r.status !== 0 || !at || !isAbsolute(at)) return refuse('a git command before the commit runs in a folder that is not a checkout the scan can check');
            readTops.add(at);
          }
        }
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
    const scope: CommitScope = { unstaged: worktree || staging, untracked: staging, head: amend, ...reads };
    // INVARIANT (#971): every place the commit may run resolves to a checkout the scan reads, or the line is refused;
    // a place that isn't one is never skipped, so a plan is never "nothing to scan".
    const tops = new Set<string>();
    for (const d of dirs) {
      const r = p.git(d, [...g.dirs.flatMap((x) => ['-C', x]), 'rev-parse', '--show-toplevel']);
      const top = r.stdout.trim();
      if (r.status !== 0 || !top || !isAbsolute(top)) return refuse('a folder the commit may run in is not a checkout the scan can read');
      tops.add(top);
    }
    if (!tops.size) return refuse('no checkout to scan');
    return { scans: [...tops].map((t) => ({ top: t, scope })), reads: [...readTops].filter((t) => !tops.has(t)) };
  } catch (e) {
    if (e instanceof Unmodelled) return refuse(e.message);
    if (e instanceof SkipsHook) {
      return { refuse: `git commit ${e.message} skips git's pre-commit hook, the secret scan of the index the commit records; an agent never skips it. Commit without -n or --no-verify` };
    }
    throw e;
  }
}
