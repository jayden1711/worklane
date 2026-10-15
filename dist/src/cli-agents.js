// WHY: item 38. Other vendors' coding CLIs (Codex, Gemini) as build agents. They have neither claude's sandbox nor
// the guardrail hooks, so a run starts only as an unprivileged OS user, only on a build route that isn't high-risk,
// and with its budget enforced here from the CLI's own token counts; its change is held after (cliChangeRefusal).
import { spawn } from 'node:child_process';
import { BRAND } from './brand.js';
import { asUser, killTreeAs, spawnDetached } from './os/index.js';
import { safeProjectEnv } from './project-env.js';
import { providerRefusal } from './providers.js';
import { RunFeed } from './run-feed.js';
import { RunRecorder, runIssue } from './run-record.js';
import { agentEnv, DEFAULT_COMMIT_IDENTITY, identityEnv, runAsEnv, stderrTail, withLoginLock } from './runner.js';
import { StuckDetector, stuckAction } from './stuck.js';
import { limitHit, USAGE_LIMIT_TEXT } from './usage-limit.js';
const TOOL_OUTPUT_MAX = 2000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v) => (typeof v === 'string' ? v : '');
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: content.slice(-TOOL_OUTPUT_MAX), is_error: isError }] } });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
export class CodexStream {
    outcome = { text: '', tokens: { in: 0, out: 0 }, turns: 0, finished: false };
    open = new Set();
    line(j) {
        const e = (j ?? {});
        switch (e.type) {
            case 'thread.started':
                if (typeof e.thread_id === 'string')
                    this.outcome.sessionId = e.thread_id;
                return [];
            case 'item.started':
                return e.item ? this.call(e.item) : [];
            case 'item.completed':
                return e.item ? this.completed(e.item) : [];
            case 'turn.completed':
                // WHY: codex counts cached input inside input_tokens; pricing all of it at the input rate overestimates, never under.
                this.outcome.tokens.in += num(e.usage?.input_tokens);
                this.outcome.tokens.out += num(e.usage?.output_tokens);
                this.outcome.finished = true;
                return [];
            case 'turn.failed':
                this.outcome.failed = str(e.error?.message) || 'turn failed';
                this.outcome.finished = true;
                return [];
            case 'error':
                this.outcome.lastError = str(e.message) || str(e.error?.message) || 'error';
                return [];
            default:
                return [];
        }
    }
    call(it) {
        const id = str(it.id) || `codex-${this.outcome.turns}`;
        const tool = it.type === 'command_execution' ? { name: 'Bash', input: { command: str(it.command) } } : it.type === 'file_change' ? { name: 'Edit', input: { file_path: (it.changes ?? []).map((c) => str(c.path)).join(', ') } } : it.type === 'mcp_tool_call' ? { name: `mcp__${str(it.server)}__${str(it.tool)}`, input: {} } : it.type === 'web_search' ? { name: 'WebSearch', input: { query: str(it.query) } } : null;
        if (!tool || this.open.has(id))
            return [];
        this.open.add(id);
        this.outcome.turns++;
        return [toolUse(id, tool.name, tool.input)];
    }
    completed(it) {
        if (it.type === 'agent_message') {
            this.outcome.text = str(it.text);
            return [said(this.outcome.text)];
        }
        if (it.type === 'error') {
            this.outcome.lastError = str(it.message) || 'error';
            return [];
        }
        const id = str(it.id) || `codex-${this.outcome.turns}`;
        const started = this.call(it);
        if (!started.length && !this.open.has(id))
            return [];
        const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0);
        return [...started, toolResult(id, str(it.aggregated_output) || str(it.status), failed)];
    }
}
export class GeminiStream {
    outcome = { text: '', tokens: { in: 0, out: 0 }, turns: 0, finished: false };
    pending = '';
    line(j) {
        const e = (j ?? {});
        switch (e.type) {
            case 'init':
                if (typeof e.session_id === 'string')
                    this.outcome.sessionId = e.session_id;
                if (typeof e.model === 'string')
                    this.outcome.model = e.model;
                return [];
            case 'message':
                if (e.role !== 'assistant')
                    return [];
                this.pending = e.delta === true ? this.pending + str(e.content) : str(e.content);
                return [];
            case 'tool_use': {
                const out = this.flush();
                this.outcome.turns++;
                return [...out, toolUse(str(e.tool_id) || `gemini-${this.outcome.turns}`, str(e.tool_name) || 'tool', typeof e.parameters === 'object' && e.parameters ? e.parameters : {})];
            }
            case 'tool_result': {
                const err = (e.error ?? {});
                return [toolResult(str(e.tool_id), str(e.output) || str(err.message), e.status === 'error')];
            }
            case 'error':
                if (e.severity !== 'warning')
                    this.outcome.lastError = str(e.message) || 'error';
                return [];
            case 'result': {
                const out = this.flush();
                const stats = (e.stats ?? {});
                const t = statsTokens(stats);
                this.outcome.tokens.in += t.in;
                this.outcome.tokens.out += t.out;
                this.outcome.finished = true;
                if (e.status !== 'success')
                    this.outcome.failed = str(e.error?.message) || `status ${str(e.status) || 'unknown'}`;
                return out;
            }
            default:
                return [];
        }
    }
    flush() {
        const text = this.pending.trim();
        this.pending = '';
        if (!text)
            return [];
        this.outcome.text = text;
        return [said(text)];
    }
}
/** WHY: gemini's stats name totals (input_tokens, output_tokens) in stream-json and per-model counts in its older json output. */
function statsTokens(stats) {
    if (typeof stats.input_tokens === 'number' || typeof stats.output_tokens === 'number')
        return { in: num(stats.input_tokens), out: num(stats.output_tokens) };
    let tin = 0;
    let tout = 0;
    for (const m of Object.values((stats.models ?? {}))) {
        tin += num(m?.tokens?.prompt);
        tout += num(m?.tokens?.candidates) + num(m?.tokens?.thoughts);
    }
    return { in: tin, out: tout };
}
/** WHY: neither CLI takes a claude-style schema; the answer's last JSON object is read back (structuredOutput). */
export function cliPrompt(req) {
    const parts = [req.appendSystemPrompt?.trim(), req.prompt];
    if (req.jsonSchema)
        parts.push(`When you are done, end your final message with one JSON object, and nothing after it, that matches this JSON schema:\n${JSON.stringify(req.jsonSchema)}`);
    return parts.filter(Boolean).join('\n\n');
}
export function structuredOutput(text) {
    const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const c of [...fenced.reverse(), text.trim()]) {
        try {
            const v = JSON.parse(c);
            if (v && typeof v === 'object' && !Array.isArray(v))
                return v;
        }
        catch {
            // WHY: not JSON; the next candidate may be.
        }
    }
    for (let at = text.lastIndexOf('{'); at >= 0; at = text.lastIndexOf('{', at - 1)) {
        try {
            const v = JSON.parse(text.slice(at).replace(/\s*`*\s*$/, ''));
            if (v && typeof v === 'object' && !Array.isArray(v))
                return v;
        }
        catch {
            // WHY: not JSON; an earlier brace may start the object.
        }
        if (at === 0)
            break;
    }
    return undefined;
}
/**
 * INVARIANT: the prompt is never on a command line (sudo logs them); it goes on stdin. `codex exec -` reads it from
 * there; the workspace-write sandbox is codex's own, an extra layer under the OS user, never the boundary itself.
 */
export function codexArgs(req) {
    return ['exec', '--json', '--model', req.model, '--sandbox', 'workspace-write', '--skip-git-repo-check', '--color', 'never', '-'];
}
/** WHY: gemini needs -p to run headless; piped stdin is added to it, so -p carries only a pointer to the task there. */
export const GEMINI_POINTER = 'Do the task given on standard input.';
/** INVARIANT: the prompt is never on a command line; yolo because no one is there to approve a tool call. */
export function geminiArgs(req) {
    return ['--output-format', 'stream-json', '--model', req.model, '--approval-mode', 'yolo', '-p', GEMINI_POINTER];
}
/** Why another vendor's CLI may not take this run (or null). INVARIANT: checked by the runner itself, whatever routed it. */
export function cliRunRefusal(agent, req) {
    if (req.provider?.kind !== 'cli' || req.provider.agent !== agent)
        return `the run isn't routed to cli:${agent}`;
    if (!req.route)
        return 'the run has no route';
    const refused = providerRefusal('cli', { route: req.route.kind, highRisk: req.route.highRisk === true });
    if (refused)
        return refused;
    if (req.interactive)
        return 'a person is waiting on this run; it runs on claude';
    if (req.resume !== undefined)
        return `a ${agent} run can't resume a session`;
    if (!(req.provider.usdPerMtok.in > 0 && req.provider.usdPerMtok.out > 0))
        return `cli:${agent} has no prices, so its budget can't be enforced`;
    return null;
}
export const cliCost = (tokens, p) => (tokens.in * p.in + tokens.out * p.out) / 1_000_000;
/** INVARIANT: through sudo as the agent user, its environment passed explicitly (env -i); sudo itself gets only PATH. */
export function cliAgentCommand(user, file, args, env) {
    return [...asUser(user, file, args, env), { PATH: env.PATH ?? '' }];
}
const SUDO_EXEC = {
    wrap: cliAgentCommand,
    kill: (user, pid) => killTreeAs(user, pid),
};
export class CliAgentRunner {
    agent;
    o;
    constructor(agent, o) {
        this.agent = agent;
        this.o = o;
    }
    args(req) {
        return this.agent === 'codex' ? codexArgs(req) : geminiArgs(req);
    }
    stream() {
        return this.agent === 'codex' ? new CodexStream() : new GeminiStream();
    }
    async run(req) {
        const no = (why) => ({ reason: 'failed', detail: `${why}; not starting`, costUsd: 0, turns: 0, model: req.model });
        const refused = cliRunRefusal(this.agent, req);
        if (refused)
            return no(refused);
        const lane = req.lane ?? 'default';
        const runAs = this.o.runAs(lane);
        if (!runAs)
            return no(`lane "${lane}" has no agent user, and cli:${this.agent} runs only as one`);
        // WHY: one run at a time per CLI login (the agent user's home holds it), as claude runs are per login.
        return withLoginLock(`cli:${this.agent}:${runAs.home}`, () => this.runOnce(req, runAs));
    }
    runOnce(req, runAs) {
        const prices = req.provider.usdPerMtok;
        const env = runAsEnv(agentEnv(this.o.base ?? process.env, 'cli', {
            ...safeProjectEnv(req.env),
            ...identityEnv(this.o.identity ?? DEFAULT_COMMIT_IDENTITY),
            [`${BRAND.envPrefix}_ROLE`]: req.role,
            ...(req.taskFile ? { [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile } : {}),
            ...(req.stateDir ? { [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: req.stateDir } : {}),
        }), runAs);
        const exec = this.o.exec ?? SUDO_EXEC;
        const label = req.provider.name;
        const record = req.stateDir ? new RunRecorder(req.stateDir, { role: req.role, model: req.model, cwd: req.cwd, ...(req.taskFile ? { taskFile: req.taskFile } : {}), ...(req.issue !== undefined ? { issue: req.issue } : {}) }) : null;
        const feed = record && req.stateDir ? new RunFeed(req.stateDir, { run: record.id, issue: req.issue ?? runIssue(req.cwd, req.taskFile), role: req.role, model: req.model, cwd: req.cwd }) : null;
        const stuck = req.stuck && req.stuck.mode !== 'off' ? { mode: req.stuck.mode, detector: new StuckDetector(), stopped: null } : null;
        const parser = this.stream();
        const started = (this.o.now ?? Date.now)();
        return new Promise((resolve) => {
            const [file, args, spawnEnv] = exec.wrap(runAs.user, this.o.bin ?? this.agent, this.args(req), env);
            const child = spawn(file, args, { cwd: req.cwd, env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: spawnDetached });
            child.stdin.on('error', () => { });
            child.on('error', () => { });
            child.stdin.end(cliPrompt(req));
            req.onStart?.(child.pid ?? -1);
            let ended = null;
            const kill = (reason, detail) => {
                ended ??= { reason, detail };
                exec.kill(runAs.user, child.pid);
            };
            req.onControl?.({ runId: record?.id ?? null, send: () => ({ queued: false, why: `a ${label} run takes no messages` }), stop: () => kill('stopped', 'killed: stopped') });
            let stall = setTimeout(() => kill('stalled', 'killed: stalled'), req.stallMs);
            const overall = setTimeout(() => kill('timed_out', 'killed: timed_out'), req.timeoutMs);
            req.signal?.addEventListener('abort', () => kill('canceled_by_reconciliation', 'killed: canceled_by_reconciliation'));
            let buf = '';
            let stderr = '';
            child.stdout.on('data', (d) => {
                clearTimeout(stall);
                stall = setTimeout(() => kill('stalled', 'killed: stalled'), req.stallMs);
                buf += d.toString();
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const raw = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    let j;
                    try {
                        j = JSON.parse(raw);
                    }
                    catch {
                        continue;
                    }
                    const lines = parser.line(j);
                    for (const l of lines) {
                        record?.line(l);
                        feed?.line(l);
                        req.onLine?.(l);
                        if (stuck) {
                            for (const v of stuck.detector.line(l)) {
                                const action = stuckAction(stuck.mode, v);
                                if (!action)
                                    continue;
                                try {
                                    req.stuck?.onVerdict?.(v, action);
                                }
                                catch {
                                    // WHY: reporting a verdict never affects the run.
                                }
                                if (action === 'stop' && !stuck.stopped) {
                                    stuck.stopped = v;
                                    kill('stuck', `stopped as stuck: the same ${v.tool} call failed ${v.failures} times in a row: ${v.input.slice(0, 200)}`);
                                }
                            }
                        }
                    }
                    // INVARIANT: the budget and the turn cap hold on every usage report and tool call, not only at the end.
                    const o = parser.outcome;
                    if (ended)
                        continue;
                    if (cliCost(o.tokens, prices) > req.maxBudgetUsd)
                        kill('budget_exhausted', 'per-run budget reached');
                    else if (o.turns > req.maxTurns)
                        kill('failed', `error_max_turns: more than ${req.maxTurns} tool calls`);
                    else if (lines.length)
                        req.onActivity?.(`${label} turn`);
                }
            });
            child.stderr.on('data', (d) => {
                stderr = (stderr + d.toString()).slice(-4000);
            });
            child.on('close', (code) => {
                clearTimeout(stall);
                clearTimeout(overall);
                const o = parser.outcome;
                const costUsd = cliCost(o.tokens, prices);
                const base = { costUsd, turns: o.turns, model: o.model ?? req.model, provider: label, tokens: { ...o.tokens }, durationMs: Math.max(0, (this.o.now ?? Date.now)() - started), ...(o.sessionId ? { sessionId: o.sessionId } : {}) };
                const done = (r) => {
                    const out = { ...r, ...(r.reason === 'stuck' && stuck?.stopped ? { stuck: stuck.stopped } : {}) };
                    record?.finish({ reason: out.reason, costUsd: out.costUsd, turns: out.turns, model: out.model, ...(o.text ? { final: o.text } : {}), ...(stuck ? { stuck: { ...stuck.detector.longest } } : {}), ...(out.sessionId ? { sessionId: out.sessionId } : {}) });
                    feed?.end({ reason: out.reason, costUsd: out.costUsd, turns: out.turns });
                    resolve(out);
                };
                if (ended)
                    return done({ reason: ended.reason, detail: ended.detail, ...base });
                // WHY: usage at the end can still exceed the cap (these CLIs report it per turn); over it, the run doesn't count.
                if (costUsd > req.maxBudgetUsd)
                    return done({ reason: 'budget_exhausted', detail: `per-run budget reached ($${costUsd.toFixed(2)} of $${req.maxBudgetUsd})`, ...base });
                const why = o.failed ?? (o.finished ? undefined : o.lastError);
                const text = `${why ?? ''}\n${stderrTail(stderr)}`;
                if ((why !== undefined || code !== 0) && (USAGE_LIMIT_TEXT.test(text) || /\b429\b|rate.?limit|quota/i.test(text))) {
                    return done({ reason: 'rate_limited', detail: `usage or rate limit reached: ${(why ?? stderrTail(stderr)).slice(0, 300)}`, limit: limitHit({ text, now: (this.o.now ?? Date.now)() }), ...base });
                }
                if (why !== undefined)
                    return done({ reason: 'failed', detail: `${label}: ${why.slice(0, 500)}`, ...base });
                if (!o.finished || code !== 0)
                    return done({ reason: 'failed', detail: `${label} exited ${code} without finishing: ${stderrTail(stderr)}`, ...base });
                const structured = req.jsonSchema ? structuredOutput(o.text) : undefined;
                if (req.jsonSchema && structured === undefined)
                    return done({ reason: 'failed', detail: `${label} ended without the JSON object its answer must end with: ${o.text.slice(-300)}`, ...base });
                done({ reason: 'succeeded', detail: o.text.slice(0, 500), ...(structured !== undefined ? { structured } : {}), ...base });
            });
        });
    }
}
/** INVARIANT: a cli-routed run never falls through to claude here (the coordinator already chose its fallback). */
export function withCliAgents(claude, agents) {
    return {
        run: (req) => {
            if (req.provider?.kind !== 'cli')
                return claude.run(req);
            const a = agents[req.provider.agent];
            return a ? a.run(req) : Promise.resolve({ reason: 'failed', detail: `no ${req.provider.name} runner on this instance; not starting`, costUsd: 0, turns: 0, model: req.model });
        },
    };
}
//# sourceMappingURL=cli-agents.js.map