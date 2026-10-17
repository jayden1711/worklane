// Machine-wide slots, shared by every agent harness on the machine through
// a tiny file protocol (docs/slots.md):
//   <config>                 {"max_agents": N}   the machine cap, set once per box
//                            (/etc/<cli>/slots.json with the system slot dir, else <dir>/config.json)
//   <dir>/slots.lock         held briefly while counting and taking a slot
//   <dir>/agent-<i>.lock     one per running agent; the count, not the index, is capped
//   <dir>/full-run.lock      at most one full test run on the machine
//   <dir>/STOP               emergency stop: while it exists, every agent halts and no new one starts
// A lock file holds {pid, owner, acquiredAt}; a dead pid means the slot is free.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock } from './locks.js';
import { pidAlive, slotsConfigPath, slotsDir } from './os/index.js';
import { drainHoldLine, updateDrain } from './update-drain.js';
export const DEFAULT_MAX_AGENTS = 2;
export function machineCap(dir = slotsDir()) {
    try {
        const n = JSON.parse(readFileSync(slotsConfigPath(dir), 'utf8')).max_agents;
        return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_AGENTS;
    }
    catch {
        return DEFAULT_MAX_AGENTS;
    }
}
/** Slot files may be numbered past the cap: lowering it must never strand an agent that is still running. */
const SLOT_INDEX_LIMIT = 64;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * Take an agent slot if fewer than the cap are running, machine-wide, across
 * every instance and harness. Counting and taking happen under one directory
 * lock, so two processes can't both see room for the last slot.
 */
export function tryAgentSlot(owner, dir = slotsDir()) {
    if (emergencyStop(dir))
        return null;
    let guard = null;
    for (let i = 0; i < 200 && !guard; i++) {
        const r = tryLock(join(dir, 'slots.lock'), owner);
        if ('lock' in r)
            guard = r.lock;
        else
            pause(10);
    }
    if (!guard)
        return null; // busy for 2s: treat as full and try again next tick
    try {
        // INVARIANT: no new agent while the updater drains the machine (src/update-drain.ts): an install restarts every
        // coordinator, which would end an agent's session, so the install waits for none to be running. Read under the lock.
        if (updateDrain(dir))
            return null;
        if (slotStatus(dir).agents.length >= machineCap(dir))
            return null;
        for (let i = 0; i < SLOT_INDEX_LIMIT; i++) {
            const r = tryLock(join(dir, `agent-${i}.lock`), owner);
            if ('lock' in r)
                return r.lock;
        }
        return null;
    }
    finally {
        guard.release();
    }
}
/**
 * Take the machine's full-run lock, waiting up to waitMs. Never while the updater drains the machine
 * (src/update-drain.ts): the drain is checked before every try, and a wait that ends inside one says so as its holder.
 */
export async function fullRunLock(owner, waitMs, dir = slotsDir(), pollMs = 1000) {
    const path = join(dir, 'full-run.lock');
    const deadline = Date.now() + waitMs;
    for (;;) {
        const drain = updateDrain(dir);
        const r = drain ? { holder: { pid: 0, owner: drainHoldLine(drain), acquiredAt: drain.since } } : tryLock(path, owner);
        if ('lock' in r || Date.now() >= deadline)
            return r;
        await new Promise((res) => setTimeout(res, Math.max(1, Math.min(pollMs, deadline - Date.now()))));
    }
}
/** Live holders only; stale files (dead pids) don't count. */
export function slotStatus(dir = slotsDir()) {
    const read = (f) => {
        try {
            const info = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            return pidAlive(info.pid) ? info : null;
        }
        catch {
            return null;
        }
    };
    let files = [];
    try {
        files = readdirSync(dir);
    }
    catch {
        // no slots dir yet: nothing held
    }
    const agents = files
        .filter((f) => /^agent-\d+\.lock$/.test(f))
        .map((f) => ({ f, info: read(f) }))
        .filter((x) => !!x.info)
        .map(({ f, info }) => ({ ...info, slot: f.replace('.lock', '') }));
    return { cap: machineCap(dir), agents, fullRun: files.includes('full-run.lock') ? read('full-run.lock') : null };
}
/** The emergency stop in force on this machine, if any. */
export function emergencyStop(dir = slotsDir()) {
    try {
        return JSON.parse(readFileSync(join(dir, 'STOP'), 'utf8'));
    }
    catch (e) {
        // Present but unreadable still means stop.
        return e.code === 'ENOENT' ? null : { by: '?', at: '', reason: 'unreadable STOP file' };
    }
}
/** Halt every agent on the machine, across instances and harnesses, until resumed. */
export function stopAll(by, reason, dir = slotsDir()) {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.STOP.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ by, at: new Date().toISOString(), reason }));
    renameSync(tmp, join(dir, 'STOP'));
}
export function resumeAll(dir = slotsDir()) {
    try {
        rmSync(join(dir, 'STOP'));
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=slots.js.map