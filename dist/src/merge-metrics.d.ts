/**
 * The events these read (their shapes, as recorded):
 *   conflict_fix.detected  { issue, number, head, base_sha }
 *   conflict_fix.started   { issue, number, head, base_sha, strategy, attempt, lease }
 *   conflict_fix.finished  { issue, number, base_sha, strategy, outcome: 'pushed'|'no_push'|'gave_up'|'interrupted', head, files, waits_owner, reasons, detail }
 *   light_check.finished   { issue, number, head, main_sha, overlap, outcome: 'merge'|'conflict'|'hold', wait_ms }
 *   hotspot.held           { issue, by, files }
 *   hotspot.released       { issue, waited_ms, files }
 *   pr.closed              { issue, number, merged }      (existing: a PR merged, by anyone)
 */
export interface MetricEvent {
    ts: string;
    type: string;
    payload: unknown;
}
export interface MergeMetrics {
    since: string;
    mergedPrs: number;
    conflicts: {
        count: number;
        needOwner: number;
        minutesToMerged: number[];
        medianMinutes: number | null;
        perMergedPr: number;
    };
    lightChecks: {
        count: number;
        minutesAdded: number;
        perMergedPr: number;
        outcomes: Record<string, number>;
    };
    holds: {
        count: number;
        minutesWaited: number;
        perMergedPr: number;
        byFile: {
            file: string;
            minutes: number;
            count: number;
        }[];
    };
    /** One line per measure that costs more than `thresholdMinutes` per merged PR, with a suggested tuning. */
    flags: string[];
}
/** "A few minutes": above this many added minutes per merged PR, a measure is flagged. */
export declare const FLAG_MINUTES = 3;
export declare function mergeMetrics(events: MetricEvent[], o: {
    since: Date;
    thresholdMinutes?: number;
}): MergeMetrics;
/** The risk areas the trust numbers are broken down by, riskiest first. */
export declare const RISK_AREAS: readonly ["money", "auth", "other"];
export type RiskArea = (typeof RISK_AREAS)[number];
/** The windows the trust numbers cover, in days. */
export declare const TRUST_WINDOWS: readonly [7, 30];
/** A fix PR, a revert or a red default branch up to this many days after a merge counts against that merge. */
export declare const FAILURE_WINDOW_DAYS = 7;
/** A production report is traced to the latest harness merge, up to this many days before it, that touched its fix's files. */
export declare const ESCAPE_TRACE_DAYS = 30;
/** Why a merge counts as a change failure. */
export type FailureKind = 'reverted' | 'main_red' | 'fix_followed' | 'escaped';
export interface TierTime {
    tier: string;
    runs: number;
    medianMinutes: number;
    totalMinutes: number;
}
/** One area's (or the whole instance's) trust numbers over one window. Rates are 0..1, null when there is nothing to divide by. */
export interface AreaTrust {
    /** Merged PRs (and direct lands) in the window. */
    merges: number;
    /** Of those, how many failed later: reverted, broke the default branch, or were followed by a fix PR or a production bug on the same files. */
    failures: number;
    changeFailureRate: number | null;
    /** Production reports (intake-filed issues) in the window traced to a harness merge. */
    escapedBugs: number;
    /** Hours from each failure being seen to its fix, its revert or a green default branch. */
    restoreHours: number[];
    medianRestoreHours: number | null;
    /** Issues a person reviewed in the window (a plan decided, a correction recorded, or a merge), and how many they sent back. */
    reviewed: number;
    revisedOrRejected: number;
    reviseRejectRate: number | null;
    /** Check runs (a check or a test tier on one commit) that passed or failed, and how many did both on the same commit. */
    checks: number;
    flakyChecks: number;
    flakyRate: number | null;
    /** The runs' own cost estimates (not billed money) and tokens, in all and per merged PR. */
    cost: {
        usd: number;
        tokens: number;
        perMergedPrUsd: number | null;
        perMergedPrTokens: number | null;
    };
    /** How long verification took, per tier: each test-run tier, the coordinator's verify checks, the evaluator's runs. */
    verification: TierTime[];
}
export interface TrustFailure {
    issue: number;
    number: number | null;
    area: RiskArea;
    kind: FailureKind;
    /** The fix or revert PR that showed it, when there is one. */
    by: number | null;
}
export interface TrustWindow {
    days: number;
    since: string;
    total: AreaTrust;
    byArea: Record<RiskArea, AreaTrust>;
    /** The failures of the merges in this window, newest issue first. */
    failures: TrustFailure[];
    /** Escaped money-path bugs (also in `byArea.money.escapedBugs`), named for the recommendation. */
    escapedMoney: number;
}
export interface TrustMetrics {
    until: string;
    windows: TrustWindow[];
}
/**
 * An issue's risk area: money when its review level's reasons name a money path (or it has the money-path label),
 * auth when they name auth or secrets (or it has the auth label), else other.
 */
