// `<cli> rollout status --flag <name> [--file <rollout.json>]`: where a flagged change stands, ring by ring
// (src/rollout.ts, docs/rollout.md). Read-only: it opens each ring instance's event log read-only and changes nothing.
//   exit 0: the status (and the one next step); 1: the rollout file or a log can't be used; 2: a usage error.
import { join } from 'node:path';
import { BRAND } from './brand.js';
import type { StoredEvent } from './events/types.js';
import { openReadOnly } from './events/read-only.js';
import { FLAGS } from './flags.js';
import { instancesDir, listInstances } from './instance.js';
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

export function rolloutCommand(sub: string | undefined, args: readonly string[], o: { out?: (s: string) => void; err?: (s: string) => void; eventsOf?: (instance: string) => StoredEvent[]; instances?: () => string[]; now?: Date } = {}): number {
  const out = o.out ?? console.log;
  const err = o.err ?? console.error;
  // Options as pairs, each once: anything else is a usage error (a stray word is never skipped).
  const given = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i]!, args[i + 1]];
    if (!['--flag', '--file'].includes(k) || v === undefined || v.startsWith('--') || given.has(k)) {
      err(USAGE);
      return 2;
    }
    given.set(k, v);
  }
  const opt = (name: string) => given.get(name) ?? null;
  if (sub !== 'status') {
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
  // Every other instance on this machine, in no ring: the flag may be on there too (#1174 review).
  const inRings = new Set(rollout.rings.flatMap((r) => r.instances));
  let others: string[] = [];
  try {
    others = (o.instances ?? (() => listInstances()))().filter((n) => !inRings.has(n));
  } catch (e) {
    err(`can't list this machine's instances: ${(e as Error).message.split('\n')[0]}`);
  }
  const outside = new Map<string, StoredEvent[]>();
  for (const n of others) {
    try {
      outside.set(n, eventsOf(n));
    } catch (e) {
      err(`can't read ${n}'s event log (in no ring): ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (!(flag in FLAGS)) out(`note: ${flag} is not a flag this engine knows (${Object.keys(FLAGS).join(', ') || 'none yet'}); every ring reads it as off`);
  const s = rolloutStatus({ rollout, flag, logs, now: o.now ?? new Date(), outside, outsideNames: others });
  for (const [i, r] of s.rings.entries()) out(`ring ${i} ${r.ring} (${r.instances.join(', ')}): ${r.state}: ${r.why}`);
  for (const n of s.outsideOn) out(`outside the rollout: ${n} has ${flag} on, in no ring`);
  out(`next: ${s.next}`);
  return logs.size === inRings.size && !s.outsideUnread.length ? 0 : 1;
}
