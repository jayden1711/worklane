import type { StoredEvent } from '../events/types.js';
import { type Automation, type AutomationLimits } from './schema.js';
/** Fires of `id` (every automation's when null) on the local day `day`. */
export declare function runsOn(events: StoredEvent[], day: string, id?: string | null): number;
/**
 * USD spent on the local day `day` by `id` (every automation's when null): its report runs' costs (automation.done)
 * and every run.cost booked to an issue one of its runs filed (a task's builds, reviews and fixes).
 */
export declare function spentOn(events: StoredEvent[], day: string, id?: string | null): number;
/** When `id` last fired (ms), or null. */
export declare function lastFiredAt(events: StoredEvent[], id: string): number | null;
/** Whether a schedule's slot already fired (its key is the fire's ref). */
export declare function slotFired(events: StoredEvent[], id: string, key: string): boolean;
/**
 * Where a GitHub object (an issue, a PR, a comment on one) came from, as far as automations go:
 *   - `person`: not an automation's output (depth 0);
 *   - `chained`: an automation run's output: the issue it filed, the PR that issue's build opened, or a comment it
 *     posted on `number` (within 10 minutes before `at`): its source, and the depth and ancestors a fire from it has;
 *   - `harness`: a bot's (the harness's own or any other), not traced to an automation: never starts one.
 */
export type Origin = {
    kind: 'person';
} | {
    kind: 'chained';
    source: string;
    depth: number;
    ancestors: string[];
} | {
    kind: 'harness';
};
export declare function originOf(events: StoredEvent[], o: {
    number: number;
    byBot: boolean;
    comment?: boolean;
    at?: string;
}): Origin;
/**
 * INVARIANT: why a chained fire of `target` is refused, or null. In this order: never itself, never a cycle (an
 * automation already in the chain), only from an automation it names in chain.accept_from, and never deeper than
 * MAX_CHAIN_DEPTH. Output not traced to an automation never starts one.
 */
export declare function chainRefusal(target: Pick<Automation, 'id' | 'chain'>, origin: Origin): string | null;
/**
 * Why `a` may not fire now, or null: off, paused, its caps (runs a day, cooldown, its day's budget), the caps over
 * every automation (runs a day, at once, their share of the daily budget), and the instance's daily budget. `active`:
 * automation runs going now (reports running, filed tasks not finished), `activeOfThis`: this one's.
 */
export declare function capRefusal(o: {
    a: Automation;
    limits: AutomationLimits;
    events: StoredEvent[];
    now: Date;
    active: number;
    activeOfThis: number;
    instanceLeftUsd: number;
}): string | null;
/** INVARIANT: the most one run of `a` may spend: its per-run cap and every day's budget it counts against, whichever is least. */
export declare function runBudget(o: {
    a: Automation;
    limits: AutomationLimits;
    events: StoredEvent[];
    now: Date;
    instanceLeftUsd: number;
}): number;
/** A trigger's text as a run may see it: redacted (secrets, then personal data), on one budget of characters, and fenced as data. */
export declare function triggerText(source: string, text: string): string;
