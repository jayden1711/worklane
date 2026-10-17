// A small 5-field cron (minute hour day-of-month month day-of-week) in this machine's local time, the time zone
// src/local-day.ts reads. Written here (no cron library): numbers, lists (1,3), ranges (1-5), steps (*/2, 8-18/2)
// and *, in every field but the minute, which is ONE number: so a schedule fires at most once an hour, whatever
// it says. Day-of-month and day-of-week follow the usual rule: when both are restricted, either one matching is
// enough. Sunday is 0 (7 is taken as 0 too).
//
// Wall-clock slots, not instants: a slot is a local date and time (its key, YYYY-MM-DD HH:MM). A slot inside the
// hour a daylight-saving change skips still fires once, just after the change; a slot inside the hour it repeats
// fires once (its key was already used).
function field(text, min, max) {
    const out = new Set();
    for (const part of text.split(',')) {
        const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
        if (!m)
            return null;
        const step = m[4] !== undefined ? Number(m[4]) : 1;
        const lo = m[1] === '*' ? min : Number(m[2]);
        const hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
        if (step < 1 || lo < min || hi > max || lo > hi)
            return null;
        for (let v = lo; v <= hi; v += step)
            out.add(v);
    }
    return out.size ? out : null;
}
export function parseCron(text) {
    const parts = String(text ?? '').trim().split(/\s+/);
    if (parts.length !== 5)
        return { ok: false, why: 'a cron has 5 fields: minute hour day-of-month month day-of-week' };
    const [mi, h, dom, mon, dow] = parts;
    if (!/^\d{1,2}$/.test(mi) || Number(mi) > 59)
        return { ok: false, why: 'the minute is one number from 0 to 59 (at most once an hour)' };
    const hours = field(h, 0, 23);
    const days = field(dom, 1, 31);
    const months = field(mon, 1, 12);
    const weekdays = field(dow, 0, 7);
    if (weekdays?.delete(7))
        weekdays.add(0);
    if (!hours || !days || !months || !weekdays)
        return { ok: false, why: 'a field is out of range or not a number, list, range or step' };
    return { ok: true, cron: { minute: Number(mi), hours, days, months, weekdays, either: dom !== '*' && dow !== '*' } };
}
const pad = (n) => String(n).padStart(2, '0');
export const slotKey = (w) => `${w.y}-${pad(w.mo + 1)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
function matches(c, w) {
    if (w.mi !== c.minute || !c.hours.has(w.h) || !c.months.has(w.mo + 1))
        return false;
    const weekday = new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay();
    const dom = c.days.has(w.d);
    const dow = c.weekdays.has(weekday);
    return c.either ? dom || dow : dom && dow;
}
/** Local wall-clock fields `back` minutes before `now`'s wall clock (wall arithmetic: no time zone shifts). */
function wallBefore(now, back) {
    const t = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) - back * 60_000;
    const u = new Date(t);
    return { y: u.getUTCFullYear(), mo: u.getUTCMonth(), d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes() };
}
/**
 * The most recent slot at or before `now` within `windowMin` minutes, or null: its key and the instant it falls on
 * (a slot the clocks skipped falls just after the change). At most one: an older missed slot never fires once a
 * newer one exists.
 */
export function latestSlot(c, now, windowMin) {
    for (let back = 0; back <= windowMin; back++) {
        const w = wallBefore(now, back);
        if (!matches(c, w))
            continue;
        const at = new Date(w.y, w.mo, w.d, w.h, w.mi);
        if (at.getTime() > now.getTime())
            continue;
        return { key: slotKey(w), at };
    }
    return null;
}
/** The next `count` slots after `now` (for the dashboard: "next at"), looking at most 400 days ahead. */
export function nextSlots(c, now, count) {
    const out = [];
    const start = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0);
    for (let h = 0; h < 400 * 24 && out.length < count; h++) {
        const u = new Date(start + h * 3600_000);
        const w = { y: u.getUTCFullYear(), mo: u.getUTCMonth(), d: u.getUTCDate(), h: u.getUTCHours(), mi: c.minute };
        if (!matches(c, w))
            continue;
        const at = new Date(w.y, w.mo, w.d, w.h, w.mi);
        if (at.getTime() > now.getTime())
            out.push(at);
    }
    return out;
}
/** A schedule in plain words, for the dashboard (the cron itself is shown beside it). */
export function describeCron(text) {
    const p = parseCron(text);
    if (!p.ok)
        return text;
    const c = p.cron;
    const all = (s, n) => s.size === n;
    const time = all(c.hours, 24) ? `every hour at :${pad(c.minute)}` : c.hours.size === 1 ? `at ${pad([...c.hours][0])}:${pad(c.minute)}` : `at :${pad(c.minute)} past ${[...c.hours].map(pad).join(', ')}`;
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const anyDay = all(c.days, 31) && all(c.months, 12);
    if (anyDay && all(c.weekdays, 7))
        return `daily ${time}`;
    if (anyDay && [1, 2, 3, 4, 5].every((d) => c.weekdays.has(d)) && c.weekdays.size === 5)
        return `weekdays ${time}`;
    if (anyDay)
        return `${[...c.weekdays].map((d) => names[d]).join(', ')} ${time}`;
    return `${text} (${time})`;
}
//# sourceMappingURL=cron.js.map