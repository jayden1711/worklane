import type { BrowserGate } from './gate.js';
import type { BrowserCheckResult } from './check.js';
import type { FlowEvidence } from './run.js';
/** What a run saw, in one line: the counts a reviewer compares before and after. */
export declare function evidenceSummary(ev: FlowEvidence): string;
/**
 * The PR description's browser section. `before` is the same flow run at `base` (the commit the change is measured
 * against); `baselineUnavailable` says why there is none, so the reader knows every error was counted as new.
 */
export declare function browserEvidenceLines(o: {
    gate: BrowserGate;
    runs: {
        result: BrowserCheckResult;
        before?: FlowEvidence | null;
        base?: string;
        baselineUnavailable?: string;
    }[];
}): string[];
