// The push gate's first-time-setup hatch, and git's pre-push hook, are a person's to use and never an agent's.
// WHY: the pre-push hook (scripts/push-gate-hook.mjs) refuses a push when origin holds no gate yet, unless the
// environment says PUSH_GATE_BOOTSTRAP=1, which runs the checkout's own copy of the gate: rules the branch being
// pushed can change. An agent that could set it, or point git at another hook, would choose the rules it is judged by.
// Like the rest of the shell matcher this is best effort (shell.ts): the runner also drops the variable from every
// agent's environment (runner.ts agentEnv), and the hook itself refuses the hatch inside an agent run.
import { devNull } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { foldName, gitGuarded } from '../os/git.js';
import { basename, envShort, envTakesNext, programsIn, shortCluster, splitCommands, type SimpleCommand } from './shell.js';

/** The hatch: set to 1 in a person's own shell, for one push. */
export const PUSH_GATE_HATCH_ENV = 'PUSH_GATE_BOOTSTRAP';

// WHY: case-insensitive, as environment names are on Windows.
const HATCH = new RegExp(PUSH_GATE_HATCH_ENV, 'i');
const HOOKS_PATH_KEY = /^core\.hookspath(=|$)/i;
/**
 * Config keys that make git read other config (an include) or run another command for a name (an alias, or a
 * misspelt command git corrects and runs): each can carry core.hooksPath or a hook-skipping push the guard can't see.
 */
const NAME_OR_INCLUDE_KEY = /^(include\.path|includeif\..*\.path|alias\..+|help\.autocorrect)(=|$)/i;
/** Any of those keys, or core.hooksPath, named anywhere in a value (GIT_CONFIG_PARAMETERS, GIT_CONFIG_KEY_<n>). */
const HOOK_CONFIG_NAMED = /core\.hookspath|include(if)?\.|alias\.|help\.autocorrect/i;
/**
 * Environment that gives a push other git config (any GIT_CONFIG*, a moved home or XDG config dir) or another
 * repository, with that repository's hooks (GIT_DIR, GIT_COMMON_DIR).
 */
const PUSH_ENV = /^(GIT_CONFIG.*|GIT_DIR|GIT_COMMON_DIR|HOME|XDG_CONFIG_HOME)$/i;
/**
 * Every word git's option parser reads as push's --no-verify: the full name or a prefix of it (measured, git 2.43:
 * `--no-veri` skips the hook). WHY: shorter prefixes are ambiguous in that version; another may read them as it.
 */
const NO_VERIFY = /^--no-v(e(r(i(f(y)?)?)?)?)?(=|$)/;
/** git commands that push without running the pre-push hook: the plumbing under push, and the remote helpers. */
const HOOKLESS_PUSH = /^(send-pack|http-push|remote-.+)$/;
const HOOKLESS_PUSH_PROGRAM = /^git-(send-pack|http-push|remote-.+?)(\.exe)?$/i;
/** git's own push and config programs, run by name or path (`$(git --exec-path)/git-push`): git push, git config. */
const DASHED_GIT = /^git-(push|config)(\.exe)?$/i;
/**
 * git's own commands that never push, for a guard with no lookup (where one runs, git lists its own). git never
 * lets an alias shadow one of its commands. INVARIANT: only real git commands are listed (an alias named like one
 * that isn't would go unread).
 */
const NON_PUSH_GIT = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore ' +
  'check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree ' +
  'config count-objects describe diff difftool fetch fmt-merge-msg for-each-ref format-patch ' +
  'fsck gc grep hash-object help init interpret-trailers log ls-remote ls-tree merge merge-base merge-file mktag mktree ' +
  'mv name-rev notes prune pull range-diff read-tree rebase reflog remote repack replace rerere reset restore rev-list rev-parse ' +
  'revert rm shortlog show show-branch show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag ' +
  'update-index update-ref var verify-commit verify-tag version worktree write-tree').split(' '));
/** help.autocorrect values with which git runs no corrected command. */
const AUTOCORRECT_OFF = /^(0+|never|show)$/i;

/** A read-only git query in a directory: its exit status (null when it didn't run) and its output. */
export type GitLookup = (dir: string, args: string[]) => { status: number | null; stdout: string };

/** `env` without the hatch (any spelling of its case). The same object, for chaining. */
export function withoutPushGateHatch<T extends Record<string, string | undefined>>(env: T): T {
  for (const k of Object.keys(env)) if (k.toUpperCase() === PUSH_GATE_HATCH_ENV) delete env[k];
  return env;
}

export interface PushHookRefusal {
  rule: 'push-gate-hatch' | 'push-hook-bypass';
  reason: string;
}

const HATCH_REASON = `${PUSH_GATE_HATCH_ENV} is the push gate's first-time-setup hatch, for a person's own push; an agent never sets, exports, passes or stores it (a command that only reads, such as grep or cat on its own, may name it)`;
const hatch = (): PushHookRefusal => ({ rule: 'push-gate-hatch', reason: HATCH_REASON });
const bypass = (what: string): PushHookRefusal => ({ rule: 'push-hook-bypass', reason: `${what}: an agent never skips, swaps or rewrites git's pre-push hook; push through the hook as installed` });

interface GitCall {
  /** Values of -c and --config-env (key=value). */
  configs: string[];
  /** The words before the subcommand. */
  globals: string[];
  /** The options that choose the repository (-C, --git-dir, --work-tree), for a lookup made where git would. */
  locate: string[];
  /** Whether --git-dir names the repository (and with it, the hooks). */
  gitDir: boolean;
  sub: string | undefined;
  rest: string[];
}

const GIT_OPTS_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source']);
const isGit = (t: string) => basename(t) === 'git' || basename(t) === 'git.exe';

