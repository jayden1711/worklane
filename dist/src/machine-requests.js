// Machine changes asked for from the dashboard, run by the coordinator.
//
// The dashboard runs hardened (its unit sets NoNewPrivileges), so it can't use sudo, and it doesn't try: a
// machine change from Settings, or a setup-console root step, is recorded here as a `machine.requested` event in
// the instance's log, after the dashboard's own checks (the owner's role, CSRF, the audit) and the helper's
// allowlist. The coordinator, whose unit allows sudo, takes each request on its next tick
// (src/coordinator/machine-requests.ts), checks it again against the same allowlist (so a request written
// some other way can't widen what runs), runs the machine helper, and records `machine.finished`. The
// dashboard shows each request as pending, running, then done or failed.
//
// Which coordinator acts: the one whose log holds the request, that is, the instance whose dashboard the
// owner used. Every coordinator user is in the helper's sudoers (machine-helper.sh lists them all), and the
// settings are machine-wide, so any one will do. A request lives in one log only, so no other coordinator sees
// it, and within that log `machine.started` is claimed in a write transaction, so it runs at most once.
import { randomBytes } from 'node:crypto';
import { checkRootStep } from './console/root-steps.js';
import { MACHINE_OWNERS_FILE, machineChangeRefusal } from './machine-owners.js';
import { addProjectNameOk, addProjectRepoOk } from './machine.js';
export const MACHINE_EVENTS = ['machine.requested', 'machine.started', 'machine.finished'];
export class MachineRequestError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
/** The helper arguments a Settings change maps to, or why it can't be one. */
export function settingArgs(what, value) {
    if (what === 'slots')
        return ['set-slots', String(value)];
    if (what === 'testSlots')
        return ['set-test-slots', String(value)];
    if (what === 'updates')
        return typeof value === 'boolean' ? ['set-updates', value ? 'on' : 'off'] : { error: 'updates is on (true) or off (false)' };
    return { error: 'what is slots, testSlots or updates' };
}
/** Why these helper arguments may not run (not on the allowlist); null when they may. */
export function machineRefusal(args) {
    if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string'))
        return 'not a machine helper command';
    const c = checkRootStep(args[0], args.slice(1));
    return c.allowed ? null : c.why;
}
/** The requests in these events, oldest first, each with its status. */
export function machineRequests(events) {
    const byId = new Map();
    for (const e of events) {
        if (e.type === 'machine.requested') {
            const p = e.payload;
            if (!byId.has(p.id))
                byId.set(p.id, { id: p.id, args: p.args, by: p.by, via: p.via, ask: p.ask, breakGlass: p.breakGlass === true, at: e.ts, status: 'pending', detail: '', finishedAt: null });
        }
        else if (e.type === 'machine.started') {
            const r = byId.get(e.payload.id);
            if (r && r.status === 'pending')
                r.status = 'running';
        }
        else if (e.type === 'machine.finished') {
            const p = e.payload;
            const r = byId.get(p.id);
            if (r && (r.status === 'pending' || r.status === 'running')) {
                r.status = p.outcome;
                r.detail = p.detail;
                r.finishedAt = e.ts;
            }
        }
    }
    return [...byId.values()];
}
const open = (r) => r.status === 'pending' || r.status === 'running';
/**
 * Record a machine change for the coordinator to run. The caller has checked the instance role (its owner); this
 * checks the requester is a machine owner on an allowed device, or the break-glass
 * (src/machine-owners.ts), the helper's allowlist, and that a root-step ask doesn't already have one pending.
 * Never runs anything.
 */
export function requestMachineChange(log, r) {
    const who = machineChangeRefusal(r.requester, { file: r.ownersFile ?? MACHINE_OWNERS_FILE });
    if (who)
        throw new MachineRequestError(who, 403);
    const why = machineRefusal(r.args);
    if (why)
        throw new MachineRequestError(why, 400);
    const by = r.requester.login;
    const id = `mr-${randomBytes(6).toString('hex')}`;
    log.db.exec('BEGIN IMMEDIATE');
    try {
        if (r.ask && machineRequests(log.read(0, [...MACHINE_EVENTS])).some((x) => x.ask === r.ask && open(x)))
            throw new MachineRequestError(`ask ${r.ask} already has a machine change waiting for the coordinator`, 409);
        log.append('machine.requested', { id, args: [...r.args], by, via: r.via, ask: r.ask ?? null, ...(r.requester.breakGlass ? { breakGlass: true } : {}) }, by, 'human');
        log.db.exec('COMMIT');
    }
    catch (e) {
        log.db.exec('ROLLBACK');
        throw e;
    }
    return machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.id === id);
}
/**
 * Record an add-project (the helper's `add-project <name> <owner/repo>`) for the coordinator to run: the same gate as
 * any machine change (requestMachineChange), with the name and the repo checked as strictly as the helper checks
 * them, and one at a time per instance's log.
 */
export function requestAddProject(log, r) {
    const who = machineChangeRefusal(r.requester, { file: r.ownersFile ?? MACHINE_OWNERS_FILE });
    if (who)
        throw new MachineRequestError(who, 403);
    if (!addProjectNameOk(r.name))
        throw new MachineRequestError("the project's name: lowercase letters, digits and dashes, starting with a letter, at most 21 (not dash, and not ending in -agent, -eval or -work)");
    if (!addProjectRepoOk(r.repo))
        throw new MachineRequestError('the repo: a GitHub owner/name');
    const open = machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.args[0] === 'add-project' && (x.status === 'pending' || x.status === 'running'));
    if (open)
        throw new MachineRequestError(`an add-project (${open.args[1]}) is already ${open.status}; wait for it to finish`, 409);
    return requestMachineChange(log, { args: ['add-project', r.name, r.repo], requester: r.requester, via: 'add-project', ...(r.ownersFile ? { ownersFile: r.ownersFile } : {}) });
}
//# sourceMappingURL=machine-requests.js.map