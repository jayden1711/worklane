// Machine changes asked for from the dashboard, run by the coordinator.
//
// The dashboard runs hardened (its unit sets NoNewPrivileges), so it can't use sudo, and it doesn't try: a
// machine change from Settings, or a setup-console root step, is recorded here as a `machine.requested` event in
// the instance's log, after the dashboard's own checks (the owner's role, CSRF, the audit) and the helper's
// allowlist. The coordinator, whose unit allows sudo, takes each request on its next tick
// (src/coordinator/machine-requests.ts), checks it again against the same allowlist (so a request written
// some other way can't widen what runs), runs the machine helper, and records `machine.finished`. The
// dashboard shows each request as pending, running, then done or failed.
//
// Which coordinator acts: the one whose log holds the request, that is, the instance whose dashboard the
// owner used. Every coordinator user is in the helper's sudoers (machine-helper.sh lists them all), and the
// settings are machine-wide, so any one will do. A request lives in one log only, so no other coordinator sees
// it, and within that log `machine.started` is claimed in a write transaction, so it runs at most once.
import { randomBytes } from 'node:crypto';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { checkRootStep } from './console/root-steps.js';
import { MACHINE_OWNERS_FILE, machineChangeRefusal, type MachineRequester } from './machine-owners.js';
import { addProjectNameOk, addProjectRepoOk } from './machine.js';
import { instanceNameProblem } from './instance-name.js';

export const MACHINE_EVENTS = ['machine.requested', 'machine.started', 'machine.finished'] as const;

export type MachineRequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'refused' | 'interrupted';

export interface MachineRequest {
  id: string;
  /** The helper's arguments: set-slots <n>, set-updates on|off, set-test-slots <n>, add-project <name> <owner/repo>, claude-account status|switch, tailscale install|up|serve|public-url. */
  args: string[];
  by: string;
  via: 'settings' | 'ask' | 'add-project' | 'claude-account' | 'tailscale' | 'plugins';
  ask: string | null;
  /** Asked for on the owner's break-glass (no person named), which needs no machine owner. */
  breakGlass: boolean;
  at: string;
  status: MachineRequestStatus;
  /** The helper's output, or why it failed or was refused. */
  detail: string;
  finishedAt: string | null;
}

export class MachineRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(message);
  }
}

/** The helper arguments a Settings change maps to, or why it can't be one. */
export function settingArgs(what: unknown, value: unknown): string[] | { error: string } {
  if (what === 'slots') return ['set-slots', String(value)];
  if (what === 'testSlots') return ['set-test-slots', String(value)];
  if (what === 'updates') return typeof value === 'boolean' ? ['set-updates', value ? 'on' : 'off'] : { error: 'updates is on (true) or off (false)' };
  return { error: 'what is slots, testSlots or updates' };
}

/** Why these helper arguments may not run (not on the allowlist); null when they may. */
export function machineRefusal(args: readonly string[]): string | null {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) return 'not a machine helper command';
  const c = checkRootStep(args[0]!, args.slice(1));
  return c.allowed ? null : c.why;
}

/** The requests in these events, oldest first, each with its status. */
export function machineRequests(events: readonly StoredEvent[]): MachineRequest[] {
  const byId = new Map<string, MachineRequest>();
  for (const e of events) {
    if (e.type === 'machine.requested') {
      const p = e.payload as EventPayload<'machine.requested'>;
      if (!byId.has(p.id)) byId.set(p.id, { id: p.id, args: p.args, by: p.by, via: p.via, ask: p.ask, breakGlass: p.breakGlass === true, at: e.ts, status: 'pending', detail: '', finishedAt: null });
    } else if (e.type === 'machine.started') {
      const r = byId.get((e.payload as EventPayload<'machine.started'>).id);
      if (r && r.status === 'pending') r.status = 'running';
    } else if (e.type === 'machine.finished') {
      const p = e.payload as EventPayload<'machine.finished'>;
      const r = byId.get(p.id);
      if (r && (r.status === 'pending' || r.status === 'running')) {
        r.status = p.outcome;
        r.detail = p.detail;
        r.finishedAt = e.ts;
      }
    }
  }
  return [...byId.values()];
}

