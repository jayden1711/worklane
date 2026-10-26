// The push gate's first-time-setup hatch, and git's pre-push hook, are a person's to use and never an agent's.
// WHY: the pre-push hook (scripts/push-gate-hook.mjs) refuses a push when origin holds no gate yet, unless the
// environment says PUSH_GATE_BOOTSTRAP=1, which runs the checkout's own copy of the gate: rules the branch being
// pushed can change. An agent that could set it, or point git at another hook, would choose the rules it is judged by.
// Like the rest of the shell matcher this is best effort (shell.ts): the runner also drops the variable from every
// agent's environment (runner.ts agentEnv), and the hook itself refuses the hatch inside an agent run.
import { resolve as resolvePath } from 'node:path';
import { basename, splitCommands, type SimpleCommand } from './shell.js';

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
/**
 * git's own commands that never push. git never lets an alias shadow one of its commands, so only another name is
 * looked up. INVARIANT: only real git commands are listed (an alias named like one that isn't would go unread).
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

// WHY: programs that never run their arguments as a command, so a word `git` among them is only a word.
const NON_EXEC = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'wc', 'less', 'more', 'sort', 'uniq', 'cut', 'nl', 'ls', 'man', 'which', 'type', 'whereis', 'test', '[', 'cd', 'pushd', 'mkdir', 'touch', 'stat', 'file']);

/**
 * git's words in a command: run directly, or run by a program the shell matcher doesn't model (a wrapper with an
 * option it doesn't read, find -exec): from the first word `git` on. null when there is none.
 */
function gitWordsIn(c: SimpleCommand): string[] | null {
  const a = c.argv;
  if (isGit(a[0] ?? '')) return a;
  if (!a.length || NON_EXEC.has(basename(a[0]!))) return null;
  const k = a.findIndex((t, i) => i > 0 && isGit(t));
  return k > 0 ? a.slice(k) : null;
}

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
}

/**
 * A git call and every call it stands for: an alias's expansion, read from config where git would read it, or a
 * misspelt name git corrects to a command (with help.autocorrect on). Without a lookup any other name may push.
 * A string is why it can't be told.
 */
function resolveGit(a: string[], look: Lookup | null, depth = 0): Resolved[] | string {
  const g = parseGit(a);
  const sub = g.sub;
  if (sub === undefined || sub === 'push' || HOOKLESS_PUSH.test(sub) || NON_PUSH_GIT.has(sub)) return [{ ...g, pushes: sub === 'push' || (sub !== undefined && HOOKLESS_PUSH.test(sub)) }];
  if (!look) return [{ ...g, pushes: true }];
  if (depth > 10) return `git ${sub}: an alias loop`;
  if (typeof look.dirs === 'string') return `git ${sub} ${look.dirs}`;
  if (look.env) return `git ${sub} in a line that ${look.env}`;
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
 * The options a command gives `env` (-i, -u NAME, -), which can take git's config away: as a wrapper, or as a word
 * of a program the shell matcher doesn't model (find -exec env -i ...).
 */
function envOptionsOf(c: SimpleCommand): string[] {
  const k = c.argv.findIndex((t, i) => basename(t) === 'env' && c.argv[i + 1]?.startsWith('-'));
  return k < 0 ? c.envOptions : [...c.envOptions, c.argv[k + 1]!];
}
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
  if (c.writes.length || Object.keys(c.assignments).length || !c.argv.length) return false;
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

/** Whether writing `path` (as given, and as resolved against the call's directory) changes git's hooks or config. */
export function isGitHooksOrConfigPath(path: string, resolved: string): boolean {
  return [path, resolved].map(slashes).some((p) => GIT_HOOKS_OR_CONFIG.some((re) => re.test(p)));
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
  const look = lookup ? { git: lookup.git, dirs: lineDirs(commands, lookup.cwd), env: lineEnv(commands) } : null;
  const calls: Resolved[] = [];
  for (const c of commands) {
    const program = basename(c.argv[0] ?? '');
    if (HOOKLESS_PUSH_PROGRAM.test(program)) return bypass(`${program} pushes without git's pre-push hook`);
    const words = gitWordsIn(c);
    if (!words) continue;
    const r = resolveGit(words, look);
    if (typeof r === 'string') return bypass(`${r}, so the guard can't tell whether it pushes without the hook; run git's own command by its name`);
    calls.push(...r);
  }
  const pushes = calls.some((g) => g.pushes);
  for (const c of commands) {
    for (const [name, value] of assigned(c)) {
      if (/^GIT_CONFIG/i.test(name) && HOOK_CONFIG_NAMED.test(value)) return bypass(`${name} sets ${HOOK_CONFIG_NAMED.exec(value)![0]}`);
      if (pushes && PUSH_ENV.test(name)) return bypass(`${name} gives this push a git config or hooks of its own`);
    }
    if (pushes && unsets(c)) return bypass(`${c.argv[0]} in a push's line can take git's config away`);
    const hit = c.writes.find((w) => isGitHooksOrConfigPath(w, resolve(w)));
    if (hit) return bypass(`${hit} is a git hooks dir or config file`);
  }
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

const CONFIG_READ = /^(--get|--get-all|--get-regexp|--list|-l|get|list)$/;
/** git config words that rewrite config by section or in an editor (any abbreviation git takes). */
const CONFIG_REWRITE = /^(-[lz]*e|--e(d(i(t)?)?)?|--ren.*|--rem.*|edit|rename-section|remove-section)$/;

/** Why a `git config` with these words (after the subcommand) may change the hooks or a name git runs; or null. */
function configRefusal(rest: string[]): string | null {
  const rewrite = rest.find((t) => CONFIG_REWRITE.test(t));
  if (rewrite) return `git config ${rewrite} can rewrite core.hooksPath, an include or an alias`;
  if (rest.some((t) => CONFIG_READ.test(t))) return null;
  if (rest.some((t) => HOOKS_PATH_KEY.test(t))) return 'git config core.hooksPath points git at other hooks';
  const key = rest.find((t) => NAME_OR_INCLUDE_KEY.test(t));
  return key ? `git config ${key} can make git read other config or run another command` : null;
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
