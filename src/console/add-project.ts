// The setup console's "Add project": the dashboard's half. The root half is scripts/setup/add-project.sh, run by
// the machine helper's one add-project command.
//
//   GET  /api/add-project   whether this person may add a project now (and why not), the machine owners, and each
//                           add-project run: its machine request, its steps in order, and the asks it raised
//   POST /api/add-project   {name, repo}: recorded as the machine request `add-project <name> <owner/repo>`
//                           (src/machine-requests.ts) for the coordinator, which runs the helper. Never runs anything.
//
// Who may: the instance's owner who is one of the machine's owners, with a GitHub sign-in in the last 5 minutes and
// an allowed console device, as for the terminal (src/machine-owners.ts); the break-glass too. The name and the
// repo are checked here, again by the coordinator (the helper's allowlist), and again by the helper itself.
//
// Progress: add-project.sh prints one line per step, which the coordinator records as an `add_project.step`
// event: {request_id, name, repo, step, state, detail}. The view folds them, per request, into the nine steps in
// the script's order. The two GitHub clicks and the Claude token are setup-console asks (approve_link,
// paste_secret), shown with the run that raised them: the asks created while it ran. One run at a time, so an
// ask belongs to exactly one run.
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { MACHINE_OWNERS_FILE, machineChangeRefusal, machineOwners, type MachineRequester } from '../machine-owners.js';
import { MACHINE_EVENTS, machineRequests, requestMachineChange, type MachineRequest } from '../machine-requests.js';
import { INSTANCE_NAME, validRepo } from '../setup/app-manifest.js';
import { ASK_EVENTS, asksFrom, mayAnswerAsk, type Ask, type Role } from './asks.js';

/** add-project.sh's steps, in the order it runs them. */
export const ADD_PROJECT_STEPS = ['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'] as const;
export type AddProjectStepName = (typeof ADD_PROJECT_STEPS)[number];
export type AddProjectStepState = 'pending' | 'started' | 'done' | 'failed' | 'ask';
export const ADD_PROJECT_EVENTS = [...MACHINE_EVENTS, ...ASK_EVENTS, 'add_project.step'] as const;

export interface AddProjectStep {
  step: AddProjectStepName;
  state: AddProjectStepState;
  detail: string;
  at: string | null;
}

export interface AddProjectRun {
  /** The machine request's id. */
  id: string;
  name: string;
  repo: string;
  by: string;
  at: string;
  /** The machine request's status: pending (for the coordinator), running, done, failed, refused, interrupted. */
  status: MachineRequest['status'];
  /** The helper's output, or why it failed or was refused. */
  detail: string;
  /** Every step, in order; one with no line yet is pending. */
  steps: AddProjectStep[];
  /** The step to retry: the first that failed. */
  failedStep: AddProjectStepName | null;
  /** The asks this run raised (GitHub's approve links, the Claude token), with whether this person may answer each. */
  asks: (Ask & { canAnswer: boolean })[];
}

/** Why this name and repo can't be added; null when they can. The same rules as the helper's. */
export function addProjectRefusal(name: unknown, repo: unknown): string | null {
  if (typeof name !== 'string' || !INSTANCE_NAME.test(name)) return 'the name is lowercase letters, digits and dashes, starting with a letter, at most 21 characters';
  if (!validRepo(repo)) return 'the repo is owner/name, as on GitHub';
  return null;
}

const isRun = (r: MachineRequest) => r.args[0] === 'add-project' && r.args.length === 3;

/** Every add-project run in these events, oldest first, with its steps and asks as `role` sees them. */
export function addProjectRuns(events: readonly StoredEvent[], role: Role | null): AddProjectRun[] {
  const runs = machineRequests(events).filter(isRun);
  const allAsks = new Map(asksFrom(events).map((a) => [a.id, a]));
  // The asks raised while each run was open, in log order: from its request until it finished (or the next began).
  const raised = new Map<string, string[]>(runs.map((r) => [r.id, []]));
  let open: string | null = null;
  for (const e of events) {
    const p = e.payload as { id?: string; args?: string[] };
    if (e.type === 'machine.requested' && raised.has(p.id!)) open = p.id!;
    else if (e.type === 'machine.finished' && p.id === open) open = null;
    else if (e.type === 'ask.created' && open) {
      const a = allAsks.get(p.id!);
      if (a && (a.kind === 'approve_link' || a.kind === 'paste_secret')) raised.get(open)!.push(a.id);
    }
  }
  return runs.map((r) => {
    const steps = new Map<AddProjectStepName, AddProjectStep>(ADD_PROJECT_STEPS.map((s) => [s, { step: s, state: 'pending', detail: '', at: null }]));
    for (const e of events) {
      if (e.type !== 'add_project.step') continue;
      const p = e.payload as EventPayload<'add_project.step'>;
      if (p.request_id === r.id && steps.has(p.step)) steps.set(p.step, { step: p.step, state: p.state, detail: p.detail, at: e.ts });
    }
    const list = ADD_PROJECT_STEPS.map((s) => steps.get(s)!);
    const asks = raised.get(r.id)!.map((id) => allAsks.get(id)!).map((a) => ({ ...a, canAnswer: a.status === 'open' && mayAnswerAsk(a, role) }));
    return { id: r.id, name: r.args[1]!, repo: r.args[2]!, by: r.by, at: r.at, status: r.status, detail: r.detail, steps: list, failedStep: list.find((s) => s.state === 'failed')?.step ?? null, asks };
  });
}

/** Why this person may not add a project now; null when they may. */
export function addProjectGate(who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string; now?: number } = {}): string | null {
  if (who.role !== 'owner') return `only an owner of this instance who is one of the machine's owners may add a project; @${who.requester.login} is ${who.role ? `a ${who.role}` : 'not on it'}`;
  return machineChangeRefusal(who.requester, { file: o.ownersFile ?? MACHINE_OWNERS_FILE, ...(o.now !== undefined ? { now: o.now } : {}) });
}

/** The view: whether the form is enabled (and why not), the machine owners, and the runs, newest first. */
export function addProjectView(events: readonly StoredEvent[], who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string; now?: number } = {}) {
  const why = addProjectGate(who, o);
  const runs = addProjectRuns(events, who.role).reverse();
  const busy = runs.find((r) => r.status === 'pending' || r.status === 'running') ?? null;
  return {
    allowed: why === null && !busy,
    why: why ?? (busy ? `adding ${busy.name} is still running; one project at a time` : null),
    login: who.requester.login,
    machineOwners: machineOwners(o.ownersFile ?? MACHINE_OWNERS_FILE),
    runs,
  };
}

export class AddProjectError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
  }
}

/** Record `add-project <name> <repo>` for the coordinator, after the gate and the checks; one run at a time. */
export function requestAddProject(log: EventLog, body: { name?: unknown; repo?: unknown }, who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string; now?: number } = {}): MachineRequest {
  const why = addProjectGate(who, o);
  if (why) throw new AddProjectError(why, 403);
  const bad = addProjectRefusal(body.name, body.repo);
  if (bad) throw new AddProjectError(bad, 400);
  const busy = machineRequests(log.read(0, [...MACHINE_EVENTS])).find((r) => isRun(r) && (r.status === 'pending' || r.status === 'running'));
  if (busy) throw new AddProjectError(`adding ${busy.args[1]} is still running; one project at a time`, 409);
  return requestMachineChange(log, { args: ['add-project', body.name as string, body.repo as string], requester: who.requester, via: 'settings', ...(o.ownersFile ? { ownersFile: o.ownersFile } : {}), ...(o.now !== undefined ? { now: o.now } : {}) });
}
