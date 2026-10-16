import type { EventPayload } from '../events/types.js';
import { type ChannelPost } from '../intake/channel.js';
import { type ThreadRecord } from '../intake/explain.js';
import { type ChatPerson } from '../intake/people.js';
import { IntakeMeter } from '../intake/store.js';
import type { IncomingReport, IntakeConfig, IntakeSource } from '../intake/report.js';
import { ResearchOnDemand } from './research-on-demand.js';
/** What a thread is for: `decision:<id>`, `ask:<id>`, `merge:<number>@<head>` or `idea:<id>` (the key of the post that opened it). */
export type Target = string;
/** A decision's or ask's thread, as a reply in it is handled (Channel.threadTarget). */
/** What a high-risk approval (or rejection) from a thread did. */
type ApprovalResult = {
    ok: true;
} | {
    ok: false;
    already?: {
        answer: string;
        by: string;
    };
    error?: string;
};
/** What makes an issue risky, in words: its high-risk labels, and a money path among its review level's reasons. */
export declare function riskNotes(labels: string[], reasons: string[]): string[];
/** A plan's fields as plain lines (approach, steps, files, risks), for the record. */
export declare function planText(plan: Record<string, unknown>): string;
export declare abstract class Channel extends ResearchOnDemand {
    /**
     * The merge flow's (merge-flow.ts): an owner's approval, from a thread, of PR `number` waiting for an owner at
     * `head`, after the same checks a merge needs (the head unchanged, its required checks green, auto-merge not
     * stopped); recorded, and merged on the next pass through the normal merge path.
     */
    protected abstract chatApproveMerge(number: number, head: string, who: ChatPerson): Promise<ApprovalResult>;
    /** Why auto-merge is stopped on this instance (the main watch, a red main), or null (merge-flow.ts). */
    abstract autoMergeStopped(): string | null;
    /** The chat source, when it can open threads. */
    protected chatSource(): IntakeSource | null;
    /**
     * File a report's issue at most once: its body carries `<!-- intake:<id> -->`, and an open issue with that marker
     * (filed before a crash, its event never written) is reused instead of filing a second one.
     */
    protected intakeFileOnce(id: string, title: string, body: string, labels: string[]): Promise<number>;
    protected intakeLabelOnce(n: number, id: string, body: string, labels: string[]): Promise<number>;
    protected intakeLabelled(n: number, id: string): Promise<boolean>;
    /** The open issue filed for this report, if any, among issues with these labels. */
    protected intakeIssueFor(id: string, labels: string[]): Promise<number | null>;
    /** Is the channel on: Discord enabled, someone mapped. Off, the intake goes on as before. */
    protected channelOn(cfg: IntakeConfig): boolean;
    /** Each of the bot's threads and what it is for, from the posts recorded. */
    protected channelThreads(): Map<string, Target>;
    /** At start-up and each pass: the source takes replies in every thread of ours again (it forgets on restart). */
    protected channelRewatch(): void;
    /** Keys posted (or being posted) already: each is sent at most once. */
    protected postedKeys(): Set<string>;
    /** A post cut off by a restart (recorded as posting, never as posted) is marked unknown, never resent. */
    protected channelRecover(): void;
    /** Send one post, once per key. A thread post returns the thread's id (opened on the message `from` when given). */
    protected channelSend(src: IntakeSource, key: string, where: {
        channel: string;
        from?: string;
    } | {
        thread: string;
    }, post: ChannelPost): Promise<string | null>;
    /** Say something in a thread, once per key. */
    protected say(src: IntakeSource, thread: string, key: string, text: string): Promise<string | null>;
    /**
     * The chat source's messages, before intake triages them: replies in the bot's threads are handled here; with the
     * channel on, a message from anyone unmapped is ignored (nothing stored, counted only). Returns the messages
     * left for intake, and those dropped by rule (to acknowledge).
     */
    protected channelInbound(cfg: IntakeConfig, reports: IncomingReport[]): Promise<{
        rest: IncomingReport[];
        ignored: IncomingReport[];
    }>;
    /**
     * A message from the chat source, before it is handled: a reply in one of the bot's threads, taken (stored, once),
     * with who sent it and what the thread is for; `ignored` (unmapped, or a reply in a thread that isn't ours, or a
     * chat-channel one: nothing stored); `rest` for intake; null when it was taken before.
     */
    protected acceptThreadReply(cfg: IntakeConfig, r: IncomingReport, threads: Map<string, Target>, meter: () => IntakeMeter): Promise<{
        person: ChatPerson;
        target: Target;
    } | 'ignored' | 'rest' | null>;
    /**
     * What a thread is for, read from the log: its record (for the summary and questions), its options, whether it
     * is closed (answered, or withdrawn), who may answer it, and how an answer is recorded (the dashboard's own path).
     */
    /** A secret or root-step ask's thread. */
    private isSetupStep;
    /** Why nothing may be approved now, whatever it is: an emergency stop, or auto-merge stopped (the main watch). */
    private approvalHold;
    /** PRs the merge policy left to an owner, still open: the latest merge.decided per PR, when it wasn't auto. */
    protected waitingMerges(): {
        issue: number;
        number: number;
        head: string;
        reasons: string[];
        url: string;
    }[];
    private threadTarget;
    /**
     * A decision's record, from what the coordinator holds: the decision, its issue (title and text), the latest plan
     * posted on it, and the risk (the issue's review level, from review.level_set or its review:L label, and what
     * makes it risky: a money path, a high-risk label, a large change). Redacted.
     */
    protected decisionRecord(q: EventPayload<'decision.asked'>): Promise<ThreadRecord>;
    /** The pick waiting for its confirmation in a thread, if any: the latest one asked and not since confirmed or dropped. */
    private pendingConfirm;
    /** What is left today for an intake run: 0 over intake's spend cap (intake.max_usd_per_day), else the daily budget's rest. */
    protected intakeSpendLeft(cfg: IntakeConfig): number;
    /** A short no-tools run for a thread (its summary, or reading a message), counted against intake's spend cap. */
    private threadModelRun;
    /**
     * A mapped person's reply in a decision's or ask's thread. Exact option words answer it (as on the dashboard); a
     * plain-language pick is asked back ("Confirm: approve?") and recorded only on the same person's following yes; a
     * question is answered from the record and never answers anything.
     */
    protected threadReply(cfg: IntakeConfig, src: IntakeSource, r: IncomingReport, who: ChatPerson, thread: string, target: Target): Promise<unknown>;
    /**
     * A reply in a high-risk thread (an L3 landing decision, or a PR waiting for an owner). Only an owner listed in
     * discord.owners whose login is an admin now may answer it, and only by naming its number: "approve 12". Anyone
     * else's reply is a comment. No model reads these replies. Approved, the other owners are pinged in the thread.
     */
    private highRiskReply;
    /**
     * A reply in a setup step's thread (a secret or a root step). It never answers the step and nothing of it is kept:
     * from an owner listed in discord.owners, "link" gets them a one-time link to the step's paste box by DM (bound to
     * the step and their GitHub login; src/console/links.ts); anything else, or anyone else, gets the fixed reply.
     */
    private setupStepReply;
    /**
     * Each open decision's or ask's thread, once: a plain-language summary from the intake-summary role, posted only
     * when it passes the facts check (checkSummary); else the fixed template and the dashboard link. Within intake's
     * spend cap; over it, the template.
     */
    private explainThreads;
    /**
     * The weekly trust digest (src/trust.ts): once per week (Monday, UTC), a plain message in the ops channel, when one
     * is set, and the metrics digest after it (delivery figures, the slowest tests and those over the time budget).
     * Read-only measurement: it posts numbers and a recommendation, and changes nothing.
     */
    protected trustDigestOutbound(cfg: IntakeConfig): Promise<void>;
    /**
     * Post what waits on a person: each open decision and ask, once, in the asks channel (a thread each, or a notice
     * with a link); and in each thread, once, who decided it when it was decided elsewhere.
     */
    protected channelOutbound(cfg: IntakeConfig): Promise<void>;
}
export {};
