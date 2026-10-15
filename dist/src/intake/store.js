// The coordinator's private intake state: the raw (unredacted) reports, kept
// 0600 for a configured number of days and then deleted; the ids seen (hashes
// only, kept far longer, so a redelivery is never new); and the daily counters
// behind the caps. Nothing here is ever given to an agent or written to an issue.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
const DIR = 'intake';
/** A stable id for a report: its source and the source's own id. */
export function reportId(r) {
    return createHash('sha256').update(`${r.source}\0${r.sourceId}`).digest('hex').slice(0, 20);
}
/** A directory only the coordinator user can enter (0700). */
export const privateDir = ownerOnlyDir;
const writePrivate = writeOwnerOnly;
/**
 * How long a report's id is remembered after it is first seen: far longer than the raw text is kept or a chat gateway
 * replays on resume, so a redelivery is never taken as new.
 */
export const SEEN_DAYS = 365;
/** The seen-id ledger: one empty file per report id (a hash of source and the provider's message id), no text. */
const seenFile = (stateDir, id) => join(stateDir, DIR, 'seen', id);
/** Has this report (by the provider's message id) been taken before? Raw text may be long purged; the ledger isn't. */
export function seen(stateDir, r) {
    const id = reportId(r);
    return existsSync(seenFile(stateDir, id)) || existsSync(join(stateDir, DIR, 'raw', `${id}.json`));
}
/**
 * Record a message's id as seen without keeping any of its text (a reply in a setup step's thread, where a secret
 * might be typed by mistake); returns false if it was seen before.
 */
export function markSeen(stateDir, r) {
    if (seen(stateDir, r))
        return false;
    privateDir(join(stateDir, DIR));
    privateDir(join(stateDir, DIR, 'seen'));
    writePrivate(seenFile(stateDir, reportId(r)), '');
    return true;
}
/**
 * Store a raw report and record its id as seen; returns false if it was seen before (a redelivery or retry). The raw
 * file is written first: a crash between the two still counts as seen, and recovery finds the raw file.
 */
export function storeRaw(stateDir, r) {
    if (seen(stateDir, r))
        return false;
    const id = reportId(r);
    privateDir(join(stateDir, DIR));
    privateDir(join(stateDir, DIR, 'raw'));
    privateDir(join(stateDir, DIR, 'seen'));
    writePrivate(join(stateDir, DIR, 'raw', `${id}.json`), JSON.stringify(r));
    writePrivate(seenFile(stateDir, id), '');
    return true;
}
/** Report ids whose raw text is still kept. */
export function rawIds(stateDir) {
    const dir = join(stateDir, DIR, 'raw');
    return existsSync(dir) ? readdirSync(dir).filter((f) => /^[0-9a-f]{20}\.json$/.test(f)).map((f) => f.slice(0, 20)) : [];
}
export function readRaw(stateDir, id) {
    if (!/^[0-9a-f]{20}$/.test(id))
        return null;
    try {
        return JSON.parse(readFileSync(join(stateDir, DIR, 'raw', `${id}.json`), 'utf8'));
    }
    catch {
        return null;
    }
}
/** Delete raw reports older than `days`. Returns how many were removed. Their ids stay in the seen ledger. */
export function purgeRaw(stateDir, days, now = Date.now()) {
    return purgeOlder(join(stateDir, DIR, 'raw'), days, now);
}
/** Forget seen ids older than `days` (SEEN_DAYS by default). */
export function purgeSeen(stateDir, days = SEEN_DAYS, now = Date.now()) {
    return purgeOlder(join(stateDir, DIR, 'seen'), days, now);
}
function purgeOlder(dir, days, now) {
    if (!existsSync(dir))
        return 0;
    let n = 0;
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (now - statSync(p).mtimeMs > days * 86_400_000) {
            rmSync(p, { force: true });
            n++;
        }
    }
    return n;
}
const day = (now) => new Date(now).toISOString().slice(0, 10);
/**
 * The daily counters behind the caps, persisted in the coordinator's state so a restart doesn't reset them. One
 * meter per coordinator; it is the only writer.
 */
