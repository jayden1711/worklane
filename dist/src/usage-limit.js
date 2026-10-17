import { localDay } from './local-day.js';
/** With no reset time in claude's message: the subscription's five-hour window. */
export const DEFAULT_PAUSE_MS = 5 * 3600_000;
/** A reset sooner than this is taken as this (a clock skew or a reset already passing never means "retry now"). */
export const MIN_PAUSE_MS = 60_000;
/** A reset further off than this (a week's window, and a day's slack) isn't believed: the default instead. */
export const MAX_PAUSE_MS = 8 * 24 * 3600_000;
/** claude's own words for the subscription's limit (not a short-lived 429 it retries by itself). */
export const USAGE_LIMIT_TEXT = /usage limit reached|hit your (?:[\w-]+ )?limit|(?:5-hour|five[- ]hour|weekly|session|opus|sonnet) limit reached|limit will reset/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** The UTC offset (ms) of `tz` at the instant `ms`; throws on an unknown zone. */
function offsetOf(ms, tz) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms));
    const n = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second')) - Math.floor(ms / 1000) * 1000;
}
/** The instant a wall-clock time in `tz` names (DST-safe to the hour). */
function zoned(y, mo, d, h, mi, tz) {
    const guess = Date.UTC(y, mo, d, h, mi);
    const first = guess - offsetOf(guess, tz);
    return guess - offsetOf(first, tz);
}
/** The wall-clock date in `tz` at `ms`. */
function dateIn(ms, tz) {
    const shifted = new Date(ms + offsetOf(ms, tz));
    return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}
/** The reset time a message's text names, or null: "|1760000000", "resets in 2h 30m", "resets 3pm (Europe/Paris)", "resets Oct 14, 9am". */
export function resetInText(text, now, localTz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const epoch = /limit reached\|(\d{10})\b/i.exec(text);
    if (epoch)
        return Number(epoch[1]) * 1000;
    const rel = /resets?\s+in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:(?:ou)?rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
    if (rel && (rel[1] || rel[2] || rel[3]))
        return now + ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60_000;
    const at = /resets?\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}|UTC)\))?/i.exec(text);
    if (!at)
        return null;
    const tz = at[6] ?? localTz;
    try {
        let h = Number(at[3]) % 12;
        if (at[5].toLowerCase() === 'pm')
            h += 12;
        const mi = Number(at[4] ?? 0);
        if (mi > 59 || Number(at[3]) > 12)
            return null;
        const today = dateIn(now, tz);
        if (at[1]) {
            const mo = MONTHS.indexOf(at[1].toLowerCase());
            if (mo < 0)
                return null;
            let t = zoned(today.y, mo, Number(at[2]), h, mi, tz);
            if (t < now - 24 * 3600_000)
                t = zoned(today.y + 1, mo, Number(at[2]), h, mi, tz);
            return t;
        }
        const t = zoned(today.y, today.mo, today.d, h, mi, tz);
        // A time of day already past today is tomorrow's.
        return t > now ? t : zoned(today.y, today.mo, today.d + 1, h, mi, tz);
    }
    catch {
        return null; // an unknown time zone: no reset time from the text
    }
}
/**
 * A run's limit as the pause takes it: the reset from claude's rate_limit_event, else from its text, else the
 * default; held to [MIN_PAUSE_MS, MAX_PAUSE_MS] from now (outside it, the default).
 */
export function limitHit(o) {
    const fromInfo = typeof o.info?.resetsAt === 'number' && o.info.resetsAt > 0 ? o.info.resetsAt * 1000 : null;
    const named = fromInfo ?? resetInText(o.text, o.now, o.localTz);
    const kind = o.info?.rateLimitType ?? null;
    if (named === null || named - o.now > MAX_PAUSE_MS)
        return { resetAt: new Date(o.now + DEFAULT_PAUSE_MS).toISOString(), source: 'default', kind };
    return { resetAt: new Date(Math.max(named, o.now + MIN_PAUSE_MS)).toISOString(), source: 'claude', kind };
}
export function pauseOf(events) {
    let p = null;
    for (const e of events) {
        if (e.type === 'usage.paused') {
            const x = e.payload;
            p = { since: e.ts, resetAt: x.reset_at, source: x.source, kind: x.kind, issue: x.issue, role: x.role, id: e.id };
        }
        else if (e.type === 'usage.resumed')
            p = null;
    }
    return p;
}
export function usageView(events, now = Date.now()) {
    const day = localDay(now);
    let runs = 0;
    let limitHits = 0;
    let lastHit = null;
    for (const e of events) {
        if (e.type === 'usage.limit_hit')
            lastHit = e.ts;
        const run = e.type === 'run.started';
        const hit = e.type === 'usage.limit_hit' || (e.type === 'run.finished' && e.payload.reason === 'rate_limited');
        if ((!run && !hit) || localDay(e.ts) !== day)
            continue;
        if (run)
            runs++;
        else
            limitHits++;
    }
    return { paused: pauseOf(events), today: { runs, limitHits }, lastHit };
}
/** Plain words for when a pause ends, for a comment or a post: the time in UTC and how far off it is. */
export function resetWords(resetAt, now) {
    const ms = Math.max(0, Date.parse(resetAt) - now);
    const h = Math.floor(ms / 3600_000);
    const m = Math.round((ms % 3600_000) / 60_000);
    return `${resetAt.slice(0, 16).replace('T', ' ')} UTC (in ${h ? `${h} h ` : ''}${m} min)`;
}
/** The incident a usage pause raises, by instance. */
export const USAGE_INCIDENT = 'claude_usage_limit';
/** The notice an account profile failover raises (src/claude-failover.ts), by instance: info, nothing to do. */
export const FAILOVER_INCIDENT = 'claude_account_failover';
//# sourceMappingURL=usage-limit.js.map