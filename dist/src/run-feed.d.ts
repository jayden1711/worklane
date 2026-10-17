export declare const FEED_MAX_BYTES: number;
export declare const FEED_MAX_LINES = 5000;
/** One feed item. `seq` counts from 0 (the start item) with no gaps. */
export type FeedItem = {
    seq: number;
    at: string;
} & ({
    kind: 'start';
    run: string;
    issue: number | null;
    role: string;
    model: string;
} | {
    kind: 'text';
    text: string;
} | {
    kind: 'thinking';
    text: string;
}
/** A tool call. For file writes, `input` names the file only; the change is in the following diff item. */
 | {
    kind: 'tool';
    id: string;
    tool: string;
    input: string;
} | {
    kind: 'tool_result';
    id: string;
    status: 'ok' | 'error';
    output: string;
} | {
    kind: 'diff';
    id: string;
    tool: string;
    file: string;
    diff: string;
}
/** A console message's progress (the owner's text on queued). */
 | {
    kind: 'message';
    id: string;
    state: 'queued' | 'delivered' | 'dropped';
    text?: string;
}
/** The feed hit its cap; nothing more but the end. */
 | {
    kind: 'truncated';
    why: 'bytes' | 'lines';
} | {
    kind: 'end';
    reason: string;
    costUsd: number;
    turns: number;
});
/** A file write as a diff: an edit's old and new text, or a written file's whole content. */
export declare function writeDiff(tool: string, input: Record<string, unknown>, file: string): string;
export declare class RunFeed {
    private caps;
    private now;
    private seq;
    private bytes;
    private count;
    private full;
    private ended;
    readonly file: string;
    constructor(stateDir: string, o: {
        run: string;
        issue: number | null;
        role: string;
        model: string;
        cwd: string;
    }, caps?: {
        bytes: number;
        lines: number;
    }, now?: () => Date);
    private cwd;
    /** One stream-json line from the session. */
    line(j: unknown): void;
    message(id: string, state: 'queued' | 'delivered' | 'dropped', text?: string): void;
    /** The last item: always written, even past the cap. */
    end(e: {
        reason: string;
        costUsd: number;
        turns: number;
    }): void;
    private push;
    private write;
    /** A path inside the worktree as the repo names it: relative, with forward slashes on every OS. */
    private relative;
}
/** A run's feed items after `after` (a seq; -1 for all), and whether the feed has ended. Never a path outside the runs dir. */
export declare function readFeed(stateDir: string, run: string, after?: number): {
    items: FeedItem[];
    ended: boolean;
} | null;
