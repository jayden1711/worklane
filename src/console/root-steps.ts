// Root steps: the only things the setup console runs as root, and only through the machine helper
// (/usr/local/libexec/<cli>-machine, src/machine.ts) with exactly the arguments its sudoers rule lists
// (scripts/setup/machine-helper.sh). Never arbitrary sudo. Anything else is refused here, before sudo is
// reached, with what it would take: extending the helper, a reviewed change to the helper and its setup script.
import type { EventLog } from '../events/log.js';
import { AskError, asks, mayAnswerAsk, type Ask, type Role } from './asks.js';
import { MachineRequestError, requestMachineChange, type MachineRequest } from '../machine-requests.js';
import { MACHINE_HELPER, setSlotCap, setUpdates, SLOTS_MAX, SLOTS_MIN, type Exec, type MachineResult } from '../machine.js';

export interface RootStepRule {
  command: string;
  /** What it does, for the console. */
  what: string;
  /** The arguments it takes, for the console. */
  usage: string;
  /** Whether these exact arguments are on the helper's sudoers list. */
  allows: (args: string[]) => boolean;
  run: (args: string[], exec?: Exec) => MachineResult;
}

/**
 * The slot ceiling, read when asked: machine.ts's SLOTS_MAX, a constant now and a function once the ceiling is
 * read from the machine's config (#212). Either form works, so the bounds are never a copy.
 */
export function slotCeiling(): number {
  const max = SLOTS_MAX as unknown as number | (() => number);
  return typeof max === 'function' ? max() : max;
}

/** The helper's allowlist, as its sudoers rule spells it out: set-slots SLOTS_MIN..slotCeiling(), set-updates on|off. Nothing else. */
export const ROOT_STEPS: readonly RootStepRule[] = [
  {
    command: 'set-slots',
    what: "set the machine's agent slot cap",
    get usage() {
      return `set-slots <${SLOTS_MIN}..${slotCeiling()}>`;
    },
    // A plain whole number (no sign, leading zero or spaces: sudoers matches the argument as written), within the shared bounds.
    allows: (a) => a.length === 1 && /^[1-9][0-9]*$/.test(a[0]!) && Number(a[0]) >= SLOTS_MIN && Number(a[0]) <= slotCeiling(),
    run: (a, exec) => setSlotCap(Number(a[0]), exec),
  },
  {
    command: 'set-updates',
    what: 'turn automatic engine updates on or off',
    usage: 'set-updates on|off',
    allows: (a) => a.length === 1 && (a[0] === 'on' || a[0] === 'off'),
    run: (a, exec) => setUpdates(a[0] === 'on', exec),
  },
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

/**
 * Ask the coordinator to run an open, allowlisted root_step ask through the helper (src/machine-requests.ts):
 * the dashboard can't sudo, and never tries. Owner only. One off the allowlist is refused here, and again by
 * the coordinator. The coordinator answers the ask (ran or failed, with the output) once it has run.
 */
export function requestRootStep(log: EventLog, id: string, a: { by: string; role: Role | null }): { ask: Ask; request: MachineRequest } {
  const ask = asks(log).get(id);
  if (!ask) throw new AskError(`no ask ${id}`, 404);
  if (!mayAnswerAsk(ask, a.role)) throw new AskError(`only the owner may run a root step; @${a.by || 'unknown'} (${a.role ?? 'no role'}) may not`, 403);
  if (ask.kind !== 'root_step') throw new AskError(`ask ${id} isn't a root_step ask`);
  if (ask.status !== 'open') throw new AskError(`ask ${id} is already ${ask.status}`, 409);
  const c = checkRootStep(ask.command, ask.args);
  if (!c.allowed) throw new AskError(`not run: ${c.why}`, 403);
  try {
    return { ask, request: requestMachineChange(log, { args: [ask.command, ...ask.args], by: a.by, via: 'ask', ask: id }) };
  } catch (e) {
    if (e instanceof MachineRequestError) throw new AskError(e.message, e.status);
    throw e;
  }
}
