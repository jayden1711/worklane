// `<cli> audit verify --log <events.db> [--chain <file>] [--anchor <head>]` and `<cli> audit checkpoint --log <events.db>
// [--chain <file>]`: the audit chain (src/audit-chain.ts, docs/audit-log.md) by hand. verify opens the log read-only.
//   exit 0: every checkpoint matches the log (and the anchor, when given, is one of them);
//   exit 1: FAILED, with why: the log or the checkpoint file was changed;
//   exit 2: a usage error.
import { BRAND } from './brand.js';
import { DatabaseSync } from 'node:sqlite';
import { chainFileFor, checkpoint, verify } from './audit-chain.js';
import { openReadOnly } from './events/read-only.js';
import { openWaiting } from './events/open.js';

const USAGE = [`usage: ${BRAND.cli} audit verify --log <events.db> [--chain <file>] [--anchor <head>]`, `       ${BRAND.cli} audit checkpoint --log <events.db> [--chain <file>]`].join('\n');

/** The one value of `name`; given twice, or with no value, is a usage error (null: absent). */
function one(args: readonly string[], name: string): string | null | Error {
  const at = args.flatMap((a, i) => (a === name ? [i] : []));
  if (!at.length) return null;
  const v = args[at[0]! + 1];
  if (at.length > 1 || v === undefined || v.startsWith('--')) return new Error(`${name} takes one value, once`);
  return v;
}

export function auditCommand(sub: string | undefined, args: readonly string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const usage = (why?: string) => {
    if (why) err(why);
    err(USAGE);
    return 2;
  };
  if (sub !== 'verify' && sub !== 'checkpoint') return usage();
  const known = new Set(sub === 'verify' ? ['--log', '--chain', '--anchor'] : ['--log', '--chain']);
  for (let i = 0; i < args.length; i += 2) if (!known.has(args[i]!)) return usage(`unknown option: ${args[i]}`);
  const log = one(args, '--log');
  const chain = one(args, '--chain');
  const anchor = sub === 'verify' ? one(args, '--anchor') : null;
  for (const v of [log, chain, anchor]) if (v instanceof Error) return usage(v.message);
  if (log === null) return usage('--log is required');
  const file = (chain as string | null) ?? chainFileFor(log as string);
  let db: DatabaseSync;
  try {
    db = sub === 'verify' ? openReadOnly(log as string) : openWaiting(log as string);
  } catch (e) {
    err(`FAILED: can't open ${log}: ${(e as Error).message}`);
    return 1;
  }
  try {
    if (sub === 'checkpoint') {
      const c = checkpoint({ db, file });
      out(c ? `checkpoint: event ${c.event}, head ${c.head}` : 'checkpoint: no new events since the last one');
      return 0;
    }
    const r = verify({ db, file, ...(anchor !== null ? { anchor: anchor as string } : {}) });
    if (!r.ok) {
      err(`FAILED: ${r.why}`);
      return 1;
    }
    out(`verified: ${r.checkpoints} checkpoint(s), through event ${r.event}${r.anchored ? ', anchor found' : ''}`);
    out(`head: ${r.head} (keep it; pass it next time as --anchor)`);
    if (r.uncovered) out(`not yet covered: ${r.uncovered} event(s) after the last checkpoint`);
    return 0;
  } finally {
    db.close();
  }
}
