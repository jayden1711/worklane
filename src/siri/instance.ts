// An instance dashboard's Siri routes (docs/siri.md): the only three paths a Siri device token reaches, behind the
// hub's Siri gateway (src/siri/gateway.ts).
//
// What makes anything else impossible, rather than only checked:
// - These routes are dispatched before the dashboard's own auth (identify) and never fall through to it: every
//   /api/siri/... request ends here.
// - They take the Siri gateway token (its own file, `siri-gateway-token`, which the hub's viewer may read), never the
//   dashboard token; and the dashboard's routes never take the gateway token (it isn't the dashboard token). So the
//   hub's gateway holds nothing that works on any other route, and the dashboard key works on none of these.
// - A request here is a `SiriCaller`, not a `Who`: the dashboard's audit, decide, chat, settings and console
//   functions take a `Who`, so the type checker refuses a Siri request anywhere else. It can do two things: leave a
//   spoken idea in the voice inbox (submitVoiceIntake: never trusted, an Inbox approval always) and leave a question
//   for the coordinator's tool-less, viewer-level answer (askSiri).
// - A person's login header or the console-device header is refused here: the gateway names no person.
// Every request that reaches a device check is audited (`dashboard.audit`, via `siri`): the device, its token id and
// its Tailscale node, never the words said or the token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DEVICE_HEADER, LOGIN_HEADER } from '../dashboard-auth.js';
import { EventLog } from '../events/log.js';
import { loadIntakeConfig } from '../intake/config.js';
import { submitVoiceIntake } from '../intake/voice.js';
import { VOICE_MAX_CHARS } from '../voice.js';
import { ASK_MAX, askSiri, siriAnswer } from './ask.js';
import { RateLimits, TOKEN, verifyToken, type DeviceRecord, type SiriNode } from './tokens.js';

/** The gateway's token file, beside the dashboard token in the instance's state. */
export const SIRI_GATEWAY_TOKEN_FILE = 'siri-gateway-token';
/** The device token, as the gateway passes it on (the phone sends it as its bearer token). */
export const SIRI_DEVICE_HEADER = 'x-siri-device-token';
/** The Tailscale node the gateway identified: JSON { id, name }. */
export const SIRI_NODE_HEADER = 'x-siri-node';
/** The instance routes the gateway calls, and nothing else. */
export const SIRI_ROUTES = { tell: '/api/siri/tell', ask: '/api/siri/ask' } as const;
/** How long one request waits for an answer before saying it is still thinking. */
export const SIRI_WAIT_MS = 8_000;
/** What a pending answer says: the last thing heard if the answer never came in time. */
export const STILL_THINKING = "That's taking too long. Try again in a minute.";

/** The instance's Siri gateway token, made the first time (0600, like the dashboard token, and never the same). */
export function siriGatewayToken(stateDir: string, dashboardToken: string): string {
  const f = join(stateDir, SIRI_GATEWAY_TOKEN_FILE);
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t && t !== dashboardToken) return t;
  }
  mkdirSync(stateDir, { recursive: true });
  let t = randomBytes(24).toString('base64url');
  while (t === dashboardToken) t = randomBytes(24).toString('base64url');
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

/** A Siri request: a device and its node. Not a `Who`: no login, no role, nothing the dashboard's routes accept. */
export interface SiriCaller {
  readonly kind: 'siri';
  readonly device: DeviceRecord;
  readonly node: SiriNode;
}

export interface SiriContext {
  stateDir: string;
  /** The instance's name (server mode); null: a checkout's own dashboard, which has no Siri. */
  instance: string | null;
  intakeFile?: string;
  eventsDb: string;
  gatewayToken: string;
  limits: RateLimits;
  waitMs?: number;
  now?: () => Date;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Every answer: JSON with `speech` (what the phone says), `done`, and an `id` while an answer is pending. */
export function speak(res: ServerResponse, status: number, speech: string, extra: { done?: boolean; id?: string } = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ speech, done: extra.done ?? true, ...(extra.id ? { id: extra.id } : {}) }));
}

async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return null;
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function auditSiri(ctx: SiriContext, device: DeviceRecord | null, action: string, detail: Record<string, unknown>) {
  const log = new EventLog(ctx.eventsDb);
  try {
    // INVARIANT: never the token, the words said or the answer: the device, its token id, its node and what happened.
    log.append('dashboard.audit', { login: device?.createdBy ?? 'unknown', role: 'viewer', via: 'siri', instance: ctx.instance, action, detail: { ...(device ? { device: device.name, token: device.id } : {}), ...detail } }, device ? `siri:${device.id}` : 'siri', 'human');
  } finally {
    log.close();
  }
}

