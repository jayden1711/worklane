/** Every reason dispatch holds (src/coordinator.ts, src/coordinator/fix-runs.ts, src/coordinator/base.ts governorHold). */
export declare const HOLD_KINDS: readonly ["disk", "disk_full", "load", "budget", "slots", "update_drain", "usage_limit", "sign_in", "run_window"];
export type HoldKind = (typeof HOLD_KINDS)[number];
/** The numbers behind a hold, as recorded when it began (each kind fills its own). */
export interface HoldFacts {
    free_gb?: number;
    total_gb?: number;
    floor_gb?: number;
    floor_min_gb?: number;
    floor_pct?: number;
    est_gb?: number;
    load?: number;
    max_load?: number;
    spent_usd?: number;
    budget_usd?: number;
    /** When it ends on its own (ISO): the usage limit's reset, the next run window, the budget's next day (local midnight). */
    until?: string;
    cap?: number;
    running?: number;
    windows?: string;
}
/** A hold as the coordinator records it. */
export interface Hold {
    kind: HoldKind;
    reason: string;
    load: number | null;
    freeDiskPct: number | null;
    facts?: HoldFacts;
}
export interface FloorSettings {
    min_free_disk_gb: number;
    min_free_disk_pct: number;
}
/** The free GB a disk of `totalGb` must keep: the larger of the absolute floor and the share. */
export declare function diskFloorGb(totalGb: number, g: FloorSettings): number;
export interface DiskRoom {
    freeGb: number;
    totalGb: number;
    freePct: number;
    floorGb: number;
    estGb: number;
    /** Free GB once another worktree of `estGb` is made. */
    afterGb: number;
    /** GB to free so another worktree fits above the floor (0 when it already does). */
    shortGb: number;
    /** INVARIANT: true exactly when another worktree would leave less than the floor free. */
    held: boolean;
}
/** The disk's room for another worktree under the floor. */
export declare function diskRoom(disk: {
    freeGb: number;
    totalGb: number;
}, g: FloorSettings, estGb: number): DiskRoom;
/** A size in GB as people read it: whole GB from 10 up, one decimal below. */
export declare const gbText: (n: number) => string;
/** The floor's rule in words: "23 GB (the larger of 10 GB and 5% of the disk)". */
export declare function floorText(floorGb: number, g: FloorSettings): string;
/** The disk's numbers: "46 GB free of 460 GB (10%); the floor is 23 GB (…); one more worktree needs ~1 GB". */
export declare function diskNumbers(r: DiskRoom, g: FloorSettings): string;
/** GB to free, rounded up to a whole GB (never 0 when something must be freed). */
export declare const toFree: (shortGb: number) => number;
/** The disk hold's reason (the coordinator's log line and the event's `reason`). */
export declare function diskHoldReason(r: DiskRoom): string;
/** The hold for a disk without room, with its numbers; null when another worktree fits. */
export declare function diskHold(r: DiskRoom, g: FloorSettings, load: number | null): Hold | null;
/** The next start of a run window after `now` (local time, as inRunWindow reads them); null without windows. */
export declare function nextRunWindowStart(windows: {
    from: string;
    to: string;
}[], now: Date): Date | null;
/** What the Board and First run show while a hold is in force. */
export interface HoldBanner {
    kind: HoldKind | 'other';
    /** The reason in plain words. */
    title: string;
    /** The numbers behind it, or null when the hold has none. */
    numbers: string | null;
    /** When it ends on its own (ISO), shown in the reader's local time as "wait until …"; null when it doesn't. */
    wait: string | null;
    /** What to do (after the wait, when there is one); null for a viewer. */
    fix: string | null;
    /** The page where it is changed; null for a viewer and when none. */
    link: {
        path: string;
        label: string;
    } | null;
    /** When the hold began. */
    since: string;
}
/**
 * The banner for a recorded hold. A hold recorded before kinds existed shows its reason only. The fix names a figure
 * from the numbers (the GB to free), never a guess.
 */
export declare function holdBanner(h: {
    kind?: string | undefined;
    reason: string;
    facts?: HoldFacts | undefined;
}, since: string): HoldBanner;
/** The banner as a viewer may have it: why work is held, never the way to change it (no fix, no link). */
export declare function bannerForViewer(b: HoldBanner): HoldBanner;
/** doctor's and First run's disk check: warn when free disk is under the floor, or would be after one more worktree. */
export declare function diskFloorCheck(disk: {
    freeGb: number;
    totalGb: number;
}, g: FloorSettings, estGb: number): {
    level: 'ok' | 'warn';
    detail: string;
    room: DiskRoom;
};
