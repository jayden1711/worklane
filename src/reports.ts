// Twice-daily reports, built only from the event log: what landed, what's
// in review, decisions waiting (with owner), what's blocked and why, spend,
// and governor holds. Short, no padding.
import { statSync } from 'node:fs';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import type { StoredEvent } from './events/types.js';
import { project } from './projection.js';

const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(h < 10 ? 1 : 0)}h`);
const money = (n: number) => `$${n.toFixed(2)}`;

export interface Report {
  markdown: string;
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

export function buildReport(events: StoredEvent[], cfg: Config, opts: { since: Date; now?: Date; slot?: string; tokenExpiresAt?: string | null; appKeyPath?: string }): Report {
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

  const spendSince = events.filter((e) => after(e) && e.type === 'run.cost').reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
  lines.push('', `**Spend**: ${money(spendSince)} since the last report; ${money(p.spendToday)} today of ${money(cfg.agents.daily_budget_usd)}.`);

  const holds = events.filter((e) => after(e) && e.type === 'governor.hold').map((e) => (e.payload as { reason: string }).reason);
  if (holds.length) lines.push('', `**Machine**: dispatch held ${holds.length} time(s): ${[...new Set(holds)].slice(0, 3).join('; ')}.`);

  return { markdown: lines.join('\n') };
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
