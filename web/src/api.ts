import { useCallback, useEffect, useRef, useState } from 'react';

export type TaskStatus =
  | 'triage' | 'ready' | 'claimed' | 'reproducing' | 'building' | 'verifying' | 'evaluating'
  | 'awaiting_decision' | 'queued' | 'in_review' | 'landed' | 'done' | 'blocked' | 'released';

export interface Task {
  issue: number;
  title: string;
  labels: string[];
  author: string;
  owner: string | null;
  delegate: { instance: string; role: string } | null;
  status: TaskStatus;
  actionable: boolean;
  why: string;
  level: string | null;
  levelReasons: string[];
  doneWhen: Record<string, unknown>[];
  verdict: { patch_correct: boolean; test_correct: boolean; confidence: string; advice: string } | null;
  /** Absent for a viewer: costs are the owners' and writers'. */
  costUsd?: number;
  attempts: number;
  head: string | null;
  landed: string | null;
  deployed: string | null;
  repro: string | null;
  openDecision: string | null;
  blockedReason: string | null;
  lastActivity: string;
  firstSeen: string;
  eventIds: number[];
}

export interface Decision {
  id: string;
  kind: string;
  issue: number | null;
  owner: string;
  question: string;
  options: string[];
  recommendation: string;
  /** Absent for a viewer (run and agent detail). */
  receipts?: string[];
  askedAt: string;
  answer: { by: string; answer: string; at: string } | null;
  /** Whether the dashboard's user may answer it (its owner or a writer); the server refuses otherwise. */
  canAnswer?: boolean;
}

/** One step of an agent run: a shell command or a file write. */
export interface RunStep {
  kind: 'command' | 'write';
  tool: string;
  what: string;
  status: 'ok' | 'error' | 'no result';
  exitCode: number | null;
  output: string;
}

/** What an agent did in one run (GET /api/runs/:id), recorded by the runner. */
export interface RunRecord {
  id: string;
  issue: number | null;
  role: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  costUsd: number | null;
  turns: number | null;
  steps: RunStep[];
  files: string[];
  otherTools: number;
  final: string;
  truncated: boolean;
}

/** An issue's runs without their steps (GET /api/runs?issue=n). */
export type RunSummary = Omit<RunRecord, 'steps' | 'otherTools' | 'final'> & { commands: number; failedCommands: number };

/** The coordinator's service log (GET /api/logs), read-only. */
/** A pull request the harness opened (GET /api/prs), with its checks, fix runs and merge calls. */
export interface PrView {
  number: number;
  issue: number;
  title: string;
  url: string;
  openedAt: string;
  head: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  status: { head: string; at: string; ready: boolean; reasons: string[]; checks: { name: string; outcome: string }[] } | null;
  unready: { at: string; why: string } | null;
  fixes: { attempt: number; at: string; checks: string[]; outcome: 'running' | 'pushed' | 'no_push' | 'interrupted'; detail: string }[];
  gaveUp: { at: string; reason: string } | null;
  decision: { at: string; head: string; auto: boolean; reasons: string[] } | null;
  /** The merge policy's standing "wait for a person" reasons (empty when it didn't say wait, or the PR has moved on). */
  waitReasons: string[];
  merged: { at: string; sha: string; url: string; auto: boolean } | null;
  mergeFailed: { at: string; why: string } | null;
  mainResult: { at: string; outcome: 'green' | 'red' | 'timed_out'; failed: string[] } | null;
  conflict: { state: 'detected' | 'running' | 'done'; at: string; attempt: number; outcome: string | null; files: string[]; waitsOwner: boolean; reasons: string[]; detail: string } | null;
  lightCheck: { state: 'running' | 'done'; at: string; mainSha: string; overlap: string[]; outcome: string | null; waitMs: number | null; detail: string } | null;
  phase: 'waiting' | 'fixing' | 'resolving' | 'light_check' | 'gave_up' | 'checks' | 'ready' | 'auto_merged' | 'merged' | 'closed';
}