export class IntakeMeter {
    stateDir;
    caps;
    clock;
    flood;
    file;
    constructor(stateDir, caps, clock = Date.now, 
    /** Near-identical reports within this window count as a flood. */
    flood = { windowMs: 10 * 60_000, max: 5 }) {
        this.stateDir = stateDir;
        this.caps = caps;
        this.clock = clock;
        this.flood = flood;
        this.file = join(stateDir, DIR, 'counters.json');
    }
    load() {
        const today = day(this.clock());
        try {
            const c = JSON.parse(readFileSync(this.file, 'utf8'));
            if (c.day === today)
                return c;
        }
        catch {
            // first use, or unreadable: start the day fresh
        }
        return { day: today, perSender: {}, drafts: 0, usd: 0, dropped: {}, recent: [] };
    }
    save(c) {
        privateDir(join(this.stateDir, DIR));
        writePrivate(this.file, JSON.stringify(c));
    }
    /** Take a report from `senderKey`, or refuse it (counted as a drop). */
    admit(senderKey, redactedText) {
        const c = this.load();
        const now = this.clock();
        const fp = redactedText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
        c.recent = c.recent.filter((r) => now - r.at < this.flood.windowMs);
        const drop = (reason) => {
            c.dropped[reason] = (c.dropped[reason] ?? 0) + 1;
            this.save(c);
            return { ok: false, reason };
        };
        if (c.recent.filter((r) => r.fp === fp).length >= this.flood.max)
            return drop('flood');
        if ((c.perSender[senderKey] ?? 0) >= this.caps.reports_per_sender_per_day)
            return drop('sender_cap');
        c.perSender[senderKey] = (c.perSender[senderKey] ?? 0) + 1;
        c.recent.push({ fp, at: now });
        this.save(c);
        return { ok: true };
    }
    /** May another draft be made today, within the draft count and the spend cap? */
    canDraft() {
        const c = this.load();
        if (c.drafts >= this.caps.drafts_per_day)
            return { ok: false, reason: 'drafts_cap' };
        if (c.usd >= this.caps.max_usd_per_day)
            return { ok: false, reason: 'spend_cap' };
        return { ok: true };
    }
    recordDraft(usd) {
        const c = this.load();
        c.drafts++;
        c.usd += usd;
        this.save(c);
    }
    /** Count a drop that happened before a report was taken (e.g. a sender not allowed): the reason only, nothing else. */
    countDrop(reason) {
        const c = this.load();
        c.dropped[reason] = (c.dropped[reason] ?? 0) + 1;
        this.save(c);
    }
    /** Spend that isn't a draft (a casual reply): counted against the day's spend cap. */
    recordSpend(usd) {
        const c = this.load();
        c.usd += usd;
        this.save(c);
    }
    /** May the chat channels run another turn today, within their own cap? */
    canChat(capUsd) {
        return (this.load().chatUsd ?? 0) < capUsd;
    }
    /** The chat channels' spend today. */
    chatSpent() {
        return this.load().chatUsd ?? 0;
    }
    /** A chat turn's spend: its own counter only (it has its own cap; the instance's daily budget counts it too). */
    recordChat(usd) {
        const c = this.load();
        c.chatUsd = (c.chatUsd ?? 0) + usd;
        this.save(c);
    }
    /** Over the chat cap: true the first time today (the bot says so once), false after. */
    chatCapNotice() {
        const c = this.load();
        if (c.chatCapSaid)
            return false;
        c.chatCapSaid = true;
        this.save(c);
        return true;
    }
    /** What was dropped today, by reason (for the health panel). */
    dropped() {
        return { ...this.load().dropped };
    }
}
//# sourceMappingURL=store.js.map