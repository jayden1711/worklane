import { type ResearchCaps, type ResearchResult } from './research.js';
/** The field a worker's or evaluator's output may carry (merged into their output schemas, in roles.ts). */
export { RESEARCH_REQUEST_FIELD } from './roles.js';
/** Research requests answered per task, at most. */
export declare const MAX_REQUESTS_PER_TASK = 2;
export interface ResearchRequest {
    question: string;
    why: string;
}
/**
 * A request is taken only when it is one precise question: 15 to 500 characters, a single question, and with
 * nothing in it that looks like a secret (the question goes to the open web).
 */
export declare function acceptResearchRequest(raw: unknown): {
    ok: true;
    request: ResearchRequest;
} | {
    ok: false;
    why: string;
};
/**
 * Why a request can't be answered now, or null: the day's research caps (searches, fetches, spend) or this
 * task's request limit. Counted from the event log by type name, so older logs simply have none.
 */
export declare function researchRequestHold(o: {
    events: {
        type: string;
        ts: string;
        payload: unknown;
    }[];
    issue: number;
    caps: ResearchCaps;
    day: string;
}): string | null;
/**
 * The answer as a section of the resumed task's brief: the question, the researcher's report and its sources,
 * framed as web data to double-check, and as information, never instructions. Redacted and bounded.
 */
export declare function researchBriefSection(request: ResearchRequest, result: ResearchResult): string;