/** The machine health view (GET /api/health): the OS adapter's snapshot, check times, usage per day, suggestions. */
export interface HealthView {
  instance: string | null;
  machine: {
    at: string;
    platform: string;
    memory: { totalBytes: number; availableBytes: number; swapTotalBytes: number; swapFreeBytes: number } | null;
    load: [number, number, number] | null;
    units: ({ unit: string; memoryCurrent: number | null; memoryMax: number | null; memorySwapCurrent: number | null; cpuUsageNSec: number | null; activeState: string | null } | { unit: string; error: string })[] | null;
    disks: ({ path: string; freeBytes: number; totalBytes: number } | { path: string; error: string })[];
    unavailable: string[];
  } | null;
  cores: number | null;
  checks: {
    timings: { check: string; runs: number; series: { at: string; ms: number; status: string }[]; recentMedianMs: number; priorMedianMs: number | null; regression: { slowerPct: number } | null }[];
    slowest: string[];
    regressions: string[];
    rule: string;
  };
  usage: {
    /** estimatedUsd: absent for a viewer (costs are the owners' and writers'). */
    days: { day: string; runs: number; estimatedUsd?: number; turns: number; rateLimited: number; authProblems: number; retries: Record<string, number>; retryWaitMs: number; lockWaits: number; lockWaitMs: number }[];
    quotaNote: string;
  };
  /** The off-machine backup (src/offsite-backup.ts): null when it was never set up (no attempt recorded). */
  offsiteBackup: {
    destination: string;
    lastOkAt: string | null;
    lastOkKey: string | null;
    lastAttemptAt: string;
    lastError: string | null;
    ageHours: number | null;
    /** No verified copy, or the last one is over a day old. */
    stale: boolean;
  } | null;
  /** An engine update this machine rolled back and holds (src/updates.ts heldUpdate); null when none. */
  updateHold?: { at: string; sha: string | null; reason: string; migration: boolean } | null;
  /** Links to the engine's docs; null when the package names no repository. */
  docs?: { backups: string | null };
  /** What conflict fixes, light checks and hotspot holds cost per merged PR, over the last week. */
  merge?: {
    since: string;
    mergedPrs: number;
    conflicts: { count: number; needOwner: number; minutesToMerged: number[]; medianMinutes: number | null; perMergedPr: number };
    lightChecks: { count: number; minutesAdded: number; perMergedPr: number; outcomes: Record<string, number> };
    holds: { count: number; minutesWaited: number; perMergedPr: number; byFile: { file: string; minutes: number; count: number }[] };
    flags: string[];
  };
  suggestions: string[];
}

export interface PrsView {
  prs: PrView[];
  refused: { at: string; issue: number; title: string; head: string; stage: string; reasons: string[] }[];
  stops: { at: string; kind: 'stopped' | 'resumed'; reason: string; number: number | null; revert: string | null }[];
  /** Tasks held on a hotspot (another task is changing the same files): still held (until null), or released. */
  holds: { issue: number; title: string; by: number; files: string[]; reason: string; since: string; until: string | null; waitedMs: number | null }[];
  /** Whether this instance merges its own PRs now, and why (or why not). */
  autoMerge: { on: boolean; policy: boolean | null; repo: boolean | null; stopped: string | null; why: string };
}

export interface ServiceLog {
  source: 'journal' | 'file' | 'none';
  unit: string | null;
  entries: { at: string | null; priority: number | null; message: string }[];
  problem: string | null;
}

/** One run of the coordinator's own checks on an issue (GET /api/checks?issue=n), newest first. */
export interface CheckRun {
  id: number;
  at: string;
  stage: string;
  head: string;
  checks: { check: string; status: 'pass' | 'fail' | 'unavailable' | 'skipped' | string; exitCode: number | null; tail: string | null }[];
}

export interface Activity { id: number; ts: string; type: string; actor: string; issue: number | null; summary: string }

