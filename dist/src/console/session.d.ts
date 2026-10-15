import type { IncomingMessage } from 'node:http';
import type { Role } from './asks.js';
export interface ConsoleSession {
    login: string;
    /** The person's role on this instance; null: none (refused). */
    role: Role | null;
    /** Whether this write request carries the session's CSRF token (#197). Reads ignore it. */
    csrfOk: boolean;
    /** The owner's break-glass (the token on this machine, no person named); false or unset: a person's session. */
    breakGlass?: boolean;
    /** Whether the hub identified this request's Tailscale device as an allowed console device (writes only). */
    deviceOk?: boolean;
}
/** The session behind a request, for one instance; null when there is none. */
export type SessionOf = (req: IncomingMessage, instance: string) => ConsoleSession | null;
/** A role from the project's owners (the model before #197): the default owner, a writer, or a viewer. */
export declare function roleFromOwners(user: string, owners: {
    default: string;
    writers: string[];
}): Role | null;
/**
 * The session for a dashboard with one configured user (before #197): their role from project.owners. The per-install token already authenticated the request, and it isn't a cookie, so CSRF
 * doesn't apply to it.
 */
export declare const fixedUserSession: (user: string, owners: {
    default: string;
    writers: string[];
}) => SessionOf;
