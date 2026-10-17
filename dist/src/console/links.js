// One-time links to a setup step's paste box, for an owner who asked for one in Discord. A secret or a root step is
// never typed into Discord: the bot sends the owner who asked a link to that ask on the dashboard instead, by DM.
// - The token is 32 random bytes (base64url), in the link's path, never its query (a proxy may log queries). The
//   page moves it out of the address bar at once and exchanges it by POST.
// - It is bound to the ask and to the owner's GitHub login: the dashboard still needs their own sign-in, and a
//   session of anyone else, or of someone who isn't an owner there now, is refused (and burns it).
// - It works once and for LINK_TTL_MS. Only its sha256 is recorded (setup_link.issued), so the log can't open it.
// The link grants nothing the owner's session doesn't already have: it only says which ask to open.
import { createHash, randomBytes } from 'node:crypto';
import { ASK_EVENTS, asksFrom } from './asks.js';
/** How long a link works. */
export const LINK_TTL_MS = 10 * 60_000;
/** A link token as minted: 32 bytes, base64url. */
export const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashOf = (token) => createHash('sha256').update(token).digest('hex');
/** Mint a link for `login` to open ask `ask`: the token (for the DM only; never recorded) and when it expires. */
export function issueSetupLink(log, o) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date((o.now ?? Date.now()) + LINK_TTL_MS).toISOString();
    log.append('setup_link.issued', { ask: o.ask, login: o.login, hash: hashOf(token), expires_at: expiresAt }, 'coordinator', 'coordinator');
    return { token, expiresAt };
}
/**
 * Exchange a link on the dashboard, by `who` (their session's login and role here). Once only, in one write
 * transaction: of two exchanges at once, one wins. Any presentation of a known link uses it up, refused or not.
 * Errors never quote the token.
 */
export function useSetupLink(log, o) {
    if (!LINK_TOKEN.test(o.token))
        return { ok: false, status: 400, error: 'not a setup link' };
    const hash = hashOf(o.token);
    log.db.exec('BEGIN IMMEDIATE');
    try {
        const issued = log.read(0, ['setup_link.issued']).map((e) => e.payload).find((p) => p.hash === hash);
        if (!issued) {
            log.db.exec('ROLLBACK');
            return { ok: false, status: 404, error: 'no such setup link; ask for a new one in Discord' };
        }
        if (log.read(0, ['setup_link.used']).some((e) => e.payload.hash === hash)) {
            log.db.exec('ROLLBACK');
            return { ok: false, status: 410, error: 'this setup link was used already; ask for a new one in Discord' };
        }
        const burn = (outcome) => log.append('setup_link.used', { hash, by: o.login, outcome }, o.login, 'human');
        let refused = null;
        if ((o.now ?? Date.now()) >= Date.parse(issued.expires_at)) {
            burn('expired');
            refused = { ok: false, status: 410, error: 'this setup link expired; ask for a new one in Discord' };
        }
        else if (issued.login.toLowerCase() !== o.login.toLowerCase()) {
            burn('wrong_login');
            refused = { ok: false, status: 403, error: `this setup link is for another person, not @${o.login}` };
        }
        else if (o.role !== 'owner') {
            burn('not_owner');
            refused = { ok: false, status: 403, error: `@${o.login} is not an owner here now; a setup step is the owners'` };
        }
        else if (asksFrom(log.read(0, [...ASK_EVENTS])).find((a) => a.id === issued.ask)?.status !== 'open') {
            burn('closed');
            refused = { ok: false, status: 409, error: 'this setup step is no longer waiting' };
        }
        else
            burn('opened');
        log.db.exec('COMMIT');
        return refused ?? { ok: true, ask: issued.ask };
    }
    catch (e) {
        try {
            log.db.exec('ROLLBACK');
        }
        catch {
            // already rolled back
        }
        throw e;
    }
}
//# sourceMappingURL=links.js.map