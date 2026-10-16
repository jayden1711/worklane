import type { EventLog } from './events/log.js';
import { type Exec } from './machine.js';
import { FAILOVER_INCIDENT, type IncidentSink } from './usage-limit.js';
export { FAILOVER_INCIDENT };
/** A move asked for with no answer after this long is given up (the step's unit never ran, or never ended). */
export declare const FAILOVER_ANSWER_MS: number;
/** A move back that was refused is asked again after this long. */
export declare const FAILOVER_RETRY_MS: number;
export type FailoverStage = 'asked' | 'switched' | 'refused' | 'none' | 'back-asked' | 'back' | 'back-refused';
export interface FailoverDeps {
    log: EventLog;
    instance: string;
    /** The claude-account dir (profiles.json, profile-ops.jsonl); the machine's when unset. */
    dir?: string;
    now?: () => number;
    /** How the helper is run (sudo -n); machine.ts's default when unset. */
    exec?: Exec;
    incidents?: IncidentSink;
}
/** One pass of the failover for this instance. Returns what it did, for the record and the tests. */
export declare function failoverStep(d: FailoverDeps): FailoverStage | null;
