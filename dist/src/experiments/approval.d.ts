import type { Study } from './study.js';
/**
 * The instance's threshold (owner, 2026-10-15): a job whose output quota (its loop-mounted volume, the disk it may
 * fill) is above 20 GB waits for an owner. Time needs none: root's max_minutes (20 to start) is a cap, not a threshold.
 */
export declare const APPROVE_DEFAULTS: {
    readonly above_gb: 20;
};
export type Thresholds = {
    above_gb: number;
};
/** What root's file allows this instance (src/experiments/root-file.ts reads it). */
export interface RootCaps {
    devices: number[];
    max_minutes: number;
    gpu_hours_per_day: number;
    output_gb: number;
    /** Approved data sources: id -> the sha256 root checked and who may read it. */
    sources: Record<string, {
        sha256: string;
        visibility: 'job' | 'scorer';
    }>;
}
export interface JobAsk {
    gpus: number;
    output_gb: number;
    /** The first job of a study version: a person sees the baseline run once. */
    first: boolean;
    lockfile: boolean;
}
/** Why an owner must approve this job (empty: it may start by itself). */
export declare function approvalReasons(j: JobAsk, t: Thresholds): string[];
/** Why a study can't run on this machine at all (root's caps and data sources), or null. */
export declare function rootRefusal(s: Study, root: RootCaps | null): string | null;
/** What the study has used today (the local day) and in all. */
export interface Used {
    gpu_hours_today: number;
    agent_usd_today: number;
    agent_usd_total: number;
    jobs: number;
}
/** Why the study can't start another session or job now (its budget), or null. A job is held if its cap could cross a line. */
export declare function budgetHold(s: Study, u: Used, instanceUsdLeft: number): string | null;
/** A session's budget: the least of the per-session cap, the study's day and total, and the instance's day. */
export declare function sessionBudgetUsd(s: Study, u: Used, instanceUsdLeft: number, perSession?: number): number;
