// Twice-daily reports, built only from the event log: what landed, what's
// in review, decisions waiting (with owner), what's blocked and why, spend,
// and governor holds. Short, no padding.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import type { StoredEvent } from './events/types.js';
import { failureModes, failureModesMarkdown, mergeCostMarkdown, type FailureProposal } from './failure-modes.js';
import { mergeMetrics } from './merge-metrics.js';
import { project } from './projection.js';
import { readRun, RUNS_DIR, type RunRecord } from './run-record.js';

const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(h < 10 ? 1 : 0)}h`);
const money = (n: number) => `$${n.toFixed(2)}`;

export interface Report {
  markdown: string;
  /** Fixes proposed for repeated failures (weekly section only): for the owner to decide on. */
  proposals: FailureProposal[];
}

/** Run records that ended at or after `since`, from an instance's state dir (none if unreadable). */
export function recentRunRecords(stateDir: string, since: Date): RunRecord[] {
  let files: string[] = [];
  try {
    files = readdirSync(join(stateDir, RUNS_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const f of files) {
    const r = readRun(stateDir, f.slice(0, -'.json'.length));
    if (r && Date.parse(r.endedAt ?? r.startedAt) >= since.getTime()) out.push(r);
  }
  return out;
}

/** The weekly section goes in the first report of each Monday (and every preview, which has no slot). */
export function weeklyDue(times: string[], slot: string | undefined, now: Date): boolean {
  return !slot || (slot === [...times].sort()[0] && now.getDay() === 1);
}

/** A warning line for the coordinator's GitHub token: 7 days before it expires, or always if it never does. */
export function tokenWarning(expiresAt: string | null | undefined, now = new Date()): string | null {
  if (expiresAt === undefined) return null; // not known (no instance, or not checked)
  if (expiresAt === null) return '**GitHub token has no expiry.** Set one: replace it with a token that expires.';
  const days = Math.floor((Date.parse(expiresAt) - now.getTime()) / 86_400_000);
  if (days > 7) return null;
  return days < 0 ? `**GitHub token expired** on ${expiresAt.slice(0, 10)}. Replace it now.` : `**GitHub token expires in ${days} day(s)**, on ${expiresAt.slice(0, 10)}. Replace it before then.`;
}

/** A GitHub App's private key never expires, so it is rotated on a schedule instead. */
export const APP_KEY_ROTATE_DAYS = 90;

/** Days since the App key file was installed on this machine (rotating it installs a new file), or null if unreadable. */
export function appKeyAge(keyPath: string, now = new Date()): number | null {
  try {
    return Math.max(0, Math.floor((now.getTime() - statSync(keyPath).mtimeMs) / 86_400_000));
  } catch {
    return null;
  }
}

/** A warning line once the App key is due for rotation. */
export function appKeyWarning(days: number | null): string | null {
  if (days === null || days < APP_KEY_ROTATE_DAYS) return null;
  return `**GitHub App key installed ${days} days ago.** Rotate it: generate a new private key in the App's settings, install it with credentials.sh, then delete the old key there.`;
}

export function buildReport(events: StoredEvent[], cfg: Config, opts: { since: Date; now?: Date; slot?: string; tokenExpiresAt?: string | null; appKeyPath?: string; runRecords?: RunRecord[]; weekly?: boolean }): Report {
  const now = opts.now ?? new Date();
  const since = opts.since.getTime();
  const after = (e: StoredEvent) => Date.parse(e.ts) > since;
  const p = project(events, now.toISOString().slice(0, 10));
  const title = (n: number) => p.tasks.find((t) => t.issue === n)?.title ?? `#${n}`;
  const owner = (n: number) => p.tasks.find((t) => t.issue === n)?.owner;
  const lines: string[] = [];
  const day = now.toLocaleDateString('en-CA');
  lines.push(`## ${BRAND.name} report: ${cfg.project.project.name}, ${day}${opts.slot ? ` ${opts.slot}` : ''}`);
  const warn = tokenWarning(opts.tokenExpiresAt, now);
  if (warn) lines.push('', warn);
  const keyWarn = opts.appKeyPath ? appKeyWarning(appKeyAge(opts.appKeyPath, now)) : null;
  if (keyWarn) lines.push('', keyWarn);

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

  // Once a day (the first report of the day, and the preview): every auto-merge of the last 24 hours, with links.
  const first = [...cfg.project.reports.times].sort()[0];
  if (!opts.slot || opts.slot === first) {
    const dayAgo = now.getTime() - 86_400_000;
    const merged = events.filter((e) => e.type === 'merge.done' && Date.parse(e.ts) > dayAgo).map((e) => e.payload as { number: number; title: string; url: string; sha: string });
    lines.push('', `**Auto-merged, last 24 h** (${merged.length})`);
    if (!merged.length) lines.push('- nothing');
    for (const m of merged) lines.push(`- [#${m.number}](${m.url}) ${m.title} \`${m.sha.slice(0, 8)}\``);
  }
  const stop = events.filter((e) => e.type === 'merge.stopped' || e.type === 'merge.resumed').at(-1);
  if (stop?.type === 'merge.stopped') lines.push('', `**Auto-merge stopped**: ${(stop.payload as { reason: string }).reason}. Every PR waits for you until the operator clears it.`);

  // Instance settings the owner changed since the last report.
  const changed = events.filter((e) => after(e) && e.type === 'settings.changed').map((e) => e.payload as { key: string; from: unknown; to: unknown; by: string });
  if (changed.length) lines.push('', `**Settings changed** (${changed.length})`, ...changed.map((c) => `- ${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)} (@${c.by})`));

  // Usage, as the CLI estimates it: not billed money (a subscription isn't charged per run).
  const spendSince = events.filter((e) => after(e) && e.type === 'run.cost').reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
  lines.push('', `**Spend** (the CLI's cost estimate, not billed money): ~${money(spendSince)} since the last report; ~${money(p.spendToday)} today, against the ${money(cfg.agents.daily_budget_usd)} daily usage guard.`);

  const holds = events.filter((e) => after(e) && e.type === 'governor.hold').map((e) => (e.payload as { reason: string }).reason);
  if (holds.length) lines.push('', `**Machine**: dispatch held ${holds.length} time(s): ${[...new Set(holds)].slice(0, 3).join('; ')}.`);

  // Weekly: how every run ended, the commonest causes, and fixes proposed for any cause seen 3+ times.
  let proposals: FailureProposal[] = [];
  if (opts.weekly ?? weeklyDue(cfg.project.reports.times, opts.slot, now)) {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const f = failureModes(events, { since: weekAgo, until: now, records: opts.runRecords ?? [] });
    proposals = f.proposals;
    lines.push('', ...failureModesMarkdown(f));
    // What resolving and avoiding conflicts cost per merged PR, flagged with a suggestion when it adds more than a few minutes.
    lines.push('', ...mergeCostMarkdown(mergeMetrics(events, { since: weekAgo })));
  }

  return { markdown: lines.join('\n'), proposals };
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
