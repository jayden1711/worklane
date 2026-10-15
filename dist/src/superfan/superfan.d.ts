import { type Cursor, type DigestItem, type DigestSources } from './digest.js';
/** intake.yaml `superfan`, as the schema leaves it (src/intake/report.ts). */
export interface SuperfanSettings {
    enabled: boolean;
    channel?: string | undefined;
    every_minutes: number;
    daily_budget_usd: number;
    model?: string | undefined;
    machine_channel?: string | undefined;
}
/** The label on every issue a superfan files. */
export declare const SUPERFAN_LABEL = "superfan";
/** The share of the day's budget at which it says so, once. */
export declare const ALERT_AT = 0.85;
/** The most one pass's model run may spend. */
export declare const PASS_MAX_USD = 0.25;
export interface SuperfanState {
    cursor: Cursor | null;
    lastPassAt: string | null;
    day: string;
    spentUsd: number;
    alerted85: boolean;
    stopNoticed: boolean;
    /** Item keys already posted about (the newest kept). */
    posted: string[];
    /** The shapes of the newest posts' texts. */
    postShapes: string[];
    /** The shapes of the titles of issues filed. */
    filed: string[];
}
export declare function readState(file: string, day: string): SuperfanState;
export declare const VERDICT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["verdict", "post", "items", "action"];
    readonly properties: {
        readonly verdict: {
            readonly type: "string";
            readonly enum: readonly ["nothing", "new", "odd"];
        };
        readonly post: {
            readonly type: "string";
        };
        readonly items: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly action: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["kind", "title", "body"];
            readonly properties: {
                readonly kind: {
                    readonly type: "string";
                    readonly enum: readonly ["none", "issue", "fix"];
                };
                readonly title: {
                    readonly type: "string";
                };
                readonly body: {
                    readonly type: "string";
                };
            };
        };
    };
};
/** The superfan's fixed instructions (its run's system prompt addition). */
export declare const SUPERFAN_SYSTEM: string;
/** The fixed question, with the digest. */
export declare function superfanPrompt(o: {
    watching: string;
    items: DigestItem[];
}): string;
export interface Verdict {
    verdict: 'nothing' | 'new' | 'odd';
    post: string;
    items: string[];
    action: {
        kind: 'none' | 'issue' | 'fix';
        title: string;
        body: string;
    };
}
/** The model's answer as code reads it: anything malformed is "nothing"; an action other than issue or fix is none. */
export declare function readVerdict(raw: unknown): Verdict;
export type PassOutcome = 'not_due' | 'quiet' | 'nothing' | 'posted' | 'duplicate' | 'budget' | 'instance_budget' | 'failed';
export interface PassRecord {
    scope: 'instance' | 'machine';
    outcome: Exclude<PassOutcome, 'not_due'>;
    items: number;
    cost_usd: number;
    spent_usd: number;
    filed: number | null;
    notes: string[];
}
export interface SuperfanDeps {
    scope: 'instance' | 'machine';
    /** What it watches, in its posts and prompt: "instance <name>", "the machine's engine and updater". */
    watching: string;
    stateFile: string;
    /** The state file's mode: 0o600 for an instance's, 0o660 for the machine's (in the shared slot directory). */
    stateMode?: number;
    settings: SuperfanSettings;
    /** The sources, read now (read-only). */
    read: () => DigestSources | Promise<DigestSources>;
    /** One model run on the prompt, within `maxUsd`: its answer and cost. No tools; the prompt is all it gets. */
    judge: (prompt: string, maxUsd: number) => Promise<{
        ok: boolean;
        costUsd: number;
        structured?: unknown;
        detail?: string;
    }>;
    /** One message in the superfan's channel, once per key; true when it went. */
    post: (key: string, text: string) => Promise<boolean>;
    /** File an issue (the backlog's createIssue); absent for the machine's superfan, which only posts. */
    file?: (title: string, body: string, labels: string[]) => Promise<number>;
    /** The redaction every line, the prompt and every post and issue go through. */
    redact: (s: string) => string;
    /** What is left of the instance's own daily budget. */
    budgetLeft?: () => number;
    now: () => Date;
    record?: (r: PassRecord) => void;
}
/** One pass: when due, within the budget; reads, judges, and posts (and files) at most once. */
export declare function superfanPass(d: SuperfanDeps): Promise<PassOutcome>;
