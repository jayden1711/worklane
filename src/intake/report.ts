// Work intake: the shape of a report, whichever source it came from, and the
// instance's intake config (sources, trusted senders, caps). The config lives in
// the instance home (intake.yaml, the coordinator user's, 0600), never in the
// repo, so no agent can read who is trusted or change it. See docs/intake.md.
import { z } from 'zod';

export const SOURCES = ['discord', 'bug-store'] as const;
export type Source = (typeof SOURCES)[number];

/** Who sent it, as the source identifies them: a Discord user id, or a store row's reporter id. */
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
  thread?: { kind: 'channel' | 'thread' | 'chat'; id: string };
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

/** How a reply is sent: `mentions`, the users it pings (only discord.owners, only in the bot's own thread; the adapter enforces both). */
export interface ReplyOptions {
  mentions?: string[];
}

/** Intake's daily caps. The instance settings win; these (or the intake config's) are the defaults. */
export interface IntakeCaps {
  reports_per_sender_per_day: number;
  drafts_per_day: number;
  max_usd_per_day: number;
}
export const INTAKE_DEFAULT_CAPS: IntakeCaps = { reports_per_sender_per_day: 10, drafts_per_day: 20, max_usd_per_day: 2 };
/** The chat channels' defaults (intake.yaml discord.chat_model, discord.chat_max_usd_per_day). */
export const CHAT_DEFAULTS = { model: 'haiku', max_usd_per_day: 2 } as const;

export const TRIAGE_KINDS = ['bug', 'feature', 'question', 'duplicate', 'not_actionable', 'needs_info'] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

