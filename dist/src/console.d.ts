import type { Config } from './config/load.js';
import { type FeedItem } from './run-feed.js';
export declare const CONSOLE_DIR = "console";
export declare const MAX_MESSAGE = 4000;
export declare class ConsoleError extends Error {
}
export interface PendingMessage {
    id: string;
    text: string;
    by: string;
    at: string;
}
/** A run the coordinator holds the input of, as live.json lists it. */
export interface LiveRun {
    run: string;
    issue: number | null;
    role: string;
    model: string;
    startedAt: string;
    /** Messages queued and not yet delivered (they go in when the current turn ends). */
    pending: PendingMessage[];
}
/**
 * `owner`: the instance's own dashboard read `by` as one of its owners (admin on the repo); `writer`: as one of its
 * writers (write or maintain), which allows a message only.
 */
export type ConsoleRequest = {
    v: 1;
    id: string;
    at: string;
    by: string;
    run: string;
    owner?: true;
    writer?: true;
} & ({
    kind: 'message';
    text: string;
} | {
    kind: 'stop';
});
/**
 * Who may make a console request, the one rule both sides apply (the dashboard before writing it, the coordinator
 * when it takes it): a message from the owner or a writer, a stop from the owner only. The owner is the default
 * owner or one the dashboard read as an owner; a writer, one it read as a writer. Null when allowed, else why not.
 */
export declare function mayRequest(cfg: Config, r: {
    kind: 'message' | 'stop';
    by: string;
    owner?: boolean;
    writer?: boolean;
}): string | null;
/** The runs live right now (empty when the coordinator isn't running any, or hasn't written the list). */
export declare function liveRuns(stateDir: string): LiveRun[];
/** Message (steer) a live run: the owner or a writer. Queued at once; delivered when the agent's current turn ends. */
export declare function sendMessage(o: {
    stateDir: string;
    cfg: Config;
    run: string;
    text: string;
    by: string;
    owner?: boolean;
    writer?: boolean;
    now?: Date;
}): {
    id: string;
};
/** Stop a live run (owner only): its process tree ends; the task it was on is blocked, saying who stopped it. */
export declare function stopRun(o: {
    stateDir: string;
    cfg: Config;
    run: string;
    by: string;
    owner?: boolean;
    now?: Date;
}): {
    id: string;
};
/** A run's live feed after `after` (owner only); the same items whether the run is live or ended. */
export declare function runFeed(o: {
    stateDir: string;
    cfg: Config;
    run: string;
    by: string;
    after?: number;
}): {
    items: FeedItem[];
    ended: boolean;
};
/** Requests waiting, oldest first; each is removed as it's taken (a malformed one too). */
export declare function takeRequests(stateDir: string): ConsoleRequest[];
/** The coordinator's list of live runs, for the dashboard. */
export declare function writeLive(stateDir: string, runs: LiveRun[]): void;
