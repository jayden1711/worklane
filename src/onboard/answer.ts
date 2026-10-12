// Answering onboarding's asks, the same way from the terminal and the dashboard:
// - a pasted secret is checked for its shape and staged in an owner-only file in the onboarding folder (never an
//   event, a response or a log), and the ask is answered "stored";
// - a root step runs through the machine helper (its rule in console/root-steps.ts), with its secret on stdin
//   when it takes one; the staged secret is deleted once the step ran, and its output kept owner-only for the step.
// Approve links and questions answer through the console's asks(log).answer.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { asks, AskError, CREDENTIAL_NAME, recordAnswer, type Ask } from '../console/asks.js';
import { checkRootStep } from '../console/root-steps.js';
import type { EventLog } from '../events/log.js';
import { redactString } from '../events/redact.js';
import type { Exec } from '../machine.js';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
import { DISCORD_TOKEN } from './discord.js';

/** Each secret onboarding asks for, and its shape: anything else is refused before it's stored. */
export const SECRET_SHAPES: Record<string, { re: RegExp; what: string }> = {
  'github-app-key': { re: /^-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END [A-Z ]*PRIVATE KEY-----\s*$/, what: "a GitHub App private key (the .pem file's contents)" },
  'github-manifest-code': { re: /^[A-Za-z0-9_-]{1,100}$/, what: 'the code GitHub put in the address bar (code=...)' },
  'claude-api-key': { re: /^sk-ant-[A-Za-z0-9_-]{20,200}$/, what: 'an Anthropic API key (sk-ant-...)' },
  'intake-discord': { re: DISCORD_TOKEN, what: "a Discord bot token (the Bot page's token)" },
};

const secretsDir = (dir: string) => join(dir, 'secrets');
const secretPath = (dir: string, credential: string) => {
  if (!CREDENTIAL_NAME.test(credential) || !SECRET_SHAPES[credential]) throw new AskError(`no secret ${credential} in onboarding`);
  return join(secretsDir(dir), credential);
};

export function stageSecret(dir: string, credential: string, value: string): void {
  const v = credential === 'github-app-key' ? value.replace(/\r\n/g, '\n').trim() + '\n' : value.trim();
  const shape = SECRET_SHAPES[credential];
  if (!shape) throw new AskError(`no secret ${credential} in onboarding`);
  if (!shape.re.test(credential === 'github-app-key' ? v : v)) throw new AskError(`that isn't ${shape.what}; nothing stored`);
  ownerOnlyDir(secretsDir(dir));
  writeOwnerOnly(secretPath(dir, credential), v);
}
export function readSecret(dir: string, credential: string): string | null {
  try {
    return readFileSync(secretPath(dir, credential), 'utf8');
  } catch {
    return null;
  }
}
export function dropSecret(dir: string, credential: string): void {
  rmSync(secretPath(dir, credential), { force: true });
}
/** The secrets still staged (names only): after onboarding there must be none. */
export function stagedSecrets(dir: string): string[] {
  return existsSync(secretsDir(dir)) ? readdirSync(secretsDir(dir)).sort() : [];
}

/** Paste a secret into a paste_secret ask: staged, then the ask answered "stored". */
export function answerSecret(log: EventLog, dir: string, id: string, by: string, value: string): Ask {
  return recordAnswer(log, id, { by, role: 'owner', answer: 'stored' }, (ask) => {
    if (ask.kind !== 'paste_secret') throw new AskError(`ask ${id} doesn't take a secret`);
    stageSecret(dir, ask.credential, value);
  });
}

export const outputPath = (dir: string, id: string) => join(dir, 'outputs', `${id.replace(/[^a-z0-9-]/gi, '')}.txt`);

/** Run a root_step ask through the helper and answer it ran or failed, with the end of its output (redacted). */
export function runRootStep(log: EventLog, dir: string, id: string, by: string, exec?: Exec): Ask {
  const ask = asks(log).get(id);
  if (!ask) throw new AskError(`no ask ${id}`, 404);
  if (ask.kind !== 'root_step') throw new AskError(`ask ${id} is not a root step`);
  if (ask.status !== 'open') throw new AskError(`ask ${id} is already ${ask.status}`, 409);
  const c = checkRootStep(ask.command, ask.args);
  if (!c.allowed) throw new AskError(c.why, 400);
  let input: string | undefined;
  if (c.rule.secret) {
    input = readSecret(dir, c.rule.secret) ?? undefined;
    if (input === undefined) throw new AskError(`${ask.command} needs ${c.rule.secret}, and none is staged; answer its paste ask first`, 409);
  }
  const r = c.rule.run(ask.args, exec, input);
  const output = r.ok ? r.output : [r.stdout, r.error].filter(Boolean).join('\n');
  mkdirSync(join(dir, 'outputs'), { recursive: true, mode: 0o700 });
  // What the command printed, for the step that asked (a report such as the doctor's), apart from any error.
  writeOwnerOnly(outputPath(dir, id), r.ok ? r.output : (r.stdout ?? ''));
  if (r.ok && c.rule.secret) dropSecret(dir, c.rule.secret);
  return recordAnswer(log, id, { by, role: 'owner', answer: r.ok ? 'ran' : 'failed', detail: redactString(output).slice(-2000) });
}
