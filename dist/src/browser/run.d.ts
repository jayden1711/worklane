import type { AppConfig, FlowStep } from '../config/schema.js';
import { type TraceSummary } from './trace.js';
/** Whether the browser may load this URL: the app on localhost, or an in-page scheme (data, blob, about). */
export declare function isLocal(url: string): boolean;
/** A step, in words, for the evidence. */
export declare function stepLabel(s: FlowStep): string;
export interface FlowEvidence {
    flow: string;
    /** Every step ran and held. */
    ok: boolean;
    steps: {
        step: string;
        ok: boolean;
        ms: number;
        error?: string;
    }[];
    consoleErrors: {
        kind: string;
        text: string;
        url?: string;
    }[];
    failedRequests: {
        url: string;
        method: string;
        status: number | null;
        error: string | null;
    }[];
    slowRequests: {
        url: string;
        method: string;
        ms: number;
    }[];
    /** Requests refused because they weren't to the app on localhost. */
    blockedRequests: string[];
    trace: TraceSummary | null;
    screenshot: string | null;
    durationMs: number;
    /** What went wrong cleaning up (a profile left behind): reported, never judged. */
    notes?: string[];
}
export type FlowRun = FlowEvidence | {
    flow: string;
    skipped: string;
};
/**
 * Run `flow` from `app` against the app started in `cwd`. Evidence lands in `outDir` (the screenshot). Throws when
 * the app can't be started or never becomes ready (its output tail in the message), or the browser fails; a failing
 * step is evidence. However it ends, Chrome and the app's whole process tree are stopped first. Chrome's temporary
 * profile goes under `chromeProfileRoot` when given (the system temp folder otherwise).
 */
export declare function runFlow(o: {
    app: AppConfig;
    flow: string;
    cwd: string;
    outDir: string;
    chrome?: string | null;
    noSandbox?: boolean;
    runAs?: {
        user: string;
        home: string;
    };
    chromeProfileRoot?: string;
}): Promise<FlowRun>;
/** INVARIANT: a flow against a deployed preview (docs/previews.md) reaches its origin only, or an in-page scheme. */
export declare function isOnOrigin(url: string, origin: string): boolean;
/** docs/previews.md: a flow against an app already deployed at `origin`; nothing is started or stopped here. */
export declare function runFlowAt(o: {
    app: AppConfig;
    flow: string;
    origin: string;
    outDir: string;
    chrome?: string | null;
    noSandbox?: boolean;
    chromeProfileRoot?: string;
}): Promise<FlowRun>;
