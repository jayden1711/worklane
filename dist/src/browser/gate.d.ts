import type { AppConfig } from '../config/schema.js';
export interface BrowserGate {
    /** The flows to run, in order; empty when none. */
    flows: string[];
    /** Why, in a line, for the run's log and the PR's evidence. */
    reason: string;
    /** The changed files under ui_paths (at most 10), when that's why. */
    uiFiles: string[];
}
/** Changed files under the app's ui_paths, repo-relative with forward slashes (git's form, on every OS). */
export declare function uiFilesTouched(app: AppConfig, changed: readonly string[]): string[];
/** The flows an issue's done_when asks for, in its order. */
export declare function askedFlows(doneWhen: readonly unknown[]): string[];
export declare function browserGate(o: {
    app: AppConfig | undefined;
    changed: readonly string[];
    asked: readonly string[];
}): BrowserGate;
