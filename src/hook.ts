// Claude Code hook entry points: `<cli> hook pre-tool-use|stop|session-end`.
// Hooks read one JSON object on stdin. Every failure inside a hook fails
// closed (deny or block with a reason); the generated settings also append
// `|| exit 2`, so a missing or crashing engine blocks instead of allowing.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { childEnv, shellCommand } from './os/index.js';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig, type Config } from './config/load.js';
import { hostOf, RESEARCH_ROOT_ENV, researchCallRefusal, researchModeRefusal } from './research.js';
import { INTAKE_ROLE, INTAKE_TOOLS } from './intake/run.js';
import { evaluate } from './guardrails/engine.js';
import { liveContext, projectStateDir } from './guardrails/context.js';
import { TaskFile } from './contract.js';
import { scanCommit, scanPath } from './scan/secrets.js';
import { splitCommands } from './guardrails/shell.js';

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

/**
 * The guardrails with the task's frozen paths added. A task file that is named but can't be read or parsed is
 * an error, never "no frozen paths": the caller refuses the call rather than run without the guard.
 */
function withFrozen(g: Config['guardrails'], taskFile: string | undefined): { guardrails: Config['guardrails'] } | { error: string } {
  if (!taskFile) return { guardrails: g };
  try {
    const frozen = TaskFile.parse(JSON.parse(readFileSync(taskFile, 'utf8'))).frozen;
    return { guardrails: frozen.length ? { ...g, protected_paths: [...g.protected_paths, ...frozen] } : g };
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0]!.slice(0, 200) };
  }
}

