import { type IncomingReport, type IntakeSource } from '../intake/report.js';
import { DeployCommands } from './deploy-commands.js';
import type { CoordinatorDeps } from './shared.js';
/** Replies running at once per instance (chat and thread questions together). Agent slots don't count them. */
export declare const QUICK_RUNS = 2;
/** Discord shows typing for about 10 s: it is sent again before then. */
export declare const TYPING_EVERY_MS = 8000;
/** The longest one channel's indicator is kept alive (a chat run's timeout). */
export declare const TYPING_MAX_MS: number;
/** After a failed typing send (a 429 among them): no indicator in that channel for this long. */
export declare const TYPING_PAUSE_MS = 60000;
export declare abstract class QuickReplies extends DeployCommands {
    private quickBusy;
    private quickAgain;
    private quickPass;
    /** Per channel or thread: the replies on their way, in order. */
    private quickLanes;
    private quickActive;
    private quickWaiting;
    private typingIn;
    /** A channel whose typing send failed: none is sent there again until then. */
    private typingPausedUntil;
    constructor(d: CoordinatorDeps);
    /**
     * Is this a reply a person is waiting on: a chat-channel message, or a reply in a decision's, ask's or owner merge's
     * thread (an L3 approval; a setup step's link)? Those are taken here only, never by the intake pass too.
     */
    private quick;
    /** What the intake pass takes from the chat source: everything else (with no quick path, everything). */
    protected intakeTake(src: IntakeSource): Promise<IncomingReport[]>;
    /** A pass over the waiting replies, now; coalesced: one at a time, and a wake during one makes one more. */
    wakeQuick(): Promise<void>;
    /** Every pass and every reply on its way, finished. */
    quickIdle(): Promise<void>;
    private quickTake;
    /** One accepted message's reply: typing from now until it is posted, in order in its channel, within QUICK_RUNS. */
    private quickReply;
    private quickSlot;
    private quickRelease;
    /**
     * Keep the typing indicator up in `where` until every reply that asked for it called its stop. One indicator per
     * channel; a failed send (a rate limit, any error) ends it, and none is started there for TYPING_PAUSE_MS after.
     */
    private typing;
}
