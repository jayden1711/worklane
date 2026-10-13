// The Claude usage limit: how claude says the subscription's limit was reached, when it resets, and the instance's
// pause until then. A run that hits it ends at once (no transient retries: the reset is hours away); the
// coordinator then starts no run until the reset, requeues the task the run was for, posts one notice, and resumes
// on its own. The pause is a fold over the log (usage.paused, usage.resumed), so a restart keeps it.
//
// Where the reset time comes from, best first: the stream's rate_limit_event (`rate_limit_info.resetsAt`, unix
// seconds), the `|<unix seconds>` older clients append to "usage limit reached", or the text's "resets 3pm
// (Area/City)" / "resets in 2h 30m". None: DEFAULT_PAUSE_MS, the length of the subscription's shortest window.
import type { StoredEvent } from './events/types.js';

/** With no reset time in claude's message: the subscription's five-hour window. */
export const DEFAULT_PAUSE_MS = 5 * 3600_000;
/** A reset sooner than this is taken as this (a clock skew or a reset already passing never means "retry now"). */
export const MIN_PAUSE_MS = 60_000;
/** A reset further off than this (a week's window, and a day's slack) isn't believed: the default instead. */
export const MAX_PAUSE_MS = 8 * 24 * 3600_000;

/** claude's own words for the subscription's limit (not a short-lived 429 it retries by itself). */
export const USAGE_LIMIT_TEXT = /usage limit reached|hit your (?:[\w-]+ )?limit|(?:5-hour|five[- ]hour|weekly|session|opus|sonnet) limit reached|limit will reset/i;

export interface LimitHit {
  /** When the limit resets (ISO). */
  resetAt: string;
  /** `claude`: read from claude's own message; `default`: none there, DEFAULT_PAUSE_MS from the hit. */
  source: 'claude' | 'default';
  /** The window claude named (five_hour, seven_day, ...), when it did. */
  kind: string | null;
}

/** What the stream's rate_limit_event carries (src/runner.ts reads it). */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number | null;
  rateLimitType?: string | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The UTC offset (ms) of `tz` at the instant `ms`; throws on an unknown zone. */
function offsetOf(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second')) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` names (DST-safe to the hour). */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - offsetOf(guess, tz);
  return guess - offsetOf(first, tz);
}

/** The wall-clock date in `tz` at `ms`. */
function dateIn(ms: number, tz: string): { y: number; mo: number; d: number } {
  const shifted = new Date(ms + offsetOf(ms, tz));
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

/** The reset time a message's text names, or null: "|1760000000", "resets in 2h 30m", "resets 3pm (Europe/Paris)", "resets Oct 14, 9am". */
export function resetInText(text: string, now: number, localTz = Intl.DateTimeFormat().resolvedOptions().timeZone): number | null {
  const epoch = /limit reached\|(\d{10})\b/i.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const rel = /resets?\s+in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:(?:ou)?rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
  if (rel && (rel[1] || rel[2] || rel[3])) return now + ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60_000;
  const at = /resets?\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}|UTC)\))?/i.exec(text);
  if (!at) return null;
  const tz = at[6] ?? localTz;
  try {
    let h = Number(at[3]) % 12;
    if (at[5]!.toLowerCase() === 'pm') h += 12;
    const mi = Number(at[4] ?? 0);
    if (mi > 59 || Number(at[3]) > 12) return null;
    const today = dateIn(now, tz);
    if (at[1]) {
      const mo = MONTHS.indexOf(at[1].toLowerCase());
      if (mo < 0) return null;
      let t = zoned(today.y, mo, Number(at[2]), h, mi, tz);
      if (t < now - 24 * 3600_000) t = zoned(today.y + 1, mo, Number(at[2]), h, mi, tz);
      return t;
    }
    const t = zoned(today.y, today.mo, today.d, h, mi, tz);
    // A time of day already past today is tomorrow's.
    return t > now ? t : zoned(today.y, today.mo, today.d + 1, h, mi, tz);
  } catch {
    return null; // an unknown time zone: no reset time from the text
  }
}

/**
 * A run's limit as the pause takes it: the reset from claude's rate_limit_event, else from its text, else the
 * default; held to [MIN_PAUSE_MS, MAX_PAUSE_MS] from now (outside it, the default).
 */
export function limitHit(o: { info?: RateLimitInfo | null; text: string; now: number; localTz?: string }): LimitHit {
  const fromInfo = typeof o.info?.resetsAt === 'number' && o.info.resetsAt > 0 ? o.info.resetsAt * 1000 : null;
  const named = fromInfo ?? resetInText(o.text, o.now, o.localTz);
  const kind = o.info?.rateLimitType ?? null;
  if (named === null || named - o.now > MAX_PAUSE_MS) return { resetAt: new Date(o.now + DEFAULT_PAUSE_MS).toISOString(), source: 'default', kind };
  return { resetAt: new Date(Math.max(named, o.now + MIN_PAUSE_MS)).toISOString(), source: 'claude', kind };
}

/** The pause in force, as the log has it: the last usage.paused with no usage.resumed after it. */
export interface UsagePause {
  since: string;
  resetAt: string;
  source: 'claude' | 'default';
  kind: string | null;
  /** The run that hit it: its issue (null for one with none) and role. */
  issue: number | null;
  role: string;
  /** The event's id: the Discord notice's key. */
  id: number;
}

export function pauseOf(events: StoredEvent[]): UsagePause | null {
  let p: UsagePause | null = null;
  for (const e of events) {
    if (e.type === 'usage.paused') {
      const x = e.payload as { reset_at: string; source: 'claude' | 'default'; kind: string | null; issue: number | null; role: string };
      p = { since: e.ts, resetAt: x.reset_at, source: x.source, kind: x.kind, issue: x.issue, role: x.role, id: e.id };
    } else if (e.type === 'usage.resumed') p = null;
  }
  return p;
}

/** What the dashboard shows of an instance's usage: the pause in force, and today's runs and limit hits (UTC day). */
export interface UsageView {
  paused: UsagePause | null;
  today: { runs: number; limitHits: number };
  /** The last time a run hit the limit (ISO), or null. */
  lastHit: string | null;
}

export function usageView(events: StoredEvent[], now = Date.now()): UsageView {
  const day = new Date(now).toISOString().slice(0, 10);
  let runs = 0;
  let limitHits = 0;
  let lastHit: string | null = null;
  for (const e of events) {
    if (e.type === 'usage.limit_hit') lastHit = e.ts;
    if (!e.ts.startsWith(day)) continue;
    if (e.type === 'run.started') runs++;
    else if (e.type === 'usage.limit_hit' || (e.type === 'run.finished' && (e.payload as { reason?: string }).reason === 'rate_limited')) limitHits++;
  }
  return { paused: pauseOf(events), today: { runs, limitHits }, lastHit };
}

/** Plain words for when a pause ends, for a comment or a post: the time in UTC and how far off it is. */
export function resetWords(resetAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(resetAt) - now);
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return `${resetAt.slice(0, 16).replace('T', ' ')} UTC (in ${h ? `${h} h ` : ''}${m} min)`;
}

/**
 * The incident model a watchdog keeps (one alert per incident, one when it's resolved). Optional: until an
 * instance has one, the pause reports through its own events, the dashboard and the asks channel only.
 */
export interface IncidentSink {
  raiseIncident(kind: string, key: string, detail: string, fix: string): void;
  resolveIncident(kind: string, key: string): void;
}

/** The incident a usage pause raises, by instance. */
export const USAGE_INCIDENT = 'claude_usage_limit';
