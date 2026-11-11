// The one place Claude Code is started for an agent session (#958, the owner's decision, 2026-11-09): every guarded
// run, and every other session the engine starts, goes through launchClaude, which always loads no setting source
// (`--setting-sources ''`), reads no MCP config but what it's given (`--strict-mcp-config`), takes its settings only
// from `--settings` (required: there is no launch without them) and keeps Claude's auto memory off
// (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1). Nothing a caller passes can change those: ClaudeLaunch has no field for them,
// and the launch owns its environment (launchEnv): an allowlist, so only the names it lists reach claude, and a
// project's variables (tests.yaml `env`) only by name through `projectEnv`, each checked again here; PATH keeps only
// absolute entries; and a bare binary is resolved here to an absolute path, never from a PATH entry in the checkout or
// a node_modules/.bin (claudeBin).
//
// test/claude-launch-lint.test.ts holds src/ to it: no other module starts the claude binary, or Claude Code's
// cli.js under node, by any spelling the lint reads (its limits are in that test). scripts/ci/setting-sources-probe.mjs
// drives this function on the real binary, over every field of ClaudeLaunch (LAUNCH_FIELDS) and the shapes production's
// call sites make, so the boundary is proven at this one choke point.
import { delimiter, isAbsolute, relative, sep } from 'node:path';
import { BRAND } from './brand.js';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from './os/child-process.js';
import { which } from './os/index.js';
import { projectEnvProblem } from './project-env.js';

export type ClaudeLaunch = {
  /** The claude binary (or a test's stand-in for it). */
  bin: string;
  cwd: string;
  /** The session's environment, before the guards below are added to it. */
  env: NodeJS.ProcessEnv;
  /** Run as another user: the wrapper's file and argv for this binary, argv and environment, and the environment to start the wrapper with (src/os asUser). */
  asUser?: (bin: string, argv: string[], env: NodeJS.ProcessEnv) => { file: string; args: string[]; env: NodeJS.ProcessEnv };
  detached?: boolean;
  /** The session's settings, as `--settings` carries them: the instance's agent settings with the lane's, or a lane's own. */
  settings: object;
  /** `stream`: a stream-json session (prompt and console messages on stdin); `json`: one `-p` answer as JSON. */
  mode: 'stream' | 'json';
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  allowedTools: readonly string[];
  disallowedTools?: readonly string[];
  appendSystemPromptFile?: string;
  appendSystemPrompt?: string;
  jsonSchema?: object;
  /** Only an effort Claude Code takes (the runner checks it against the role's). */
  effort?: string;
  /** A session id to resume (the runner checks its shape). */
  resume?: string;
  pluginDirs?: readonly string[];
  mcpConfigFile?: string;
  /**
   * Where Claude Code keeps installed plugins (CLAUDE_CODE_PLUGIN_CACHE_DIR): the instance's empty, root-owned plugins
   * root, which the runner gives. The launch sets the variable from this field alone: a caller's environment never
   * names it (launchEnv drops it). Absent: no such variable.
   */
  pluginCacheDir?: string;
  /**
   * The names of the project's own variables (tests.yaml `env`) that `env` carries for this session. Only these pass
   * beyond launchEnv's fixed list, and each must pass projectEnvProblem here too (R1185ae D2: BUN_OPTIONS from a
   * committed tests.yaml loaded the checkout's code into claude), or the launch throws.
   */
  projectEnv?: readonly string[];
};

/** Every field of ClaudeLaunch: the probe names each, so a field it doesn't drive can't be added unseen. */
export const LAUNCH_FIELDS = ['bin', 'cwd', 'env', 'asUser', 'detached', 'settings', 'mode', 'model', 'maxTurns', 'maxBudgetUsd', 'allowedTools', 'disallowedTools', 'appendSystemPromptFile', 'appendSystemPrompt', 'jsonSchema', 'effort', 'resume', 'pluginDirs', 'mcpConfigFile', 'pluginCacheDir', 'projectEnv'] as const satisfies readonly (keyof ClaudeLaunch)[];

/** Every tool Claude Code has, for a launch that may use none (skill-eval's answer, the login proof). */
export const NO_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'];

/** What every launch adds to its environment. */
export const LAUNCH_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } as const;

/**
 * The only CLAUDE_* and ANTHROPIC_* variables a launch passes on (R1185ac D1): the login (its config dir, a key or a
 * token, as the runtime and the login proof give them), a provider's endpoint, and Windows' git bash. The plugin
 * cache folder is the launch's own (ClaudeLaunch.pluginCacheDir), never a caller's. Every other one is dropped, whoever put it in the environment: Claude Code reads some to load
 * content outside its setting sources (CLAUDE_CODE_PLUGIN_DIRS loads a plugin's hooks and skills, measured on 2.1.296).
 */
// check-table: never-grow
export const LAUNCH_ENV_KEEP = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_GIT_BASH_PATH'] as const;

