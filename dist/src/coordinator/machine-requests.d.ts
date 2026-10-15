import type { EventLog } from '../events/log.js';
import type { Exec } from '../machine.js';
import { type MachineRequest } from '../machine-requests.js';
import { type SpawnHelper } from './add-project.js';
/** A claim older than this with no outcome is from a coordinator that stopped mid-run (the helper times out at 30 s). */
export declare const STALE_CLAIM_MS: number;
export interface MachineRequestDeps {
    log: EventLog;
    instance: string;
    /** How the helper is run (sudo -n); machine.ts's default when unset. */
    exec?: Exec;
    now?: () => number;
    /** The machine owners file; the system's when unset (tests). */
    ownersFile?: string;
    /** How a streamed command (add-project) starts; sudo -n by default (src/coordinator/add-project.ts). */
    spawn?: SpawnHelper;
    /** This user's home (where the dashboard stores a pasted secret); the process's own when unset (tests). */
    home?: string;
    /** How often a streamed command's ask is checked for its answer. */
    pollMs?: number;
}
/**
 * Why the person a request names may not change the machine; null when they may. Checked here as well as by the
 * dashboard: a request written to the log some other way, naming someone who isn't a machine owner, never runs.
 * One marked as the break-glass's is allowed, as the dashboard allows it.
 */
export declare function requesterRefusal(r: Pick<MachineRequest, 'by' | 'breakGlass'>, file?: string): string | null;
/** Run every pending machine request in this instance's log, once each. Returns how many ran. */
export declare function runMachineRequests(d: MachineRequestDeps): number;
