// The agents' Claude account profiles (issue #464): several Claude accounts side by side for each instance's agent
// user, each in its own CLAUDE_CONFIG_DIR, <agent home>/.claude-profiles/<profile> (0700, that user's own). The login
// the agent user always had (~/.claude, or instance.yaml's claude_config_dir) is the profile named `default`.
//
// The root half is scripts/setup/claude-account.sh (profile-add, use, remove), run from the dashboard through the
// machine helper as its own unit. It writes, root's and 0644, in the claude-account dir:
//   profiles.json       each profile, each agent user's last real call on it (account and plan as Claude names them,
//                       whether the API answered), and which profile each instance's runs use ("active")
//   profile-ops.jsonl   each step of each profile-add, use and remove
// Never a token: the token goes from the dashboard's 0400 file (or stdin) into each agent user's own profile dir.
//
// The engine reads "active" when each run starts (resolveLogin): a switch needs no pause, and a run already going
// finishes on the login it started on. A profile becomes active only after a minimal real call as every agent user it
// is for was answered on it; a refused call changes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Role } from './console/asks.js';
import { installOwnerOnlySecret } from './os/index.js';
import { secretsDir } from './console/secrets.js';
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import { CLAUDE_ACCOUNT_DIR, claudeAccountGate, readAccountStatus, SETUP_TOKEN, ClaudeTokenError } from './claude-account.js';
import { MachineRequestError, machineRequests, requestMachineChange, type MachineRequest } from './machine-requests.js';
import type { MachineRequester } from './machine-owners.js';
import type { RunAs } from './runner.js';
import { asRoot } from './os/system-paths.js';

/** The root script, as an admin runs it on the machine (confirm-profile, and every instance's steps). */
export const CLAUDE_ACCOUNT_SCRIPT = asRoot.opt('current/scripts/setup/claude-account.sh');
/** The login each agent user always had: never added or removed, always there to go back to. */
export const DEFAULT_PROFILE = 'default';
/** A profile's name (claude-account.sh and the machine helper check the same). */
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,20}$/;
/** Where an agent user's profiles live, under its home. */
export const PROFILES_DIRNAME = '.claude-profiles';
/** The new profile's token in the asking instance's secrets dir (lib.sh's CLAUDE_PROFILE_CREDENTIAL). */
export const CLAUDE_PROFILE_CREDENTIAL = 'claude-profile-token';
/** A relayed sign-in's one-time code in the asking instance's secrets dir (lib.sh's CLAUDE_LOGIN_CREDENTIAL). */
export const CLAUDE_LOGIN_CREDENTIAL = 'claude-login-code';
/** The code Anthropic's sign-in page shows to paste (claude-account.sh login checks the same shape). */
export const LOGIN_CODE = /^[A-Za-z0-9_-]{8,}(#[A-Za-z0-9_-]{8,})?$/;
/** A profile step with no new line for this long has stopped (its unit ended without a last line). */
export const PROFILE_OP_STALE_MS = 30 * 60_000;

export const PROFILE_ACTIONS = ['profile-add', 'use', 'remove', 'login'] as const;
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];

/** One agent user's last real call on a profile. */
export interface ProfileCheck {
  instance: string;
  user: string;
  /** The account's email, as `claude auth status` names it on that profile. */
  account: string | null;
  subscription: string | null;
  apiOk: boolean;
  apiError: string | null;
  checkedAt: string | null;
}

export interface Profiles {
  /**
   * Each profile. `staged`: added from a dashboard and not yet confirmed by a root admin on the machine (claude-account.sh
   * confirm-profile): nothing may use it. `instance`: the instance whose dashboard added it, if one did.
   */
  profiles: Record<string, { kind: string; addedAt: string | null; users: Record<string, ProfileCheck>; staged: boolean; instance: string | null }>;
  /** Each instance's active profile; an instance not named is on default. */
  active: Record<string, { profile: string; since: string }>;
  /** When each instance last switched profile (to default too). */
  switchedAt: Record<string, string>;
  /** Auto-failover on a usage limit: machine-wide, and per instance (which overrides it; an empty order is off). */
  failover: { machine: FailoverSetting | null; instances: Record<string, FailoverSetting> };
}

