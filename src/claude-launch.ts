// The one place Claude Code is started for an agent session (#958, the owner's decision, 2026-11-09): every guarded
// run, and every other session the engine starts, goes through launchClaude, which always loads no setting source
// (`--setting-sources ''`), reads no MCP config but what it's given (`--strict-mcp-config`), takes its settings only
// from `--settings` (required: there is no launch without them) and keeps Claude's auto memory off
// (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1). Nothing a caller passes can change those: ClaudeLaunch has no field for them.
//
// test/claude-launch-lint.test.ts holds src/ to it: no other module starts the claude binary, or Claude Code's
// cli.js under node, by any spelling the lint reads (its limits are in that test). scripts/ci/setting-sources-probe.mjs
// drives this function on the real binary, over every field of ClaudeLaunch (LAUNCH_FIELDS) and the shapes production's
// call sites make, so the boundary is proven at this one choke point.
import { spawn, type ChildProcessWithoutNullStreams } from './os/child-process.js';

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
};

/** Every field of ClaudeLaunch: the probe names each, so a field it doesn't drive can't be added unseen. */
export const LAUNCH_FIELDS = ['bin', 'cwd', 'env', 'asUser', 'detached', 'settings', 'mode', 'model', 'maxTurns', 'maxBudgetUsd', 'allowedTools', 'disallowedTools', 'appendSystemPromptFile', 'appendSystemPrompt', 'jsonSchema', 'effort', 'resume', 'pluginDirs', 'mcpConfigFile'] as const satisfies readonly (keyof ClaudeLaunch)[];

/** What every launch adds to its environment. */
export const LAUNCH_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } as const;

/**
 * The argv a launch gives claude: `--settings`, `--setting-sources ''` and `--strict-mcp-config` always, then what the
 * spec asks for. In the runner's order for a stream-json session, and in a one-shot answer's for `json`.
 */
export function claudeArgv(spec: Omit<ClaudeLaunch, 'bin' | 'cwd' | 'env' | 'asUser' | 'detached'>): string[] {
  const guards = ['--setting-sources', '', '--strict-mcp-config'];
  const args = ['--settings', JSON.stringify(spec.settings)];
  if (spec.mode === 'stream') args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', spec.model, ...guards, '--permission-mode', 'dontAsk', '--max-turns', String(spec.maxTurns), '--max-budget-usd', String(spec.maxBudgetUsd));
  else args.push('-p', '--model', spec.model, '--output-format', 'json', '--max-turns', String(spec.maxTurns), '--max-budget-usd', String(spec.maxBudgetUsd), ...guards);
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.mode === 'json' && spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.allowedTools.length) args.push('--allowedTools', ...spec.allowedTools);
  if (spec.disallowedTools?.length) args.push('--disallowedTools', ...spec.disallowedTools);
  if (spec.appendSystemPromptFile) args.push('--append-system-prompt-file', spec.appendSystemPromptFile);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  // One flag per approved plugin directory, never a folder of them: exactly what was checked.
  for (const d of spec.pluginDirs ?? []) args.push('--plugin-dir', d);
  if (spec.mcpConfigFile) args.push('--mcp-config', spec.mcpConfigFile);
  if (spec.mode === 'stream' && spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.resume) args.push('--resume', spec.resume);
  return args;
}

/** Start a Claude Code session: the only way the engine does (see the top of this file). */
export function launchClaude(spec: ClaudeLaunch): ChildProcessWithoutNullStreams {
  const argv = claudeArgv(spec);
  const env = { ...spec.env, ...LAUNCH_ENV };
  const w = spec.asUser ? spec.asUser(spec.bin, argv, env) : { file: spec.bin, args: argv, env };
  return spawn(w.file, w.args, { cwd: spec.cwd, env: w.env, stdio: ['pipe', 'pipe', 'pipe'], ...(spec.detached ? { detached: true } : {}) }) as ChildProcessWithoutNullStreams;
}
