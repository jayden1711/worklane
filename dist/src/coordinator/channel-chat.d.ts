import { type ChatTurn } from '../intake/chat.js';
import { type ChatPerson } from '../intake/people.js';
import type { IncomingReport, IntakeConfig, IntakeSource } from '../intake/report.js';
import { Conversation } from './conversation.js';
export declare abstract class ChannelChat extends Conversation {
    private chatOn;
    /** Chat-channel messages first: each one from a mapped admin or writer gets a reply; anything else is ignored. */
    protected channelInbound(cfg: IntakeConfig, reports: IncomingReport[]): Promise<{
        rest: IncomingReport[];
        ignored: IncomingReport[];
    }>;
    /**
     * Whether a chat-channel message gets a reply: its sender when it does (the message is stored, taken once);
     * `ignored` when chat is off, the channel isn't listed, or the sender is unmapped or a viewer (nothing stored);
     * null when it was taken before (the gateway delivered it again).
     */
    protected acceptChat(cfg: IntakeConfig, r: IncomingReport): Promise<ChatPerson | 'ignored' | null>;
    private historyFile;
    /** The channel's recent conversation (redacted, in the coordinator's private store). */
    protected chatHistory(channel: string): ChatTurn[];
    private keepTurn;
    /** The instance's state as the chat sees it: open issues, pull requests, open decisions, recent runs. Redacted. */
    protected chatState(): string;
    /** One reply: within the chat's cap and the daily budget, a channel-chat run, its reply checked, then posted. */
    protected chatReply(cfg: IntakeConfig, src: IntakeSource, r: IncomingReport, who: ChatPerson): Promise<undefined>;
}
