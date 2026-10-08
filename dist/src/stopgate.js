// Stop gate: an agent can't finish a task until the task's done_when checks
// pass. The gate never passes by default. If it can't run (lock busy, a
// check timed out, the runner reports it's busy, an internal error), it
// blocks with reason "unavailable" and records that. It never skips.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { acquireLock } from './locks.js';
import { childEnv, killTree, spawnDetached } from './os/index.js';
export const DoneWhen = z.array(z.union([
    z.strictObject({ command: z.string().min(1), timeout_s: z.number().int().positive().optional() }),
    z.strictObject({ test: z.string().min(1), timeout_s: z.number().int().positive().optional() }),
    z.strictObject({ manual: z.string().min(1) }),
    z.strictObject({ repro: z.boolean() }),
]));
export const TaskFile = z.strictObject({
    id: z.string().min(1),
    done_when: DoneWhen.min(1),
});
function runCheck(command, cwd, timeoutMs, busy) {
    const started = Date.now();
    return new Promise((resolveRun) => {
        let out = '';
        let settled = false;
        const done = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolveRun({ check: command, durationMs: Date.now() - started, ...r });
        };
        const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: spawnDetached, env: childEnv() });
        const timer = setTimeout(() => {
            killTree(child.pid, () => child.kill('SIGKILL'));
            done({ status: 'unavailable', exitCode: null, detail: `timed out after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);
        const collect = (b) => {
            out += b.toString();
            if (out.length > 64_000)
                out = out.slice(-32_000);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', (e) => done({ status: 'unavailable', exitCode: null, detail: `could not start: ${e.message}` }));
        child.on('close', (code) => {
            const tail = out.trim().split('\n').slice(-15).join('\n');
            if (busy.some((re) => re.test(out)))
                done({ status: 'unavailable', exitCode: code, detail: `runner reported busy:\n${tail}` });
            else if (code === 0)
                done({ status: 'pass', exitCode: 0, detail: '' });
            else
                done({ status: 'fail', exitCode: code, detail: tail });
        });
    });
}
function record(stateDir, entry) {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, 'stopgate.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}
export async function runStopGate(opts) {
    const result = await evaluateGate(opts).catch((e) => ({ outcome: 'block', unavailable: true, reason: `stop gate error: ${e.message}`, checks: [], manual: [] }));
    try {
        record(opts.stateDir, { outcome: result.outcome, unavailable: result.unavailable, reason: result.reason, checks: result.checks.map(({ detail: _d, ...c }) => c) });
    }
    catch (e) {
        // Not being able to record is itself reported; it never turns a block into a pass.
        if (result.outcome === 'pass')
            return { ...result, outcome: 'block', unavailable: true, reason: `could not record gate result: ${e.message}` };
    }
    return result;
}
async function evaluateGate(opts) {
    if (!opts.taskFile) {
        return { outcome: 'no_task', unavailable: false, reason: 'no task assigned to this session', checks: [], manual: [] };
    }
    let task;
    try {
        task = TaskFile.parse(JSON.parse(readFileSync(opts.taskFile, 'utf8')));
    }
    catch (e) {
        return { outcome: 'block', unavailable: true, reason: `task file unreadable or invalid (${opts.taskFile}): ${e.message.split('\n')[0]}`, checks: [], manual: [] };
    }
    const got = await acquireLock(join(opts.stateDir, `stopgate-${task.id.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`), `stop-gate pid ${process.pid}`, opts.lockWaitS * 1000);
    if (!('lock' in got)) {
        const who = got.holder ? `pid ${got.holder.pid} since ${got.holder.acquiredAt}` : 'unknown holder';
        return { outcome: 'block', unavailable: true, reason: `stop gate busy (another gate run holds the lock: ${who}); not skipping, try again`, checks: [], manual: [] };
    }
    try {
        const busy = opts.busyPatterns.map((p) => new RegExp(p, 'm'));
        const deadline = Date.now() + opts.timeoutS * 1000;
        const checks = [];
        const manual = [];
        for (const item of task.done_when) {
            if ('manual' in item) {
                manual.push(item.manual);
                continue;
            }
            if ('repro' in item)
                continue; // the evaluator owns reproduction tests
            let command;
            if ('test' in item) {
                if (!opts.testCommand) {
                    checks.push({ check: `test ${item.test}`, status: 'unavailable', exitCode: null, durationMs: 0, detail: 'no tests.yaml runner.one command to run a single test' });
                    continue;
                }
                command = opts.testCommand.replaceAll('{file}', item.test);
            }
            else
                command = item.command;
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                checks.push({ check: command, status: 'unavailable', exitCode: null, durationMs: 0, detail: 'gate time budget exhausted before this check ran' });
                continue;
            }
            const limit = Math.min(remaining, (item.timeout_s ?? opts.timeoutS) * 1000);
            checks.push(await runCheck(command, opts.cwd, limit, busy));
        }
        const failed = checks.filter((c) => c.status === 'fail');
        const unavailable = checks.filter((c) => c.status === 'unavailable');
        if (!failed.length && !unavailable.length) {
            return { outcome: 'pass', unavailable: false, reason: checks.length ? `${checks.length} check(s) passed` : 'no automatic checks; manual checks go to the owner', checks, manual };
        }
        const lines = [
            ...failed.map((c) => `FAILED: ${c.check} (exit ${c.exitCode})\n${c.detail}`),
            ...unavailable.map((c) => `COULD NOT RUN: ${c.check}: ${c.detail}`),
        ];
        return {
            outcome: 'block',
            unavailable: !failed.length,
            reason: `done_when not met. Fix and finish again; the task stays open.\n${lines.join('\n\n')}`,
            checks,
            manual,
        };
    }
    finally {
        got.lock.release();
    }
}
//# sourceMappingURL=stopgate.js.map