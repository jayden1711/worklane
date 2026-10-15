// The dashboard's routes for the agents' Claude account profiles (src/claude-profiles.ts, issue #464), on the Machine
// page's Claude account panel:
//
//   POST /api/claude-account/profile-add?profile=<name>   body {"value": "<token from claude setup-token>"}
//   POST /api/machine/claude-profile                      body {"action": "use"|"remove", "profile"}
//
// Each is a machine owner's who is an owner of this instance, on one of the console's allowed devices (the same gate as
// the owner terminal and any machine change), or the owner's break-glass. Every refusal is audited, a request with no
// session's too, and a refused request starts nothing: no token is read, no file written, no machine request recorded.
// The token never reaches an event, the audit, a response or an error: it goes from the body (zeroed after) to a 0400
// file for this coordinator user, which profile-add reads once as root and deletes; a refused request deletes it.
import type { IncomingMessage } from 'node:http';
import { rmSync } from 'node:fs';
import { ClaudeTokenError } from './claude-account.js';
import { PROFILE_NAME, requestFailoverSetting, requestProfileOp, storeLoginCode, storeProfileToken } from './claude-profiles.js';
import type { Role } from './console/asks.js';
import { AskError } from './console/asks.js';
import { readSecretBody } from './console/secrets.js';
import { EventLog } from './events/log.js';
import { MachineRequestError, type MachineRequest } from './machine-requests.js';
import type { MachineRequester } from './machine-owners.js';

export const PROFILE_ADD_PATH = '/api/claude-account/profile-add';
export const PROFILE_PATH = '/api/machine/claude-profile';
/** The one-time code for a relayed sign-in (claude-account.sh login), in a JSON body: {"value": "<code>"}. */
export const LOGIN_CODE_PATH = '/api/claude-account/login-code';
export const isProfileRoute = (path: string) => path === PROFILE_ADD_PATH || path === PROFILE_PATH || path === LOGIN_CODE_PATH;

/** A person the dashboard identified. */
export interface ProfileWho {
  login: string;
  role: Role;
  via: 'session' | 'break-glass';
  deviceOk: boolean;
}

export interface ProfileRouteDeps {
  eventsDb: string;
  instance: string;
  repo: string;
  accountDir: string;
  ownersFile?: string;
  secretsHome?: string;
  /** Records a write by a person (dashboard.audit). */
  audit: (who: ProfileWho, action: string, detail: Record<string, unknown>) => void;
  readBody: (req: IncomingMessage) => Promise<unknown>;
}

export type ProfileRouteResult = { status: number; body: Record<string, unknown> };

/**
 * A request with no person behind it (no session, or one with no role here): refused, and recorded as
 * claude_account.refused with what is known (the login the hub named, if any). Nothing is read from the body.
 */
export function refuseUnidentified(req: IncomingMessage, d: Pick<ProfileRouteDeps, 'eventsDb' | 'instance'>, path: string, id: { status: number; error: string; login?: string }): ProfileRouteResult {
  req.resume();
  const log = new EventLog(d.eventsDb);
  try {
    log.append('claude_account.refused', { path, login: id.login ?? null, status: 403, why: id.error.slice(0, 300) }, id.login ?? 'unknown', 'human');
  } finally {
    log.close();
  }
  return { status: 403, body: { error: id.error } };
}

