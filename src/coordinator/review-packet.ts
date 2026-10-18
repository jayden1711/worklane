// The review packet: the one comment a PR that waits for the owner gets (merge-flow.ts waitForOwner), sized for a
// phone. On top, every reason it waits, its risk class, the evaluator's verdict, the eval scores and a receipts
// summary, together at most PACKET_VISIBLE_MAX characters; below, a collapsed "Full details" section with the whole of
// each. Pure text: it decides nothing (whether and when a PR waits is the merge policy's call before this runs), and
// it offers no way to approve but the ones that already exist (a GitHub review, or the owner's chat approval).
//
// INVARIANT: every piece of text from the record (wait reasons, which quote agents; the advice; the confidence and
// cross-family reasons; paths, which an agent names; check names, claims and done_when items; eval targets, case ids
// and errors) reaches the comment only through `lit` or `fenced`: a code span or block with no backtick inside, so
// GitHub shows it as typed. No HTML (<br>, <img>, <details>), no link or image, no @mention, no emphasis, and no new
// line: it can't forge a packet line, hide one or push the summary off the screen. Lengths are measured on that final
// text. test/review-packet.test.ts pins what this module may import and call.
import { BRAND } from '../brand.js';
import type { DoneWhenList } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import type { RiskClass } from '../pr-rules.js';
import { receiptLines, receiptSummary, type CheckRecord } from '../receipts.js';

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

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const short = (sha: string) => sha.slice(0, 8);
/**
 * Text from the record as GitHub shows it verbatim: one line (whitespace folded), backticks turned into quotes, cut to
 * `max` characters, in a code span. Inside one, nothing is markup.
 */
