import type { GuardrailsConfig } from '../config/schema.js';
import type { EvalContext } from './engine.js';
/** Per-project state folder, keyed by the project's absolute path. */
export declare function projectStateDir(projectRoot: string): string;
export declare function loadFingerprintSets(projectRoot: string): Record<string, Set<string>>;
export interface RefreshResult {
    name: string;
    ok: boolean;
    count: number;
    error?: string;
}
/**
 * Run each set's read-only command, hash the value at `key`, and store only
 * the hashes. The secret itself is never written or printed.
 */
export declare function refreshFingerprints(projectRoot: string, cfg: GuardrailsConfig): RefreshResult[];
export declare function liveContext(projectRoot: string, env?: NodeJS.ProcessEnv): EvalContext;
