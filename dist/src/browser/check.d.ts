import type { AppConfig } from '../config/schema.js';
import { BrowserDoneWhenItem } from '../contract.js';
import { type FlowEvidence } from './run.js';
export { BrowserDoneWhenItem };
export interface BrowserVerdict {
    pass: boolean;
    /** Why it failed, one line each; empty when it passed. */
    reasons: string[];
    /** What was seen but not judged (slow and blocked requests, frames not measured). */
    notes: string[];
}
/** Judge a flow's evidence against the app's thresholds, and against a baseline run of the same flow if there is one. */
export declare function judgeFlow(ev: FlowEvidence, thresholds: AppConfig['thresholds'], baseline?: FlowEvidence | null): BrowserVerdict;
/** A browser check's result, in the shape of the coordinator's other checks, with its evidence. */
export interface BrowserCheckResult {
    check: string;
    status: 'pass' | 'fail' | 'unavailable';
    kind: 'browser';
    exitCode: null;
    tail: string;
    evidence: FlowEvidence | null;
    verdict: BrowserVerdict | null;
}
/**
 * Run a `browser:` check: the flow from the project's app, judged. Unavailable (never passed) without an app or
 * a browser; failed for an unknown flow, or an app that doesn't start.
 */
export declare function runBrowserCheck(o: {
    item: BrowserDoneWhenItem;
    app: AppConfig | undefined;
    cwd: string;
    outDir: string;
    baseline?: FlowEvidence | null;
    chrome?: string | null;
    runAs?: {
        user: string;
        home: string;
    };
}): Promise<BrowserCheckResult>;
