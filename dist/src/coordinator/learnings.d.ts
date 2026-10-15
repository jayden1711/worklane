import { ChecksFromFeedback } from './checks-from-feedback.js';
export declare const PROMOTE_LEVEL_LABEL = "review:L3";
export declare abstract class Learnings extends ChecksFromFeedback {
    noteLearnings(issue: number, doneWhen?: string[]): number;
    promoteLearnings(): Promise<void>;
    private fileAgentsMdPr;
}
