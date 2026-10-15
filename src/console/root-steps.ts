// Root steps: the only things the setup console runs as root, and only through the machine helper
// (/usr/local/libexec/<cli>-machine, src/machine.ts) with exactly the arguments its sudoers rule lists
// (scripts/setup/machine-helper.sh). Never arbitrary sudo. Anything else is refused here, before sudo is
// reached, with what it would take: extending the helper, a reviewed change to the helper and its setup script.
import type { EventLog } from '../events/log.js';
import { AskError, asks, mayAnswerAsk, type Ask, type Role } from './asks.js';
import { MachineRequestError, requestMachineChange, type MachineRequest } from '../machine-requests.js';
import type { MachineRequester } from '../machine-owners.js';
import { addProjectNameOk, addProjectRepoOk, claudeAccount, claudeProfile, followReleases, installUpdater, MACHINE_HELPER, setSlotCap, setTestSlotCap, setUpdates, signerKeyOk, signerPrincipalOk, SLOTS_MAX, SLOTS_MIN, stagedSigner, tailscaleStep, TEST_SLOTS_MAX, TEST_SLOTS_MIN, type Exec, type MachineResult } from '../machine.js';

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

/**
 * An account profile step (src/claude-profiles.ts), as the helper and its sudoers patterns take it: profile-add|remove
 * <profile> (never default), use <profile> [<instance>].
 */
export function profileStepOk(a: readonly string[]): boolean {
  const name = (s: string | undefined) => typeof s === 'string' && /^[a-z][a-z0-9-]{0,20}$/.test(s);
  // failover <order|off> back|stay [<instance>]: the setting only (src/claude-failover.ts).
  if (a[0] === 'failover') return (a.length === 3 || (a.length === 4 && addProjectNameOk(a[3]))) && (a[1] === 'off' || /^[a-z][a-z0-9-]{0,20}(\+[a-z][a-z0-9-]{0,20}){1,7}$/.test(a[1] ?? '')) && (a[2] === 'back' || a[2] === 'stay');
  if (!name(a[1])) return false;
  if ((a[0] === 'profile-add' || a[0] === 'remove') && a.length === 2) return a[1] !== 'default';
  return a[0] === 'use' && (a.length === 2 || (a.length === 3 && addProjectNameOk(a[2])));
}

/** The helper's allowlist, as its sudoers rule spells it out: set-slots SLOTS_MIN..slotCeiling(), set-updates on|off, set-test-slots 1..8, claude-account status|switch, tailscale install|up|serve|public-url, add-project <name> <owner/repo>, and the updater's setup: install-updater, set-update-channel release, stage-update-signer and discard-update-signer <principal> ssh-ed25519 <public key>. Nothing else: nothing here adds a release signer or follows main. */
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
    usage: 'claude-account status|switch | claude-account profile-add|remove <profile> | claude-account use <profile> [<instance>] | claude-account failover <order|off> back|stay [<instance>]',
    allows: (a) => (a.length === 1 && (a[0] === 'status' || a[0] === 'switch')) || profileStepOk(a),
    run: (a, exec) => (a.length === 1 ? claudeAccount(a[0] as 'status' | 'switch', exec) : claudeProfile(a, exec)),
  },
  {
    command: 'tailscale',
    what: "Tailscale for the dashboard hub: install it (the signed apt repository, pinned), log this machine in (no auth key; the login link goes to a machine owner only), forward https 443 to the hub's sign-in port, or set the hub's URL to this machine's tailnet name",
    usage: 'tailscale install|up|serve|public-url',
    // One fixed word and nothing after it: no auth key, flag, URL or port (the helper and its sudoers rule take exactly these four).
    allows: (a) => a.length === 1 && (a[0] === 'install' || a[0] === 'up' || a[0] === 'serve' || a[0] === 'public-url'),
    run: (a, exec) => tailscaleStep(a[0] as 'install' | 'up' | 'serve' | 'public-url', exec),
  },
  {
    command: 'install-updater',
    what: 'install the engine updater and its timer, with updates off (the installed engine\'s scripts/setup/updates.sh, as root)',
    usage: 'install-updater',
    allows: (a) => a.length === 0,
    run: (_a, exec) => installUpdater(exec),
  },
  {
    command: 'set-update-channel',
    what: 'put the engine updater on the release channel: signed release tags only',
    usage: 'set-update-channel release',
    allows: (a) => a.length === 1 && a[0] === 'release',
    run: (_a, exec) => followReleases(exec),
  },
  ...(['stage', 'discard'] as const).map(
    (action): RootStepRule => ({
      command: `${action}-update-signer`,
      what: action === 'stage' ? 'stage one release-signing public key for an admin to confirm at a root shell (staging adds nothing to the keys the updater trusts)' : 'take a staged release signer back out of the pending list',
      usage: `${action}-update-signer <principal> ssh-ed25519 <public key>`,
      allows: (a) => a.length === 3 && signerPrincipalOk(a[0]) && a[1] === 'ssh-ed25519' && signerKeyOk(a[2]),
      run: (a, exec) => stagedSigner(action, a[0]!, a[2]!, exec),
    }),
  ),
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
