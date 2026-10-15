import type { StoredEvent } from '../events/types.js';
import { type MachineRequester } from '../machine-owners.js';
import { type MachineRequest } from '../machine-requests.js';
import { ADD_PROJECT_STEPS, type AddProjectStep as AddProjectStepName } from '../coordinator/add-project.js';
import { type Ask, type Role } from './asks.js';
export { ADD_PROJECT_STEPS };
export type AddProjectStepState = 'pending' | 'started' | 'done' | 'failed' | 'ask' | 'waiting';
export declare const ADD_PROJECT_EVENTS: readonly ["machine.requested", "machine.started", "machine.finished", "ask.created", "ask.answered", "ask.cancelled", "add_project.step"];
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
    asks: (Ask & {
        canAnswer: boolean;
    })[];
}
/** Every add-project run in these events, oldest first, with its steps and asks as `role` sees them. */
export declare function addProjectRuns(events: readonly StoredEvent[], role: Role | null): AddProjectRun[];
/** Why this person may not add a project now; null when they may. */
export declare function addProjectGate(who: {
    role: Role | null;
    requester: MachineRequester;
}, o?: {
    ownersFile?: string;
}): string | null;
/** The view: whether the form is enabled (and why not), the machine owners, and the runs, newest first. */
/**
 * When the machine helper can't run add-project here (this machine's sudo is older than 1.9.10, so machine-helper.sh
 * left the rule out and recorded it): why, and the root command to run instead. Null when it can.
 */
export declare function addProjectManual(o?: {
    helperRulesFile?: string;
}): {
    sudo: string | null;
    why: string;
    script: string;
} | null;
export declare function addProjectView(events: readonly StoredEvent[], who: {
    role: Role | null;
    requester: MachineRequester;
}, o?: {
    ownersFile?: string;
    helperRulesFile?: string;
}): {
    allowed: boolean;
    /** Not through the helper on this machine: the root command instead (the page fills in the name and repo). */
    manual: {
        sudo: string | null;
        why: string;
        script: string;
    } | null;
    why: string | null;
    login: string;
    machineOwners: string[];
    runs: AddProjectRun[];
};
