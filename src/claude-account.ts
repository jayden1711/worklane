// The agents' Claude account, for the machine's owners: which account and expiry each agent user has, and switching
// every agent on the machine to another account. The root half is scripts/setup/claude-account.sh:
//
//   status   each agent user's account (as `claude auth status` names it), whether it is signed in, which token (the
//            first 8 hex digits of its sha256) and when that expires; written to <dir>/status.json
//   switch   pause every instance (its coordinator starts no more runs; the running ones finish), take the token
//            `claude setup-token` prints, wait for the runs (or a timeout), install the token for every agent user
//            (0600, never echoed), check each with `claude auth status` as that user, resume each instance whose
//            users all passed. Each step change is a JSON line in <dir>/switch.jsonl.
//
// From the dashboard (the Machine page's Claude account panel, a machine owner's only), both are machine requests
// (`claude-account status|switch`) that the coordinator runs through the machine helper. switch starts the script as
// its own unit (it stops that coordinator too), so this side follows it by reading switch.jsonl, not the event log.
// The token is pasted here, once the switch asks for it: stored for this coordinator user only (0400, the setup
// console's secrets directory), read once by the script as root, and deleted. It is never in an event, a response,
// a log line or an error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import { installOwnerOnlySecret } from './os/index.js';
import { secretsDir } from './console/secrets.js';
import type { Role } from './console/asks.js';
import { isMachineOwner, MACHINE_OWNERS_FILE, machineChangeRefusal, machineOwners, type MachineRequester } from './machine-owners.js';
import { MachineRequestError, machineRequests, requestMachineChange, type MachineRequest } from './machine-requests.js';
import { varLibPath } from './os/system-paths.js';

/** Where claude-account.sh writes status.json, switch.jsonl and paused (root's, 0644; lib.sh's CLAUDE_ACCOUNT_DIR). */
export const CLAUDE_ACCOUNT_DIR = varLibPath('claude-account');
/** The pasted token's file in this instance's secrets directory (lib.sh's CLAUDE_ACCOUNT_CREDENTIAL). */
export const CLAUDE_ACCOUNT_CREDENTIAL = 'claude-account-token';
/** A token from `claude setup-token` (lib.sh's claude_token_ok, install_claude_token's check). */
export const SETUP_TOKEN = /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}$/;
/** A switch with no new line for this long has stopped (its unit ended without a last line): the longest a step waits is 30 minutes. */
export const SWITCH_STALE_MS = 90 * 60_000;

export const CLAUDE_ACCOUNT_ACTIONS = ['status', 'switch'] as const;
export type ClaudeAccountAction = (typeof CLAUDE_ACCOUNT_ACTIONS)[number];

/** One agent user, as status.json has it. */
export interface AccountUser {
  instance: string;
  /** agent (the instance's agent user, which channel chat runs as too) or eval. */
  kind: string;
  user: string;
  /** Whether a Claude login is stored in its credentials file. */
  stored: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  /** The account's email, as claude auth status names it (none for some logins). */
  account: string | null;
  org: string | null;
  subscription: string | null;
  /** The first 8 hex digits of the stored token's sha256: the same login shows the same id. */
  tokenId: string | null;
  expiresAt: string | null;
  installedAt: string | null;
  error: string | null;
  /**
   * Whether the API took the login on one minimal real call as that user (issue #463: claude auth status says a
   * credential is configured, not that it works); null when no call was made (signed out, or an older record).
   */
  apiOk: boolean | null;
  /** What Claude said when the API refused it (redacted by the script), else null. */
  apiError: string | null;
}

export interface AccountStatus {
  at: string;
  users: AccountUser[];
}

export type SwitchStep = 'switch' | 'pause' | 'token' | 'wait' | 'install' | 'check' | 'resume';
export type SwitchState = 'started' | 'done' | 'failed' | 'ask' | 'skipped';
const STEPS: readonly string[] = ['switch', 'pause', 'token', 'wait', 'install', 'check', 'resume'];
const STATES: readonly string[] = ['started', 'done', 'failed', 'ask', 'skipped'];

export interface SwitchLine {
  at: string;
  step: SwitchStep;
  state: SwitchState;
  instance: string | null;
  user: string | null;
  detail: string;
}

/** One instance through the switch: each phase's last line, and each user's install and check. */
export interface SwitchInstance {
  name: string;
  pause: SwitchLine | null;
  wait: SwitchLine | null;
  users: { user: string; install: SwitchLine | null; check: SwitchLine | null }[];
  /** A check line for the instance as a whole (no agent user found). */
  check: SwitchLine | null;
  resume: SwitchLine | null;
}

export interface SwitchView {
  startedAt: string;
  /** running; done or failed (its last line); stalled: no line for SWITCH_STALE_MS and no end. */
  status: 'running' | 'done' | 'failed' | 'stalled';
  /** Its last switch line's detail (how it ended, or what it is doing). */
  detail: string;
  /** Where the token comes from: this instance's dashboard (its name), or a terminal (null). */
  tokenFrom: string | null;
  /** Waiting for the token: an ask line and nothing after it on the token step. */
  waitingForToken: boolean;
  token: SwitchLine | null;
  instances: SwitchInstance[];
  lines: SwitchLine[];
}

