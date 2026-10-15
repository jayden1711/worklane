import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import type { MainWatchApi } from './main-watch.js';
export type Protection = Pick<MainWatchApi, 'protection'>;
/** Whether `remote` in `repo` is a path on this machine (or file://), not a host that could protect a branch. */
export declare function localRemote(repo: string, remote: string): boolean;
/**
 * Why a direct land may not push `branch` of `repo`, or null when GitHub enforces its protection. Never throws: a
 * check that fails (an error, the network down) is a refusal that says the protection couldn't be checked.
 */
export declare function directLandRefusal(api: Protection | undefined, o: {
    repo: string;
    branch: string;
    local: boolean;
}): Promise<string | null>;
/** The kind of the coordinator.error a refused direct land records (at start-up, and at a land): health shows it. */
export declare const DIRECT_LAND_REFUSED = "direct_land_refused";
/**
 * At start-up, before anything else runs: with land_mode direct, refuse to start unless the default branch is
 * protected. The refusal is recorded (coordinator.error, where start-up) so health and the dashboard show it, and
 * returned to be printed; null: start.
 */
export declare function directLandStartGate(o: {
    landMode: 'direct' | 'pr';
    api: Protection | undefined;
    local: boolean;
    repo: string;
    branch: string;
    label: string;
    log: EventLog;
    actor: string;
}): Promise<string | null>;
/**
 * A refused direct land not since cleared (by a coordinator that started, or a land that pushed): its message, for
 * health to say first. Null when there is none.
 */
export declare function directLandProblem(events: readonly StoredEvent[]): string | null;
