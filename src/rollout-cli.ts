// `<cli> rollout status --flag <name> [--file <rollout.json>]`: where a flagged change stands, ring by ring
// (src/rollout.ts, docs/rollout.md). Read-only: it opens each ring instance's event log read-only and changes nothing.
//   exit 0: the status (and the one next step); 1: the rollout file or a log can't be used; 2: a usage error.
import { join } from 'node:path';
import { BRAND } from './brand.js';
import type { StoredEvent } from './events/types.js';
import { openReadOnly } from './events/read-only.js';
import { FLAGS } from './flags.js';
import { instancesDir } from './instance.js';
import { ROLLOUT_FILE, readRollout, rolloutStatus, type Rollout } from './rollout.js';

const USAGE = `usage: ${BRAND.cli} rollout status --flag <name> [--file <rollout.json>]`;

/** An instance's events, read-only: the rows as stored, payloads parsed. */
export function readEvents(db: string): StoredEvent[] {
  const d = openReadOnly(db);
  try {
    const rows = d.prepare('SELECT id, ts, type, actor, source, payload FROM events ORDER BY id').all() as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), ts: String(r.ts), type: r.type, actor: String(r.actor), source: r.source, payload: JSON.parse(String(r.payload)) }) as StoredEvent);
  } finally {
    d.close();
  }
}

export function rolloutCommand(sub: string | undefined, args: readonly string[], o: { out?: (s: string) => void; err?: (s: string) => void; eventsOf?: (instance: string) => StoredEvent[]; now?: Date } = {}): number {
  const out = o.out ?? console.log;
  const err = o.err ?? console.error;
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? null : (args[i + 1] ?? '');
  };
  if (sub !== 'status' || args.some((a, i) => a.startsWith('--') && !['--flag', '--file'].includes(a) && i % 2 === 0)) {
    err(USAGE);
    return 2;
  }
  const flag = opt('--flag');
  if (!flag) {
    err(USAGE);
    return 2;
  }
  let rollout: Rollout;
  const file = opt('--file') ?? ROLLOUT_FILE();
  try {
    rollout = readRollout(file);
  } catch (e) {
    err(`can't use ${file}: ${(e as Error).message.split('\n')[0]}`);
    return 1;
  }
  const eventsOf = o.eventsOf ?? ((n: string) => readEvents(join(instancesDir(), n, 'state', 'events.db')));
  const logs = new Map<string, StoredEvent[]>();
  for (const n of rollout.rings.flatMap((r) => r.instances)) {
    try {
      logs.set(n, eventsOf(n));
    } catch (e) {
      err(`can't read ${n}'s event log: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (!(flag in FLAGS)) out(`note: ${flag} is not a flag this engine knows (${Object.keys(FLAGS).join(', ') || 'none yet'}); every ring reads it as off`);
  const s = rolloutStatus({ rollout, flag, logs, now: o.now ?? new Date() });
  for (const [i, r] of s.rings.entries()) out(`ring ${i} ${r.ring} (${r.instances.join(', ')}): ${r.state}: ${r.why}`);
  out(`next: ${s.next}`);
  return logs.size === rollout.rings.flatMap((r) => r.instances).length ? 0 : 1;
}
