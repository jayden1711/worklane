// Tailscale and HTTPS for the dashboard hub, for the machine's owners (the first-run wizard's screen, server mode):
// whether tailscale is installed and up, and four steps, each a machine request the coordinator runs through the
// machine helper (`tailscale install|up|serve|public-url`; the root half is scripts/setup/tailscale.sh):
//
//   install     Tailscale's signed apt repository, the signing key and the version pinned in the script's lib.sh
//   up          `tailscale up`, with no auth key: it prints a login link and waits for the owner to open it
//   serve       https 443 on this machine's tailnet name to the hub's sign-in port, and to nothing else
//   public-url  the hub's URL becomes https://<that name>, through dashboards.sh with the hub's other settings kept
//
// Each runs as its own unit, so this side follows it by reading the script's progress file (steps.jsonl), not the
// event log. The login link is the one thing that isn't in that file: the script writes it to a file only this
// coordinator's user can read, and it is served here to a machine owner (or the break-glass) and nobody else, checked
// again to be Tailscale's own login page. It is never in an event, an audit entry, a log line or an error, and no auth
// key exists anywhere on this path: the request is two fixed words.
//
// Nothing here runs unless an owner asks: a machine without tailscale, or an owner who skips the screen, changes
// nothing, and the hub keeps its URL.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import type { Role } from './console/asks.js';
import { isMachineOwner, MACHINE_OWNERS_FILE, machineChangeRefusal, machineOwners, type MachineRequester } from './machine-owners.js';
import { MACHINE_EVENTS, MachineRequestError, machineRequests, requestMachineChange, type MachineRequest } from './machine-requests.js';
import { ENGINE_CURRENT } from './updates.js';
import { varLibPath } from './os/system-paths.js';

/** Where tailscale.sh writes steps.jsonl (root's, 0644) and, while `up` waits, login-url (0400, this coordinator's user; lib.sh's TAILSCALE_DIR). */
export const TAILSCALE_DIR = varLibPath('tailscale');
/** The installed engine's script: its `status --json` is what the screen shows (no root needed). */
export const TAILSCALE_SCRIPT = join(ENGINE_CURRENT, 'scripts', 'setup', 'tailscale.sh');
/** The helper's four tailscale commands, in the order the screen walks them (scripts/machine/, the helper's source; a test keeps the two equal). */
export const TAILSCALE_ACTIONS = ['install', 'up', 'serve', 'public-url'] as const;
export type TailscaleAction = (typeof TAILSCALE_ACTIONS)[number];
export const isTailscaleAction = (s: unknown): s is TailscaleAction => typeof s === 'string' && (TAILSCALE_ACTIONS as readonly string[]).includes(s);
/** The login link `tailscale up` prints, strictly (lib.sh's tailscale_login_url_ok): Tailscale's own login host and a short id. */
export const TAILSCALE_LOGIN_URL = /^https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]{6,64}$/;
/** A machine's tailnet name, as the script accepts one. */
const TAILNET_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/;
/** A step with no new line for this long has stopped (its unit ended without a last line): the longest wait is `up`'s 10 minutes. */
export const STEP_STALE_MS = 15 * 60_000;
/** Where the tailnet's MagicDNS and HTTPS certificates are turned on: Tailscale's own page. */
export const TAILSCALE_DNS_ADMIN = 'https://login.tailscale.com/admin/dns';

/** What `tailscale.sh status --json` says, each value checked. */
export interface TailscaleStatus {
  installed: boolean;
  version: string | null;
  /** The version the install step would install. */
  pinnedVersion: string | null;
  /** tailscale's BackendState (Running, NeedsLogin, Stopped, ...); null without one. */
  state: string | null;
  /** This machine's tailnet name; null off a tailnet. */
  name: string | null;
  /** The tailnet issues an HTTPS certificate for that name. */
  https: boolean;
  /** tailscale serve forwards https 443 on that name to the hub's sign-in port. */
  serve: boolean;
  other443: boolean;
  breakGlassForwarded: boolean;
  /** Tailscale Funnel (the public internet) is on for something on this machine. Shown, never changed from here. */
  funnel: boolean;
  /** The hub's URL now (its unit's --public-url); null with no hub. */
  hubUrl: string | null;
}

