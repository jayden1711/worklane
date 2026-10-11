import { useCallback, useEffect, useRef, useState } from 'react';

export type TaskStatus =
  | 'triage' | 'ready' | 'claimed' | 'reproducing' | 'building' | 'verifying' | 'evaluating'
  | 'awaiting_decision' | 'queued' | 'landed' | 'done' | 'blocked' | 'released';

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
  costUsd: number;
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
  receipts: string[];
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
  mainResult: { at: string; outcome: 'green' | 'red'; failed: string[] } | null;
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
    days: { day: string; runs: number; estimatedUsd: number; turns: number; rateLimited: number; authProblems: number; retries: Record<string, number>; retryWaitMs: number; lockWaits: number; lockWaitMs: number }[];
    quotaNote: string;
  };
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
  project: { name: string; repo: string; landMode: string };
  user: string;
  owners: { default: string; writers: string[]; areas: { name: string; owner: string; paths: string[]; labels: string[] }[] };
  budget: number;
  slots: { cap: number; running: number; agents: { slot: string; owner: string; pid: number; acquiredAt: string }[]; fullRun: { owner: string; acquiredAt: string } | null };
  lastId: number;
  tasks: Task[];
  decisions: Decision[];
  /** Every cost figure is an estimate (the agent CLI's own per-run cost estimate), not money billed. */
  costBasis: 'estimate';
  spendToday: number;
  spendByRole: Record<string, number>;
  landedToday: number;
  baseline: { sha: string; failing: string[]; at: string } | null;
  deploys: { env: string; sha: string; status: string; why?: string; at: string }[];
  coordinator: { instance: string; startedAt: string; lastTick: string | null } | null;
  errors: { at: string; where: string; message: string }[];
  activity: Activity[];
  inbox: { decisions: Decision[]; blocked: Task[]; notify: Task[] };
  runs: { active: Run[]; recent: Run[] };
  landQueue: { issue: number; title: string; head: string; level: string; queuedAt: string; deferred: string | null }[];
  batches: { id: string; issues: number[]; tip: string; outcome: string; detail: string; at: string }[];
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
}

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

export const getSettings = () => api<Settings>('/api/settings');

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
  return get('/api/hub', { headers: { authorization: `Bearer ${auth}` } })
    .then((r) => (r.ok ? (r.json() as Promise<HubInfo>) : null))
    .catch(() => null);
}
export const hub: Promise<HubInfo | null> = inBrowser ? probeHub(!!document.querySelector('meta[name="dashboard-hub"]')) : Promise.resolve(null);

/** The instance a hub page shows: the one picked last in this tab, else the first that answers. */
export const hubInstance: Promise<string | null> = hub.then((h) => {
  if (!h?.instances.length) return null;
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem('dash-instance');
  } catch {
    // no storage: the default
  }
  return h.instances.find((i) => i.name === saved)?.name ?? h.instances.find((i) => i.up)?.name ?? h.instances[0]!.name;
});

/** Show another instance (hub only): everything reloads from that instance's own server. */
export function selectInstance(name: string) {
  try {
    sessionStorage.setItem('dash-instance', name);
  } catch {
    // no storage: this tab can't switch
  }
  window.location.reload();
}

/** An API path as this page reaches it: on a hub, through the selected instance's own server. */
async function apiPath(path: string): Promise<string> {
  const inst = await hubInstance;
  return inst ? path.replace(/^\/api\//, `/api/i/${encodeURIComponent(inst)}/`) : path;
}

/** A call to one named instance's own server through the hub (`/api/i/<name>/...`), whichever instance this page shows. */
export async function instanceApi<T>(name: string, path: string): Promise<T> {
  const res = await fetch(path.replace(/^\/api\//, `/api/i/${encodeURIComponent(name)}/`), { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(await apiPath(path), { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
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
      es = new EventSource(`${p}?t=${encodeURIComponent(token)}`);
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

export interface SavedView { name: string; filters: Filters }
export interface Filters { owner?: string; status?: string; level?: string; label?: string; text?: string }

export const listViews = () => api<SavedView[]>('/api/views');
export const saveViews = (v: SavedView[]) => api('/api/views', { method: 'PUT', body: JSON.stringify(v) });
