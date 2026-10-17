import type { StoredEvent } from '../events/types.js';
import type { IntakeConfig } from '../intake/report.js';
import { type RunAs } from '../runner.js';
import type { IncidentSink } from '../usage-limit.js';
/** The machine's disks to watch: the slot directory's and the instances', once per volume. */
export declare function machineDisks(paths?: string[]): {
    path: string;
    usedPct: number;
    freeGb: number;
}[];
/** The instances on this machine, by their homes' names. */
export declare function machineInstances(dir?: string): string[];
/** The auto-merge stop file in an instance's state dir, when there is one. */
export declare function readStop(stateDir: string): {
    reason: string;
    by: string | null;
} | null;
export declare function watchdogForInstance(o: {
    instance: string;
    stateDir: string;
    log: {
        read(after?: number): StoredEvent[];
    };
    env: NodeJS.ProcessEnv;
    /** The agent user, on the login its runs use now (a function: an account profile switch changes it). */
    runAs?: RunAs | (() => RunAs);
    tokens?: () => Promise<string>;
    intake?: () => IntakeConfig | null;
    discordTokenFile?: string;
    say?: (line: string) => void;
}): {
    stop: () => void;
};
/**
 * The incident sink a coordinator reports into (the usage-limit pause, src/usage-limit.ts): each incident is this
 * instance's, in the machine's store the watchdog posts from and the Health page lists. Never throws: a store that
 * can't be written leaves the pause to its own events and banner.
 */
export declare function incidentSink(instance: string, dir?: string): IncidentSink;
