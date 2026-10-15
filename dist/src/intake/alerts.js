// Production alerts as an intake source: a second fixed read-only query on the production read path (prodread.ts),
// beside the in-product bug reports (bug-store.ts), through the same read-only role and the same validated cursor.
// The query is built here from the table and column names in the instance's intake.yaml, each checked to be a plain
// identifier; only the cursor is filled in, and it is validated (withCursor), never free text.
//
// Alert rows aren't reports one for one. A kind never seen before, or a kind whose rows within the window pass the
// threshold (a spike), becomes one report; every other row only updates the counts. The source's state (cursor,
// kinds seen, recent times per kind, the reports not yet recorded) is one owner-only file, written as one, so a crash
// between the pull and the record hands the same reports out again and the seen ledger takes each once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactString } from '../events/redact.js';
import { writeOwnerOnly } from '../os/index.js';
import { withCursor } from './bug-store.js';
import { privateDir } from './store.js';
/** A plain SQL identifier (one part of a table name, or a column). Nothing that needs quoting is accepted. */
export const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ident = (s, what) => {
    if (!SQL_IDENT.test(s))
        throw new Error(`alerts: ${what} ${JSON.stringify(s)} is not a plain identifier`);
    return `"${s}"`;
};
/** The one fixed query: id, kind, message and created_at, newer than :after, oldest first, at most `batch` rows. */
export function alertsQuery(a) {
    const parts = a.table.split('.');
    if (parts.length > 2)
        throw new Error(`alerts: table ${JSON.stringify(a.table)} is not a table or schema.table`);
    const table = parts.map((p) => ident(p, 'table')).join('.');
    const c = a.columns;
    const id = ident(c.id, 'column');
    return `SELECT ${id} AS id, ${ident(c.kind, 'column')} AS kind, ${ident(c.message, 'column')} AS message, ${ident(c.created_at, 'column')} AS created_at FROM ${table} WHERE ${id} > :after ORDER BY ${id} LIMIT ${Math.trunc(a.batch)}`;
}
const stateFile = (stateDir) => join(stateDir, 'intake', 'alerts-state.json');
export function readAlertsState(stateDir) {
    try {
        const s = JSON.parse(readFileSync(stateFile(stateDir), 'utf8'));
        return { after: String(s.after), baseline: s.baseline !== false, kinds: s.kinds ?? {}, recent: s.recent ?? {}, spiked: s.spiked ?? {}, pending: s.pending ?? [] };
    }
    catch {
        return { after: '0', baseline: true, kinds: {}, recent: {}, spiked: {}, pending: [] };
    }
}
function writeState(stateDir, s) {
    privateDir(join(stateDir, 'intake'));
    writeOwnerOnly(stateFile(stateDir), JSON.stringify(s));
}
/** A kind as the source names it: secrets out, one line, at most 80 characters; empty is "unknown". */
const kindOf = (k) => redactString(String(k ?? '')).replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
/** A message excerpt: secrets out before it is stored anywhere (the pipeline redacts personal data after). */
const excerptOf = (m) => redactString(String(m ?? '')).replace(/\s+/g, ' ').trim().slice(0, 300);
const newer = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? BigInt(a) > BigInt(b) : a > b);
/**
 * One pull: rows newer than the cursor, turned into reports for new kinds and spikes, added to the pending ones, and
 * the state (cursor included) written in one go. Returns every pending report.
 */
export function pullAlerts(stateDir, cfg, run, now = () => new Date()) {
    const s = readAlertsState(stateDir);
    const r = run(withCursor(alertsQuery(cfg), s.after));
    if (!r.ok)
        throw new Error(`alerts read failed: ${r.error ?? 'unknown'}`);
    const rows = (JSON.parse(r.output).rows ?? []).filter((x) => x.id != null);
    const t = now().getTime();
    const windowMs = cfg.spike.window_minutes * 60_000;
    const latest = new Map();
    // Each report is made once: a kind is new only once, and a kind's spike once per window.
    const add = (rep) => void s.pending.push(rep);
    for (const row of rows) {
        const id = String(row.id);
        if (newer(id, s.after))
            s.after = id;
        const kind = kindOf(row.kind);
        const at = Date.parse(row.created_at ?? '') || t;
        const iso = new Date(at).toISOString();
        latest.set(kind, row);
        if (!(kind in s.kinds)) {
            s.kinds[kind] = iso;
            if (!s.baseline)
                add({ source: 'alerts', sourceId: `new:${kind}`, sender: { source: 'alerts', id: kind }, text: `New production alert kind "${kind}", first seen ${iso}. Message: ${excerptOf(row.message)}`, receivedAt: iso });
        }
        s.recent[kind] = [...(s.recent[kind] ?? []), at].sort((a, b) => a - b).slice(-(cfg.spike.threshold + 1));
    }
    // Spikes: more than the threshold within the window ending now, once per window per kind.
    for (const [kind, times] of Object.entries(s.recent)) {
        const live = times.filter((x) => x > t - windowMs);
        if (live.length)
            s.recent[kind] = live;
        else
            delete s.recent[kind];
        if (live.length <= cfg.spike.threshold)
            continue;
        if (s.spiked[kind] !== undefined && s.spiked[kind] > t - windowMs)
            continue;
        s.spiked[kind] = t;
        const iso = new Date(t).toISOString();
        add({
            source: 'alerts',
            sourceId: `spike:${kind}:${iso}`,
            sender: { source: 'alerts', id: kind },
            text: `Spike in production alert "${kind}": more than ${cfg.spike.threshold} in the last ${cfg.spike.window_minutes} minutes (up to ${iso}). Latest message: ${excerptOf(latest.get(kind)?.message ?? null)}`,
            receivedAt: iso,
        });
    }
    // Caught up: from now on a kind not seen before is new.
    if (rows.length < cfg.batch)
        s.baseline = false;
    writeState(stateDir, s);
    return s.pending;
}
/** Alerts as an intake source: pulled on each pass; a report leaves the pending list once the coordinator records it. */
export class AlertsIntake {
    o;
    name = 'alerts';
    constructor(o) {
        this.o = o;
    }
    async take() {
        return pullAlerts(this.o.stateDir, this.o.config(), this.o.run, this.o.now);
    }
    async ack(ids) {
        const s = readAlertsState(this.o.stateDir);
        const done = new Set(ids);
        const left = s.pending.filter((p) => !done.has(p.sourceId));
        if (left.length === s.pending.length)
            return;
        writeState(this.o.stateDir, { ...s, pending: left });
    }
    /** Alerts have no thread to reply into. */
    async reply() {
        return false;
    }
}
//# sourceMappingURL=alerts.js.map