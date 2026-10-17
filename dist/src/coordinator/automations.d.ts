import type { Actionability, Issue } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import type { IncomingReport, IntakeConfig } from '../intake/report.js';
import { type Origin } from '../automations/engine.js';
import { type Automation, type AutomationLimits } from '../automations/schema.js';
import { HarnessEvals } from './harness-evals.js';
/** The label on every issue an automation files or posts its reports on. */
export declare const AUTOMATION_LABEL: {
    readonly name: "worklane:automation";
    readonly color: "c5def5";
    readonly description: "Filed by an automation (its definition is in the instance, not the repo)";
};
/** This many failed runs in a row pause an automation. */
export declare const BREAKER_FAILURES = 3;
/** `run <command>` (with anything after it, the trigger's text). */
export declare function parseRunCommand(text: string): {
    command: string;
    rest: string;
} | null;
type TriggerRef = EventPayload<'automation.fired'>['trigger'];
/** The report run's instructions: fixed here, before any trigger text is read. */
export declare const REPORT_PROMPT: string;
export declare abstract class AutomationRuns extends HarnessEvals {
    /** Report runs going now, by automation id. */
    private autoReports;
    private autoPoller;
    protected automationLimits(): AutomationLimits;
    private automationList;
    private autoNow;
    /** The automation that filed issue `n`, with the run, or null. */
    private automationOfIssue;
    /** An automation's task: actionable when this instance's log records filing it (the tracker's author is the App). */
    protected automationTask(issue: Issue): Actionability | null;
    /**
     * What a build of issue `n` may still spend, when an automation filed it: the least its budgets have left
     * (runBudget). null: not an automation's issue. `why` says which budget stopped it, at under $0.10.
     */
    protected automationLeft(n: number): {
        usd: number;
        why: string;
    } | null;
    /** Automation runs going now: reports running, and filed tasks not finished. Of `id` only, when given. */
    private automationActive;
    /** Each pass: dashboard run requests, due schedule slots, and GitHub events. Nothing while held or off. */
    checkAutomations(): Promise<void>;
    /**
     * Fires waiting for approval: an owner's approve fires it (every cap and the owner checked again now), a reject or a
     * day without an answer ends it. Each is resolved once.
     */
    private resolveApprovals;
    private githubMatches;
    private githubFire;
    private autoRole;
    /**
     * Fire `a`, or record why not. `text`: the trigger's text (untrusted), `target`: the issue or PR it was about (a
     * report's answer goes there). Returns whether it fired.
     */
    protected fireAutomation(a: Automation, trigger: TriggerRef, origin: Origin, text: string | null, target: number | null, limits?: AutomationLimits, o?: {
        approved?: boolean;
    }): Promise<'fired' | 'pending' | 'refused'>;
    private placeholders;
    private fileAutomationTask;
    private reportRun;
    /** A failed run: recorded; the BREAKER_FAILURES-th in a row pauses the automation (by the engine, in its file). */
    private automationFailed;
    private automationLogIssue;
    /** `run <command>` to the bot, in a channel it reads: a writer or owner (allowed and mapped) starts the automation with that command. */
    protected channelInbound(cfg: IntakeConfig, reports: IncomingReport[]): Promise<{
        rest: IncomingReport[];
        ignored: IncomingReport[];
    }>;
}
export {};
