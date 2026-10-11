// Work intake: the shape of a report, whichever source it came from, and the
// instance's intake config (sources, trusted senders, caps). The config lives in
// the instance home (intake.yaml, the coordinator user's, 0600), never in the
// repo, so no agent can read who is trusted or change it. See docs/intake.md.
import { z } from 'zod';

export const SOURCES = ['discord', 'sms', 'bug-store'] as const;
export type Source = (typeof SOURCES)[number];

/** Who sent it, as the source identifies them: a chat user id, a phone number in E.164, or a store row's reporter id. */
export interface Sender {
  source: Source;
  id: string;
  /** A display name, used only to redact it from the text; never stored outside the raw store. */
  name?: string;
}

/** One report as an adapter produces it. `thread` is where replies go (a channel, a DM, a conversation). */
export interface IncomingReport {
  source: Source;
  /** The source's own id for this message or row, unique within the source. */
  sourceId: string;
  sender: Sender;
  text: string;
  receivedAt: string;
  thread?: { kind: 'channel' | 'dm' | 'sms' | 'group'; id: string };
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

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'a phone number in E.164 form, e.g. +15551234567');

export const IntakeConfig = z.strictObject({
  version: z.literal(1),
  /** Trusted senders: their drafts are filed with `ready`. The owner is trusted by their chat id / phone below. */
  trusted: z
    .strictObject({
      discord: z.array(z.string().regex(/^\d{5,25}$/, 'a Discord user id (digits)')).default([]),
      sms: z.array(e164).default([]),
      'bug-store': z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  discord: z
    .strictObject({
      enabled: z.boolean().default(false),
      channels: z.array(z.string().regex(/^\d{5,25}$/)).default([]),
      dms: z.boolean().default(true),
      /** In a channel, a message counts only if it mentions the bot or starts with one of these. */
      prefixes: z.array(z.string().min(1)).default(['bug:']),
    })
    .prefault({}),
  sms: z
    .strictObject({
      enabled: z.boolean().default(false),
      relay_url: z.string().url().optional(),
      /** In a group, a message counts only if it starts with one of these; the relay drops the rest unstored. */
      prefixes: z.array(z.string().min(1)).default(['bug:']),
    })
    .prefault({}),
  'bug-store': z
    .strictObject({
      enabled: z.boolean().default(false),
      /** A fixed read-only SELECT returning id, reporter, text, created_at, newer than :after. */
      query: z.string().min(1).optional(),
    })
    .prefault({}),
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
  return (cfg.trusted[sender.source] as string[]).includes(sender.id);
}
