import type { RunHost } from './host.js';
/** The protocol this engine speaks: the helper's PROTOCOL must equal it (a test checks the script's). */
export declare const HELPER_PROTOCOL = 7;
/** The one reinstall that fixes an outdated helper: only the helper, from the installed engine, nothing else changed. */
export declare const helperFix: (instance: string) => string;
export interface HelperState {
    ok: boolean;
    /** The helper's version; null when it has none (too old) or couldn't be asked. */
    have: number | null;
    need: number;
    /** One line: what is wrong, and the fix; '' when ok. */
    detail: string;
    /** The tail of what the helper said on stderr when asked (never its stdout), for the check. */
    stderr: string;
}
/** Ask the host's helper its protocol version, and compare it with this engine's. Never throws. */
export declare function checkHelper(host: RunHost, instance: string): Promise<HelperState>;
