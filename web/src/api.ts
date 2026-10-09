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

function readToken(): string {
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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
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
    const es = new EventSource(`/api/stream?t=${encodeURIComponent(token)}`);
    es.addEventListener('hello', () => setLive(true));
    es.addEventListener('change', () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void refresh();
        setPulse((p) => p + 1);
      }, 150);
    });
    es.onerror = () => setLive(false);
    return () => es.close();
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
