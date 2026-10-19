// Governance mode (#704, slice S8): the GitHub App's PR webhook receiver. Nothing mounts it yet (S9 does, beside the
// dashboard's other verify-first routes); polling stays the fallback either way.
//
// INVARIANT: verify first, like the automations hooks gateway (src/automations/webhook.ts). In this order, and nothing
// of a delivery is read before the step that needs it: a secret is configured (else 503 for everything); the body is
// within BODY_MAX (else 413, unread); its X-Hub-Signature-256 is the HMAC-SHA256 of the raw body under that secret,
// compared in constant time (else 401, the same body every time). Only a delivery that passed all three has its event
// name, delivery id or JSON looked at. Its parsed payload then goes through the #711 guard (a Claude credential in it
// refuses the whole delivery) before any wake is made.
//
// INVARIANT: a delivery only wakes. Its result is a PrWake: the configured repo and a PR number (or null: list the
// repo's open PRs again), made only here, frozen, recognised by a module-private WeakSet. No head, check, review,
// label, sender or text from the payload leaves this module, so a forged, replayed or stale delivery can at most make
// the gate re-read a PR through the API, which decides on what the API says (#704: "webhooks are hints, not data").
//
// The delivery-id window is defence in depth only (the gate re-reads anyway): an id is remembered REPLAY_KEEP_MS,
// at most REPLAY_MAX of them, and only after its signature passed, so a forged delivery can't spend a real id.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { holdsClaudeCredential } from './claude-credential-guard.js';

/** The headers GitHub sends with every delivery. */
export const GITHUB_HEADERS = { event: 'x-github-event', delivery: 'x-github-delivery', signature: 'x-hub-signature-256' } as const;
/** The events that wake the gate (#704 slice 7's list); `ping` is answered; anything else is refused. */
export const WAKE_EVENTS = Object.freeze(['pull_request', 'pull_request_review', 'check_run', 'check_suite', 'status'] as const);
/** A delivery's body, at most. WHY: PR and check payloads are tens of KB; a bigger one is dropped and polling covers it. */
export const BODY_MAX = 1024 * 1024;
/** A shorter secret is treated as none. */
export const SECRET_MIN = 16;
/** How long a delivery id is remembered, and how many at most. */
export const REPLAY_KEEP_MS = 60 * 60_000;
export const REPLAY_MAX = 10_000;
/** PRs one check delivery may name; more wake the whole repo once instead. */
export const PRS_PER_DELIVERY = 20;

type WakeEvent = (typeof WAKE_EVENTS)[number];
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
// WHY: GitHub's delivery ids are GUIDs; anything else isn't a GitHub delivery.
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MINT = Symbol('webhook wake mint');
const minted = new WeakSet<object>();

/** Re-read this PR (or, with pr null, the repo's open PRs) through the API. Made only by receiveDelivery(). */
export class PrWake {
  readonly repo: string;
  readonly pr: number | null;
  constructor(mint: symbol, repo: string, pr: number | null) {
    if (mint !== MINT) throw new Error('a PrWake is made only by the webhook receiver');
    this.repo = repo;
    this.pr = pr;
    Object.freeze(this);
    minted.add(this);
  }
}

/** Whether x is a wake the receiver made (never a copy or a look-alike). */
export function isWake(x: unknown): x is PrWake {
  return typeof x === 'object' && x !== null && minted.has(x);
}

/** Delivery ids seen lately: bounded in time and count, the oldest dropped first. */
export class DeliveryWindow {
  private readonly ids = new Map<string, number>();
  private readonly keepMs: number;
  private readonly max: number;
  constructor(o: { keepMs?: number; max?: number } = {}) {
    this.keepMs = o.keepMs ?? REPLAY_KEEP_MS;
    this.max = o.max ?? REPLAY_MAX;
  }
  get size(): number {
    return this.ids.size;
  }
  seen(id: string, now: number): boolean {
    const at = this.ids.get(id.toLowerCase());
    return at !== undefined && now - at <= this.keepMs;
  }
  record(id: string, now: number): void {
    const key = id.toLowerCase();
    this.ids.delete(key);
    this.ids.set(key, now);
    for (const [k, at] of this.ids) {
      if (this.ids.size <= this.max && now - at <= this.keepMs) break;
      this.ids.delete(k);
    }
  }
}

export interface Received {
  /** The HTTP status to answer. */
  status: number;
  wakes: readonly PrWake[];
  /** Why, for the log; never sent to the caller. */
  why: string;
}

const header = (h: IncomingHttpHeaders, name: string) => (typeof h[name] === 'string' ? (h[name] as string) : '');
const prNumber = (x: unknown): number | null => (typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? x : null);
const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

function signed(secret: string, body: Buffer, sig: string): boolean {
  const m = SIGNATURE.exec(sig);
  if (!m) return false;
  const want = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(Buffer.from(m[1]!, 'hex'), want);
}