export interface State {
  brand: { name: string; cli: string };
  /** Whether this viewer may read intake reports (the owner or a writer); absent from an older server: yes. */
  canReadIntake?: boolean;
  /** Whether this viewer may read the throughput panel (the owner or a writer); absent from an older server: yes. */
  canReadThroughput?: boolean;
  /** Whether this viewer may read the report preview (the owner or a writer); absent from an older server: yes. */
  canReadReports?: boolean;
  /** Whether this viewer may read agent runs (the owner or a writer); absent from an older server: yes. */
  canReadRuns?: boolean;
  /** Whether this viewer may read what waits on the owner (the owner or a writer); absent from an older server: yes. */
  canReadDigest?: boolean;
  project: { name: string; repo: string; landMode: string };
  /** Who this page is for: the signed-in person's login, or the owner's on the break-glass. */
  user: string;
  /** Their role on this instance, read by its server from their permission on the repo; absent from an older server. */
  role?: Role;
  /** How they came in: signed in with GitHub, or the owner's break-glass on the machine. */
  via?: 'session' | 'break-glass';
  /** Whether they may write at all (viewers are read-only). */
  canWrite?: boolean;
  /** Whether they may read the audit log (owners only). */
  canReadAudit?: boolean;
  /** Whether they may read the service log and the machine settings (owners and writers). */
  canReadLogs?: boolean;
  canReadMachine?: boolean;
  owners: { default: string; writers: string[]; areas: { name: string; owner: string; paths: string[]; labels: string[] }[] };
  /** Absent for a viewer (the budget, spend and agent runs are the owners' and writers'). */
  budget?: number;
  /** A viewer gets the counts only (cap, running), not which agents hold the slots. */
  slots: { cap: number; running: number; agents?: SlotHolder[]; fullRun?: { owner: string; acquiredAt: string; elsewhere?: true } | null };
  lastId: number;
  tasks: Task[];
  decisions: Decision[];
  /** Every cost figure is an estimate (the agent CLI's own per-run cost estimate), not money billed. */
  costBasis: 'estimate';
  spendToday?: number;
  spendByRole?: Record<string, number>;
  landedToday: number;
  baseline: { sha: string; failing: string[]; at: string } | null;
  deploys: { env: string; sha: string; status: string; why?: string; at: string }[];
  coordinator: { instance: string; startedAt: string; lastTick: string | null } | null;
  /** The coordinator's recent errors; a viewer gets only how many (errorCount), never their text. */
  errors?: { at: string; where: string; message: string }[];
  errorCount?: number;
  activity: Activity[];
  inbox: { decisions: Decision[]; blocked: Task[]; notify: Task[] };
  runs?: { active: Run[]; recent: Run[] };
  landQueue: { issue: number; title: string; head: string; level: string; queuedAt: string; deferred: string | null }[];
  /** Direct landing's batches (`land`) and PR mode's (`pr`, with its PRs); a viewer's have no tip or detail. */
  batches: { id: string; kind?: 'land' | 'pr'; issues: number[]; prs?: number[]; tip?: string; outcome: string; detail?: string; at: string }[];
  governor: { held: boolean; reason: string | null; load: number | null; freeDiskPct: number | null; at: string } | null;
  /** The machine-wide emergency stop, read-only: in force now, and whether this coordinator has halted for it. */
  /** Open PRs, and those needing a person (waiting on review, or a CI fix that gave up). */
  prCounts?: { open: number; needYou: number };
  emergency: {
    inForce: { by: string; at: string; reason: string } | null;
    halted: { at: string; running: number } | null;
    lastStop: { at: string; by: string; reason: string; running: number } | null;
    lastResume: string | null;
  };
  reports: { day: string; slot: string; issue: number | null; at: string }[];
  /** How the default branch is guarded; a viewer gets `mode` only. Absent from an older server. */
  protection?: Protection;
}

/** The default branch's protection: GitHub's, the main watch's (with the last commit it checked and an alert), or off. */
export interface Protection {
  mode: 'github' | 'main_watch' | 'off' | 'unknown';
  detail?: string;
  lastChecked?: { sha: string; url: string; at: string | null } | null;
  alert?: { at: string; sha: string; url: string; reason: string; number: number | null; revert: string | null } | null;
  stopped?: string | null;
  canClear?: boolean;
  /** Commits admins accepted as bootstrap merges (owners and writers); `appliedTo`: the commit the watch accounted with it. */
  accepted?: AcceptedMerge[];
  /** Whether this person may accept one (an admin, while the main watch guards the branch). */
  canAccept?: boolean;
}

export interface AcceptedMerge {
  id: string;
  sha: string | null;
  pr: number | null;
  head: string | null;
  by: string;
  reason: string;
  at: string;
  appliedTo: string | null;
}

/** An admin resumes auto-merge (the stop file goes; audited). */
export const clearAutoMergeStop = () => api<{ ok: boolean }>('/api/auto-merge/clear', { method: 'POST', body: '{}' });

