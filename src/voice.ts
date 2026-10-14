// Voice intake and spoken approvals: the server's rules (the dashboard's routes and the one decide path apply them).
// A spoken idea or "approve <n>" is heard on the owner's own device (web/src/voice/), shown to them, and sent only
// when they confirm it within 10 s, by voice or by a click. Here, a request that says it came by voice:
// - is refused unless the person is an owner of the instance and their tab says it was focused and visible;
// - may only approve (never reject, revise or answer anything else), and never an item voice may not approve
//   (voiceExclusion: a high-risk merge the owner holds, a plan held for a high-risk reason, a change to what waits
//   for the owner); those take a click on the dashboard;
// - is audited "by voice".
// The voice claim is the client's word, so it is untrusted: it only ever adds these checks. A request without it is
// an ordinary click, under the ordinary rules, never more.
import { join } from 'node:path';
import type { EventPayload } from './events/types.js';
import { isHighRiskReason } from './merge-policy.js';
import { NEVER_FROM_CHAT } from './intake/people.js';
import type { Role } from './dashboard-auth.js';

/** How long a spoken confirm stays open; the dashboard's banner counts it down (web/src/voice/commands.ts). */
export const VOICE_WINDOW_MS = 10_000;

/** The audit's mark on everything done by voice. */
export const BY_VOICE = 'voice';

/** What a request says about voice: nothing (an ordinary click), or that it came by voice, with its tab's state. */
export type VoiceClaim = { voice: false } | { voice: true; focused: boolean; visible: boolean };

/**
 * The request's voice claim. Any `voice` field at all, whatever its shape, is a voice request: a malformed one is
 * refused as voice, never treated as a click. Only an exact `true` counts as focused or visible.
 */
export function voiceClaim(body: unknown): VoiceClaim {
  const v = body && typeof body === 'object' ? (body as { voice?: unknown }).voice : undefined;
  if (v === undefined || v === null || v === false) return { voice: false };
  const o = v && typeof v === 'object' ? (v as { focused?: unknown; visible?: unknown }) : {};
  return { voice: true, focused: o.focused === true, visible: o.visible === true };
}

/** Why a voice request is refused for this person and tab, or null: owners only, from a focused and visible tab. */
export function voiceRefusal(who: { login: string; role: Role }, claim: Extract<VoiceClaim, { voice: true }>, repo: string): string | null {
  if (who.role !== 'owner') return `voice intake and approvals are the instance's owners' only (admin on ${repo}); @${who.login} is a ${who.role}`;
  if (!claim.focused || !claim.visible) return 'nothing is done by voice unless the dashboard tab is focused and visible';
  return null;
}

/**
 * THE rule for what voice may never approve; one classifier, used by the decide path (the server refuses) and by
 * the dashboard's state (the page says so before anyone speaks). It reuses the engine's own classification:
 * - NEVER_FROM_CHAT: the high-risk (L3) merges the owner holds, which no chat reply answers either;
 * - a held plan with a high-risk reason (isHighRiskReason, merge-policy.ts: money path, auth, secrets, deploy and
 *   release config, the harness's own controls and protection, CI), from its plan.posted reasons and its receipts;
 * - delegation: answering it changes what waits for the owner (the merge policy's categories).
 * Null: voice may approve it. Merges the merge policy left to an owner (merge.approved) and setup steps (secrets,
 * root steps) are never decisions, so no voice request reaches them at all.
 */
export function voiceExclusion(q: { id: string; kind: string; receipts: readonly string[] }, posted: readonly Pick<EventPayload<'plan.posted'>, 'decision' | 'reasons'>[] = []): string | null {
  if (NEVER_FROM_CHAT.has(q.kind)) return 'a high-risk merge the owner holds is approved only by a click on the dashboard or on GitHub';
  if (q.kind === 'delegation') return 'a change to what waits for the owner is approved only by a click';
  const reasons = [...posted.filter((p) => p.decision === q.id).flatMap((p) => p.reasons), ...q.receipts.map((r) => r.replace(/^holds because /, ''))];
  const high = reasons.find(isHighRiskReason);
  if (high) return `it is high-risk (${high.slice(0, 160)}); approve it with a click`;
  return null;
}

/** Where the dashboard leaves confirmed spoken ideas for the coordinator's voice source (src/intake/voice.ts). */
export const voiceInboxDir = (stateDir: string) => join(stateDir, 'voice', 'inbox');

/** The longest spoken idea taken (a few minutes of talking). */
export const VOICE_MAX_CHARS = 4000;
