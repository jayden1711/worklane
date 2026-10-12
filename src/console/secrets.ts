// A pasted secret, from the browser straight to the credential store: one file per credential, for the
// coordinator user only (0400) in a 0700 directory of the instance's (credentials.sh's layout and modes). The
// dashboard runs as that user, so it writes the file itself; no agent user can read that directory.
//
// The value is never logged, never in an event (the answer records only that it was stored, and where), never
// echoed in a response or an error, and never passed to an agent or the chat model. Errors from parsing or
// writing are replaced by fixed messages, because some (JSON.parse's) quote their input.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { EventLog } from '../events/log.js';
import { installOwnerOnlySecret } from '../os/index.js';
import { AskError, recordAnswer, type Ask, type Role } from './asks.js';

export const MAX_SECRET = 16_384;

/** Where an instance's pasted credentials go: in the coordinator user's home, beside the intake secrets. */
export const secretsDir = (instance: string, home = homedir()) => join(home, '.config', `${instance}-secrets`);

/**
 * The request body of a pasted secret, `{"value": "..."}`. Every failure is a fixed message: never the body,
 * never a parser's message (which quotes it).
 */
export async function readSecretBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_SECRET + 1024) throw new AskError(`the secret is longer than ${MAX_SECRET} bytes`);
    chunks.push(c as Buffer);
  }
  let value: unknown;
  try {
    value = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { value?: unknown }).value;
  } catch {
    throw new AskError('the body must be JSON: {"value": "<the secret>"}');
  } finally {
    for (const c of chunks) c.fill(0);
  }
  if (typeof value !== 'string') throw new AskError('the body must be JSON: {"value": "<the secret>"}');
  return value;
}

/**
 * Install a pasted secret for an open paste_secret ask and answer it, once. Owner only. The answer records
 * who, when and the file it went to; the value goes nowhere but that file.
 */
export function storeSecret(log: EventLog, id: string, a: { by: string; role: Role | null; value: string; dir: string }): Ask {
  const value = a.value.replace(/\r?\n$/, '');
  if (!value) throw new AskError('the secret is empty');
  if (value.length > MAX_SECRET) throw new AskError(`the secret is longer than ${MAX_SECRET} bytes`);
  if (/[\0]/.test(value)) throw new AskError('the secret has a NUL byte');
  return recordAnswer(log, id, { by: a.by, role: a.role, answer: 'stored' }, (ask) => {
    if (ask.kind !== 'paste_secret') throw new AskError(`ask ${id} isn't a paste_secret ask`);
    try {
      return `installed ${installOwnerOnlySecret(a.dir, ask.credential, value)} (0400, this user only)`;
    } catch (e) {
      // The OS error names the path, never the value; keep only its first line.
      throw new AskError(`couldn't install the secret: ${String((e as Error).message).split('\n')[0]}`);
    }
  });
}
