// Claude Code hook entry points: `<cli> hook pre-tool-use|stop|session-end`.
// Hooks read one JSON object on stdin. Every failure inside a hook fails
// closed (deny or block with a reason); the generated settings also append
// `|| exit 2`, so a missing or crashing engine blocks instead of allowing.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig, type Config } from './config/load.js';
import { evaluate } from './guardrails/engine.js';
import { liveContext, projectStateDir } from './guardrails/context.js';
import { runStopGate } from './stopgate.js';
import { scanPath } from './scan/secrets.js';

export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  transcript_path?: string;
  stop_hook_active?: boolean;
  session_id?: string;
}

export interface HookOutput {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, BRAND.configDir))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function log(root: string, file: string, entry: object) {
  try {
    const dir = projectStateDir(root);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // logging must never change a decision
  }
}

const isAgent = (env: NodeJS.ProcessEnv) => env[`${BRAND.envPrefix}_AGENT`] === '1';

function preToolUse(input: HookInput, env: NodeJS.ProcessEnv): HookOutput {
  const cwd = input.cwd ?? process.cwd();
  const root = env.CLAUDE_PROJECT_DIR && existsSync(join(env.CLAUDE_PROJECT_DIR, BRAND.configDir)) ? env.CLAUDE_PROJECT_DIR : findProjectRoot(cwd);
  const decide = (permissionDecision: 'deny' | 'ask', reason: string): HookOutput => ({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `[${BRAND.cli}] ${reason}` } }),
    exitCode: 0,
  });
  if (!root) return isAgent(env) ? decide('deny', `no ${BRAND.configDir}/ found above ${cwd}`) : { exitCode: 0 };
  let cfg: Config;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    const msg = e instanceof ConfigInvalid ? e.message : (e as Error).message;
    return decide(isAgent(env) ? 'deny' : 'ask', `guardrails can't load, so this call can't be checked: ${msg}`);
  }
  const v = evaluate({ tool: input.tool_name ?? '', input: input.tool_input ?? {}, cwd }, cfg.guardrails, liveContext(root, env));
  if (v.decision === 'none') return { exitCode: 0 };
  log(root, 'guardrails.jsonl', { decision: v.decision, rule: v.rule, tool: input.tool_name, agent: isAgent(env), session: input.session_id });
  return decide(v.decision, `${v.rule}: ${v.reason}`);
}

async function stop(input: HookInput, env: NodeJS.ProcessEnv): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const root = findProjectRoot(cwd);
  const taskFile = env[`${BRAND.envPrefix}_TASK_FILE`];
  const block = (reason: string): HookOutput => ({ stdout: JSON.stringify({ decision: 'block', reason: `[${BRAND.cli} stop gate] ${reason}` }), exitCode: 0 });
  if (!root) return taskFile ? block(`no ${BRAND.configDir}/ found; can't verify done_when`) : { exitCode: 0 };
  let cfg: Config;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    return taskFile ? block(`config invalid, can't run the gate: ${(e as Error).message}`) : { exitCode: 0 };
  }
  const r = await runStopGate({
    cwd,
    stateDir: projectStateDir(root),
    taskFile,
    timeoutS: cfg.tests.stop_gate.timeout_s,
    lockWaitS: cfg.tests.stop_gate.lock_wait_s,
    busyPatterns: cfg.tests.stop_gate.busy_patterns,
    testCommand: cfg.tests.runner.one,
  });
  return r.outcome === 'block' ? block(r.reason) : { exitCode: 0 };
}

function sessionEnd(input: HookInput): HookOutput {
  const root = findProjectRoot(input.cwd ?? process.cwd());
  if (!input.transcript_path || !existsSync(input.transcript_path)) return { exitCode: 0 };
  const r = scanPath(input.transcript_path);
  if (root) log(root, 'secrets.jsonl', { source: 'transcript', session: input.session_id, transcript: input.transcript_path, ...r });
  if (r.status === 'clean') return { exitCode: 0 };
  if (r.status === 'unavailable') {
    return { stderr: `[${BRAND.cli}] transcript secret scan could not run: ${r.error}\n`, exitCode: 0 };
  }
  const lines = r.findings.map((f) => `  ${f.rule} at line ${f.line}`).join('\n');
  return {
    stderr: `[${BRAND.cli}] possible secrets in this session's transcript (${input.transcript_path}):\n${lines}\nRotate any real credential; run \`${BRAND.cli} scan transcripts\` for details.\n`,
    exitCode: 0,
  };
}

export async function runHook(event: string, input: HookInput, env: NodeJS.ProcessEnv = process.env): Promise<HookOutput> {
  try {
    if (event === 'pre-tool-use') return preToolUse(input, env);
    if (event === 'stop') return await stop(input, env);
    if (event === 'session-end') return sessionEnd(input);
    return { stderr: `unknown hook event ${event}\n`, exitCode: 2 };
  } catch (e) {
    // Fail closed with a reason Claude can show.
    return { stderr: `[${BRAND.cli}] hook ${event} failed: ${(e as Error).message}\n`, exitCode: 2 };
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
