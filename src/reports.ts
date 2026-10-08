// Twice-daily reports, built only from the event log: what landed, what's
// in review, decisions waiting (with owner), what's blocked and why, spend,
// and the scorecard with changes since the last report. Short, no padding.
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import type { StoredEvent } from './events/types.js';
import { project } from './projection.js';
import { scorecard, type Scorecard } from './scorecard.js';

const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(h < 10 ? 1 : 0)}h`);
const money = (n: number) => `$${n.toFixed(2)}`;

export interface Report {
  markdown: string;
  card: Scorecard;
}

const CARD_ROWS: [keyof Scorecard, string, 'up-good' | 'down-good'][] = [
  ['tasksDone', 'tasks done (7d)', 'up-good'],
  ['evaluatorPassRate', 'evaluator pass rate', 'up-good'],
  ['unverifiedClaimRate', 'unverified claims', 'down-good'],
  ['reverts', 'reverts', 'down-good'],
  ['baselineGrowth', 'new reds on main', 'down-good'],
  ['costPerDoneUsd', 'cost per done task', 'down-good'],
  ['readyToDoneHours', 'ready to done (median h)', 'down-good'],
  ['idleHours', 'idle hours (work waiting, nothing running)', 'down-good'],
  ['decisionWaitHours', 'hours decisions waited on owners', 'down-good'],
  ['blockedHours', 'hours tasks sat blocked', 'down-good'],
];

export function buildReport(events: StoredEvent[], cfg: Config, opts: { since: Date; now?: Date; previous?: Scorecard | null; slot?: string }): Report {
  const now = opts.now ?? new Date();
  const since = opts.since.getTime();
  const after = (e: StoredEvent) => Date.parse(e.ts) > since;
  const p = project(events, now.toISOString().slice(0, 10));
  const title = (n: number) => p.tasks.find((t) => t.issue === n)?.title ?? `#${n}`;
  const owner = (n: number) => p.tasks.find((t) => t.issue === n)?.owner;
  const lines: string[] = [];
  const day = now.toLocaleDateString('en-CA');
  lines.push(`## ${BRAND.name} report: ${cfg.project.project.name}, ${day}${opts.slot ? ` ${opts.slot}` : ''}`);

  const landed = events.filter((e) => after(e) && e.type === 'land.result' && (e.payload as { outcome: string }).outcome === 'landed');
  const deployed = new Map(events.filter((e) => e.type === 'deploy.verified').map((e) => [(e.payload as { sha: string }).sha, (e.payload as { env: string }).env]));
  lines.push('', `**Landed** (${landed.length})`);
  if (!landed.length) lines.push('- nothing');
  for (const e of landed) {
    const { issue, landed: sha } = e.payload as { issue: number; landed: string };
    const env = deployed.get(sha);
    lines.push(`- #${issue} ${title(issue)} (@${owner(issue) ?? '?'}) \`${sha.slice(0, 8)}\`${env ? `, serving on ${env}` : cfg.deploy?.environments.some((x) => !x.production) ? ', **not yet verified on staging**' : ''}`);
  }

  const review = p.tasks.filter((t) => ['verifying', 'evaluating', 'queued'].includes(t.status));
  lines.push('', `**In review** (${review.length})`);
  if (!review.length) lines.push('- nothing');
  for (const t of review) lines.push(`- #${t.issue} ${t.title}: ${t.status}${t.level ? `, ${t.level}` : ''} (@${t.owner ?? '?'})`);

  const open = p.decisions.filter((d) => !d.answer);
  lines.push('', `**Decisions needed** (${open.length})`);
  if (!open.length) lines.push('- none');
  for (const d of open) lines.push(`- @${d.owner}: ${d.issue !== null ? `#${d.issue} ` : ''}${d.question} (waiting ${fmtH((now.getTime() - Date.parse(d.askedAt)) / 3_600_000)}; recommended: ${d.recommendation})`);

  const blocked = p.tasks.filter((t) => t.status === 'blocked');
  lines.push('', `**Blocked** (${blocked.length})`);
  if (!blocked.length) lines.push('- nothing');
  for (const t of blocked) lines.push(`- #${t.issue} ${t.title} (@${t.owner ?? '?'}): ${(t.blockedReason ?? '').split('\n')[0]!.slice(0, 200)}`);

  const spendSince = events.filter((e) => after(e) && e.type === 'run.cost').reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
  lines.push('', `**Spend**: ${money(spendSince)} since the last report; ${money(p.spendToday)} today of ${money(cfg.agents.daily_budget_usd)}.`);

  const holds = events.filter((e) => after(e) && e.type === 'governor.hold').map((e) => (e.payload as { reason: string }).reason);
  if (holds.length) lines.push('', `**Machine**: dispatch held ${holds.length} time(s): ${[...new Set(holds)].slice(0, 3).join('; ')}.`);

  const card = scorecard(events, { from: new Date(now.getTime() - 7 * 86_400_000), to: now });
  lines.push('', '**Scorecard (7 days)**', '', '| metric | now | change |', '|---|---|---|');
  for (const [k, label, dir] of CARD_ROWS) {
    const v = card[k] as number | null;
    const prev = opts.previous ? (opts.previous[k] as number | null) : null;
    let change = '';
    if (v !== null && prev !== null && v !== prev) {
      const better = dir === 'up-good' ? v > prev : v < prev;
      change = `${v > prev ? '+' : ''}${Math.round((v - prev) * 100) / 100} ${better ? '(better)' : '(worse)'}`;
    }
    lines.push(`| ${label} | ${v === null ? '-' : v} | ${change} |`);
  }
  return { markdown: lines.join('\n'), card };
}

/** The report slot due now (latest configured time already passed today), or null. */
export function dueSlot(times: string[], now = new Date()): string | null {
  const mins = now.getHours() * 60 + now.getMinutes();
  const passed = times.filter((t) => {
    const [h, m] = t.split(':').map(Number) as [number, number];
    return h * 60 + m <= mins;
  });
  return passed.sort().at(-1) ?? null;
}
