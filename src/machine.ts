// Machine-wide settings an instance may change: the agent slot cap, the test-run slot cap and the engine update switch.
// They are root-owned, so an instance changes them only through the machine helper, which sudo
// lets each coordinator user run with exactly these arguments (scripts/setup/machine-helper.sh).
// The helper validates again and logs every change; this side refuses bad values before asking.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';
import { instanceNameOk } from './instance-name.js';
import { asRoot, etcPath, libexecPath, varLibPath } from './os/system-paths.js';

export const MACHINE_HELPER = libexecPath('machine');
export const MACHINE_CHANGES = varLibPath('machine-changes.jsonl');
export const SLOTS_MIN = 1;
export const SLOTS_MAX = 16;

export interface MachineChange {
  at: string;
  by: string;
  what: string;
  from: unknown;
  to: unknown;
}

export type Exec = (file: string, args: string[]) => string;
const defaultExec: Exec = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

export type MachineResult = { ok: true; output: string } | { ok: false; error: string };

function runHelper(args: string[], exec: Exec): MachineResult {
  try {
    return { ok: true, output: exec('sudo', ['-n', MACHINE_HELPER, ...args]).trim() };
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message: string };
    const text = `${err.stderr ?? ''}`.trim() || err.message;
    // sudo -n refuses rather than prompting: the rule isn't installed for this user (or not for these arguments).
    if (/password is required|not allowed to execute|may not run sudo|is not in the sudoers/i.test(text)) {
      return { ok: false, error: `this user may not run ${MACHINE_HELPER} ${args.join(' ')} (sudo: ${text.split('\n')[0]!.replace(/^sudo:\s*/, '')}); an admin runs scripts/setup/machine-helper.sh with every instance once` };
    }
    if (/command not found|no such file/i.test(text)) return { ok: false, error: `${MACHINE_HELPER} isn't installed; an admin runs scripts/setup/machine-helper.sh once` };
    return { ok: false, error: `${MACHINE_HELPER} ${args.join(' ')} failed: ${text.slice(0, 500)}` };
  }
}

/** One plugin or MCP step through the helper (src/plugins/steps.ts checked its shape), for the asking coordinator's instance. */
export function pluginStep(args: readonly string[], exec: Exec = defaultExec): MachineResult {
  return runHelper([...args], exec);
}

/** Set the machine's agent slot cap (1..16) through the helper. */
export function setSlotCap(n: number, exec: Exec = defaultExec): MachineResult {
  if (!Number.isInteger(n) || n < SLOTS_MIN || n > SLOTS_MAX) return { ok: false, error: `the slot cap must be a whole number from ${SLOTS_MIN} to ${SLOTS_MAX}, not ${n}` };
  return runHelper(['set-slots', String(n)], exec);
}

export const TEST_SLOTS_MIN = 1;
export const TEST_SLOTS_MAX = 8;

/** Set how many test runs go at once on the machine (1..8) through the helper. */
export function setTestSlotCap(n: number, exec: Exec = defaultExec): MachineResult {
  if (!Number.isInteger(n) || n < TEST_SLOTS_MIN || n > TEST_SLOTS_MAX) return { ok: false, error: `the test-run slot cap must be a whole number from ${TEST_SLOTS_MIN} to ${TEST_SLOTS_MAX}, not ${n}` };
  return runHelper(['set-test-slots', String(n)], exec);
}

/** Turn automatic engine updates on or off through the helper. */
export function setUpdates(on: boolean, exec: Exec = defaultExec): MachineResult {
  return runHelper(['set-updates', on ? 'on' : 'off'], exec);
}

/**
 * The agents' Claude account through the helper (scripts/setup/claude-account.sh, src/claude-account.ts): status
 * refreshes each agent user's account and expiry; switch starts the switch as its own unit, which then takes the token
 * from this instance's dashboard.
 */
export function claudeAccount(action: 'status' | 'switch', exec: Exec = defaultExec): MachineResult {
  return runHelper(['claude-account', action], exec);
}

/**
 * A Claude account profile step through the helper (src/claude-profiles.ts): profile-add|remove|use <profile>, for
 * this coordinator's own instance (the helper takes it from sudo). It starts the step as its own unit and returns at
 * once; the caller checked the shape.
 */
export function claudeProfile(args: readonly string[], exec: Exec = defaultExec): MachineResult {
  return runHelper(['claude-account', ...args], exec);
}

/** What the engine updater follows (scripts/machine/, the updater): signed release tags, or main's green commits. */
export const UPDATE_CHANNELS = ['release', 'main'] as const;
export type UpdateChannelName = (typeof UPDATE_CHANNELS)[number];