const str = (v: unknown, max = 1000): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** The script's status output, parsed strictly; null when it isn't that. */
export function parseTailscaleStatus(text: string): TailscaleStatus | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.installed !== 'boolean') return null;
  const version = (s: unknown) => (typeof s === 'string' && /^[0-9][0-9A-Za-z.+~-]{0,40}$/.test(s) ? s : null);
  const name = typeof o.name === 'string' && o.name.length <= 253 && TAILNET_NAME.test(o.name) ? o.name : null;
  const hubUrl = typeof o.hub_url === 'string' && /^https:\/\/[a-z0-9.-]{1,253}$/.test(o.hub_url) ? o.hub_url : null;
  return {
    installed: o.installed,
    version: version(o.version),
    pinnedVersion: version(o.pinned_version),
    state: typeof o.state === 'string' && /^[A-Za-z]{1,30}$/.test(o.state) ? o.state : null,
    name,
    https: !!name && o.https === true,
    serve: !!name && o.serve === true,
    other443: o.other_443 === true,
    breakGlassForwarded: o.break_glass_forwarded === true,
    funnel: o.funnel === true,
    hubUrl,
  };
}

/** Ask the installed script (as this user: it reads only); null when it isn't there or doesn't answer. */
export function tailscaleStatus(script = TAILSCALE_SCRIPT): Promise<TailscaleStatus | null> {
  return new Promise((resolve) => {
    execFile('bash', [script, 'status', '--json'], { encoding: 'utf8', timeout: 15_000 }, (err, stdout) => resolve(err ? null : parseTailscaleStatus(stdout)));
  });
}

export type StepState = 'started' | 'running' | 'waiting' | 'done' | 'failed';
const STATES: readonly string[] = ['started', 'running', 'waiting', 'done', 'failed'];
export interface StepLine {
  at: string;
  step: TailscaleAction;
  state: StepState;
  detail: string;
}

/** Take a link or a key out of a line before it is shown: the script never writes one, and this is the check on that. */
const scrub = (s: string) => s.replace(/https?:\/\/login\.tailscale\.com\S*/g, '[the login link]').replace(/tskey-[A-Za-z0-9_-]+/g, '[a key]');

/** Which version of the progress file this is (its size and change time; '' when there is none): it changes with every line. */
export function stepsStamp(dir = TAILSCALE_DIR): string {
  try {
    const st = statSync(join(dir, 'steps.jsonl'));
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return '';
  }
}

/** The progress lines of the last step (steps.jsonl); torn or foreign lines are skipped. */
export function readStepLines(dir = TAILSCALE_DIR): StepLine[] {
  let text: string;
  try {
    text = readFileSync(join(dir, 'steps.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: StepLine[] = [];
  for (const l of text.split('\n').slice(-200)) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      if (!isTailscaleAction(j.step) || !STATES.includes(j.state as string) || typeof j.at !== 'string' || Number.isNaN(Date.parse(j.at))) continue;
      out.push({ at: j.at, step: j.step, state: j.state as StepState, detail: scrub(str(j.detail) ?? '') });
    } catch {
      // a torn line (being written) or not ours
    }
  }
  return out;
}

export interface StepRun {
  step: TailscaleAction;
  startedAt: string;
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stalled';
  detail: string;
  lines: StepLine[];
}

/** The last step run on this machine, from its lines; null when there has been none. */
export function stepRun(lines: readonly StepLine[], now = Date.now()): StepRun | null {
  const start = lines.findIndex((l) => l.state === 'started');
  if (start < 0) return null;
  const ls = lines.slice(start).filter((l) => l.step === lines[start]!.step);
  const last = ls.at(-1)!;
  const ended = last.state === 'done' || last.state === 'failed';
  const stalled = !ended && now - Date.parse(last.at) > STEP_STALE_MS;
  return { step: ls[0]!.step, startedAt: ls[0]!.at, status: ended ? (last.state as 'done' | 'failed') : stalled ? 'stalled' : last.state === 'waiting' ? 'waiting' : 'running', detail: last.detail, lines: ls };
}

/**
 * The login link `up` is waiting on: the file the script wrote for this coordinator's user, when it holds exactly
 * Tailscale's login page. Anything else (no file, another host, a key in it) is no link.
 */
export function readLoginUrl(dir = TAILSCALE_DIR): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, 'login-url'), 'utf8').trim();
  } catch {
    return null;
  }
  return TAILSCALE_LOGIN_URL.test(text) ? text : null;
}

/** Whether this person sees the screen (and so the login link): a machine owner, or the owner's break-glass. */
export const mayViewTailscale = (r: Pick<MachineRequester, 'login' | 'breakGlass'>, file = MACHINE_OWNERS_FILE) => r.breakGlass || isMachineOwner(r.login, file);

/** Why this person may not run a step now; null when they may (the same gate as any machine change). */
export function tailscaleGate(who: { role: Role | null; requester: MachineRequester }, o: { ownersFile?: string } = {}): string | null {
  if (who.role !== 'owner') return `only an owner of this instance who is one of the machine's owners may set up Tailscale; @${who.requester.login} is ${who.role ? `a ${who.role}` : 'not on it'}`;
  return machineChangeRefusal(who.requester, { file: o.ownersFile ?? MACHINE_OWNERS_FILE });
}

