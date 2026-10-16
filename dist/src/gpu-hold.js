// `<cli> gpu hold [--gpu <N>]... -- <command> [args...]`: run one of your own GPU jobs under the same per-GPU lock the
// test runs' GPU commands take (docs/test-runs.md "GPU"), so a test run never shares the GPU with it, and it never
// starts while a test run has the GPU. It waits as long as it takes, saying who holds the GPU, and lets go when the
// command ends. Without --gpu it holds every GPU root's file lists for any instance.
//
// WHY: the harness's own runs take the lock; your jobs don't, unless they go through this. Nothing here asks the
// driver (no nvidia-smi): it is the lock and nothing else. Only the <cli>-gpu group's one member (the owner; root's
// scripts/setup/testrun-gpu.sh holder) can open a lock: anyone who could would be able to keep the GPU runs waiting.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BRAND } from './brand.js';
import { flockHolders, holdFlocksInOrder } from './os/index.js';
import { GPU_GROUP, gpuCommands, gpuFilePath, gpuIndices, gpuLockPath, readGpuFile } from './testrun/gpu.js';
/** The arguments: --gpu indices (before `--`), and the command after it. */
export function parseGpuHold(args) {
    const at = args.indexOf('--');
    if (at < 0 || at === args.length - 1)
        return { error: `usage: ${BRAND.cli} gpu hold [--gpu <N>]... -- <command> [args...]` };
    const gpus = [];
    const opts = args.slice(0, at);
    for (let i = 0; i < opts.length; i++) {
        if (opts[i] !== '--gpu' || !/^[0-9]{1,2}$/.test(opts[i + 1] ?? ''))
            return { error: `gpu hold: unexpected ${opts[i]}${opts[i] === '--gpu' ? ' (a GPU index, 0 to 99)' : ''}` };
        gpus.push(Number(opts[++i]));
    }
    return { gpus: [...new Set(gpus)].sort((a, b) => a - b), command: args.slice(at + 1) };
}
/** Whether this user is refused a lock (EACCES/EPERM on its directory or the file), as a non-member of the GPU group is. */
export function lockDenied(path) {
    for (const [p, mode] of [[dirname(path), constants.X_OK], [path, constants.R_OK]]) {
        try {
            accessSync(p, mode);
        }
        catch (e) {
            const code = e.code;
            if (code === 'EACCES' || code === 'EPERM')
                return true;
        }
    }
    return false;
}
/** Who holds a GPU's lock, as far as this user can tell: the helper's note in the file, and the holders' pids. */
export function gpuHolder(path) {
    let note = '';
    try {
        note = readFileSync(path, 'utf8').replace(/[^\w ./:+-]/g, '').trim().slice(0, 200);
    }
    catch {
        // unreadable: the pids alone
    }
    const pids = (flockHolders(path) ?? []).filter((h) => h.mode === 'exclusive').map((h) => `pid ${h.pid}`);
    return [note, ...pids].filter(Boolean).join('; ') || 'another process';
}
/** Run `gpu hold`; its exit code is the command's (2 for a usage or setup problem, nothing run). */
export async function gpuHoldCommand(args, d = {}) {
    const err = d.err ?? ((l) => process.stderr.write(`${l}\n`));
    const p = parseGpuHold(args);
    if ('error' in p) {
        err(p.error);
        return 2;
    }
    let gpus = p.gpus;
    if (!gpus.length) {
        const f = readGpuFile(d.file ?? gpuFilePath(), d.rootUid ?? 0);
        if ('state' in f || !gpuIndices(f).length) {
            err(`gpu hold: no instance's test runs may use a GPU here (${'state' in f ? f.why : 'root\'s file lists none'}), so no test run takes a GPU lock: run your command directly, or name a GPU with --gpu <N>. Root turns GPU test runs on with: ${gpuCommands('<name>').enable}`);
            return 2;
        }
        gpus = gpuIndices(f);
    }
    const lock = d.lockPath ?? gpuLockPath;
    // INVARIANT: only the GPU group's members (the owner) can open a lock; anyone else is told so, before anything runs.
    const denied = gpus.find((g) => lockDenied(lock(g)));
    if (denied !== undefined) {
        err(`gpu hold: only a member of the ${GPU_GROUP} group may hold a GPU, and this user can't open ${lock(denied)}. Root makes the owner its one member: ${gpuCommands('<name>').holder}; then log in again. Agent, test and coordinator users never can.`);
        return 2;
    }
    const missing = gpus.filter((g) => !existsSync(lock(g)));
    if (missing.length) {
        err(`gpu hold: no lock file for GPU ${missing.join(', ')} (${lock(missing[0])}): root's script makes one for each GPU it lists (${gpuCommands('<name>').status})`);
        return 2;
    }
    const stop = new AbortController();
    const onSignal = () => stop.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let held;
    try {
        held = await holdFlocksInOrder(gpus.map((g) => lock(g)), { signal: stop.signal, waiting: (path) => err(`gpu hold: waiting for ${path} (held by ${gpuHolder(path)})`) });
    }
    catch (e) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        err(`gpu hold: ${stop.signal.aborted ? 'stopped while waiting; nothing was run' : e.message}`);
        return stop.signal.aborted ? 130 : 2;
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    err(`gpu hold: holding GPU ${gpus.join(', ')}; running ${p.command[0]}`);
    try {
        return await new Promise((resolve) => {
            const child = spawn(p.command[0], p.command.slice(1), { stdio: 'inherit' });
            // The command gets what this process gets; the locks go only once it has ended.
            const pass = (sig) => () => child.kill(sig);
            const int = pass('SIGINT');
            const term = pass('SIGTERM');
            process.on('SIGINT', int);
            process.on('SIGTERM', term);
            const done = (code) => {
                process.off('SIGINT', int);
                process.off('SIGTERM', term);
                resolve(code);
            };
            child.on('error', (e) => {
                err(`gpu hold: can't run ${p.command[0]}: ${e.message}`);
                done(127);
            });
            child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGINT' ? 2 : 15) : 1)));
        });
    }
    finally {
        await held.release();
    }
}
//# sourceMappingURL=gpu-hold.js.map