/** The PR numbers an event names: one for a PR or review; a check's own list (deduplicated); none for a status. */
function prsOf(event: WakeEvent, p: Record<string, unknown>): number[] | 'repo' | null {
  if (event === 'pull_request' || event === 'pull_request_review') {
    const n = prNumber(obj(p.pull_request)?.number);
    return n === null ? null : [n];
  }
  if (event === 'status') return 'repo';
  const list = obj(p[event])?.pull_requests;
  const ns = [...new Set((Array.isArray(list) ? list : []).map((x) => prNumber(obj(x)?.number)).filter((x): x is number => x !== null))];
  return ns.length === 0 || ns.length > PRS_PER_DELIVERY ? 'repo' : ns;
}

interface DeliveryInput {
  secret: string | null;
  /** The instance's repo (owner/name): a wake names it, never the payload's spelling. */
  repo: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  window: DeliveryWindow;
  now?: number;
}

/** A delivery that passed every check before its wakes: its event and parsed payload, which never leave this module. */
interface Verified {
  event: WakeEvent;
  payload: Record<string, unknown>;
}

const no = (status: number, why: string): Received => ({ status, wakes: [], why });
// WHY: #711: no body the engine reads may carry a Claude credential; refused with a fixed text that never quotes it.
const CREDENTIAL = no(400, 'it holds a Claude credential (#711)');

/** One delivery, judged in the order the header comment gives. */
export function receiveDelivery(o: DeliveryInput): Received {
  const v = verify(o);
  if (!('payload' in v)) return v;
  if (holdsClaudeCredential(v.payload)) return CREDENTIAL;
  return wakesOf(v, o.repo);
}

function verify(o: DeliveryInput): Received | Verified {
  if (!o.secret || o.secret.length < SECRET_MIN) return no(503, 'no webhook secret is configured');
  if (o.body.length > BODY_MAX) return no(413, `the body is over ${BODY_MAX} bytes`);
  if (!signed(o.secret, o.body, header(o.headers, GITHUB_HEADERS.signature))) return no(401, "its signature isn't this App's");
  const now = o.now ?? Date.now();
  const event = header(o.headers, GITHUB_HEADERS.event);
  if (event === 'ping') return no(200, 'ping');
  if (!(WAKE_EVENTS as readonly string[]).includes(event)) return no(400, `${event || 'no event'} is not an event that wakes the gate`);
  const delivery = header(o.headers, GITHUB_HEADERS.delivery);
  if (!DELIVERY.test(delivery)) return no(400, 'its delivery id is not a GUID');
  if (o.window.seen(delivery, now)) return no(200, 'that delivery id was seen');
  o.window.record(delivery, now);
  let payload: Record<string, unknown> | null;
  try {
    payload = obj(JSON.parse(o.body.toString('utf8')));
  } catch {
    return no(400, 'its body is not JSON');
  }
  if (!payload) return no(400, 'its body is not a JSON object');
  return { event: event as WakeEvent, payload };
}

function wakesOf(v: Verified, repo: string): Received {
  const full = obj(v.payload.repository)?.full_name;
  if (typeof full !== 'string' || full.toLowerCase() !== repo.toLowerCase()) return no(202, 'not for this repo');
  const prs = prsOf(v.event, v.payload);
  if (prs === null) return no(202, 'it names no PR');
  const wakes = prs === 'repo' ? [new PrWake(MINT, repo, null)] : prs.map((n) => new PrWake(MINT, repo, n));
  return { status: 202, wakes, why: `${v.event}: ${wakes.length} wake(s)` };
}

/** Read a delivery off the wire and judge it as receiveDelivery does; null once its body is past BODY_MAX (read no further). */
async function readDelivery(req: IncomingMessage, o: Omit<DeliveryInput, 'body' | 'headers'>): Promise<Received | null> {
  if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) return null;
    chunks.push(c as Buffer);
  }
  const v = verify({ ...o, headers: req.headers, body: Buffer.concat(chunks) });
  if (!('payload' in v)) return v;
  if (holdsClaudeCredential(v.payload)) return CREDENTIAL;
  return wakesOf(v, o.repo);
}

const BODIES: Record<number, string> = { 200: '{"ok":true}', 202: '{"accepted":true}', 400: '{"error":"bad request"}', 401: '{"error":"refused"}', 405: '{"error":"POST only"}', 413: '{"error":"too long"}', 503: '{"error":"unavailable"}' };

/** A delivery over HTTP: answers it and hands each wake to `wake`. Always ends the request. */
export async function handleGithubWebhook(req: IncomingMessage, res: ServerResponse, ctx: { secret: () => string | null; repo: string; window: DeliveryWindow; wake: (w: PrWake) => void; log?: (why: string) => void; now?: () => number }): Promise<void> {
  const send = (status: number, after?: () => void) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(after ? { connection: 'close' } : {}) });
    res.end(BODIES[status] ?? '{}', after);
  };
  if (req.method !== 'POST') return send(405);
  const r = await readDelivery(req, { secret: ctx.secret(), repo: ctx.repo, window: ctx.window, now: ctx.now?.() ?? Date.now() });
  // WHY: stop reading an oversized body: answer, then drop the connection.
  if (r === null) return send(413, () => req.destroy());
  ctx.log?.(r.why);
  for (const w of r.wakes) ctx.wake(w);
  send(r.status);
}
