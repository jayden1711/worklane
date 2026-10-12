// Machine-wide settings an instance may change: the agent slot cap and the engine update switch.
// They are root-owned, so an instance changes them only through the machine helper, which sudo
// lets each coordinator user run with exactly these arguments (scripts/setup/machine-helper.sh).
// The helper validates again and logs every change; this side refuses bad values before asking.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';

export const MACHINE_HELPER = `/usr/local/libexec/${BRAND.cli}-machine`;
export const MACHINE_CHANGES = `/var/lib/${BRAND.cli}/machine-changes.jsonl`;
export const SLOTS_MIN = 1;
export const SLOTS_MAX = 16;

export interface MachineChange {
  at: string;
  by: string;
  what: string;
  from: unknown;
  to: unknown;
}

/** Run a command and return its stdout; `input`, when given, is its stdin (a secret for a setup command). */
export type Exec = (file: string, args: string[], input?: string) => string;
const defaultExec: Exec = (file, args, input) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: input === undefined ? 30_000 : 1_800_000, ...(input === undefined ? {} : { input }) });

export type MachineResult = { ok: true; output: string } | { ok: false; error: string };

function runHelper(args: string[], exec: Exec, input?: string): MachineResult {
  try {
    return { ok: true, output: (input === undefined ? exec('sudo', ['-n', MACHINE_HELPER, ...args]) : exec('sudo', ['-n', MACHINE_HELPER, ...args], input)).trim() };
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

/** Set the machine's agent slot cap (1..16) through the helper. */
export function setSlotCap(n: number, exec: Exec = defaultExec): MachineResult {
  if (!Number.isInteger(n) || n < SLOTS_MIN || n > SLOTS_MAX) return { ok: false, error: `the slot cap must be a whole number from ${SLOTS_MIN} to ${SLOTS_MAX}, not ${n}` };
  return runHelper(['set-slots', String(n)], exec);
}

/** Turn automatic engine updates on or off through the helper. */
export function setUpdates(on: boolean, exec: Exec = defaultExec): MachineResult {
  return runHelper(['set-updates', on ? 'on' : 'off'], exec);
}

/**
 * One of the helper's setup commands (onboarding a project), as the setup user. The arguments are checked by
 * the caller (console/root-steps.ts) and again by the helper; a secret goes on stdin, never in the arguments.
 */
export function runSetupCommand(command: string, args: string[], input?: string, exec: Exec = defaultExec): MachineResult {
  return runHelper([command, ...args], exec, input);
}

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
