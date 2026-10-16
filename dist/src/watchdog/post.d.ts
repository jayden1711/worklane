import { type Incident } from './incidents.js';
/** At most this many posts per window, machine-wide. */
export declare const RATE: {
    readonly max: 5;
    readonly windowMs: number;
};
/** Sends one message to the ops channel; true when it went. */
export type Poster = (content: string) => Promise<boolean>;
/** A text with every secret-shaped string, and each of `secrets` (the bot token), taken out. */
export declare function scrub(text: string, secrets?: string[]): string;
/** Where an incident is on the Health page; null without a dashboard address. */
export declare function incidentLink(dashboardUrl: string | null | undefined, id: string): string | null;
/** The post for an incident that opened, or was resolved. */
export declare function postText(x: Incident, what: 'raised' | 'resolved', o?: {
    dashboardUrl?: string | null;
    secrets?: string[];
}): string;
/**
 * Post what waits, within the rate limit. Only the one poster on the machine calls this (the watchdog's post lock),
 * so a post is never sent twice; its mark is written right after it went.
 */
export declare function postPending(o: {
    poster: Poster;
    dashboardUrl?: string | null;
    secrets?: string[];
    dir?: string;
    now?: () => Date;
}): Promise<{
    posted: number;
    waiting: number;
}>;
/**
 * One ops post from elsewhere (a direct push's alert, src/direct-push-alert.ts; a merge post, src/merge-posts.ts;
 * fix-forward's red and green posts, coordinator/fix-forward.ts), within the same machine-wide limit as the incident
 * posts: true, and counted, when one may go now; false when the window is full (try again later). The one helper for
 * all of them, so they share the one window. `now`: a Date or epoch ms.
 */
export declare function takeOpsPost(o?: {
    dir?: string;
    now?: Date | number;
}): boolean;
/** A poster for one Discord channel with the bot's token: a plain message that pings nobody. */
export declare function discordPoster(o: {
    token: () => string;
    channel: string;
    fetch?: typeof fetch;
    api?: string;
}): Poster;
