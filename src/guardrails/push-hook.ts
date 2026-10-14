// The push gate's first-time-setup hatch, and git's pre-push hook, are a person's to use and never an agent's.
// WHY: the pre-push hook (scripts/push-gate-hook.mjs) refuses a push when origin holds no gate yet, unless the
// environment says PUSH_GATE_BOOTSTRAP=1, which runs the checkout's own copy of the gate: rules the branch being
// pushed can change. An agent that could set it, or point git at another hook, would choose the rules it is judged by.
// Like the rest of the shell matcher this is best effort (shell.ts): the runner also drops the variable from every
// agent's environment (runner.ts agentEnv), and the hook itself refuses the hatch inside an agent run.
import { basename, type SimpleCommand } from './shell.js';

/** The hatch: set to 1 in a person's own shell, for one push. */
export const PUSH_GATE_HATCH_ENV = 'PUSH_GATE_BOOTSTRAP';

// WHY: case-insensitive, as environment names are on Windows.
const HATCH = new RegExp(PUSH_GATE_HATCH_ENV, 'i');
const HOOKS_PATH_KEY = /^core\.hookspath(=|$)/i;
const HOOKS_PATH = /core\.hookspath/i;
/** Config git reads from the environment: with a push in the same line, any of these can carry core.hooksPath. */
const GIT_CONFIG_SOURCE = /^GIT_CONFIG_(GLOBAL|SYSTEM|PARAMETERS|COUNT)$/i;

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
  sub: string | undefined;
  rest: string[];
}

const GIT_OPTS_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);

/** A git command's global config options, subcommand and the arguments after it; null when it isn't git. */
function gitCall(c: SimpleCommand): GitCall | null {
  const a = c.argv;
  if (basename(a[0] ?? '') !== 'git' && basename(a[0] ?? '') !== 'git.exe') return null;
  const configs: string[] = [];
  let i = 1;
  for (; i < a.length && a[i]!.startsWith('-'); i++) {
    const opt = a[i]!;
    if (opt === '-c' || opt === '--config-env') configs.push(a[++i] ?? '');
    else if (GIT_OPTS_WITH_VALUE.has(opt)) i++;
    else if (opt.startsWith('--config-env=')) configs.push(opt.slice('--config-env='.length));
    else if (/^-c./.test(opt)) configs.push(opt.slice(2));
  }
  return { configs, sub: a[i], rest: a.slice(i + 1) };
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
 * pre-push hook (`push --no-verify`, core.hooksPath by -c, config or environment, a write into a hooks dir or a git
 * config file). `resolve` turns a written path into an absolute one.
 */
export function pushHookShellRefusal(command: string, commands: SimpleCommand[], resolve: (p: string) => string): PushHookRefusal | null {
  const named = (c: SimpleCommand) => [...Object.keys(c.assignments), ...Object.values(c.assignments), ...c.argv, ...c.writes].some((t) => HATCH.test(t));
  // INVARIANT: a line that names the hatch anywhere runs only when every command in it can do nothing but read.
  if ((HATCH.test(command) || commands.some(named)) && !commands.every(onlyReads)) return hatch();

  const pushes = commands.some((c) => gitCall(c)?.sub === 'push');
  for (const c of commands) {
    for (const [name, value] of assigned(c)) {
      if (/^GIT_CONFIG/i.test(name) && HOOKS_PATH.test(value)) return bypass(`${name} sets core.hooksPath`);
      if (pushes && GIT_CONFIG_SOURCE.test(name)) return bypass(`${name} gives this push a git config of its own`);
    }
    const hit = c.writes.find((w) => isGitHooksOrConfigPath(w, resolve(w)));
    if (hit) return bypass(`${hit} is a git hooks dir or config file`);
    const git = gitCall(c);
    if (!git) continue;
    if (git.configs.some((k) => HOOKS_PATH_KEY.test(k))) return bypass('git -c core.hooksPath points git at other hooks');
    if (git.sub === 'push' && git.rest.includes('--no-verify')) return bypass('git push --no-verify skips the pre-push hook');
    if (git.sub === 'config' && git.rest.some((t) => HOOKS_PATH_KEY.test(t)) && !git.rest.some((t) => /^(--get|--get-all|--get-regexp|--list|-l|get|list)$/.test(t))) {
      return bypass('git config core.hooksPath points git at other hooks');
    }
  }
  return null;
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
