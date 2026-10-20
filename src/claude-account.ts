// The agents' Claude account, for the machine's owners: which account and expiry each agent user has. The root half
// is scripts/setup/claude-account.sh:
//
//   status     each agent user's account (as `claude auth status` names it), whether it is signed in, which token
//              (the first 8 hex digits of its sha256) and when that expires; written to <dir>/status.json
//   uninstall  removes what the account profiles, failover and the account switch left (issue #736: all three were
//              removed; src/claude-accounts-retired.ts)
//
// The engine manages no Claude account (#736): one person signs an instance's agent user in to `claude` themselves,
// as that user, through Anthropic's own flow, or the instance uses an API key. From the dashboard (the Machine page's
// Claude account panel, a machine owner's only), status is a machine request (`claude-account status`) that the
// coordinator runs through the machine helper. Nothing here takes a Claude credential (issue #711, docs/auth.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import type { Role } from './console/asks.js';
import { retiredView, signinCommand } from './claude-accounts-retired.js';
import { isMachineOwner, MACHINE_OWNERS_FILE, machineChangeRefusal, machineOwners, type MachineRequester } from './machine-owners.js';
import { MachineRequestError, machineRequests, requestMachineChange, type MachineRequest } from './machine-requests.js';
import { varLibPath } from './os/system-paths.js';

/** Where claude-account.sh writes status.json (root's, 0644; lib.sh's CLAUDE_ACCOUNT_DIR). */
export const CLAUDE_ACCOUNT_DIR = varLibPath('claude-account');

/** What a dashboard may ask for: status only. */
export const CLAUDE_ACCOUNT_ACTIONS = ['status'] as const;
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

/**
 * Whether an instance's agents have a Claude account set: all that anyone the accounts panel refuses learns of them
 * (issue #567: a viewer or a writer gets no email, plan or profile name). Whether claude-account.sh last found the
 * instance's agent user signed in; null when nothing on the machine says (no status record for it yet). A profile an
 * older engine left counts for nothing (#736).
 */
export function accountSet(instance: string, dir = CLAUDE_ACCOUNT_DIR): boolean | null {
  const rec = readAccountStatus(dir)?.users.find((u) => u.instance === instance && u.kind === 'agent');
  return rec ? rec.loggedIn : null;
}

/** Whether this person sees the Claude account panel: a machine owner, or the owner's break-glass. */
export const mayViewClaudeAccount = (r: Pick<MachineRequester, 'login' | 'breakGlass'>, file = MACHINE_OWNERS_FILE) => r.breakGlass || isMachineOwner(r.login, file);

/** Why this person may not refresh now; null when they may (the same gate as any machine change). */
export function claudeAccountGate(who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string } = {}): string | null {
  if (who.role !== 'owner') return `only an owner of this instance who is one of the machine's owners may refresh the Claude account; @${who.requester.login} is ${who.role ? `a ${who.role}` : 'not on it'}`;
  return machineChangeRefusal(who.requester, { file: o.ownersFile ?? MACHINE_OWNERS_FILE });
}

const isAccountRequest = (r: MachineRequest) => r.args[0] === 'claude-account';
const open = (r: MachineRequest) => r.status === 'pending' || r.status === 'running';

/**
 * The panel's data: each agent user's account, this log's requests, whether this person may act, how an agent user is
 * signed in now, and what the removed account profiles left on the machine (#736), with the root step that removes it.
 */
export function claudeAccountView(o: { dir?: string; events: readonly StoredEvent[]; who: { role: Role | null; requester: MachineRequester }; instance: string; ownersFile?: string }) {
  const why = claudeAccountGate(o.who, o.ownersFile ? { ownersFile: o.ownersFile } : {});
  const requests = machineRequests(o.events).filter(isAccountRequest);
  return {
    machineOwner: mayViewClaudeAccount(o.who.requester, o.ownersFile),
    machineOwners: machineOwners(o.ownersFile ?? MACHINE_OWNERS_FILE),
    login: o.who.requester.login,
    instance: o.instance,
    allowed: why === null,
    why,
    status: readAccountStatus(o.dir),
    requests: requests.slice(-10).reverse(),
    /** How a person signs an agent user in to claude: as that user, on the machine, through Anthropic's own flow. */
    signin: signinCommand(),
    retired: retiredView(o.dir),
  };
}

export type ClaudeAccountData = ReturnType<typeof claudeAccountView>;

/**
 * Record `claude-account status` for the coordinator to run through the machine helper: the same gate as any machine
 * change (src/machine-requests.ts), one at a time.
 */
export function requestClaudeAccount(log: EventLog, r: { action: unknown; requester: MachineRequester; ownersFile?: string }): MachineRequest {
  if (!(CLAUDE_ACCOUNT_ACTIONS as readonly unknown[]).includes(r.action)) throw new MachineRequestError('action is status; the engine manages no Claude account (#736): sign an agent user in as that user, on the machine');
  const action = r.action as ClaudeAccountAction;
  const pending = machineRequests(log.read(0, ['machine.requested', 'machine.started', 'machine.finished'])).find((x) => isAccountRequest(x) && open(x) && x.args[1] === action);
  if (pending) throw new MachineRequestError(`a claude-account ${action} is already ${pending.status === 'pending' ? 'waiting for the coordinator' : 'running'}`, 409);
  return requestMachineChange(log, { args: ['claude-account', action], requester: r.requester, via: 'claude-account', ...(r.ownersFile ? { ownersFile: r.ownersFile } : {}) });
}
