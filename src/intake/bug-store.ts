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

/** Pull reports newer than the stored cursor and advance it. */
export function pullBugReports(stateDir: string, query: string, run: ReadOnlyQuery, now = () => new Date()): IncomingReport[] {
  const after = readCursor(stateDir);
  const r = run(withCursor(query, after));
  if (!r.ok) throw new Error(`bug-report read failed: ${r.error ?? 'unknown'}`);
  const { rows } = JSON.parse(r.output) as { rows: Row[] };
  const out: IncomingReport[] = [];
  let next = after;
  for (const row of rows ?? []) {
    if (row.text == null || row.id == null) continue;
    const id = String(row.id);
    out.push({
      source: 'bug-store',
      sourceId: id,
      sender: { source: 'bug-store', id: row.reporter == null ? 'anonymous' : String(row.reporter) },
      text: String(row.text),
      receivedAt: row.created_at ?? now().toISOString(),
    });
    next = /^\d+$/.test(id) && /^\d+$/.test(next) ? String(Math.max(Number(next), Number(id))) : id > next ? id : next;
  }
  if (next !== after) {
    privateDir(join(stateDir, 'intake'));
    writeOwnerOnly(cursorFile(stateDir), JSON.stringify({ after: next }));
  }
  return out;
}
