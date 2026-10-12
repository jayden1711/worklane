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
  /** Where replies go: the channel it came from, or the bot's own thread it was a reply in (src/intake/channel.ts). */
  thread?: { kind: 'channel' | 'thread'; id: string };
}

/** A source as the coordinator uses it: new reports since the last take, and a reply into a report's thread. */
export interface IntakeSource {
  name: Source;
  take(): Promise<IncomingReport[]>;
  reply(thread: NonNullable<IncomingReport['thread']>, text: string): Promise<boolean>;
  /** Tell the source these reports are recorded (their ids are in the seen ledger), so it stops redelivering them. */
  ack?(sourceIds: string[]): Promise<void>;
  /**
   * A chat source only: post `text` in `channel` and open a thread on it named `name` (on the message `from` when
   * given, else on the new post). Returns the thread's id, or null when either step failed.
   */
  openThread?(channel: string, text: string, name: string, from?: string): Promise<string | null>;
  /** A chat source only: take replies in this thread of the bot's (no prefix or mention needed). */
  watch?(thread: string): void;
}

/** Intake's daily caps. The instance settings win; these (or the intake config's) are the defaults. */
export interface IntakeCaps {
  reports_per_sender_per_day: number;
  drafts_per_day: number;
  max_usd_per_day: number;
}
export const INTAKE_DEFAULT_CAPS: IntakeCaps = { reports_per_sender_per_day: 10, drafts_per_day: 20, max_usd_per_day: 2 };

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
      /** The dashboard's address, for the links a post carries (a secret ask, a high-risk merge): https only. */
      dashboard_url: z.string().regex(/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/, 'an https URL').optional(),
    })
    .refine((d) => !d.enabled || d.guild, { message: 'discord.guild (the server id) is required when discord is enabled', path: ['guild'] })
    .refine((d) => !d.asks_channel || d.dashboard_url, { message: 'discord.dashboard_url is required with discord.asks_channel (posts link to it)', path: ['dashboard_url'] })
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
