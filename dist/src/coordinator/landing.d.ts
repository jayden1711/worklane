import type { EventPayload } from '../events/types.js';
import { Decisions } from './decisions.js';
export declare abstract class Landing extends Decisions {
    /** Queued changes without a final landing result, oldest first. "deferred" isn't final. */
    private landQueue;
    private filesOf;
    /** Seed with the oldest; add later changes whose files don't overlap, at most one L3, up to batch_max. */
    buildBatch(queue: EventPayload<'land.queued'>[]): EventPayload<'land.queued'>[];
    private directRefused;
    private remoteIsLocal;
    /**
     * Why a direct land may not push the default branch now, or null: GitHub must enforce its protection, asked now
     * (src/direct-land.ts). A refusal is recorded once until the answer changes (coordinator.error: health and the
     * dashboard show it); the queue waits, and lands once protection is back.
     */
    private directLandBlocked;
    protected landNext(): Promise<void>;
    private gateTiers;
    private tierCommand;
    /** Run the land gates: baseline-aware, a failure retried once (flake), exclusive tiers under the machine-wide lock. */
    private runGates;
    /**
     * Land a batch on the tip in one tested commit. On a red gate: retry once
     * (flake), then split in half and land each half on its own (bors-style
     * bisection); a single change that's still red is ejected with the evidence.
     */
    private landBatch;
    /**
     * land_mode pr: push the task's own branch and open a pull request for a
     * human to merge. The coordinator never merges and never pushes the
     * default branch; the PR closes the issue when it's merged.
     */
    private proposePr;
    private afterLand;
    /**
     * Trigger a deploy, then confirm the environment serves the exact sha. A skipped deploy is a failure. `issue`:
     * the issue whose landing triggered it, recorded on each deploy event (so deploy.verified ends that task).
     */
    deploy(env: string, trigger: string, verify: string, sha: string, issue?: number, polls?: number, pollMs?: number): Promise<boolean>;
}
