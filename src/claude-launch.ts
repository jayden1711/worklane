// The one place Claude Code is started for an agent session (#958, the owner's decision, 2026-11-09): every guarded
// run, and every other session the engine starts, goes through launchClaude, which always loads no setting source
// (`--setting-sources ''`), reads no MCP config but what it's given (`--strict-mcp-config`), takes its settings only
// from `--settings` (required: there is no launch without them) and keeps Claude's auto memory off
// (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1). Nothing a caller passes can change those: ClaudeLaunch has no field for them,
// and the launch owns its environment (launchEnv): no CLAUDE_* or ANTHROPIC_* variable it doesn't name reaches claude,
// and PATH keeps only absolute entries.
//
// test/claude-launch-lint.test.ts holds src/ to it: no other module starts the claude binary, or Claude Code's
// cli.js under node, by any spelling the lint reads (its limits are in that test). scripts/ci/setting-sources-probe.mjs
// drives this function on the real binary, over every field of ClaudeLaunch (LAUNCH_FIELDS) and the shapes production's
// call sites make, so the boundary is proven at this one choke point.
import { delimiter, isAbsolute } from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from './os/child-process.js';

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
};

/** Every field of ClaudeLaunch: the probe names each, so a field it doesn't drive can't be added unseen. */
export const LAUNCH_FIELDS = ['bin', 'cwd', 'env', 'asUser', 'detached', 'settings', 'mode', 'model', 'maxTurns', 'maxBudgetUsd', 'allowedTools', 'disallowedTools', 'appendSystemPromptFile', 'appendSystemPrompt', 'jsonSchema', 'effort', 'resume', 'pluginDirs', 'mcpConfigFile', 'pluginCacheDir'] as const satisfies readonly (keyof ClaudeLaunch)[];

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
 * The environment a launch gives claude: the caller's, less every CLAUDE_* and ANTHROPIC_* variable LAUNCH_ENV_KEEP
 * doesn't name (case aside: Windows' names aren't case-sensitive), with PATH's empty and relative entries dropped (an
 * empty entry is the working directory: a bare `claude` would then run the checkout's own file, R1185ac D3), and
 * LAUNCH_ENV over it.
 */
export function launchEnv(env: NodeJS.ProcessEnv, pluginCacheDir?: string): NodeJS.ProcessEnv {
  if (pluginCacheDir !== undefined && !isAbsolute(pluginCacheDir)) throw new Error(`launchClaude: the plugin cache folder ${JSON.stringify(pluginCacheDir)} isn't an absolute path`);
  const keep = new Set<string>(LAUNCH_ENV_KEEP);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(?:CLAUDE|ANTHROPIC)_/i.test(k) && !keep.has(k.toUpperCase())) continue;
    out[k] = /^path$/i.test(k) ? v.split(delimiter).filter((d) => d !== '' && isAbsolute(d)).join(delimiter) : v;
  }
  return { ...out, ...(pluginCacheDir !== undefined ? { CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCacheDir } : {}), ...LAUNCH_ENV };
}

/** The binary a launch starts: a bare name (found on its PATH, as launchEnv leaves it), or an absolute path. */
function launchBin(bin: string): string {
  if (bin.includes('/') || bin.includes('\\')) {
    if (!isAbsolute(bin)) throw new Error(`launchClaude: the binary ${JSON.stringify(bin)} is a relative path: give its absolute path`);
  }
  return bin;
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
function flagFree(spec: Omit<ClaudeLaunch, 'bin' | 'cwd' | 'env' | 'asUser' | 'detached' | 'pluginCacheDir'>): void {
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
export function claudeArgv(spec: Omit<ClaudeLaunch, 'bin' | 'cwd' | 'env' | 'asUser' | 'detached' | 'pluginCacheDir'>): string[] {
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
  const r = spawnSync(launchBin(spec.bin), claudeArgv(spec), { cwd: spec.cwd, env: launchEnv(spec.env, spec.pluginCacheDir), encoding: 'utf8', timeout: o.timeoutMs, input: o.input ?? '' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
}

/** Start a Claude Code session: the only way the engine does (see the top of this file). */
export function launchClaude(spec: ClaudeLaunch): ChildProcessWithoutNullStreams {
  const argv = claudeArgv(spec);
  const env = launchEnv(spec.env, spec.pluginCacheDir);
  const w = spec.asUser ? spec.asUser(launchBin(spec.bin), argv, env) : { file: launchBin(spec.bin), args: argv, env };
  return spawn(w.file, w.args, { cwd: spec.cwd, env: w.env, stdio: ['pipe', 'pipe', 'pipe'], ...(spec.detached ? { detached: true } : {}) }) as ChildProcessWithoutNullStreams;
}
