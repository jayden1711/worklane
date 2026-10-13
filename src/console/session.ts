// Who is asking, as the setup console needs it: their login, their role on this instance, and when they last
// signed in with GitHub. This is the seam for per-person sign-in (#197): until it lands, an instance dashboard
// has one configured user (its --user), whose role comes from project.owners and who has no sign-in time, so
// everything that needs a fresh sign-in (the owner terminal) is refused. #197 supplies a SessionOf that reads
// its session cookie (and checks CSRF on writes) and the role from the repo permission.
import type { IncomingMessage } from 'node:http';
import type { Role } from './asks.js';

export interface ConsoleSession {
  login: string;
  /** The person's role on this instance; null: none (refused). */
  role: Role | null;
  /** When they last authenticated with GitHub (ms since the epoch); null: never, or unknown. */
  authenticatedAt: number | null;
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
export function roleFromOwners(user: string, owners: { default: string; writers: string[] }): Role | null {
  if (!user) return null;
  const u = user.toLowerCase();
  if (u === owners.default.toLowerCase()) return 'owner';
  return owners.writers.some((w) => w.toLowerCase() === u) ? 'writer' : 'viewer';
}

/**
 * The session for a dashboard with one configured user (before #197): their role from project.owners, no
 * sign-in time. The per-install token already authenticated the request, and it isn't a cookie, so CSRF
 * doesn't apply to it.
 */
export const fixedUserSession =
  (user: string, owners: { default: string; writers: string[] }): SessionOf =>
  () => ({ login: user, role: roleFromOwners(user, owners), authenticatedAt: null, csrfOk: true });
