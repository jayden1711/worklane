export type LightPlan = {
    action: 'merge-now';
    why: string;
} | {
    action: 'verify-combined';
    overlap: string[];
    why: string;
};
/**
 * Decide whether a PR needs the combined-state check. `mainChanged`: files changed on main since the commit
 * the PR's checks ran against (empty when main hasn't moved). `prFiles`: files the PR changes. `imports`:
 * repo files each PR file imports (from `importsOf`).
 */
export declare function lightCheckPlan(o: {
    enabled: boolean;
    mainChanged: string[];
    prFiles: string[];
    imports: Record<string, string[]>;
}): LightPlan;
/**
 * The repo files a source file imports, resolved against the repo's file list: relative imports for
 * JS/TS (import, export … from, require, dynamic import; a .js specifier also finds the .ts source), and
 * for Python both relative imports and absolute ones that name a module in the repo. Conservative and cheap:
 * no type information, no package resolution; unknown languages import nothing.
 */
export declare function importsOf(file: string, content: string, repoFiles: Set<string>): string[];
/**
 * What the coordinator does with the result of the combined check: merge the unchanged PR head, or not.
 * A merge of main that conflicts is a conflict (the conflict fix path), never a red check.
 */
export declare function lightOutcome(r: {
    merged: boolean;
    fastPassed: boolean | null;
}): 'merge' | 'conflict' | 'hold';
/** How many light checks one PR may start within LIGHT_CHECK_WINDOW_MS: the first, and one catch-up. */
export declare const LIGHT_CHECK_BURST = 2;
export declare const LIGHT_CHECK_WINDOW_MS: number;
/**
 * Debounce for light checks: a burst of moves of main runs at most LIGHT_CHECK_BURST checks for a PR within the
 * window; any further one waits until the window has room, then checks the newest main. `startedAt`: when this
 * PR's light checks started (ms). Returns how long to wait before starting another (0: start now).
 */
export declare function lightCheckWait(startedAt: number[], now: number): number;
