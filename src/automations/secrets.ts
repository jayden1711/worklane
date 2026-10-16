// Webhook automations' secrets and the instance's delivery state (src/automations/webhook.ts). Each secret is its own
// file in the instance's home (0400 in a 0700 folder), never in automations.yaml, an event, the audit or a response
// after the one that shows it once. The state (which node each automation is bound to, the delivery ids seen, the
// hour's counts) is the instance's own 0600 file.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOMATION_ID } from './schema.js';

/** Where an instance keeps its webhook secrets: its home, beside automations.yaml. */
export const SECRETS_DIR = 'automation-secrets';
/** The instance's state file for bindings, seen deliveries and counts. */
export const HOOKS_STATE = 'automation-hooks.json';

const secretFile = (home: string, id: string) => {
  if (!AUTOMATION_ID.test(id)) throw new Error(`not an automation id: ${id.slice(0, 40)}`);
  return join(home, SECRETS_DIR, id);
};

/** A new secret for `id` (256 bits), replacing any old one at once: 0400 in a 0700 folder. Returned once. */
export function makeSecret(home: string, id: string): string {
  const dir = join(home, SECRETS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const secret = randomBytes(32).toString('base64url');
  const f = secretFile(home, id);
  const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, secret, { mode: 0o400 });
  renameSync(tmp, f);
  return secret;
}

export function removeSecret(home: string, id: string): void {
  rmSync(secretFile(home, id), { force: true });
}

export function readSecret(home: string, id: string): string | null {
  try {
    const s = readFileSync(secretFile(home, id), 'utf8').trim();
    return s.length >= 32 ? s : null;
  } catch {
    return null;
  }
}

export interface HooksState {
  bound: Record<string, { id: string; name: string; at: string }>;
  seen: Record<string, Record<string, number>>;
  accepted: Record<string, number[]>;
  refused: Record<string, number[]>;
}

export function readHooksState(stateDir: string): HooksState {
  try {
    const v = JSON.parse(readFileSync(join(stateDir, HOOKS_STATE), 'utf8')) as Partial<HooksState>;
    return { bound: v.bound ?? {}, seen: v.seen ?? {}, accepted: v.accepted ?? {}, refused: v.refused ?? {} };
  } catch {
    return { bound: {}, seen: {}, accepted: {}, refused: {} };
  }
}

export function writeHooksState(stateDir: string, s: HooksState): void {
  mkdirSync(stateDir, { recursive: true });
  const f = join(stateDir, HOOKS_STATE);
  const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, f);
}

/** Forget which node an automation is bound to (an owner's unbind; and a delete). Its next valid delivery binds it again. */
export function unbind(stateDir: string, id: string): boolean {
  const s = readHooksState(stateDir);
  if (!s.bound[id]) return false;
  delete s.bound[id];
  writeHooksState(stateDir, s);
  return true;
}