export async function handleProfileRoute(req: IncomingMessage, url: URL, who: ProfileWho, d: ProfileRouteDeps): Promise<ProfileRouteResult> {
  const requester: MachineRequester = { login: who.login, breakGlass: who.via === 'break-glass', deviceOk: whoDevice(who) };
  const gateWho = { role: who.role, requester };
  const opts = { dir: d.accountDir, ...(d.ownersFile ? { ownersFile: d.ownersFile } : {}) };
  const refuse = (status: number, error: string, detail: Record<string, unknown>) => {
    d.audit(who, 'machine.claude_profile_refused', { ...detail, why: error.slice(0, 300) });
    return { status, body: { error } };
  };
  const record = (args: { action: unknown; profile: unknown; instance?: unknown }, onRefused?: () => void): ProfileRouteResult => {
    const log = new EventLog(d.eventsDb);
    let r: MachineRequest;
    try {
      r = requestProfileOp(log, { ...args, who: gateWho, ...opts });
    } catch (e) {
      onRefused?.();
      if (e instanceof MachineRequestError) return refuse(e.status, e.message, { action: String(args.action).slice(0, 20), profile: String(args.profile).slice(0, 40) });
      throw e;
    } finally {
      log.close();
    }
    d.audit(who, 'machine.claude_profile', { action: r.args[1], profile: r.args[2], instance: r.args[3] ?? null, request: r.id });
    return { status: 200, body: { ok: true, pending: true, request: r } };
  };
  if (url.pathname === LOGIN_CODE_PATH) {
    // The gate before the body is read: a refused request never has its code read or stored.
    if (who.role !== 'owner') {
      req.resume();
      return refuse(403, `only the instance's owners (admin on ${d.repo}) who are machine owners may sign a Claude account in; @${who.login} is a ${who.role}`, { action: 'login-code' });
    }
    try {
      const value = await readSecretBody(req);
      storeLoginCode({ value, instance: d.instance, who: gateWho, dir: d.accountDir, ...(d.secretsHome ? { home: d.secretsHome } : {}), ...(d.ownersFile ? { ownersFile: d.ownersFile } : {}) });
    } catch (e) {
      if (e instanceof ClaudeTokenError || e instanceof AskError) return refuse(e.status, e.message, { action: 'login-code' });
      return refuse(500, "the code couldn't be stored", { action: 'login-code' });
    }
    // Only that it was stored: never the code.
    d.audit(who, 'machine.claude_login_code', { stored: true });
    return { status: 200, body: { ok: true } };
  }
  if (url.pathname === PROFILE_ADD_PATH) {
    const profile = url.searchParams.get('profile') ?? '';
    const named = PROFILE_NAME.test(profile) ? profile : 'not a profile name';
    // The gate before the body is read: a refused request never has its token read or stored.
    if (who.role !== 'owner') {
      req.resume();
      return refuse(403, `only the instance's owners (admin on ${d.repo}) who are machine owners may add a Claude account; @${who.login} is a ${who.role}`, { action: 'profile-add', profile: named });
    }
    let file: string;
    try {
      const value = await readSecretBody(req);
      // storeProfileToken checks the machine owner and the device again, then the token's shape.
      file = storeProfileToken({ value, instance: d.instance, who: gateWho, ...(d.secretsHome ? { home: d.secretsHome } : {}), ...(d.ownersFile ? { ownersFile: d.ownersFile } : {}) });
    } catch (e) {
      if (e instanceof ClaudeTokenError || e instanceof AskError) return refuse(e.status, e.message, { action: 'profile-add', profile: named });
      return refuse(500, "the token couldn't be stored", { action: 'profile-add', profile: named });
    }
    return record({ action: 'profile-add', profile }, () => rmSync(file, { force: true }));
  }
  const body = ((await d.readBody(req)) ?? {}) as { action?: unknown; profile?: unknown; instance?: unknown; order?: unknown; back?: unknown };
  const action = body.action === 'use' || body.action === 'remove' || body.action === 'login' || body.action === 'failover' ? body.action : null;
  if (who.role !== 'owner') return refuse(403, `only the instance's owners (admin on ${d.repo}) who are machine owners may switch or remove a Claude account; @${who.login} is a ${who.role}`, { action: action ?? 'not an action' });
  if (!action) return refuse(400, 'action is use, remove, login or failover (adding one by its token: profile-add)', { action: 'not an action' });
  // Never another instance, nor every one: a dashboard's step is for its own instance (a root admin's otherwise).
  if (body.instance !== undefined && body.instance !== null && body.instance !== d.instance) return refuse(403, `a step from ${d.instance}'s dashboard is for ${d.instance} alone; another instance, or every one, is a root admin's on the machine (claude-account.sh)`, { action });
  if (action === 'failover') {
    const log = new EventLog(d.eventsDb);
    let r: MachineRequest;
    try {
      r = requestFailoverSetting(log, { order: body.order, back: body.back, who: gateWho, ...(d.ownersFile ? { ownersFile: d.ownersFile } : {}) });
    } catch (e) {
      if (e instanceof MachineRequestError) return refuse(e.status, e.message, { action });
      throw e;
    } finally {
      log.close();
    }
    d.audit(who, 'machine.claude_profile', { action, order: r.args[2], back: r.args[3], request: r.id });
    return { status: 200, body: { ok: true, pending: true, request: r } };
  }
  return record({ action, profile: body.profile });
}

/** Only a session's device flag counts; the break-glass passes the machine gate on its own. */
const whoDevice = (who: ProfileWho) => who.via === 'session' && who.deviceOk;
