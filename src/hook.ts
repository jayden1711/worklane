// Claude Code hook entry points: `node <engine>/dist/src/hook-main.js pre-tool-use|session-start|session-end|post-tool-use`
// (src/hook-main.ts), and `<cli> hook <event>` for installs before #665.
// Hooks read one JSON object on stdin. Every failure inside a hook fails
// closed (deny or block with a reason); the generated settings also append
// `|| exit 2`, so a missing or crashing engine blocks instead of allowing.
import { spawnSync } from './os/child-process.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { childEnv, shellCommand } from './os/index.js';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig, type Config } from './config/load.js';
// WHY (#785): the lanes' rules come from the guard's own modules (src/guard/), not from src/research.ts and
// src/intake/*, so the guard's process loads only what it decides with (test/review.test.ts pins the tree).
import { hostOf, RESEARCH_ROOT_ENV, researchCallRefusal, researchModeRefusal } from './guard/research.js';
import { INTAKE_ROLE, INTAKE_TOOLS } from './guard/intake.js';
import { CHAT_ROLE, CHAT_ROOT_ENV, chatModeRefusal } from './guard/chat.js';
import { evaluate } from './guardrails/engine.js';
import { liveContext, projectStateDir } from './guardrails/context.js';
import { TaskFile } from './contract.js';
import { HELD_OUT_ENV, HELD_OUT_GLOB } from './held-out-paths.js';
import { DASHBOARD_KEY_GLOB } from './dashboard-key-paths.js';
import { expSecretGlobs } from './experiments/paths.js';
import { checkReadPrograms, scanCommit, scanIndex, scanPath } from './scan/secrets.js';
import { commitPlan } from './guard/commit.js';
import { checkWorkingFile, formatFindings } from './comment-policy.js';

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

/** The most of a PreToolUse reason the guard sends at each end (#894 review); the middle of a longer one is cut. */
export const REASON_END_CHARS = 300;

/**
 * A deny or ask reason as the guard sends it. WHY (#894 review): a reason quotes the word it matched (a path, a
 * pattern, a host), and the agent picks the word: padded (`./` 40,000 times before `.env`), it made an 80 KB deny.
 * Every reason the guard sends goes through here, so a deny stays about 1 KB whatever the call: a reason over twice
 * REASON_END_CHARS keeps its start (the word's) and its end (why it was refused), with the cut named.
 */
export function shownReason(reason: string): string {
  if (reason.length <= 2 * REASON_END_CHARS) return reason;
  return `${reason.slice(0, REASON_END_CHARS)}… (${reason.length - 2 * REASON_END_CHARS} characters cut) …${reason.slice(-REASON_END_CHARS)}`;
}

/**
 * The guardrails with the task's frozen paths (and its hidden ones, unreadable too) added. A task file that is named but can't be read or parsed is
 * an error, never "no frozen paths": the caller refuses the call rather than run without the guard.
 */
