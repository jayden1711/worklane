// What a decision rests on, as decision.asked records it (DecisionContextSchema in src/events/types.ts): built here
// from what the coordinator holds when it asks, clipped to the schema's bounds so recording it can never fail the
// ask. Nothing is made up: a field the asker doesn't have is left out, and the dashboard's detail view says so.
import type { EventPayload } from './events/types.js';
import type { ChangeFile, LevelResult } from './review.js';

export type DecisionContext = NonNullable<EventPayload<'decision.asked'>['context']>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clipAll = (xs: readonly string[], n: number, max: number) => xs.slice(0, max).map((x) => clip(x, n));
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * The file and line a finding's evidence names, when it names one: the first `path:line` (or `path:line:col`, or
 * `path#Lline`) in it whose path has a directory or an extension. Null when it names none (a command and its output).
 */
export function findingLocation(evidence: string): { file: string; line: number } | null {
  const m = /(?:^|[\s(`'"[])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]+)(?::(\d+)(?::\d+)?|#L(\d+))\b/.exec(evidence);
  if (!m) return null;
  const line = Number(m[2] ?? m[3]);
  if (!Number.isInteger(line) || line < 1) return null;
  return { file: clip(m[1]!.replace(/^\.\//, ''), 500), line };
}

type Verdict = { patch_correct: boolean; test_correct: boolean; confidence: 'high' | 'medium' | 'low'; advice: string; confidence_reason?: string; unread?: string[]; unverified_claims?: string[]; design_change?: boolean; design_reason?: string };
type Check = { check: string; status: string; duration_ms?: number; tail?: string };
const CHECK_STATUS = new Set(['pass', 'fail', 'unavailable', 'skipped']);

/** A change asked about (a landing held for the owner): its commits, files, level and why, verdict and checks. */
export function changeContext(o: { base: string; head: string; files: readonly ChangeFile[]; level: LevelResult; verdict: Verdict; checks: readonly Check[]; tampered?: readonly string[] }): DecisionContext {
  const v = o.verdict;
  const categories = Object.fromEntries(
    Object.entries(o.level.categories)
      .filter(([k, files]) => files.length && k.length <= 100)
      .map(([k, files]) => [k, clipAll(files, 500, 50)]),
  );
  return {
    ...(SHA.test(o.base) ? { base: o.base } : {}),
    ...(SHA.test(o.head) ? { head: o.head } : {}),
    files: o.files.slice(0, 300).map((f) => ({ path: clip(f.path, 500), added: Math.max(0, Math.trunc(f.added)), removed: Math.max(0, Math.trunc(f.removed)) })),
    ...(o.files.length > 300 ? { files_more: o.files.length - 300 } : {}),
    level: o.level.level,
    level_reasons: clipAll(o.level.reasons, 1000, 50),
    categories,
    verdict: {
      patch_correct: v.patch_correct,
      test_correct: v.test_correct,
      confidence: v.confidence,
      advice: clip(v.advice ?? '', 4000),
      ...(v.confidence_reason?.trim() ? { confidence_reason: clip(v.confidence_reason.trim(), 2000) } : {}),
      ...(v.unread?.length ? { unread: clipAll(v.unread, 500, 100) } : {}),
      ...(v.unverified_claims?.length ? { unverified_claims: clipAll(v.unverified_claims, 1000, 50) } : {}),
      ...(v.design_change !== undefined ? { design_change: v.design_change } : {}),
      ...(v.design_reason?.trim() ? { design_reason: clip(v.design_reason.trim(), 2000) } : {}),
    },
    checks: o.checks
      .filter((c) => CHECK_STATUS.has(c.status))
      .slice(0, 100)
      .map((c) => ({ check: clip(c.check, 300), status: c.status as 'pass', ...(c.duration_ms !== undefined && c.duration_ms >= 0 ? { duration_ms: Math.trunc(c.duration_ms) } : {}), ...(c.tail ? { tail: clip(c.tail, 2000) } : {}) })),
    ...(o.tampered?.length ? { tampered: clipAll(o.tampered, 1000, 50) } : {}),
  };
}

const CONF = new Set(['high', 'medium', 'low']);

/** An investigation asked about: its answer, every finding (with the file and line its evidence names), its confidence and what it couldn't confirm. */
export function investigationContext(s: { summary?: string; findings?: { claim: string; evidence: string }[]; confidence?: string; unverified?: string[] }): DecisionContext {
  return {
    ...(s.summary?.trim() ? { summary: clip(s.summary.trim(), 8000) } : {}),
    findings: (s.findings ?? []).slice(0, 100).map((f) => {
      const at = findingLocation(String(f.evidence ?? ''));
      return { claim: clip(String(f.claim ?? ''), 4000), evidence: clip(String(f.evidence ?? ''), 4000), ...(at ? { file: at.file, line: at.line } : {}) };
    }),
    ...(s.confidence && CONF.has(s.confidence) ? { confidence: s.confidence as 'high' } : {}),
    ...(s.unverified?.length ? { unverified: clipAll(s.unverified, 1000, 50) } : {}),
  };
}

/** A worker's question: its summary of where the work stands, whole (the detail's first line keeps a copy). */
export function summaryContext(summary: string | undefined): DecisionContext | undefined {
  return summary?.trim() ? { summary: clip(summary.trim(), 8000) } : undefined;
}