function nodeOf(req: IncomingMessage): SiriNode | null {
  const raw = req.headers[SIRI_NODE_HEADER];
  if (typeof raw !== 'string' || raw.length > 400) return null;
  try {
    const v = JSON.parse(raw) as { id?: unknown; name?: unknown };
    return typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) && typeof v.name === 'string' && /^[a-z0-9.-]{1,253}$/i.test(v.name) ? { id: v.id, name: v.name } : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait (up to the context's wait) for the coordinator's answer; pending after that. */
async function answerOrPending(ctx: SiriContext, res: ServerResponse, id: string, device: string) {
  const end = Date.now() + (ctx.waitMs ?? SIRI_WAIT_MS);
  for (;;) {
    const a = siriAnswer(ctx.stateDir, id);
    if (!a || a.device !== device) return speak(res, 404, "I don't have that question.");
    // The id always comes back, answered or not: the Shortcut asks again by it, and an answered one comes back at once.
    if (a.state !== 'pending') return speak(res, 200, a.speech, { id });
    if (Date.now() >= end) return speak(res, 202, STILL_THINKING, { done: false, id });
    await sleep(200);
  }
}

/**
 * Every /api/siri/... request on an instance's dashboard, before and instead of the dashboard's own auth. Ends the
 * request whatever happens.
 */
export async function handleSiri(req: IncomingMessage, res: ServerResponse, url: URL, ctx: SiriContext): Promise<void> {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!same(bearer, ctx.gatewayToken)) return speak(res, 401, 'This only answers the Siri gateway.');
  if (req.headers[LOGIN_HEADER] !== undefined || req.headers[DEVICE_HEADER] !== undefined) return speak(res, 400, 'A Siri request names no person.');
  if (url.search) return speak(res, 400, 'A Siri request has no query.');
  const poll = url.pathname.match(/^\/api\/siri\/ask\/([0-9]{13}-[a-f0-9]{8})$/);
  const route = req.method === 'POST' && url.pathname === SIRI_ROUTES.tell ? 'tell' : req.method === 'POST' && url.pathname === SIRI_ROUTES.ask ? 'ask' : req.method === 'GET' && poll ? 'poll' : null;
  if (!route) return speak(res, 404, 'Siri can only tell or ask.');
  if (!ctx.instance) return speak(res, 404, 'Siri needs a server instance behind the hub.');
  const token = req.headers[SIRI_DEVICE_HEADER];
  const node = nodeOf(req);
  const tokenId = typeof token === 'string' ? (TOKEN.exec(token)?.[2] ?? null) : null;
  const intake = ctx.intakeFile ? loadIntakeConfig(ctx.intakeFile) : null;
  if (!intake || 'error' in intake || !intake.config.siri.enabled) {
    auditSiri(ctx, null, 'siri.refused', { route, token: tokenId, node: node?.name ?? null, why: 'siri is off' });
    return speak(res, 403, 'Siri is off for this instance.');
  }
  if (typeof token !== 'string' || !node) {
    auditSiri(ctx, null, 'siri.refused', { route, token: tokenId, node: node?.name ?? null, why: 'no token or no Tailscale device' });
    return speak(res, 401, "That device isn't allowed. Make a new token on the dashboard.");
  }
  const v = verifyToken({ stateDir: ctx.stateDir, instance: ctx.instance, token, node, ...(ctx.now ? { now: ctx.now() } : {}) });
  if (!v.ok) {
    auditSiri(ctx, v.device, 'siri.refused', { route, token: tokenId, node: node.name, nodeId: node.id, why: v.why });
    return speak(res, 401, /expired/.test(v.why) ? 'That token expired. Make a new one on the dashboard.' : "That device isn't allowed. Make a new token on the dashboard.");
  }
  const caller: SiriCaller = { kind: 'siri', device: v.device, node };
  if (v.bound) auditSiri(ctx, caller.device, 'siri.bound', { node: node.name, nodeId: node.id });
  if (route === 'poll') return answerOrPending(ctx, res, poll![1]!, caller.device.id);
  return route === 'tell' ? tell(req, res, ctx, caller) : ask(req, res, ctx, caller);
}

async function tell(req: IncomingMessage, res: ServerResponse, ctx: SiriContext, c: SiriCaller) {
  const body = await readJson(req, 32_000);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return speak(res, 400, "I didn't hear anything to pass on.");
  if (text.length > VOICE_MAX_CHARS) return speak(res, 400, 'That was too long. Try a shorter idea.');
  if (!ctx.limits.take(c.device.id, 'tell')) {
    auditSiri(ctx, c.device, 'siri.refused', { route: 'tell', node: c.node.name, why: 'over 20 an hour' });
    return speak(res, 429, "That's a lot of ideas for one hour. Try again later.");
  }
  // The voice inbox, as the dashboard's spoken ideas: the coordinator's intake takes it, never trusted.
  const { id } = submitVoiceIntake({ stateDir: ctx.stateDir, text, by: `siri:${c.device.name}` });
  auditSiri(ctx, c.device, 'siri.tell', { node: c.node.name, id, chars: text.length });
  return speak(res, 200, "Got it. It's in the Inbox for review.");
}

async function ask(req: IncomingMessage, res: ServerResponse, ctx: SiriContext, c: SiriCaller) {
  const body = await readJson(req, 8_000);
  const question = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!question) return speak(res, 400, "I didn't hear a question.");
  if (question.length > ASK_MAX) return speak(res, 400, 'That question was too long.');
  if (!ctx.limits.take(c.device.id, 'ask')) {
    auditSiri(ctx, c.device, 'siri.refused', { route: 'ask', node: c.node.name, why: 'over 10 an hour' });
    return speak(res, 429, "That's a lot of questions for one hour. Try again later.");
  }
  const { id } = askSiri({ stateDir: ctx.stateDir, device: c.device.id, question });
  auditSiri(ctx, c.device, 'siri.ask', { node: c.node.name, id, chars: question.length });
  return answerOrPending(ctx, res, id, c.device.id);
}

