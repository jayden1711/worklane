// Every claim an agent hands the owner is labeled: measured (it ran the command or check and read the output),
// inferred (reasoned from code or evidence, not run) or guess. The worker's and the evaluator's output schemas carry
// the labeled claims (src/roles.ts); a verdict without them is refused and the evaluator asked once more
// (src/verdict-confidence.ts). And an agent never hands the owner a check it could run itself: a sentence that does
// ("please run", "you can verify by running") is a doubt on the change, so it waits for a human with that sentence.
// Pure: the coordinator reads these around its runs.

import { CLAIM_LABELS, type ClaimLabel } from './roles.js';

export { CLAIM_LABELS, LABELED_CLAIMS_FIELD, type ClaimLabel } from './roles.js';

export interface LabeledClaim {
  claim: string;
  label: ClaimLabel;
  /** measured: the command or check and what its output said; inferred: what it is reasoned from; guess: why. */
  basis: string;
}

const text = (x: unknown) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The labeled claims in an agent's output, and what is wrong with them: none given, a claim without one of the three
 * labels, or a measured claim that names no command or check. Problems are empty when every claim is labeled.
 */
export function readClaims(x: unknown): { claims: LabeledClaim[]; problems: string[] } {
  if (!Array.isArray(x) || !x.length) return { claims: [], problems: ['no labeled claims (each claim measured, inferred or guess)'] };
  const claims: LabeledClaim[] = [];
  const problems: string[] = [];
  for (const c of x as Record<string, unknown>[]) {
    const claim = clip(text(c?.claim), 500);
    const label = c?.label as ClaimLabel;
    const basis = clip(text(c?.basis), 500);
    if (!claim) continue;
    if (!CLAIM_LABELS.includes(label)) {
      problems.push(`"${clip(claim, 120)}" has no label (measured, inferred or guess)`);
      continue;
    }
    if (label === 'measured' && !basis) problems.push(`"${clip(claim, 120)}" is labeled measured but names no command or check`);
    claims.push({ claim, label, basis });
  }
  if (!claims.length && !problems.length) problems.push('no labeled claims (each claim measured, inferred or guess)');
  return { claims, problems };
}

/**
 * Handing the reader a check: asking them to run, verify or test something, or saying it is left to them. Past tense
 * ("I ran", "verified by running") and reports of what was run are not handoffs.
 */
const HANDOFF = [
  /\bplease\s+(?:run|re-?run|verify|check|test|confirm|try)\b/i,
  /\byou\s+(?:can|could|should|may|might|will\s+need\s+to|need\s+to|have\s+to|'ll\s+need\s+to)\s+(?:manually\s+)?(?:run|verify|confirm|check|test|try)\b/i,
  /(?:^|[.!?:;]\s+)(?:to\s+(?:verify|confirm|check)(?:\s+(?:this|it|that))?,?\s+)?(?:run|try\s+running)\s+`[^`]+`\s+to\s+(?:verify|confirm|check|see)\b/i,
  /\bto\s+(?:verify|confirm)(?:\s+(?:this|it|that))?,\s+run\b/i,
  /\b(?:left|leave|leaving)\s+(?:it\s+)?(?:for|to)\s+(?:you|the\s+owner|the\s+reviewer|a\s+human|a\s+person)\s+to\s+(?:run|verify|check|test|confirm)\b/i,
  /\b(?:needs?|requires?)\s+(?:manual\s+)?(?:verification|testing|checking)\s+by\s+(?:you|the\s+owner|the\s+reviewer|a\s+human|a\s+person)\b/i,
];

/** The sentences of `text` that hand the reader a check to run (at most 5, each at most 300 characters). */
export function handoffs(...texts: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const s of (t ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) {
      if (HANDOFF.some((re) => re.test(s)) && !out.includes(clip(s.trim(), 300))) out.push(clip(s.trim(), 300));
    }
  }
  return out.slice(0, 5);
}

/** The doubt a handoff is: the change waits for a human, with the sentence. */
export const handoffDoubt = (who: string, sentences: string[]) =>
  `${who} handed the reader a check it could run itself instead of running it: ${sentences.map((s) => `"${clip(s, 200)}"`).join('; ')}`;

/** A PR body's lines for one agent's labeled claims. */
export function claimLines(who: string, claims: LabeledClaim[], problems: string[] = []): string[] {
  const md = (s: string) => s.replace(/`/g, "'");
  return [
    `**${who}:**`,
    ...(claims.length ? claims.slice(0, 15).map((c) => `- ${c.label}: ${md(c.claim)}${c.basis ? ` (${md(c.basis)})` : ''}`) : ['- none labeled']),
    ...(claims.length > 15 ? [`- and ${claims.length - 15} more`] : []),
    ...problems.slice(0, 5).map((p) => `- not labeled: ${md(p)}`),
  ];
}
