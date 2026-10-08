// Agent runners. The default runs the locally installed `claude` headless
// with the user's own auth; an option runs it with an API key. Either way
// the agent's environment is built from an allowlist: no GitHub token, no
// git credential helper, no SSH agent, so an agent can't push or write to
// GitHub even if it tries. It proposes; the coordinator acts.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { killTree, spawnDetached } from './os/index.js';
const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'XDG_RUNTIME_DIR', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData', 'ProgramFiles', 'NODE_EXTRA_CA_CERTS'];
/**
 * The agent's whole environment. Anything not listed is dropped, which
 * removes GitHub tokens, cloud keys, database URLs and the SSH agent.
 */
export function agentEnv(base, runtime, extra = {}) {
    const env = {};
    for (const k of PASS_THROUGH)
        if (base[k] !== undefined)
            env[k] = base[k];
    if (runtime === 'sdk' && base.ANTHROPIC_API_KEY)
        env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
    Object.assign(env, {
        [`${BRAND.envPrefix}_AGENT`]: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        // git: no credential helpers or prompts, so pushes can't authenticate.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'false',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        // gh: an empty config dir means no stored login.
        GH_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'no-gh-')),
        ...extra,
    });
    return env;
}
/** Which auth `claude` would use. The cli runtime refuses API-key billing it wasn't asked for. */
export function claudeAuthMethod(env) {
    const r = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', env, timeout: 30_000 });
    try {
        const j = JSON.parse(r.stdout);
        return j.loggedIn ? (j.authMethod ?? 'unknown') : 'none';
    }
    catch {
        return 'unknown';
    }
}
export function cliArgs(req) {
    const args = ['-p', req.prompt, '--output-format', 'stream-json', '--verbose', '--model', req.model, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--max-turns', String(req.maxTurns), '--max-budget-usd', String(req.maxBudgetUsd)];
    if (req.allowedTools.length)
        args.push('--allowedTools', ...req.allowedTools);
    if (req.disallowedTools?.length)
        args.push('--disallowedTools', ...req.disallowedTools);
    if (req.appendSystemPrompt)
        args.push('--append-system-prompt', req.appendSystemPrompt);
    if (req.jsonSchema)
        args.push('--json-schema', JSON.stringify(req.jsonSchema));
    return args;
}
export class CliRunner {
    runtime;
    base;
    bin;
    constructor(runtime = 'cli', base = process.env, bin = 'claude') {
        this.runtime = runtime;
        this.base = base;
        this.bin = bin;
    }
    async run(req) {
        const env = agentEnv(this.base, this.runtime, {
            [`${BRAND.envPrefix}_ROLE`]: req.role,
            ...(req.taskFile ? { [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile } : {}),
            ...(req.stateDir ? { [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: req.stateDir } : {}),
        });
        const auth = claudeAuthMethod(env);
        const want = this.runtime === 'cli' ? ['claude.ai', 'oauth_token'] : ['api_key', 'api_key_helper'];
        if (!want.includes(auth)) {
            return { reason: 'auth_mismatch', detail: `runtime ${this.runtime} expects ${want.join(' or ')} auth, claude reports ${auth}; not starting (no silent billing switch)`, costUsd: 0, turns: 0, model: req.model };
        }
        return new Promise((resolve) => {
            const child = spawn(this.bin, cliArgs(req), { cwd: req.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: spawnDetached });
            req.onStart?.(child.pid ?? -1);
            let result = null;
            let rateLimited = false;
            let ended = null;
            let buf = '';
            let stderr = '';
            const kill = (why) => {
                ended ??= why;
                killTree(child.pid, () => child.kill('SIGKILL'));
            };
            let stall = setTimeout(() => kill('stalled'), req.stallMs);
            const overall = setTimeout(() => kill('timed_out'), req.timeoutMs);
            req.signal?.addEventListener('abort', () => kill('canceled_by_reconciliation'));
            child.stdout.on('data', (d) => {
                clearTimeout(stall);
                stall = setTimeout(() => kill('stalled'), req.stallMs);
                buf += d.toString();
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    let j;
                    try {
                        j = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (j.type === 'result')
                        result = j;
                    else if (j.type === 'rate_limit_event' && j.rate_limit_info?.status === 'rejected')
                        rateLimited = true;
                    else if (j.type === 'assistant')
                        req.onActivity?.('assistant turn');
                }
            });
            child.stderr.on('data', (d) => {
                stderr = (stderr + d.toString()).slice(-4000);
            });
            child.on('close', (code) => {
                clearTimeout(stall);
                clearTimeout(overall);
                const r = result;
                const model = Object.keys(r?.modelUsage ?? {})[0] ?? req.model;
                const base = { costUsd: r?.total_cost_usd ?? 0, turns: r?.num_turns ?? 0, model, ...(r?.session_id ? { sessionId: r.session_id } : {}) };
                if (ended)
                    return resolve({ reason: ended, detail: `killed: ${ended}`, ...base });
                if (rateLimited || r?.api_error_status === 429)
                    return resolve({ reason: 'rate_limited', detail: 'usage or rate limit reached', ...base });
                if (!r)
                    return resolve({ reason: 'failed', detail: `claude exited ${code} without a result: ${stderr.trim().split('\n').pop() ?? ''}`, ...base });
                if (r.subtype === 'error_max_budget_usd')
                    return resolve({ reason: 'budget_exhausted', detail: 'per-run budget reached', ...base });
                if (r.subtype !== 'success' || r.is_error)
                    return resolve({ reason: 'failed', detail: `${r.subtype}: ${(r.result ?? '').slice(0, 500)}`, ...base });
                resolve({ reason: 'succeeded', detail: (r.result ?? '').slice(0, 500), ...(r.structured_output !== undefined ? { structured: r.structured_output } : {}), ...base });
            });
        });
    }
}
/** Scripted runner for tests and dry runs: `script` acts on the worktree and returns structured output. */
export class FakeRunner {
    script;
    calls = [];
    constructor(script) {
        this.script = script;
    }
    async run(req) {
        this.calls.push(req);
        req.onStart?.(process.pid);
        const r = await this.script(req);
        return { reason: 'succeeded', detail: '', costUsd: 0.01, turns: 1, model: req.model, ...r };
    }
}
//# sourceMappingURL=runner.js.map