const str = (v: unknown, max = 1000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** status.json, or null when there is none yet (or it can't be read). */
export function readAccountStatus(dir = CLAUDE_ACCOUNT_DIR): AccountStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
  const o = raw as { at?: unknown; users?: unknown };
  if (!o || typeof o !== 'object' || !Array.isArray(o.users)) return null;
  const users = o.users
    .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object' && typeof (u as { user?: unknown }).user === 'string' && typeof (u as { instance?: unknown }).instance === 'string')
    .map((u) => ({
      instance: str(u.instance, 40)!,
      kind: str(u.kind, 20) ?? 'agent',
      user: str(u.user, 40)!,
      stored: u.stored === true,
      loggedIn: u.logged_in === true,
      authMethod: str(u.auth_method, 100),
      account: str(u.account, 200),
      org: str(u.org, 200),
      subscription: str(u.subscription, 100),
      tokenId: typeof u.token_id === 'string' && /^[0-9a-f]{8}$/.test(u.token_id) ? u.token_id : null,
      expiresAt: str(u.expires_at, 40),
      installedAt: str(u.installed_at, 40),
      error: str(u.error, 300),
      apiOk: typeof u.api_ok === 'boolean' ? u.api_ok : null,
      apiError: str(u.api_error, 500),
    }));
  return { at: str(o.at, 40) ?? '', users };
}

/** The progress lines of the last switch (switch.jsonl); torn or foreign lines are skipped. */
export function readSwitchLines(dir = CLAUDE_ACCOUNT_DIR): SwitchLine[] {
  let text: string;
  try {
    text = readFileSync(join(dir, 'switch.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: SwitchLine[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      if (!STEPS.includes(j.step as string) || !STATES.includes(j.state as string) || typeof j.at !== 'string') continue;
      out.push({ at: j.at, step: j.step as SwitchStep, state: j.state as SwitchState, instance: str(j.instance, 40), user: str(j.user, 40), detail: str(j.detail) ?? '' });
    } catch {
      // a torn line (being written) or not ours
    }
  }
  return out;
}

/**
 * When the last switch put this instance on the new login and started it again: its resume line's time, else null.
 * All of: a token was received (not "checked on its current login"), every one of the instance's agent users had it
 * installed and passed the auth check, and the instance was resumed. Its usage-limit pause then ends (the old
 * account's limit no longer applies); an instance whose check failed stays paused.
 */
export function switchedOnto(instance: string, lines: readonly SwitchLine[] = readSwitchLines()): string | null {
  const v = switchView(lines);
  const i = v?.instances.find((x) => x.name === instance);
  if (!v || !i || v.token?.state !== 'done' || i.resume?.state !== 'done' || i.check?.state === 'failed') return null;
  if (i.users.length === 0 || !i.users.every((u) => u.install?.state === 'done' && u.check?.state === 'done')) return null;
  return i.resume.at;
}

/** The last switch, folded per instance and user in the script's order; null when there has been none. */
export function switchView(lines: readonly SwitchLine[], now = Date.now()): SwitchView | null {
  const start = lines.findIndex((l) => l.step === 'switch' && l.state === 'started');
  if (start < 0) return null;
  const ls = lines.slice(start);
  const byName = new Map<string, SwitchInstance>();
  const inst = (name: string) => {
    let i = byName.get(name);
    if (!i) byName.set(name, (i = { name, pause: null, wait: null, users: [], check: null, resume: null }));
    return i;
  };
  let token: SwitchLine | null = null;
  for (const l of ls) {
    if (l.step === 'token') token = l;
    if (!l.instance) continue;
    const i = inst(l.instance);
    if (l.step === 'pause') i.pause = l;
    else if (l.step === 'wait') i.wait = l;
    else if (l.step === 'resume') i.resume = l;
    else if ((l.step === 'install' || l.step === 'check') && l.user) {
      let u = i.users.find((x) => x.user === l.user);
      if (!u) i.users.push((u = { user: l.user, install: null, check: null }));
      u[l.step] = l;
    } else if (l.step === 'check') i.check = l;
  }
  const end = [...ls].reverse().find((l) => l.step === 'switch' && (l.state === 'done' || l.state === 'failed')) ?? null;
  const last = ls.at(-1)!;
  const stalled = !end && now - Date.parse(last.at) > SWITCH_STALE_MS;
  const from = /the token from the dashboard of ([a-z][a-z0-9-]{0,20})/.exec(ls[0]!.detail)?.[1] ?? null;
  return {
    startedAt: ls[0]!.at,
    status: end ? (end.state as 'done' | 'failed') : stalled ? 'stalled' : 'running',
    detail: (end ?? ls[0]!).detail,
    tokenFrom: from,
    waitingForToken: !end && !stalled && token?.state === 'ask',
    token,
    instances: [...byName.values()],
    lines: ls,
  };
}

/** Whether this person sees the Claude account panel: a machine owner, or the owner's break-glass. */
export const mayViewClaudeAccount = (r: Pick<MachineRequester, 'login' | 'breakGlass'>, file = MACHINE_OWNERS_FILE) => r.breakGlass || isMachineOwner(r.login, file);

/** Why this person may not refresh or switch now; null when they may (the same gate as any machine change). */
export function claudeAccountGate(who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string } = {}): string | null {
  if (who.role !== 'owner') return `only an owner of this instance who is one of the machine's owners may switch the Claude account; @${who.requester.login} is ${who.role ? `a ${who.role}` : 'not on it'}`;
  return machineChangeRefusal(who.requester, { file: o.ownersFile ?? MACHINE_OWNERS_FILE });
}

const isAccountRequest = (r: MachineRequest) => r.args[0] === 'claude-account';
const open = (r: MachineRequest) => r.status === 'pending' || r.status === 'running';

/** The panel's data: each agent user's account, the last switch, this log's requests, and whether this person may act. */
export function claudeAccountView(o: { dir?: string; events: readonly StoredEvent[]; who: { role: Role | null; requester: MachineRequester }; instance: string; ownersFile?: string; now?: number }) {
  const now = o.now ?? Date.now();
  const why = claudeAccountGate(o.who, o.ownersFile ? { ownersFile: o.ownersFile } : {});
  const sw = switchView(readSwitchLines(o.dir), now);
  const requests = machineRequests(o.events).filter(isAccountRequest);
  const busy = sw?.status === 'running' ? 'a switch is running' : requests.some((r) => open(r) && r.args[1] === 'switch') ? 'a switch is waiting for the coordinator' : null;
  return {
    machineOwner: mayViewClaudeAccount(o.who.requester, o.ownersFile),
    machineOwners: machineOwners(o.ownersFile ?? MACHINE_OWNERS_FILE),
    login: o.who.requester.login,
    instance: o.instance,
    allowed: why === null,
    why,
    canSwitch: why === null && !busy,
    busy,
    /** Whether this person may paste the token here now: the switch is waiting for it, from this instance. */
    canPasteToken: why === null && !!sw?.waitingForToken && sw.tokenFrom === o.instance,
    status: readAccountStatus(o.dir),
    switch: sw,
    requests: requests.slice(-10).reverse(),
  };
}

export type ClaudeAccountData = ReturnType<typeof claudeAccountView>;

/**
 * Record `claude-account status|switch` for the coordinator to run through the machine helper: the same gate as any
 * machine change (src/machine-requests.ts), and one switch at a time (none waiting for the coordinator, none running).
 */
export function requestClaudeAccount(log: EventLog, r: { action: unknown; requester: MachineRequester; dir?: string; ownersFile?: string; now?: number }): MachineRequest {
  if (!(CLAUDE_ACCOUNT_ACTIONS as readonly unknown[]).includes(r.action)) throw new MachineRequestError('action is status or switch');
  const action = r.action as ClaudeAccountAction;
  const pending = machineRequests(log.read(0, ['machine.requested', 'machine.started', 'machine.finished'])).find((x) => isAccountRequest(x) && open(x) && x.args[1] === action);
  if (pending) throw new MachineRequestError(`a claude-account ${action} is already ${pending.status === 'pending' ? 'waiting for the coordinator' : 'running'}`, 409);
  if (action === 'switch' && switchView(readSwitchLines(r.dir), r.now)?.status === 'running') throw new MachineRequestError('a Claude account switch is running on this machine; wait for it to end', 409);
  return requestMachineChange(log, { args: ['claude-account', action], requester: r.requester, via: 'claude-account', ...(r.ownersFile ? { ownersFile: r.ownersFile } : {}) });
}

export class ClaudeTokenError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(message);
  }
}

