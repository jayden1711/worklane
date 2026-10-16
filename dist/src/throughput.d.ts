interface Ev {
    type: string;
    ts: string;
    payload: unknown;
}
/** Where a run's cost goes. Gardener has no runs yet; it shows as zero rather than missing. */
export declare const STAGES: readonly ["worker", "evaluator", "plan", "research", "intake", "gardener", "chat", "retries", "other"];
export type Stage = (typeof STAGES)[number];
/** A run.cost role's stage. A worker's later attempts, and fix runs after a failed check or a conflict, are retries. */
export declare function stageOf(role: string, attempt?: number): Stage;
export interface Wait {
    kind: string;
    label: string;
    /** Whether the owner's action ends the wait (a hotspot hold ends on its own). */
    owner: boolean;
    count: number;
    /** Still waiting now. */
    open: number;
    medianHours: number | null;
    totalHours: number;
    /** The commonest reasons or questions, most first. */
    reasons: {
        reason: string;
        count: number;
    }[];
}
export interface Throughput {
    since: string;
    until: string;
    merged: {
        total: number;
        perDay: {
            day: string;
            merged: number;
        }[];
        perWeek: {
            week: string;
            merged: number;
        }[];
    };
    cost: {
        totalUsd: number;
        perMergedPrUsd: number | null;
        byStage: {
            stage: Stage;
            usd: number;
            perMergedPrUsd: number | null;
            share: number;
        }[];
        /**
         * The same spend by model, most first: haiku, sonnet or opus; an open-model provider by name (`local`,
         * `hosted:<name>`, whose cost is its own price, $0 for local); or the id of a model of no known tier. With the
         * tokens and run time behind it, where claude reported them.
         */
        byModel: {
            model: string;
            usd: number;
            perMergedPrUsd: number | null;
            share: number;
            tokensIn: number;
            tokensOut: number;
            secs: number;
            perMergedPrTokens: number | null;
        }[];
        /** Evaluator spend on PRs whose review level was L0. */
        evaluatorOnL0Usd: number;
    };
    waits: Wait[];
    top: {
        stage: Stage;
        usd: number;
        share: number;
        suggestion: string;
    }[];
}
/** The suggested tuning for a stage's cost: fixed rules, with this week's numbers in them. */
export declare function suggestionFor(stage: Stage, t: Pick<Throughput, 'cost'> & {
    merged: {
        total: number;
    };
}): string;
/** Throughput over `days` (7) up to `now`, with merges per day over the last 14 days and per week over the last 8. */
export declare function throughput(events: Ev[], o?: {
    now?: Date;
    days?: number;
}): Throughput;
/** The weekly report's throughput section. */
export declare function throughputMarkdown(t: Throughput): string[];
export {};
