// Posting incidents to the ops channel: one post when an incident opens, one when it is resolved, each linking to
// its place on the Health page. Machine-wide at most RATE.max posts per RATE.windowMs; the rest wait for the next
// pass, oldest first. An incident resolved before its first post was ever sent is not posted at all (it came and
// went inside the limit). Every post is redacted again here, and the bot's own token is never in one.
import { readIncidents, redactIncidentText, withIncidents, type Incident } from './incidents.js';

/** At most this many posts per window, machine-wide. */
export const RATE = { max: 5, windowMs: 10 * 60_000 } as const;
/** Discord's message limit is 2000 characters; posts stay under it. */
const MAX_CHARS = 1900;

/** Sends one message to the ops channel; true when it went. */
export type Poster = (content: string) => Promise<boolean>;

/** A text with every secret-shaped string, and each of `secrets` (the bot token), taken out. */
export function scrub(text: string, secrets: string[] = []): string {
  let out = redactIncidentText(text);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  return out;
}

/** Where an incident is on the Health page; null without a dashboard address. */
export function incidentLink(dashboardUrl: string | null | undefined, id: string): string | null {
  if (!dashboardUrl || !/^https:\/\//.test(dashboardUrl)) return null;
  return `${dashboardUrl.replace(/\/+$/, '')}/health#incident-${encodeURIComponent(id)}`;
}

const span = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} days`;
};

/** The post for an incident that opened, or was resolved. */
export function postText(x: Incident, what: 'raised' | 'resolved', o: { dashboardUrl?: string | null; secrets?: string[] } = {}): string {
  const where = x.instance ? `instance ${x.instance}` : 'the machine';
  const link = incidentLink(o.dashboardUrl, x.id);
  const lines =
    what === 'raised'
      ? [`**${x.severity === 'red' ? 'Incident' : x.severity === 'info' ? 'Notice' : 'Warning'}** on ${where}: ${x.title}`, x.detail, ...(x.tried.length ? [`Already tried: ${x.tried.join('; ')}`] : []), `Fix: ${x.fix}`, ...(link ? [link] : [])]
      : [`**Resolved** on ${where}: ${x.title} (open ${span(Date.parse(x.resolvedAt!) - Date.parse(x.since))})`, ...(link ? [link] : [])];
  const text = scrub(lines.join('\n'), o.secrets);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}

/** What waits to be posted, oldest first: openings not yet posted, then resolutions of posted ones. */
function pending(incidents: Incident[]): { id: string; what: 'raised' | 'resolved'; at: string }[] {
  const out: { id: string; what: 'raised' | 'resolved'; at: string }[] = [];
  for (const x of incidents) {
    if (x.posted.skipped) continue;
    if (!x.posted.raised && !x.resolvedAt) out.push({ id: x.id, what: 'raised', at: x.since });
    else if (x.posted.raised && x.resolvedAt && !x.posted.resolved) out.push({ id: x.id, what: 'resolved', at: x.resolvedAt });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Post what waits, within the rate limit. Only the one poster on the machine calls this (the watchdog's post lock),
 * so a post is never sent twice; its mark is written right after it went.
 */
export async function postPending(o: { poster: Poster; dashboardUrl?: string | null; secrets?: string[]; dir?: string; now?: () => Date }): Promise<{ posted: number; waiting: number }> {
  const now = o.now ?? (() => new Date());
  // Resolved before ever posted: nothing to say about it.
  withIncidents(o.dir, (f) => {
    for (const x of f.incidents) if (x.resolvedAt && !x.posted.raised && !x.posted.skipped) x.posted.skipped = true;
  });
  const todo = pending(readIncidents(o.dir).incidents);
  let posted = 0;
  for (const p of todo) {
    const t = now();
    const recent = readIncidents(o.dir).posts.filter((s) => t.getTime() - Date.parse(s) < RATE.windowMs);
    if (recent.length >= RATE.max) break;
    const x = readIncidents(o.dir).incidents.find((i) => i.id === p.id);
    if (!x) continue;
    let ok = false;
    try {
      ok = await o.poster(postText(x, p.what, { dashboardUrl: o.dashboardUrl ?? null, secrets: o.secrets ?? [] }));
    } catch {
      ok = false;
    }
    if (!ok) break; // Discord is down or refusing: try again on the next pass, in the same order
    posted++;
    withIncidents(o.dir, (f) => {
      const y = f.incidents.find((i) => i.id === p.id);
      if (y) y.posted[p.what] = t.toISOString();
      f.posts = [...f.posts.filter((s) => t.getTime() - Date.parse(s) < RATE.windowMs), t.toISOString()];
    });
  }
  return { posted, waiting: todo.length - posted };
}

/**
 * One ops post from elsewhere (a direct push's alert, src/direct-push-alert.ts; a merge post, src/merge-posts.ts;
 * fix-forward's red and green posts, coordinator/fix-forward.ts), within the same machine-wide limit as the incident
 * posts: true, and counted, when one may go now; false when the window is full (try again later). The one helper for
 * all of them, so they share the one window. `now`: a Date or epoch ms.
 */
export function takeOpsPost(o: { dir?: string; now?: Date | number } = {}): boolean {
  const t = o.now === undefined ? Date.now() : typeof o.now === 'number' ? o.now : o.now.getTime();
  return withIncidents(o.dir, (f) => {
    const recent = f.posts.filter((s) => t - Date.parse(s) < RATE.windowMs);
    if (recent.length >= RATE.max) return false;
    f.posts = [...recent, new Date(t).toISOString()];
    return true;
  });
}

/** A poster for one Discord channel with the bot's token: a plain message that pings nobody. */
export function discordPoster(o: { token: () => string; channel: string; fetch?: typeof fetch; api?: string }): Poster {
  return async (content) => {
    const r = await (o.fetch ?? fetch)(`${o.api ?? 'https://discord.com/api/v10'}/channels/${encodeURIComponent(o.channel)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${o.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  };
}
