// A webhook automation's deliveries, on the instance's own dashboard (docs/automations.md). They reach it only from
// the hub's hooks gateway (src/automations/webhook-gateway.ts: the tailnet, never Funnel), on /api/hooks/<id>, before
// and instead of the dashboard's own auth, like Siri's routes (src/siri/instance.ts):
// - only the hooks gateway token works here (its own file, which the hub's viewer may read with dashboards.sh
//   --hooks); it is never the dashboard token, works on no other route, and the dashboard key works on none of these;
// - the instance, not the hub, checks the delivery: the automation exists, is on and takes webhooks; the timestamp is
//   within WINDOW_S; the signature is HMAC-SHA256 with this automation's own secret over `<timestamp>.<delivery>.<body>`;
//   the delivery id was never seen (kept REPLAY_KEEP_MS, longer than the window); the gateway's node is the one the
//   automation is bound to (the first that sent a valid delivery). Every refusal answers the same 401 with the same
//   body, so nothing tells a caller which part failed, or whether the automation exists;
// - an accepted delivery is only recorded (automation.webhook, its body redacted and cut, as untrusted text). The
//   coordinator turns it into an approval: nothing runs before an owner approves.
// The hub holds no secret: it can't sign. Each secret is its own file in the instance's home (0400 in a 0700 folder),
// shown once when made; never in automations.yaml, an event, the audit or a response after that.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DEVICE_HEADER, LOGIN_HEADER } from '../dashboard-auth.js';
import { EventLog } from '../events/log.js';
import { redactString } from '../events/redact.js';
import { redactPii } from '../intake/redact.js';
import { AUTOMATION_ID, TRIGGER_TEXT_MAX } from './schema.js';
import { loadAutomations, pauseBySystem } from './store.js';
import { readHooksState, readSecret, writeHooksState } from './secrets.js';

/** The gateway's token file, beside the dashboard token in the instance's state. */
export const HOOKS_GATEWAY_TOKEN_FILE = 'hooks-gateway-token';
/** The headers a delivery carries (the caller sets the first three; the gateway the node, from Tailscale). */
export const HOOK_HEADERS = { timestamp: 'x-hook-timestamp', delivery: 'x-hook-delivery', signature: 'x-hook-signature', node: 'x-hook-node' } as const;
/** The instance route the gateway calls: /api/hooks/<automation id>, and nothing else. */
export const HOOK_ROUTE = /^\/api\/hooks\/([^/]{1,80})$/;
/** A delivery's body, at most. */
export const BODY_MAX = 64 * 1024;
/** How far a delivery's timestamp may be from now, either way (seconds). */
export const WINDOW_S = 300;
/** How long a delivery id is remembered: longer than the window, so a replay is always refused. */
export const REPLAY_KEEP_MS = 15 * 60_000;
/** Deliveries one automation accepts an hour, at most (each still waits for an owner). */
export const ACCEPT_PER_HOUR = 30;
/** Refused deliveries for one automation in an hour that pause it (a storm), with a notice in its detail. */
export const STORM_REFUSALS = 50;
const DELIVERY = /^[A-Za-z0-9_-]{8,80}$/;
const REFUSED = JSON.stringify({ error: 'refused' });

/** The instance's hooks gateway token, made the first time (0600; never the dashboard's or Siri's). */
export function hooksGatewayToken(stateDir: string, others: string[]): string {
  const f = join(stateDir, HOOKS_GATEWAY_TOKEN_FILE);
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t && !others.includes(t)) return t;
  }
  mkdirSync(stateDir, { recursive: true });
  let t = randomBytes(24).toString('base64url');
  while (others.includes(t)) t = randomBytes(24).toString('base64url');
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

