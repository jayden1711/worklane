import { z } from 'zod';
export declare const SOURCES: readonly ["discord", "bug-store", "alerts", "github", "voice"];
export type Source = (typeof SOURCES)[number];
/** Who sent it, as the source identifies them: a Discord user id, a store row's reporter id, an alert's kind, or (voice) the owner's GitHub login. */
export interface Sender {
    source: Source;
    id: string;
    /** A display name, used only to redact it from the text; never stored outside the raw store. */
    name?: string;
}
/** One report as an adapter produces it. `thread` is where replies go (the channel it came from). */
export interface IncomingReport {
    source: Source;
    /** The source's own id for this message or row, unique within the source. */
    sourceId: string;
    sender: Sender;
    text: string;
    receivedAt: string;
    /**
     * Where replies go: the channel it came from, the bot's own thread it was a reply in (src/intake/channel.ts), or a
     * chat channel (`chat`: never a report; src/coordinator/channel-chat.ts).
     */
    thread?: {
        kind: 'channel' | 'thread' | 'chat';
        id: string;
    };
}
/** A source as the coordinator uses it: new reports since the last take, and a reply into a report's thread. */
export interface IntakeSource {
    name: Source;
    take(): Promise<IncomingReport[]>;
    reply(thread: NonNullable<IncomingReport['thread']>, text: string, opts?: ReplyOptions): Promise<boolean>;
    /** Tell the source these reports are recorded (their ids are in the seen ledger), so it stops redelivering them. */
    ack?(sourceIds: string[]): Promise<void>;
    /**
     * A chat source only: post `text` in `channel` and open a thread on it named `name` (on the message `from` when
     * given, else on the new post). Returns the thread's id, or null when either step failed.
     */
    openThread?(channel: string, text: string, name: string, from?: string): Promise<string | null>;
    /** A chat source only: take replies in this thread of the bot's (no prefix or mention needed). */
    watch?(thread: string): void;
    /**
     * A chat source only: the reports received and not yet taken that match `which`, taken now (the rest stay for
     * take()). With it, the coordinator answers chat-channel messages and decision-thread replies as they arrive
     * (src/coordinator/quick-replies.ts) and the intake pass takes everything else.
     */
    takeNow?(which: (r: IncomingReport) => boolean): Promise<IncomingReport[]>;
    /** A chat source only: call `fn` as each chat-channel message or thread reply arrives. */
    onArrival?(fn: (r: IncomingReport) => void): void;
    /** A chat source only: show the typing indicator in a channel or thread. False on any failure. */
    typing?(where: string): Promise<boolean>;
    /**
     * A chat source only: send `text` to this user as a direct message, outbound only (the bot never reads DMs; an
     * incoming one is dropped on receipt). True when it was sent.
     */
    dm?(user: string, text: string): Promise<boolean>;
}
/** How a reply is sent: `mentions`, the users it pings (only discord.owners, only in the bot's own thread or the ops channel; the adapter enforces both). */
export interface ReplyOptions {
    mentions?: string[];
}
/** Intake's daily caps. The instance settings win; these (or the intake config's) are the defaults. */
export interface IntakeCaps {
    reports_per_sender_per_day: number;
    drafts_per_day: number;
    max_usd_per_day: number;
}
export declare const INTAKE_DEFAULT_CAPS: IntakeCaps;
/** The chat channels' defaults (intake.yaml discord.chat_model, discord.chat_max_usd_per_day). */
export declare const CHAT_DEFAULTS: {
    readonly model: "haiku";
    readonly max_usd_per_day: 2;
};
/** The superfan's defaults (intake.yaml superfan.every_minutes, superfan.daily_budget_usd). */
export declare const SUPERFAN_DEFAULTS: {
    readonly every_minutes: 30;
    readonly daily_budget_usd: 2;
};
export declare const TRIAGE_KINDS: readonly ["bug", "feature", "question", "duplicate", "not_actionable", "needs_info"];
export type TriageKind = (typeof TRIAGE_KINDS)[number];
export declare const IntakeConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    trusted: z.ZodPrefault<z.ZodObject<{
        discord: z.ZodDefault<z.ZodArray<z.ZodString>>;
        'bug-store': z.ZodDefault<z.ZodArray<z.ZodString>>;
        alerts: z.ZodDefault<z.ZodArray<z.ZodString>>;
        github: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>>;
    }, z.core.$strict>>;
    discord: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        guild: z.ZodOptional<z.ZodString>;
        channels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowed_senders: z.ZodDefault<z.ZodArray<z.ZodString>>;
        prefixes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        people: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        asks_channel: z.ZodOptional<z.ZodString>;
        ops_channel: z.ZodOptional<z.ZodString>;
        post_merges: z.ZodDefault<z.ZodBoolean>;
        conversation: z.ZodDefault<z.ZodBoolean>;
        dashboard_url: z.ZodOptional<z.ZodString>;
        chat_channels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        chat_model: z.ZodDefault<z.ZodEnum<{
            haiku: "haiku";
            sonnet: "sonnet";
            opus: "opus";
        }>>;
        chat_max_usd_per_day: z.ZodDefault<z.ZodNumber>;
        owners: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    'bug-store': z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        query: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    alerts: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        table: z.ZodDefault<z.ZodString>;
        columns: z.ZodPrefault<z.ZodObject<{
            id: z.ZodDefault<z.ZodString>;
            kind: z.ZodDefault<z.ZodString>;
            message: z.ZodDefault<z.ZodString>;
            created_at: z.ZodDefault<z.ZodString>;
        }, z.core.$strict>>;
        batch: z.ZodDefault<z.ZodNumber>;
        spike: z.ZodPrefault<z.ZodObject<{
            threshold: z.ZodDefault<z.ZodNumber>;
            window_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    github: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        poll_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    voice: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    casual_replies: z.ZodDefault<z.ZodBoolean>;
    raw_retention_days: z.ZodDefault<z.ZodNumber>;
    redact: z.ZodPrefault<z.ZodObject<{
        names: z.ZodDefault<z.ZodArray<z.ZodString>>;
        patterns: z.ZodDefault<z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            regex: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    superfan: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        channel: z.ZodOptional<z.ZodString>;
        every_minutes: z.ZodDefault<z.ZodNumber>;
        daily_budget_usd: z.ZodDefault<z.ZodNumber>;
        model: z.ZodOptional<z.ZodEnum<{
            haiku: "haiku";
            sonnet: "sonnet";
            opus: "opus";
        }>>;
        machine_channel: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    caps: z.ZodPrefault<z.ZodObject<{
        reports_per_sender_per_day: z.ZodDefault<z.ZodNumber>;
        drafts_per_day: z.ZodDefault<z.ZodNumber>;
        max_usd_per_day: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type IntakeConfig = z.infer<typeof IntakeConfig>;
/**
 * May this sender's message be taken at all? Discord: only the allowed senders. Checked on the sender id alone,
 * before anything of the message is read or stored. In-product reports have no allow-list.
 */
export declare function isAllowed(sender: Sender, cfg: IntakeConfig): boolean;
/** What the config allows that is probably not meant, for the start-up check. */
export declare function intakeWarnings(cfg: IntakeConfig): string[];
/**
 * Is this sender trusted? Decided only from the adapter's sender id against the instance config: nothing in the
 * report's text can make a sender trusted.
 */
export declare function isTrusted(sender: Sender, cfg: IntakeConfig): boolean;
