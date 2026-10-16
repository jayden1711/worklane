import type { Role } from '../dashboard-auth.js';
import type { EventLog } from '../events/log.js';
import type { StoredEvent } from '../events/types.js';
import { type RootState } from './root-file.js';
export declare const EXP_ACTIONS: readonly ["start", "pause", "resume", "stop_job", "approve", "decline", "archive"];
export type ExpAction = (typeof EXP_ACTIONS)[number];
/** INVARIANT: the one rule for who may do what. */
export declare function mayDoExp(action: ExpAction, role: Role | null | undefined): boolean;
export declare class ExperimentsError extends Error {
}
export interface ExpSite {
    /** The coordinator's checkout: studies are read from its default branch's tip, as fetched. */
    repo: string;
    branch: string;
    instance: string;
    pinsFile: string;
    root?: () => RootState;
}
/** The page's data: the machine's setup, each study (started or not), and this person's actions. */
export declare function experimentsView(o: {
    site: ExpSite;
    events: StoredEvent[];
    role: Role;
    now: Date;
}): {
    setup: {
        state: "off" | "unknown" | "on";
        why: string | null;
        commands: {
            install: string;
            set: string;
            hash: string;
            add: string;
        };
        devices: number[];
    };
    error: string | null;
    actions: ("pause" | "resume" | "approve" | "start" | "decline" | "stop_job" | "archive")[];
    approve: {
        above_gb: number;
    } | null;
    studies: ({
        started: false;
        startRefused: string | null;
        id: string;
        goal: string;
        kind: "supervised" | "self_supervised" | "unsupervised" | "generative" | "rl_rollout";
        metric: {
            name: string;
            direction: "max" | "min";
            min_delta: number;
            source: "score" | "train_ms" | "predict_ms";
            anomaly_margin: number;
        };
        job: {
            max_minutes: number;
            gpus: number;
            output_gb: number;
        };
        budget: {
            gpu_hours_per_day: number;
            agent_usd_per_day: number;
            agent_usd_total: number;
            max_jobs: number;
        };
        exploration: {
            share: number;
            near_miss: number;
        };
        screen: {
            margin: number;
            seeds: number;
        };
        ladder: string[];
        editable: string[];
    } | {
        started: true;
        version: string;
        startedBy: string;
        phase: import("./state.js").Phase;
        paused: boolean;
        archived: boolean;
        broken: boolean;
        hold: string | null;
        best: {
            n: number;
            value: number;
        } | null;
        baseline: {
            n: number;
            value: number | null;
        } | null;
        current: {
            n: number;
            job: string | null;
            kind: import("./keep.js").EntryKind;
            hypothesis: string;
            approval: string[];
            since: string;
        } | null;
        held: {
            n: number;
            hypothesis: string;
            variable: string;
            why: string;
            commit: string | null;
            files: string[];
            stage2: {
                meanCandidate: number | null;
                meanBest: number | null;
                spread: number | null;
                size: number;
                seeds: number;
                minutesCandidate: number;
                minutesBest: number;
            }[];
            monitor: {
                flagged: boolean;
                findings: string[];
            } | null;
        } | null;
        spend: {
            agentToday: number;
            agentPerDay: number;
            agentTotal: number;
            agentAll: number;
            gpuHoursToday: number;
            gpuHoursPerDay: number;
            jobs: number;
            maxJobs: number;
        };
        counts: {
            jobs: number;
            kept: number;
            explore: number;
            crash: number;
            screened: number;
        };
        points: {
            n: number;
            value: number | null;
            kept: boolean;
        }[];
        log: {
            decision: string;
            n: number;
            kind: import("./keep.js").EntryKind;
            at: string;
            hypothesis: string;
            variable: string;
            motivation: string;
            change: {
                commit: string | null;
                files: string[];
            };
            config: Record<string, string | number>;
            minutes: number | null;
            waited_s: number | null;
            result: number | null;
            why: string;
            step: string | null;
            parent: number | null;
            stage: number;
            stage2: {
                meanCandidate: number | null;
                meanBest: number | null;
                spread: number | null;
                size: number;
                seeds: number;
                minutesCandidate: number;
                minutesBest: number;
            }[];
            seeds: number;
        }[];
        id: string;
        goal: string;
        kind: "supervised" | "self_supervised" | "unsupervised" | "generative" | "rl_rollout";
        metric: {
            name: string;
            direction: "max" | "min";
            min_delta: number;
            source: "score" | "train_ms" | "predict_ms";
            anomaly_margin: number;
        };
        job: {
            max_minutes: number;
            gpus: number;
            output_gb: number;
        };
        budget: {
            gpu_hours_per_day: number;
            agent_usd_per_day: number;
            agent_usd_total: number;
            max_jobs: number;
        };
        exploration: {
            share: number;
            near_miss: number;
        };
        screen: {
            margin: number;
            seeds: number;
        };
        ladder: string[];
        editable: string[];
    })[];
};
export interface ExpChange {
    action: ExpAction;
    study: string;
}
/** What a change would do, in plain words, and the digest a confirm must carry. Writes nothing. */
export declare function planExperiment(o: {
    site: ExpSite;
    events: StoredEvent[];
    req: ExpChange;
    by: string;
    now: Date;
}): {
    summary: string[];
    changes: string[];
    digest: string;
};
/** Carry out a change the person reviewed: planned again now, refused if anything moved since (the digest). */
export declare function applyExperiment(o: {
    site: ExpSite;
    events: StoredEvent[];
    req: ExpChange;
    digest: string;
    by: string;
    role: Role;
    now: Date;
    log: EventLog;
}): {
    summary: string[];
    changes: string[];
};
