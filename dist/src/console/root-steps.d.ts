import type { EventLog } from '../events/log.js';
import { type Ask, type Role } from './asks.js';
import { type MachineRequest } from '../machine-requests.js';
import type { MachineRequester } from '../machine-owners.js';
import { type Exec, type MachineResult } from '../machine.js';
export interface RootStepRule {
    command: string;
    /** What it does, for the console. */
    what: string;
    /** The arguments it takes, for the console. */
    usage: string;
    /** Whether these exact arguments are on the helper's sudoers list. */
    allows: (args: string[]) => boolean;
    run: (args: string[], exec?: Exec) => MachineResult;
    /** Long-running, with progress: the coordinator streams it instead of calling run. */
    streams?: boolean;
}
/**
 * The slot ceiling, read when asked: machine.ts's SLOTS_MAX, a constant now and a function once the ceiling is
 * read from the machine's config (#212). Either form works, so the bounds are never a copy.
 */
export declare function slotCeiling(): number;
/**
 * An account profile step (src/claude-profiles.ts), as the helper and its sudoers patterns take it: profile-add|remove
 * <profile> (never default), use <profile>. Each is for the asking coordinator's own instance.
 */
export declare function profileStepOk(a: readonly string[]): boolean;
/** The helper's allowlist, as its sudoers rule spells it out: set-slots SLOTS_MIN..slotCeiling(), set-updates on|off, set-test-slots 1..8, claude-account status|switch, tailscale install|up|serve|public-url, add-project <name> <owner/repo>, and the updater's setup: install-updater, set-update-channel release, stage-update-signer and discard-update-signer <principal> ssh-ed25519 <public key>. Nothing else: nothing here adds a release signer or follows main. */
export declare const ROOT_STEPS: readonly RootStepRule[];
export type RootStepCheck = {
    allowed: true;
    rule: RootStepRule;
} | {
    allowed: false;
    why: string;
};
/** Whether a root step is on the helper's allowlist; when not, why, and what it would take. */
export declare function checkRootStep(command: string, args: readonly string[]): RootStepCheck;
/**
 * Ask the coordinator to run an open, allowlisted root_step ask through the helper (src/machine-requests.ts):
 * the dashboard can't sudo, and never tries. The instance's owner only, and a machine owner on
 * an allowed device (or the break-glass; src/machine-owners.ts). One off the allowlist is refused here, and again by
 * the coordinator. The coordinator answers the ask (ran or failed, with the output) once it has run.
 */
export declare function requestRootStep(log: EventLog, id: string, a: {
    by: string;
    role: Role | null;
    requester: MachineRequester;
    ownersFile?: string;
}): {
    ask: Ask;
    request: MachineRequest;
};
