import type { AgentsConfig, ReviewConfig } from './config/schema.js';
import type { StoredEvent } from './events/types.js';
import type { Level } from './review.js';
import { type Scorecard } from './scorecard.js';
export declare function effectiveStage(events: StoredEvent[], configured: number): number;
/** Category -> level for everything the stages up to `stage` relax (later stages win). */
export declare function relaxedFor(stage: number, review: ReviewConfig | undefined): Record<string, Level>;
export interface Health {
    healthy: boolean;
    why: string[];
    card: Scorecard;
}
export declare function health(events: StoredEvent[], trust: AgentsConfig['trust'], now?: Date, revertedShas?: Set<string>): Health;
/** A regression is a breach of a quality threshold; too few tasks is not a regression. */
export declare function regressed(h: Health): boolean;
/** Consecutive healthy daily evaluations, most recent first. */
export declare function healthyStreak(events: StoredEvent[]): number;
