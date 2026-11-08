// The audit chain (docs/audit-log.md): a SHA-256 hash chain over every row of the event log, so a change to any
// recorded action (an agent run, a merge, a decision, a dashboard write, a guardrail block) shows.
//
//   - Each row links to the one before it: link(prev, row) = sha256(prev, "\n", the row's stored text as one JSON
//     array [id, ts, type, actor, source, payload]). The payload is the exact text SQLite holds, never re-serialized,
//     so the chain is over what was written, byte for byte. The first row links to GENESIS.
//   - The coordinator appends a checkpoint, at most every CHECKPOINT_EVERY_MS, to `audit-chain.jsonl` beside the
//     events database: the last event id it covers, the chain's head there, when, and the SHA-256 of the line before
//     it (GENESIS for the first), so a checkpoint line edited or dropped from the middle shows too.
//   - verify() recomputes the whole chain from the first row and checks every checkpoint against it. It names the
//     first checkpoint that disagrees, and so the range of events (after the last good checkpoint, up to that one)
//     where something changed.
//
// WHY: the event log is append-only by its triggers (src/events/log.ts), which stop the engine's own code but not the
// user who owns the file: that user can drop a trigger or rewrite the file. Signed receipts (src/signed-receipts.ts)
// cover merges only. This covers every event, with no key.
//
// What it can't do (the doc has the whole list): whoever can write both the database and the checkpoint file can
// rewrite both consistently. Only a head kept somewhere else (`verify --anchor <head>`) shows that, as with receipts.
// Events after the last checkpoint aren't covered until the next one.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { groupOnly } from './os/index.js';

export const GENESIS = '0'.repeat(64);
export const CHAIN_FILE = 'audit-chain.jsonl';
/** How often the coordinator appends a checkpoint, at most (one line each: about 8 MB a year at this rate). */
export const CHECKPOINT_EVERY_MS = 10 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

/** One stored row of the events table, as SQLite holds it (payload as its stored text). */
export interface ChainRow {
  id: number;
  ts: string;
  type: string;
  actor: string;
  source: string;
  payload: string;
}

export interface Checkpoint {
  v: 1;
  /** The last event id the head covers. */
  event: number;
  head: string;
  at: string;
  /** SHA-256 of the previous line's text (GENESIS for the first line). */
  prev: string;
}

export const chainFileFor = (eventsDb: string) => join(dirname(eventsDb), CHAIN_FILE);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function link(prev: string, r: ChainRow): string {
  return sha256(`${prev}\n${JSON.stringify([r.id, r.ts, r.type, r.actor, r.source, r.payload])}`);
}

/** The stored rows after `afterId`, in id order, read one at a time (a long log never sits in memory whole). */
function* rowsAfter(db: DatabaseSync, afterId: number): Generator<ChainRow> {
  const q = db.prepare('SELECT id, ts, type, actor, source, payload FROM events WHERE id > ? ORDER BY id');
  for (const r of q.iterate(afterId) as Iterable<Record<string, unknown>>) {
    yield { id: Number(r.id), ts: String(r.ts), type: String(r.type), actor: String(r.actor), source: String(r.source), payload: String(r.payload) };
  }
}

/** The chain's head after every row up to `upTo` (all rows when absent), from `start` (GENESIS after event 0). */
export function headOf(db: DatabaseSync, o: { after?: number; start?: string; upTo?: number } = {}): { event: number; head: string } {
  let head = o.start ?? GENESIS;
  let event = o.after ?? 0;
  for (const r of rowsAfter(db, event)) {
    if (o.upTo !== undefined && r.id > o.upTo) break;
    head = link(head, r);
    event = r.id;
  }
  return { event, head };
}

