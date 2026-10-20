// The engine's part of renaming an instance (scripts/setup/instance-rename.sh <old> <new>), run as the new instance's
// coordinator once the old one's history is imported into it, before its coordinator first starts:
//   - Asks: each one still open for the old name (the console lists an instance's own asks only) is withdrawn, saying
//     so, and asked again, the same, for the new name. Answered and withdrawn asks stay as they were: history.
// Run again, it finds nothing left to carry. (Siri device tokens, which a rename used to revoke, were removed with
// Siri (#743); an import never brings an old store across: src/instance-move.ts.)
import { asks, type Ask, type AskInput } from './console/asks.js';
import type { EventLog } from './events/log.js';

const NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** The input that asks the same thing again, for another instance. */
function again(a: Ask, instance: string): AskInput {
  const base = { instance, title: a.title, detail: a.detail };
  if (a.kind === 'paste_secret') return { ...base, kind: a.kind, credential: a.credential, where: a.where };
  if (a.kind === 'approve_link') return { ...base, kind: a.kind, url: a.url };
  if (a.kind === 'question') return { ...base, kind: a.kind, options: a.options, writersMayAnswer: a.writersMayAnswer };
  return { ...base, kind: a.kind, command: a.command, args: a.args };
}

export function renamedFrom(o: { stateDir: string; log: EventLog; from: string; to: string; now?: Date }): { carried: { from: string; to: string }[] } {
  if (!NAME.test(o.from) || !NAME.test(o.to) || o.from === o.to) throw new Error('renamed: two different instance names');
  const by = `rename from ${o.from}`;
  const a = asks(o.log);
  const carried: { from: string; to: string }[] = [];
  for (const old of a.list({ instance: o.from, status: 'open' })) {
    a.cancel(old.id, by, `the instance was renamed to ${o.to}; asked again there`);
    carried.push({ from: old.id, to: a.create(again(old, o.to), by).id });
  }
  return { carried };
}