/** What the accept field names: `#22` or `22` is a PR (a sha is at least 7 hex characters), anything else a sha. */
export function acceptTarget(text: string): { pr: number } | { sha: string } {
  const t = text.trim();
  const pr = t.match(/^#?(\d{1,6})$/);
  return pr ? { pr: Number(pr[1]) } : { sha: t };
}

/** An admin accepts a commit, or a PR's merge to come, as a bootstrap merge (audited; the stop, if any, stays). */
export const acceptBootstrapMerge = (target: string, reason: string) => api<{ ok: boolean }>('/api/main-watch/accept', { method: 'POST', body: JSON.stringify({ ...acceptTarget(target), reason }) });

export interface Run {
  issue: number;
  role: string;
  model: string;
  pid: number;
  attempt: number;
  startedAt: string;
  lastHeartbeat: string | null;
  note: string | null;
  finishedAt: string | null;
  reason: string | null;
  costUsd: number;
}

export interface Settings {
  configDir: string;
  project: { name: string; repo: string; landMode: string; runtime: unknown };
  owners: State['owners'];
  reports: { times: string[]; to: string[] };
  governor: { max_load?: number; min_free_disk_pct: number };
  agents: { budget: number; roles: { name: string; enabled: boolean; model: string; count: number | null }[] };
  tests: { gates: Record<string, string[]>; batchMax: number; nightlyAt: string | null; tiers: string[]; baselineParser: boolean };
  review: { levels: Record<string, string[]> } | null;
  guardrails: { rules: number; protectedPaths: string[]; secretPaths: number; network: string; preApproved: string[] };
  deploy: { environments: { name: string; production: boolean }[]; prodRead: boolean } | null;
}

/** What a viewer (read on the repo) gets of the settings: the project part only. */
export type ViewerSettings = Pick<Settings, 'configDir' | 'project' | 'owners' | 'reports'> & { forViewer: true };
export const getSettings = () => api<Settings | ViewerSettings>('/api/settings');

/** Fetch once, and again whenever `dep` changes (e.g. the live pulse). */
export function useFetch<T>(fn: () => Promise<T>, dep: unknown = 0): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fn().then(
      (d) => live && (setData(d), setError(null)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return { data, error };
}

/** In a browser (not the render checks, which render pages on the server). */
const inBrowser = typeof window !== 'undefined';

function readToken(): string {
  if (!inBrowser) return '';
  const url = new URL(window.location.href);
  const t = url.searchParams.get('t');
  if (t) {
    try {
      sessionStorage.setItem('dash-token', t);
    } catch {
      // storage unavailable: keep it in the URL instead
      return t;
    }
    url.searchParams.delete('t');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return t;
  }
  try {
    return sessionStorage.getItem('dash-token') ?? '';
  } catch {
    return '';
  }
}

export const token = readToken();

/** Where a one-time setup link from Discord waits for the page to exchange it (src/console/links.ts). */
const SETUP_LINK_KEY = 'dash-setup-link';
/**
 * A one-time setup link (`/setup/link/<instance>/<token>`, sent by DM): taken out of the address bar at once, before
 * anything renders, and kept in this tab only until the Setup page exchanges it (after a sign-in, if one is needed).
 * On a hub, the link's instance is the one this tab shows. Returns whether this page was opened from one.
 */
export function takeSetupLink(loc: Pick<Location, 'pathname'> = window.location, store: Pick<Storage, 'setItem'> = sessionStorage, replace: (path: string) => void = (p) => window.history.replaceState(null, '', p)): boolean {
  const m = loc.pathname.match(/^\/setup\/link\/([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_-]{43})\/?$/);
  if (!m) return false;
  replace('/setup');
  try {
    store.setItem(SETUP_LINK_KEY, m[2]!);
    if (m[1] !== '-') {
      store.setItem('dash-instance', m[1]!);
      sessionStorage.removeItem('dash-all-instances');
    }
  } catch {
    // no storage: the link can't be kept; open the step from the Setup page
  }
  return true;
}
if (inBrowser && !takeSetupLink()) {
  // Back from signing in (the hub returns to /): a link still waiting opens the Setup page.
  try {
    if (sessionStorage.getItem(SETUP_LINK_KEY) && window.location.pathname === '/') window.history.replaceState(null, '', '/setup');
  } catch {
    // no storage: nothing waits
  }
}

/** The setup link waiting in this tab, taken once. */
export function pendingSetupLink(): string | null {
  try {
    const t = sessionStorage.getItem(SETUP_LINK_KEY);
    sessionStorage.removeItem(SETUP_LINK_KEY);
    return t;
  } catch {
    return null;
  }
}

/** Someone's role on an instance (src/dashboard-auth.ts): from their permission on its repo. */
export type Role = 'owner' | 'writer' | 'viewer';

/** Who is signed in to the hub: their login and this session's CSRF token; or the owner's break-glass (the token). */
export interface Me {
  login: string | null;
  csrf: string | null;
  breakGlass: boolean;
}
/**
 * Who is signed in, asked only on a hub page: null when nobody is (the page then shows the sign-in), or on an
 * instance's own dashboard (no sign-in there: its token is the owner's break-glass).
 */
export function probeMe(servedByHub: boolean, get: typeof fetch = fetch, auth = token): Promise<Me | null> {
  if (!servedByHub) return Promise.resolve(null);
  return get('/api/me', { headers: auth ? { authorization: `Bearer ${auth}` } : {} })
    .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
    .then((m) => (m && (m.login || m.breakGlass) ? m : null))
    .catch(() => null);
}
const servedByHub = inBrowser && !!document.querySelector('meta[name="dashboard-hub"]');
export const me: Promise<Me | null> = probeMe(servedByHub);
/** Whether this page needs a sign-in: a hub page, with no session and no break-glass token. */
export const needsSignIn: Promise<boolean> = me.then((m) => servedByHub && !m);

let csrf = '';
void me.then((m) => {
  csrf = m?.csrf ?? '';
});

/** What every API call carries: the break-glass token when there is one, and this session's CSRF token (every write needs it). */
async function authHeaders(): Promise<Record<string, string>> {
  await me;
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), 'content-type': 'application/json' };
}