/** Install the engine updater (off) through the helper: the installed engine's scripts/setup/updates.sh, no arguments. */
export function installUpdater(exec: Exec = defaultExec): MachineResult {
  return runHelper(['install-updater'], exec);
}

/**
 * Put an installed updater on the release channel (signed release tags), through the helper; nothing else in its
 * config changes. The helper takes no other channel: following main is an admin's, at a root shell.
 */
export function followReleases(exec: Exec = defaultExec): MachineResult {
  return runHelper(['set-update-channel', 'release'], exec);
}

/**
 * A staged signer's arguments, exactly as the machine helper takes them (scripts/machine/, the helper's source; a
 * test keeps the two equal): one principal of an email's shape (never a pattern, a list or an option) and one ed25519
 * public key in its fixed encoding (the key type's name and 32 bytes: 68 base64 characters).
 */
export function signerPrincipalOk(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && /^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(s);
}
const ED25519_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32])]);
export function signerKeyOk(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]{68}$/.test(s)) return false;
  const blob = Buffer.from(s, 'base64');
  return blob.length === 51 && blob.subarray(0, ED25519_HEAD.length).equals(ED25519_HEAD) && blob.toString('base64') === s;
}
/** A public key's fingerprint as `ssh-keygen -l` prints it: what an owner checks the key against. */
export function signerFingerprint(key: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Stage one release signer through the helper, or take a staged one back out. Staging adds nothing to the keys the
 * updater trusts: the helper only writes its pending list, and an admin confirms a staged signer at a root shell.
 */
export function stagedSigner(action: 'stage' | 'discard', principal: string, key: string, exec: Exec = defaultExec): MachineResult {
  if (!signerPrincipalOk(principal) || !signerKeyOk(key)) return { ok: false, error: 'a release signer is one principal of an email\'s shape and one ssh-ed25519 public key' };
  return runHelper([`${action}-update-signer`, principal, 'ssh-ed25519', key], exec);
}

/**
 * A Tailscale setup step through the helper (scripts/setup/tailscale.sh, src/tailscale-setup.ts): it starts the step
 * as its own unit and returns at once. The step is one fixed word; nothing else is passed.
 */
export function tailscaleStep(action: 'install' | 'up' | 'serve' | 'public-url', exec: Exec = defaultExec): MachineResult {
  return runHelper(['tailscale', action], exec);
}

/**
 * add-project's arguments, exactly as the machine helper takes them (scripts/machine/, the helper's source; a test
 * keeps the two equal): an instance name (src/instance-name.ts: never one whose users or units are another's) and a
 * GitHub owner/name.
 */
export function addProjectNameOk(s: unknown): s is string {
  return instanceNameOk(s);
}
export function addProjectRepoOk(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(s);
  return !!m && m[2] !== '.' && m[2] !== '..';
}

/** What machine-helper.sh recorded about this machine's sudo rule (scripts/setup/lib.sh HELPER_RULES). */
export const HELPER_RULES = etcPath('helper-rules.json');
/** The root command an owner runs instead, where the helper's add-project rule isn't installed. */
export const ADD_PROJECT_SCRIPT = asRoot.opt('current/scripts/setup/add-project.sh');

/**
 * The helper's commands this machine's sudo rule leaves out (an older sudo reads their patterns as literal text), and
 * that sudo's version; null when machine-helper.sh hasn't recorded it (a machine set up before it did).
 */
export function helperRules(path = HELPER_RULES): { sudo: string | null; leftOut: string[] } | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { sudo?: unknown; left_out?: unknown };
    return { sudo: typeof j.sudo === 'string' && j.sudo ? j.sudo : null, leftOut: Array.isArray(j.left_out) ? j.left_out.filter((x): x is string => typeof x === 'string') : [] };
  } catch {
    return null;
  }
}

/** The root command for one add-project, its name and repo filled in (or placeholders). */
export const addProjectCommand = (name?: string, repo?: string) => `sudo bash ${ADD_PROJECT_SCRIPT} ${name || '<name>'} ${repo || '<owner/repo>'}`;

/** The helper's change log, newest last; unreadable or malformed lines are skipped. */
export function machineChanges(path = MACHINE_CHANGES, limit = 200): MachineChange[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: MachineChange[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Partial<MachineChange>;
      if (typeof j.at === 'string' && typeof j.by === 'string' && typeof j.what === 'string') out.push({ at: j.at, by: j.by, what: j.what, from: j.from ?? null, to: j.to ?? null });
    } catch {
      // a torn or foreign line: skip it
    }
  }
  return out.slice(-limit);
}