/** The file's lines as checkpoints; a line that isn't one is an error naming its line number. */
export function readCheckpoints(file: string): { lines: string[]; checkpoints: Checkpoint[] } {
  if (!existsSync(file)) return { lines: [], checkpoints: [] };
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const checkpoints = lines.map((l, i) => {
    let c: unknown;
    try {
      c = JSON.parse(l);
    } catch {
      throw new Error(`${file}: line ${i + 1} is not JSON`);
    }
    const o = c as Partial<Checkpoint>;
    if (o.v !== 1 || !Number.isSafeInteger(o.event) || (o.event as number) < 0 || typeof o.head !== 'string' || !HEX64.test(o.head) || typeof o.prev !== 'string' || !HEX64.test(o.prev) || typeof o.at !== 'string') {
      throw new Error(`${file}: line ${i + 1} is not a checkpoint`);
    }
    return o as Checkpoint;
  });
  return { lines, checkpoints };
}

/**
 * Append a checkpoint for the rows written since the last one, continuing from its head. Nothing when no row is
 * newer. It trusts the file's last line for where to continue; verify() is what checks the whole chain.
 */
export function checkpoint(o: { db: DatabaseSync; file: string; now?: () => Date }): Checkpoint | null {
  const { lines, checkpoints } = readCheckpoints(o.file);
  const last = checkpoints.at(-1);
  const { event, head } = headOf(o.db, last ? { after: last.event, start: last.head } : {});
  if (last ? event === last.event : event === 0) return null;
  const c: Checkpoint = { v: 1, event, head, at: (o.now ?? (() => new Date()))().toISOString(), prev: lines.length ? sha256(lines.at(-1)!) : GENESIS };
  appendFileSync(o.file, `${JSON.stringify(c)}\n`, { mode: 0o640 });
  groupOnly(o.file);
  return c;
}

export type VerifyResult =
  | { ok: true; checkpoints: number; event: number; head: string; uncovered: number; anchored: boolean }
  | { ok: false; why: string };

/**
 * Recompute the chain from the first row and check every checkpoint: each line chains to the one before it, its
 * events exist, and its head is the chain's head at its event. With `anchor` (a head kept elsewhere), that head must
 * be one of the checkpoints', so a file cut short or rewritten with the log shows too.
 */
export function verify(o: { db: DatabaseSync; file: string; anchor?: string }): VerifyResult {
  if (o.anchor !== undefined && !HEX64.test(o.anchor)) return { ok: false, why: `--anchor is not a head (64 lowercase hex characters): ${JSON.stringify(o.anchor)}` };
  let read: ReturnType<typeof readCheckpoints>;
  try {
    read = readCheckpoints(o.file);
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
  const { lines, checkpoints } = read;
  let head = GENESIS;
  let event = 0;
  let good: Checkpoint | null = null;
  const rows = rowsAfter(o.db, 0);
  let next = rows.next();
  for (const [i, c] of checkpoints.entries()) {
    const where = `checkpoint ${i + 1} of ${checkpoints.length} (event ${c.event})`;
    const prev = i === 0 ? GENESIS : sha256(lines[i - 1]!);
    if (c.prev !== prev) return { ok: false, why: `${where}: does not chain to the line before it (a checkpoint was changed, removed or inserted)` };
    if (c.event < event) return { ok: false, why: `${where}: goes back from event ${event}` };
    while (!next.done && next.value.id <= c.event) {
      head = link(head, next.value);
      event = next.value.id;
      next = rows.next();
    }
    if (event !== c.event) return { ok: false, why: `${where}: event ${c.event} is not in the log (the last one at or before it is ${event}); events were removed${good ? ` after event ${good.event}` : ''}` };
    if (head !== c.head) return { ok: false, why: `${where}: the log's head there is ${head}, the checkpoint says ${c.head}: an event was changed, removed or inserted ${good ? `after event ${good.event}` : 'at or before it'}, up to event ${c.event}` };
    good = c;
  }
  let uncovered = 0;
  for (; !next.done; next = rows.next()) uncovered++;
  const anchored = o.anchor !== undefined;
  if (anchored && !checkpoints.some((c) => c.head === o.anchor)) return { ok: false, why: `the anchor ${o.anchor} is no checkpoint's head: the checkpoint file was cut short or rewritten` };
  return { ok: true, checkpoints: checkpoints.length, event: good?.event ?? 0, head: good?.head ?? GENESIS, uncovered, anchored };
}