/** git's words (`git` first): its global config options, subcommand and the arguments after it. */
function parseGit(a: string[]): GitCall {
  const configs: string[] = [];
  const locate: string[] = [];
  let gitDir = false;
  let i = 1;
  for (; i < a.length && a[i]!.startsWith('-'); i++) {
    const opt = a[i]!;
    const name = opt.split('=')[0]!;
    if (name === '--git-dir') gitDir = true;
    if (['-C', '--git-dir', '--work-tree'].includes(opt)) locate.push(opt, a[i + 1] ?? '');
    else if (['--git-dir', '--work-tree'].includes(name)) locate.push(opt);
    if (opt === '-c' || opt === '--config-env') configs.push(a[++i] ?? '');
    else if (GIT_OPTS_WITH_VALUE.has(opt)) i++;
    else if (opt.startsWith('--config-env=')) configs.push(opt.slice('--config-env='.length));
    else if (/^-c./.test(opt)) configs.push(opt.slice(2));
  }
  return { configs, globals: a.slice(1, i), locate, gitDir, sub: a[i], rest: a.slice(i + 1) };
}

/** A command's git words as a command run directly; null when it isn't git. */
function gitCall(c: SimpleCommand): GitCall | null {
  return isGit(c.argv[0] ?? '') ? parseGit(c.argv) : null;
}

/** `git <sub> ...` for a git program's words, a dashed program (git-push) read as its subcommand. */
function asGit(a: string[]): string[] {
  const dashed = DASHED_GIT.exec(basename(a[0]!));
  return dashed ? ['git', dashed[1]!.toLowerCase(), ...a.slice(1)] : a;
}
const startsGit = (t: string) => isGit(t) || DASHED_GIT.test(basename(t));

export { RUNNERS, type Options, type Runner } from './shell.js';

/** git's words (`git` first) for every git program a command runs. */
const gitWordsIn = (c: SimpleCommand) => programsIn(c).filter((p) => startsGit(p.argv[0] ?? '')).map((p) => asGit(p.argv));

interface Resolved extends GitCall {
  /** Whether git may run a push for this call. */
  pushes: boolean;
}

interface Lookup {
  git: GitLookup;
  /** Every directory the line may run git in, or why they can't be known. */
  dirs: string[] | string;
  /** Why the line's own environment may change what git reads (and a lookup can't), or null. */
  env: string | null;
  /** Whether git runs `sub` as one of its own commands (so never as an alias), with these global options. */
  own(sub: string, globals: string[]): boolean;
}

/**
 * Which of git's lists names only commands git runs as its own for a line: `others` (git-* on PATH) unless the line
 * sets or removes PATH, `main` (git's exec path) unless it sets or removes GIT_EXEC_PATH or clears the environment,
 * and the commands built into git always.
 */
function commandLists(commands: SimpleCommand[]): string {
  const moved = (name: RegExp) => commands.some((c) => assigned(c).some(([n]) => name.test(n)) || removedNames(c).some((n) => n === '*' || name.test(n)));
  if (moved(/^GIT_EXEC_PATH$/i)) return 'builtins';
  return moved(/^PATH$/i) ? 'main' : 'main,others';
}

/** Names a command takes out of the environment (unset, export -n, env -u); `*` for all of it (env -i, env -). */
function removedNames(c: SimpleCommand): string[] {
  const out: string[] = [];
  if (unsets(c)) out.push(...c.argv.slice(1).filter((t) => !t.startsWith('-')));
  for (const p of programsIn(c)) {
    for (let i = 0; i < p.envOptions.length; i++) {
      const o = p.envOptions[i]!;
      const short = envShort(o);
      if (o === '-' || o === '--ignore-environment' || short?.flags.includes('i')) out.push('*');
      if (o.startsWith('--unset=')) out.push(o.slice('--unset='.length));
      const value = envTakesNext(o) ? p.envOptions[++i] : undefined;
      if (o === '--unset' || short?.letter === 'u') out.push(short?.attached || (value ?? '*'));
    }
  }
  return out;
}

/** `own` for a lookup: git's own list, asked once per list; the static list where git can't answer. */
function ownCommands(git: GitLookup, cwd: string, lists: string): Lookup['own'] {
  const asked = new Map<string, Set<string> | null>();
  return (sub, globals) => {
    const which = globals.some((t) => t.startsWith('--exec-path')) ? 'builtins' : lists;
    if (!asked.has(which)) {
      const r = git(cwd, [`--list-cmds=${which}`]);
      asked.set(which, r.status === 0 ? new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) : null);
    }
    return asked.get(which)?.has(sub) ?? NON_PUSH_GIT.has(sub);
  };
}

/**
 * A git call and every call it stands for: an alias's expansion, read from config where git would read it, or a
 * misspelt name git corrects to a command (with help.autocorrect on). Without a lookup any other name may push.
 * A string is why it can't be told.
 */
