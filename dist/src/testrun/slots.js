// Test-run slots: how many test runs go at once on the machine, across every instance. They are lease files in the
// machine's slot directory (docs/slots.md), `test-<i>.lock`, beside the agents' and counted apart from them; the cap
// is slots.json `max_test_runs`, a machine setting changed only through the machine helper (set-test-slots).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock } from '../locks.js';
import { TEST_SLOTS_MAX, TEST_SLOTS_MIN } from '../machine.js';
import { pidAlive, slotsConfigPath, slotsDir } from '../os/index.js';
import { updateDrain } from '../update-drain.js';
export { TEST_SLOTS_MAX, TEST_SLOTS_MIN };
/** Without a setting: two runs, the recommendation for a 24-core, 30 GB machine with three instances and six agents. */
export const DEFAULT_TEST_SLOTS = 2;
const INDEX_LIMIT = 32;
export function testSlotCap(dir = slotsDir()) {
    try {
        const n = JSON.parse(readFileSync(slotsConfigPath(dir), 'utf8')).max_test_runs;
        return typeof n === 'number' && Number.isInteger(n) && n >= TEST_SLOTS_MIN && n <= TEST_SLOTS_MAX ? n : DEFAULT_TEST_SLOTS;
    }
    catch {
        return DEFAULT_TEST_SLOTS;
    }
}
/** The live test-run slots (dead holders don't count). */
export function testSlotsHeld(dir = slotsDir()) {
    let files = [];
    try {
        files = readdirSync(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const f of files) {
        if (!/^test-\d+\.lock$/.test(f))
            continue;
        try {
            const info = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            if (pidAlive(info.pid))
                out.push({ ...info, slot: f.replace('.lock', '') });
        }
        catch {
            // released in between
        }
    }
    return out;
}
/**
 * Take a test slot if fewer than the cap are held and the engine updater isn't draining the machine (src/update-drain.ts),
 * counting and taking under the slot directory's lock. `limitMs`: the longest the run can take holding it, recorded in
 * the slot for the updater's drain to say when the machine will be quiet.
 */
export function tryTestSlot(owner, dir = slotsDir(), limitMs) {
    const guard = tryLock(join(dir, 'slots.lock'), owner);
    if (!('lock' in guard))
        return null;
    try {
        // INVARIANT: read under the slot directory's lock, so a drain the updater has written is never raced by a new run.
        if (updateDrain(dir))
            return null;
        if (testSlotsHeld(dir).length >= testSlotCap(dir))
            return null;
        for (let i = 0; i < INDEX_LIMIT; i++) {
            const r = tryLock(join(dir, `test-${i}.lock`), owner, {}, limitMs !== undefined && Number.isFinite(limitMs) && limitMs > 0 ? { limit_ms: Math.round(limitMs) } : {});
            if ('lock' in r)
                return r.lock;
        }
        return null;
    }
    finally {
        guard.lock.release();
    }
}
/** Wait for a test slot (and for any update drain to end), however long it takes; rejects only when `signal` aborts. */
export async function waitTestSlot(owner, o = {}) {
    for (;;) {
        if (o.signal?.aborted)
            throw new Error('cancelled while waiting for a test slot');
        const s = tryTestSlot(owner, o.dir, o.limitMs);
        if (s)
            return s;
        await new Promise((res) => setTimeout(res, o.pollMs ?? 2000));
    }
}
/**
 * The test slots this machine can afford: the cores left after the agents, and the memory left after the
 * instances' caps, each divided by what one run takes; the smaller, within 1..TEST_SLOTS_MAX.
 */
export function recommendTestSlots(c) {
    const reserve = c.reserve ?? { cores: 2, memGb: 2 };
    const freeCores = c.cores - c.agentSlots * (c.agentCores ?? 2) - reserve.cores;
    const freeMemGb = c.memGb - c.instanceCapsGb.reduce((a, b) => a + b, 0) - reserve.memGb;
    const byCpu = Math.floor(freeCores / c.perRun.cores);
    const byMemory = Math.floor(freeMemGb / c.perRun.memGb);
    return { slots: Math.max(TEST_SLOTS_MIN, Math.min(TEST_SLOTS_MAX, byCpu, byMemory)), byCpu, byMemory, freeCores, freeMemGb };
}
//# sourceMappingURL=slots.js.map