/**
 * Every other name a launch passes on, whoever built the environment (R1185ae D1: an allowlist, not a prefix
 * denylist; BUN_OPTIONS=--preload ran code inside the Bun-built claude before it started). The process basics the
 * runner passes through (agentAuthEnv), Windows' own, the agent user's XDG folders (agentUserEnv), the proxy and CA
 * the machine's network.json sets (src/network.ts outboundEnv), and the git and gh keys agentEnv, identityEnv and
 * runAsEnv set. Matched in any case (Windows' names aren't case-sensitive).
 */
// check-table: never-grow
export const LAUNCH_ENV_PASS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData', 'ProgramFiles',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO',
  'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GH_CONFIG_DIR',
] as const;

/** The harness's own variables (its prefix) and git's numbered config keys, by pattern; nothing else is. */
const LAUNCH_ENV_PASS_PATTERN = new RegExp(`^(?:${BRAND.envPrefix}_[A-Z0-9_]+|GIT_CONFIG_(?:KEY|VALUE)_\\d+)$`, 'i');

/** A path inside a node_modules/.bin folder, which a package installs into (a checkout's own `claude`, R1185ae D3). */
const IN_PACKAGE_BIN = /(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/i;

/** Whether `p` is `dir` or inside it. */
const within = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * A launch's PATH (R1185ac D3, R1185ae D3): only absolute entries, none in a node_modules/.bin (npm exec, and so
 * `npx … init`, puts the checkout's and its parents' first), and none inside `cwd`, the folder the session runs in.
 * A bare `claude` looked up on it, here or by another user's `env -i` (asUser), is never the checkout's own.
 */
export function launchPath(path: string, cwd?: string): string {
  return path.split(delimiter).filter((d) => d !== '' && isAbsolute(d) && !IN_PACKAGE_BIN.test(d) && !(cwd !== undefined && within(d, cwd))).join(delimiter);
}

/**
 * The environment a launch gives claude: of the caller's, only the names LAUNCH_ENV_PASS and LAUNCH_ENV_KEEP list,
 * the harness's own and git's numbered config keys, and the project variables `projectEnv` names (each refused here
 * when projectEnvProblem refuses it), in the caller's order; PATH as launchPath leaves it (`cwd`: the session's folder);
 * LAUNCH_ENV and the launch's plugin cache folder over it.
 */
export function launchEnv(env: NodeJS.ProcessEnv, pluginCacheDir?: string, projectEnv: readonly string[] = [], cwd?: string): NodeJS.ProcessEnv {
  if (pluginCacheDir !== undefined && !isAbsolute(pluginCacheDir)) throw new Error(`launchClaude: the plugin cache folder ${JSON.stringify(pluginCacheDir)} isn't an absolute path`);
  for (const k of projectEnv) {
    const why = projectEnvProblem(k);
    if (why) throw new Error(`launchClaude: the project variable ${JSON.stringify(k)} can't reach claude: ${why}`);
  }
  // The launch's own variables stay where the caller had them (the order a sudo `env -i` list shows), with the
  // launch's value; a caller's plugin cache folder never.
  const pass = new Set<string>([...LAUNCH_ENV_PASS, ...LAUNCH_ENV_KEEP, ...Object.keys(LAUNCH_ENV)].map((k) => k.toUpperCase()));
  const project = new Set(projectEnv);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!pass.has(k.toUpperCase()) && !LAUNCH_ENV_PASS_PATTERN.test(k) && !project.has(k)) continue;
    out[k] = /^path$/i.test(k) ? launchPath(v, cwd) : v;
  }
  return { ...out, ...(pluginCacheDir !== undefined ? { CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCacheDir } : {}), ...LAUNCH_ENV };
}

/**
 * The claude binary a launch (or a `claude auth status` check) starts, as an absolute path (R1185ae D3): an absolute
 * `bin` as given, unless it is in a node_modules/.bin; a bare name looked up on `env`'s PATH less its empty and
 * relative entries, every node_modules/.bin (npm exec, and so `npx … init`, puts the checkout's and its parents'
 * first) and every entry inside `cwd` (the checkout or worktree the session runs in). A relative path, or a name found
 * nowhere else, throws: never the checkout's own file. Run as another user (`asUser`), a bare name is left to that
 * user's `env -i`, which looks it up on the launch's PATH (launchPath): the coordinator's own may not have it.
 */
export function claudeBin(bin: string, env: NodeJS.ProcessEnv, cwd: string, asUser = false): string {
  if (bin.includes('/') || bin.includes('\\')) {
    if (!isAbsolute(bin)) throw new Error(`launchClaude: the binary ${JSON.stringify(bin)} is a relative path: give its absolute path`);
    if (IN_PACKAGE_BIN.test(bin)) throw new Error(`launchClaude: the binary ${JSON.stringify(bin)} is in a node_modules/.bin: a package's, not the installed claude`);
    return bin;
  }
  if (asUser) return bin;
  const path = Object.entries(env).find(([k]) => /^path$/i.test(k))?.[1] ?? '';
  const found = which(bin, launchPath(path, cwd));
  if (!found) throw new Error(`launchClaude: ${JSON.stringify(bin)} isn't on PATH outside the checkout and node_modules/.bin`);
  return found;
}

