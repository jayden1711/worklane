// What the intake agent may return, and what the pipeline accepts from it. The
// agent reads untrusted report text, so its output is a fixed shape: a triage
// kind, an optional duplicate/group target, a reproduction result, an issue draft
// and a reply. It has no field for labels, trust, config or decisions, and any
// such field it returns anyway is dropped and named.
import { parseContract } from '../backlog/types.js';
import { TRIAGE_KINDS, type TriageKind } from './report.js';

export const INTAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: [...TRIAGE_KINDS] },
    duplicate_of: { type: 'integer', minimum: 1, description: 'An open issue this report is the same bug or request as.' },
    group_with: { type: 'string', description: 'A recent report id this belongs with, when no issue exists yet.' },
    reproduction: {
      type: 'object',
      additionalProperties: false,
      required: ['result', 'detail'],
      properties: {
        result: { type: 'string', enum: ['reproduced', 'not_reproduced', 'fixed_on_main', 'not_tried'] },
        detail: { type: 'string' },
        commit: { type: 'string' },
      },
    },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: { title: { type: 'string' }, body: { type: 'string', description: 'Markdown with a closed ```done_when block; commands as YAML block scalars (|).' } },
    },
    reply: { type: 'string', description: 'What to ask the reporter, for needs_info or not_actionable. Short and polite; no internal details.' },
  },
} as const;

export interface Triage {
  kind: TriageKind;
  duplicate_of?: number;
  group_with?: string;
  reproduction?: { result: 'reproduced' | 'not_reproduced' | 'fixed_on_main' | 'not_tried'; detail: string; commit?: string };
  draft?: { title: string; body: string };
  reply?: string;
}

const ALLOWED = new Set(['kind', 'duplicate_of', 'group_with', 'reproduction', 'draft', 'reply']);

/** The agent's output as the pipeline takes it: only the known fields, each checked; everything else dropped and named. */
export function acceptTriage(raw: unknown): { ok: true; triage: Triage; dropped: string[] } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'not an object' };
  const o = raw as Record<string, unknown>;
  const dropped = Object.keys(o).filter((k) => !ALLOWED.has(k));
  if (!TRIAGE_KINDS.includes(o.kind as TriageKind)) return { ok: false, why: `unknown kind ${JSON.stringify(o.kind)}` };
  const t: Triage = { kind: o.kind as TriageKind };
  if (Number.isInteger(o.duplicate_of) && (o.duplicate_of as number) > 0) t.duplicate_of = o.duplicate_of as number;
  if (typeof o.group_with === 'string' && /^[0-9a-f]{20}$/.test(o.group_with)) t.group_with = o.group_with;
  const rep = o.reproduction as Record<string, unknown> | undefined;
  if (rep && typeof rep === 'object' && ['reproduced', 'not_reproduced', 'fixed_on_main', 'not_tried'].includes(rep.result as string) && typeof rep.detail === 'string') {
    t.reproduction = { result: rep.result as NonNullable<Triage['reproduction']>['result'], detail: rep.detail.slice(0, 2000), ...(typeof rep.commit === 'string' && /^[0-9a-f]{7,40}$/.test(rep.commit) ? { commit: rep.commit } : {}) };
  }
  const d = o.draft as Record<string, unknown> | undefined;
  if (d && typeof d === 'object' && typeof d.title === 'string' && typeof d.body === 'string') t.draft = { title: d.title.slice(0, 200), body: d.body.slice(0, 20_000) };
  if (typeof o.reply === 'string') t.reply = o.reply.slice(0, 600);
  return { ok: true, triage: t, dropped };
}

/**
 * Is a draft fileable? Its done_when must parse with the engine's contract parser, and every command must be written
 * as a YAML block scalar (`command: |`), which keeps quoting and colons inside commands from breaking the block.
 */
export function checkDraft(draft: { title: string; body: string }): { ok: true } | { ok: false; why: string } {
  if (!draft.title.trim()) return { ok: false, why: 'the draft has no title' };
  const c = parseContract(draft.body);
  if (!c.ok) return { ok: false, why: c.why };
  const block = draft.body.match(/```done_when\s*\n([\s\S]*?)\n```/)![1]!;
  const inline = block.split('\n').filter((l) => /^\s*-?\s*command:\s*\S/.test(l) && !/^\s*-?\s*command:\s*[|>][-+]?\s*$/.test(l));
  if (inline.length) return { ok: false, why: `commands must be YAML block scalars (command: |), not inline: ${inline[0]!.trim()}` };
  return { ok: true };
}
