import type { EventPayload } from './events/types.js';
import type { Role } from './dashboard-auth.js';
/** How long a spoken confirm stays open; the dashboard's banner counts it down (web/src/voice/commands.ts). */
export declare const VOICE_WINDOW_MS = 10000;
/** The audit's mark on everything done by voice. */
export declare const BY_VOICE = "voice";
/** What a request says about voice: nothing (an ordinary click), or that it came by voice, with its tab's state. */
export type VoiceClaim = {
    voice: false;
} | {
    voice: true;
    focused: boolean;
    visible: boolean;
};
/**
 * The request's voice claim. Any `voice` field at all, whatever its shape, is a voice request: a malformed one is
 * refused as voice, never treated as a click. Only an exact `true` counts as focused or visible.
 */
export declare function voiceClaim(body: unknown): VoiceClaim;
/** Why a voice request is refused for this person and tab, or null: owners only, from a focused and visible tab. */
export declare function voiceRefusal(who: {
    login: string;
    role: Role;
}, claim: Extract<VoiceClaim, {
    voice: true;
}>, repo: string): string | null;
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
export declare function voiceExclusion(q: {
    id: string;
    kind: string;
    receipts: readonly string[];
}, posted?: readonly Pick<EventPayload<'plan.posted'>, 'decision' | 'reasons'>[]): string | null;
/** Where the dashboard leaves confirmed spoken ideas for the coordinator's voice source (src/intake/voice.ts). */
export declare const voiceInboxDir: (stateDir: string) => string;
/** The longest spoken idea taken (a few minutes of talking). */
export declare const VOICE_MAX_CHARS = 4000;
