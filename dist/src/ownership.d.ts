import type { Hold } from './hotspots.js';
/** INVARIANT: plan paths are compared repo-relative, without "./" and surrounding blanks. */
export declare const normFiles: (files: readonly string[]) => string[];
export declare class FileClaims {
    private claims;
    /** INVARIANT: a waiter waits on exactly one owner at a time; the edge is gone once it owns its files. */
    private waits;
    set(issue: number, files: readonly string[]): void;
    add(issue: number, files: readonly string[]): void;
    release(issue: number): void;
    files(issue: number): string[];
    /** WHY: the shape pickDispatch takes, so a dispatch hold and an in-task hold judge overlap the same way. */
    running(): {
        issue: number;
        hotspots: string[];
    }[];
    /** INVARIANT: a task never clashes with itself; null means every file in `files` is free. */
    clash(issue: number, files: readonly string[]): Hold | null;
    wait(issue: number, on: number): void;
    unwait(issue: number): void;
    /** INVARIANT: only a cycle through `issue` counts; one further along is found by its own members. */
    cycle(issue: number): number[] | null;
    /** WHY: a claim outliving its task would hold every overlapping task forever; each one is dropped and returned for the report. */
    dropStale(live: (issue: number) => boolean): {
        issue: number;
        files: string[];
    }[];
}
