import { type AreaTrust, type DeliveryMetrics, type MetricEvent, type RiskArea, type TrustFailure, type TrustWindow } from './merge-metrics.js';
/** The recommendation's rules. Fixed here, never a model's. */
export declare const TRUST_RULES: {
    /** Ready to raise the agent count: over the last `days`, at least `minMerges` merges, a change failure rate under `maxChangeFailureRate`, and no escaped money-path bug. */
    readonly raise: {
        readonly days: 30;
        readonly minMerges: 30;
        readonly maxChangeFailureRate: 0.05;
    };
    /**
     * Verification per area, over 30 days: heavier at a change failure rate of `heavierAt` or more, or any escaped
     * bug; lighter (other areas only: money path and auth stay heavy) below `lighterBelow` over at least
     * `lighterMinMerges` merges; under `minMerges` there is too little to judge.
     */
    readonly verification: {
        readonly days: 30;
        readonly minMerges: 10;
        readonly heavierAt: 0.1;
        readonly lighterBelow: 0.02;
        readonly lighterMinMerges: 20;
    };
};
export declare const AREA_LABEL: Record<RiskArea, string>;
/** A figure a viewer may not see is null (src/trust.ts, trustForViewer); the owner and writers see every one. */
export type Shown<T> = {
    [K in keyof T]: T[K] | null;
};
export interface AgentAdvice {
    action: 'keep' | 'raise';
    /** The instance's agents (workers) now, and what the advice is for. */
    now: number;
    to: number;
    text: string;
    /** Each rule, met or not, in words. */
    why: {
        rule: string;
        met: boolean;
    }[];
}
export interface VerificationAdvice {
    area: RiskArea;
    advice: 'heavier' | 'lighter' | 'keep' | 'too_few';
    text: string;
}
export interface TrustWindowView {
    days: number;
    since: string;
    total: Shown<AreaTrust>;
    byArea: Record<RiskArea, Shown<AreaTrust>> | null;
    failures: TrustFailure[] | null;
    escapedMoney: number | null;
}
export interface TrustView {
    until: string;
    windows: TrustWindowView[];
    agents: AgentAdvice | null;
    verification: VerificationAdvice[] | null;
    /** What each number means, as the panel's footnotes. */
    definitions: string[];
    /** Says plainly that this is a recommendation and changes nothing. */
    note: string;
    /** The figures left out for this reader (a viewer), by name; empty for the owner and writers. */
    hidden: string[];
}
/** "Keep 2 agents" or "Ready to raise to 3 agents", by TRUST_RULES.raise, from the 30-day window. */
export declare function agentAdvice(w: Pick<TrustWindow, 'days' | 'total' | 'escapedMoney'>, now: number): AgentAdvice;
/** Per area: heavier, lighter or as it is, by TRUST_RULES.verification, from the 30-day window. */
export declare function verificationAdvice(byArea: Record<RiskArea, Pick<AreaTrust, 'merges' | 'changeFailureRate' | 'escapedBugs'>>): VerificationAdvice[];
export declare const TRUST_DEFINITIONS: string[];
export declare const TRUST_NOTE = "A recommendation only: nothing here changes the agent count, the slots, the caps or any merge. Raising the agent count stays a machine owner's action.";
/** The Trust panel's view for the owner and writers: every figure. `agents`: the instance's agents (workers) now. */
export declare function trustView(events: MetricEvent[], o: {
    agents: number;
    now?: Date;
}): TrustView;
type Fields = Readonly<Record<string, readonly string[]>>;
/**
 * Each figure and the event fields it is made of. A viewer sees a figure only when the viewer-events allowlist
 * (src/viewer-events.ts) shows them every one of those fields; anything made of more stays hidden, the way a new
 * event type does. Cost is never a viewer's (costs are the owners' and writers', like /api/throughput).
 */
export declare const TRUST_SOURCES: Readonly<Record<string, Fields>>;
/** Whether `allow` (event type -> the payload fields shown) shows every field a figure is made of. */
export declare function allowlistShows(sources: Fields, allow: Fields): boolean;
/**
 * The view as a viewer may have it: only the figures the viewer-events allowlist `allow` permits (TRUST_SOURCES),
 * never cost; the area breakdown and the recommendations only when what they are made of is permitted too.
 */
export declare function trustForViewer(v: TrustView, allow: Fields): TrustView;
/** The Monday (UTC) of a time's week, YYYY-MM-DD: the digest is posted once per week. */
export declare function trustWeek(t: Date): string;
/** The weekly digest for the Discord ops channel: the 7- and 30-day numbers, by area, and both recommendations. Under 2000 characters. */
export declare function trustDigest(v: TrustView, o: {
    instance: string;
    dashboardUrl?: string | null;
}): string;
/** What each delivery figure means, as the Metrics panel's footnotes. */
export declare const METRICS_DEFINITIONS: string[];
export declare const NOT_MEASURED = "not measured yet";
/** One delivery figure over the 7 and 30 days, in words: "not measured yet" when its source has nothing yet. */
export declare function deliveryLines(m: DeliveryMetrics): string[];
/**
 * The weekly metrics digest for the Discord ops channel, beside the trust digest: the delivery figures, then the 20
 * slowest tests and every test over the time budget (what the weekly optimization pass can target). Each message
 * is under 2000 characters; a long list continues in the next.
 */
export declare function metricsDigest(m: DeliveryMetrics, o: {
    instance: string;
    dashboardUrl?: string | null;
}): string[];
export {};
