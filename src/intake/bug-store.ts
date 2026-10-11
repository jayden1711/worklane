// In-product bug reports: a read-only pull from the project's report store
// through the production read path (a read-only role limited to that table or
// view), on a timer. The query is fixed in the project's config; only the
// cursor of what has been seen is filled in, and it is validated, never free text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingReport } from './report.js';
import { writeOwnerOnly } from '../os/index.js';
import { privateDir } from './store.js';

/** Runs one read-only SELECT and returns its output line ({rows: [...]}), like prodRead. */
export type ReadOnlyQuery = (sql: string) => { ok: boolean; output: string; error?: string };

interface Row {
  id: string | number;
  reporter?: string | number | null;
  text: string;
  created_at: string;
}

const cursorFile = (stateDir: string) => join(stateDir, 'intake', 'bug-store-cursor.json');

export function readCursor(stateDir: string): string {
  try {
    return String((JSON.parse(readFileSync(cursorFile(stateDir), 'utf8')) as { after: string }).after);
  } catch {
    return '0';
  }
}

/** The query with `:after` filled in: a number or an ISO timestamp only, as a quoted literal. */
export function withCursor(query: string, after: string): string {
  if (!query.includes(':after')) throw new Error('the bug-report query must use :after for what was already seen');
  if (!/^\d{1,20}$/.test(after) && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(after)) throw new Error(`refusing an unexpected cursor ${JSON.stringify(after)}`);
  return query.replaceAll(':after', `'${after}'`);
}

/** Cursor order: numeric ids as numbers, anything else (timestamps) as text. */
const before = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? BigInt(a) < BigInt(b) : a < b);

/**
 * Pull reports newer than the stored cursor, oldest first. The cursor is not moved here but in BugStoreIntake.ack,
 * once what was pulled is recorded, so a crash between the pull and the record pulls the same rows again (and the
 * seen ledger takes each once). `skipped`: rows with no text, which nothing will record.
 */
export function pullBugReports(stateDir: string, query: string, run: ReadOnlyQuery, now = () => new Date()): { reports: IncomingReport[]; skipped: string[] } {
  const r = run(withCursor(query, readCursor(stateDir)));
  if (!r.ok) throw new Error(`bug-report read failed: ${r.error ?? 'unknown'}`);
  const { rows } = JSON.parse(r.output) as { rows: Row[] };
  const reports: IncomingReport[] = [];
  const skipped: string[] = [];
  for (const row of rows ?? []) {
    if (row.id == null) continue;
    const id = String(row.id);
    if (row.text == null) {
      skipped.push(id);
      continue;
    }
    reports.push({
      source: 'bug-store',
      sourceId: id,
      sender: { source: 'bug-store', id: row.reporter == null ? 'anonymous' : String(row.reporter) },
      text: String(row.text),
      receivedAt: row.created_at ?? now().toISOString(),
    });
  }
  // In the order they were made, whatever order the project's query returns them in.
  const num = (x: string) => (/^\d{1,15}$/.test(x) ? x.padStart(15, '0') : x);
  reports.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || num(a.sourceId).localeCompare(num(b.sourceId)));
  return { reports, skipped };
}

/** The bug store as an intake source: pulled on each pass, its cursor advanced only past what is recorded. */
export class BugStoreIntake {
  readonly name = 'bug-store' as const;
  /** Ids pulled and not yet behind the cursor, and whether each is recorded (or needs no record). */
  private pending = new Map<string, boolean>();
  constructor(private o: { stateDir: string; query: string; run: ReadOnlyQuery; now?: () => Date }) {}

  async take(): Promise<IncomingReport[]> {
    const { reports, skipped } = pullBugReports(this.o.stateDir, this.o.query, this.o.run, this.o.now);
    for (const r of reports) if (!this.pending.has(r.sourceId)) this.pending.set(r.sourceId, false);
    for (const id of skipped) this.pending.set(id, true);
    this.advance();
    return reports;
  }

  /** These ids are recorded: move the cursor past every pulled id up to the first one that isn't. */
  async ack(ids: string[]): Promise<void> {
    for (const id of ids) if (this.pending.has(id)) this.pending.set(id, true);
    this.advance();
  }

  /** In-product reports have no thread to reply into. */
  async reply(): Promise<boolean> {
    return false;
  }

  private advance() {
    const after = readCursor(this.o.stateDir);
    let next = after;
    for (const id of [...this.pending.keys()].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))) {
      if (!this.pending.get(id)) break;
      if (before(next, id)) next = id;
      this.pending.delete(id);
    }
    if (next === after) return;
    privateDir(join(this.o.stateDir, 'intake'));
    writeOwnerOnly(cursorFile(this.o.stateDir), JSON.stringify({ after: next }));
  }
}

