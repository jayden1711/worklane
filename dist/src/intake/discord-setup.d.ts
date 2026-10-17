import { type Ask, type Role } from '../console/asks.js';
import type { SecretRule } from '../console/secrets.js';
import type { EventLog } from '../events/log.js';
import type { BotApplication, ChannelRow } from './discord-channels.js';
import { IntakeConfig } from './report.js';
export declare class DiscordSetupError extends Error {
    readonly status: 400 | 409 | 502;
    constructor(message: string, status?: 400 | 409 | 502);
}
/** The paste_secret ask's credential name (the file's name in the instance's secrets directory). */
export declare const DISCORD_CREDENTIAL = "intake-discord";
export declare const DISCORD_PORTAL = "https://discord.com/developers/applications";
/** What a bot token looks like, as credentials.sh intake-discord checks it. */
export declare const DISCORD_TOKEN_SHAPE: RegExp;
/**
 * The permissions the invite link asks for: exactly what intake's bot does (src/intake/discord.ts), each a bit of
 * Discord's permission integer. Nothing else: no reading history, no managing anything, no mentioning everyone.
 * docs/intake.md lists the same four, and test/discord-setup.test.ts holds the integer.
 */
export declare const INVITE_PERMISSIONS: readonly [{
    readonly name: "View Channels";
    readonly bit: 10;
    readonly why: "see the channels it is added to and receive their messages";
}, {
    readonly name: "Send Messages";
    readonly bit: 11;
    readonly why: "reply, and post decisions, incidents, merges and what the superfan finds";
}, {
    readonly name: "Create Public Threads";
    readonly bit: 35;
    readonly why: "open one thread per idea, decision or setup ask";
}, {
    readonly name: "Send Messages in Threads";
    readonly bit: 38;
    readonly why: "answer inside those threads";
}];
export declare const INVITE_PERMISSION_INTEGER: string;
/** The bot's invite link: the `bot` scope only, with those permissions. `applicationId` is the bot's own (digits). */
export declare function inviteUrl(applicationId: string): string;
export type RunCli = (args: string[]) => Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
}>;
/** This engine's own CLI, by absolute path: the one binary the listing ever runs. */
export declare const ENGINE_CLI: string;
/**
 * The environment the child gets: this process's, less what would make node load other code (NODE_OPTIONS can
 * --require or --import a file; NODE_PATH adds module directories). Nothing in it chooses the binary: that is
 * process.execPath and ENGINE_CLI, both absolute.
 */
export declare function listingEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * The listing as a child process, run as this process's user (an instance's dashboard runs as its coordinator user):
 * always this node binary (process.execPath) running this engine's own cli.js (ENGINE_CLI), both absolute paths.
 * INVARIANT: no PATH lookup, and no option, environment variable, config key or request can change which binary runs;
 * the only other way the dashboard gets the listing is an in-process stand-in (discordListingStandIn), set in code.
 */
export declare function engineRunCli(): RunCli;
declare const STAND_IN: unique symbol;
/** An in-process answer in place of the listing's child process: for tests and CI, made only by discordListingStandIn. */
export interface DiscordListingStandIn {
    readonly [STAND_IN]: RunCli;
}
/**
 * The one seam: code (a test, a CI helper) hands the dashboard an answer to give instead of running the listing. It
 * is set in code only: it is a value no configuration, environment, PATH or request can produce, and it starts no
 * binary of its own choosing; it answers in-process.
 */
export declare function discordListingStandIn(answer: RunCli): DiscordListingStandIn;
/**
 * The listing the dashboard uses: the engine's own CLI, or a stand-in made by discordListingStandIn. Anything else (a
 * function, a path, an object naming a binary) is refused, so no option can point it at another program.
 */
export declare function listingRunner(standIn?: unknown): RunCli;
export interface BotView {
    application: BotApplication;
    /** The invite link for this bot. */
    invite: string;
    channels: ChannelRow[];
    at: string;
}
/**
 * The bot's application and the channels it can see, from `discord channels --instance <name> --json` run as a child
 * process. A failure is the child's own one-line message (it scrubs the token from everything it prints).
 */
