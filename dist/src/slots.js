// Machine-wide slots, shared by every agent harness on the machine through
// a tiny file protocol (docs/slots.md):
//   <dir>/config.json        {"max_agents": N}   the machine cap, set once per box
//   <dir>/agent-<i>.lock     one per running agent, i < max_agents
//   <dir>/full-run.lock      at most one full test run on the machine
// A lock file holds {pid, owner, acquiredAt}; a dead pid means the slot is free.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, tryLock } from './locks.js';
import { pidAlive, slotsDir } from './os/index.js';
export const DEFAULT_MAX_AGENTS = 2;
export function machineCap(dir = slotsDir()) {
    try {
        const n = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).max_agents;
        return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_AGENTS;
    }
    catch {
        return DEFAULT_MAX_AGENTS;
    }
}
/** Take a free agent slot, or null if the machine is at its cap. */
export function tryAgentSlot(owner, dir = slotsDir()) {
    const cap = machineCap(dir);
    for (let i = 0; i < cap; i++) {
        const r = tryLock(join(dir, `agent-${i}.lock`), owner);
        if ('lock' in r)
            return r.lock;
    }
    return null;
}
export function fullRunLock(owner, waitMs, dir = slotsDir()) {
    return acquireLock(join(dir, 'full-run.lock'), owner, waitMs, 1000);
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
//# sourceMappingURL=slots.js.map