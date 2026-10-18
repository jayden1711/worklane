// The review packet: the one comment a PR that waits for the owner gets (merge-flow.ts waitForOwner), sized for a
// phone. On top, every reason it waits, its risk class, the evaluator's verdict, the eval scores and a receipts
// summary, together at most PACKET_VISIBLE_MAX characters; below, a collapsed "Full details" section with the whole of
// each. Pure text: it decides nothing (whether and when a PR waits is the merge policy's call before this runs), and
// it offers no way to approve but the ones that already exist (a GitHub review, or the owner's chat approval).
import { BRAND } from '../brand.js';
import type { DoneWhenList } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import type { RiskClass } from '../pr-rules.js';
import { receiptLines, receiptSummary, type CheckRecord } from '../receipts.js';
import { evalLines } from './shared.js';

/** The most characters shown above "Full details": about one phone screen of GitHub's mobile app. */
export const PACKET_VISIBLE_MAX = 1200;
/** The most characters in the "Full details" section (GitHub refuses a comment over 65,536). */
export const PACKET_DETAILS_MAX = 20_000;
/** Each summary line shown on top, and each wait reason there, at most this long (the whole is below). */
const LINE_MAX = 160;

export interface PacketInput {
  owner: string;
  /** What the owner is asked to do (review and merge, or approve under batching). */
  ask: string;
  head: string;
  reasons: string[];
  advice?: string | undefined;
  /** The risk class at this head, and why; null when it couldn't be computed. */
  risk: { cls: RiskClass; why: string[] } | null;
  verdict?: EventPayload<'eval.verdict'> | undefined;
  evals: EventPayload<'instructions.eval'>[];
  receipts: { checks: CheckRecord[]; doneWhen: DoneWhenList; unverified: string[]; head?: string | undefined } | null;
}

/** One line: whitespace folded, so text an agent wrote can't start a line of its own (a forged "Risk class:"). */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const short = (sha: string) => sha.slice(0, 8);
/** Text that can't open or close a collapsed section: only the packet's own "Full details" does. */
const tagSafe = (s: string) => s.replace(/<(\/?)(details|summary)\b/gi, '&lt;$1$2');
/** The evaluator's advice in the details: quoted line by line, so no line of it reads as the packet's own. */
const quoted = (s: string) => s.split('\n').map((l) => `> ${l}`).join('\n');

function riskLine(risk: PacketInput['risk'], whyMax: number): string {
  if (!risk) return '**Risk class:** unknown (it could not be computed at this head)';
  const why = risk.why.length ? ` (${risk.why.join('; ')})` : '';
  return `**Risk class:** ${risk.cls}${why.length > whyMax ? `${why.slice(0, whyMax - 2)}…)` : why}`;
}

function verdictLine(v: PacketInput['verdict'], head: string): string {
  if (!v) return '**Evaluator:** no verdict';
  const at = v.head === head ? '' : ` (on \`${short(v.head)}\`)`;
  const cf = v.cross_family;
  const cross = !cf ? '' : cf.outcome === 'not_run' ? `; cross-family (${cf.provider}): not run` : `; cross-family (${cf.provider}): ${cf.outcome === 'agrees' ? 'agrees' : 'DISAGREES'}`;
  return `**Evaluator:** ${v.patch_correct ? 'approves' : 'rejects'}, confidence ${v.confidence}${at}${cross}`;
}

function evalsLine(evals: PacketInput['evals']): string | null {
  if (!evals.length) return null;
  const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');
  const each = evals.map((r) => {
    if (r.error) return `${r.target}: not evaluated`;
    const h = r.held_out;
    const held = h === undefined ? '' : h === null ? ', held-out none' : `, held-out ${score(h.base)} → ${score(h.result)}${h.dropped ? ' LOWER' : ''}`;
    return `${r.target} ${score(r.base)} → ${score(r.result)}${r.dropped ? ' LOWER' : ''}${held}`;
  });
  return `**Evals:** ${each.join('; ')}`;
}

function receiptsLine(r: PacketInput['receipts'], head: string): string {
  if (!r) return '**Receipts:** none recorded';
  return `**Receipts:** ${receiptSummary(r)}${r.head && r.head !== head ? ` (on \`${short(r.head)}\`)` : ''}`;
}

/**
 * The waiting comment. The top keeps the first line the owner has always seen, then as many wait reasons as fit
 * (each cut to one line), the risk class, the evaluator, the evals and the receipts; whatever didn't fit is counted
 * there and given in full under "Full details". The top never exceeds PACKET_VISIBLE_MAX.
 */
export function reviewPacket(o: PacketInput): string {
  const header = `[${BRAND.cli}] @${o.owner} ready, and ${o.ask} (\`${short(o.head)}\`):`;
  const reasons = o.reasons.map((r) => `- ${cut(oneLine(r), LINE_MAX)}`);
  const summary = [riskLine(o.risk, LINE_MAX - 40), verdictLine(o.verdict, o.head), evalsLine(o.evals), receiptsLine(o.receipts, o.head)].filter((l): l is string => l !== null).map((l) => cut(l, LINE_MAX));
  const advice = o.advice?.trim() ? `**Evaluator's advice:** ${cut(oneLine(o.advice), LINE_MAX)}` : null;
  const len = (lines: string[]) => lines.join('\n').length;
  const note = (hidden: number) => `*${hidden ? `${hidden} more reason${hidden === 1 ? '' : 's'}, and ` : ''}the whole of each: under Full details below.*`;
  // Reasons first, as many as fit beside the summary lines and the note; the evaluator's advice only if there's room.
  // (A blank line after the reasons, or GitHub reads the next line as part of the last one.)
  let shown = reasons.length;
  while (shown > 0 && len([header, ...reasons.slice(0, shown), '', ...summary, note(reasons.length - shown)]) > PACKET_VISIBLE_MAX) shown--;
  const top = [header, ...reasons.slice(0, shown), '', ...summary];
  if (advice && len([...top, advice, note(reasons.length - shown)]) <= PACKET_VISIBLE_MAX) top.push(advice);
  top.push(note(reasons.length - shown));
  // A safety net the line caps above already keep: the top is never longer than the cap.
  const visible = cut(tagSafe(top.join('\n')), PACKET_VISIBLE_MAX);

  const details = [
    `**Every reason it waits (${o.reasons.length}):**`,
    ...o.reasons.map((r) => `- ${cut(oneLine(r), 1000)}`),
    '',
    riskLine(o.risk, Infinity),
    '',
    verdictLine(o.verdict, o.head),
    ...(o.verdict?.confidence_reason ? [`Why not high: ${cut(oneLine(o.verdict.confidence_reason), 1000)}`] : []),
    ...(o.verdict?.cross_family?.reason ? [`Cross-family: ${cut(oneLine(o.verdict.cross_family.reason), 500)}`] : []),
    ...(o.advice?.trim() ? ['', "**Evaluator's advice:**", quoted(o.advice.slice(0, 1500))] : []),
    ...(o.evals.length ? ['', ...evalLines(o.evals)] : []),
    '',
    ...(o.receipts ? receiptLines(o.receipts) : ['**Receipts:** none recorded']),
    '',
    'The PR description has the full receipts and the labeled claims.',
  ].join('\n');
  return `${visible}\n\n<details><summary>Full details</summary>\n\n${cut(tagSafe(details), PACKET_DETAILS_MAX)}\n\n</details>`;
}

/** The part of a packet shown above "Full details": what the length cap holds. */
export function packetTop(packet: string): string {
  const at = packet.indexOf('\n\n<details>');
  return at === -1 ? packet : packet.slice(0, at);
}