function resolveGit(a: string[], look: Lookup | null, depth = 0): Resolved[] | string {
  const g = parseGit(a);
  const sub = g.sub;
  if (sub === undefined || sub === 'push' || HOOKLESS_PUSH.test(sub)) return [{ ...g, pushes: sub !== undefined }];
  if (look ? look.own(sub, g.globals) : NON_PUSH_GIT.has(sub)) return [{ ...g, pushes: false }];
  if (!look) return [{ ...g, pushes: true }];
  if (depth > 10) return `git ${sub}: an alias loop`;
  if (typeof look.dirs === 'string') return `git ${sub} ${look.dirs}`;
  if (look.env) return `git ${sub} in a line that ${look.env}`;
  // R1124h 3: a name with a dot may be an alias in a subsection, which git matches whatever its case.
  if (sub.includes('.')) return `git ${sub}: a name with a dot may be an alias in a subsection (alias.<sub>.<name>), which git matches whatever its case`;
  // R1124h 4 (as R124d): a marked process's git reads no global config, so it can't say what this name runs.
  if (gitGuarded()) return `git ${sub}: this process's git reads no global config (it runs for an instance), so it can't say whether the name is an alias or a correction`;
  const out: Resolved[] = [{ ...g, pushes: false }];
  for (const dir of look.dirs) {
    const query = (key: string) => look.git(dir, [...g.locate, 'config', '--get', key]);
    const alias = query(`alias.${sub}`);
    // WHY: git config exits 1 for "no such key"; anything else (an error, a timeout) is not an answer.
    if (alias.status !== 0 && alias.status !== 1) return `git ${sub}: its alias lookup failed`;
    if (alias.status === 0) {
      const value = alias.stdout.trim();
      if (value.startsWith('!')) return `git ${sub} is an alias for a shell command, which may push`;
      const words = splitCommands(value);
      if (words.length !== 1 || Object.keys(words[0]!.assignments).length) return `git ${sub} is an alias the guard can't read`;
      const inner = resolveGit(['git', ...g.globals, ...words[0]!.argv, ...g.rest], look, depth + 1);
      if (typeof inner === 'string') return inner;
      out.push(...inner);
      continue;
    }
    const fix = query('help.autocorrect');
    if (fix.status !== 0 && fix.status !== 1) return `git ${sub}: its help.autocorrect lookup failed`;
    if (fix.status === 0 && !AUTOCORRECT_OFF.test(fix.stdout.trim())) out.push({ ...g, sub: 'push', pushes: true });
  }
  return out;
}

/** Every directory a line may run git in, as far as its directory changes can be followed; or why they can't. */
function lineDirs(commands: SimpleCommand[], cwd: string): string[] | string {
  let dirs = [cwd];
  for (const c of commands) {
    const n = basename(c.argv[0] ?? '');
    if (n === 'popd') return 'after popd';
    if (n !== 'cd' && n !== 'pushd') continue;
    const args = c.argv.slice(1);
    if (args.length !== 1 || /^[-+]/.test(args[0]!) || /[$`*?[{~]/.test(args[0]!)) return `after a directory change the guard can't follow`;
    dirs = [...new Set([...dirs, ...dirs.map((d) => resolvePath(d, args[0]!))])];
    if (dirs.length > 32) return 'after too many directory changes';
  }
  return dirs;
}

/**
 * The options (with their values) a command gives `env` (-i, -u NAME, -), which can take git's config away: an env
 * in command position, as a wrapper or as a program find -exec or a runner runs.
 */
const envOptionsOf = (c: SimpleCommand) => programsIn(c).flatMap((p) => p.envOptions);
const unsets = (c: SimpleCommand) => basename(c.argv[0] ?? '') === 'unset' || (basename(c.argv[0] ?? '') === 'export' && c.argv.includes('-n'));

/** Why the line's own environment may change what git reads, so a lookup made outside it can't tell; or null. */
function lineEnv(commands: SimpleCommand[]): string | null {
  if (commands.some((c) => assigned(c).some(([n]) => /^GIT_/i.test(n) || PUSH_ENV.test(n)))) return "sets git's environment";
  if (commands.some((c) => unsets(c) || envOptionsOf(c).length)) return "changes git's environment";
  return null;
}

/** NAME=value pairs a command sets: its prefix and `env` assignments, and export/declare-style arguments. */
function assigned(c: SimpleCommand): [string, string][] {
  const out: [string, string][] = Object.entries(c.assignments);
  for (const t of c.argv) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=([\s\S]*)$/.exec(t);
    if (m) out.push([m[1]!, m[2]!]);
  }
  return out;
}

const READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'wc', 'less', 'more', 'sort', 'uniq', 'cut', 'nl']);
const GIT_READERS = new Set(['grep', 'log', 'show', 'diff', 'blame', 'status', 'commit']);

/**
 * A command that can name the hatch without being able to set it: a plain reader (or a git read, or a commit, whose
 * message may say it) that writes no file, sets no variable and takes no config or helper program of its own.
 */
function onlyReads(c: SimpleCommand): boolean {
  if (c.writes.length || writeArgs(c).length || Object.keys(c.assignments).length || !c.argv.length) return false;
  const git = gitCall(c);
  if (git) return git.configs.length === 0 && GIT_READERS.has(git.sub ?? '');
  // WHY: rg --pre runs a program of the caller's choosing on every file.
  return READERS.has(basename(c.argv[0]!)) && !c.argv.some((t) => t.startsWith('--pre'));
}

const slashes = (p: string) => p.split('\\').join('/');
/** A hooks dir or config file inside a git dir (a worktree's own included), or a user or system git config. */
const GIT_HOOKS_OR_CONFIG = [/(^|\/)\.git\/(.*\/)?hooks(\/|$)/, /(^|\/)\.git\/(.*\/)?config(\.worktree)?$/, /(^|\/)\.?gitconfig$/, /(^|\/)git\/config$/];
/** Files a later shell, tool or push reads its environment from. */
const ENV_FILE = /(^|\/)(\.(bashrc|bash_profile|bash_login|bash_aliases|bash_logout|profile|zshrc|zshenv|zprofile|zlogin|kshrc|envrc|pam_environment|env(\.[^/]*)?)|[^/]*\.env|config\.fish|environment)$|(^|\/)(environment\.d|profile\.d|conf\.d)\/[^/]+$/i;

/** Commands that put their sources at, or into, a destination they name (a move, a copy, a link). */
const PLACES = new Set(['mv', 'cp', 'ln', 'install', 'rsync']);

/**
 * R1124h 5: what a move, copy or link may create besides its destination: `<destination>/<source's name>`, when the
 * destination is a folder (`mv /tmp/.gitconfig ~` makes ~/.gitconfig). Its operands are its words that aren't options;
 * `-t DIR`, `--target-directory=DIR` name the destination first.
 */
