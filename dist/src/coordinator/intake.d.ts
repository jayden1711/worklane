import { QuickReplies } from './quick-replies.js';
export declare abstract class Intake extends QuickReplies {
    /**
     * Work intake (docs/intake.md), on the short timer: pull each enabled source (at most every `pullMs`), take each
     * new report through redaction, the caps, a read-only triage run and the policy (intake/decide.ts), then act on
     * the owner's answers and send status replies. Report text is data: nothing in it, and nothing the triage run
     * returns, can file `ready`, answer a decision or change config. One pass at a time; returns the pass in flight.
     */
    checkIntake(): Promise<void>;
    /**
     * At start-up, before any pass: end what a restart cut off, exactly once and without running any agent again.
     * A reply recorded as being sent but never as sent is marked unknown (not resent). A report taken but without an
     * outcome is filed if its issue exists (found by its marker), else dropped as interrupted, and its sender asked
     * once to send it again. Each writes an outcome, so a second restart finds nothing to do.
     */
    recoverIntake(): Promise<void>;
    private intakePass;
    /** One new report, from its raw text to its action. A report already stored is never taken again. */
    private intakeReport;
    /** The project's money paths, for marking a draft that names one high-risk; none when unset or unreadable. */
    private intakeMoneyPaths;
    private intakeAct;
    /**
     * A reply into the report's thread, sent at most once: the intent is recorded first, so a crash between sending
     * and recording is found at start-up and marked unknown, never sent again (a person's phone gets at most one).
     * Its text is the engine's own, never the agent's.
     */
    private intakeReply;
    /**
     * The reply's text: the casual replier's when casual replies are on and its reply passes every check in code,
     * else the engine's fixed `fixed`. Its inputs are the redacted message and the facts only; one run, no tools,
     * within intake's daily spend cap. Which text was used, and why, is recorded.
     */
    private casualReply;
    /** Open issues a report may repeat: those with the labels intake files under, and ready work. */
    private intakeOpenIssues;
    /** The last week's reports (redacted excerpts, from the log), with the issue each joined. */
    private intakeRecent;
    /** The issue each report was filed as or joined. */
    private intakeIssues;
    /**
     * Answers on intake decisions, each acted on once: approve files the draft `ready`, edit files it without `ready`
     * (to fix up first), reject drops it. A question's answer is only recorded. The owner or any of the project's
     * writers may answer (or the instance's own CLI, run on its machine); anyone else's answer is ignored. Who
     * answered is recorded on intake.decided.
     */
    private intakeDecisions;
    private intakeDrop;
    /** "Fixed" and "live" replies: once the report's issue merges, and once a verified deploy includes that merge. */
    private intakeStatus;
}