/**
 * Store the pasted token for the running switch: only while it waits for one from this instance, only a token from
 * claude setup-token, for this coordinator user only (0400). Every error is a fixed text: never the value.
 * Returns the file's path.
 */
export function storeSwitchToken(o: { value: string; instance: string; who: { role: Role | null; requester: MachineRequester }; dir?: string; home?: string; ownersFile?: string; now?: number }): string {
  const why = claudeAccountGate(o.who, o.ownersFile ? { ownersFile: o.ownersFile } : {});
  if (why) throw new ClaudeTokenError(why, 403);
  const sw = switchView(readSwitchLines(o.dir), o.now);
  if (!sw || !sw.waitingForToken) throw new ClaudeTokenError('no Claude account switch is waiting for a token', 409);
  if (sw.tokenFrom !== o.instance) throw new ClaudeTokenError(`the switch takes its token from ${sw.tokenFrom ? `${sw.tokenFrom}'s dashboard` : 'the terminal it was started in'}, not this one`, 409);
  const value = o.value.trim();
  if (!SETUP_TOKEN.test(value)) throw new ClaudeTokenError('that is not a token from claude setup-token (it starts sk-ant-oat01-); nothing stored');
  try {
    return installOwnerOnlySecret(secretsDir(o.instance, o.home), CLAUDE_ACCOUNT_CREDENTIAL, value);
  } catch (e) {
    // The OS error names the path, never the value; keep its first line.
    throw new ClaudeTokenError(`couldn't store the token: ${String((e as Error).message).split('\n')[0]}`);
  }
}