/** A stream's URL: the break-glass token on it (EventSource sends no headers); a session's cookie goes by itself. */
export const streamUrl = (path: string) => (token ? `${path}?t=${encodeURIComponent(token)}` : path);

/** Sign out: the hub deletes the session (server-side), then the page shows the sign-in again. */
export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', headers: await authHeaders(), body: '{}' }).catch(() => undefined);
  try {
    sessionStorage.removeItem('dash-instance');
    sessionStorage.removeItem('dash-all-instances');
  } catch {
    // nothing kept
  }
  window.location.assign('/');
}

/** On a hub (one view over several instances), its instances; null on an instance's or a checkout's own dashboard. */
export interface HubInfo {
  instances: { name: string; up: boolean; error: string | null }[];
}
/**
 * The hub's instances, asked for only when a hub served this page (it marks the page; see HUB_MARKER).
 * An instance's or a checkout's own dashboard has no /api/hub, and asking would log a 404 on every page.
 */
export function probeHub(servedByHub: boolean, get: typeof fetch = fetch, auth = token): Promise<HubInfo | null> {
  if (!servedByHub) return Promise.resolve(null);
  return get('/api/hub', { headers: auth ? { authorization: `Bearer ${auth}` } : {} })
    .then((r) => (r.ok ? (r.json() as Promise<HubInfo>) : null))
    .catch(() => null);
}
export const hub: Promise<HubInfo | null> = inBrowser ? needsSignIn.then((n) => (n ? null : probeHub(servedByHub))) : Promise.resolve(null);

/**
 * Which instances a hub page reads: the selected one, or every instance this person has a role on when they
 * chose "All instances" in the switcher (off unless chosen). `instances` is what pages that can show several
 * instances read, labelled; every other page reads `current` only. Off a hub: this page's own server (null).
 */
export interface InstanceScope {
  current: string | null;
  all: boolean;
  instances: (string | null)[];
}
/** The scope from the hub's list (only instances with a role on them), the instance picked last and the All choice. */
export function scopeOf(h: HubInfo | null, saved: string | null, all: boolean): InstanceScope {
  if (!h?.instances.length) return { current: null, all: false, instances: [null] };
  const current = h.instances.find((i) => i.name === saved)?.name ?? h.instances.find((i) => i.up)?.name ?? h.instances[0]!.name;
  const every = all && h.instances.length > 1;
  return { current, all: every, instances: every ? h.instances.map((i) => i.name) : [current] };
}
const saved = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null; // no storage: the default
  }
};
export const instanceScope: Promise<InstanceScope> = hub.then((h) => scopeOf(h, saved('dash-instance'), saved('dash-all-instances') === '1'));
/** The instance a hub page shows: the one picked last in this tab, else the first that answers. */
export const hubInstance: Promise<string | null> = instanceScope.then((s) => s.current);

/** Show another instance (hub only), and only it: everything reloads from that instance's own server. */
export function selectInstance(name: string) {
  try {
    sessionStorage.setItem('dash-instance', name);
    sessionStorage.removeItem('dash-all-instances');
  } catch {
    // no storage: this tab can't switch
  }
  window.location.reload();
}
/** "All instances" (hub only): the Board and its test runs show every instance this person has a role on, labelled. */
export function selectAllInstances() {
  try {
    sessionStorage.setItem('dash-all-instances', '1');
  } catch {
    // no storage: this tab can't switch
  }
  window.location.reload();
}

/** An API path as this page reaches it: on a hub, through the selected instance's own server. */
export async function apiPath(path: string): Promise<string> {
  const inst = await hubInstance;
  return inst ? path.replace(/^\/api\//, `/api/i/${encodeURIComponent(inst)}/`) : path;
}

/** A call to one named instance's own server through the hub (`/api/i/<name>/...`), whichever instance this page shows. */
export async function instanceApi<T>(name: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.replace(/^\/api\//, `/api/i/${encodeURIComponent(name)}/`), { ...init, headers: { ...(init.headers ?? {}), ...(await authHeaders()) } });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(await apiPath(path), { ...init, headers: { ...(init.headers ?? {}), ...(await authHeaders()) } });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** State from the server, refetched whenever the event log changes (one SSE stream). */
export function useLiveState() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [pulse, setPulse] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setState(await api<State>('/api/state'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    let es: EventSource | null = null;
    let closed = false;
    void apiPath('/api/stream').then((p) => {
      if (closed) return;
      es = new EventSource(streamUrl(p));
      es.addEventListener('hello', () => setLive(true));
      es.addEventListener('change', () => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          void refresh();
          setPulse((p) => p + 1);
        }, 150);
      });
      es.onerror = () => setLive(false);
    });
    return () => {
      closed = true;
      es?.close();
    };
  }, [refresh]);

  return { state, error, live, pulse, refresh };
}

