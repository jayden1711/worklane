import type { IncomingMessage, ServerResponse } from 'node:http';
/** The only sizes asked of GitHub (px): the page asks for the smallest at least twice its box (web/src/api.ts). */
export declare const AVATAR_SIZES: readonly [40, 80, 160];
/** A picture larger than this is refused, whatever its type. */
export declare const AVATAR_MAX_BYTES: number;
/** How long a picture is kept before it is asked of GitHub again; the browser keeps it as long. */
export declare const AVATAR_TTL_MS: number;
/** How long a failed picture (none, refused, timed out) is answered with "none" before it is asked again. */
export declare const AVATAR_MISS_MS: number;
/** How long one fetch from GitHub may take, redirects and body included. */
export declare const AVATAR_TIMEOUT_MS = 5000;
/** The route, on an instance's own server (and, as /api/i/<instance>/avatar/<login>, on the hub). */
export declare const AVATAR_ROUTE: RegExp;
export interface AvatarOptions {
    /** Tests only, in code: a stand-in for GitHub. Nothing reads one from outside the process. */
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
}
interface Picture {
    type: string;
    etag: string;
    at: number;
    body: Buffer;
}
/** A picture's size as the route takes it: one of AVATAR_SIZES, else null. */
export declare function avatarSize(raw: string | null): number | null;
/** Fetch one picture from GitHub, following its redirect only to GitHub's hosts; null when there is none to serve. */
export declare function fetchAvatar(login: string, size: number, o?: {
    fetch?: typeof fetch;
    timeoutMs?: number;
}): Promise<{
    type: string;
    body: Buffer;
} | null>;
/**
 * The pictures one server keeps, in `<dir>` (its state dir's avatars/): fetched once per person and size, kept a
 * day, each served with cache-control and an ETag.
 */
export declare class Avatars {
    private readonly o;
    private readonly dir;
    private readonly now;
    private readonly inFlight;
    private readonly missed;
    constructor(dir: string, o?: AvatarOptions);
    private file;
    private read;
    private write;
    /** The picture to serve for `login` at `size`: the kept one while fresh, else GitHub's (the stale one if that fails). */
    picture(login: string, size: number): Promise<Picture | null>;
    /**
     * GET /api/avatar/<login>?size=N, after the caller's own sign-in check: a bad login or size is refused before
     * anything else, then anyone `known` doesn't name (no fetch for them), then the picture, or 204 No Content (the page shows
     * initials). WHY 204, not 404: Chrome logs every 4xx as a console error, and a person with no picture is no error.
     */
    serve(req: IncomingMessage, res: ServerResponse, rawLogin: string, rawSize: string | null, known: (login: string) => boolean | Promise<boolean>): Promise<void>;
}
/** Everyone an instance's events and config name: its owners, and each task's and decision's people. Lowercased. */
export declare function peopleOf(o: {
    owners: {
        default: string;
        writers: string[];
        areas: {
            owner: string;
        }[];
    };
    tasks: {
        owner: string | null;
        author?: string;
    }[];
    decisions: {
        owner: string;
    }[];
}): Set<string>;
export {};