export function lit(s: string, max = 1000): string {
  const t = cut(s.replace(/\s+/g, ' ').replace(/`/g, "'").trim(), Math.max(2, max - 2));
  return t ? `\`${t}\`` : "''";
}
/** Multi-line text from the record (the evaluator's advice), verbatim: a fenced block no line of it can close. */
function fenced(s: string, max: number): string[] {
  return ['```text', ...cut(s.replace(/`/g, "'").trim(), max).split('\n'), '```'];
}

function riskLine(risk: PacketInput['risk'], whyMax: number): string {
  if (!risk) return '**Risk class:** unknown (it could not be computed at this head)';
  return `**Risk class:** ${risk.cls}${risk.why.length ? ` (${lit(risk.why.join('; '), whyMax)})` : ''}`;
}

function verdictLine(v: PacketInput['verdict'], head: string): string {
  if (!v) return '**Evaluator:** no verdict';
  const at = v.head === head ? '' : ` (on \`${short(v.head)}\`)`;
  const cf = v.cross_family;
  const who = cf ? `cross-family (${lit(cf.provider, 40)})` : '';
  const cross = !cf ? '' : cf.outcome === 'not_run' ? `; ${who}: not run` : `; ${who}: ${cf.outcome === 'agrees' ? 'agrees' : 'DISAGREES'}`;
  return `**Evaluator:** ${v.patch_correct ? 'approves' : 'rejects'}, confidence ${v.confidence}${at}${cross}`;
}

const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');

/** The eval scores on one line of at most LINE_MAX: as many targets as fit, whole (a cut never splits a code span), the rest counted. */
function evalsLine(evals: PacketInput['evals']): string | null {
  if (!evals.length) return null;
  const each = evals.map((r) => {
    if (r.error) return `${lit(r.target, 50)}: not evaluated`;
    const h = r.held_out;
    const held = h === undefined ? '' : h === null ? ', held-out none' : `, held-out ${score(h.base)} → ${score(h.result)}${h.dropped ? ' LOWER' : ''}`;
    return `${lit(r.target, 50)} ${score(r.base)} → ${score(r.result)}${r.dropped ? ' LOWER' : ''}${held}`;
  });
  const line = (n: number) => `**Evals:** ${each.slice(0, n).join('; ')}${n < each.length ? `; ${each.length - n} more` : ''}`;
  let n = each.length;
  while (n > 1 && line(n).length > LINE_MAX) n--;
  return line(n);
}

/** The instruction evals in full: each target's scores, the cases that changed, and why one wasn't evaluated. */
function evalDetails(evals: PacketInput['evals']): string[] {
  if (!evals.length) return [];
  const total = evals.reduce((s, r) => s + r.cost_usd, 0);
  return [
    `**Instruction evals** (base → head; ~$${total.toFixed(2)}, the CLI's cost estimate):`,
    ...evals.map((r) => {
      if (r.error) return `- ${lit(r.target, 200)}: not evaluated: ${lit(r.error, 300)}`;
      const changed = r.changes.filter((c) => !(c.base === 'pass' && c.head === 'pass')).map((c) => `case ${lit(c.id, 80)} ${lit(c.base, 20)} → ${lit(c.head, 20)}`);
      const h = r.held_out;
      const held = h === undefined ? '' : h === null ? `; held-out: none${r.held_out_error ? ` (${lit(r.held_out_error, 300)})` : ''}` : `; held-out ${score(h.base)} → ${score(h.result)}${h.dropped ? ', **lower**' : ''}${h.incomplete ? ', incomplete (cost cap)' : ''}`;
      return `- ${lit(r.target, 200)}: visible ${score(r.base)} → ${score(r.result)}${r.dropped ? ', **lower**' : ''}${r.incomplete ? ', incomplete (cost cap)' : ''}${changed.length ? `; ${changed.join(', ')}` : ''}${held}${r.samples ? `, ${r.samples} sample(s) per case` : ''} (~$${r.cost_usd.toFixed(2)})`;
    }),
  ];
}

function receiptsLine(r: PacketInput['receipts'], head: string): string {
  if (!r) return '**Receipts:** none recorded';
  return `**Receipts:** ${receiptSummary(r)}${r.head && r.head !== head ? ` (on \`${short(r.head)}\`)` : ''}`;
}

/** The three receipt sections, with the worker's claims and the manual done_when items made literal. */
function receiptDetails(r: NonNullable<PacketInput['receipts']>): string[] {
  const doneWhen = r.doneWhen.map((d) => ('manual' in d ? { ...d, manual: lit(String((d as { manual: unknown }).manual), 300) } : d)) as DoneWhenList;
  // receiptLines puts each check name in a code span of its own, and each claim in quotes: here a code span inside them.
  return receiptLines({ checks: r.checks.map((c) => ({ ...c, check: c.check.replace(/\s+/g, ' ').slice(0, 300) })), doneWhen, unverified: r.unverified.map((c) => lit(c, 300)) });
}

/**
 * The waiting comment. The top keeps the first line the owner has always seen, then as many wait reasons as fit
 * (each cut to one line), the risk class, the evaluator, the evals and the receipts; whatever didn't fit is counted
 * there and given in full under "Full details". The top never exceeds PACKET_VISIBLE_MAX.
 */
export function reviewPacket(o: PacketInput): string {
  const header = `[${BRAND.cli}] @${o.owner} ready, and ${o.ask} (\`${short(o.head)}\`):`;
  const reasons = o.reasons.map((r) => `- ${lit(r, LINE_MAX)}`);
  const summary = [riskLine(o.risk, LINE_MAX - 40), verdictLine(o.verdict, o.head), evalsLine(o.evals), receiptsLine(o.receipts, o.head)].filter((l): l is string => l !== null);
  const advice = o.advice?.trim() ? `**Evaluator's advice:** ${lit(o.advice, LINE_MAX)}` : null;
  const len = (lines: string[]) => lines.join('\n').length;
  const note = (hidden: number) => `*${hidden ? `${hidden} more reason${hidden === 1 ? '' : 's'}, and ` : ''}the whole of each: under Full details below.*`;
  // Reasons first, as many as fit beside the summary lines and the note; the evaluator's advice only if there's room.
  // (A blank line after the reasons, or GitHub reads the next line as part of the last one.)
  let shown = reasons.length;
  while (shown > 0 && len([header, ...reasons.slice(0, shown), '', ...summary, note(reasons.length - shown)]) > PACKET_VISIBLE_MAX) shown--;
  const top = [header, ...reasons.slice(0, shown), '', ...summary];
  if (advice && len([...top, advice, note(reasons.length - shown)]) <= PACKET_VISIBLE_MAX) top.push(advice);
  top.push(note(reasons.length - shown));
  // A safety net the caps above already keep (each summary line is bounded): whole lines off the end until the top
  // fits, never a cut through a code span; only the header, the packet's own text, is ever cut.
  while (top.length > 1 && len(top) > PACKET_VISIBLE_MAX) top.pop();
  const visible = cut(top.join('\n'), PACKET_VISIBLE_MAX);

  // The details: whole blocks only, up to the cap, so a cut never leaves a code block open.
  const blocks: string[][] = [
    [`**Every reason it waits (${o.reasons.length}):**`],
    ...o.reasons.map((r) => [`- ${lit(r, 1000)}`]),
    ['', riskLine(o.risk, 4000)],
    ['', verdictLine(o.verdict, o.head)],
    ...(o.verdict?.confidence_reason ? [[`Why not high: ${lit(o.verdict.confidence_reason, 1000)}`]] : []),
    ...(o.verdict?.cross_family?.reason ? [[`Cross-family: ${lit(o.verdict.cross_family.reason, 500)}`]] : []),
    ...(o.advice?.trim() ? [['', "**Evaluator's advice:**", ...fenced(o.advice, 1500)]] : []),
    ...(o.evals.length ? [['', ...evalDetails(o.evals)]] : []),
    ['', ...(o.receipts ? receiptDetails(o.receipts) : ['**Receipts:** none recorded'])],
  ];
  const end = ['', 'The PR description has the full receipts and the labeled claims.'];
  const details: string[] = [];
  for (const b of blocks) {
    if (len([...details, ...b, ...end]) > PACKET_DETAILS_MAX) {
      details.push('', '*(cut here: the rest is in the PR description and the event log)*');
      break;
    }
    details.push(...b);
  }
  return `${visible}\n\n<details><summary>Full details</summary>\n\n${[...details, ...end].join('\n')}\n\n</details>`;
}

/** The part of a packet shown above "Full details": what the length cap holds. */
export function packetTop(packet: string): string {
  const at = packet.indexOf('\n\n<details>');
  return at === -1 ? packet : packet.slice(0, at);
}