/** The guards every launch ends with: Claude Code takes the last `--settings` and `--setting-sources` it is given. */
export const launchGuards = (settings: object): string[] => ['--settings', JSON.stringify(settings), '--setting-sources', '', '--strict-mcp-config'];

/**
 * Why a spec's values can't be read as flags (R1185aa D1): Claude Code ends a list (`--allowedTools a b`) at the first
 * element starting with `-` and reads it as a flag, so `--setting-sources=user,project,local` in `allowedTools` (a
 * repo's `pre_approved`) would load every source. Every list element must be a string not starting with `-`, and so
 * must every value given as a separate argument (a model, an effort, a session id, a path). The appended system prompt
 * is free text (a skill's own instructions, which may start with `---`): it goes as `--append-system-prompt=<text>`,
 * one argument a flag can't be read out of. Throws naming the field.
 */
function flagFree(spec: Omit<ClaudeLaunch, 'bin' | 'cwd' | 'env' | 'asUser' | 'detached' | 'pluginCacheDir' | 'projectEnv'>): void {
  const bad = (v: unknown) => typeof v !== 'string' || v.startsWith('-');
  for (const k of ['allowedTools', 'disallowedTools', 'pluginDirs'] as const) {
    const list: unknown = spec[k] ?? [];
    if (!Array.isArray(list)) throw new Error(`claudeArgv: ${k} isn't a list`);
    for (const v of list as unknown[]) if (bad(v)) throw new Error(`claudeArgv: ${k} element ${JSON.stringify(v)} would be read as a flag (or isn't text): refused`);
  }
  for (const k of ['model', 'effort', 'resume', 'mcpConfigFile', 'appendSystemPromptFile'] as const) {
    const v: unknown = spec[k];
    if (v !== undefined && bad(v)) throw new Error(`claudeArgv: ${k} ${JSON.stringify(v)} would be read as a flag (or isn't text): refused`);
  }
}

/**
 * The argv a launch gives claude: what the spec asks for, in the runner's order for a stream-json session and a
 * one-shot answer's for `json`, then always `--settings`, `--setting-sources ''` and `--strict-mcp-config`, last, so
 * no earlier argument can stand in for them (R1185aa D1). A spec value that would be read as a flag is refused.
 */
export function claudeArgv(spec: Omit<ClaudeLaunch, 'bin' | 'cwd' | 'env' | 'asUser' | 'detached' | 'pluginCacheDir' | 'projectEnv'>): string[] {
  flagFree(spec);
  const args: string[] = [];
  if (spec.mode === 'stream') args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', spec.model, '--permission-mode', 'dontAsk', '--max-turns', String(spec.maxTurns), '--max-budget-usd', String(spec.maxBudgetUsd));
  else args.push('-p', '--model', spec.model, '--output-format', 'json', '--max-turns', String(spec.maxTurns), '--max-budget-usd', String(spec.maxBudgetUsd));
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.mode === 'json' && spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.allowedTools.length) args.push('--allowedTools', ...spec.allowedTools);
  if (spec.disallowedTools?.length) args.push('--disallowedTools', ...spec.disallowedTools);
  if (spec.appendSystemPromptFile) args.push('--append-system-prompt-file', spec.appendSystemPromptFile);
  if (spec.appendSystemPrompt) args.push(`--append-system-prompt=${spec.appendSystemPrompt}`);
  // One flag per approved plugin directory, never a folder of them: exactly what was checked.
  for (const d of spec.pluginDirs ?? []) args.push('--plugin-dir', d);
  if (spec.mcpConfigFile) args.push('--mcp-config', spec.mcpConfigFile);
  if (spec.mode === 'stream' && spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.resume) args.push('--resume', spec.resume);
  return [...args, ...launchGuards(spec.settings)];
}

/**
 * A one-shot answer, waited for (the setup wizard's login proof, #1245): the same argv and environment as launchClaude,
 * run to its end. `input`: what goes on stdin (none: closed). Never through asUser: the caller's own login is what it
 * proves.
 */
export function launchClaudeSync(spec: Omit<ClaudeLaunch, 'asUser' | 'detached'>, o: { timeoutMs: number; input?: string }): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const r = spawnSync(claudeBin(spec.bin, spec.env, spec.cwd), claudeArgv(spec), { cwd: spec.cwd, env: launchEnv(spec.env, spec.pluginCacheDir, spec.projectEnv, spec.cwd), encoding: 'utf8', timeout: o.timeoutMs, input: o.input ?? '' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
}

/** Start a Claude Code session: the only way the engine does (see the top of this file). */
export function launchClaude(spec: ClaudeLaunch): ChildProcessWithoutNullStreams {
  const argv = claudeArgv(spec);
  const env = launchEnv(spec.env, spec.pluginCacheDir, spec.projectEnv, spec.cwd);
  const bin = claudeBin(spec.bin, spec.env, spec.cwd, !!spec.asUser);
  const w = spec.asUser ? spec.asUser(bin, argv, env) : { file: bin, args: argv, env };
  return spawn(w.file, w.args, { cwd: spec.cwd, env: w.env, stdio: ['pipe', 'pipe', 'pipe'], ...(spec.detached ? { detached: true } : {}) }) as ChildProcessWithoutNullStreams;
}
