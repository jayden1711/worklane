import type { EventPayload } from './events/types.js';
import type { IntakeConfig } from './intake/report.js';
/** The post's key (discord.posting / discord.posted): one per commit. */
export declare const directPushKey: (sha: string) => string;
/** Where the dashboard shows the main watch (the Machine page's protection section). */
export declare const mainWatchLink: (dashboardUrl: string) => string;
/** Where the alert goes: the ops channel and the dashboard's address; or why it can't be posted. */
export declare function alertTarget(cfg: IntakeConfig | null): {
    channel: string;
    dashboardUrl: string;
} | {
    why: string;
};
/**
 * Who the post mentions: each of discord.owners mapped to a GitHub login in discord.people. `note`: why nobody is
 * mentioned (shown on the dashboard), or null.
 */
export declare function ownerMentions(cfg: IntakeConfig): {
    mentions: string[];
    note: string | null;
};
/** The post: what landed without a PR, who pushed it, its subject, and the dashboard's main-watch view. */
export declare function directPushText(p: EventPayload<'main_watch.direct_push'>, o: {
    branch: string;
    dashboardUrl: string;
    secrets?: string[];
}): string;
