export declare const WATCHDOG_CONFIG: string;
export interface WatchdogConfig {
    stallHours: number;
    diskPct: number;
    opsChannel: string | null;
    dashboardUrl: string | null;
    /** The free-disk floor before a test run or agent run starts: the larger of these GiB and this % of the filesystem. */
    minFreeGb: number;
    minFreePct: number;
}
/** The settings in effect: the file's valid fields over the defaults. */
export declare function watchdogConfig(path?: string): WatchdogConfig;