export async function decide(id: string, answer: string) {
  return api<{ ok: boolean }>('/api/decide', { method: 'POST', body: JSON.stringify({ id, answer }) });
}

/** A setup-console ask (src/console/asks.ts), as GET /api/asks serves it. */
export type Ask = {
  id: string;
  instance: string;
  title: string;
  detail: string;
  createdAt: string;
  createdBy: string;
  status: 'open' | 'answered' | 'cancelled';
  answer: { by: string; role: 'owner' | 'writer'; answer: string; detail: string; at: string } | null;
  cancelled: { by: string; why: string; at: string } | null;
  /** Whether this person may answer it (the server checks again). */
  canAnswer: boolean;
  /** A root step's machine request, once asked for: the coordinator runs it (pending, running, done, failed, refused, interrupted). */
  request?: { status: string; detail: string } | null;
} & (
  | { kind: 'paste_secret'; credential: string; where: string }
  | { kind: 'approve_link'; url: string }
  | { kind: 'question'; options: string[]; writersMayAnswer: boolean }
  | { kind: 'root_step'; command: string; args: string[]; allowed: boolean; refusal: string | null }
);
export interface AsksView {
  role: 'owner' | 'writer' | 'viewer';
  login: string;
  asks: Ask[];
}
export const getAsks = () => api<AsksView>('/api/asks');
export const answerAsk = (id: string, answer: string) => api<{ ok: boolean }>(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) });
/** A pasted secret, straight to the instance's server; nothing keeps it on this side. */
export const pasteSecret = (id: string, value: string) => api<{ ok: boolean }>(`/api/asks/${id}/secret`, { method: 'POST', body: JSON.stringify({ value }) });
/** Exchange a one-time setup link: which ask it opens. Bound to this person's sign-in; it works once. */
export const openSetupLink = (token: string) => api<{ ok: boolean; ask: string }>('/api/asks/link', { method: 'POST', body: JSON.stringify({ token }) });
export const runRootStep = (id: string) => api<{ ok: boolean }>(`/api/asks/${id}/run`, { method: 'POST', body: '{}' });

/** The setup console's Add project (src/console/add-project.ts), as GET /api/add-project serves it. */
export interface AddProjectStep {
  step: string;
  state: 'pending' | 'started' | 'done' | 'failed' | 'ask';
  detail: string;
  /** A failed step: how to try again (absent from older servers). */
  retry?: string | null;
  at: string | null;
}
export interface AddProjectRun {
  id: string;
  name: string;
  repo: string;
  by: string;
  at: string;
  /** The machine request's status: pending (for the coordinator), running, done, failed, refused, interrupted. */
  status: string;
  detail: string;
  /** add-project.sh's steps, in its order. */
  steps: AddProjectStep[];
  failedStep: string | null;
  /** The asks it raised: GitHub's approve links and the Claude token. */
  asks: Ask[];
}
export interface AddProjectData {
  /** Whether this person may add a project now (the server checks again on submit). */
  allowed: boolean;
  /** Why not, when not. */
  why: string | null;
  login: string;
  machineOwners: string[];
  /** Newest first. */
  runs: AddProjectRun[];
}
export const getAddProject = () => api<AddProjectData>('/api/add-project');
export const addProject = (name: string, repo: string) => api<{ ok: boolean }>('/api/machine/add-project', { method: 'POST', body: JSON.stringify({ name, repo }) });
/**
 * The name and repo add-project takes: the same rules as the server's and the machine helper's (addProjectNameOk and
 * addProjectRepoOk in src/machine.ts; test/web-render.test.ts holds the two to the same answers).
 */
export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,20}$/;
export const PROJECT_REPO = /^([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})\/([A-Za-z0-9_.-]{1,100})$/;
/** Why this name and repo won't be accepted; null when they will. */
export function addProjectInvalid(name: string, repo: string): string | null {
  if (!PROJECT_NAME.test(name) || name === 'dash' || /-(agent|eval|work)$/.test(name)) return 'The name is lowercase letters, digits and dashes, starting with a letter, at most 21 characters, not "dash" and not ending in -agent, -eval or -work.';
  const m = PROJECT_REPO.exec(repo);
  if (!m || m[2] === '.' || m[2] === '..') return 'The repo is owner/name, as on GitHub.';
  return null;
}

export interface SavedView { name: string; filters: Filters }
export interface Filters { owner?: string; status?: string; level?: string; label?: string; text?: string }

