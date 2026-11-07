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
import { CLAUDE_ASK_WITHDRAWN, CREDENTIAL_REFUSED, holdsClaudeCredential } from '../claude-credential-guard.js';
import { installOwnerOnlySecret } from '../os/index.js';
import { DETAIL_LOGGED, logDetail } from '../user-facing-error.js';
import { AskError, asks, isClaudeCredentialAsk, recordAnswer, type Ask, type Role } from './asks.js';

export const MAX_SECRET = 16_384;

/**
 * At coordinator startup (issue #711): withdraw every open ask an earlier version opened for a Claude credential
 * (add-project's claude-token, left open when the coordinator stopped mid-run), so no page offers its paste box.
 * The withdrawal's event says why, in a fixed text. Returns the ids withdrawn.
 */
export function withdrawClaudeCredentialAsks(log: EventLog): string[] {
  const a = asks(log);
  const out: string[] = [];
  for (const ask of a.list({ status: 'open' })) {
    if (!isClaudeCredentialAsk(ask)) continue;
    try {
      a.cancel(ask.id, 'coordinator', CLAUDE_ASK_WITHDRAWN);
      out.push(ask.id);
    } catch {
      // answered or withdrawn meanwhile: either way it is no longer open
    }
  }
  return out;
}

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
  // INVARIANT (issue #711): no paste box takes a Claude credential, whichever ask it answers.
  if (holdsClaudeCredential(value)) throw new AskError(CREDENTIAL_REFUSED);
  return value;
}

/**
 * What the server does for one credential beyond storing it (the dashboard's, per credential name):
 * - `shape`: what its value must look like; one that doesn't is refused with `what`, a fixed text, and nothing is
 *   stored;
 * - `stored`: runs once the file is installed, with the file's path only (never the value), inside the answer's
 *   transaction: when it throws, the ask stays open. What it returns is added to the answer's detail.
 */
export interface SecretRule {
  shape?: { re: RegExp; what: string };
  stored?: (ask: Ask & { kind: 'paste_secret' }, file: string) => string | void;
}

/**
 * Install a pasted secret for an open paste_secret ask and answer it, once. Owner only. The answer records
 * who, when and the file it went to; the value goes nowhere but that file.
 */
export function storeSecret(log: EventLog, id: string, a: { by: string; role: Role | null; value: string; dir: string; rules?: Record<string, SecretRule> }): Ask {
  const value = a.value.replace(/\r?\n$/, '');
  if (!value) throw new AskError('the secret is empty');
  if (value.length > MAX_SECRET) throw new AskError(`the secret is longer than ${MAX_SECRET} bytes`);
  if (/[\0]/.test(value)) throw new AskError('the secret has a NUL byte');
  if (holdsClaudeCredential(value)) throw new AskError(CREDENTIAL_REFUSED);
  return recordAnswer(log, id, { by: a.by, role: a.role, answer: 'stored' }, (ask) => {
    if (ask.kind !== 'paste_secret') throw new AskError(`ask ${id} isn't a paste_secret ask`);
    // An ask an earlier version opened for a Claude credential (add-project's claude-token) never gets here:
    // recordAnswer refuses it first (isClaudeCredentialAsk).
    const rule = a.rules && Object.hasOwn(a.rules, ask.credential) ? a.rules[ask.credential] : undefined;
    // INVARIANT: a refusal is the rule's fixed text, never the value.
    if (rule?.shape && !rule.shape.re.test(value)) throw new AskError(rule.shape.what);
    let file: string;
    try {
      file = installOwnerOnlySecret(a.dir, ask.credential, value);
    } catch (e) {
      // The OS error names the path, never the value: the log may have it, the page not (#882).
      logDetail(`installing the secret for ask ${id}`, e);
      throw new AskError(`couldn't install the secret; ${DETAIL_LOGGED}`);
    }
    let more: string | void;
    try {
      more = rule?.stored?.(ask, file);
    } catch (e) {
      // It was given the path only, so its message can't hold the value.
      logDetail(`the step after installing the secret for ask ${id}`, e);
      throw new AskError(`the secret is installed, but the step after it failed; ${DETAIL_LOGGED}`);
    }
    return `installed ${file} (0400, this user only)${more ? `; ${more}` : ''}`;
  });
}