function withFrozen(g: Config['guardrails'], taskFile: string | undefined): { guardrails: Config['guardrails'] } | { error: string } {
  if (!taskFile) return { guardrails: g };
  try {
    const { frozen, hidden } = TaskFile.parse(JSON.parse(readFileSync(taskFile, 'utf8')));
    // Hidden paths (an experiment's eval and scorer, the harness's config) are never read either: denied as secrets.
    return { guardrails: { ...g, protected_paths: [...g.protected_paths, ...frozen, ...hidden], secret_paths: [...g.secret_paths, ...hidden] } };
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
    return why ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[${BRAND.cli}] ${shownReason(why)}` } }), exitCode: 0 } : { exitCode: 0 };
  }
  // A chat-channel run: its three read tools inside the checkout only, never a credential, key or .env file, and
  // nothing at all without its lane's root (fail closed). The project's guardrails below still apply on top.
  if (isAgent(env) && role === CHAT_ROLE) {
    const chatRoot = env[CHAT_ROOT_ENV];
    const why = chatRoot ? chatModeRefusal(input.tool_name ?? '', input.tool_input ?? {}, cwd, chatRoot) : `chat runs need their lane's root (${CHAT_ROOT_ENV}); refusing every call`;
    if (why) return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[${BRAND.cli}] ${shownReason(why)}` } }), exitCode: 0 };
  }
  const root = env.CLAUDE_PROJECT_DIR && existsSync(join(env.CLAUDE_PROJECT_DIR, BRAND.configDir)) ? env.CLAUDE_PROJECT_DIR : findProjectRoot(cwd);
  const decide = (permissionDecision: 'deny' | 'ask', reason: string): HookOutput => ({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `[${BRAND.cli}] ${shownReason(reason)}` } }),
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
    // Held-out eval cases are never read by an agent, by tool or by shell argument: wherever a store is, and the
    // one this instance names. (They live in the coordinator's state, which agent users can't enter either.)
    const held = env[HELD_OUT_ENV];
    // A dashboard key, likewise: in local mode the agents are the person's own OS user, so only this keeps them out (#508).
    // Experiment jobs' state and root's experiment files too: the eval copies, the data and every job's outputs.
    guardrails = { ...guardrails, secret_paths: [...guardrails.secret_paths, HELD_OUT_GLOB, DASHBOARD_KEY_GLOB, ...expSecretGlobs(), ...(held ? [`${held.replace(/[\\/]+$/, '')}/**`] : [])] };
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
    // INVARIANT (#971): what is scanned is what the commit records, in every checkout it can land in; a command line
    // whose commit can't be modelled (src/guard/commit.ts) is refused, never let through on a narrower scan.
    const plan = isAgent(env) && input.tool_name === 'Bash' ? commitPlan(String(input.tool_input?.command ?? ''), { cwd, env, git: gitQuery }) : null;
    if (plan && 'refuse' in plan) {
      log(root, 'secrets.jsonl', { source: 'commit', session: input.session_id, status: 'unmodelled' });
      return decide('deny', plan.refuse);
    }
    if (plan && !plan.scans.length) return decide('deny', 'the commit secret scan found no checkout to scan for this commit, so it isn\'t let through unscanned');
    // WHY (#971): the line's reads in other checkouts run under those checkouts' config, so it is checked there too.
    for (const other of plan?.reads ?? []) {
      try {
        checkReadPrograms(other, plan!.scans[0]!.scope);
      } catch (e) {
        log(root, 'secrets.jsonl', { source: 'commit', session: input.session_id, status: 'unavailable' });
        return decide('deny', `commit secret scan could not run (${(e as Error).message.split('\n')[0]!.slice(0, 400)}); not committing unscanned`);
      }
    }
    for (const { top, scope } of plan?.scans ?? []) {
      const r = scanCommit(top, scope);
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

/** A read-only git query for the commit model: its exit status and output, never an exception. */
function gitQuery(dir: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 5_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
}

/**
 * git's pre-commit hook, as the engine installs it (src/install.ts installGitHook): the second layer of the commit scan
 * (#983), for agents and people alike. It scans the index the commit records, so what the guard's model of the command
 * line missed is still refused here. Exit 1 refuses the commit; so does a scan that can't run.
 */
function preCommit(): HookOutput {
  const at = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5_000 });
  const top = !at.error && at.status === 0 ? at.stdout.trim() : '';
  if (!top) return { stderr: `[${BRAND.cli}] pre-commit secret scan: no checkout found here; not committing unscanned\n`, exitCode: 1 };
  const r = scanIndex(top);
  const root = findProjectRoot(top);
  if (root) log(root, 'secrets.jsonl', { source: 'pre-commit', status: r.status });
  if (r.status === 'clean') return { exitCode: 0 };
  if (r.status === 'unavailable') return { stderr: `[${BRAND.cli}] pre-commit secret scan could not run (${r.error}); not committing unscanned\n`, exitCode: 1 };
  const lines = r.findings.map((f) => `  ${f.rule} in ${f.file}`).join('\n');
  return { stderr: `[${BRAND.cli}] gitleaks found a secret in this commit:\n${lines}\nRemove it (and rotate it if real) before committing.\n`, exitCode: 1 };
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

const cut = (s: string) => (s.length > POST_EDIT_MAX_CHARS ? `${s.slice(0, POST_EDIT_MAX_CHARS)}\n… (cut)` : s);

/** WHY: its own function so a failing post_edit can't hide the comment policy's report (#330). Null: passed or timed out. */
function postEditCheck(root: string, file: string, template: string, timeoutMs: number): string | null {
  const [bin, args] = shellCommand(template.replaceAll('{file}', shellWord(file)));
  const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, env: childEnv() });
  if (r.error || r.signal || r.status === null || r.status === 0) return null;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return `[${BRAND.cli}] the project's post-edit check found problems in ${file} (${template}):\n${cut(out) || `exit ${r.status}`}`;
}

/** INVARIANT: the same rule and words as the PR check (#330), judged on the file's lines that are new since HEAD. */
function commentCheck(root: string, file: string, policy: Config['project']['comment_policy']): string | null {
  const findings = checkWorkingFile(root, file, policy);
  if (!findings.length) return null;
  return `[${BRAND.cli}] the comment policy refuses ${findings.length === 1 ? 'a new comment' : `${findings.length} new comments`} in ${file}: start each with WHY: or INVARIANT:, or cite an issue or decision id; no narration; at most ${policy.max_lines} lines. It is the same rule the PR check uses.\n${cut(formatFindings(findings))}`;
}

/**
 * INVARIANT: never blocks or undoes the edit (#330). After an Edit/Write, the comment policy (when on) and tests.yaml
 * `post_edit` report to the agent as context; no config, a file outside the project, a timeout or an error is a
 * no-op for that check, silent except a comment check that couldn't run, which says so. PreToolUse is separate.
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
    const cfg = loadConfig(root);
    const rel = relative(root, resolve(cwd, target));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return none;
    const file = rel.split(sep).join('/');
    const found: string[] = [];
    if (cfg.project.comment_policy.enabled) {
      try {
        const r = commentCheck(root, file, cfg.project.comment_policy);
        if (r) found.push(r);
      } catch (e) {
        // WHY: the edit can't be undone here (#330), so a check that can't run fails open and says so; it never guesses.
        found.push(`[${BRAND.cli}] the comment policy could not check ${file} (${(e as Error).message.split('\n')[0]!.slice(0, 200)}); its comments were not judged.`);
      }
    }
    const template = cfg.tests.post_edit;
    if (template) {
      try {
        const r = postEditCheck(root, file, template, timeoutMs);
        if (r) found.push(r);
      } catch {
        // WHY: a post_edit command that can't start stays the silent no-op it always was, without hiding the policy's findings.
      }
    }
    if (!found.length) return none;
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: found.join('\n\n') } }), exitCode: 0 };
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
    if (event === 'pre-commit') return preCommit();
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

/**
 * One hook process: the event's JSON from stdin, the decision to stdout and stderr, and the exit code to end with.
 * The guard's own entry (src/hook-main.ts, what the installed hook commands run) and the CLI's `hook` command (what
 * installs before #665 run) both run this, so the two decide the same.
 */
export async function hookProcess(event: string): Promise<number> {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    process.stderr.write(`[${BRAND.cli}] hook input is not JSON\n`);
    return 2;
  }
  const out = await runHook(event, input);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  return out.exitCode;
}