export const listViews = () => api<SavedView[]>('/api/views');
export const saveViews = (v: SavedView[]) => api('/api/views', { method: 'PUT', body: JSON.stringify(v) });

/** A chat answer as the instance's server gives it (src/chat.ts); a non-owner's has no draft and no proposals. */
export interface ChatCitation { kind: 'event' | 'run' | 'pr' | 'issue'; id: string; instance: string; label: string; href: string }
export type ChatAction = ({ kind: 'settings'; key: string; value: unknown; confirm: 'settings.change' } | { kind: 'decision'; id: string; answer: string; confirm: 'decision.answer' } | { kind: 'pause'; confirm: 'emergency.pause' } | { kind: 'resume'; confirm: 'emergency.resume' }) & { why?: string };
export interface ChatAnswer {
  turn: string;
  instance: string;
  answer: string;
  citations: ChatCitation[];
  unknownCitations: string[];
  issueDraft: null | { ok: true; title: string; body: string; labels: string[] } | { ok: false; title: string; body: string; why: string };
  actions: ChatAction[];
  refusedActions: string[];
  readOnly: boolean;
  costUsd: number;
}
export type ChatAnswerFile = { v: number; id: string; at: string; owner: boolean; filed: { number: number } | null } & ({ state: 'pending' } | { state: 'answered'; answer: ChatAnswer } | { state: 'refused'; why: string });

/** The chat on one instance: this page's (null), or a named one through the hub. */
const chatCall = <T,>(instance: string | null, path: string, init: RequestInit = {}) => (instance ? instanceApi<T>(instance, path, init) : api<T>(path, init));
/** `key` names one ask: a retry of the same POST returns the same question instead of running a second turn. */
export const askChat = (instance: string | null, question: string, key: string) => chatCall<{ id: string }>(instance, '/api/chat', { method: 'POST', body: JSON.stringify({ question, key }) });
/** A fresh request key (works outside secure contexts too, where randomUUID is missing). */
export const requestKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
export const chatAnswer = (instance: string | null, id: string) => chatCall<ChatAnswerFile>(instance, `/api/chat/${id}`);
export const fileChatDraft = (instance: string | null, id: string) => chatCall<{ ok: boolean; number: number }>(instance, `/api/chat/${id}/file-issue`, { method: 'POST', body: '{}' });

/** Intake (GET /api/intake): each report, redacted, and what became of it; and the numbers for the health panel. */
export interface IntakeReport {
  id: string;
  source: string;
  receivedAt: string;
  /** A short hash, never a handle or a number. */
  sender: string;
  kind: string | null;
  reproduction: string | null;
  outcome: 'filed' | 'awaiting_owner' | 'commented' | 'grouped' | 'replied' | 'asked_owner' | 'dropped' | 'rejected' | 'pending';
  issue: number | null;
  dropped: string | null;
  replies: string[];
  excerpt: string | null;
}
export interface IntakeHealth {
  perDay: { day: string; source: string; reports: number }[];
  dropped: Record<string, number>;
  reportToMerged: { count: number; medianMinutes: number | null };
}
export interface IntakeView {
  reports: IntakeReport[];
  health: IntakeHealth;
}

/** Throughput (GET /api/throughput, src/throughput.ts): merges, cost per merged PR by stage, waits, the top costs. */
export type ThroughputStage = 'worker' | 'evaluator' | 'plan' | 'research' | 'intake' | 'gardener' | 'chat' | 'retries' | 'other';
export interface Throughput {
  since: string;
  until: string;
  merged: { total: number; perDay: { day: string; merged: number }[]; perWeek: { week: string; merged: number }[] };
  cost: { totalUsd: number; perMergedPrUsd: number | null; byStage: { stage: ThroughputStage; usd: number; perMergedPrUsd: number | null; share: number }[]; byModel?: { model: string; usd: number; perMergedPrUsd: number | null; share: number; tokensIn?: number; tokensOut?: number; secs?: number; perMergedPrTokens?: number | null }[]; evaluatorOnL0Usd: number };
  waits: { kind: string; label: string; owner: boolean; count: number; open: number; medianHours: number | null; totalHours: number; reasons: { reason: string; count: number }[] }[];
  top: { stage: ThroughputStage; usd: number; share: number; suggestion: string }[];
}

