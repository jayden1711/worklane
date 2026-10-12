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
  thread?: { kind: 'channel'; id: string };
}

/** A source as the coordinator uses it: new reports since the last take, and a reply into a report's thread. */
export interface IntakeSource {
  name: Source;
  take(): Promise<IncomingReport[]>;
  reply(thread: NonNullable<IncomingReport['thread']>, text: string): Promise<boolean>;
  /** Tell the source these reports are recorded (their ids are in the seen ledger), so it stops redelivering them. */
  ack?(sourceIds: string[]): Promise<void>;
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

const snowflake = (what: string) => z.string().regex(/^\d{5,25}$/, `a Discord ${what} id (digits)`);

export const IntakeConfig = z.strictObject({
  version: z.literal(1),
  /** Trusted senders: their drafts are filed with `ready`. The owner is trusted by their Discord user id below. */
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
      /** In a channel, a message counts only if it mentions the bot or starts with one of these. */
      prefixes: z.array(z.string().min(1)).default(['bug:']),
    })
    .refine((d) => !d.enabled || d.guild, { message: 'discord.guild (the server id) is required when discord is enabled', path: ['guild'] })
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
});
export type IntakeConfig = z.infer<typeof IntakeConfig>;

/**
 * Is this sender trusted? Decided only from the adapter's sender id against the instance config: nothing in the
 * report's text can make a sender trusted.
 */
export function isTrusted(sender: Sender, cfg: IntakeConfig): boolean {
  // A source no longer configured (a report stored before it was removed) is trusted for nobody.
  return (cfg.trusted[sender.source] as string[] | undefined)?.includes(sender.id) ?? false;
}
