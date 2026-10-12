// The gardener: on a schedule (default weekly, off-hours, within a capped budget), one read-only run scans the
// repo for tech debt and anti-patterns (dead code, duplicated logic, rule violations linters miss), beside what
// the event log already shows (files that keep conflicting, slow and flaky checks). Every finding is appended to
// one log issue per instance. A fix (a small cleanup, or a lint rule that stops the pattern coming back) is filed,
// as an issue the pipeline builds into a reviewed PR, only for a pattern seen 3 or more times, never twice, at
// most max_prs per run, and never for a pattern in a high-risk or safety-floor path. Pure.
import { checkDraftedIssue, DRAFT_FORMAT } from './backlog/types.js';
import { checkTimings } from './health.js';
import type { StoredEvent } from './events/types.js';

/** A pattern is fixed only once it has been seen this many times (distinct places, over every run). */
export const MIN_SIGHTINGS = 3;

export const FINDING_KINDS = ['dead_code', 'duplication', 'rule_violation', 'hotspot', 'slow_check', 'flaky_check'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  /** A stable slug for the pattern (kebab case), the same across runs: what sightings are counted by. */
  pattern: string;
  kind: FindingKind;
  /** Repo-relative paths (or check names) where it was seen. */
  where: string[];
  detail: string;
  /** The fix, as a five-part issue: a small cleanup or a lint rule that stops it coming back. */
  fix: { title: string; body: string } | null;
}

const HOUR = 3600_000;

/**
 * Due when enabled, at or after the day's `at` (local time) and within 3 hours of it (off-hours, never late in the
 * day), and the last run started at least `everyDays` days ago (less an hour, so a weekly run doesn't drift).
 */
export function gardenerDue(now: Date, lastRunAt: string | null, o: { everyDays: number; at: string }): boolean {
  const [h, m] = o.at.split(':').map(Number) as [number, number];
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (now.getTime() < slot.getTime() || now.getTime() >= slot.getTime() + 3 * HOUR) return false;
  return lastRunAt === null || now.getTime() - Date.parse(lastRunAt) >= o.everyDays * 24 * HOUR - HOUR;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9:._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** What the log already shows: files conflict fixes keep touching, slow or slowing checks, checks that flip on one commit. */
export function gardenerSignals(events: StoredEvent[]): Finding[] {
  const out: Finding[] = [];
  const conflicts = new Map<string, number>();
  for (const e of events) if (e.type === 'conflict_fix.finished') for (const f of (e.payload as { files?: string[] }).files ?? []) conflicts.set(f, (conflicts.get(f) ?? 0) + 1);
  for (const [file, n] of [...conflicts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10))
    out.push({ pattern: slug(`hotspot:${file}`), kind: 'hotspot', where: [file], detail: `${n} conflict fixes touched it`, fix: null });
  const t = checkTimings(events);
  for (const c of new Set([...t.regressions, ...t.slowest])) {
    const x = t.timings.find((y) => y.check === c)!;
    out.push({ pattern: slug(`slow-check:${c}`), kind: 'slow_check', where: [c], detail: `median ${Math.round(x.recentMedianMs / 1000)} s over the last runs${x.regression ? `, ${x.regression.slowerPct}% slower than before` : ''}`, fix: null });
  }
  const flips = new Map<string, Set<string>>();
  const byHead = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== 'check.result') continue;
    const p = e.payload as { head: string; checks: { check: string; status: string }[] };
    for (const c of p.checks) {
      if (c.status !== 'pass' && c.status !== 'fail') continue;
      const k = `${c.check}\0${p.head}`;
      const s = byHead.get(k) ?? new Set<string>();
      s.add(c.status);
      byHead.set(k, s);
      if (s.size === 2) flips.set(c.check, (flips.get(c.check) ?? new Set()).add(p.head));
    }
  }
  for (const [check, heads] of flips) out.push({ pattern: slug(`flaky-check:${check}`), kind: 'flaky_check', where: [check], detail: `passed and failed on the same commit (${heads.size} commit(s))`, fix: null });
  return out;
}

