// Root steps: the only things the setup console runs as root, and only through the machine helper
// (/usr/local/libexec/<cli>-machine, src/machine.ts) with exactly the arguments its sudoers rule lists
// (scripts/setup/machine-helper.sh). Never arbitrary sudo. Anything else is refused here, before sudo is
// reached, with what it would take: extending the helper, a reviewed change to the helper and its setup script.
import { MACHINE_HELPER, setSlotCap, setUpdates, SLOTS_MAX, SLOTS_MIN, type Exec, type MachineResult } from '../machine.js';
import { SETUP_STEPS } from './setup-steps.js';

export interface RootStepRule {
  command: string;
  /** What it does, for the console. */
  what: string;
  /** The arguments it takes, for the console. */
  usage: string;
  /** Whether these exact arguments are on the helper's sudoers list. */
  allows: (args: string[]) => boolean;
  /** A setup command that reads one secret on stdin: the credential's name (setup-steps.ts). */
  secret?: string;
  run: (args: string[], exec?: Exec, input?: string) => MachineResult;
}

/**
 * The helper's allowlist, as its sudoers rules spell it out: set-slots 1..16, set-updates on|off (coordinators),
 * and the setup commands (the setup user only; setup-steps.ts). Nothing else.
 */
export const ROOT_STEPS: readonly RootStepRule[] = [
  {
    command: 'set-slots',
    what: "set the machine's agent slot cap",
    usage: `set-slots <${SLOTS_MIN}..${SLOTS_MAX}>`,
    allows: (a) => a.length === 1 && /^(?:[1-9]|1[0-6])$/.test(a[0]!) && Number(a[0]) >= SLOTS_MIN && Number(a[0]) <= SLOTS_MAX,
    run: (a, exec) => setSlotCap(Number(a[0]), exec),
  },
  {
    command: 'set-updates',
    what: 'turn automatic engine updates on or off',
    usage: 'set-updates on|off',
    allows: (a) => a.length === 1 && (a[0] === 'on' || a[0] === 'off'),
    run: (a, exec) => setUpdates(a[0] === 'on', exec),
  },
  ...SETUP_STEPS,
];

export type RootStepCheck = { allowed: true; rule: RootStepRule } | { allowed: false; why: string };

/** Whether a root step is on the helper's allowlist; when not, why, and what it would take. */
export function checkRootStep(command: string, args: readonly string[]): RootStepCheck {
  const rule = ROOT_STEPS.find((r) => r.command === command);
  const extend = `it needs the helper extended: a reviewed change to scripts/machine/ (the helper) and scripts/setup/machine-helper.sh (its sudoers list), installed by an admin`;
  if (!rule) return { allowed: false, why: `${MACHINE_HELPER} has no command "${command}"; ${extend}` };
  if (!rule.allows([...args])) return { allowed: false, why: `${MACHINE_HELPER} ${[command, ...args].join(' ')} isn't on its allowlist (${rule.usage}); ${extend}` };
  return { allowed: true, rule };
}