export interface TailscaleStepView {
  id: TailscaleAction;
  title: string;
  done: boolean;
  /** Why it can't be run yet (an earlier step, or something only Tailscale's own pages can change); null when it can. */
  blocked: string | null;
  /** What it changes on the machine, shown before the owner confirms. */
  changes: string[];
  /** The same step without the dashboard, as root. */
  command: string;
  /** A page of Tailscale's own to open for it, when the step needs one. */
  link: { url: string; label: string } | null;
}

const SCRIPT = 'scripts/setup/tailscale.sh';
const FUNNEL_ON = 'Tailscale Funnel is on for this machine, which publishes to the public internet; nothing here turns it on or off, and this step does nothing while it is on (an admin: tailscale funnel reset)';

/** The four steps against what the machine says now: which are done, which can run, and what each would change. */
export function tailscaleSteps(s: TailscaleStatus | null): TailscaleStepView[] {
  const running = s?.state === 'Running' && !!s.name;
  const name = s?.name ?? '<this machine>.<tailnet>.ts.net';
  const url = `https://${name}`;
  const cmd = (a: TailscaleAction) => `sudo bash ${SCRIPT} ${a}`;
  return [
    {
      id: 'install',
      title: 'Install Tailscale',
      done: !!s?.installed,
      blocked: null,
      changes: [
        "adds Tailscale's apt repository for this distribution (Ubuntu or Debian), with its signing key: the key must be the one whose fingerprint the script pins, and apt checks every package against it",
        `installs the tailscale package${s?.pinnedVersion ? `, version ${s.pinnedVersion} (pinned)` : ' at the pinned version'}, and starts its service (tailscaled)`,
        'no install script is downloaded or run; nothing is logged in yet',
      ],
      command: cmd('install'),
      link: null,
    },
    {
      id: 'up',
      title: 'Log this machine in to your tailnet',
      done: running,
      blocked: !s?.installed ? 'install Tailscale first' : null,
      changes: [
        'runs tailscale up, with no auth key: it prints a login link and waits up to 10 minutes',
        'the link is shown here, to machine owners only; open it and approve this machine in your Tailscale account',
        'the link is never written to a log; it is deleted when the step ends',
      ],
      command: cmd('up'),
      link: null,
    },
    {
      id: 'serve',
      title: 'Put the hub on HTTPS',
      done: !!s?.serve,
      blocked: !running
        ? 'log this machine in to your tailnet first'
        : s!.breakGlassForwarded
          ? 'tailscale serve forwards to the break-glass port, which must never be forwarded: an admin runs tailscale serve reset'
          : s!.funnel
            ? FUNNEL_ON
          : s!.serve
            ? null
            : s!.other443
              ? 'tailscale serve already forwards https 443 somewhere else; it is left as it is (an admin: tailscale serve status)'
              : !s!.https
                ? `your tailnet doesn't issue an HTTPS certificate for ${name} yet: turn on MagicDNS and HTTPS certificates in Tailscale's DNS settings, then check again`
                : null,
      changes: [`runs tailscale serve --bg --https=443 http://127.0.0.1:4399: ${url} then reaches the hub's sign-in port, from your tailnet only`, 'nothing else is forwarded; the break-glass port (4398) never is; Funnel (the public internet) is never turned on'],
      command: cmd('serve'),
      link: running && !s!.serve && !s!.https ? { url: TAILSCALE_DNS_ADMIN, label: "Tailscale's DNS settings" } : null,
    },
    {
      id: 'public-url',
      title: "Set the hub's public URL",
      done: running && !!s!.hubUrl && s!.hubUrl === url,
      blocked: !running ? 'log this machine in to your tailnet first' : s!.funnel ? FUNNEL_ON : !s!.serve ? 'put the hub on HTTPS first: until then the new URL would reach nothing' : !s!.hubUrl ? 'this machine has no dashboard hub yet (an admin runs dashboards.sh)' : null,
      changes: [
        `the hub's URL becomes ${url}${s?.hubUrl && s.hubUrl !== url ? ` (now ${s.hubUrl})` : ''}, through dashboards.sh with the hub's other settings kept: this machine's own tailnet name, read on the machine; no other name can be set`,
        'the hub still listens on this machine only (127.0.0.1): nothing becomes reachable that tailscale serve does not already forward to your tailnet',
        "the hub and each instance's dashboard restart: this page reloads, and a session signed in at the old URL ends",
        `then, on GitHub, set the sign-in App's callback URL to exactly ${url}/auth/callback: sign-in at the new URL fails until it is`,
      ],
      command: `${cmd('public-url')}   (the same as: sudo bash scripts/setup/dashboards.sh --client-id <the sign-in App's client id> --public-url ${url} <instance>...)`,
      link: null,
    },
  ];
}