export const GARDENER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern', 'kind', 'where', 'detail', 'fix_title', 'fix_body'],
        properties: {
          pattern: { type: 'string', description: 'A short stable slug for the pattern, the same one each run sees it (reuse a listed earlier one).' },
          kind: { type: 'string', enum: [...FINDING_KINDS] },
          where: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths (or check names) where you saw it, each one you checked.' },
          detail: { type: 'string', description: 'What is wrong there, in a sentence or two, with the evidence.' },
          fix_title: { type: 'string', description: 'The fix issue title: a small cleanup or a lint rule that stops it coming back. Empty if none.' },
          fix_body: { type: 'string', description: `The fix issue body, in the ${DRAFT_FORMAT} Empty if none.` },
        },
      },
    },
  },
} as const;

/** The run's findings, checked: a known kind, a pattern, at least one place; a fix only as a valid five-part draft. */
export function readFindings(s: unknown): { findings: Finding[]; refused: string[] } {
  const list = ((s ?? {}) as { findings?: unknown[] }).findings;
  const findings: Finding[] = [];
  const refused: string[] = [];
  for (const raw of Array.isArray(list) ? list.slice(0, 50) : []) {
    const f = raw as Record<string, unknown>;
    const pattern = slug(String(f.pattern ?? ''));
    const kind = f.kind as FindingKind;
    const where = Array.isArray(f.where) ? f.where.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map((w) => w.trim().replace(/^\.\//, '')).slice(0, 20) : [];
    if (!pattern || !FINDING_KINDS.includes(kind) || !where.length) {
      refused.push(`a finding without a pattern, kind or place (${pattern || '?'})`);
      continue;
    }
    const title = String(f.fix_title ?? '').trim();
    const body = String(f.fix_body ?? '').trim();
    let fix: Finding['fix'] = null;
    if (title || body) {
      const c = checkDraftedIssue(title, body);
      if (c.ok) fix = { title, body };
      else refused.push(`${pattern}: its fix isn't a valid draft (${c.why})`);
    }
    findings.push({ pattern, kind, where, detail: String(f.detail ?? '').slice(0, 1000), fix });
  }
  return { findings, refused };
}

/** Each pattern's sightings so far (distinct places over every run's findings), and the patterns already filed. */
export function patternHistory(events: { type: string; payload: unknown }[]): { sightings: Map<string, Set<string>>; filed: Map<string, number> } {
  const sightings = new Map<string, Set<string>>();
  const filed = new Map<string, number>();
  for (const e of events) {
    const p = e.payload as { pattern?: string; where?: string[]; issue?: number };
    if (e.type === 'gardener.finding' && p.pattern) for (const w of p.where ?? []) (sightings.get(p.pattern) ?? sightings.set(p.pattern, new Set()).get(p.pattern)!).add(w);
    else if (e.type === 'gardener.filed' && p.pattern) filed.set(p.pattern, p.issue!);
  }
  return { sightings, filed };
}

/**
 * Which findings get a fix filed this run: a pattern seen MIN_SIGHTINGS+ times (with this run's places), never filed
 * before, with a valid fix, and nowhere in a protected path; at most `maxPrs`, most-seen first. The rest say why not.
 */
export function toFile(findings: Finding[], history: ReturnType<typeof patternHistory>, o: { maxPrs: number; isProtected: (path: string) => boolean }): { file: Finding[]; held: { pattern: string; why: string }[] } {
  const seen = (f: Finding) => new Set([...(history.sightings.get(f.pattern) ?? []), ...f.where]).size;
  const held: { pattern: string; why: string }[] = [];
  const eligible: Finding[] = [];
  for (const f of findings) {
    if (history.filed.has(f.pattern)) held.push({ pattern: f.pattern, why: `already filed as #${history.filed.get(f.pattern)}` });
    else if (seen(f) < MIN_SIGHTINGS) held.push({ pattern: f.pattern, why: `seen ${seen(f)} time(s); a fix is filed from ${MIN_SIGHTINGS}` });
    else if (!f.fix) held.push({ pattern: f.pattern, why: 'no fix proposed' });
    else if (f.where.some(o.isProtected)) held.push({ pattern: f.pattern, why: 'it is in a high-risk or safety-floor path: logged only, never fixed by the gardener' });
    else eligible.push(f);
  }
  eligible.sort((a, b) => seen(b) - seen(a));
  for (const f of eligible.slice(o.maxPrs)) held.push({ pattern: f.pattern, why: `over this run's limit of ${o.maxPrs} fix(es); next run` });
  return { file: eligible.slice(0, o.maxPrs), held };
}

/** The gardener's brief: what the log shows, the patterns it has seen before, and what to look for. */
export function gardenerBrief(signals: Finding[], history: ReturnType<typeof patternHistory>): string {
  return [
    'Scan this repository, read-only, for tech debt and anti-patterns: dead code (unused exports, unreachable branches, files nothing imports), duplicated logic (the same rule written in several places), and violations of the repo\'s own rules (AGENTS.md, CLAUDE.md, skills, the config folder) that its linters miss.',
    `A fix is filed only for a pattern seen ${MIN_SIGHTINGS} or more times; reuse an earlier pattern's slug when you see it again. Propose a fix only as a small cleanup or a lint rule that stops the pattern coming back.`,
    '',
    signals.length ? 'What the event log already shows (report these too, with a fix if one fits):' : 'The event log shows no conflict hotspots, slow or flaky checks.',
    ...signals.map((s) => `- ${s.pattern} (${s.kind}): ${s.where.join(', ')}: ${s.detail}`),
    '',
    history.sightings.size ? 'Patterns seen before (slug: places):' : 'No patterns seen before.',
    ...[...history.sightings].slice(-50).map(([p, w]) => `- ${p}: ${[...w].slice(0, 5).join(', ')}${w.size > 5 ? ` and ${w.size - 5} more` : ''}${history.filed.has(p) ? ` (fix filed as #${history.filed.get(p)})` : ''}`),
  ].join('\n');
}

export const GARDENER_LOG_LABEL = 'gardener-log';
export const GARDENER_LABEL = 'gardener';
export const gardenerLogMarker = (instance: string) => `<!-- gardener-log:${instance} -->`;

/** One run's entry in the log issue. */
export function logEntry(o: { at: string; findings: Finding[]; filed: { pattern: string; issue: number }[]; held: { pattern: string; why: string }[]; refused: string[]; costUsd: number }): string {
  const filed = new Map(o.filed.map((f) => [f.pattern, f.issue]));
  const held = new Map(o.held.map((h) => [h.pattern, h.why]));
  return [
    `### Gardener run, ${o.at.slice(0, 16).replace('T', ' ')} UTC ($${o.costUsd.toFixed(2)})`,
    o.findings.length ? '' : 'Nothing found.',
    ...o.findings.map((f) => `- **${f.pattern}** (${f.kind.replace('_', ' ')}): ${f.where.slice(0, 5).map((w) => `\`${w}\``).join(', ')}${f.where.length > 5 ? ` and ${f.where.length - 5} more` : ''}. ${f.detail}${filed.has(f.pattern) ? ` → fix filed as #${filed.get(f.pattern)}` : held.has(f.pattern) ? ` (${held.get(f.pattern)})` : ''}`),
    ...(o.refused.length ? ['', 'Refused from the run:', ...o.refused.map((r) => `- ${r}`)] : []),
  ].join('\n');
}

/** The dashboard's view: each run, what it logged and filed; each pattern, how often seen and whether filed. */
export interface GardenerView {
  logIssue: number | null;
  runs: { at: string; findings: number; filed: number[]; costUsd: number; outcome: string }[];
  patterns: { pattern: string; kind: string; sightings: number; places: string[]; filed: number | null; lastSeen: string }[];
}

export function gardenerView(events: { ts: string; type: string; payload: unknown }[]): GardenerView {
  const runs: GardenerView['runs'] = [];
  const patterns = new Map<string, GardenerView['patterns'][number]>();
  let logIssue: number | null = null;
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'gardener.run') {
      runs.push({ at: (p.started_at as string | undefined) ?? e.ts, findings: p.findings as number, filed: p.filed as number[], costUsd: p.cost_usd as number, outcome: p.outcome as string });
      if (p.log_issue) logIssue = p.log_issue as number;
    } else if (e.type === 'gardener.finding') {
      const x = patterns.get(p.pattern as string) ?? { pattern: p.pattern as string, kind: p.kind as string, sightings: 0, places: [], filed: null, lastSeen: e.ts };
      x.places = [...new Set([...x.places, ...(p.where as string[])])];
      x.sightings = x.places.length;
      x.lastSeen = e.ts;
      patterns.set(x.pattern, x);
    } else if (e.type === 'gardener.filed') {
      const x = patterns.get(p.pattern as string);
      if (x) x.filed = p.issue as number;
    }
  }
  return { logIssue, runs: runs.reverse(), patterns: [...patterns.values()].sort((a, b) => b.sightings - a.sightings) };
}
