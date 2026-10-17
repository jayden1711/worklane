import type { IncomingMessage } from 'node:http';
import type { EventLog } from '../events/log.js';
import { type Ask, type Role } from './asks.js';
export declare const MAX_SECRET = 16384;
/** Where an instance's pasted credentials go: in the coordinator user's home, beside the intake secrets. */
export declare const secretsDir: (instance: string, home?: string) => string;
/**
 * The request body of a pasted secret, `{"value": "..."}`. Every failure is a fixed message: never the body,
 * never a parser's message (which quotes it).
 */
export declare function readSecretBody(req: IncomingMessage): Promise<string>;
/**
 * What the server does for one credential beyond storing it (the dashboard's, per credential name):
 * - `shape`: what its value must look like; one that doesn't is refused with `what`, a fixed text, and nothing is
 *   stored;
 * - `stored`: runs once the file is installed, with the file's path only (never the value), inside the answer's
 *   transaction: when it throws, the ask stays open. What it returns is added to the answer's detail.
 */
export interface SecretRule {
    shape?: {
        re: RegExp;
        what: string;
    };
    stored?: (ask: Ask & {
        kind: 'paste_secret';
    }, file: string) => string | void;
}
/**
 * Install a pasted secret for an open paste_secret ask and answer it, once. Owner only. The answer records
 * who, when and the file it went to; the value goes nowhere but that file.
 */
export declare function storeSecret(log: EventLog, id: string, a: {
    by: string;
    role: Role | null;
    value: string;
    dir: string;
    rules?: Record<string, SecretRule>;
}): Ask;