/** A GitHub login as GitHub allows them (letters, digits, dashes; at most 39), as the dashboard checks it. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const snowflake = (what: string) => z.string().regex(/^\d{5,25}$/, `a Discord ${what} id (digits)`);

export const IntakeConfig = z.strictObject({
  version: z.literal(1),
  /**
   * Trusted senders: their drafts are filed with `ready`. The owner is trusted by their Discord user id below. A
   * trusted Discord id must also be an allowed sender (discord.allowed_senders).
   */
  trusted: z
    .strictObject({
      discord: z.array(snowflake('user')).default([]),
      'bug-store': z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  /** One server only: messages from any other server, and every direct message, are dropped unstored. */
  discord: z
    .strictObject({
      enabled: z.boolean().default(false),
      /** The server (guild) id; required when enabled. */
      guild: snowflake('server').optional(),
      /** Only these channels of that server count. */
      channels: z.array(snowflake('channel')).default([]),
      /**
       * The only Discord users whose messages are taken (user ids). Anyone else's message is dropped before it is
       * stored, counted only, and gets no reply. Empty: nobody's message is accepted.
       */
      allowed_senders: z.array(snowflake('user')).default([]),
      /** In a channel, a message counts only if it mentions the bot or starts with one of these. */
      prefixes: z.array(z.string().min(1)).default(['bug:']),
      /**
       * Who each allowed sender is on GitHub: Discord user id -> GitHub login. Their role in a Discord thread is that
       * login's permission on the instance's repo (admin: owner, write: writer), read as the dashboard reads it. An
       * allowed sender not listed here is ignored in threads and conversations: nothing of theirs is stored.
       */
      people: z.record(snowflake('user'), z.string().regex(GITHUB_LOGIN, 'a GitHub login')).default({}),
      /**
       * The channel decisions and setup-console asks are posted in, one thread each, answered by a reply in the thread.
       * Absent: nothing is posted.
       */
      asks_channel: snowflake('channel').optional(),
      /**
       * Ideas in conversation: an addressed message in `channels` from a mapped admin or writer opens a thread where
       * the bot asks what it must, drafts the five-part issue, shows it, and files it `ready` only on an explicit
       * yes (src/coordinator/conversation.ts), instead of being triaged and filed at once. Off: intake as before.
       */
      conversation: z.boolean().default(false),
      /** The dashboard's address, for the links a post carries (a secret ask, a high-risk merge): https only. */
      dashboard_url: z.string().regex(/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/, 'an https URL').optional(),
      /**
       * Chat channels (src/coordinator/channel-chat.ts): in these, the bot is a conversational assistant for mapped
       * admins and writers, replying to each of their messages (no mention needed), with read-only access to the
       * checkout's code and the instance's state. It can never file, answer, change or start anything. Each must be
       * none of `channels` or `asks_channel`. Empty (the default): no chat.
       */
      chat_channels: z.array(snowflake('channel')).default([]),
      /** The chat's model (capped by the instance's model_cap like every run). */
      chat_model: z.enum(['haiku', 'sonnet', 'opus']).default(CHAT_DEFAULTS.model),
      /** The chat's own daily spend cap, in dollars; its runs count against the instance's daily budget too. */
      chat_max_usd_per_day: z.number().positive().max(20).default(CHAT_DEFAULTS.max_usd_per_day),
      /**
       * The owners on Discord (user ids): the only people who may approve a high-risk (L3) merge from a thread
       * ("approve <number>"), or ask for a setup step's one-time dashboard link by DM. Each must be mapped in
       * `people`, and the login it maps to must be an admin on the instance's repo: checked at start-up, where one
       * that isn't refuses Discord. They are also the only users a post may ever mention (an approval pings the
       * others, in its thread). Empty (the default): no high-risk approval and no link comes from Discord.
       */
      owners: z.array(snowflake('user')).default([]),
      /**
       * The ops channel: the machine's watchdog posts each incident here (a service down, an update rolled back, a
       * login failing, a full disk...), once when it opens and once when it is resolved, each linking to its place on
       * the dashboard's Health page (src/watchdog/). Only one coordinator on the machine posts. Absent: none from here.
       */
      ops_channel: snowflake('channel').optional(),
    })
    .refine((d) => !d.enabled || d.guild, { message: 'discord.guild (the server id) is required when discord is enabled', path: ['guild'] })
    .refine((d) => !d.chat_channels.some((c) => d.channels.includes(c) || c === d.asks_channel), { message: 'a chat channel must not also be an ideas channel (discord.channels) or the asks channel', path: ['chat_channels'] })
    .refine((d) => !d.asks_channel || d.dashboard_url, { message: 'discord.dashboard_url is required with discord.asks_channel (posts link to it)', path: ['dashboard_url'] })
    .refine((d) => !d.ops_channel || d.dashboard_url, { message: 'discord.dashboard_url is required with discord.ops_channel (incident posts link to the Health page)', path: ['dashboard_url'] })
    .prefault({}),
  'bug-store': z
    .strictObject({
      enabled: z.boolean().default(false),
      /** A fixed read-only SELECT returning id, reporter, text, created_at, newer than :after. */
      query: z.string().min(1).optional(),
    })
    .prefault({}),
  /**
   * Replies worded by the casual replier role from the redacted message and the engine's facts, each checked in
   * code before it is sent (src/intake/replier.ts). Off: the engine's fixed replies.
   */
  casual_replies: z.boolean().default(false),
  /** Days the raw (unredacted) text is kept in the coordinator's private state. */
  raw_retention_days: z.number().int().min(1).max(90).default(14),
  /** Extra redaction: names and labelled patterns specific to this project (e.g. account or bet ids). */
  redact: z
    .strictObject({
      names: z.array(z.string().min(2)).default([]),
      patterns: z
        .array(
          z.strictObject({
            label: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
            regex: z.string().min(1).refine((r) => {
              try {
                new RegExp(r);
                return true;
              } catch {
                return false;
              }
            }, 'not a valid regular expression'),
          }),
        )
        .default([]),
    })
    .prefault({}),
  /** Defaults for the caps; the instance settings (intake.*) win over these. */
  caps: z
    .strictObject({
      reports_per_sender_per_day: z.number().int().min(1).max(100).default(INTAKE_DEFAULT_CAPS.reports_per_sender_per_day),
      drafts_per_day: z.number().int().min(1).max(200).default(INTAKE_DEFAULT_CAPS.drafts_per_day),
      max_usd_per_day: z.number().positive().max(20).default(INTAKE_DEFAULT_CAPS.max_usd_per_day),
    })
    .prefault({}),
}).superRefine((c, ctx) => {
  for (const id of c.trusted.discord) {
    if (!c.discord.allowed_senders.includes(id)) ctx.addIssue({ code: 'custom', path: ['trusted', 'discord'], message: `${id} is trusted but not in discord.allowed_senders; a trusted sender must be allowed` });
  }
  for (const id of Object.keys(c.discord.people)) {
    if (!c.discord.allowed_senders.includes(id)) ctx.addIssue({ code: 'custom', path: ['discord', 'people'], message: `${id} is mapped to a GitHub login but not in discord.allowed_senders; a mapped person must be allowed` });
  }
  for (const id of c.discord.owners) {
    if (!Object.hasOwn(c.discord.people, id)) ctx.addIssue({ code: 'custom', path: ['discord', 'owners'], message: `${id} is in discord.owners but not mapped to a GitHub login in discord.people; every Discord owner must be mapped (to a GitHub admin)` });
  }
});
export type IntakeConfig = z.infer<typeof IntakeConfig>;

/**
 * May this sender's message be taken at all? Discord: only the allowed senders. Checked on the sender id alone,
 * before anything of the message is read or stored. In-product reports have no allow-list.
 */
export function isAllowed(sender: Sender, cfg: IntakeConfig): boolean {
  return sender.source === 'discord' ? cfg.discord.allowed_senders.includes(sender.id) : true;
}

/** What the config allows that is probably not meant, for the start-up check. */
export function intakeWarnings(cfg: IntakeConfig): string[] {
  return cfg.discord.enabled && !cfg.discord.allowed_senders.length ? ['discord is on but discord.allowed_senders is empty: no Discord message will be accepted'] : [];
}

/**
 * Is this sender trusted? Decided only from the adapter's sender id against the instance config: nothing in the
 * report's text can make a sender trusted.
 */
export function isTrusted(sender: Sender, cfg: IntakeConfig): boolean {
  // A source no longer configured (a report stored before it was removed) is trusted for nobody.
  return (cfg.trusted[sender.source] as string[] | undefined)?.includes(sender.id) ?? false;
}