/** The order of profiles to move through on a usage limit, and whether to move back after its reset. */
export interface FailoverSetting {
  order: string[];
  back: boolean;
}

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const isInstance = (s: string) => /^[a-z][a-z0-9-]{0,20}$/.test(s);
const empty = (): Profiles => ({ profiles: {}, active: {}, switchedAt: {}, failover: { machine: null, instances: {} } });
const failoverOf = (v: unknown): FailoverSetting | null => {
  const o = v as { order?: unknown; back?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.order)) return null;
  const order = o.order.filter((n): n is string => typeof n === 'string' && PROFILE_NAME.test(n)).slice(0, 8);
  return { order: [...new Set(order)], back: o.back === true };
};

/** profiles.json, or no profiles when there is none (or it can't be read). Anything not of its shape is left out. */
export function readProfiles(dir = CLAUDE_ACCOUNT_DIR): Profiles {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
  } catch {
    return empty();
  }
  const o = (raw ?? {}) as { profiles?: unknown; active?: unknown; switched_at?: unknown; failover?: unknown };
  const out = empty();
  if (o.profiles && typeof o.profiles === 'object') {
    for (const [name, p] of Object.entries(o.profiles as Record<string, unknown>)) {
      if (!PROFILE_NAME.test(name) || !p || typeof p !== 'object') continue;
      const x = p as { kind?: unknown; added_at?: unknown; users?: unknown; staged?: unknown; instance?: unknown };
      const users: Record<string, ProfileCheck> = {};
      for (const [user, r] of Object.entries((x.users && typeof x.users === 'object' ? x.users : {}) as Record<string, unknown>)) {
        if (!r || typeof r !== 'object') continue;
        const c = r as Record<string, unknown>;
        users[user] = { instance: str(c.instance, 40) ?? '', user, account: str(c.account, 200), subscription: str(c.subscription, 100), apiOk: c.api_ok === true, apiError: str(c.api_error), checkedAt: str(c.checked_at, 40) };
      }
      out.profiles[name] = { kind: str(x.kind, 40) ?? 'unknown', addedAt: str(x.added_at, 40), users, staged: x.staged === true, instance: typeof x.instance === 'string' && isInstance(x.instance) ? x.instance : null };
    }
  }
  if (o.active && typeof o.active === 'object') {
    for (const [inst, a] of Object.entries(o.active as Record<string, unknown>)) {
      const p = (a as { profile?: unknown; since?: unknown } | null)?.profile;
      if (isInstance(inst) && typeof p === 'string' && PROFILE_NAME.test(p) && p !== DEFAULT_PROFILE) out.active[inst] = { profile: p, since: str((a as { since?: unknown }).since, 40) ?? '' };
    }
  }
  const f = (o.failover ?? {}) as { machine?: unknown; instances?: unknown };
  out.failover.machine = failoverOf(f.machine);
  if (f.instances && typeof f.instances === 'object') {
    for (const [inst, v] of Object.entries(f.instances as Record<string, unknown>)) {
      const x = failoverOf(v);
      if (isInstance(inst) && x) out.failover.instances[inst] = x;
    }
  }
  if (o.switched_at && typeof o.switched_at === 'object') {
    for (const [inst, at] of Object.entries(o.switched_at as Record<string, unknown>)) if (isInstance(inst) && typeof at === 'string') out.switchedAt[inst] = at.slice(0, 40);
  }
  return out;
}

/** An instance's failover setting in force: its own, else the machine's; null when off (no order of two or more). */
export function failoverFor(instance: string, p: Profiles = readProfiles()): FailoverSetting | null {
  const f = p.failover.instances[instance] ?? p.failover.machine;
  if (!f) return null;
  // A staged profile (not confirmed by a root admin) is never moved to, whatever the order says.
  const order = f.order.filter((n) => n === DEFAULT_PROFILE || (p.profiles[n] && !p.profiles[n]!.staged));
  return order.length >= 2 ? { ...f, order } : null;
}

