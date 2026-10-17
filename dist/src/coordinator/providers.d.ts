import type { Config } from '../config/load.js';
import type { InstanceSettings } from '../instance.js';
import type { GuardrailsConfig } from '../config/schema.js';
import type { RunRequest } from '../runner.js';
import type { ReviewConfig } from '../config/schema.js';
import { type ChangeFile } from '../review.js';
export interface ProviderDeps {
    cfg: Config;
    settings: InstanceSettings;
    stateDir: string;
    providerKeys?: Record<string, string>;
    fetch?: typeof fetch;
    lockHeld?: (path: string) => boolean | null;
    /** When a provider (by label) hit its usage or rate limit: the ISO time it's skipped until, or null. */
    limited?: (label: string) => string | null;
}
/** The run as it will start: on its provider, or on its fallback, with why it fell back (null when it didn't). */
export declare function resolveProvider(req: RunRequest, d: ProviderDeps): Promise<{
    req: RunRequest;
    fellBack: {
        provider: string;
        reason: string;
    } | null;
}>;
/**
 * WHY: item 38. Its run had no claude sandbox or hooks, so its change is held to more than a hosted model's: L1 or
 * below and no protected path, besides everything hostedChangeRefusal refuses.
 */
export declare function cliChangeRefusal(o: {
    files: ChangeFile[];
    labels: string[];
    moneyPaths: () => RegExp[];
    review: ReviewConfig;
    guardrails: Pick<GuardrailsConfig, 'protected_paths'>;
}): string | null;
/**
 * Why a change a hosted open model built may not stand (or null): it is L3, touches a money path, or changes agent
 * instructions (a skill, AGENTS.md, a role prompt). Hosted models never do that work; the task redoes it on Anthropic.
 */
export declare function hostedChangeRefusal(o: {
    files: ChangeFile[];
    labels: string[];
    moneyPaths: () => RegExp[];
    review: ReviewConfig;
}): string | null;
/** WHY: item 38. One place the build loop asks, so a cli: build can't skip its stricter check. */
export declare function builtChangeRefusal(provider: string | undefined, o: Parameters<typeof cliChangeRefusal>[0]): string | null;
