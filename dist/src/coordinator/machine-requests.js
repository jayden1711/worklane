import { checkRootStep } from '../console/root-steps.js';
import { PLUGIN_STEPS } from '../plugins/steps.js';
import { recordAnswer } from '../console/asks.js';
import { MACHINE_EVENTS, machineRefusal, machineRequests } from '../machine-requests.js';
import { isMachineOwner, MACHINE_OWNERS_FILE, machineOwners, ownersText } from '../machine-owners.js';
import { runAddProject, runningAddProjects } from './add-project.js';
/** A claim older than this with no outcome is from a coordinator that stopped mid-run (the helper times out at 30 s). */
export const STALE_CLAIM_MS = 5 * 60_000;
/**
 * Why the person a request names may not change the machine; null when they may. Checked here as well as by the
 * dashboard: a request written to the log some other way, naming someone who isn't a machine owner, never runs.
 * One marked as the break-glass's is allowed, as the dashboard allows it.
 */
export function requesterRefusal(r, file = MACHINE_OWNERS_FILE) {
    if (r.breakGlass)
        return null;
    return isMachineOwner(r.by, file) ? null : `@${r.by} isn't one of the machine's owners (machine owners: ${ownersText(machineOwners(file))}), so it wasn't run`;
}
/** Claim a pending request: append machine.started inside a write transaction, so of two takers only one wins. */
function claim(log, id, instance) {
    log.db.exec('BEGIN IMMEDIATE');
    try {
        const r = machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.id === id);
        if (!r || r.status !== 'pending') {
            log.db.exec('ROLLBACK');
            return false;
        }
        log.append('machine.started', { id, instance }, instance, 'coordinator');
        log.db.exec('COMMIT');
        return true;
    }
    catch (e) {
        log.db.exec('ROLLBACK');
        throw e;
    }
}
/** A root-step ask behind a request gets the outcome as its answer (once; a later answer would be refused anyway). */
function answerAsk(log, r, answer, detail) {
    if (!r.ask)
        return;
    try {
        recordAnswer(log, r.ask, { by: r.by, role: 'owner', answer, detail });
    }
    catch {
        // the ask was answered or withdrawn meanwhile: the request's own outcome is the record
    }
}
/** Run every pending machine request in this instance's log, once each. Returns how many ran. */
export function runMachineRequests(d) {
    const now = d.now ?? Date.now;
    let ran = 0;
    for (const r of machineRequests(d.log.read(0, [...MACHINE_EVENTS]))) {
        if (r.status === 'running') {
            const started = d.log.read(0, ['machine.started']).find((e) => e.payload.id === r.id);
            if (runningAddProjects.has(r.id))
                continue; // this process is running it now
            if (started && now() - Date.parse(started.ts) > STALE_CLAIM_MS)
                d.log.append('machine.finished', { id: r.id, outcome: 'interrupted', detail: 'the coordinator stopped before it finished; not run again (see the machine changes log for whether it applied)' }, d.instance, 'coordinator');
            continue;
        }
        if (r.status !== 'pending')
            continue;
        // One add-project at a time: a second waits, pending, until the first is over.
        if (r.args[0] === 'add-project' && runningAddProjects.size)
            continue;
        if (!claim(d.log, r.id, d.instance))
            continue;
        // Checked again here, whatever the dashboard checked: a request written any other way can't widen what runs.
        // Q13: a plugin step (via the Plugins page) is the instance owner's to ask for, and the dashboard checked that role;
        // it is for this instance alone and approves nothing. Every other machine change still needs a machine owner.
        const instanceStep = r.via === 'plugins' && PLUGIN_STEPS.includes(r.args[0] ?? '');
        const why = (instanceStep ? null : requesterRefusal(r, d.ownersFile)) ?? machineRefusal(r.args);
        if (why) {
            d.log.append('machine.finished', { id: r.id, outcome: 'refused', detail: why.slice(0, 1000) }, d.instance, 'coordinator');
            continue;
        }
        const c = checkRootStep(r.args[0], r.args.slice(1));
        if (!c.allowed)
            continue; // unreachable: machineRefusal checked the same
        if (c.rule.streams) {
            // Minutes long, with asks on the way: run alongside the ticks, each step relayed as it comes.
            const run = runAddProject({ log: d.log, instance: d.instance, ...(d.spawn ? { spawn: d.spawn } : {}), ...(d.home ? { home: d.home } : {}), ...(d.pollMs ? { pollMs: d.pollMs } : {}), ...(d.now ? { now: d.now } : {}) }, r).finally(() => runningAddProjects.delete(r.id));
            runningAddProjects.set(r.id, run);
            ran++;
            continue;
        }
        const out = c.rule.run(r.args.slice(1), d.exec);
        const detail = (out.ok ? out.output : out.error).slice(0, 1000);
        d.log.append('machine.finished', { id: r.id, outcome: out.ok ? 'done' : 'failed', detail }, d.instance, 'coordinator');
        answerAsk(d.log, r, out.ok ? 'ran' : 'failed', detail);
        ran++;
    }
    return ran;
}
//# sourceMappingURL=machine-requests.js.map