function placedInto(c: SimpleCommand): string[] {
  if (!c.argv.length || !PLACES.has(basename(c.argv[0]!))) return [];
  const args = c.argv.slice(1);
  let target: string | null = null;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-t' || a === '--target-directory') target = args[++i] ?? null;
    else if (a.startsWith('--target-directory=')) target = a.slice('--target-directory='.length);
    else if (!a.startsWith('-')) operands.push(a);
  }
  const dest = target ?? operands.pop();
  if (!dest) return [];
  return operands.map((s) => `${dest.replace(/\/+$/, '')}/${basename(s.replace(/\/+$/, ''))}`);
}

/** A path's shape is a git hooks dir or config file, compared folded: APFS reads ~/.GITCONFIG as ~/.gitconfig (R1124j). */
const shaped = (p: string) => {
  const f = foldName(slashes(p));
  return GIT_HOOKS_OR_CONFIG.some((re) => re.test(f));
};
const clean = (p: string) => slashes(resolvePath(p)).replace(/(.)\/+$/, '$1');

/** HOME, and the folders git reads the user's config from (XDG_CONFIG_HOME, else ~/.config; ~/.config always). */
function configRoots(): { home: string | null; xdg: string | null; roots: string[] } {
  const home = process.env.HOME ? clean(process.env.HOME) : null;
  const xdg = process.env.XDG_CONFIG_HOME ? clean(process.env.XDG_CONFIG_HOME) : home ? `${home}/.config` : null;
  return { home, xdg, roots: [...new Set([xdg, home && `${home}/.config`].filter((x): x is string => !!x))] };
}

/**
 * R1124h 5: whether `resolved`, put in place as a folder, is one git reads config or hooks from: a git dir (a worktree's
 * included), or the user's config folder or its git/ (HOME, XDG_CONFIG_HOME). `mkdir .config/gx`, write its config,
 * then `mv .config/gx .config/git` wrote a git config no path test saw. Folded (R1124j: ~/.CONFIG/Git is that folder).
 */
function holdsGitConfig(resolved: string): boolean {
  const p = foldName(clean(resolved));
  if (/(^|\/)\.git(\/worktrees\/[^/]+)?$/.test(p)) return true;
  return configRoots().roots.some((r) => p === foldName(r) || p === `${foldName(r)}/git`);
}

/** Whether writing `path` (as given, and as resolved against the call's directory) changes git's hooks or config. */
export function isGitHooksOrConfigPath(path: string, resolved: string): boolean {
  return [path, resolved].some(shaped);
}

/** The words `{a,b}` brace expansion makes of `w` (bash's, innermost group first); null past `cap` words. */
function braces(w: string, cap = 64): string[] | null {
  const out = new Set<string>();
  const todo = [w];
  while (todo.length) {
    const s = todo.pop()!;
    const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
    if (!m) out.add(s);
    else for (const alt of m[1]!.split(',')) todo.push(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length));
    if (out.size + todo.length > cap) return null;
  }
  return [...out];
}

const UNKNOWN = '\u0000';
/**
 * An expansion the guard doesn't model (R1124k F1): a command substitution or arithmetic (`$(…)`, backquotes), or a
 * parameter expansion with an operator (`${F%x}`, `${F/x/}`, `${F:-x}`, `${#F}`, `${!F}`). Its value is unknown.
 */
const UNMODELLED = /\$\(|`|\$\{[#!]|\$\{[^}]*[^A-Za-z0-9_}][^}]*\}/;

/**
 * Every spelling a shell word may become as a path: `~` and `~user` as HOME, $HOME and $XDG_CONFIG_HOME as theirs, a
 * variable set in the line as its value, and any other variable, substitution or operator expansion as each folder
 * git reads user config from, or nothing (`unknown`). `unmodelled`: it holds an expansion the guard doesn't model
 * (UNMODELLED, or a line variable whose value does). Null when it makes too many words to follow.
 */
function spellings(w: string, vars: Map<string, string | null>): { s: string; unknown: boolean; unmodelled: boolean }[] | null {
  const { home, xdg } = configRoots();
  const words = braces(w);
  if (!words) return null;
  const out: { s: string; unknown: boolean; unmodelled: boolean }[] = [];
  for (const word of words) {
    let unmodelled = UNMODELLED.test(word);
    let s = home ? word.replace(/(^|[=:])~[^/:]*(?=\/|:|$)/g, `$1${home}`) : word;
    s = s.replace(/\$\(([^()]|\([^()]*\))*\)|`[^`]*`|\$\{[#!][^}]*\}|\$\{[A-Za-z_][A-Za-z0-9_]*[^A-Za-z0-9_}][^}]*\}/g, UNKNOWN);
    s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a?: string, b?: string) => {
      const name = (a ?? b)!;
      if (name === 'HOME' && home) return home;
      if (name === 'XDG_CONFIG_HOME' && xdg) return xdg;
      const v = vars.get(name);
      if (v === null) unmodelled = true;
      return v ?? UNKNOWN;
    });
    let alts = [s];
    for (let i = 0; i < 3 && alts.some((x) => x.includes(UNKNOWN)); i++) alts = alts.flatMap((x) => [home ?? '', xdg ?? '', ''].map((v) => x.replace(UNKNOWN, v)));
    if (alts.some((x) => x.includes(UNKNOWN))) return null;
    out.push(...alts.map((x) => ({ s: x, unknown: s.includes(UNKNOWN), unmodelled })));
  }
  return out;
}

/**
 * Variables the line sets (a prefix, `env`, export or a bare NAME=value), their values spelt as spellings reads them;
 * null for a value holding an expansion the guard doesn't model (R1124k F1: `F=$(printf …)`).
 */
function lineVars(commands: SimpleCommand[]): Map<string, string | null> {
  const { home } = configRoots();
  const vars = new Map<string, string | null>();
  for (const c of commands) for (const [n, v] of assigned(c)) vars.set(n, UNMODELLED.test(v) ? null : home ? v.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home) : v);
  return vars;
}