export declare function riskAreaOf(reasons: readonly string[], labels?: readonly string[]): RiskArea;
/**
 * The trust numbers over each of TRUST_WINDOWS up to `now`, for the whole instance and per risk area. Pure: the
 * event log in, numbers out. The definitions are the panel's (docs/dashboard.md, "Trust"):
 * - a merge failed when, within FAILURE_WINDOW_DAYS, the default branch went red on it or auto-merge stopped on it,
 *   a revert PR named it, or a fix PR (a bug, or a title starting "fix") changed the same files; or when a production
 *   report (an intake-filed issue) was traced to it: the latest merge, up to ESCAPE_TRACE_DAYS before the report,
 *   that changed a file the report's fix changed. Each merge fails at most once, by what showed first.
 */
export declare function trustMetrics(events: MetricEvent[], o?: {
    now?: Date;
}): TrustMetrics;
/**
 * Fix-forward (a red default branch fixed by a fix PR rather than reverted; src/fix-forward.ts) records this event,
 * `{ outcome: 'fixed' | 'reverted' | 'gave_up' }`, once per red default branch it took on; until one exists, the
 * fix-forward figure says it is not measured yet.
 */
export declare const FIX_FORWARD_EVENT = "fix_forward.finished";
/** The windows the delivery metrics cover, in days. */
export declare const DELIVERY_WINDOWS: readonly [7, 30];
/** The slow tests are over this many days. */
export declare const SLOW_TEST_DAYS = 7;
/** How many of the slowest tests are listed. */
export declare const SLOWEST = 20;
/** At most this many over-budget tests are listed (and how many there are in all). */
export declare const OVER_BUDGET_LISTED = 50;
/** The merges-per-day series: this many days, today last. */
export declare const PER_DAY_DAYS = 14;
export type Measure<T> = ({
    measured: true;
} & T) | {
    measured: false;
    why: string;
};
export interface DeliveryWindow {
    days: number;
    since: string;
    /** Merges to the default branch the log records: merged PRs and direct lands. */
    merges: Measure<{
        total: number;
        perDay: number;
    }>;
    /** Times the default branch went red after a merge (a red after a green, or the first; red again while red is the same time). */
    mainRed: Measure<{
        count: number;
        stillRed: boolean;
    }>;
    /** Minutes from the default branch going red to its next green, for each red time that went green. */
    timeToGreen: Measure<{
        minutes: number[];
        medianMinutes: number | null;
    }>;
    /** Revert PRs opened (after a red default branch, or for a commit the main watch couldn't account for) and merged. */
    reverts: Measure<{
        opened: number;
        onRed: number;
        merged: number;
        redTimes: number;
        rate: number | null;
    }>;
    /** Fix-forward's outcomes, once it exists (FIX_FORWARD_EVENT). */
    fixForward: Measure<{
        attempts: number;
        fixed: number;
        reverted: number;
        successRate: number | null;
    }>;
    /** Merged PRs' CI wall-clock (ci.pr_timing). */
    prCi: Measure<{
        prs: number;
        medianMinutes: number | null;
        p90Minutes: number | null;
        slowest: {
            number: number;
            minutes: number;
        }[];
    }>;
    /** Seconds from a task being claimed to its agent's process starting (issue.claimed to run.started). */
    startup: Measure<{
        runs: number;
        medianSeconds: number | null;
        p90Seconds: number | null;
    }>;
    /** Re-runs of a red default branch's failing checks that found a flaky one, over all such re-runs (flaky.rerun_result). */
    flake: Measure<{
        reruns: number;
        flaky: number;
        rate: number | null;
        quarantined: number;
    }>;
}
export interface SlowTest {
    name: string;
    medianMs: number;
    maxMs: number;
    runs: number;
}
export interface SlowTests {
    days: number;
    budgetS: number;
    /** Runs (test-run tiers and CI jobs) in the window that printed durations this reads. */
    runs: number;
    slowest: SlowTest[];
    overBudget: SlowTest[];
    overBudgetTotal: number;
}
export interface DeliveryMetrics {
    until: string;
    windows: DeliveryWindow[];
    /** Merges per day, the last PER_DAY_DAYS days (UTC), today last. Null when merges aren't measured yet. */
    perDay: {
        day: string;
        merged: number;
    }[] | null;
    slowTests: Measure<SlowTests>;
}
/**
 * The delivery metrics over each of DELIVERY_WINDOWS up to `now`, and the slow tests over SLOW_TEST_DAYS. Pure: the
 * event log in, numbers out. `budgetS`: config.yaml metrics.slow_test_budget_s.
 */
export declare function deliveryMetrics(events: MetricEvent[], o: {
    now?: Date;
    budgetS: number;
}): DeliveryMetrics;
