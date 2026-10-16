import type { Role } from '../dashboard-auth.js';
import type { EventLog } from '../events/log.js';
import { Automation, AutomationsFile, type Trigger } from './schema.js';
export declare const ACTIONS: readonly ["create", "edit", "delete", "pause", "resume", "run", "rotate", "unbind"];
export type AutomationAction = (typeof ACTIONS)[number];
/** INVARIANT: the one rule for who may do what. Pause and run now are the writers' too; the rest (rotating a webhook's secret and unbinding its node included) the owners' only. */
export declare function mayDo(action: AutomationAction, role: Role | null | undefined): boolean;
export declare class AutomationsError extends Error {
}
export interface Loaded {
    file: AutomationsFile;
    /** The file's text as read ('' when absent): its digest pins a review to it. */
    text: string;
    error: string | null;
}
export declare const digestOf: (text: string) => string;
/** Read automations.yaml. Absent: none. Unsafe permissions or an invalid file: none run, and `error` says why. */
export declare function loadAutomations(path: string): Loaded;
/** What a person asks for: an action, the automation's id, and for create/edit the definition. */
export interface ChangeRequest {
    action: AutomationAction;
    id?: string;
    automation?: unknown;
}
export interface Plan {
    action: AutomationAction;
    id: string;
    /** Every changed field, as `- path: old` / `+ path: new` lines; a run now changes no field. */
    changes: string[];
    /** What it means, in plain words. */
    summary: string[];
    /** The file's digest this plan was made against. */
    digest: string;
    next: AutomationsFile;
}
/** The changed fields between two versions of one automation (null: it doesn't exist on that side). */
export declare function fieldDiff(before: Automation | null, after: Automation | null): string[];
/** A trigger in plain words. */
export declare function describeTrigger(t: Trigger): string;
/** What an automation does, in plain words (the Review's summary and the detail pane). */
export declare function describe(a: Automation): string[];
/**
 * The change a request makes to `loaded`, or why it is refused (AutomationsError). Nothing is written. `by`: the
 * person asking (a create's owner); their role is checked by the caller with mayDo.
 */
export declare function planChange(loaded: Loaded, req: ChangeRequest, by: string): Plan;
/**
 * Carry out a reviewed plan: planned again on the file as it is now, refused when its digest isn't `digest` (the file
 * changed since the review). A run now writes nothing to the file: it is recorded (automation.run_requested) for the
 * coordinator. Every change is recorded as automation.changed with who did it.
 */
export declare function applyChange(o: {
    path: string;
    req: ChangeRequest;
    digest: string;
    by: string;
    role: Role;
    log: EventLog;
    stateDir?: string;
}): Plan & {
    secret?: string;
};
/**
 * The engine pausing an automation (its breaker): enabled false in the file, recorded as automation.changed by
 * `system` with why. Never anything else: it can't resume, edit or add one.
 */
export declare function pauseBySystem(o: {
    path: string;
    id: string;
    why: string;
    by: string;
    log: EventLog;
}): boolean;
