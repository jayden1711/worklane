import { type ReadOnlyQuery } from './bug-store.js';
import type { IncomingReport, IntakeConfig } from './report.js';
export type AlertsConfig = IntakeConfig['alerts'];
/** A plain SQL identifier (one part of a table name, or a column). Nothing that needs quoting is accepted. */
export declare const SQL_IDENT: RegExp;
/** The one fixed query: id, kind, message and created_at, newer than :after, oldest first, at most `batch` rows. */
export declare function alertsQuery(a: Pick<AlertsConfig, 'table' | 'columns' | 'batch'>): string;
interface State {
    after: string;
    /** Until the first pull that reaches the end of the table: kinds already there are learned, not reported. */
    baseline: boolean;
    /** Each kind seen, and when first. */
    kinds: Record<string, string>;
    /** Each kind's newest row times (ms), at most threshold + 1 of them. */
    recent: Record<string, number[]>;
    /** When each kind's last spike was reported (ms). */
    spiked: Record<string, number>;
    /** Reports made and not yet recorded by the coordinator. */
    pending: IncomingReport[];
}
export declare function readAlertsState(stateDir: string): State;
/**
 * One pull: rows newer than the cursor, turned into reports for new kinds and spikes, added to the pending ones, and
 * the state (cursor included) written in one go. Returns every pending report.
 */
export declare function pullAlerts(stateDir: string, cfg: AlertsConfig, run: ReadOnlyQuery, now?: () => Date): IncomingReport[];
/** Alerts as an intake source: pulled on each pass; a report leaves the pending list once the coordinator records it. */
export declare class AlertsIntake {
    private o;
    readonly name: "alerts";
    constructor(o: {
        stateDir: string;
        config: () => AlertsConfig;
        run: ReadOnlyQuery;
        now?: () => Date;
    });
    take(): Promise<IncomingReport[]>;
    ack(ids: string[]): Promise<void>;
    /** Alerts have no thread to reply into. */
    reply(): Promise<boolean>;
}
export {};
