// Siri device tokens (docs/siri.md): one per phone, made by an owner on the dashboard, shown once, revocable, bound to
// the first Tailscale device that uses it, and good for exactly two things: "tell" (a spoken idea for the Inbox) and
// "ask" (a spoken, viewer-level answer). Never the dashboard key, and never a session.
//
// The store is the instance's own (`<state>/siri/devices.json`, 0600, the coordinator user's): it holds each token's
// SHA-256, never the token. The secret is 256 random bits, so a plain hash is enough; it is compared in constant time.
//
// A token reads `<cli>_siri_<instance>_<id>_<secret>`: the instance it works on (the hub's gateway sends it there and
// nowhere else), a 10-character id (shown on the dashboard and in the audit) and the secret.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import { ownerOnlyDir } from '../os/index.js';
/** A token unused this long is refused (and shown as expired): there is no fixed lifetime. */
export const IDLE_EXPIRY_MS = 60 * 24 * 3_600_000;
/** The most devices one instance keeps (revoked ones included, until removed). */
export const MAX_DEVICES = 20;
/** A device's name: what the owner calls the phone. */
export const DEVICE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} '._-]{0,39}$/u;
const INSTANCE = '[a-z][a-z0-9-]{0,40}';
const ID = '[a-z2-7]{10}';
const SECRET = '[A-Za-z0-9_-]{43}';
/** The prefix every token starts with (a scanner can find one pasted where it shouldn't be). */
export const TOKEN_PREFIX = `${BRAND.cli}_siri_`;
/** A whole token: its instance, its id and its secret. */
export const TOKEN = new RegExp(`^${TOKEN_PREFIX}(${INSTANCE})_(${ID})_(${SECRET})$`);
export const DEVICE_ID = new RegExp(`^${ID}$`);
export class SiriTokenError extends Error {
}
const file = (stateDir) => join(stateDir, 'siri', 'devices.json');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function newId() {
    const b = randomBytes(10);
    return [...b].map((x) => B32[x & 31]).join('');
}
/** The instance's devices (an unreadable or malformed store is no devices: every token is refused). */
export function readDevices(stateDir) {
    const f = file(stateDir);
    if (!existsSync(f))
        return [];
    try {
        const v = JSON.parse(readFileSync(f, 'utf8'));
        if (v.v !== 1 || !Array.isArray(v.devices))
            return [];
        return v.devices.filter((d) => !!d && typeof d === 'object' && DEVICE_ID.test(d.id) && /^[0-9a-f]{64}$/.test(d.hash));
    }
    catch {
        return [];
    }
}
function writeDevices(stateDir, devices) {
    const dir = join(stateDir, 'siri');
    ownerOnlyDir(dir);
    const tmp = join(dir, `.devices.${randomBytes(3).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify({ v: 1, devices }, null, 2), { mode: 0o600 });
    renameSync(tmp, file(stateDir));
}
const expired = (d, now) => now - Date.parse(d.lastUsed ?? d.created) > IDLE_EXPIRY_MS;
export function viewOf(d, now = Date.now()) {
    return {
        id: d.id,
        name: d.name,
        created: d.created,
        createdBy: d.createdBy,
        boundNode: d.boundNode?.name ?? null,
        lastUsed: d.lastUsed,
        lastNode: d.lastNode,
        lastForeign: d.lastForeign,
        state: d.revokedAt ? 'revoked' : expired(d, now) ? 'expired' : 'active',
        revokedAt: d.revokedAt,
    };
}
export const listDevices = (stateDir, now = Date.now()) => readDevices(stateDir).map((d) => viewOf(d, now));
/** A new device's token: returned here once, never stored or shown again (only its hash is kept). */
export function createDevice(o) {
    const name = o.name.trim();
    if (!DEVICE_NAME.test(name))
        throw new SiriTokenError("a device's name: 1-40 letters, digits, spaces, ' . _ or -, starting with a letter or digit");
    if (!new RegExp(`^${INSTANCE}$`).test(o.instance))
        throw new SiriTokenError('Siri devices are made on a server instance (behind the hub), which has a name');
    const devices = readDevices(o.stateDir);
    if (devices.length >= MAX_DEVICES)
        throw new SiriTokenError(`at most ${MAX_DEVICES} devices; remove a revoked one first`);
    if (devices.some((d) => !d.revokedAt && d.name.toLowerCase() === name.toLowerCase()))
        throw new SiriTokenError(`a device named "${name}" exists already`);
    let id = newId();
    while (devices.some((d) => d.id === id))
        id = newId();
    const secret = randomBytes(32).toString('base64url');
    const now = (o.now ?? new Date()).toISOString();
    const rec = { id, name, hash: sha256(secret), created: now, createdBy: o.by, boundNode: null, lastUsed: null, lastNode: null, lastForeign: null, revokedAt: null, revokedBy: null };
    writeDevices(o.stateDir, [...devices, rec]);
    return { token: `${TOKEN_PREFIX}${o.instance}_${id}_${secret}`, device: viewOf(rec) };
}
function change(stateDir, id, f) {
    const devices = readDevices(stateDir);
    const i = devices.findIndex((d) => d.id === id);
    if (i < 0)
        throw new SiriTokenError(`no Siri device ${id}`);
    const next = f(devices[i]);
    if (next)
        devices[i] = next;
    writeDevices(stateDir, devices);
    return viewOf(devices[i]);
}
/** Revoke: refused from the next request on. Kept on the list (as revoked) for the record. */
export const revokeDevice = (stateDir, id, by, now = new Date()) => change(stateDir, id, (d) => (d.revokedAt ? null : { ...d, revokedAt: now.toISOString(), revokedBy: by }));
/** Revoke every device still active (an instance removed or renamed): none works from the next request on. Returns their ids. */
export function revokeAllDevices(stateDir, by, now = new Date()) {
    const ids = readDevices(stateDir).filter((d) => !d.revokedAt).map((d) => d.id);
    for (const id of ids)
        revokeDevice(stateDir, id, by, now);
    return ids;
}
/** Unbind: the next use binds it again (to whichever node makes it). */
export const unbindDevice = (stateDir, id) => change(stateDir, id, (d) => ({ ...d, boundNode: null, lastForeign: null }));
/**
 * Check a token for this instance, from this node. On success the device's last use (and, the first time, its node)
 * is recorded; a use from another node than the bound one is recorded as foreign and refused.
 */
export function verifyToken(o) {
    const m = TOKEN.exec(o.token);
    if (!m)
        return { ok: false, why: 'not a Siri device token', device: null };
    if (m[1] !== o.instance)
        return { ok: false, why: 'this token is for another instance', device: null };
    const devices = readDevices(o.stateDir);
    const d = devices.find((x) => x.id === m[2]);
    const given = Buffer.from(sha256(m[3]), 'hex');
    // Compared even when there is no such device, so an unknown id takes as long as a wrong secret.
    const want = Buffer.from(d?.hash ?? '0'.repeat(64), 'hex');
    const match = timingSafeEqual(given, want);
    if (!d || !match)
        return { ok: false, why: 'unknown or wrong token', device: null };
    const now = o.now ?? new Date();
    if (d.revokedAt)
        return { ok: false, why: 'this device was revoked', device: d };
    if (expired(d, now.getTime()))
        return { ok: false, why: 'this token expired (unused 60 days): make a new one on the dashboard', device: d };
    if (!o.node.id || !o.node.name)
        return { ok: false, why: "the request's Tailscale device is unknown", device: d };
    if (d.boundNode && d.boundNode.id !== o.node.id) {
        change(o.stateDir, d.id, (x) => ({ ...x, lastForeign: { at: now.toISOString(), node: o.node.name } }));
        return { ok: false, why: `this token is bound to ${d.boundNode.name}; it was used from ${o.node.name}`, device: d };
    }
    const bound = !d.boundNode;
    const used = { ...d, boundNode: d.boundNode ?? { id: o.node.id, name: o.node.name }, lastUsed: now.toISOString(), lastNode: o.node.name };
    change(o.stateDir, d.id, () => used);
    return { ok: true, device: used, bound };
}
/** Per-device limits, in the instance's dashboard process (a restart starts them afresh). */
export const LIMITS = { tell: { n: 20, ms: 3_600_000 }, ask: { n: 10, ms: 3_600_000 } };
export class RateLimits {
    now;
    seen = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    /** Count one use of `kind` by device `id`; false (and not counted) when over its limit. */
    take(id, kind) {
        const { n, ms } = LIMITS[kind];
        const t = this.now();
        const k = `${kind}:${id}`;
        const xs = (this.seen.get(k) ?? []).filter((x) => t - x < ms);
        if (xs.length >= n) {
            this.seen.set(k, xs);
            return false;
        }
        xs.push(t);
        this.seen.set(k, xs);
        return true;
    }
}
//# sourceMappingURL=tokens.js.map