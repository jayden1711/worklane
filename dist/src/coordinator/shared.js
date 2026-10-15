import { spawn } from 'node:child_process';
import { killTree, killTreeAs, projectCommand, spawnDetached } from '../os/index.js';
import { DEFAULT_GENERATED } from '../config/schema.js';
/** The default for tests.yaml command_timeout_s (2 hours), for a command run without the config. */
export const COMMAND_TIMEOUT_MS = 2 * 3600_000;
/** How often the worktree pool is checked against main's tip. */
export const POOL_CHECK_MS = 5 * 60_000;
/** When GitHub is still computing whether a PR can merge, look again this soon. */
export const MERGEABLE_RECHECK_MS = 10_000;
/** How often the default branch's tip is checked for a merge (which can make open PRs conflict). */
export const TIP_CHECK_MS = 15_000;
/** A wait on the Claude login shorter than this isn't worth an event. */
export const LOCK_WAIT_RECORDED_MS = 1_000;
/** How many times an issue blocked on a rate limit or budget is requeued on its own before it waits for a person. */
export const RETRY_CAP = 3;
/** When a rate-limit or budget block may retry: a rate limit after its window (5 h), a budget at the next UTC midnight. */
export function retryAfter(kind, now = Date.now()) {
    if (kind === 'rate_limit')
        return { kind, after: new Date(now + 5 * 3600_000) };
    const d = new Date(now);
    return { kind, after: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)) };
}
/** How long a fix run waits on an issue claim held elsewhere (from the first time it found it so) before giving up. */
export const CLAIM_HELD_GIVE_UP_MS = 3600_000;
/**
 * Run a project command without blocking the event loop: with several agents
 * in flight, a blocking test run would starve their output streams and trip
 * their stall timers. Output is capped; the tail is kept for reports.
 */
export function sh(command, cwd, timeoutMs = COMMAND_TIMEOUT_MS, runAs, projectEnv = {}, signal) {
    return new Promise((resolveRun) => {
        // Aborted (the coordinator shutting down): never started, or killed like a timed-out command.
        if (signal?.aborted)
            return resolveRun({ code: null, tail: 'not run: the coordinator is shutting down', out: '' });
        const { file, args, env } = projectCommand(command, runAs, projectEnv);
        const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: spawnDetached });
        let out = '';
        const take = (d) => {
            out += d.toString();
            if (out.length > 32_000_000)
                out = out.slice(-16_000_000);
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        let timedOut = false;
        const kill = () => {
            timedOut = true;
            if (runAs)
                killTreeAs(runAs.user, child.pid);
            else
                killTree(child.pid, () => child.kill('SIGKILL'));
        };
        const timer = setTimeout(kill, timeoutMs);
        signal?.addEventListener('abort', kill, { once: true });
        const finish = (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', kill);
            resolveRun({ code: timedOut ? null : code, tail: out.trim().split('\n').slice(-20).join('\n'), out });
        };
        child.on('error', () => finish(null));
        child.on('close', (code) => finish(code));
    });
}
/** An issue's lane: its lane:<name> label, if any (otherwise the runner's default lane). */
export const laneOf = (issue) => {
    const l = issue.labels.find((x) => x.startsWith('lane:'));
    return l ? { lane: l.slice(5) } : {};
};
/** An emergency stop interrupted this task. */
/** The owner stopped this run from the console. */
export class StoppedByOwner extends Error {
    by;
    constructor(by) {
        super(`stopped by @${by} from the console`);
        this.by = by;
    }
}
export class Halted extends Error {
    constructor(message = 'emergency stop') {
        super(message);
    }
}
/**
 * The coordinator is shutting down (SIGTERM or SIGINT: a restart, an update, a stop): its runs are aborted and their
 * tasks requeued to start again after the restart. A kind of halt, so every caller that requeues on a halt does here too.
 */
export class ShuttingDown extends Halted {
    constructor() {
        super('the coordinator is shutting down');
    }
}
/**
 * The instance is paused on the Claude usage limit (src/usage-limit.ts): a run that hit it, or one asked for while
 * the pause holds, which never starts. A kind of halt, so every caller that requeues on a halt requeues on this too.
 */
export class UsagePaused extends Halted {
    resetAt;
    constructor(resetAt) {
        super(`paused on the Claude usage limit until ${resetAt}`);
        this.resetAt = resetAt;
    }
}
export const DEFAULT_REVIEW = {
    version: 1,
    categories: {},
    levels: {
        L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
        L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
        L2_notify: { when: ['app-non-money-large', 'dependency', 'test-machinery'] },
        L3_human: { when: ['money-path', 'migration', 'auth', 'secrets', 'deploy-config', 'release-config', 'harness-config', 'guardrail-config', 'deletes-data'], over_lines: 800 },
    },
    merge: { auto: true, max_lines: 800, max_files: 20, wait_categories: [], loosened: [] },
    max_pr_lines: 600,
    generated: DEFAULT_GENERATED,
    docs_only_checks: [],
    delegation: { enabled: false, min_clean: 10 },
};
/** The PR body's lines for instruction evals: base and head scores, the cost, and every case that changed. */
export function evalLines(results) {
    if (!results.length)
        return [];
    const score = (s) => (s ? `${s.passed}/${s.total}` : 'new');
    const total = results.reduce((s, r) => s + r.cost_usd, 0);
    return [
        `**Instruction evals** (base → head; ~$${total.toFixed(2)}, the CLI's cost estimate):`,
        ...results.map((r) => {
            const changed = r.changes.filter((c) => !(c.base === 'pass' && c.head === 'pass')).map((c) => `case ${c.id} ${c.base} → ${c.head}`);
            const what = r.error ? `not evaluated: ${r.error}` : `visible ${score(r.base)} → ${score(r.result)}${r.dropped ? ', **lower**' : ''}${r.incomplete ? ', incomplete (cost cap)' : ''}${changed.length ? `; ${changed.join(', ')}` : ''}`;
            const h = r.held_out;
            const held = r.error || h === undefined ? '' : h === null ? `; held-out: none${r.held_out_error ? ` (${r.held_out_error})` : ''}` : `; held-out ${score(h.base)} → ${score(h.result)}${h.dropped ? ', **lower**' : ''}${h.incomplete ? ', incomplete (cost cap)' : ''}`;
            return `- ${r.target}: ${what}${held}${r.samples ? `, ${r.samples} sample(s) per case` : ''} (~$${r.cost_usd.toFixed(2)})`;
        }),
    ];
}
/** The end of a CI job log, for a fix run's brief: the last lines, without the runner's per-line timestamps. */
export function logTail(text, lines = 150, chars = 12_000) {
    const out = text
        .replace(/\r/g, '')
        .split('\n')
        .map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z /, ''))
        .slice(-lines)
        .join('\n');
    return out.length > chars ? out.slice(-chars) : out;
}
/** The blocked comment for a refused push: every reason, one per line. */
export function pushRefusal(reasons) {
    return `the push was refused:\n${reasons.map((r) => `- ${r}`).join('\n')}`;
}
//# sourceMappingURL=shared.js.map