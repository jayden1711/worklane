import type { IncomingReport, IntakeConfig } from '../intake/report.js';
import { ChannelChat } from './channel-chat.js';
/** `deploy <sha>`: the sha (7 to 40 hex), or null for anything else. */
export declare function parseDeployCommand(text: string): string | null;
/** A reply in an override's thread: confirm, cancel, or neither. */
export declare function parseDeployReply(text: string): 'confirm' | 'cancel' | null;
export declare abstract class DeployCommands extends ChannelChat {
    /** The override threads' targets start with this. */
    private static readonly TARGET;
    /** The gate is configured (on, or off and refusing). */
    private deployOn;
    /** tests.yaml has deploy_gate, switched off (no `enabled: true`). */
    private gateOff;
    /** Overrides first: `deploy <sha>` in a channel the bot reads, and replies in an override's thread. */
    protected channelInbound(cfg: IntakeConfig, reports: IncomingReport[]): Promise<{
        rest: IncomingReport[];
        ignored: IncomingReport[];
    }>;
    /** The override thread's ask, if it is still waiting: the latest record for it is `asked`. */
    private pendingOverride;
    private deployCommand;
    private deployReply;
    /**
     * Every pass: the gate's moves and holds (tests.yaml deploy_gate.notify: ops), and every post-deploy check that
     * didn't pass (always, while there is an ops channel), once each, in the ops channel.
     */
    protected channelOutbound(cfg: IntakeConfig): Promise<void>;
}
