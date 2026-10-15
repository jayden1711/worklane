import { Delegation } from './delegation.js';
export declare abstract class Gardener extends Delegation {
    /** The gardener run in flight. */
    protected gardenerRun: Promise<void>;
    private gardenerBusy;
    /** Start the gardener when it is due (one run at a time). */
    checkGardener(): Promise<void>;
    /** A path the gardener never fixes: anything the merge policy treats as high-risk, or a safety floor. */
    protected protectedPath(): (path: string) => boolean;
    private garden;
    private gardenerLogIssue;
    /** The instance's one log issue: the one recorded, or found by its marker, or opened now. */
    private ensureGardenerLog;
}