/** The signature a delivery carries: `v1=` and the hex HMAC-SHA256 of `<timestamp>.<delivery>.<body>`. */
export function signature(secret: string, timestamp: string, delivery: string, body: Buffer | string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${delivery}.`).update(body).digest('hex')}`;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface HookContext {
  stateDir: string;
  /** The instance's home (automations.yaml and the secrets folder). */
  home: string;
  automationsFile: string;
  eventsDb: string;
  gatewayToken: string;
  instance: string;
  now?: () => number;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function nodeOf(req: IncomingMessage): { id: string; name: string } | null {
  const raw = req.headers[HOOK_HEADERS.node];
  if (typeof raw !== 'string' || raw.length > 400) return null;
  try {
    const v = JSON.parse(raw) as { id?: unknown; name?: unknown };
    return typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) && typeof v.name === 'string' && /^[a-z0-9.-]{1,253}$/i.test(v.name) ? { id: v.id, name: v.name } : null;
  } catch {
    return null;
  }
}

const header = (req: IncomingMessage, h: string) => (typeof req.headers[h] === 'string' ? (req.headers[h] as string) : '');

/**
 * Check one delivery. `ok`: accepted (recorded by the caller). Else the status to answer (401 for every refusal of the
 * delivery itself, the same body each time; 413 too long; 429 over the hour's cap) and why (for the log, never sent).
 */
export function checkDelivery(o: { ctx: HookContext; id: string; body: Buffer; timestamp: string; delivery: string; sig: string; node: { id: string; name: string } }): { ok: true } | { ok: false; status: number; why: string; known: boolean } {
  const now = o.ctx.now?.() ?? Date.now();
  const no = (why: string, known = true) => ({ ok: false as const, status: 401, why, known });
  if (!AUTOMATION_ID.test(o.id)) return no('not an automation id', false);
  const loaded = loadAutomations(o.ctx.automationsFile);
  const a = loaded.file.automations.find((x) => x.id === o.id);
  if (!a || a.trigger.kind !== 'webhook') return no('no webhook automation by that id', false);
  if (!a.enabled) return no('paused');
  const secret = readSecret(o.ctx.home, a.id);
  if (!secret) return no('it has no secret (make one with Rotate secret)');
  const ts = Number(o.timestamp);
  if (!/^[0-9]{9,11}$/.test(o.timestamp) || Math.abs(now / 1000 - ts) > WINDOW_S) return no(`its timestamp is more than ${WINDOW_S} s from now`);
  if (!DELIVERY.test(o.delivery)) return no('its delivery id is not 8-80 letters, digits, - or _');
  if (!same(o.sig, signature(secret, o.timestamp, o.delivery, o.body))) return no("its signature isn't this automation's");
  const s = readHooksState(o.ctx.stateDir);
  const seen = Object.fromEntries(Object.entries(s.seen[a.id] ?? {}).filter(([, at]) => now - at < REPLAY_KEEP_MS));
  if (o.delivery in seen) return no('a replay: that delivery id was seen');
  const bound = s.bound[a.id];
  if (bound && bound.id !== o.node.id) return no(`from ${o.node.name}, but it is bound to ${bound.name}`);
  const hour = (s.accepted[a.id] ?? []).filter((at) => now - at < 3600_000);
  if (hour.length >= ACCEPT_PER_HOUR) return { ok: false, status: 429, why: `${ACCEPT_PER_HOUR} deliveries in the last hour`, known: true };
  seen[o.delivery] = now;
  s.seen[a.id] = seen;
  s.accepted[a.id] = [...hour, now];
  if (!bound) s.bound[a.id] = { id: o.node.id, name: o.node.name, at: new Date(now).toISOString() };
  writeHooksState(o.ctx.stateDir, s);
  return { ok: true };
}

/** A refusal for a known automation: counted; the STORM_REFUSALS-th in an hour pauses it. */
function countRefusal(ctx: HookContext, id: string, log: EventLog): void {
  const now = ctx.now?.() ?? Date.now();
  const s = readHooksState(ctx.stateDir);
  const xs = [...(s.refused[id] ?? []).filter((at) => now - at < 3600_000), now];
  s.refused[id] = xs;
  writeHooksState(ctx.stateDir, s);
  if (xs.length >= STORM_REFUSALS) pauseBySystem({ path: ctx.automationsFile, id, why: `${STORM_REFUSALS} refused deliveries in an hour`, by: ctx.instance, log });
}

/** Every /api/hooks/... request on an instance's dashboard, before and instead of its own auth. Always ends the request. */
export async function handleHook(req: IncomingMessage, res: ServerResponse, url: URL, ctx: HookContext): Promise<void> {
  const send = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  const m = HOOK_ROUTE.exec(url.pathname);
  if (req.method !== 'POST' || !m || url.search) return send(404, JSON.stringify({ error: 'not found' }));
  const given = (req.headers.authorization ?? '').replace(/^Bearer /, '').trim();
  // Only the gateway: its token, no person, no console device.
  if (!given || !same(given, ctx.gatewayToken) || req.headers[LOGIN_HEADER] !== undefined || req.headers[DEVICE_HEADER] !== undefined) return send(401, REFUSED);
  const node = nodeOf(req);
  if (!node) return send(401, REFUSED);
  const body = await readBody(req);
  if (body === null) return send(413, JSON.stringify({ error: 'too long' }));
  const id = decodeURIComponent(m[1]!);
  const delivery = header(req, HOOK_HEADERS.delivery);
  const got = checkDelivery({ ctx, id, body, timestamp: header(req, HOOK_HEADERS.timestamp), delivery, sig: header(req, HOOK_HEADERS.signature), node });
  const log = new EventLog(ctx.eventsDb);
  try {
    if (!got.ok) {
      if (got.known) {
        // INVARIANT: ref null: a refused delivery never names a delivery id, so a forged one can't mark a real one handled.
        log.append('automation.refused', { id, trigger: 'webhook', ref: null, why: `delivery from ${node.name} refused: ${got.why}` }, 'hooks');
        countRefusal(ctx, id, log);
      }
      return send(got.status, got.status === 401 ? REFUSED : JSON.stringify({ error: 'too many' }));
    }
    log.append('automation.webhook', { id, delivery, node, text: redactPii(redactString(body.toString('utf8'))).slice(0, TRIGGER_TEXT_MAX) }, 'hooks');
  } finally {
    log.close();
  }
  return send(202, JSON.stringify({ delivery }));
}
