// The coordinator's private intake state: the raw (unredacted) reports, kept
// 0600 for a configured number of days and then deleted; the ids seen (hashes
// only, kept far longer, so a redelivery is never new); and the daily counters
// behind the caps. Nothing here is ever given to an agent or written to an issue.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
import type { IncomingReport } from './report.js';

const DIR = 'intake';

/** A stable id for a report: its source and the source's own id. */
export function reportId(r: Pick<IncomingReport, 'source' | 'sourceId'>): string {
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
const seenFile = (stateDir: string, id: string) => join(stateDir, DIR, 'seen', id);

/** Has this report (by the provider's message id) been taken before? Raw text may be long purged; the ledger isn't. */
export function seen(stateDir: string, r: Pick<IncomingReport, 'source' | 'sourceId'>): boolean {
  const id = reportId(r);
  return existsSync(seenFile(stateDir, id)) || existsSync(join(stateDir, DIR, 'raw', `${id}.json`));
}

/**
 * Store a raw report and record its id as seen; returns false if it was seen before (a redelivery or retry). The raw
 * file is written first: a crash between the two still counts as seen, and recovery finds the raw file.
 */
export function storeRaw(stateDir: string, r: IncomingReport): boolean {
  if (seen(stateDir, r)) return false;
  const id = reportId(r);
  privateDir(join(stateDir, DIR));
  privateDir(join(stateDir, DIR, 'raw'));
  privateDir(join(stateDir, DIR, 'seen'));
  writePrivate(join(stateDir, DIR, 'raw', `${id}.json`), JSON.stringify(r));
  writePrivate(seenFile(stateDir, id), '');
  return true;
}

/** Report ids whose raw text is still kept. */
export function rawIds(stateDir: string): string[] {
  const dir = join(stateDir, DIR, 'raw');
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^[0-9a-f]{20}\.json$/.test(f)).map((f) => f.slice(0, 20)) : [];
}

export function readRaw(stateDir: string, id: string): IncomingReport | null {
  if (!/^[0-9a-f]{20}$/.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(stateDir, DIR, 'raw', `${id}.json`), 'utf8')) as IncomingReport;
  } catch {
    return null;
  }
}

/** Delete raw reports older than `days`. Returns how many were removed. Their ids stay in the seen ledger. */
export function purgeRaw(stateDir: string, days: number, now = Date.now()): number {
  return purgeOlder(join(stateDir, DIR, 'raw'), days, now);
}

/** Forget seen ids older than `days` (SEEN_DAYS by default). */
export function purgeSeen(stateDir: string, days = SEEN_DAYS, now = Date.now()): number {
  return purgeOlder(join(stateDir, DIR, 'seen'), days, now);
}

function purgeOlder(dir: string, days: number, now: number): number {
  if (!existsSync(dir)) return 0;
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

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

interface Counters {
  day: string;
  perSender: Record<string, number>;
  drafts: number;
  usd: number;
  dropped: Record<string, number>;
  /** Recent report fingerprints with their times, for flood detection. */
  recent: { fp: string; at: number }[];
}

export type Admit = { ok: true } | { ok: false; reason: 'sender_cap' | 'flood' };

/**
 * The daily counters behind the caps, persisted in the coordinator's state so a restart doesn't reset them. One
 * meter per coordinator; it is the only writer.
 */
export class IntakeMeter {
  private file: string;
  constructor(
    private stateDir: string,
    private caps: { reports_per_sender_per_day: number; drafts_per_day: number; max_usd_per_day: number },
    private clock: () => number = Date.now,
    /** Near-identical reports within this window count as a flood. */
    private flood = { windowMs: 10 * 60_000, max: 5 },
  ) {
    this.file = join(stateDir, DIR, 'counters.json');
  }

  private load(): Counters {
    const today = day(this.clock());
    try {
      const c = JSON.parse(readFileSync(this.file, 'utf8')) as Counters;
      if (c.day === today) return c;
    } catch {
      // first use, or unreadable: start the day fresh
    }
    return { day: today, perSender: {}, drafts: 0, usd: 0, dropped: {}, recent: [] };
  }

  private save(c: Counters) {
    privateDir(join(this.stateDir, DIR));
    writePrivate(this.file, JSON.stringify(c));
  }

  /** Take a report from `senderKey`, or refuse it (counted as a drop). */
  admit(senderKey: string, redactedText: string): Admit {
    const c = this.load();
    const now = this.clock();
    const fp = redactedText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    c.recent = c.recent.filter((r) => now - r.at < this.flood.windowMs);
    const drop = (reason: 'sender_cap' | 'flood'): Admit => {
      c.dropped[reason] = (c.dropped[reason] ?? 0) + 1;
      this.save(c);
      return { ok: false, reason };
    };
    if (c.recent.filter((r) => r.fp === fp).length >= this.flood.max) return drop('flood');
    if ((c.perSender[senderKey] ?? 0) >= this.caps.reports_per_sender_per_day) return drop('sender_cap');
    c.perSender[senderKey] = (c.perSender[senderKey] ?? 0) + 1;
    c.recent.push({ fp, at: now });
    this.save(c);
    return { ok: true };
  }

  /** May another draft be made today, within the draft count and the spend cap? */
  canDraft(): { ok: true } | { ok: false; reason: 'drafts_cap' | 'spend_cap' } {
    const c = this.load();
    if (c.drafts >= this.caps.drafts_per_day) return { ok: false, reason: 'drafts_cap' };
    if (c.usd >= this.caps.max_usd_per_day) return { ok: false, reason: 'spend_cap' };
    return { ok: true };
  }

  recordDraft(usd: number) {
    const c = this.load();
    c.drafts++;
    c.usd += usd;
    this.save(c);
  }

  /** Count a drop that happened before a report was taken (e.g. a sender not allowed): the reason only, nothing else. */
  countDrop(reason: string) {
    const c = this.load();
    c.dropped[reason] = (c.dropped[reason] ?? 0) + 1;
    this.save(c);
  }

  /** Spend that isn't a draft (a casual reply): counted against the day's spend cap. */
  recordSpend(usd: number) {
    const c = this.load();
    c.usd += usd;
    this.save(c);
  }

  /** What was dropped today, by reason (for the health panel). */
  dropped(): Record<string, number> {
    return { ...this.load().dropped };
  }
}
