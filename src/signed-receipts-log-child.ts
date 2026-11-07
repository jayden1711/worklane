// The signer's event-log reader (#918 round 15), run as a child process by src/signed-receipts-store.ts (inLogChild)
// under a deadline and a heap limit, so the signer process itself never opens the log: a read that blocks (a FIFO at
// the log or beside it) or runs out of memory is killed there, and the signer refuses, releases its lock and writes
// nothing. It reads one query as JSON on stdin and writes one answer as JSON on stdout; it writes no file.
import { readFileSync } from 'node:fs';
import { ReceiptError, scanEvents } from './signed-receipts.js';
import { withLog, type LogChildQuery } from './signed-receipts-store.js';

function answer(): { ok: true; result: unknown } | { ok: false; error: string } {
  try {
    const q = JSON.parse(readFileSync(0, 'utf8')) as LogChildQuery;
    if (q.op === 'lastId') return { ok: true, result: withLog(q.log, (l) => l.lastId().toString()) };
    return { ok: true, result: withLog(q.log, (l) => scanEvents(l.rows(), q.scan)) };
  } catch (e) {
    // Any other error (SQLite's "database disk image is malformed", "database is locked") is the log's: named as such.
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: e instanceof ReceiptError ? message : `the event log can't be read (${message}); nothing was signed` };
  }
}

const a = answer();
process.stdout.write(JSON.stringify(a));
if (!a.ok) process.exitCode = 1;