function preToolUse(input: HookInput, env: NodeJS.ProcessEnv): HookOutput {
  const cwd = input.cwd ?? process.cwd();
  // A research run without repo access: its hook comes with its lane (not the project's settings; its directory is
  // a bundle with no config), and only the research rules apply.
  const researchRoot = env[RESEARCH_ROOT_ENV];
  const role = env[`${BRAND.envPrefix}_ROLE`];
  // An intake run reads untrusted report text: its read tools only, whatever lane or settings it runs under.
  const intakeRefusal = (tool: string) => (isAgent(env) && role === INTAKE_ROLE && !(INTAKE_TOOLS as readonly string[]).includes(tool) ? `intake runs may only use ${INTAKE_TOOLS.join(', ')}; ${tool} is refused` : null);
  if (isAgent(env) && (role === 'researcher' || role === INTAKE_ROLE) && researchRoot) {
    const why = intakeRefusal(input.tool_name ?? '') ?? researchModeRefusal(input.tool_name ?? '', input.tool_input ?? {}, cwd, researchRoot);
    return why ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[${BRAND.cli}] ${why}` } }), exitCode: 0 } : { exitCode: 0 };
  }
  const root = env.CLAUDE_PROJECT_DIR && existsSync(join(env.CLAUDE_PROJECT_DIR, BRAND.configDir)) ? env.CLAUDE_PROJECT_DIR : findProjectRoot(cwd);
  const decide = (permissionDecision: 'deny' | 'ask', reason: string): HookOutput => ({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `[${BRAND.cli}] ${reason}` } }),
    exitCode: 0,
  });
  if (!root) return isAgent(env) ? decide('deny', `no ${BRAND.configDir}/ found above ${cwd}`) : { exitCode: 0 };
  const intakeWhy = intakeRefusal(input.tool_name ?? '');
  if (intakeWhy) return decide('deny', intakeWhy);
  let cfg: Config;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    const msg = e instanceof ConfigInvalid ? e.message : (e as Error).message;
    return decide(isAgent(env) ? 'deny' : 'ask', `guardrails can't load, so this call can't be checked: ${msg}`);
  }
  // A research run may only read and use the web, and never fetch a blocklisted domain: refused here, before the
  // call runs, whatever the run was told by a page it read (its tools were fixed before it started, too).
  if (isAgent(env) && env[`${BRAND.envPrefix}_ROLE`] === 'researcher') {
    const why = researchCallRefusal(input.tool_name ?? '', input.tool_input ?? {}, cfg.project.research.domain_blocklist);
    if (why) {
      log(root, 'guardrails.jsonl', { decision: 'deny', rule: 'research', tool: input.tool_name, agent: true, session: input.session_id });
      return decide('deny', why);
    }
  }
  // An agent's task can freeze files (a reproduction test): treat them as protected for this run.
  let guardrails = cfg.guardrails;
  if (isAgent(env)) {
    const taskFile = env[`${BRAND.envPrefix}_TASK_FILE`];
    const g = withFrozen(cfg.guardrails, taskFile);
    if ('error' in g) return decide('deny', `the task file ${taskFile} can't be read (${g.error}), so the task's frozen files can't be protected; refusing every call until it can`);
    guardrails = g.guardrails;
    // Hosts the owner allowed for this one run ("allow once"), set by the runner for this session only.
    const once = (env[`${BRAND.envPrefix}_ALLOW_HOSTS`] ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    if (once.length) guardrails = { ...guardrails, network: { ...guardrails.network, allow: [...guardrails.network.allow, ...once] } };
    // A research run's web is the open web minus the research blocklist (checked above), not the network
    // allowlist other agents are held to: let this one fetch's host through; every other guardrail still applies.
    const host = env[`${BRAND.envPrefix}_ROLE`] === 'researcher' && input.tool_name === 'WebFetch' ? hostOf(String(input.tool_input?.url ?? '')) : null;
    if (host) guardrails = { ...guardrails, network: { ...guardrails.network, allow: [...guardrails.network.allow, host] } };
  }
  const v = evaluate({ tool: input.tool_name ?? '', input: input.tool_input ?? {}, cwd }, guardrails, liveContext(root, env));
  if (v.decision === 'none') {
    // Agents: every commit is secret-scanned first. Humans opt in with a git pre-commit hook.
    const commit = isAgent(env) && input.tool_name === 'Bash' ? gitCommit(String(input.tool_input?.command ?? '')) : null;
    if (commit) {
      const r = scanCommit(cwd, commit.all);
      if (r.status !== 'clean') {
        log(root, 'secrets.jsonl', { source: 'commit', session: input.session_id, status: r.status });
        return decide('deny', r.status === 'leaks' ? 'gitleaks found a secret in this commit; remove it (and rotate it if real) before committing' : `commit secret scan could not run (${r.error}); not committing unscanned`);
      }
    }
    return { exitCode: 0 };
  }
  log(root, 'guardrails.jsonl', { decision: v.decision, rule: v.rule, tool: input.tool_name, agent: isAgent(env), session: input.session_id });
  return decide(v.decision, `${v.rule}: ${v.reason}`);
}

/** The `git commit` in a command line, if any, and whether it commits unstaged changes (-a). */
export function gitCommit(command: string): { all: boolean } | null {
  for (const c of splitCommands(command)) {
    const [bin, ...args] = c.argv;
    if (bin !== 'git') continue;
    const sub = args.find((a, i) => !a.startsWith('-') && !['-C', '-c'].includes(args[i - 1] ?? ''));
    if (sub === 'commit') return { all: args.some((a) => a === '-a' || a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a)) };
  }
  return null;
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

/** How long the post-edit check may take; a slower check is ignored, never waited out. */
export const POST_EDIT_TIMEOUT_MS = 20_000;
const POST_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const POST_EDIT_MAX_CHARS = 4000;
/** One shell word (project commands run in bash on every platform). */
const shellWord = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * After an Edit/Write: the project's fast check of that one file (tests.yaml `post_edit`), its findings returned
 * to the agent as context. It never blocks or undoes the edit: no config, a file outside the project, a timeout or
 * any error is a silent no-op (exit 0, no output). The PreToolUse guard is separate and unchanged.
 */
function postToolUse(input: HookInput, timeoutMs: number): HookOutput {
  const none: HookOutput = { exitCode: 0 };
  try {
    if (!POST_EDIT_TOOLS.has(input.tool_name ?? '')) return none;
    const target = input.tool_input?.file_path;
    if (typeof target !== 'string' || !target) return none;
    const cwd = input.cwd ?? process.cwd();
    const root = findProjectRoot(cwd);
    if (!root) return none;
    const template = loadConfig(root).tests.post_edit;
    if (!template) return none;
    const rel = relative(root, resolve(cwd, target));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return none;
    const file = rel.split(sep).join('/');
    const [bin, args] = shellCommand(template.replaceAll('{file}', shellWord(file)));
    const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, env: childEnv() });
    if (r.error || r.signal || r.status === null || r.status === 0) return none;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const text = out.length > POST_EDIT_MAX_CHARS ? `${out.slice(0, POST_EDIT_MAX_CHARS)}\n… (cut)` : out || `exit ${r.status}`;
    const context = `[${BRAND.cli}] the project's post-edit check found problems in ${file} (${template}):\n${text}`;
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }), exitCode: 0 };
  } catch {
    return none;
  }
}

export async function runHook(event: string, input: HookInput, env: NodeJS.ProcessEnv = process.env, opts: { postEditTimeoutMs?: number } = {}): Promise<HookOutput> {
  try {
    if (event === 'pre-tool-use') return preToolUse(input, env);
    if (event === 'post-tool-use') return postToolUse(input, opts.postEditTimeoutMs ?? POST_EDIT_TIMEOUT_MS);
    // The Stop gate was removed (the coordinator re-runs every check itself); older installs still call it.
    if (event === 'stop') return { exitCode: 0 };
    if (event === 'session-end') return sessionEnd(input);
    if (event === 'session-start') return { exitCode: 0 };
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
