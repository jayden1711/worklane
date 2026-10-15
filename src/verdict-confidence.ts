// The evaluator's confidence, with its reason (#471). A confidence that isn't high must say why, naming the one
// thing left unverified or the problem found: a verdict without that reason is refused, and the evaluator is asked
// once more. For a change to a protected surface the evaluator also answers the "compromised component" question for
// every actor that can reach it; a missing or unacceptable answer is a doubt with that reason, never a high pass.
// Pure: the coordinator runs the evaluator around these (src/coordinator.ts evaluate).
import { lowerConfidence } from './receipts.js';
import { COMPROMISED_ACTORS, OTHER_ACTOR } from './roles.js';

export { OTHER_ACTOR };

export type Confidence = 'high' | 'medium' | 'low';

/** The actors the "compromised component" question asks about (src/roles.ts, where the evaluator's schema names them). */
export const ACTORS = COMPROMISED_ACTORS;
export type Actor = (typeof ACTORS)[number][0];

/** One actor's answer: what it can do through the change if compromised or hostile, and whether that's acceptable. */
export interface CompromisedAnswer {
  actor: string;
  can_do: string;
  acceptable: boolean;
  why: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (x: unknown) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');

/** The longest reason recorded (eval.verdict's bound). */
export const REASON_MAX = 2000;

/**
 * Why a verdict is refused as given: a confidence other than high without a reason. Null: accepted. The text is what
 * the evaluator is told when it's asked once more.
 */
export function verdictRefusal(s: { confidence?: unknown; confidence_reason?: unknown } | undefined): string | null {
  if (!s || s.confidence === 'high' || (s.confidence !== 'medium' && s.confidence !== 'low')) return null;
  if (text(s.confidence_reason)) return null;
  return `Your verdict was refused: confidence ${s.confidence} needs confidence_reason, one sentence naming the specific thing you could not verify or the likely problem you found. Give the whole verdict again.`;
}

/**
 * For a change to a protected surface: one doubt per actor whose answer is missing or empty, and per answer that says
 * what the actor can do is not acceptable. Empty for a change to no protected surface, or when every actor's answer
 * holds.
 */
export function compromisedDoubts(answers: unknown, protectedSurface: boolean): string[] {
  if (!protectedSurface) return [];
  const list = (Array.isArray(answers) ? answers : []).filter((a): a is Record<string, unknown> => !!a && typeof a === 'object');
  const out: string[] = [];
  const missing: string[] = [];
  for (const [key, words] of ACTORS) {
    const a = list.find((x) => x.actor === key);
    if (!a || !text(a.can_do) || !text(a.why) || typeof a.acceptable !== 'boolean') missing.push(words);
  }
  if (missing.length) out.push(`compromised component: no answer for ${missing.join(', ')}`);
  for (const a of list) {
    if (a.acceptable !== false) continue;
    const who = ACTORS.find(([k]) => k === a.actor)?.[1] ?? (text(a.actor) || OTHER_ACTOR);
    out.push(`compromised component: ${clip(who, 120)} can ${clip(text(a.can_do) || 'act through it', 300)}, which is not acceptable${text(a.why) ? `: ${clip(text(a.why), 300)}` : ''}`);
  }
  return out;
}

/**
 * The confidence recorded and its reason. The evaluator's own, lowered for claims no record backs (never evidence)
 * and, for a protected surface, to at most medium by any compromised-component doubt. A confidence other than high
 * always has a reason: the evaluator's, what lowered it, or, when it gave none even when asked again, that it gave none.
 */
export function calibrated(o: { confidence: Confidence; reason?: unknown; unverified: number; compromised: string[] }): { confidence: Confidence; confidence_reason?: string } {
  let confidence = lowerConfidence(o.confidence, o.unverified);
  if (o.compromised.length && confidence === 'high') confidence = 'medium';
  if (confidence === 'high') return { confidence };
  const own = o.confidence !== 'high' ? text(o.reason) : '';
  const parts = [
    ...(own ? [own] : []),
    ...(o.unverified ? [`lowered: ${o.unverified} unverified claim(s)`] : []),
    ...o.compromised,
  ];
  if (!parts.length) parts.push(`the evaluator gave no reason for confidence ${o.confidence}, even when asked again`);
  return { confidence, confidence_reason: clip(parts.join('; '), REASON_MAX) };
}

/** The brief line for a change to a protected surface: what it touches, and the question to answer for each actor. */
export function protectedBrief(why: string[]): string {
  return [
    `PROTECTED SURFACE: this change ${why.slice(0, 6).join('; ')}${why.length > 6 ? `; and ${why.length - 6} more` : ''}.`,
    `Answer compromised_component for each actor (${ACTORS.map(([k, w]) => `${k}: ${w}`).join('; ')}), plus any other actor the change exposes it to (actor "${OTHER_ACTOR}", named in can_do): what it can do through this change if it is compromised or hostile, whether that is acceptable, and why (or what stops it).`,
  ].join('\n');
}
