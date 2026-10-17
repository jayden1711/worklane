import type { StoredEvent } from '../events/types.js';
import type { Incident } from '../watchdog/incidents.js';
import type { UpdateEntry } from '../updates.js';
export interface DigestItem {
    key: string;
    line: string;
}
/** Where the last pass stopped: the newest event read, its time, the incidents open then, the health suggestions then (null: none read yet). */
export interface Cursor {
    since: string;
    eventId: number;
    open: string[] | null;
    health: string[] | null;
}
/** A service log as the dashboard's reader returns it (src/dashboard.ts readServiceLog), read as the coordinator's own user. */
export interface JournalRead {
    entries: {
        at: string | null;
        priority: number | null;
        message: string;
    }[];
    problem: string | null;
}
export interface DigestSources {
    /** The instance's whole event log (test runs are folded from it); events after the cursor become items. */
    events?: StoredEvent[];
    /** The incidents this superfan watches (the instance's, or the machine's). */
    incidents?: Incident[];
    /** The health view's suggestions (src/health.ts), the test runs' problems among them. */
    health?: string[];
    journal?: JournalRead | null;
    /** The updater's log (the machine's superfan). */
    updates?: UpdateEntry[];
}
/** The most items one digest carries (the newest kept); the most characters one line does. */
export declare const MAX_ITEMS = 120;
/** Event kinds worth a look: something failed, stopped, was refused or held, or changed course. Everything else is routine. */
export declare const NOTABLE_EVENTS: Set<string>;
/**
 * The items since `cursor`, and the cursor to keep after a pass that judged them. `redact` is applied to every line
 * (the caller's redaction: secret shapes, the project's names and patterns). Notes: what couldn't be read (the
 * journal), for the pass's record only, never the digest.
 */
export declare function buildDigest(src: DigestSources, cursor: Cursor, now: Date, redact: (s: string) => string): {
    items: DigestItem[];
    cursor: Cursor;
    notes: string[];
};
