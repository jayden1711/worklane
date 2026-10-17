import { MACHINE_OWNERS_FILE, machineChangeRefusal, machineOwners } from '../machine-owners.js';
import { ADD_PROJECT_SCRIPT, HELPER_RULES, helperRules } from '../machine.js';
import { MACHINE_EVENTS, machineRequests } from '../machine-requests.js';
import { ADD_PROJECT_STEPS } from '../coordinator/add-project.js';
import { ASK_EVENTS, asksFrom, mayAnswerAsk } from './asks.js';
export { ADD_PROJECT_STEPS };
export const ADD_PROJECT_EVENTS = [...MACHINE_EVENTS, ...ASK_EVENTS, 'add_project.step'];
const isRun = (r) => r.args[0] === 'add-project' && r.args.length === 3;
/** Every add-project run in these events, oldest first, with its steps and asks as `role` sees them. */
export function addProjectRuns(events, role) {
    const runs = machineRequests(events).filter(isRun);
    const allAsks = new Map(asksFrom(events).map((a) => [a.id, a]));
    // The asks raised while each run was open, in log order: from its request until it finished (or the next began).
    const raised = new Map(runs.map((r) => [r.id, []]));
    let open = null;
    for (const e of events) {
        const p = e.payload;
        if (e.type === 'machine.requested' && raised.has(p.id))
            open = p.id;
        else if (e.type === 'machine.finished' && p.id === open)
            open = null;
        else if (e.type === 'add_project.step') {
            // The ask a step line names is that run's, whenever it was made.
            const s = e.payload;
            const list = raised.get(s.request_id);
            if (s.ask && list && allAsks.has(s.ask) && !list.includes(s.ask))
                list.push(s.ask);
        }
        else if (e.type === 'ask.created' && open) {
            const a = allAsks.get(p.id);
            if (a && (a.kind === 'approve_link' || a.kind === 'paste_secret') && !raised.get(open).includes(a.id))
                raised.get(open).push(a.id);
        }
    }
    return runs.map((r) => {
        const steps = new Map(ADD_PROJECT_STEPS.map((s) => [s, { step: s, state: 'pending', detail: '', retry: null, at: null }]));
        for (const e of events) {
            if (e.type !== 'add_project.step')
                continue;
            const p = e.payload;
            if (p.request_id === r.id && steps.has(p.step))
                steps.set(p.step, { step: p.step, state: p.state, detail: p.detail, retry: p.retry ?? null, at: e.ts });
        }
        const list = ADD_PROJECT_STEPS.map((s) => steps.get(s));
        const asks = raised.get(r.id).map((id) => allAsks.get(id)).map((a) => ({ ...a, canAnswer: a.status === 'open' && mayAnswerAsk(a, role) }));
        return { id: r.id, name: r.args[1], repo: r.args[2], by: r.by, at: r.at, status: r.status, detail: r.detail, steps: list, failedStep: list.find((s) => s.state === 'failed')?.step ?? null, asks };
    });
}
/** Why this person may not add a project now; null when they may. */
export function addProjectGate(who, o = {}) {
    if (who.role !== 'owner')
        return `only an owner of this instance who is one of the machine's owners may add a project; @${who.requester.login} is ${who.role ? `a ${who.role}` : 'not on it'}`;
    return machineChangeRefusal(who.requester, { file: o.ownersFile ?? MACHINE_OWNERS_FILE });
}
/** The view: whether the form is enabled (and why not), the machine owners, and the runs, newest first. */
/**
 * When the machine helper can't run add-project here (this machine's sudo is older than 1.9.10, so machine-helper.sh
 * left the rule out and recorded it): why, and the root command to run instead. Null when it can.
 */
export function addProjectManual(o = {}) {
    const rules = helperRules(o.helperRulesFile ?? HELPER_RULES);
    if (!rules || !rules.leftOut.includes('add-project'))
        return null;
    return { sudo: rules.sudo, why: `this machine's sudo (${rules.sudo ?? 'its version unknown'}) is older than 1.9.10, so the machine helper's add-project rule isn't installed and the dashboard can't run it: run it at a root shell on the machine`, script: ADD_PROJECT_SCRIPT };
}
export function addProjectView(events, who, o = {}) {
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
//# sourceMappingURL=add-project.js.map