export declare function botView(instance: string, run: RunCli): Promise<BotView>;
export interface TokenState {
    /** credentials.yaml names a token file. */
    configured: boolean;
    file: string | null;
    /** A file is at that path (not read). */
    present: boolean;
    error: string | null;
}
export declare function tokenState(credentialsFile: string): TokenState;
/** The setup console's rule for a pasted bot token: its shape, then credentials.yaml pointed at the installed file. */
export declare function discordTokenRule(o: {
    instance: string;
    credentialsFile: string;
    onStored?: () => void;
}): SecretRule;
/** The open paste box for this instance's bot token: the one already waiting, or a new ask. Nothing is stored yet. */
export declare function tokenAsk(log: EventLog, instance: string, by: string): {
    ask: Ask;
    created: boolean;
};
type KeyKind = 'boolean' | 'id' | 'ids' | 'guild' | 'url';
/** The intake.yaml keys this step writes, and nothing else in the file. */
export declare const INTAKE_FORM: readonly {
    key: string;
    kind: KeyKind;
    what: string;
}[];
export declare const INTAKE_FORM_KEYS: string[];
export type FormValue = boolean | string | string[] | null;
/** The form's keys as the config has them (its defaults applied). */
export declare const intakeFormValues: (cfg: IntakeConfig) => Record<string, FormValue>;
export interface IntakeChange {
    key: string;
    from: FormValue;
    to: FormValue;
}
export interface IntakePlan {
    file: string;
    /** No intake.yaml yet: confirming creates it. */
    creates: boolean;
    changes: IntakeChange[];
    /** The exact change to the file, as a unified diff. */
    diff: string;
    /** What a confirm must send back: the file as it was and as it would be, so what is written is what was shown. */
    hash: string;
    warnings: string[];
    text: string;
}
/**
 * The change these values make to intake.yaml, or why it is refused. Nothing is written.
 * - Only INTAKE_FORM's keys; every other key and comment of the file is kept.
 * - A newly picked server or channel must be one the bot can see (`channels`, the bot's own list).
 * - A channel the bot reads (discord.channels, asks_channel, chat_channels) must be in the chosen server.
 * - A superfan channel is never one the bot reads: the schema's rule, held here whether or not the superfan is on.
 * - The result must pass the intake schema (src/intake/report.ts).
 */
export declare function planIntake(o: {
    path: string;
    values: Record<string, unknown>;
    channels: readonly ChannelRow[];
}): IntakePlan;
/**
 * Write a confirmed change: planned again (the file or the bot's list may have changed since), and written only when
 * that is the very change the owner was shown (`expect`, the plan's hash). Renamed into place, 0600.
 */
export declare function applyIntake(o: {
    path: string;
    values: Record<string, unknown>;
    channels: readonly ChannelRow[];
    expect: string;
}): IntakePlan;
/** A unified diff of two texts by line, three lines of context; `before` null is a file that doesn't exist yet. */
export declare function lineDiff(before: string | null, after: string, name: string): string;
export interface DiscordSetupView {
    available: true;
    instance: string;
    /** Whether this person may act (the instance's owners). */
    canAct: boolean;
    portal: string;
    token: TokenState;
    /** The open paste box for the token, when one is waiting. */
    ask: (Ask & {
        canAnswer: boolean;
    }) | null;
    invite: {
        integer: string;
        permissions: {
            name: string;
            bit: number;
            why: string;
        }[];
    };
    intake: {
        file: string;
        exists: boolean;
        error: string | null;
        values: Record<string, FormValue>;
        warnings: string[];
    };
    form: {
        key: string;
        kind: KeyKind;
        what: string;
    }[];
    /** The same without this page: the commands and the config keys. */
    automation: {
        token: string;
        channels: string;
        file: string;
        keys: string[];
        restart: string;
    };
}
/** The step as the page shows it: all from local files and the event log; no network, nothing written, no token. */
export declare function discordSetupView(o: {
    instance: string;
    home: string;
    asks: readonly Ask[];
    role: Role | null;
    engineRoot: string;
    user?: string;
}): DiscordSetupView;
export {};
