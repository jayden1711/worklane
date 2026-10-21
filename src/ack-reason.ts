// The typed reason an owner gives to resume auto-merge while the default branch isn't green (#776). One validator,
// used by the dashboard's route, by the event schema (merge.resume_requested's `ack`), and by the coordinator before it
// acts on a request, so a reason the dashboard would refuse can't be logged or acted on from anywhere else.

export const ACK_MIN = 10;
export const ACK_MAX = 500;

/** Characters that print nothing or change how text around them reads: control, format (zero-width, bidi), private-use, unassigned. */
const UNREADABLE = /\p{C}/u;
/**
 * What counts toward the minimum: letters, digits, punctuation and symbols that print (not spaces, not combining marks
 * alone, not default-ignorables such as the Hangul fillers U+115F, U+1160, U+3164, U+FFA0, nor the braille blank U+2800).
 * web/src/components/Protection.tsx counts the same way.
 */
const VISIBLE = /(?![\p{Default_Ignorable_Code_Point}⠀])[\p{L}\p{N}\p{P}\p{S}]/gu;

/** Whitespace (newlines too) folded to single spaces, trimmed: the form a reason is recorded in. */
const fold = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Why `reason` (already folded) is no acknowledgement, or null when it is one. */
export function ackReasonError(reason: string): string | null {
  if (UNREADABLE.test(reason)) return 'the reason has characters that don\'t print (control, format such as zero-width or bidi, or unassigned): type it plainly';
  if ((reason.match(VISIBLE)?.length ?? 0) < ACK_MIN) return `an acknowledgement needs a typed reason of at least ${ACK_MIN} visible characters`;
  if (reason.length > ACK_MAX) return `the reason is too long (at most ${ACK_MAX} characters)`;
  return null;
}

/** Whether `reason` is an acknowledgement exactly as recorded: folded, and passing ackReasonError. */
export function isRecordedAck(reason: unknown): reason is string {
  return typeof reason === 'string' && reason === fold(reason) && ackReasonError(reason) === null;
}

/**
 * The acknowledgement a resume request carries (`{ acknowledge: { reason } }`): none, a typed reason, or why it is
 * refused. A bare `true`, an empty or short reason, or one with characters that don't print is no acknowledgement.
 * Whitespace (newlines too) is folded to single spaces; nothing else is changed, so what is recorded is what was typed.
 */
export function acknowledgement(body: unknown): { reason: string | null } | { error: string } {
  const a = (body as { acknowledge?: unknown } | null)?.acknowledge;
  if (a === undefined || a === null) return { reason: null };
  const reason = typeof (a as { reason?: unknown }).reason === 'string' ? fold((a as { reason: string }).reason) : '';
  const error = ackReasonError(reason);
  return error ? { error } : { reason };
}
