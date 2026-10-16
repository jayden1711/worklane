export type Direction = 'min' | 'max';
/** A job's kind: the baseline, a candidate (from an exploit, explore or combine session), or a stage-2 seed. */
export type EntryKind = 'baseline' | 'exploit' | 'explore' | 'combine' | 'seed';
export type Decision = 'running' | 'keep' | 'discard' | 'screened_out' | 'stage2' | 'ladder' | 'held' | 'winner' | 'seed' | 'crash' | 'refused' | 'stopped';
export declare const CANDIDATE: readonly EntryKind[];
export declare const isCandidate: (k: EntryKind) => boolean;
/** A candidate's stage-2 numbers at one size. */
export interface Stage2 {
    size: number;
    meanCandidate: number;
    meanBest: number;
    spread: number;
    seeds: number;
    minutesCandidate: number;
    minutesBest: number;
}
export interface Entry {
    n: number;
    kind: EntryKind;
    /** The entry it was built from (null: the study's own commit). */
    parent: number | null;
    /** A seed's candidate, and which arm it runs: the candidate's change, or the best it is measured against. */
    of?: number;
    arm?: 'candidate' | 'best';
    /** The best a candidate's stage 2 is measured against (set when it enters stage 2). */
    vs?: number;
    /** A combine session's winner (the change it puts on the best). */
    combines?: number;
    size: number;
    seed: number;
    result: number | null;
    /** What it counts as when it is the best: its stage-2 mean at the smallest size (the baseline: its result). */
    value?: number | null;
    /** Measured GPU minutes of this run (the budget it used). */
    minutes?: number | null;
    decision: Decision;
    stage2?: Stage2[];
    /** A held winner's fate if accepted: keep, or winner (to combine). */
    after?: 'keep' | 'winner';
}
export interface Metric {
    direction: Direction;
    min_delta: number;
    anomaly_margin: number;
}
export interface Plan {
    metric: Metric;
    screen: {
        margin: number;
        seeds: number;
    };
    sizes: number;
    exploration: {
        share: number;
        near_miss: number;
    };
}
/** How much `a` improves on `b` (positive is better), in the metric's direction. */
export declare const gain: (a: number, b: number, d: Direction) => number;
/** The current best: the latest entry kept (each one was proven better than the one before). */
export declare function best(entries: readonly Entry[]): {
    n: number;
    value: number;
} | null;
/** Stage 1: a candidate's one result against the best. */
export declare function screen(entries: readonly Entry[], result: number | null, p: Plan): {
    decision: 'crash' | 'screened_out' | 'stage2';
    why: string;
    vs?: number;
};
/** A candidate's seeds at one size, by arm. */
export declare function seedsOf(entries: readonly Entry[], c: number, size: number): {
    candidate: Entry[];
    best: Entry[];
};
/** The size a candidate in stage 2 (or on the ladder) is being measured at now. */
export declare const sizeNow: (c: Entry) => number;
/**
 * Stage 2 at one size, once every seed of both arms is in: better only when the candidate's mean beats the best's by
 * more than the spread (the larger arm's standard deviation) and min_delta. Then the next size, or a hold, or kept.
 */
export declare function judgeStage2(entries: readonly Entry[], c: Entry, p: Plan, flagged: boolean): {
    decision: Decision;
    why: string;
    stage2: Stage2;
    value?: number;
    after?: 'keep' | 'winner';
};
/** Whether the next session explores: exactly floor(share x sessions) of them do, counted, never drawn at random. */
export declare function shouldExplore(entries: readonly Entry[], share: number): boolean;
/** An explore session's parent: the newest near miss (screened out within near_miss of the best) not explored from yet. */
export declare function exploreParent(entries: readonly Entry[], p: Plan): number | null;
/** What the coordinator runs next. */
export type Next = {
    do: 'baseline';
} | {
    do: 'seed';
    of: number;
    arm: 'candidate' | 'best';
    source: number;
    size: number;
    seed: number;
} | {
    do: 'judge';
    of: number;
} | {
    do: 'session';
    kind: 'exploit' | 'explore' | 'combine';
    parent: number | null;
    combines?: number;
} | {
    do: 'wait';
    why: string;
};
export declare function nextStep(entries: readonly Entry[], p: Plan): Next;
/** One variable per hypothesis: the knobs it changed against its parent's config, and whether it changed code too. */
export declare function variablesChanged(config: Record<string, string | number>, parentConfig: Record<string, string | number>, codeChanged: boolean): string[];
