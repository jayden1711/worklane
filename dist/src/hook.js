// Claude Code hook entry points: `<cli> hook pre-tool-use|stop|session-end`.
// Hooks read one JSON object on stdin. Every failure inside a hook fails
// closed (deny or block with a reason); the generated settings also append
// `|| exit 2`, so a missing or crashing engine blocks instead of allowing.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig } from './config/load.js';
import { evaluate } from './guardrails/engine.js';
import { liveContext, projectStateDir } from './guardrails/context.js';
import { runStopGate } from './stopgate.js';
import { scanCommit, scanPath } from './scan/secrets.js';
import { splitCommands } from './guardrails/shell.js';
export function findProjectRoot(start) {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, BRAND.configDir)))
            return dir;
        const up = dirname(dir);
        if (up === dir)
            return null;
        dir = up;
    }
}
function log(root, file, entry) {
    try {
        const dir = projectStateDir(root);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, file), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    }
    catch {
        // logging must never change a decision
    }
}
const isAgent = (env) => env[`${BRAND.envPrefix}_AGENT`] === '1';
function preToolUse(input, env) {
    const cwd = input.cwd ?? process.cwd();
    const root = env.CLAUDE_PROJECT_DIR && existsSync(join(env.CLAUDE_PROJECT_DIR, BRAND.configDir)) ? env.CLAUDE_PROJECT_DIR : findProjectRoot(cwd);
    const decide = (permissionDecision, reason) => ({
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `[${BRAND.cli}] ${reason}` } }),
        exitCode: 0,
    });
    if (!root)
        return isAgent(env) ? decide('deny', `no ${BRAND.configDir}/ found above ${cwd}`) : { exitCode: 0 };
    let cfg;
    try {
        cfg = loadConfig(root);
    }
    catch (e) {
        const msg = e instanceof ConfigInvalid ? e.message : e.message;
        return decide(isAgent(env) ? 'deny' : 'ask', `guardrails can't load, so this call can't be checked: ${msg}`);
    }
    const v = evaluate({ tool: input.tool_name ?? '', input: input.tool_input ?? {}, cwd }, cfg.guardrails, liveContext(root, env));
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
export function gitCommit(command) {
    for (const c of splitCommands(command)) {
        const [bin, ...args] = c.argv;
        if (bin !== 'git')
            continue;
        const sub = args.find((a, i) => !a.startsWith('-') && !['-C', '-c'].includes(args[i - 1] ?? ''));
        if (sub === 'commit')
            return { all: args.some((a) => a === '-a' || a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a)) };
    }
    return null;
}
async function stop(input, env) {
    const cwd = input.cwd ?? process.cwd();
    const root = findProjectRoot(cwd);
    const taskFile = env[`${BRAND.envPrefix}_TASK_FILE`];
    const block = (reason) => ({ stdout: JSON.stringify({ decision: 'block', reason: `[${BRAND.cli} stop gate] ${reason}` }), exitCode: 0 });
    // Human sessions have no Stop gate (recorded, not silent). Agent sessions always do.
    if (!isAgent(env)) {
        if (root)
            log(root, 'stopgate.jsonl', { outcome: 'human_session', session: input.session_id });
        return { exitCode: 0 };
    }
    if (!taskFile)
        return block('agent session without a task file; the coordinator must set one');
    if (!root)
        return taskFile ? block(`no ${BRAND.configDir}/ found; can't verify done_when`) : { exitCode: 0 };
    let cfg;
    try {
        cfg = loadConfig(root);
    }
    catch (e) {
        return taskFile ? block(`config invalid, can't run the gate: ${e.message}`) : { exitCode: 0 };
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
function sessionEnd(input) {
    const root = findProjectRoot(input.cwd ?? process.cwd());
    if (!input.transcript_path || !existsSync(input.transcript_path))
        return { exitCode: 0 };
    const r = scanPath(input.transcript_path);
    if (root)
        log(root, 'secrets.jsonl', { source: 'transcript', session: input.session_id, transcript: input.transcript_path, ...r });
    if (r.status === 'clean')
        return { exitCode: 0 };
    if (r.status === 'unavailable') {
        return { stderr: `[${BRAND.cli}] transcript secret scan could not run: ${r.error}\n`, exitCode: 0 };
    }
    const lines = r.findings.map((f) => `  ${f.rule} at line ${f.line}`).join('\n');
    return {
        stderr: `[${BRAND.cli}] possible secrets in this session's transcript (${input.transcript_path}):\n${lines}\nRotate any real credential; run \`${BRAND.cli} scan transcripts\` for details.\n`,
        exitCode: 0,
    };
}
export async function runHook(event, input, env = process.env) {
    try {
        if (event === 'pre-tool-use')
            return preToolUse(input, env);
        if (event === 'stop')
            return await stop(input, env);
        if (event === 'session-end')
            return sessionEnd(input);
        if (event === 'session-start')
            return { exitCode: 0 };
        return { stderr: `unknown hook event ${event}\n`, exitCode: 2 };
    }
    catch (e) {
        // Fail closed with a reason Claude can show.
        return { stderr: `[${BRAND.cli}] hook ${event} failed: ${e.message}\n`, exitCode: 2 };
    }
}
export async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}
//# sourceMappingURL=hook.js.map