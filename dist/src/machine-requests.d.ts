import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import { type MachineRequester } from './machine-owners.js';
export declare const MACHINE_EVENTS: readonly ["machine.requested", "machine.started", "machine.finished"];
export type MachineRequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'refused' | 'interrupted';
export interface MachineRequest {
    id: string;
    /** The helper's arguments: set-slots <n>, set-updates on|off, set-test-slots <n>, add-project <name> <owner/repo>, claude-account status|switch, tailscale install|up|serve|public-url. */
    args: string[];
    by: string;
    via: 'settings' | 'ask' | 'add-project' | 'claude-account' | 'tailscale' | 'plugins';
    ask: string | null;
    /** Asked for on the owner's break-glass (no person named), which needs no machine owner. */
    breakGlass: boolean;
    at: string;
    status: MachineRequestStatus;
    /** The helper's output, or why it failed or was refused. */
    detail: string;
    finishedAt: string | null;
}
export declare class MachineRequestError extends Error {
    readonly status: 400 | 403 | 409;
    constructor(message: string, status?: 400 | 403 | 409);
}
/** The helper arguments a Settings change maps to, or why it can't be one. */
export declare function settingArgs(what: unknown, value: unknown): string[] | {
    error: string;
};
/** Why these helper arguments may not run (not on the allowlist); null when they may. */
export declare function machineRefusal(args: readonly string[]): string | null;
/** The requests in these events, oldest first, each with its status. */
export declare function machineRequests(events: readonly StoredEvent[]): MachineRequest[];
/**
 * Record a machine change for the coordinator to run. The caller has checked the instance role (its owner); this
 * checks the requester is a machine owner on an allowed device, or the break-glass
 * (src/machine-owners.ts), the helper's allowlist, and that a root-step ask doesn't already have one pending.
 * Never runs anything.
 */
export declare function requestMachineChange(log: EventLog, r: {
    args: string[];
    requester: MachineRequester;
    via: MachineRequest['via'];
    ask?: string | null;
    ownersFile?: string;
}): MachineRequest;
/**
 * Record an add-project (the helper's `add-project <name> <owner/repo>`) for the coordinator to run: the same gate as
 * any machine change (requestMachineChange), with the name and the repo checked as strictly as the helper checks
 * them, and one at a time per instance's log.
 */
export declare function requestAddProject(log: EventLog, r: {
    name: unknown;
    repo: unknown;
    requester: MachineRequester;
    ownersFile?: string;
}): MachineRequest;
/**
 * Record a plugin or MCP step (src/plugins/steps.ts) for the coordinator to run. Q13: the instance's owner may ask for
 * one (the caller checked the role and CSRF): unlike a machine-wide change, no machine owner or console device is
 * needed, because each step is for this instance alone (the helper takes it from sudo) and none approves anything (a
 * root admin confirms at a root shell). The helper's allowlist is checked here, and again by the coordinator.
 */
export declare function requestPluginStep(log: EventLog, r: {
    args: string[];
    by: string;
    breakGlass: boolean;
}): MachineRequest;
