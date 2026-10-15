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

/** The Tailscale device a request came from, as the hub's gateway identified it (src/console/terminal-devices.ts). */
export interface SiriNode {
  /** Tailscale's stable node id: what a token binds to (a node can be renamed; this can't). */
  id: string;
  /** Its MagicDNS name. */
  name: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 of the secret, hex. */
  hash: string;
  created: string;
  createdBy: string;
  /** The first node that used it; every later use must come from the same one. */
  boundNode: SiriNode | null;
  lastUsed: string | null;
  lastNode: string | null;
  /** The last refusal because the request came from another node: when, and from which. */
  lastForeign: { at: string; node: string } | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** What the dashboard shows of a device: never the hash. */
export interface DeviceView {
  id: string;
  name: string;
  created: string;
  createdBy: string;
  boundNode: string | null;
  lastUsed: string | null;
  lastNode: string | null;
  lastForeign: { at: string; node: string } | null;
  state: 'active' | 'revoked' | 'expired';
  revokedAt: string | null;
}

export class SiriTokenError extends Error {}

const file = (stateDir: string) => join(stateDir, 'siri', 'devices.json');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function newId(): string {
  const b = randomBytes(10);
  return [...b].map((x) => B32[x & 31]).join('');
}

/** The instance's devices (an unreadable or malformed store is no devices: every token is refused). */
export function readDevices(stateDir: string): DeviceRecord[] {
  const f = file(stateDir);
  if (!existsSync(f)) return [];
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')) as { v?: number; devices?: unknown };
    if (v.v !== 1 || !Array.isArray(v.devices)) return [];
    return v.devices.filter((d): d is DeviceRecord => !!d && typeof d === 'object' && DEVICE_ID.test((d as DeviceRecord).id) && /^[0-9a-f]{64}$/.test((d as DeviceRecord).hash));
  } catch {
    return [];
  }
}

function writeDevices(stateDir: string, devices: DeviceRecord[]): void {
  const dir = join(stateDir, 'siri');
  ownerOnlyDir(dir);
  const tmp = join(dir, `.devices.${randomBytes(3).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify({ v: 1, devices }, null, 2), { mode: 0o600 });
  renameSync(tmp, file(stateDir));
}

const expired = (d: DeviceRecord, now: number) => now - Date.parse(d.lastUsed ?? d.created) > IDLE_EXPIRY_MS;

export function viewOf(d: DeviceRecord, now = Date.now()): DeviceView {
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

export const listDevices = (stateDir: string, now = Date.now()): DeviceView[] => readDevices(stateDir).map((d) => viewOf(d, now));

/** A new device's token: returned here once, never stored or shown again (only its hash is kept). */
export function createDevice(o: { stateDir: string; instance: string; name: string; by: string; now?: Date }): { token: string; device: DeviceView } {
  const name = o.name.trim();
  if (!DEVICE_NAME.test(name)) throw new SiriTokenError("a device's name: 1-40 letters, digits, spaces, ' . _ or -, starting with a letter or digit");
  if (!new RegExp(`^${INSTANCE}$`).test(o.instance)) throw new SiriTokenError('Siri devices are made on a server instance (behind the hub), which has a name');
  const devices = readDevices(o.stateDir);
  if (devices.length >= MAX_DEVICES) throw new SiriTokenError(`at most ${MAX_DEVICES} devices; remove a revoked one first`);
  if (devices.some((d) => !d.revokedAt && d.name.toLowerCase() === name.toLowerCase())) throw new SiriTokenError(`a device named "${name}" exists already`);
  let id = newId();
  while (devices.some((d) => d.id === id)) id = newId();
  const secret = randomBytes(32).toString('base64url');
  const now = (o.now ?? new Date()).toISOString();
  const rec: DeviceRecord = { id, name, hash: sha256(secret), created: now, createdBy: o.by, boundNode: null, lastUsed: null, lastNode: null, lastForeign: null, revokedAt: null, revokedBy: null };
  writeDevices(o.stateDir, [...devices, rec]);
  return { token: `${TOKEN_PREFIX}${o.instance}_${id}_${secret}`, device: viewOf(rec) };
}

function change(stateDir: string, id: string, f: (d: DeviceRecord) => DeviceRecord | null): DeviceView {
  const devices = readDevices(stateDir);
  const i = devices.findIndex((d) => d.id === id);
  if (i < 0) throw new SiriTokenError(`no Siri device ${id}`);
  const next = f(devices[i]!);
  if (next) devices[i] = next;
  writeDevices(stateDir, devices);
  return viewOf(devices[i]!);
}

/** Revoke: refused from the next request on. Kept on the list (as revoked) for the record. */
export const revokeDevice = (stateDir: string, id: string, by: string, now = new Date()) => change(stateDir, id, (d) => (d.revokedAt ? null : { ...d, revokedAt: now.toISOString(), revokedBy: by }));

/** Unbind: the next use binds it again (to whichever node makes it). */
export const unbindDevice = (stateDir: string, id: string) => change(stateDir, id, (d) => ({ ...d, boundNode: null, lastForeign: null }));

export type Verdict = { ok: true; device: DeviceRecord; bound: boolean } | { ok: false; why: string; device: DeviceRecord | null };

/**
 * Check a token for this instance, from this node. On success the device's last use (and, the first time, its node)
 * is recorded; a use from another node than the bound one is recorded as foreign and refused.
 */
export function verifyToken(o: { stateDir: string; instance: string; token: string; node: SiriNode; now?: Date }): Verdict {
  const m = TOKEN.exec(o.token);
  if (!m) return { ok: false, why: 'not a Siri device token', device: null };
  if (m[1] !== o.instance) return { ok: false, why: 'this token is for another instance', device: null };
  const devices = readDevices(o.stateDir);
  const d = devices.find((x) => x.id === m[2]);
  const given = Buffer.from(sha256(m[3]!), 'hex');
  // Compared even when there is no such device, so an unknown id takes as long as a wrong secret.
  const want = Buffer.from(d?.hash ?? '0'.repeat(64), 'hex');
  const match = timingSafeEqual(given, want);
  if (!d || !match) return { ok: false, why: 'unknown or wrong token', device: null };
  const now = o.now ?? new Date();
  if (d.revokedAt) return { ok: false, why: 'this device was revoked', device: d };
  if (expired(d, now.getTime())) return { ok: false, why: 'this token expired (unused 60 days): make a new one on the dashboard', device: d };
  if (!o.node.id || !o.node.name) return { ok: false, why: "the request's Tailscale device is unknown", device: d };
  if (d.boundNode && d.boundNode.id !== o.node.id) {
    change(o.stateDir, d.id, (x) => ({ ...x, lastForeign: { at: now.toISOString(), node: o.node.name } }));
    return { ok: false, why: `this token is bound to ${d.boundNode.name}; it was used from ${o.node.name}`, device: d };
  }
  const bound = !d.boundNode;
  const used: DeviceRecord = { ...d, boundNode: d.boundNode ?? { id: o.node.id, name: o.node.name }, lastUsed: now.toISOString(), lastNode: o.node.name };
  change(o.stateDir, d.id, () => used);
  return { ok: true, device: used, bound };
}

/** Per-device limits, in the instance's dashboard process (a restart starts them afresh). */
export const LIMITS = { tell: { n: 20, ms: 3_600_000 }, ask: { n: 10, ms: 3_600_000 } } as const;

export class RateLimits {
  private readonly seen = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  /** Count one use of `kind` by device `id`; false (and not counted) when over its limit. */
  take(id: string, kind: keyof typeof LIMITS): boolean {
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
