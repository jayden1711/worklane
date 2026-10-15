import type { EventPayload } from '../events/types.js';
import type { IncomingReport, IntakeConfig } from '../intake/report.js';
import { Channel } from './channel.js';
type Idea = {
    id: string;
    thread: string | null;
    poster: string;
    stage: EventPayload<'discord.idea'>['stage'];
    issue: number | null;
    turns: number;
};
export declare abstract class Conversation extends Channel {
    private conversationOn;
    /** Every idea, from its events: its thread, who posted it, where it stands. */
    protected ideas(): Map<string, Idea>;
    private draftFile;
    /** Ideas take the chat channel's messages first: new ideas, and replies in their threads. */
    protected channelInbound(cfg: IntakeConfig, reports: IncomingReport[]): Promise<{
        rest: IncomingReport[];
        ignored: IncomingReport[];
    }>;
    private ideaOpen;
    private ideaReply;
    /** The conversation so far, redacted, for the agent: what people said, and what the bot asked or drafted. */
    private transcript;
    /** The decisions made so far (each question and its answer), redacted: what the agent must not ask again. */
    private decisionsMade;
    /** One turn: the intake agent reads the conversation and asks back (one message), or drafts; never files. */
    private ideaTurn;
    /** File the shown draft `ready`, once (its marker), after an explicit yes from someone mayFileReady allows. */
    private ideaFile;
    /** Decisions and asks as before, then each filed idea's progress, once per stage: planned, PR opened, merged, live. */
    protected channelOutbound(cfg: IntakeConfig): Promise<void>;
    /** Does a deploy of `deploy` include the commit `sha` (it, or a later commit on top of it)? */
    private includes;
}
export {};
