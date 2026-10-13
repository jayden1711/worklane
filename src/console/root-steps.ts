// Root steps: the only things the setup console runs as root, and only through the machine helper
// (/usr/local/libexec/<cli>-machine, src/machine.ts) with exactly the arguments its sudoers rule lists
// (scripts/setup/machine-helper.sh). Never arbitrary sudo. Anything else is refused here, before sudo is
// reached, with what it would take: extending the helper, a reviewed change to the helper and its setup script.
import type { EventLog } from '../events/log.js';
import { AskError, asks, mayAnswerAsk, type Ask, type Role } from './asks.js';
import { MachineRequestError, requestMachineChange, type MachineRequest } from '../machine-requests.js';
import type { MachineRequester } from '../machine-owners.js';
import { addProjectNameOk, addProjectRepoOk, claudeAccount, MACHINE_HELPER, setSlotCap, setTestSlotCap, setUpdates, SLOTS_MAX, SLOTS_MIN, TEST_SLOTS_MAX, TEST_SLOTS_MIN, type Exec, type MachineResult } from '../machine.js';

export interface RootStepRule {
  command: string;
  /** What it does, for the console. */
  what: string;
  /** The arguments it takes, for the console. */
  usage: string;
  /** Whether these exact arguments are on the helper's sudoers list. */
  allows: (args: string[]) => boolean;
  run: (args: string[], exec?: Exec) => MachineResult;
  /** Long-running, with progress: the coordinator streams it instead of calling run. */
  streams?: boolean;
}

/**
 * The slot ceiling, read when asked: machine.ts's SLOTS_MAX, a constant now and a function once the ceiling is
 * read from the machine's config (#212). Either form works, so the bounds are never a copy.
 */
export function slotCeiling(): number {
  const max = SLOTS_MAX as unknown as number | (() => number);
  return typeof max === 'function' ? max() : max;
}

/** The helper's allowlist, as its sudoers rule spells it out: set-slots SLOTS_MIN..slotCeiling(), set-updates on|off, set-test-slots 1..8, claude-account status|switch, add-project <name> <owner/repo>. Nothing else. */
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
  {
    command: 'set-test-slots',
    what: 'set how many test runs go at once on the machine',
    usage: `set-test-slots <${TEST_SLOTS_MIN}..${TEST_SLOTS_MAX}>`,
    allows: (a) => a.length === 1 && /^[1-9][0-9]*$/.test(a[0]!) && Number(a[0]) >= TEST_SLOTS_MIN && Number(a[0]) <= TEST_SLOTS_MAX,
    run: (a, exec) => setTestSlotCap(Number(a[0]), exec),
  },
  {
    command: 'claude-account',
    what: "the agents' Claude account: refresh each agent user's account and expiry (status), or switch every agent on the machine to another account (switch)",
    usage: 'claude-account status|switch',
    allows: (a) => a.length === 1 && (a[0] === 'status' || a[0] === 'switch'),
    run: (a, exec) => claudeAccount(a[0] as 'status' | 'switch', exec),
  },
  {
    command: 'add-project',
    what: 'add a project to this machine (the installed engine\'s scripts/setup/add-project.sh, as root)',
    usage: 'add-project <name> <owner/repo>',
    allows: (a) => a.length === 2 && addProjectNameOk(a[0]) && addProjectRepoOk(a[1]),
    // It runs for minutes and asks for things on the way: the coordinator streams it (src/coordinator/add-project.ts).
    streams: true,
    run: () => ({ ok: false, error: 'add-project streams its steps: the coordinator runs it with its own runner' }),
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
 * the dashboard can't sudo, and never tries. The instance's owner only, and a machine owner on
 * an allowed device (or the break-glass; src/machine-owners.ts). One off the allowlist is refused here, and again by
 * the coordinator. The coordinator answers the ask (ran or failed, with the output) once it has run.
 */
export function requestRootStep(log: EventLog, id: string, a: { by: string; role: Role | null; requester: MachineRequester; ownersFile?: string }): { ask: Ask; request: MachineRequest } {
  const ask = asks(log).get(id);
  if (!ask) throw new AskError(`no ask ${id}`, 404);
  if (!mayAnswerAsk(ask, a.role)) throw new AskError(`only the owner may run a root step; @${a.by || 'unknown'} (${a.role ?? 'no role'}) may not`, 403);
  if (ask.kind !== 'root_step') throw new AskError(`ask ${id} isn't a root_step ask`);
  if (ask.status !== 'open') throw new AskError(`ask ${id} is already ${ask.status}`, 409);
  const c = checkRootStep(ask.command, ask.args);
  if (!c.allowed) throw new AskError(`not run: ${c.why}`, 403);
  try {
    return { ask, request: requestMachineChange(log, { args: [ask.command, ...ask.args], requester: a.requester, via: 'ask', ask: id, ...(a.ownersFile ? { ownersFile: a.ownersFile } : {}) }) };
  } catch (e) {
    if (e instanceof MachineRequestError) throw new AskError(e.message, e.status);
    throw e;
  }
}