/**
 * The directories a line's relative paths may resolve in (R1124i): `followed`, the call's and each `cd`/`pushd` target
 * with ~, HOME and the line's variables spelt out; and after a change it can't follow (popd, an option, a substitution),
 * `fallback`: HOME and the user's config folders, where a write destination is judged too (a move made after
 * `cd ~/.config` is judged in ~/.config). Ordinary arguments are judged in `followed` only (R1124k F2: `make config`).
 */
function writeDirs(commands: SimpleCommand[], cwd: string, vars: Map<string, string | null>): { followed: string[]; fallback: string[] } {
  const { home, roots } = configRoots();
  let dirs = [clean(cwd)];
  let lost = false;
  for (const c of commands) {
    const n = basename(c.argv[0] ?? '');
    if (n === 'popd') lost = true;
    if (n !== 'cd' && n !== 'pushd') continue;
    const args = c.argv.slice(1);
    if (!args.length) {
      if (home) dirs = [...new Set([...dirs, home])];
      continue;
    }
    if (args.length !== 1 || /^[-+]/.test(args[0]!)) {
      lost = true;
      continue;
    }
    const sp = spellings(args[0]!, vars);
    if (!sp || sp.some((x) => x.unknown || x.unmodelled) || /[*?[]/.test(args[0]!)) lost = true;
    dirs = [...new Set([...dirs, ...(sp ?? []).filter((x) => !x.unknown).flatMap((x) => dirs.map((d) => clean(resolvePath(d, x.s))))])];
    if (dirs.length > 32) {
      dirs = dirs.slice(0, 32);
      lost = true;
    }
  }
  return { followed: dirs, fallback: lost ? [...new Set([...(home ? [home] : []), ...roots, ...roots.map((r) => `${r}/git`)])] : [] };
}

/** Programs that only read the paths they are given (their redirects are judged as writes either way). */
const PATH_READERS = new Set([...READERS, 'ls', 'stat', 'file', 'realpath', 'readlink', 'test', '[', 'du', 'tree', 'cd', 'pushd', 'popd']);
const pathReader = (c: SimpleCommand) => {
  const git = gitCall(c);
  if (git) return git.configs.length === 0 && (GIT_READERS.has(git.sub ?? '') || (git.sub === 'config' && configUse(git.rest).use === 'read'));
  return PATH_READERS.has(basename(c.argv[0] ?? '')) && !c.argv.some((t) => t.startsWith('--pre'));
};
/** A program that writes to paths it reads at run time (stdin, a find's results), so no word of the line names them. */
const takesPathsFromInput = (c: SimpleCommand) =>
  [{ argv: c.argv }, ...programsIn(c)].some((p) => {
    const n = basename(p.argv[0] ?? '');
    return n === 'xargs' || n === 'parallel' || (n === 'find' && p.argv.some((t) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(t)));
  });
/** The same, in the line's text: the shell matcher reads `xargs cp x` as the `cp x` it runs, so its words show none. */
const PATHS_FROM_INPUT = /(^|[\s|;&(`!{])(xargs|parallel)(\s|$)|(^|\s)-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)(\s|$)/;
/**
 * R1124o D5: a line that reads names into variables (`while read -r f`, mapfile). Only its commands that may write
 * (not a reader, echo, printf or read itself) have their words judged as paths read at run time.
 */
const READS_NAMES = /(^|[\s|;&(`!{])(read|mapfile|readarray)(\s|$)/;
const namesOnly = (c: SimpleCommand) => pathReader(c) || /^(echo|printf|read|mapfile|readarray|true|false|:|test|\[)$/.test(basename(c.argv[0] ?? ''));
/** The path-like parts of a word: itself, the value of --opt=value or of=value, and a short option's attached value. */
const pathParts = (t: string) => [t, ...(t.includes('=') ? [t.slice(t.indexOf('=') + 1)] : []), ...(/^-[A-Za-z]./.test(t) && !t.includes('=') ? [t.slice(2)] : [])].filter(Boolean);

/**
 * R1124k: the words a command writes to, besides its redirects: a move, copy or link's every operand (a link's source
 * is what a write through the link reaches), tee's files, curl's and wget's output file, dd's of=, and the files of an
 * in-place sed or perl.
 */
function writeArgs(c: SimpleCommand): string[] {
  const out: string[] = [];
  for (const p of [{ argv: c.argv }, ...programsIn(c)]) {
    const n = basename(p.argv[0] ?? '');
    const a = p.argv.slice(1);
    if (PLACES.has(n) || n === 'tee') out.push(...a.filter((t) => !t.startsWith('-')), ...a.filter((t) => t.startsWith('--target-directory=')).map((t) => t.slice('--target-directory='.length)));
    if (PLACES.has(n)) a.forEach((t, i) => t === '-t' && a[i + 1] && out.push(a[i + 1]!));
    if (n === 'curl' || n === 'wget') {
      a.forEach((t, i) => {
        if (/^(-o|-O|--output|--output-document)$/.test(t) && a[i + 1]) out.push(a[i + 1]!);
        else if (/^--output(-document)?=/.test(t)) out.push(t.slice(t.indexOf('=') + 1));
        else if (/^-[oO]./.test(t)) out.push(t.slice(2));
      });
    }
    if (n === 'dd') out.push(...a.filter((t) => t.startsWith('of=')).map((t) => t.slice(3)));
    // R1124o D1: sort -o / --output and tree -o write their output file; uniq writes its second operand.
    if (n === 'sort' || n === 'tree') {
      a.forEach((t, i) => {
        if ((t === '-o' || t === '--output') && a[i + 1]) out.push(a[i + 1]!);
        else if (t.startsWith('--output=')) out.push(t.slice('--output='.length));
        else if (/^-[^-]*o./.test(t) && n === 'sort') out.push(t.slice(t.indexOf('o') + 1));
      });
    }
    if (n === 'uniq') out.push(...a.filter((t) => !t.startsWith('-') || t === '-').slice(1, 2));
    // R1124o D2: a git command's --output (log, show, diff, blame, format-patch) writes a file of its choosing.
    if (isGit(n)) {
      a.forEach((t, i) => {
        if ((t === '--output' || t === '--output-directory' || t === '-o') && a[i + 1]) out.push(a[i + 1]!);
        else if (/^--output(-directory)?=/.test(t)) out.push(t.slice(t.indexOf('=') + 1));
      });
    }
    if ((n === 'sed' || n === 'perl') && a.some((t) => /^-[A-Za-z]*i/.test(t) || t.startsWith('--in-place'))) out.push(...a.filter((t) => !t.startsWith('-')));
  }
  return out;
}

/**
 * A glob as bash reads it, folded, as a regular expression, or null when it isn't one: `*`, `?` and a bracket match
 * within a name, and none matches a name's leading dot (R1124k F2: `rm -rf *` names no .git). An unbalanced `[` is a
 * plain character, as in bash.
 */
function globRe(p: string): RegExp | null {
  const f = foldName(p);
  let re = '^';
  let start = true;
  for (let i = 0; i < f.length; i++) {
    const ch = f[i]!;
    if (ch === '/') {
      re += '/';
      start = true;
      continue;
    }
    const noDot = start ? '(?!\\.)' : '';
    if (ch === '*') re += `${noDot}[^/]*`;
    else if (ch === '?') re += `${noDot}[^/]`;
    else if (ch === '[' && f.indexOf(']', i + 2) > 0 && !f.slice(i, f.indexOf(']', i + 2)).includes('/')) {
      const j = f.indexOf(']', i + 2);
      re += `${noDot}[${f.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = j;
    } else re += ch.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
    start = false;
  }
  try {
    return new RegExp(`${re}$`);
  } catch {
    return null;
  }
}

/**
 * R1124i, R1124j, R1124k: the word of the line that writes, or can reach, git's hooks or config, or why the guard can't
 * tell; or null.
 * - A write destination (writeArgs, redirects, placements; in a line that writes to paths it reads at run time, every
 *   word) is spelt every way the shell may (braces, ~, HOME, the line's variables), resolved in every directory the
 *   line may be in, and compared folded. One the guard can't spell out (an expansion it doesn't model, too many
 *   variables, an unreadable glob) is refused: write it with a literal path.
 * - Any other path-like word of a command that doesn't only read is judged the same way where it can be spelt out, in
 *   the directories the line's `cd`s are followed to; one that can't be is left alone (R1124k F2).
 * - A line that runs `eval`, or writes to paths it reads at run time (xargs, find -exec, read) with a word that reaches
 *   HOME or a folder above it, is refused.
 */
function configWriteIn(command: string, commands: SimpleCommand[], cwd: string): string | null {
  if (commands.some((c) => [{ argv: c.argv }, ...programsIn(c)].some((p) => basename(p.argv[0] ?? '') === 'eval'))) return "eval (it builds commands, and their writes, from text the guard can't read)";
  const vars = lineVars(commands);
  const { followed, fallback } = writeDirs(commands, cwd, vars);
  const all = [...new Set([...followed, ...fallback])];
  const { home, roots } = configRoots();
  const anyInput = commands.some(takesPathsFromInput) || PATHS_FROM_INPUT.test(command);
  const readsNames = READS_NAMES.test(command) || commands.some((c) => basename(c.argv[0] ?? '') === 'read');
  /** Whether this command's words are paths it may write that it read at run time. */
  const runtime = (c: SimpleCommand) => anyInput || (readsNames && !namesOnly(c));
  const targetsIn = (dirs: string[]) => [...(home ? [`${home}/.gitconfig`] : []), ...roots, ...roots.flatMap((r) => [r + '/git', r + '/git/config']), ...dirs.flatMap((d) => [`${d}/.git`, `${d}/.git/config`, `${d}/.git/hooks`])].map(foldName);
  const above = (p: string) => {
    const f = foldName(p);
    return [...(home ? [home] : []), ...roots].some((r) => foldName(r) === f || foldName(r).startsWith(f === '/' ? '/' : `${f}/`));
  };
  let atRuntime = false;
  /** Why word `w` reaches git's config or hooks, judged in `dirs`; 'unreadable' when a glob in it isn't one. */
  const reaches = (w: string, sp: { s: string; unknown: boolean }[], dirs: string[], dest: boolean): string | null => {
    const targets = targetsIn(dirs);
    for (const { s, unknown } of sp) {
      const paths = s.startsWith('/') ? [clean(s)] : dirs.map((d) => clean(resolvePath(d, s)));
      if (shaped(s) || paths.some(shaped)) return w;
      // A destination put in place as a folder git reads config from. WHY: only a destination (an argument such as
      // `apt-get install git` names no folder); a lone unknown variable stands for any folder, so shapes judge it.
      if (dest && !(unknown && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(w)) && paths.some(holdsGitConfig)) return w;
      if (/[*?[]/.test(s)) {
        for (const p of paths) {
          const re = globRe(p);
          if (!re) return 'unreadable';
          if (targets.some((t) => re.test(t))) return w;
        }
      }
      if (atRuntime && paths.some(above)) return `${w} (a line that writes to paths it reads at run time reaches HOME there)`;
    }
    return null;
  };
  for (const c of commands) {
    atRuntime = runtime(c);
    const words = !pathReader(c) || atRuntime ? c.argv.slice(1).flatMap(pathParts) : [];
    const dests = new Set([...c.writes, ...placedInto(c), ...writeArgs(c), ...(atRuntime ? words : [])]);
    for (const w of dests) {
      const sp = spellings(w, vars);
      const why = sp && !sp.some((x) => x.unmodelled) ? reaches(w, sp, all, true) : 'unreadable';
      if (why === 'unreadable') return `${w}: a write destination the guard can't spell out (a substitution, a parameter operator, too many variables or an unreadable glob); write to a literal path`;
      if (why) return why;
    }
    for (const w of words) {
      if (dests.has(w)) continue;
      const sp = spellings(w, vars);
      if (!sp) continue;
      const why = reaches(w, sp, followed, false);
      if (why && why !== 'unreadable') return why;
    }
  }
  return null;
}

/**
 * Why an agent's shell command may not run: it sets, exports, passes or stores the hatch, or it skips or swaps the
 * pre-push hook: in any spelling git reads as push --no-verify, core.hooksPath (or config that can carry it, or a
 * name that runs a push) by -c, config or environment, a push with other config or another repository's hooks, a
 * push without the hook (send-pack, a remote helper), a write into a hooks dir or a git config file. `resolve` turns
 * a written path into an absolute one. With `lookup`, a git name that isn't one of git's commands is read as git
 * reads it (an alias, or a correction); without, it may be a push.
 */
export function pushHookShellRefusal(command: string, commands: SimpleCommand[], resolve: (p: string) => string, lookup?: { cwd: string; git: GitLookup }): PushHookRefusal | null {
  const named = (c: SimpleCommand) => [...Object.keys(c.assignments), ...Object.values(c.assignments), ...c.argv, ...c.writes].some((t) => HATCH.test(t));
  // INVARIANT: a line that names the hatch anywhere runs only when every command in it can do nothing but read.
  if ((HATCH.test(command) || commands.some(named)) && !commands.every(onlyReads)) return hatch();

  // INVARIANT (#993): every git call is judged as git reads it, alias and correction included; one the guard can't
  // read that way is refused.
  const look = lookup ? { git: lookup.git, dirs: lineDirs(commands, lookup.cwd), env: lineEnv(commands), own: ownCommands(lookup.git, lookup.cwd, commandLists(commands)) } : null;
  const calls: Resolved[] = [];
  for (const c of commands) {
    // R1124o D4: `git` as an argument of a program the guard doesn't know as a runner (arch, xcrun, script, …), with
    // a push or a config change after it, is refused: that program may run it, and the guard can't read how.
    if (!gitWordsIn(c).length && !pathReader(c) && !/^(echo|printf)$/.test(basename(c.argv[0] ?? ''))) {
      const g = c.argv.findIndex((t, i) => i > 0 && isGit(t));
      if (g > 0 && c.argv.slice(g + 1).some((t) => /^(push|config|send-pack)$/.test(t) || NO_VERIFY.test(t))) return bypass(`git run through ${basename(c.argv[0] ?? '')}, a program the guard doesn't know as a runner; run git by its own name`);
    }
    const hookless = programsIn(c).map((p) => basename(p.argv[0] ?? '')).find((n) => HOOKLESS_PUSH_PROGRAM.test(n));
    if (hookless) return bypass(`${hookless} pushes without git's pre-push hook`);
    for (const words of gitWordsIn(c)) {
      const r = resolveGit(words, look);
      if (typeof r === 'string') return bypass(`${r}, so the guard can't tell whether it pushes without the hook; run git's own command by its name`);
      calls.push(...r);
    }
  }
  const pushes = calls.some((g) => g.pushes);
  for (const c of commands) {
    for (const [name, value] of assigned(c)) {
      if (/^GIT_CONFIG/i.test(name) && HOOK_CONFIG_NAMED.test(value)) return bypass(`${name} sets ${HOOK_CONFIG_NAMED.exec(value)![0]}`);
      // #983 (owner's 6c): an agent's git reads its config environment only as the runner set it (GIT_CONFIG_GLOBAL
      // at the null device, src/runner.ts agentEnv), so no line sets any of it.
      // Setting GIT_CONFIG_GLOBAL to the null device, as the runner already has it, changes nothing.
      if (/^GIT_CONFIG/i.test(name) && !(/^GIT_CONFIG_GLOBAL$/i.test(name) && value === devNull)) return bypass(`${name} changes the git config every agent git reads (the runner sets it)`);
      if (pushes && PUSH_ENV.test(name)) return bypass(`${name} gives this push a git config or hooks of its own`);
    }
    if (pushes && unsets(c)) return bypass(`${c.argv[0]} in a push's line can take git's config away`);
    // #983 (6c): nor unsets it (unset, export -n, env -u), nor starts a program with an emptied environment (env -i),
    // where a git would read the user's own config again.
    if (unsets(c) && c.argv.slice(1).some((t) => /^GIT_CONFIG/i.test(t))) return bypass(`${c.argv[0]} ${c.argv.slice(1).join(' ')} takes away the git config the runner sets`);
    const envOpts = envOptionsOf(c);
    if (envOpts.some((t) => /^GIT_CONFIG/i.test(t)) || envOpts.some((t) => t === '-i' || t === '-' || t === '--ignore-environment' || /^-[^-]*i/.test(t))) return bypass("env clearing the environment, or GIT_CONFIG*, takes away the git config the runner sets");
  }
  // INVARIANT (R1124i, R1124j): no command of the line writes, places or names a git hooks dir or config file, in any
  // spelling or case the shell and the file system read as one.
  const hit = configWriteIn(command, commands, lookup?.cwd ?? resolve('.'));
  if (hit) return bypass(`${hit} is, or can reach, a git hooks dir or config file`);
  if (pushes && commands.some((c) => envOptionsOf(c).length)) return bypass("env with an option in a push's line can take git's config away");
  for (const git of calls) {
    if (git.sub && HOOKLESS_PUSH.test(git.sub)) return bypass(`git ${git.sub} pushes without git's pre-push hook`);
    if (git.configs.some((k) => HOOKS_PATH_KEY.test(k))) return bypass('git -c core.hooksPath points git at other hooks');
    const key = git.configs.find((k) => NAME_OR_INCLUDE_KEY.test(k));
    if (key) return bypass(`git -c ${key.split('=')[0]} can make git read other config or run another command`);
    if (git.pushes && git.gitDir) return bypass("git --git-dir with a push runs that repository's hooks");
    const skip = git.pushes ? git.rest.find((t) => NO_VERIFY.test(t)) : undefined;
    if (skip) return bypass(skip === '--no-verify' ? 'git push --no-verify skips the pre-push hook' : `git push ${skip} is git's --no-verify, which skips the pre-push hook`);
    if (git.sub === 'config') {
      const why = configRefusal(git.rest);
      if (why) return bypass(why);
    }
  }
  return null;
}

/** git config's read actions, which take a name and an optional pattern, default or URL but never a value. */
const CONFIG_READ_ACTION = /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list)$/;
/** git config's subcommands that only read (git 2.46 and later; earlier, a name without a section and an error). */
const CONFIG_READ_SUB = /^(get|list)$/;
/**
 * git config's long options that rewrite config by section or in an editor (any abbreviation git takes). WHY: these,
 * and a short cluster with -e among its flags, are refused in any position, though git reads a word after the name
 * as a value, so a git that read options there is no hole.
 */
const CONFIG_REWRITE = /^(--e(d(i(t)?)?)?|--ren.*|--rem.*)$/;
const CONFIG_REWRITE_SUB = /^(edit|rename-section|remove-section)$/;

/** git config long options that only choose a file, scope, type or output format; the second list takes a value. */
const CONFIG_QUIET = /^(--global|--system|--local|--worktree|--includes|--no-includes|--bool|--int|--bool-or-int|--path|--expiry-date|--no-type|--null|--show-origin|--show-scope|--fixed-value|--(file|blob|type|default)=.*)$/;
const CONFIG_QUIET_VALUE = /^(--file|--blob|--type|--default)$/;
/**
 * git config's short options, read by git's parse-options (measured: `git config -h`, git 2.43): -f <file> and
 * -t <type> take a value; -e (edit), -l (list) and -z (NUL output) are flags. Any other letter is a write.
 */
const configShort = (t: string) => shortCluster(t, 'ft');
const configRewrites = (t: string) => CONFIG_REWRITE.test(t) || !!configShort(t)?.flags.includes('e');

/**
 * What `git config` does with these words (after `config`), by git's own argument rules: options end at the first
 * other word or `--` (measured, git 2.43: `git config core.hooksPath --global` writes the value `--global`), and that
 * word is the subcommand or the name; every word after it is an operand. A read action, or `get`/`list` in that
 * place, only reads. Otherwise one operand reads the name and a second is a value. An option git config might take
 * that isn't listed as quiet is a write. `word`: the option or subcommand that rewrites config.
 */
function configUse(rest: string[]): { use: 'read' | 'write' | 'rewrite'; word?: string; at?: number } {
  const rewrite = rest.find(configRewrites);
  if (rewrite) return { use: 'rewrite', word: rewrite };
  let read = false;
  let i = 0;
  for (; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-') || t === '-') break;
    const short = configShort(t);
    if (short) {
      if ([...short.flags].some((ch) => ch !== 'l' && ch !== 'z')) return { use: 'write' };
      if (short.flags.includes('l')) read = true;
      if (short.letter !== undefined && short.attached === '') i++;
    } else if (CONFIG_READ_ACTION.test(t)) read = true;
    else if (CONFIG_QUIET_VALUE.test(t)) i++;
    else if (!CONFIG_QUIET.test(t)) return { use: 'write' };
  }
  const first = rest[i];
  if (first !== undefined && CONFIG_REWRITE_SUB.test(first)) return { use: 'rewrite', word: first };
  if (read || (first !== undefined && CONFIG_READ_SUB.test(first))) return { use: 'read' };
  return { use: rest.length - i > 1 ? 'write' : 'read', at: i };
}

/** The config key a `git config` write names (after its options, or after `set`/`unset` and their options). */
function configKey(rest: string[], at: number): string | undefined {
  const words = rest.slice(at);
  const sub = words[0] === 'set' || words[0] === 'unset';
  return (sub ? words.slice(1) : words).find((t) => !t.startsWith('-'));
}

/** Why a `git config` with these words (after the subcommand) may change the hooks or a name git runs; or null. */
function configRefusal(rest: string[]): string | null {
  const { use, word, at } = configUse(rest);
  if (use === 'rewrite') return `git config ${word} can rewrite core.hooksPath, an include or an alias`;
  if (use === 'read') return null;
  // R1124o D3: a key the guard can't spell out (a variable, a substitution, braces, a glob) may be core.hooksPath.
  const key = configKey(rest, at ?? 0);
  if (key === undefined || /[$`{}\\*?[\]]/.test(key)) return `git config ${key ?? ''}: a key the guard can't spell out; write the key literally`;
  if (rest.some((t) => HOOKS_PATH_KEY.test(t))) return 'git config core.hooksPath points git at other hooks';
  const named = rest.find((t) => NAME_OR_INCLUDE_KEY.test(t));
  return named ? `git config ${named} can make git read other config or run another command` : null;
}

/**
 * Why an agent's Edit/Write may not run: the file is a git hooks dir or config file, or it is a file a later shell or
 * push takes its environment from (a shell rc, .env, an environment.d entry) and the new text names the hatch.
 */
export function pushHookFileRefusal(path: string, resolved: string, input: Record<string, unknown>): PushHookRefusal | null {
  if (isGitHooksOrConfigPath(path, resolved)) return bypass(`${path} is a git hooks dir or config file`);
  if (ENV_FILE.test(slashes(resolved)) && HATCH.test(JSON.stringify(input))) return hatch();
  return null;
}
