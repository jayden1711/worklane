// The setup console's "Add project": the dashboard's half. The root half is scripts/setup/add-project.sh, run by
// the machine helper's one add-project command.
//
//   GET  /api/add-project            whether this person may add a project now (and why not), the machine owners,
//                                    and each add-project run: its machine request, its steps in order, its asks
//   POST /api/machine/add-project    {name, repo}: the one way to start one (src/dashboard.ts, requestAddProject in
//                                    src/machine-requests.ts), which checks all of this again
//
// Who may: the instance's owner who is one of the machine's owners, signed in, on an allowed console device, as for
// the terminal (src/machine-owners.ts); the break-glass too. The name and the
// repo are checked in the page, by the dashboard, again by the coordinator (the helper's allowlist), and by the
// helper itself.
//
// Progress: add-project.sh prints one line per step, which the coordinator records as an `add_project.step`
// event (src/coordinator/add-project.ts). The view folds them, per request, into the nine steps in the script's
// order. The two GitHub clicks and the Claude token are setup-console asks (approve_link, paste_secret), shown with
// the run that raised them: the ask a step line names, and any other ask created while the run was open. One run at
// a time, so an ask belongs to exactly one run.
import type { EventPayload, StoredEvent } from '../events/types.js';
import { MACHINE_OWNERS_FILE, machineChangeRefusal, machineOwners, type MachineRequester } from '../machine-owners.js';
import { ADD_PROJECT_SCRIPT, HELPER_RULES, helperRules } from '../machine.js';
import { MACHINE_EVENTS, machineRequests, type MachineRequest } from '../machine-requests.js';
import { ADD_PROJECT_STEPS, type AddProjectStep as AddProjectStepName } from '../coordinator/add-project.js';
import { ASK_EVENTS, asksFrom, mayAnswerAsk, type Ask, type Role } from './asks.js';

export { ADD_PROJECT_STEPS };
export type AddProjectStepState = 'pending' | 'started' | 'done' | 'failed' | 'ask' | 'waiting';
export const ADD_PROJECT_EVENTS = [...MACHINE_EVENTS, ...ASK_EVENTS, 'add_project.step'] as const;

export interface AddProjectStep {
  step: AddProjectStepName;
  state: AddProjectStepState;
  detail: string;
  /** A failed line: how to try again. */
  retry: string | null;
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
    else if (e.type === 'add_project.step') {
      // The ask a step line names is that run's, whenever it was made.
      const s = e.payload as EventPayload<'add_project.step'>;
      const list = raised.get(s.request_id);
      if (s.ask && list && allAsks.has(s.ask) && !list.includes(s.ask)) list.push(s.ask);
    } else if (e.type === 'ask.created' && open) {
      const a = allAsks.get(p.id!);
      if (a && (a.kind === 'approve_link' || a.kind === 'paste_secret') && !raised.get(open)!.includes(a.id)) raised.get(open)!.push(a.id);
    }
  }
  return runs.map((r) => {
    const steps = new Map<AddProjectStepName, AddProjectStep>(ADD_PROJECT_STEPS.map((s) => [s, { step: s, state: 'pending', detail: '', retry: null, at: null }]));
    for (const e of events) {
      if (e.type !== 'add_project.step') continue;
      const p = e.payload as EventPayload<'add_project.step'>;
      if (p.request_id === r.id && steps.has(p.step)) steps.set(p.step, { step: p.step, state: p.state, detail: p.detail, retry: p.retry ?? null, at: e.ts });
    }
    const list = ADD_PROJECT_STEPS.map((s) => steps.get(s)!);
    const asks = raised.get(r.id)!.map((id) => allAsks.get(id)!).map((a) => ({ ...a, canAnswer: a.status === 'open' && mayAnswerAsk(a, role) }));
    return { id: r.id, name: r.args[1]!, repo: r.args[2]!, by: r.by, at: r.at, status: r.status, detail: r.detail, steps: list, failedStep: list.find((s) => s.state === 'failed')?.step ?? null, asks };
  });
}

/** Why this person may not add a project now; null when they may. */
export function addProjectGate(who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string } = {}): string | null {
  if (who.role !== 'owner') return `only an owner of this instance who is one of the machine's owners may add a project; @${who.requester.login} is ${who.role ? `a ${who.role}` : 'not on it'}`;
  return machineChangeRefusal(who.requester, { file: o.ownersFile ?? MACHINE_OWNERS_FILE });
}

/** The view: whether the form is enabled (and why not), the machine owners, and the runs, newest first. */
/**
 * When the machine helper can't run add-project here (this machine's sudo is older than 1.9.10, so machine-helper.sh
 * left the rule out and recorded it): why, and the root command to run instead. Null when it can.
 */
export function addProjectManual(o: { helperRulesFile?: string } = {}): { sudo: string | null; why: string; script: string } | null {
  const rules = helperRules(o.helperRulesFile ?? HELPER_RULES);
  if (!rules || !rules.leftOut.includes('add-project')) return null;
  return { sudo: rules.sudo, why: `this machine's sudo (${rules.sudo ?? 'its version unknown'}) is older than 1.9.10, so the machine helper's add-project rule isn't installed and the dashboard can't run it: run it at a root shell on the machine`, script: ADD_PROJECT_SCRIPT };
}

export function addProjectView(events: readonly StoredEvent[], who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string; helperRulesFile?: string } = {}) {
  const manual = addProjectManual(o);
  const why = manual ? manual.why : addProjectGate(who, o);
  const runs = addProjectRuns(events, who.role).reverse();
  const busy = runs.find((r) => r.status === 'pending' || r.status === 'running') ?? null;
  return {
    allowed: why === null && !busy,
    /** Not through the helper on this machine: the root command instead (the page fills in the name and repo). */
    manual,
    why: why ?? (busy ? `adding ${busy.name} is still running; one project at a time` : null),
    login: who.requester.login,
    machineOwners: machineOwners(o.ownersFile ?? MACHINE_OWNERS_FILE),
    runs,
  };
}