/** The profile an instance's runs use now. */
export function activeProfile(instance: string, p: Profiles = readProfiles()): string {
  const name = p.active[instance]?.profile;
  // A staged profile is never used, whatever the file says (the script never makes one active; this holds if it did).
  return name && p.profiles[name] && !p.profiles[name]!.staged ? name : DEFAULT_PROFILE;
}

/** A user's default login dir (as runs always had it). */
const defaultDir = (r: RunAs) => r.claudeConfigDir ?? posix.join(r.home, '.claude');
/** A profile's dir for this agent user. */
export const profileDir = (r: RunAs, profile: string): string => (profile === DEFAULT_PROFILE ? defaultDir(r) : posix.join(r.home, PROFILES_DIRNAME, profile));

/**
 * The login a run as this user uses: the instance's active profile's dir, for its agent user only (the eval user's
 * lane keeps its own login). `agentUser`: the instance's agent user. Read when each run starts.
 */
export function resolveLogin(r: RunAs, o: { instance: string; agentUser: string; dir?: string }): RunAs {
  if (r.user !== o.agentUser) return r;
  const profile = activeProfile(o.instance, readProfiles(o.dir));
  return profile === DEFAULT_PROFILE ? r : { ...r, claudeConfigDir: profileDir(r, profile) };
}

/**
 * Every profile's credentials file for this user, default's too: what no agent command may read, whichever profile it
 * runs on. Its own login is not something an agent needs to read, and another account's never is.
 */
export function profileCredentialFiles(r: RunAs, p: Profiles): string[] {
  return [...new Set([DEFAULT_PROFILE, ...Object.keys(p.profiles)].map((n) => posix.join(profileDir(r, n), '.credentials.json')))];
}

/**
 * The runner's login hook for an instance (src/runner.ts CliRunner's `login`): each run's user on its active profile,
 * and every profile's credentials file for that user, for its commands' deny list. Profiles apply to the instance's
 * agent user only.
 */
export function profileLogin(o: { instance: string; agentUser: string; dir?: string }) {
  return {
    resolve: (r: RunAs) => resolveLogin(r, o),
    credentialFiles: (r: RunAs) => (r.user === o.agentUser ? profileCredentialFiles(r, readProfiles(o.dir)) : []),
  };
}

/** One line of profile-ops.jsonl. */
export interface ProfileOpLine {
  at: string;
  id: string;
  op: string;
  profile: string;
  step: string;
  state: string;
  instance: string | null;
  user: string | null;
  for: string | null;
  detail: string;
}

/** One profile-add, use or remove, folded from its lines. */
export interface ProfileOp {
  id: string;
  op: string;
  profile: string;
  /** The instance whose dashboard asked (null: a terminal). */
  for: string | null;
  status: 'running' | 'done' | 'failed' | 'stalled';
  startedAt: string;
  endedAt: string | null;
  /** Its last line's detail (how it ended, or what it is doing). */
  detail: string;
  /** A finished use: each instance's profile before it. */
  from: Record<string, string> | null;
  /** Each agent user's install, check and remove line, in order. */
  steps: { step: string; state: string; instance: string | null; user: string | null; detail: string }[];
}

