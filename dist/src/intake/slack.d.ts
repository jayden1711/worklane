import type { Socket } from './discord.js';
import type { IncomingReport } from './report.js';
/** Slack's Web API. INVARIANT: a constant; no config, environment variable or request names another host. */
export declare const SLACK_API = "https://slack.com/api";
/** The longest reply posted; anything longer is cut (the same as Discord's). */
export declare const SLACK_REPLY_CHARS = 500;
/**
 * Is this the WebSocket URL Slack's API handed us? It comes from Slack's own response, so it is checked: wss only, on
 * a host under slack.com. Anything else is refused and no socket is opened.
 */
export declare function slackSocketUrl(raw: unknown): string | null;
/** Text for Slack with `&`, `<` and `>` escaped: no <!channel>, <@U...> or <url|label> can form from it. */
export declare function escapeSlack(text: string): string;
/**
 * A message's text as a person reads it, before anything else sees it: the bot's own mention removed, other people's
 * mentions as `[mention]` (an id is personal data), a channel as its name, a mailto or tel link as its address (so
 * the redaction finds it), a link as its URL, and Slack's own escapes undone.
 */
export declare function slackPlainText(text: string, botUserId: string | null): string;
export interface SlackOptions {
    /** The app-level token (xapp-, connections:write): opens the Socket Mode connection. */
    appToken: string;
    /** The bot token (xoxb-): who the bot is, a sender's display name, and the replies. */
    botToken: string;
    /** The one workspace (slack.team). */
    team: string;
    channels: string[];
    /** The only users whose mentions are taken (slack.allowed_senders); anyone else's is dropped unread. */
    allowedSenders: string[];
    connect?: (url: string) => Socket;
    fetch?: typeof fetch;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    now?: () => Date;
    /** Connection notes (never a token or message content). */
    log?: (line: string) => void;
}
export declare class SlackIntake {
    private o;
    readonly name: "slack";
    private socket;
    private stopped;
    private attempts;
    /** The bot's own user id (auth.test), so its own mention is removed and its own messages dropped. */
    private botUserId;
    private queue;
    private seenEvents;
    private seenSet;
    private names;
    /** Mentions seen and dropped, counted only. */
    dropped: number;
    /** The same drops by reason: `place` (another workspace or channel, a DM), `bot`, `sender` (not allowed), `unaddressed`, `repeat` (a redelivery). */
    droppedBy: Record<'place' | 'bot' | 'sender' | 'unaddressed' | 'repeat', number>;
    /** Envelopes acknowledged. */
    acked: number;
    constructor(o: SlackOptions);
    private api;
    /**
     * Who the bot is (auth.test with the bot token): its user id and workspace. Refused when the token is bad or belongs
     * to another workspace than slack.team. Called before connecting (wire.ts claims the app by it).
     */
    identify(): Promise<{
        team: string;
        user: string;
    } | {
        error: string;
    }>;
    /** Connect: ask Slack for a Socket Mode URL with the app-level token, then open it. Reconnects on its own. */
    start(): void;
    stop(): void;
    private open;
    private reconnectLater;
    private onFrame;
    private drop;
    /** One event: dropped in order (workspace, bot, sender, place, addressing) before its text is read. */
    private onEvent;
    /** A sender's display name (users.info), only so the redaction can take it out of their text. Null on any failure. */
    private nameOf;
    /** Reports received since the last call, each with its sender's display name (for the redaction) when Slack gives one. */
    take(): Promise<IncomingReport[]>;
    /**
     * Reply in the message's thread (`<channel>:<thread ts>`), only in a listed channel, at most SLACK_REPLY_CHARS,
     * escaped (no ping, no link markup), no link previews.
     */
    reply(thread: string, text: string): Promise<boolean>;
}