const isTailscaleRequest = (r: MachineRequest) => r.args[0] === 'tailscale';
const open = (r: MachineRequest) => r.status === 'pending' || r.status === 'running';

/** What is going on now that a new step must wait for; null when nothing is. */
function busyWith(run: StepRun | null, requests: readonly MachineRequest[]): string | null {
  const waiting = requests.find((r) => isTailscaleRequest(r) && open(r));
  if (waiting) return `tailscale ${waiting.args[1]} is ${waiting.status === 'pending' ? 'waiting for the coordinator' : 'starting'}`;
  if (run && (run.status === 'running' || run.status === 'waiting')) return `tailscale ${run.step} is running`;
  return null;
}

/** The screen's data: the machine's state, the four steps, the last run, this log's requests, and whether this person may act. */
export function tailscaleView(o: { status: TailscaleStatus | null; dir?: string; events: readonly StoredEvent[]; who: { role: Role | null; requester: MachineRequester }; instance: string; ownersFile?: string; now?: number }) {
  const now = o.now ?? Date.now();
  const why = tailscaleGate(o.who, o.ownersFile ? { ownersFile: o.ownersFile } : {});
  const run = stepRun(readStepLines(o.dir), now);
  const requests = machineRequests(o.events).filter(isTailscaleRequest);
  const busy = busyWith(run, requests);
  const steps = tailscaleSteps(o.status);
  const viewer = mayViewTailscale(o.who.requester, o.ownersFile);
  return {
    machineOwner: viewer,
    machineOwners: machineOwners(o.ownersFile ?? MACHINE_OWNERS_FILE),
    login: o.who.requester.login,
    instance: o.instance,
    /** Whether this person may run a step (the server checks again). */
    allowed: why === null,
    why,
    busy,
    /** Null: the installed engine has no tailscale.sh, or it didn't answer (the steps can't be offered). */
    status: o.status,
    steps,
    /** The first step not done: the one the screen offers. */
    next: steps.find((s) => !s.done)?.id ?? null,
    run,
    /** The login link, only while `up` waits on it, and only for the people who see this screen. */
    loginUrl: viewer && run?.step === 'up' && run.status === 'waiting' ? readLoginUrl(o.dir) : null,
    requests: requests.slice(-10).reverse(),
    /** The same without the dashboard. */
    script: { status: `bash ${SCRIPT} status`, steps: TAILSCALE_ACTIONS.map((a) => `sudo bash ${SCRIPT} ${a}`) },
  };
}

export type TailscaleData = ReturnType<typeof tailscaleView>;

/**
 * What everyone else is sent (not a machine owner, or a local checkout, which has no hub): that there is nothing for
 * them here, and nothing else. No state, no steps, no link. The page renders nothing from it.
 */
export function noTailscaleView(login: string, instance: string | null): TailscaleData {
  return { machineOwner: false, machineOwners: [], login, instance: instance ?? '', allowed: false, why: null, busy: null, status: null, steps: [], next: null, run: null, loginUrl: null, requests: [], script: { status: '', steps: [] } };
}

/**
 * Record `tailscale <step>` for the coordinator to run through the machine helper: the same gate as any machine
 * change, one step at a time, and only a step the machine is ready for (the script checks that again, as root).
 * The request is those two words: nothing a person typed is part of it.
 */
export function requestTailscale(log: EventLog, r: { action: unknown; status: TailscaleStatus | null; requester: MachineRequester; dir?: string; ownersFile?: string; now?: number }): MachineRequest {
  if (!isTailscaleAction(r.action)) throw new MachineRequestError(`action is one of ${TAILSCALE_ACTIONS.join(', ')}`);
  const who = machineChangeRefusal(r.requester, { file: r.ownersFile ?? MACHINE_OWNERS_FILE });
  if (who) throw new MachineRequestError(who, 403);
  if (!r.status) throw new MachineRequestError("this machine's engine has no tailscale setup script (scripts/setup/tailscale.sh), or it didn't answer: update the engine, or run the steps in a terminal", 409);
  const busy = busyWith(stepRun(readStepLines(r.dir), r.now), machineRequests(log.read(0, [...MACHINE_EVENTS])));
  if (busy) throw new MachineRequestError(`${busy}; wait for it to end`, 409);
  // A step that is already done may be run again: the script finds it done and changes nothing.
  const step = tailscaleSteps(r.status).find((s) => s.id === r.action)!;
  if (step.blocked) throw new MachineRequestError(`not yet: ${step.blocked}`, 409);
  return requestMachineChange(log, { args: ['tailscale', r.action], requester: r.requester, via: 'tailscale', ...(r.ownersFile ? { ownersFile: r.ownersFile } : {}) });
}