/** Every profile step in profile-ops.jsonl, oldest first; torn or foreign lines are skipped. */
export function readProfileOps(dir = CLAUDE_ACCOUNT_DIR, now = Date.now()): ProfileOp[] {
  let text: string;
  try {
    text = readFileSync(join(dir, 'profile-ops.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const ops = new Map<string, ProfileOp>();
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(l) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = str(j.id, 80), op = str(j.op, 20), profile = str(j.profile, 40), step = str(j.step, 20), state = str(j.state, 20), at = str(j.at, 40);
    if (!id || !op || !(PROFILE_ACTIONS as readonly string[]).includes(op) || !profile || !step || !state || !at) continue;
    const line = { step, state, instance: str(j.instance, 40), user: str(j.user, 40), detail: str(j.detail, 1000) ?? '' };
    let o = ops.get(id);
    if (!o) ops.set(id, (o = { id, op, profile, for: str(j.for, 40), status: 'running', startedAt: at, endedAt: null, detail: line.detail, from: null, steps: [] }));
    o.detail = line.detail;
    if (step === op && (state === 'done' || state === 'failed')) {
      o.status = state;
      o.endedAt = at;
      if (j.from && typeof j.from === 'object') o.from = Object.fromEntries(Object.entries(j.from as Record<string, unknown>).filter((kv): kv is [string, string] => isInstance(kv[0]) && typeof kv[1] === 'string' && PROFILE_NAME.test(kv[1])));
    } else if (step !== op) o.steps.push(line);
    (o as ProfileOp & { lastAt?: string }).lastAt = at;
  }
  return [...ops.values()].map((o) => {
    const { lastAt, ...rest } = o as ProfileOp & { lastAt?: string };
    return rest.status === 'running' && lastAt && now - Date.parse(lastAt) > PROFILE_OP_STALE_MS ? { ...rest, status: 'stalled' as const } : rest;
  });
}

/** When this instance last switched profile, or null: a switch ends its usage-limit pause, and rechecks a held login. */
export const profileSwitchedAt = (instance: string, dir = CLAUDE_ACCOUNT_DIR): string | null => readProfiles(dir).switchedAt[instance] ?? null;

/** The later of two switch times (either may be null): an account switch, or a profile switch. */
export function latestSwitch(a: string | null, b: string | null): string | null {
  if (a === null || Number.isNaN(Date.parse(a))) return b;
  if (b === null || Number.isNaN(Date.parse(b))) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** The accounts × instances table: for each profile, each instance's agent user's last real call on it, and which is active. */
export function profilesTable(o: { dir?: string; instances?: string[] }) {
  const failover = readProfiles(o.dir).failover;
  const p = readProfiles(o.dir);
  const status = readAccountStatus(o.dir);
  // The instances: every one status.json has an agent user for, and every one with an active profile.
  const agents = new Map<string, string>();
  for (const u of status?.users ?? []) if (u.kind === 'agent') agents.set(u.instance, u.user);
  for (const prof of Object.values(p.profiles)) for (const c of Object.values(prof.users)) if (c.instance && !agents.has(c.instance)) agents.set(c.instance, c.user);
  const instances = [...new Set([...(o.instances ?? []), ...agents.keys(), ...Object.keys(p.active)])].filter(isInstance).sort();
  const names = [DEFAULT_PROFILE, ...Object.keys(p.profiles).filter((n) => n !== DEFAULT_PROFILE).sort()];
  const rows = names.map((name) => {
    const prof = p.profiles[name];
    return {
      name,
      kind: name === DEFAULT_PROFILE ? 'existing' : (prof?.kind ?? 'unknown'),
      staged: prof?.staged === true,
      /** The instance whose dashboard added it (only that instance's agent user has it), or null for a root admin's. */
      addedFor: prof?.instance ?? null,
      addedAt: prof?.addedAt ?? null,
      cells: instances.map((instance) => {
        const user = agents.get(instance) ?? null;
        const check = user ? (prof?.users[user] ?? null) : null;
        // default's account comes from status.json when no profile check has run on it yet.
        const st = name === DEFAULT_PROFILE && !check ? (status?.users.find((u) => u.instance === instance && u.kind === 'agent') ?? null) : null;
        return {
          instance,
          user,
          active: activeProfile(instance, p) === name,
          account: check?.account ?? st?.account ?? null,
          subscription: check?.subscription ?? st?.subscription ?? null,
          apiOk: check ? check.apiOk : (st?.apiOk ?? null),
          apiError: check ? check.apiError : (st?.apiError ?? null),
          checkedAt: check?.checkedAt ?? (st ? status!.at : null),
        };
      }),
    };
  });
  return { instances, profiles: rows, active: Object.fromEntries(instances.map((i) => [i, activeProfile(i, p)])), failover };
}

export type ProfilesTable = ReturnType<typeof profilesTable>;

const isAccountRequest = (r: MachineRequest) => r.args[0] === 'claude-account';
const open = (r: MachineRequest) => r.status === 'pending' || r.status === 'running';

/**
 * Record the failover setting for the coordinator to run through the machine helper (`claude-account failover
 * <order|off> back|stay`), for this dashboard's own instance: the same gate as a profile step. `order`: two to eight profiles, or null (off).
 */
export function requestFailoverSetting(log: EventLog, r: { order: unknown; back: unknown; who: { role: Role | null; requester: MachineRequester }; ownersFile?: string }): MachineRequest {
  const why = claudeAccountGate(r.who, r.ownersFile ? { ownersFile: r.ownersFile } : {});
  if (why) throw new MachineRequestError(why, 403);
  const off = r.order === null;
  const order = Array.isArray(r.order) ? r.order : [];
  if (!off && (order.length < 2 || order.length > 8 || !order.every((n) => typeof n === 'string' && PROFILE_NAME.test(n)) || new Set(order).size !== order.length)) throw new MachineRequestError('a failover order is two to eight different profiles (or null: off)');
  if (typeof r.back !== 'boolean') throw new MachineRequestError('back is true (move back after the reset) or false');
  const pending = machineRequests(log.read(0, ['machine.requested', 'machine.started', 'machine.finished'])).find((x) => isAccountRequest(x) && open(x));
  if (pending) throw new MachineRequestError(`a claude-account ${pending.args.slice(1).join(' ')} is already ${pending.status === 'pending' ? 'waiting for the coordinator' : 'running'}`, 409);
  // Never an instance: the helper takes the asking coordinator's from sudo; the machine-wide setting is a root admin's.
  const args = ['claude-account', 'failover', off ? 'off' : (order as string[]).join('+'), r.back ? 'back' : 'stay'];
  return requestMachineChange(log, { args, requester: r.who.requester, via: 'claude-account', ...(r.ownersFile ? { ownersFile: r.ownersFile } : {}) });
}

/**
 * Record a profile step for the coordinator to run through the machine helper: the same gate as any machine change
 * (a machine owner, on an allowed device, or the break-glass), the instance's owner role, one profile step or switch
 * at a time. Never runs anything.
 */
export function requestProfileOp(log: EventLog, r: { action: unknown; profile: unknown; who: { role: Role | null; requester: MachineRequester }; dir?: string; ownersFile?: string; now?: number }): MachineRequest {
  const why = claudeAccountGate(r.who, r.ownersFile ? { ownersFile: r.ownersFile } : {});
  if (why) throw new MachineRequestError(why, 403);
  if (!(PROFILE_ACTIONS as readonly unknown[]).includes(r.action)) throw new MachineRequestError('action is profile-add, login, use or remove');
  const action = r.action as ProfileAction;
  if (typeof r.profile !== 'string' || !PROFILE_NAME.test(r.profile)) throw new MachineRequestError("a profile's name: lowercase letters, digits and dashes, starting with a letter, at most 21");
  if (action !== 'use' && r.profile === DEFAULT_PROFILE) throw new MachineRequestError('default is the login each agent user already has: it is never added, signed in or removed');
  const pending = machineRequests(log.read(0, ['machine.requested', 'machine.started', 'machine.finished'])).find((x) => isAccountRequest(x) && open(x));
  if (pending) throw new MachineRequestError(`a claude-account ${pending.args.slice(1).join(' ')} is already ${pending.status === 'pending' ? 'waiting for the coordinator' : 'running'}`, 409);
  if (readProfileOps(r.dir, r.now).some((o) => o.status === 'running')) throw new MachineRequestError('a Claude account profile change is running on this machine; wait for it to end', 409);
  // Never an instance: each step is for this dashboard's own instance, which the helper takes from sudo (SUDO_USER).
  const args = ['claude-account', action, r.profile];
  return requestMachineChange(log, { args, requester: r.who.requester, via: 'claude-account', ...(r.ownersFile ? { ownersFile: r.ownersFile } : {}) });
}

/**
 * Store a new profile's token for this coordinator user only (0400), for profile-add to read once as root and delete.
 * Only a machine owner who may act here, only a token from claude setup-token. Every error is a fixed text: never the
 * value. Returns the file's path.
 */
export function storeProfileToken(o: { value: unknown; instance: string; who: { role: Role | null; requester: MachineRequester }; home?: string; ownersFile?: string }): string {
  const why = claudeAccountGate(o.who, o.ownersFile ? { ownersFile: o.ownersFile } : {});
  if (why) throw new ClaudeTokenError(why, 403);
  const value = typeof o.value === 'string' ? o.value.trim() : '';
  if (!SETUP_TOKEN.test(value)) throw new ClaudeTokenError('that is not a token from claude setup-token (it starts sk-ant-oat01-); nothing stored');
  try {
    return installOwnerOnlySecret(secretsDir(o.instance, o.home), CLAUDE_PROFILE_CREDENTIAL, value);
  } catch (e) {
    throw new ClaudeTokenError(`couldn't store the token: ${String((e as Error).message).split('\n')[0]}`);
  }
}

/**
 * The account.switched records this instance's log still needs: each finished `use` its dashboard asked for (the
 * op's `for`), not yet recorded (by op id). `by` is who asked, from the machine request it came from.
 */
export function unrecordedSwitches(events: readonly StoredEvent[], ops: readonly ProfileOp[], instance: string) {
  const recorded = new Set(events.filter((e) => e.type === 'account.switched').map((e) => (e.payload as { op: string }).op));
  const asked = machineRequests(events).filter((r) => r.args[0] === 'claude-account' && r.args[1] === 'use');
  // The coordinator's own moves (src/claude-failover.ts): asked for in the log before the step started.
  const failovers = events.filter((e) => e.type === 'account.failover' && ['asked', 'back-asked'].includes((e.payload as { stage: string }).stage));
  return ops
    .filter((o) => o.op === 'use' && o.for === instance && (o.status === 'done' || o.status === 'failed') && !recorded.has(o.id))
    .map((o) => {
      const before = (at: string) => Date.parse(at) <= Date.parse(o.startedAt) + 1000;
      // Who asked: the latest request for this profile before the step, a person's from the dashboard or the failover's.
      const req = [...asked].reverse().find((r) => r.args[2] === o.profile && before(r.at)) ?? null;
      const fo = [...failovers].reverse().find((e) => (e.payload as { to: string }).to === o.profile && before(e.ts)) ?? null;
      const by = fo && (!req || Date.parse(fo.ts) > Date.parse(req.at)) ? 'failover' : (req?.by ?? 'terminal');
      const instances = [...new Set(o.steps.map((s) => s.instance).filter((x): x is string => !!x))];
      return {
        op: o.id,
        to: o.profile,
        from: Object.fromEntries(instances.map((i) => [i, o.from?.[i] ?? DEFAULT_PROFILE])),
        instances,
        by,
        ok: o.status === 'done',
        detail: o.detail.slice(0, 1000),
      };
    });
}

/** Append each finished profile switch this instance's dashboard asked for as account.switched, once. Returns how many. */
export function recordProfileSwitches(log: EventLog, instance: string, dir = CLAUDE_ACCOUNT_DIR): number {
  const ops = readProfileOps(dir);
  if (!ops.some((o) => o.op === 'use' && o.for === instance)) return 0;
  const todo = unrecordedSwitches(log.read(0, ['account.switched', 'account.failover', 'machine.requested', 'machine.started', 'machine.finished']), ops, instance);
  for (const s of todo) log.append('account.switched', s, instance, 'coordinator');
  return todo.length;
}

/** The panel's profile data: the accounts × instances table and the last few profile steps (newest first). */
export function profilesView(dir = CLAUDE_ACCOUNT_DIR, now = Date.now(), instance?: string) {
  // A staged profile's confirmation, at a root shell on the machine (never through the dashboard). The relayed
  // sign-in under way, for this instance (its link only while it waits for the code).
  return { profiles: profilesTable({ dir }), profileOps: readProfileOps(dir, now).slice(-5).reverse(), confirmScript: CLAUDE_ACCOUNT_SCRIPT, signin: instance ? signinView({ dir, instance, now }) : null };
}

/**
 * The link a relayed sign-in waits on (claude-account.sh login wrote it for this coordinator's user only): Anthropic's
 * sign-in page whose redirect is its own code page, and nothing else. null when there is none, or it is anything else.
 */
export function readSigninUrl(dir = CLAUDE_ACCOUNT_DIR): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, 'login-url'), 'utf8').trim();
  } catch {
    return null;
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (text.length > 4000 || u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  if (!['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com'].includes(u.hostname) || !/\/oauth\/authorize$/.test(u.pathname)) return null;
  return u.searchParams.get('redirect_uri') === 'https://platform.claude.com/oauth/code/callback' ? u.toString() : null;
}

/** This instance's relayed sign-in under way: its profile, whether it waits for the code, and (then) the link. */
export function signinView(o: { dir?: string; instance: string; now?: number }) {
  const op = [...readProfileOps(o.dir, o.now)].reverse().find((x) => x.op === 'login' && x.for === o.instance) ?? null;
  if (!op || op.status !== 'running') return op ? { profile: op.profile, status: op.status, detail: op.detail, waitingForCode: false, url: null } : null;
  const last = op.steps.at(-1);
  const waiting = last?.step === 'link' && last.state === 'ask';
  return { profile: op.profile, status: op.status, detail: op.detail, waitingForCode: waiting, url: waiting ? readSigninUrl(o.dir) : null };
}

/**
 * Store the code a machine owner pasted for this instance's relayed sign-in, for its coordinator user only (0400), for
 * claude-account.sh login to read once, as root, and delete. Only while that sign-in waits for it, only one (a code is
 * single-use: once one is stored or taken, another is refused), only a code's shape. Every error is a fixed text,
 * never the value. Returns the file's path.
 */
export function storeLoginCode(o: { value: unknown; instance: string; who: { role: Role | null; requester: MachineRequester }; dir?: string; home?: string; ownersFile?: string; now?: number }): string {
  const why = claudeAccountGate(o.who, o.ownersFile ? { ownersFile: o.ownersFile } : {});
  if (why) throw new ClaudeTokenError(why, 403);
  const s = signinView({ instance: o.instance, ...(o.dir ? { dir: o.dir } : {}), ...(o.now ? { now: o.now } : {}) });
  if (!s || !s.waitingForCode) throw new ClaudeTokenError("no sign-in from this dashboard is waiting for a code (a code is used once: start the sign-in again)", 409);
  const file = join(secretsDir(o.instance, o.home), CLAUDE_LOGIN_CREDENTIAL);
  if (existsSync(file)) throw new ClaudeTokenError('a code for this sign-in was given already: it is used once', 409);
  const value = typeof o.value === 'string' ? o.value.trim() : '';
  if (value.length > 512 || !LOGIN_CODE.test(value)) throw new ClaudeTokenError("that isn't the code Anthropic's sign-in page shows; nothing stored");
  try {
    return installOwnerOnlySecret(secretsDir(o.instance, o.home), CLAUDE_LOGIN_CREDENTIAL, value);
  } catch (e) {
    throw new ClaudeTokenError(`couldn't store the code: ${String((e as Error).message).split('\n')[0]}`);
  }
}