const open = (r: MachineRequest) => r.status === 'pending' || r.status === 'running';

/**
 * Record a machine change for the coordinator to run. The caller has checked the instance role (its owner); this
 * checks the requester is a machine owner on an allowed device, or the break-glass
 * (src/machine-owners.ts), the helper's allowlist, and that a root-step ask doesn't already have one pending.
 * Never runs anything.
 */
export function requestMachineChange(log: EventLog, r: { args: string[]; requester: MachineRequester; via: MachineRequest['via']; ask?: string | null; ownersFile?: string }): MachineRequest {
  const who = machineChangeRefusal(r.requester, { file: r.ownersFile ?? MACHINE_OWNERS_FILE });
  if (who) throw new MachineRequestError(who, 403);
  const why = machineRefusal(r.args);
  if (why) throw new MachineRequestError(why, 400);
  const by = r.requester.login;
  const id = `mr-${randomBytes(6).toString('hex')}`;
  log.db.exec('BEGIN IMMEDIATE');
  try {
    if (r.ask && machineRequests(log.read(0, [...MACHINE_EVENTS])).some((x) => x.ask === r.ask && open(x))) throw new MachineRequestError(`ask ${r.ask} already has a machine change waiting for the coordinator`, 409);
    log.append('machine.requested', { id, args: [...r.args], by, via: r.via, ask: r.ask ?? null, ...(r.requester.breakGlass ? { breakGlass: true } : {}) }, by, 'human');
    log.db.exec('COMMIT');
  } catch (e) {
    log.db.exec('ROLLBACK');
    throw e;
  }
  return machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.id === id)!;
}

/**
 * Record an add-project (the helper's `add-project <name> <owner/repo>`) for the coordinator to run: the same gate as
 * any machine change (requestMachineChange), with the name and the repo checked as strictly as the helper checks
 * them, and one at a time per instance's log.
 */
export function requestAddProject(log: EventLog, r: { name: unknown; repo: unknown; requester: MachineRequester; ownersFile?: string }): MachineRequest {
  const who = machineChangeRefusal(r.requester, { file: r.ownersFile ?? MACHINE_OWNERS_FILE });
  if (who) throw new MachineRequestError(who, 403);
  if (!addProjectNameOk(r.name)) throw new MachineRequestError(`the project's name: ${instanceNameProblem(r.name)}`);
  if (!addProjectRepoOk(r.repo)) throw new MachineRequestError('the repo: a GitHub owner/name');
  const open = machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.args[0] === 'add-project' && (x.status === 'pending' || x.status === 'running'));
  if (open) throw new MachineRequestError(`an add-project (${open.args[1]}) is already ${open.status}; wait for it to finish`, 409);
  return requestMachineChange(log, { args: ['add-project', r.name, r.repo], requester: r.requester, via: 'add-project', ...(r.ownersFile ? { ownersFile: r.ownersFile } : {}) });
}

/**
 * Record a plugin or MCP step (src/plugins/steps.ts) for the coordinator to run. Q13: the instance's owner may ask for
 * one (the caller checked the role and CSRF): unlike a machine-wide change, no machine owner or console device is
 * needed, because each step is for this instance alone (the helper takes it from sudo) and none approves anything (a
 * root admin confirms at a root shell). The helper's allowlist is checked here, and again by the coordinator.
 */
export function requestPluginStep(log: EventLog, r: { args: string[]; by: string; breakGlass: boolean }): MachineRequest {
  const why = machineRefusal(r.args);
  if (why) throw new MachineRequestError(why, 400);
  const id = `mr-${randomBytes(6).toString('hex')}`;
  log.append('machine.requested', { id, args: [...r.args], by: r.by, via: 'plugins', ask: null, ...(r.breakGlass ? { breakGlass: true } : {}) }, r.by, 'human');
  return machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.id === id)!;
}