/** Waiting on you (GET /api/waiting, src/digest.ts): every owner-held state open now, and the digest's Markdown. */
export type WaitKind = 'emergency_halt' | 'merge_stopped' | 'main_checks_timed_out' | 'awaiting_decision' | 'plan_held' | 'needs_owner' | 'ci_fix_gave_up' | 'blocked' | 'landing_failed' | 'deploy_failed' | 'check_held' | 'hotspot_held' | 'update_held';
export interface WaitItem {
  kind: WaitKind;
  since: string;
  issue: number | null;
  pr: number | null;
  title: string | null;
  detail: string;
  sha?: string;
}
/** A PR merged on its own since the last digest, for sampling: its review level and the evaluator's confidence. */
export interface MergedItem {
  pr: number;
  issue: number;
  title: string;
  url: string;
  at: string;
  level: string | null;
  confidence: string | null;
}
export interface Waiting {
  at: string;
  items: WaitItem[];
  mergedSince: string;
  merged: MergedItem[];
  /** PR batches running now or active since `mergedSince`. */
  batches?: { id: string; status: PrBatchStatus; prs: { issue: number; number: number }[]; detail: string; at: string; last: string }[];
  /** The daily digest as posted to GitHub. */
  markdown: string;
}

/** A PR batch's status (src/coordinator/pr-batch.ts). */
export type PrBatchStatus = 'testing' | 'bisecting' | 'green' | 'red' | 'abandoned' | 'empty';
/** A Landing-column PR batch; a viewer's has no detail. */
export interface BoardBatch {
  id: string;
  status: PrBatchStatus;
  prs: number[];
  issues: number[];
  at: string;
  detail?: string;
}

/** An agent slot's holder; another instance's (or a job's) is `elsewhere`, with no owner or pid (src/dashboard.ts ownHolders). */
export interface SlotHolder {
  slot: string;
  owner: string;
  pid?: number;
  acquiredAt: string;
  elsewhere?: true;
}

/** The Board (GET /api/board, src/board.ts): one instance's tasks in flight by stage, with what this person may do on each. */
export type BoardColumn = 'planning' | 'building' | 'verifying' | 'waiting' | 'landing';
export interface BoardCard {
  instance: string;
  issue: number;
  title: string;
  column: BoardColumn;
  status: TaskStatus;
  /** A viewer's card has the PR's number and link only. */
  pr: { number: number; url: string; phase?: PrView['phase'] } | null;
  // The owner's and writers' only: a viewer's card leaves these out (src/board.ts VIEWER_CARD_FIELDS).
  diff?: { added: number | null; removed: number | null; lines: number; files: number; source: 'pr' | 'change' } | null;
  comments?: number | null;
  startedAt: string;
  since: string;
  checks?: { state: 'failing' | 'pending' | 'passing' | 'none'; source: 'pr' | 'coordinator' | null; items: { name: string; outcome: string }[] };
  run?: { role: string; model: string; startedAt: string; lastHeartbeat: string | null; note: string | null; live: string | null; usage: { rssBytes: number; cpuSeconds: number; processes: number } | null } | null;
  waiting: { kind: WaitKind; label: string; detail: string | null; since: string } | null;
  decision: { id: string; kind: string; question: string; options: string[]; recommendation: string } | null;
  level: string | null;
  /** Its PR head with the PR batches: queued, being tested, passed or returned (absent from older servers). */
  batch?: { status: 'queued' | 'testing' | 'passed' | 'returned'; id: string | null } | null;
  highRisk: boolean;
  actions: { watch: 'feed' | null; steer: boolean; answer: boolean; approve: { decision: string; options: string[] } | { merge: string } | null };
}
export interface BoardData {
  instance: string;
  role: Role;
  at: string;
  columns: { id: BoardColumn; label: string }[];
  cards: BoardCard[];
  slots: { cap: number; running: number };
  /** The Landing column's PR batches (absent from older servers). */
  batches?: BoardBatch[];
}

/**
 * A call to one instance in this page's scope: through the hub to the named one (`/api/i/<name>/...`), or the
 * instance this page shows (null: the selected one on a hub, else this page's own server). An instance outside the scope (not the selected one, unless "All instances" is on) is
 * refused before anything is asked, so no page can show another instance's data by mistake.
 */
export async function onInstance<T>(instance: string | null, path: string, init: RequestInit = {}, scope: Promise<InstanceScope> = instanceScope): Promise<T> {
  const s = await scope;
  if (instance !== null && !s.instances.includes(instance)) throw new Error(`instance ${instance} isn't selected: choose it, or All instances, in the switcher`);
  return instance ? instanceApi<T>(instance, path, init) : api<T>(path, init);
}
/** A stream's URL on one instance in this page's scope (as onInstance): through the hub to the named one, or this page's own server (null). */
export async function instanceStream(instance: string | null, path: string, scope: Promise<InstanceScope> = instanceScope): Promise<string> {
  if (instance !== null && !(await scope).instances.includes(instance)) throw new Error(`instance ${instance} isn't selected`);
  return streamUrl(instance ? path.replace(/^\/api\//, `/api/i/${encodeURIComponent(instance)}/`) : await apiPath(path));
}
