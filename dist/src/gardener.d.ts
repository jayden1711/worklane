import type { StoredEvent } from './events/types.js';
/** A pattern is fixed only once it has been seen this many times (distinct places, over every run). */
export declare const MIN_SIGHTINGS = 3;
export declare const FINDING_KINDS: readonly ["dead_code", "duplication", "rule_violation", "hotspot", "slow_check", "flaky_check"];
export type FindingKind = (typeof FINDING_KINDS)[number];
export interface Finding {
    /** A stable slug for the pattern (kebab case), the same across runs: what sightings are counted by. */
    pattern: string;
    kind: FindingKind;
    /** Repo-relative paths (or check names) where it was seen. */
    where: string[];
    detail: string;
    /** The fix, as a five-part issue: a small cleanup or a lint rule that stops it coming back. */
    fix: {
        title: string;
        body: string;
    } | null;
}
/**
 * Due when enabled, at or after the day's `at` (local time) and within 3 hours of it (off-hours, never late in the
 * day), and the last run started at least `everyDays` days ago (less an hour, so a weekly run doesn't drift).
 */
export declare function gardenerDue(now: Date, lastRunAt: string | null, o: {
    everyDays: number;
    at: string;
}): boolean;
/** What the log already shows: files conflict fixes keep touching, slow or slowing checks, checks that flip on one commit. */
export declare function gardenerSignals(events: StoredEvent[]): Finding[];
export declare const GARDENER_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["findings"];
    readonly properties: {
        readonly findings: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["pattern", "kind", "where", "detail", "fix_title", "fix_body"];
                readonly properties: {
                    readonly pattern: {
                        readonly type: "string";
                        readonly description: "A short stable slug for the pattern, the same one each run sees it (reuse a listed earlier one).";
                    };
                    readonly kind: {
                        readonly type: "string";
                        readonly enum: readonly ["dead_code", "duplication", "rule_violation", "hotspot", "slow_check", "flaky_check"];
                    };
                    readonly where: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: "Repo-relative paths (or check names) where you saw it, each one you checked.";
                    };
                    readonly detail: {
                        readonly type: "string";
                        readonly description: "What is wrong there, in a sentence or two, with the evidence.";
                    };
                    readonly fix_title: {
                        readonly type: "string";
                        readonly description: "The fix issue title: a small cleanup or a lint rule that stops it coming back. Empty if none.";
                    };
                    readonly fix_body: {
                        readonly type: "string";
                        readonly description: "The fix issue body, in the five parts, each starting a line with its bold label: **Outcome:** one sentence. **Sources:** where to look, nowhere else. **Constraints:** what to leave alone. **Deliverable:** a closed ```done_when block, commands as YAML block scalars (\"- command: |\"). **Review point:** the expected review level (L0 to L3) and what would make it wait for the owner. Empty if none.";
                    };
                };
            };
        };
    };
};
/** The run's findings, checked: a known kind, a pattern, at least one place; a fix only as a valid five-part draft. */
export declare function readFindings(s: unknown): {
    findings: Finding[];
    refused: string[];
};
/** Each pattern's sightings so far (distinct places over every run's findings), and the patterns already filed. */
export declare function patternHistory(events: {
    type: string;
    payload: unknown;
}[]): {
    sightings: Map<string, Set<string>>;
    filed: Map<string, number>;
};
/**
 * Which findings get a fix filed this run: a pattern seen MIN_SIGHTINGS+ times (with this run's places), never filed
 * before, with a valid fix, and nowhere in a protected path; at most `maxPrs`, most-seen first. The rest say why not.
 */
export declare function toFile(findings: Finding[], history: ReturnType<typeof patternHistory>, o: {
    maxPrs: number;
    isProtected: (path: string) => boolean;
}): {
    file: Finding[];
    held: {
        pattern: string;
        why: string;
    }[];
};
/** The gardener's brief: what the log shows, the patterns it has seen before, and what to look for. */
export declare function gardenerBrief(signals: Finding[], history: ReturnType<typeof patternHistory>): string;
export declare const GARDENER_LOG_LABEL = "gardener-log";
export declare const GARDENER_LABEL = "gardener";
export declare const gardenerLogMarker: (instance: string) => string;
/** One run's entry in the log issue. */
export declare function logEntry(o: {
    at: string;
    findings: Finding[];
    filed: {
        pattern: string;
        issue: number;
    }[];
    held: {
        pattern: string;
        why: string;
    }[];
    refused: string[];
    costUsd: number;
}): string;
/** The dashboard's view: each run, what it logged and filed; each pattern, how often seen and whether filed. */
export interface GardenerView {
    logIssue: number | null;
    runs: {
        at: string;
        findings: number;
        filed: number[];
        costUsd: number;
        outcome: string;
    }[];
    patterns: {
        pattern: string;
        kind: string;
        sightings: number;
        places: string[];
        filed: number | null;
        lastSeen: string;
    }[];
}
export declare function gardenerView(events: {
    ts: string;
    type: string;
    payload: unknown;
}[]): GardenerView;
