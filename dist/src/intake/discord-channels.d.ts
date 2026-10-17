/** Discord channel types listed: GUILD_TEXT (0) and GUILD_ANNOUNCEMENT (5); the ones a bot posts in. */
export declare const LISTED_CHANNEL_TYPES: ReadonlySet<number>;
export declare class DiscordChannelsError extends Error {
}
export interface ListOptions {
    token: string;
    /** Tests stand in for Discord here, in code. */
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}
/** Remove every occurrence of the token from a message (and so from anything a server echoed back). */
export declare function scrubToken(text: string, token: string): string;
/** A channel the bot can see: its server (guild), its own id and name, and Discord's channel type. */
export interface ChannelRow {
    guild_id: string;
    guild: string;
    id: string;
    name: string;
    type: number;
}
/** Every text and announcement channel in every server the bot is in, sorted by server, then channel. */
export declare function listDiscordChannelRows(o: ListOptions): Promise<ChannelRow[]>;
/** The same channels as "<server> / #<channel> <id>" lines. */
export declare function listDiscordChannels(o: ListOptions): Promise<string[]>;
/** The bot's own application: its id (the invite link's client_id), its name, and whether message content is on. */
export interface BotApplication {
    id: string;
    name: string;
    message_content: boolean;
}
export declare function discordApplication(o: ListOptions): Promise<BotApplication>;
/** What `discord channels --json` prints, on one line. */
export interface ChannelsJson {
    application: BotApplication;
    channels: ChannelRow[];
}
export interface CommandOptions {
    instance?: string | undefined;
    dir?: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    out?: (line: string) => void;
    err?: (line: string) => void;
    /** One JSON line (ChannelsJson) instead of the lines. */
    json?: boolean;
}
/** The CLI command: pick the instance, read its token, print the channels. Exit 0, or 1 with one scrubbed line. */
export declare function discordChannelsCommand(o?: CommandOptions): Promise<number>;
