import type { GateResult } from './discord-gate.js';
import type { IncomingReport } from './report.js';
export declare const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
export declare const API = "https://discord.com/api/v10";
/** GUILD_MESSAGES | MESSAGE_CONTENT: the least the bot needs to read addressed messages. No direct messages. */
export declare const INTENTS: number;
/** The longest reply the bot sends; anything longer is cut. */
export declare const REPLY_CHARS = 500;
/** The part of WebSocket the adapter uses, so tests can pass a fake. */
export interface Socket {
    send(data: string): void;
    close(code?: number): void;
    addEventListener(type: 'message' | 'close' | 'open', fn: (ev: {
        data?: unknown;
        code?: number;
    }) => void): void;
}
export interface DiscordOptions {
    token: string;
    /** The one server (guild) the bot reads; a message from any other is dropped. */
    guild: string;
    channels: string[];
    /** Chat channels (intake.yaml discord.chat_channels): every message from an allowed sender there is taken, no mention needed. */
    chatChannels?: string[];
    /** The only users whose messages are taken (discord.allowed_senders); anyone else's is dropped unread. */
    allowedSenders: string[];
    prefixes: string[];
    /** discord.owners: the only users a post may ever mention, and only in the bot's own threads or the ops channel. */
    owners?: string[];
    /** discord.ops_channel: the one channel (not a thread of the bot's) a post may mention owners in. */
    opsChannel?: string;
    /** The machine-wide identify gate (discord-gate.ts). Absent: identify at once (tests). */
    gate?: () => Promise<GateResult>;
    connect?: (url: string) => Socket;
    fetch?: typeof fetch;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (h: unknown) => void;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    now?: () => Date;
    /** Connection notes (never a token or message content). */
    log?: (line: string) => void;
}
export declare class DiscordIntake {
    private o;
    private socket;
    private seq;
    private heartbeat;
    private botId;
    /** The gateway session (from READY), resumed after a dropped connection instead of identifying again. */
    private sessionId;
    private resumeUrl;
    private stopped;
    private attempts;
    /** Identifies sent by this adapter (each one counts against the token's daily session starts). */
    identifies: number;
    /**
     * Messages received and not yet taken. Known loss: this lives in memory only, so messages that arrived in the few
     * seconds before a coordinator crash (or that the gateway delivered while it was down) are not recovered; the
     * gateway has no acknowledgement to hold them. A replay of a message already taken is deduped by its id.
     */
    private queue;
    /** Told of each chat-channel message and thread reply as it is queued: the coordinator answers those at once. */
    private arrival;
    /** The bot's own threads (decisions, asks, conversations) whose replies it takes. */
    private threads;
    /** Messages seen and dropped (not addressed, another server or channel, a DM, from a bot), counted only. */
    dropped: number;
    /** The same drops by reason: `sender` (not an allowed sender), `bot`, `place` (another server or channel, a DM), `unaddressed`. */
    droppedBy: Record<'sender' | 'bot' | 'place' | 'unaddressed', number>;
    constructor(o: DiscordOptions);
    start(): void;
    private open;
    /** After a dropped connection: resume (or identify again) after a backoff; never after a fatal close or stop(). */
    private reconnectLater;
    /** Drop the current connection and open another (Discord asked us to reconnect). */
    private reconnectNow;
    private forgetSession;
    stop(): void;
    /** Identify, once the machine-wide gate lets this one go (Discord's identify limits are per token). */
    private identify;
    /** Reports received since the last call. */
    take(): IncomingReport[];
    /** Reports received and not yet taken that match `which`, taken now; the rest stay queued. */
    takeWhere(which: (r: IncomingReport) => boolean): IncomingReport[];
    /** Call `fn` for each chat-channel message and thread reply once it is queued (an in-process wake-up, no I/O). */
    onArrival(fn: (r: IncomingReport) => void): void;
    /** Discord's typing indicator in `channel` (shown about 10 s, or until the bot posts). False on any failure. */
    typing(channel: string): Promise<boolean>;
    private stopHeartbeat;
    private send;
    private onFrame;
    /**
     * A dispatch. One bot may sit in several servers (one per instance that uses its token): an event of any other
     * server, or a message of no server (a DM), is dropped here, on its guild id alone, before anything else of it
     * is read.
     */
    private onDispatch;
    private onMessage;
    /** Take replies in this thread of the bot's. */
    watch(thread: string): void;
    /**
     * Post in `channel` (at most REPLY_CHARS, pinging nobody) and open a thread on the post, or on the message `from`
     * when given (a person's idea). The thread is watched from then on. Returns its id, or null on any failure.
     */
    openThread(channel: string, text: string, name: string, from?: string): Promise<string | null>;
    /**
     * Reply in the same channel, at most REPLY_CHARS, pinging nobody, except `mentions`: users among discord.owners,
     * and only in one of the bot's own threads or the ops channel (a direct push's alert; anywhere else, or anyone
     * else, is never pinged).
     */
    reply(threadId: string, content: string, mentions?: string[]): Promise<boolean>;
    /**
     * A direct message to one user, outbound only: open (or reuse) the DM channel and post in it, at most REPLY_CHARS,
     * pinging nobody. The DM channel is never watched: a reply there is dropped like every incoming DM.
     */
    dm(user: string, content: string): Promise<boolean>;
}
