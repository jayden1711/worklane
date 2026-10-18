import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { openStream, type Stream, type StreamOptions } from './sse';
import { coalesced, forgetAll, forgetInstance, instanceOf, keep, markUpdating, peek } from './cache';

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
  /** An owner's only: why it can never be approved by voice (src/voice.ts), or null when it can. */
  voiceRefused?: string | null;
}

/** A decision's (or a held PR's, `pr-<n>`) detail, GET /api/decisions/:id (src/decision-detail.ts). Null: not recorded. */
export interface DecisionDetail {
  id: string;
  kind: 'land' | 'question' | 'domain' | 'plan' | 'intake' | 'delegation' | 'automation' | 'pr';
  issue: number | null;
  owner: string;
  question: string;
  options: { option: string; does: string; cannot: string; recommended: boolean }[];
  recommendation: string;
  askedAt: string;
  answer: { by: string; answer: string; at: string } | null;
  canAnswer: boolean;
  ifNothing: string;
  /** A viewer's: why the rest isn't here. */
  withheld: string | null;
  title?: string | null;
  summary?: { happened: string; agent: string | null };
  reasoning?: string[];
  receipts?: string[];
  findings?: { list: { claim: string; evidence: string; file?: string; line?: number; severity?: string; confidence?: string }[]; confidence: string | null; unverified: string[] } | null;
  change?: { base: string | null; head: string | null; files: { path: string; added: number | null; removed: number | null }[]; filesMore: number; level: string | null; levelReasons: string[]; source: 'asked' | 'log' } | null;
  verdict?: { patch_correct: boolean; test_correct: boolean; confidence: string; confidenceReason: string | null; advice: string; unread: string[]; unverifiedClaims: string[]; designChange: boolean | null; designReason: string | null } | null;
  tests?: { check: string; status: string; duration_ms: number | null; tail?: string }[] | null;
  tampered?: string[];
  pr?: { number: number; url: string; head: string; phase: string; draft: boolean; checks: { name: string; outcome: string }[]; checksOnHead: boolean; waitReasons: string[]; why: { category: string; text: string }[] } | null;
  impact?: { flags: { flag: 'money-path' | 'auth' | 'secrets'; files: string[] | null }[]; others: string[]; note: string | null };
  runs?: { id: string; role: string; model: string; startedAt: string; endedAt: string | null; reason: string | null }[] | null;
  auth?: { failed: { at: string; role: string; detail: string }[]; held: { login: string; detail: string; since: string } | null };
  diff?: 'owner' | 'owners-only' | 'none';
  prBody?: boolean;
  ownerOnly?: string | null;
}
/** A decision's change as a diff (owners only), or why there's none. */
export type DecisionDiff = { diff: string; truncated: boolean } | { diff: null; why: string };
/** A decision's PR body: its fail-without and "never" sections (null: the body has none), or why it couldn't be read. */
export interface DecisionPrBody {
  pr: number | null;
  failWithout: string | null;
  never: string | null;
  why: string | null;
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
  /** Why a run that didn't succeed ended: Claude's error text or its stderr's tail (redacted). Absent in older records. */
  detail?: string;
  /** What the session loaded beyond Claude Code itself (approved plugins and MCP servers). */
  loaded?: { plugins: string[]; mcpServers: string[] };
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
  /** The machine's outbound proxy and custom CA from root's network.json (src/network.ts), or why the file was refused; null when neither (or for a viewer). */
  network?: { proxy: string | null; file: string; ca: { path: string; count: number; fingerprints: string[] } | null; error: string | null } | null;
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
  holds: { issue: number; title: string; by: number; files: string[]; reason: string; since: string; until: string | null; waitedMs: number | null; kind?: 'files' | 'dependency' }[];
  /** Whether this instance merges its own PRs now, and why (or why not). */
  autoMerge: { on: boolean; policy: boolean | null; repo: boolean | null; stopped: string | null; why: string };
  /** The latest stale-PR pass: its counts and their line; null before the first (absent from an older server). */
  hygiene?: { at: string; merged_in: number; conflicting: number; closed: number; held: number; skipped: number; line: string } | null;
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

/** A goal's task graph (GET /api/goal-graph?issue=n, src/goal-graph.ts): `from` finishes before `to` starts. */
export interface GoalGraph {
  goal: number;
  split: boolean;
  nodes: { issue: number; key: string | null; title: string; status: TaskStatus | null; pr: { number: number; url: string } | null; run: string | null; cycle: boolean; layer: number }[];
  edges: { from: number; to: number; cycle: boolean }[];
  cycles: number[][];
  total: number;
  capped: boolean;
}

export interface Activity { id: number; ts: string; type: string; actor: string; issue: number | null; summary: string }

/** One coordinator error, grouped by where and message (src/projection.ts CoordinatorError). */
export interface CoordinatorError {
  where: string;
  message: string;
  kind?: string;
  count?: number;
  first?: string;
  last?: string;
  at: string;
}

export interface State {
  brand: { name: string; cli: string };
  /** Setup mode (src/setup-mode.ts): no config yet; the first-run page is the whole dashboard. */
  setupMode?: boolean;
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
  project: { name: string; repo: string; landMode: string; ci?: CiMode };
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
  /**
   * The coordinator's errors still current (a later tick or a restart clears one: src/projection.ts), one per place
   * and message with how many times, first and last; a viewer gets only how many (errorCount), never their text.
   */
  errors?: CoordinatorError[];
  /** Errors no longer current, newest first: history only (owners and writers). */
  earlierErrors?: CoordinatorError[];
  errorCount?: number;
  activity: Activity[];
  inbox: { decisions: Decision[]; blocked: Task[]; notify: Task[] };
  runs?: { active: Run[]; recent: Run[] };
  landQueue: { issue: number; title: string; head: string; level: string; queuedAt: string; deferred: string | null }[];
  /** Direct landing's batches (`land`) and PR mode's (`pr`, with its PRs); a viewer's have no tip or detail. */
  batches: { id: string; kind?: 'land' | 'pr'; issues: number[]; prs?: number[]; tip?: string; outcome: string; detail?: string; at: string }[];
  /** The last hold or release; `banner` while held (absent from older servers). */
  governor: { held: boolean; reason: string | null; load: number | null; freeDiskPct: number | null; at: string; banner?: HoldBanner | null } | null;
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
  /** The pre-deploy gate, when tests.yaml has one (owners and writers only). */
  deployGate?: DeployGate;
}

/** The pre-deploy gate: the commit the deploy branch is at, the last held commit and why, and a refusal in force. */
export interface DeployGate {
  branch: string;
  /** tests.yaml deploy_gate.enabled: false (the default) means configured, off: nothing runs or moves. */
  enabled: boolean;
  /** The test_run tiers that must pass before the branch moves. */
  tiers: string[];
  /** Whether a post-deploy check is configured. */
  postDeploy: boolean;
  deployed: { sha: string; url: string; at: string | null; by: string | null; override: boolean } | null;
  held: { sha: string; url: string; at: string; reason: string } | null;
  refused: { at: string; reason: string } | null;
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
  /** The last commit that landed without a PR, and its ops-channel alert (owners and writers). */
  directPush?: DirectPush | null;
}

export interface DirectPush {
  at: string;
  sha: string;
  url: string;
  kind: 'direct' | 'rewrite';
  pusher: string | null;
  /** posted; pending (the ops posts' limit); not_posted (with `note` saying why); off (turned off). */
  status: 'posted' | 'pending' | 'not_posted' | 'off';
  mentioned: number;
  note: string | null;
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
  /** Whether this dashboard has the First run page's Discord step (a server instance's). */
  discordSetup?: boolean;
  configDir: string;
  project: { name: string; repo: string; landMode: string; runtime: unknown; ci?: CiMode };
  owners: State['owners'];
  reports: { times: string[]; to: string[] };
  governor: { max_load?: number; min_free_disk_pct: number; min_free_disk_gb?: number };
  /** The disk floor on this machine now; null when it can't be measured (absent from older servers). */
  diskFloor?: DiskFloor | null;
  agents: { budget: number; roles: { name: string; enabled: boolean; model: string; count: number | null }[] };
  /** INVARIANT: `from` null means the engine's default (item 32). */
  routing: { key: string; task: string; value: string | number | boolean | string[]; from: string | null }[];
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

/**
 * INVARIANT: the key is read from this tab's storage only, never from the address bar: the servers refuse a request
 * whose URL carries a key (src/dashboard.ts keyInUrl), so a page opened that way never loads. The key page puts it here.
 */
function readToken(): string {
  if (!inBrowser) return '';
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
/** Whether the hub served this page (its sign-in or break-glass port); false on an instance's own dashboard. */
export const servedByHub = inBrowser && !!document.querySelector('meta[name="dashboard-hub"]');
export const me: Promise<Me | null> = probeMe(servedByHub);
/** Whether this page needs a sign-in: a hub page, with no session and no break-glass token. */
export const needsSignIn: Promise<boolean> = me.then((m) => servedByHub && !m);

/** WHY: the install's URL carries no key (src/dashboard-detach.ts), so an instance's own page opened by it asks for one. */
export const needsKey = (hubPage: boolean, key: string) => !hubPage && !key;
export const keyMissing = inBrowser && needsKey(servedByHub, token);
/** WHY: the hub's break-glass port takes the key too; its sign-in port never does, so the form shows on loopback only. */
export const onLoopback = inBrowser && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);

/**
 * INVARIANT: a key is tried (in a header, never a URL) before it is kept, and kept in this tab only. On a hub only the break-glass answer counts: its sign-in port says 200 to anyone.
 */
export async function tryKey(given: string, o: { hub: boolean; get?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>; store?: Pick<Storage, 'setItem'> }): Promise<boolean> {
  const key = given.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return false;
  const r = await (o.get ?? fetch)(o.hub ? '/api/me' : '/api/role', { headers: { authorization: `Bearer ${key}` } }).catch(() => null);
  if (!r?.ok) return false;
  if (o.hub && !((await r.json()) as { breakGlass?: boolean }).breakGlass) return false;
  (o.store ?? sessionStorage).setItem('dash-token', key);
  return true;
}

let csrf = '';
void me.then((m) => {
  csrf = m?.csrf ?? '';
});

/** What every API call carries: the break-glass token when there is one, and this session's CSRF token (every write needs it). */
async function authHeaders(): Promise<Record<string, string>> {
  await me;
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), 'content-type': 'application/json' };
}

/**
 * The subprotocols the owner terminal's WebSocket offers: its own (src/dashboard-auth.ts TERMINAL_PROTOCOL) and the
 * session's CSRF token as `csrf.<token>` (CSRF_PROTOCOL_PREFIX), since a browser can't set headers on the upgrade.
 * The token never goes in the URL; the hub answers with the terminal's protocol alone.
 */
export async function terminalProtocols(): Promise<string[]> {
  await me;
  return ['terminal.v1', ...(csrf ? [`csrf.${csrf}`] : [])];
}

/**
 * A live stream (server-sent events) at `path`, read with fetch so the break-glass key goes in the Authorization
 * header like every other call (a session's cookie goes by itself). It reconnects after a drop, with Last-Event-ID.
 * INVARIANT: no stream URL carries the key; EventSource, which can't send headers, isn't used (test/web-key-in-url.test.ts).
 */
export function liveStream(path: string | Promise<string>, on: StreamOptions['on'], o: Pick<StreamOptions, 'onOpen' | 'onError'> = {}): Stream {
  return openStream(path, { headers: async (): Promise<Record<string, string>> => (await me, token ? { authorization: `Bearer ${token}` } : {}), on, ...o });
}

/** Sign out: the hub deletes the session (server-side), then the page shows the sign-in again. */
export async function signOut(): Promise<void> {
  // Nothing read in this session stays, even for the moment before the page leaves.
  forgetAll();
  await fetch('/auth/logout', { method: 'POST', headers: await authHeaders(), body: '{}' }).catch(() => undefined);
  try {
    sessionStorage.removeItem('dash-instance');
    sessionStorage.removeItem('dash-all-instances');
  } catch {
    // nothing kept
  }
  window.location.assign('/');
}

/** An instance's Claude usage (/api/usage): the usage-limit pause in force, and today's runs and limit hits (UTC day). */
export interface UsageInfo {
  instance: string;
  paused: { since: string; resetAt: string; source: 'claude' | 'default'; kind: string | null } | null;
  today: { runs: number; limitHits: number };
  lastHit: string | null;
  /** Claude logins the API refused (no new runs on them until a call succeeds): the account and Claude's words, never a token. */
  signinFailed?: { login: string; detail: string; since: string; lastCheck: { at: string; ok: boolean; detail: string } | null }[];
  /** This viewer may ask the coordinator to re-check a refused login now. */
  canRecheckSignin?: boolean;
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
// WHY asked beside /api/me, not after it: one round trip less before any data. Signed out, the hub refuses it (401)
// and the answer is dropped; what it lists is still only the instances this person has a role on.
const hubAsked = inBrowser ? probeHub(servedByHub) : Promise.resolve(null);
export const hub: Promise<HubInfo | null> = inBrowser ? needsSignIn.then((n) => (n ? null : hubAsked)) : Promise.resolve(null);

/**
 * The hub's list again, from a fresh answer: it replaces the last one when it differs (an instance that was down at
 * page load, during an update's restart, is up again); no answer (the hub itself didn't answer, or refused) keeps the
 * last one rather than emptying the sidebar.
 */
export function nextHub(prev: HubInfo | null, fresh: HubInfo | null): HubInfo | null {
  if (!fresh) return prev;
  return prev && JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh;
}
/** The hub's list as last read: this page's first answer, then each refresh's (refreshHub). */
let latestHub: Promise<HubInfo | null> = hub;
/** The same, once read: what an instance switch picks from without waiting. */
let latestHubNow: HubInfo | null = null;
void hub.then((h) => {
  latestHubNow ??= h;
});
/** The hub's instances as last read, synchronously (null before the first answer, or off a hub). */
export const hubNow = (): HubInfo | null => latestHubNow;
/** The hub's instances as last read, without asking again. */
export const currentHub = (): Promise<HubInfo | null> => latestHub;
/** Ask the hub for its instances again (each health refresh does): whether each answers now, not at page load. */
export async function refreshHub(probe: () => Promise<HubInfo | null> = () => (servedByHub ? needsSignIn.then((n) => (n ? null : probeHub(servedByHub))) : Promise.resolve(null))): Promise<HubInfo | null> {
  const prev = await latestHub;
  const next = nextHub(prev, await probe());
  latestHub = Promise.resolve(next);
  latestHubNow = next;
  return next;
}

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
/**
 * The scope this page shows now. An instance switch changes it in place (no reload): `instanceScope` and
 * `hubInstance` are live bindings, so whatever asks after the switch gets the new one, and the Dashboard is keyed on
 * it (App.tsx), so every view below it starts again for the new instance, from what was kept for that instance.
 */
let scopeNow: InstanceScope | null = null;
const scopeListeners = new Set<() => void>();
/**
 * On a hub page, the state of the instance this tab showed last, asked for beside /api/me and /api/hub rather than
 * after them (two round trips less before the first data). The hub checks the session and the role on it as for any
 * call; it is kept only if answered, under that instance's own key, and shown only if the scope turns out to be it.
 */
if (inBrowser && servedByHub && !keyMissing) {
  const last = saved('dash-instance');
  if (last && saved('dash-all-instances') !== '1') void request(`/api/i/${encodeURIComponent(last)}/state`, { prefetch: true, early: true } as RequestInit).catch(() => undefined);
}
export let instanceScope: Promise<InstanceScope> = hub.then((h) => (scopeNow = scopeOf(h, saved('dash-instance'), saved('dash-all-instances') === '1')));
/** The instance a hub page shows: the one picked last in this tab, else the first that answers. */
export let hubInstance: Promise<string | null> = instanceScope.then((s) => s.current);
/** The scope now, synchronously: null until the hub's first answer (or its absence) is in. */
export const scopeNowOrNull = (): InstanceScope | null => scopeNow;
/** A key for the scope ('' off a hub): what the Dashboard is keyed on. */
export const scopeKey = (s: InstanceScope | null): string => (s ? `${s.all ? 'all:' : ''}${s.current ?? ''}` : '');
/** The scope, as a hook: re-renders on a switch. */
export function useScope(): InstanceScope | null {
  return useSyncExternalStore(
    (l) => (scopeListeners.add(l), () => void scopeListeners.delete(l)),
    () => scopeNow,
    () => null,
  );
}
function setScope(s: InstanceScope) {
  scopeNow = s;
  instanceScope = Promise.resolve(s);
  hubInstance = Promise.resolve(s.current);
  for (const l of scopeListeners) l();
}

/** Show another instance (hub only), and only it: every view starts again on that instance's own server, from what was kept for it. */
export function selectInstance(name: string) {
  try {
    sessionStorage.setItem('dash-instance', name);
    sessionStorage.removeItem('dash-all-instances');
  } catch {
    // no storage: the switch still holds for this page
  }
  const h = latestHubNow;
  if (!h) return window.location.reload();
  setScope(scopeOf(h, name, false));
}
/** "All instances" (hub only): the Board and its test runs show every instance this person has a role on, labelled. */
export function selectAllInstances() {
  try {
    sessionStorage.setItem('dash-all-instances', '1');
  } catch {
    // no storage: the switch still holds for this page
  }
  const h = latestHubNow;
  if (!h || !scopeNow) return window.location.reload();
  setScope(scopeOf(h, scopeNow.current, true));
}

/** An API path as this page reaches it: on a hub, through the selected instance's own server. */
export async function apiPath(path: string): Promise<string> {
  const inst = await hubInstance;
  return inst ? path.replace(/^\/api\//, `/api/i/${encodeURIComponent(inst)}/`) : path;
}

/** The sizes the server fetches people's pictures at (src/avatars.ts AVATAR_SIZES; test/avatars.test.ts keeps them the same). */
export const AVATAR_SIZES = [40, 80, 160];
const avatarUrls = new Map<string, Promise<string | null>>();

/**
 * A person's picture for a box of `box` px, as a blob: URL the page shows, or null (the page shows initials). Read from
 * this page's own server with the page's own auth, never from GitHub (#462): an <img> can't send the key in a header.
 * Asked once per picture while the page is open, whatever the answer (initials until a reload when there was none).
 */
export async function avatarSrc(login: string, box: number): Promise<string | null> {
  const size = AVATAR_SIZES.find((s) => s >= box * 2) ?? AVATAR_SIZES[AVATAR_SIZES.length - 1]!;
  const url = await apiPath(`/api/avatar/${encodeURIComponent(login)}?size=${size}`);
  let p = avatarUrls.get(url);
  if (!p) {
    p = (async () => {
      await me;
      const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!r.ok || !/^image\/(?:png|jpeg|gif|webp)$/.test(r.headers.get('content-type') ?? '')) return null;
      return URL.createObjectURL(await r.blob());
    })().catch(() => null);
    avatarUrls.set(url, p);
  }
  return p;
}

/** A call to one named instance's own server through the hub (`/api/i/<name>/...`), whichever instance this page shows. */
export async function instanceApi<T>(name: string, path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path.replace(/^\/api\//, `/api/i/${encodeURIComponent(name)}/`), init);
}

/**
 * The URL a view is read at, now: on a hub through the named instance (null or absent: the selected one), else this
 * page's own server. What the cache keys on (cache.ts), synchronously, so a page can show what was kept before it asks.
 */
export function viewUrl(path: string, instance?: string | null): string {
  const inst = instance ?? scopeNow?.current ?? null;
  return inst ? path.replace(/^\/api\//, `/api/i/${encodeURIComponent(inst)}/`) : path;
}

/**
 * Every call: a GET (no body) asked once at a time per URL (cache.ts coalesced) and its answer kept when it is a listed
 * view; a refusal forgets what it says is no longer this person's (a 401 everything; a 403 on /state that instance's).
 */
async function request<T>(url: string, init: RequestInit): Promise<T> {
  const get = (!init.method || init.method === 'GET') && init.body === undefined;
  const { early, prefetch, ...rest } = init as RequestInit & { early?: boolean; prefetch?: boolean };
  const go = async () => {
    // Early (a GET before /api/me is in): the key if any; a session goes by its cookie, and a GET needs no CSRF token.
    const headers = early ? { ...(token ? { authorization: `Bearer ${token}` } : {}) } : await authHeaders();
    const res = await fetch(url, { ...rest, headers: { ...(rest.headers ?? {}), ...headers } });
    try {
      const d = await answer<T>(res);
      if (get) keep(url, d);
      return d;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) forgetAll();
        else if (e.status === 403 && /\/state(?:\?|$)/.test(url)) forgetInstance(instanceOf(url));
      }
      throw e;
    }
  };
  return get ? coalesced(url, go, !prefetch) : go();
}

/** A GET in the background, at low priority: what was kept is refreshed; a GET of it already in flight is enough. */
export function prefetchView(path: string, instance?: string | null): Promise<unknown> {
  return request(viewUrl(path, instance), { priority: 'low', prefetch: true } as RequestInit);
}

/**
 * A view, shown at once from what was kept for this instance (marked "updating…" until the fresh answer comes), read
 * again on mount and whenever `dep` changes. A refusal hides it; any other failure keeps the last good data with the
 * error. `path` null: nothing asked (refused before asking).
 */
export function useView<T>(path: string | null, dep: unknown = 0, instance?: string | null): { data: T | null; error: string | null; updating: boolean } {
  const url = path === null ? null : viewUrl(path, instance);
  const init = (u: string | null) => {
    const k = u === null ? undefined : peek<T>(u);
    return { url: u, data: k ? k.data : null, error: null as string | null, updating: !!k };
  };
  const [st, setSt] = useState(() => init(url));
  let cur = st;
  if (st.url !== url) {
    // Another view (or instance) from now on: never one moment of the last one's data under it.
    cur = init(url);
    setSt(cur);
  }
  useEffect(() => {
    if (url === null) return;
    let live = true;
    const unmark = cur.updating ? markUpdating() : () => {};
    request<T>(url, {}).then(
      (data) => live && setSt({ url, data, error: null, updating: false }),
      (e: Error) => live && setSt((p) => (p.url !== url ? p : isRefusal(e) ? { url, data: null, error: e.message, updating: false } : { ...p, error: e.message, updating: false })),
    ).finally(unmark);
    return () => {
      live = false;
      unmark();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, dep]);
  return { data: cur.data, error: cur.error, updating: cur.updating };
}

/** A server's answer that wasn't a success, with its HTTP status: a refusal (isRefusal) or something to retry. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Not signed in, not allowed, or no such view on this server: an answer, not a hiccup. Anything else is transient. */
export const isRefusal = (e: unknown): boolean => e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404);

async function answer<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // A proxy's 502 page is no JSON: its status still says what it was.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(await apiPath(path), init);
}

/**
 * State from the server, refetched whenever the event log changes (one SSE stream: the instance shown). Shown at once
 * from what was kept for this instance (an instance or page switch), marked "updating…" until the fresh answer.
 */
export function useLiveState() {
  const url = viewUrl('/api/state');
  const [state, setState] = useState<State | null>(() => peek<State>(url)?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [pulse, setPulse] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async (first = false) => {
    try {
      // The first load takes an answer already on its way (the early ask); every later one asks again.
      setState(await request<State>(url, first ? ({ prefetch: true } as RequestInit) : {}));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url]);

  useEffect(() => {
    const unmark = peek(url) ? markUpdating() : () => {};
    void refresh(true).finally(unmark);
    const es = liveStream(
      apiPath('/api/stream'),
      {
        hello: () => setLive(true),
        change: () => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            void refresh();
            setPulse((p) => p + 1);
          }, 150);
        },
      },
      { onError: () => setLive(false) },
    );
    return () => {
      unmark();
      window.clearTimeout(timer.current);
      es.close();
    };
  }, [url, refresh]);

  return { state, error, live, pulse, refresh };
}

/** The tab's state, sent with everything done by voice: the server refuses it unless both are true. */
export type VoiceTab = { focused: boolean; visible: boolean };

/** Answer a decision; `voice`: said by voice (an approval only; the server adds its voice checks). */
export async function decide(id: string, answer: string, voice?: VoiceTab) {
  return api<{ ok: boolean }>('/api/decide', { method: 'POST', body: JSON.stringify({ id, answer, ...(voice ? { voice } : {}) }) });
}

/** Send a spoken idea the owner confirmed to the instance's intake (POST /api/voice/intake). */
export async function voiceIntake(text: string, voice: VoiceTab) {
  return api<{ ok: boolean; id: string }>('/api/voice/intake', { method: 'POST', body: JSON.stringify({ text, voice }) });
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
  state: 'pending' | 'started' | 'done' | 'failed' | 'ask' | 'waiting';
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
  /** When the machine helper can't run add-project here (an older sudo): why, and the root script to run instead; absent from older servers. */
  manual?: { sudo: string | null; why: string; script: string } | null;
}
export const getAddProject = () => api<AddProjectData>('/api/add-project');
/** Add project's repo picker (GET /api/add-project/repos, src/setup/repo-picker.ts): an account's repos to pick from. */
export interface PickableRepo {
  fullName: string;
  private: boolean;
  installable: boolean;
  why: string | null;
  pushedAt: string | null;
}
export interface RepoPickerData {
  owner: string;
  ownerType: 'User' | 'Organization' | null;
  accounts: string[];
  repos: PickableRepo[];
  note: string;
  error: string | null;
}
export const getAddProjectRepos = (owner?: string) => api<RepoPickerData>(`/api/add-project/repos${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`);

/** The first-run checklist (GET /api/first-run, src/init.ts firstRunView): init's steps as it recorded them. */
export type FirstRunStatus = 'pending' | 'done' | 'skipped' | 'failed';
export interface FirstRunStep {
  id: string;
  title: string;
  optional: boolean;
  status: FirstRunStatus;
  detail: string;
  at: string | null;
}
export interface FirstRun {
  /** The machine check: the disk floor now (null in setup mode or unmeasurable; absent from older servers). */
  diskFloor?: DiskFloor | null;
  recorded: boolean;
  mode: 'local' | 'server' | null;
  steps: FirstRunStep[];
  done: number;
  total: number;
  unavailable: { feature: string; why: string }[];
  updatedAt: string | null;
  finishedAt: string | null;
  command: string;
  /** Auto-config (src/auto-config.ts): its open questions with their choices, each command's run on the default branch, the setup PR. */
  autoConfig: FirstRunAutoConfig | null;
  /** Every setup step that applies to the mode, checked live (src/setup-steps.ts); doctor shows the same. */
  setup: SetupView | null;
  /** What Start would change, shown before it does anything. */
  start: FirstRunStart;
  /** Whether this viewer may press Start (the instance's owners). */
  canStart: boolean;
  /** Each open Fix action's plan, by action id (src/setup-actions.ts), shown before it runs. */
  actions?: Record<string, FirstRunActionPlan>;
  /** Whether this viewer may run a Fix action (the instance's owners). */
  canAct?: boolean;
  /** A server instance's policy form (src/policy-edit.ts); null for a checkout. */
  policy?: FirstRunPolicy | null;
  /** A checkout's Repo config form, from the default branch's config (src/config-change.ts); null on a server. */
  repoConfig?: FirstRunRepoConfig | { error: string } | null;
  /** Setup mode (src/setup-mode.ts): the checkout has no config yet; this page is the whole dashboard. */
  setupMode?: boolean;
  /** Setup mode: the checkout's own config loads now (the dashboard takes over shortly). */
  configReady?: boolean;
  draft?: DraftJob;
  /** #468: every config PR the page proposed (and init's setup PR), followed to its end; absent from older servers. */
  configPrs?: ConfigPr[];
}
/** A config PR as the page follows it (src/config-pr.ts): open, closed, or merged and this checkout brought to it. */
export interface ConfigPr {
  number: number;
  url: string;
  kind: 'setup' | 'config';
  base: string;
  state: 'open' | 'merged' | 'closed' | 'unknown';
  mergedBy: string | null;
  mergedAt: string | null;
  synced: boolean;
  sha: string | null;
  why: string | null;
  retry: boolean;
  command: string | null;
}
/** #468: the held draft's preview (src/setup-mode.ts draftView): its summary and its files, read-only. */
export interface HeldDraftView {
  summary: { owner: string; writers: string[]; tests: { slot: string; command: string }[]; dailyBudgetUsd: number; models: { role: string; model: string }[]; waits: string[]; autoMerge: string } | null;
  error: string | null;
  files: { name: string; text: string }[];
  values: RepoConfigValues | null;
  at: string;
}
type ConfigPrAnswer = { ok: boolean; number: number; confirmed: boolean; url?: string; command?: string; then?: string; merged?: boolean; synced?: boolean; detail?: string | null; why?: string; admin?: boolean };
/** Merge one of the page's config PRs here, or fast-forward this checkout to a merged one (confirm false: what it would do). */
export const configPrAction = (number: number, action: 'merge' | 'sync', confirm: boolean) => api<ConfigPrAnswer>('/api/first-run/config-pr', { method: 'POST', body: JSON.stringify({ number, action, confirm }) });
/** The preview's Change: what these values change in the held draft (confirm: the draft changed). */
export const setupDraftValues = (values: Partial<RepoConfigValues>, confirm: boolean) => api<{ ok: boolean; changes: ConfigChange[]; confirmed: boolean }>('/api/first-run/setup/draft-values', { method: 'POST', body: JSON.stringify({ values, confirm }) });
/** The preview's Confirm: the setup PR opened, and merged here when the person is the repo's admin and GitHub allows it. */
export const setupPropose = () => api<ConfigPrAnswer>('/api/first-run/setup/propose', { method: 'POST', body: JSON.stringify({ confirm: true }) });
export interface DraftJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lines: string[];
  result: { status: string; detail: string } | null;
}
export const getSetupRepos = () => api<{ repos: string[]; error?: string }>('/api/first-run/setup/repos');
export const setupOrigin = (repo: string, confirm: boolean) => api<{ ok: boolean; commands?: string[]; repo?: string; confirmed: boolean }>('/api/first-run/setup/origin', { method: 'POST', body: JSON.stringify({ repo, confirm }) });
export const setupAnswers = (answers: Record<string, string>) => api<{ ok: boolean; saved: string[] }>('/api/first-run/setup/answers', { method: 'POST', body: JSON.stringify({ answers }) });
export const setupDraft = () => api<{ ok: boolean; draft: DraftJob }>('/api/first-run/setup/draft', { method: 'POST', body: JSON.stringify({ confirm: true }) });
export interface RepoConfigValues {
  writers: string[];
  required_checks: string[];
  daily_budget_usd: number;
  workers_count: number;
  workers_model: string;
  /** Which CI judges a PR (#469); absent from an older server: github. */
  ci?: 'github' | 'none';
}
/** Which CI judges a PR; under No CI, what that means (said on the PR, land and Settings pages). */
export interface CiMode {
  kind: 'github' | 'none';
  means: string | null;
}
export interface FirstRunRepoConfig {
  values: RepoConfigValues;
  owner: string;
  branch: string;
  repo: string;
  /** The workers' models the engine supports (src/config-change.ts WORKER_MODELS) and its default; absent from older servers. */
  models?: string[];
  defaultModel?: string;
  /** #468: the config's worker model is listed (an alias, or a full Anthropic model id); absent from older servers. */
  modelListed?: boolean;
}
export interface ConfigChange {
  file: string;
  key: string;
  from: unknown;
  to: unknown;
}
/** The checks GitHub ran on the default branch's tip (the required-checks picker's suggestions). */
/** #468: the first-task form's picks (the repo's test files) and the template; `local` false on a server, with why. */
export interface FirstTaskInfo {
  local: boolean;
  why: string | null;
  template: { label: string; body: string };
  tests: string[];
}
export type DoneWhenPick = { test: string } | { command: string; expect?: string };
export interface FirstTaskValues {
  title: string;
  outcome: string;
  done_when: DoneWhenPick[];
  context?: string;
}
export const getFirstTask = () => api<FirstTaskInfo>('/api/first-run/first-task');
/** confirm false: the issue as it would be filed (checked with the coordinator's parser); true: filed, with `ready`. */
export const fileFirstTask = (values: FirstTaskValues, confirm: boolean) => api<{ ok: boolean; title: string; body: string; number?: number; url?: string | null; labelCreated?: boolean; confirmed: boolean }>('/api/first-run/first-task', { method: 'POST', body: JSON.stringify({ values, confirm }) });
/** #468: each open issue the harness isn't working on, and why. */
export interface IgnoredIssue {
  issue: number;
  title: string;
  url: string;
  author: string;
  labels: string[];
  reasons: { kind: 'no-ready' | 'contract' | 'not-writer' | 'waiting' | 'blocked' | 'held'; text: string; fix: 'add-ready' | 'edit' | null }[];
}
export const getIgnored = () => api<{ at: number; issues: IgnoredIssue[]; error: string | null; canFix: boolean; local: boolean }>('/api/issues/ignored');
export const addReady = (issue: number) => api<{ ok: boolean }>(`/api/issues/${issue}/ready`, { method: 'POST', body: '{}' });
export const getChecksSeen = () => api<{ checks: string[]; error?: string }>('/api/first-run/checks-seen');
/** The starter CI (src/starter-ci.ts): a drafted workflow, GitHub's new-file page for it, and its first run on the default branch. */
export interface StarterCi {
  path: string;
  check: string;
  summary: string;
  file: string;
  placeholder: boolean;
  command: string | null;
  branch: string;
  newFile: string;
  onBranch: boolean;
  firstRun: { state: 'none' | 'running' | 'done'; conclusion: string | null };
  /** No CI: offered only where tests.yaml has test_run (`why` says why not); `means`, what it means. */
  noCi: { offered: boolean; means: string; why: string | null };
}
export const getStarterCi = () => api<StarterCi>('/api/first-run/starter-ci');
/** Preview (nothing written) or propose as a PR the config change these values make. */
export const changeRepoConfig = (values: Partial<RepoConfigValues>, confirm: boolean) => api<{ ok: boolean; changes: ConfigChange[]; confirmed: boolean; url?: string; branch?: string }>('/api/first-run/repo-config', { method: 'POST', body: JSON.stringify({ values, confirm }) });
export interface FirstRunPolicyField {
  key: string;
  value: number | boolean | string;
  kind: 'number' | 'boolean' | 'choice';
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
  why: string;
}
export interface FirstRunPolicy {
  fields: FirstRunPolicyField[];
  fixed: { key: string; value: unknown }[];
  error: string | null;
}
export interface PolicyChange {
  key: string;
  from: unknown;
  to: unknown;
}
/** Preview (confirm false: nothing written) or write the policy change these values make. */
export const changePolicy = (values: Record<string, unknown>, confirm: boolean) => api<{ ok: boolean; changes: PolicyChange[]; confirmed: boolean }>('/api/first-run/policy', { method: 'POST', body: JSON.stringify({ values, confirm }) });
export interface FirstRunActionPlan {
  id: string;
  step: string;
  label: string;
  available: boolean;
  why?: string;
  changes: string[];
  commands: string[];
}
/** How the page fixes a step that isn't done (src/setup-steps.ts Fix). */
export type SetupFix =
  | { kind: 'screen'; path: string; label: string }
  | { kind: 'coming' }
  | { kind: 'outside'; url: string | null; label: string; why: string; command?: string }
  | { kind: 'terminal'; command: string; why: string }
  | { kind: 'start' }
  | { kind: 'action'; action: string; label: string }
  | { kind: 'signin'; label: string }
  | { kind: 'form'; form: 'policy' | 'repo-config' | 'setup-origin' | 'setup-config' | 'first-task'; label: string }
  | { kind: 'gh-login'; label: string; command: string }
  | { kind: 'discord'; label: string }
  | { kind: 'source'; source: SourceKind; label: string };
export interface SetupStepView {
  id: string;
  group: string;
  rows: number[];
  title: string;
  optional: boolean;
  /** init's walk needs it for its group, in this mode. */
  walk: boolean;
  reach: 'all' | 'most' | 'some' | 'few';
  done: boolean;
  detail: string;
  today: string;
  fix: SetupFix;
  /** The command or config key that does the same without the page. */
  automation: string | null;
  /** Skipped on the first-run page (not counted as left). */
  skipped: boolean;
  network: boolean;
  checkedAt: string;
}
export interface SetupGroupView {
  id: string;
  title: string;
  optional: boolean;
  done: boolean;
  /** Every step init's walk needs here done: what doctor's line for the group says. */
  ready: boolean;
  steps: SetupStepView[];
}
export interface SetupView {
  mode: 'local' | 'server';
  groups: SetupGroupView[];
  done: number;
  total: number;
  requiredLeft: number;
}
export type FirstRunStart =
  | { kind: 'local'; label: string; file: string; manager: string; commands: string[]; program: string[]; log: string }
  | { kind: 'owner-command'; unit: string; command: string; why: string }
  | { kind: 'unsupported'; why: string };
export interface FirstRunQuestion {
  id: string;
  ask: string;
  choices: { id: string; label: string; command?: string }[];
  custom: boolean;
  about?: string;
}
export interface FirstRunVerification {
  slot: 'setup' | 'full' | 'changed' | 'one';
  command: string;
  base: string;
  code: number | null;
  passed: boolean;
  ms: number;
  tail: string;
  at: string;
}
export interface FirstRunAutoConfig {
  questions: FirstRunQuestion[];
  verified: FirstRunVerification[];
  pr: { number: number | null; url: string } | null;
  /** The command that answers a question. */
  answer: string;
  /** #468: the drafted config held for its preview (setup mode), before any PR; absent from older servers. */
  held?: HeldDraftView | null;
}
export const getFirstRun = (fresh = false) => api<FirstRun>(`/api/first-run${fresh ? '?fresh=1' : ''}`);
/** Start the coordinator's service (the first-run page's Start), after the person confirmed the change it showed. */
/** Run a first-run Fix action after the person confirmed the plan it showed. */
export const runFirstRunAction = (id: string) => api<{ ok: boolean; detail: string }>(`/api/first-run/actions/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
/** Sign in to Claude (src/claude-signin.ts), as GET /api/first-run/claude-signin serves it. */
export interface ClaudeStatusView {
  loggedIn: boolean;
  method: string | null;
  /** Claude Code's cached account email: may predate a token change, so it is shown as cached. */
  cachedAccount: string | null;
}
export type ClaudeSigninData =
  | {
      mode: 'local';
      canAct: boolean;
      state: 'idle' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'timed-out';
      /** Anthropic's sign-in page while waiting (the owners only). */
      url: string | null;
      detail: string;
      startedAt: string | null;
      endedAt: string | null;
      status: ClaudeStatusView | null;
    }
  | {
      mode: 'server';
      canAct: boolean;
      agentUser: string;
      /** add-project's open claude-token paste box for this instance, when one is waiting. */
      ask: (Ask & { kind: 'paste_secret' }) | null;
      status: { at: string; loggedIn: boolean; method: string | null; cachedAccount: string | null; installedAt: string | null } | null;
      command: string;
      script: string;
    };
export const getClaudeSignin = () => api<ClaudeSigninData>('/api/first-run/claude-signin');
/** Start the relayed `claude auth login` (local mode), after the person confirmed what it does. */
export const startClaudeSignin = () => api<{ ok: boolean }>('/api/first-run/claude-signin', { method: 'POST', body: JSON.stringify({ confirm: true }) });
export const cancelClaudeSignin = () => api<{ ok: boolean }>('/api/first-run/claude-signin/cancel', { method: 'POST', body: '{}' });
/** Skip a setup step on the first-run page, or undo the skip. */
export const skipStep = (step: string, skip: boolean) => api<{ ok: boolean; skipped: string[] }>('/api/first-run/skip', { method: 'POST', body: JSON.stringify({ step, skip }) });
/** Connect GitHub (src/gh-login.ts): gh's device login, run by the server; only its one-time code reaches the page. */
export interface GhLoginView {
  state: 'idle' | 'waiting' | 'done' | 'failed' | 'expired' | 'cancelled';
  code: string | null;
  url: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  detail: string | null;
  installed: boolean;
}
export const getGhLogin = () => api<GhLoginView>('/api/first-run/gh-login');
export const startGhLogin = () => api<GhLoginView>('/api/first-run/gh-login', { method: 'POST', body: '{}' });
export const cancelGhLogin = () => api<GhLoginView>('/api/first-run/gh-login', { method: 'DELETE' });
/** The first-run page's Discord step (src/intake/discord-setup.ts), as GET /api/first-run/discord serves it. */
export type DiscordFormValue = boolean | string | string[] | null;
export interface DiscordChannel {
  guild_id: string;
  guild: string;
  id: string;
  name: string;
  type: number;
}
/** The bot's own view, from a child process on the instance that reads the token itself; this page never sees it. */
export interface DiscordBot {
  application: { id: string; name: string; message_content: boolean };
  invite: string;
  channels: DiscordChannel[];
  at: string;
}
export type DiscordSetup =
  | { available: false; why: string }
  | {
      available: true;
      instance: string;
      canAct: boolean;
      portal: string;
      token: { configured: boolean; file: string | null; present: boolean; error: string | null };
      ask: (Ask & { kind: 'paste_secret' }) | null;
      invite: { integer: string; permissions: { name: string; bit: number; why: string }[] };
      intake: { file: string; exists: boolean; error: string | null; values: Record<string, DiscordFormValue>; warnings: string[] };
      form: { key: string; kind: 'boolean' | 'id' | 'ids' | 'guild' | 'url'; what: string }[];
      automation: { token: string; channels: string; file: string; keys: string[]; restart: string };
    };
export interface DiscordIntakePlan {
  ok: boolean;
  confirmed: boolean;
  file: string;
  creates: boolean;
  changes: { key: string; from: DiscordFormValue; to: DiscordFormValue }[];
  diff: string;
  hash: string;
  warnings: string[];
}
export const getDiscordSetup = () => api<DiscordSetup>('/api/first-run/discord');
export const getDiscordBot = (fresh = false) => api<DiscordBot>(`/api/first-run/discord/channels${fresh ? '?fresh=1' : ''}`);
/** Open the paste box for the bot token (a paste_secret ask); the token itself goes through pasteSecret. */
export const openDiscordTokenAsk = () => api<{ ok: boolean; ask: Ask }>('/api/first-run/discord/token-ask', { method: 'POST', body: JSON.stringify({ confirm: true }) });
/** Review (no `expect`: nothing written) or write the intake.yaml change these picks make; a write names the reviewed change's hash. */
export const changeDiscordIntake = (values: Record<string, DiscordFormValue>, expect?: string) =>
  api<DiscordIntakePlan>('/api/first-run/discord/intake', { method: 'POST', body: JSON.stringify(expect ? { values, confirm: true, expect } : { values }) });
/** The first-run page's Slack and Linear steps (src/intake/source-setup.ts), as GET /api/first-run/<slack|linear> serves them. */
export type SourceKind = 'slack' | 'linear';
export type SourceFormValue = boolean | string | string[] | null;
export interface SourceCred {
  credential: string;
  key: string;
  title: string;
  configured: boolean;
  file: string | null;
  present: boolean;
  error: string | null;
  ask: (Ask & { kind: 'paste_secret' }) | null;
}
export type SourceSetup =
  | { available: false; why: string }
  | {
      available: true;
      kind: SourceKind;
      instance: string;
      canAct: boolean;
      portal: string;
      creds: SourceCred[];
      intake: { file: string; exists: boolean; error: string | null; values: Record<string, SourceFormValue>; warnings: string[]; allowed: number; trusted: number };
      form: { key: string; kind: 'boolean' | 'team' | 'ids' | 'label'; what: string }[];
      slack?: { manifest: string; scopes: { scope: string; why: string }[] };
      linear?: { permissions: { name: string; why: string }[] };
      automation: { token: string; view: string; file: string; keys: string[]; restart: string };
    };
/** What the source's secret can see, from a child process on the instance that reads it itself; this page never sees it. */
export type SourceView =
  | { kind: 'slack'; team: { id: string; name: string }; bot: { user: string }; channels: { id: string; name: string; member: boolean }[]; members: { id: string; name: string }[]; at: string }
  | {
      kind: 'linear';
      organization: { name: string };
      viewer: { id: string; name: string };
      teams: { id: string; name: string; key: string; labels: { id: string; name: string }[]; members: { id: string; name: string }[] }[];
      labels: { id: string; name: string }[];
      at: string;
    };
export type SourceIntakePlan = DiscordIntakePlan;
export const getSourceSetup = (kind: SourceKind) => api<SourceSetup>(`/api/first-run/${kind}`);
export const getSourceView = (kind: SourceKind, fresh = false) => api<SourceView>(`/api/first-run/${kind}/view${fresh ? '?fresh=1' : ''}`);
/** Open the paste box for one of the source's secrets (a paste_secret ask); the secret itself goes through pasteSecret. */
export const openSourceTokenAsk = (kind: SourceKind, credential: string) => api<{ ok: boolean; ask: Ask }>(`/api/first-run/${kind}/token-ask`, { method: 'POST', body: JSON.stringify({ confirm: true, credential }) });
/** Review (no `expect`: nothing written) or write the intake.yaml change these picks make. */
export const changeSourceIntake = (kind: SourceKind, values: Record<string, SourceFormValue>, expect?: string) =>
  api<SourceIntakePlan>(`/api/first-run/${kind}/intake`, { method: 'POST', body: JSON.stringify(expect ? { values, confirm: true, expect } : { values }) });
export const startCoordinator = () => api<{ ok: boolean; path: string; detail: string }>('/api/first-run/start', { method: 'POST', body: JSON.stringify({ confirm: true }) });
export const addProject = (name: string, repo: string) => api<{ ok: boolean }>('/api/machine/add-project', { method: 'POST', body: JSON.stringify({ name, repo }) });
/**
 * The name and repo add-project takes: the same rules as the server's and the machine helper's (addProjectNameOk and
 * addProjectRepoOk in src/machine.ts; test/web-render.test.ts holds the two to the same answers).
 */
export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,20}$/;
export const PROJECT_REPO = /^([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})\/([A-Za-z0-9_.-]{1,100})$/;
/** Why this name and repo won't be accepted; null when they will. */
export function addProjectInvalid(name: string, repo: string): string | null {
  if (!PROJECT_NAME.test(name)) return 'The name is lowercase letters, digits and dashes, starting with a letter, at most 21 characters.';
  // Names whose machine users or units would be another's (src/instance-name.ts has why for each).
  if (/^(dash|hub|hub-setup|update|tailscale|claude-account|agent|eval|work)$|^(test|ci|dashboard)-|-(agent|eval|work)$/.test(name)) return `The machine already uses that name for something else: not ${name}.`;
  const m = PROJECT_REPO.exec(repo);
  if (!m || m[2] === '.' || m[2] === '..') return 'The repo is owner/name, as on GitHub.';
  return null;
}

/** The agents' Claude account (src/claude-account.ts), as GET /api/claude-account serves it to a machine owner. */
export interface AccountUser {
  instance: string;
  kind: string;
  user: string;
  stored: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  account: string | null;
  org: string | null;
  subscription: string | null;
  tokenId: string | null;
  expiresAt: string | null;
  installedAt: string | null;
  error: string | null;
}
export interface SwitchLine {
  at: string;
  step: 'switch' | 'pause' | 'token' | 'wait' | 'install' | 'check' | 'resume';
  state: 'started' | 'done' | 'failed' | 'ask' | 'skipped';
  instance: string | null;
  user: string | null;
  detail: string;
}
export interface SwitchInstance {
  name: string;
  pause: SwitchLine | null;
  wait: SwitchLine | null;
  users: { user: string; install: SwitchLine | null; check: SwitchLine | null }[];
  check: SwitchLine | null;
  resume: SwitchLine | null;
}
export interface SwitchView {
  startedAt: string;
  status: 'running' | 'done' | 'failed' | 'stalled';
  detail: string;
  tokenFrom: string | null;
  waitingForToken: boolean;
  token: SwitchLine | null;
  instances: SwitchInstance[];
}
export interface ClaudeAccountData {
  machineOwner: boolean;
  machineOwners: string[];
  login: string;
  instance: string;
  /** Whether this person may refresh or switch (the server checks again). */
  allowed: boolean;
  why: string | null;
  canSwitch: boolean;
  busy: string | null;
  canPasteToken: boolean;
  status: { at: string; users: AccountUser[] } | null;
  switch: SwitchView | null;
  requests: { id: string; args: string[]; by: string; at: string; status: string; detail: string; finishedAt?: string | null }[];
  /** The account profiles (src/claude-profiles.ts); absent from an older server. */
  profiles?: ProfilesTable;
  profileOps?: ProfileOp[];
  /** The root script a staged profile is confirmed with, on the machine. */
  confirmScript?: string;
  /** This instance's relayed sign-in under way: the link only while it waits for the code. */
  signin?: { profile: string; status: string; detail: string; waitingForCode: boolean; url: string | null } | null;
}
/** One instance's agent user on one profile: its last real call there, and whether it is the active one. */
export interface ProfileCell {
  instance: string;
  user: string | null;
  active: boolean;
  account: string | null;
  subscription: string | null;
  apiOk: boolean | null;
  apiError: string | null;
  checkedAt: string | null;
}
export interface ProfilesTable {
  instances: string[];
  profiles: { name: string; kind: string; staged?: boolean; addedFor?: string | null; addedAt: string | null; cells: ProfileCell[] }[];
  active: Record<string, string>;
  /** Auto-failover on a usage limit: machine-wide, and per instance (an empty order: off there). Absent from an older server. */
  failover?: { machine: FailoverSetting | null; instances: Record<string, FailoverSetting> };
}
export interface FailoverSetting {
  order: string[];
  back: boolean;
}
export interface ProfileOp {
  id: string;
  op: 'profile-add' | 'use' | 'remove' | 'login';
  profile: string;
  for: string | null;
  status: 'running' | 'done' | 'failed' | 'stalled';
  startedAt: string;
  endedAt: string | null;
  detail: string;
  steps: { step: string; state: string; instance: string | null; user: string | null; detail: string }[];
}
/** A new account profile from a setup token: the token in the body only, never the URL. */
export const addClaudeProfile = (profile: string, value: string) => api<{ ok: boolean }>(`/api/claude-account/profile-add?profile=${encodeURIComponent(profile)}`, { method: 'POST', body: JSON.stringify({ value }) });
/** This dashboard's own instance's failover setting: an order of 2 to 8 profiles, or null for off (the machine's is a root admin's). */
export const setClaudeFailover = (order: string[] | null, back: boolean) => api<{ ok: boolean }>('/api/machine/claude-profile', { method: 'POST', body: JSON.stringify({ action: 'failover', order, back }) });
/** Use or remove a profile, for this dashboard's own instance only (another instance, or every one, is a root admin's). */
/** The one-time code Anthropic's sign-in page showed, for this instance's relayed sign-in: in the body only. */
export const pasteLoginCode = (value: string) => api<{ ok: boolean }>('/api/claude-account/login-code', { method: 'POST', body: JSON.stringify({ value }) });
export const claudeProfileAction = (action: 'use' | 'remove' | 'login', profile: string) => api<{ ok: boolean }>('/api/machine/claude-profile', { method: 'POST', body: JSON.stringify({ action, profile }) });
export const getClaudeAccount = () => api<ClaudeAccountData>('/api/claude-account');
export const claudeAccountAction = (action: 'status' | 'switch') => api<{ ok: boolean }>('/api/machine/claude-account', { method: 'POST', body: JSON.stringify({ action }) });
export const pasteClaudeToken = (value: string) => api<{ ok: boolean }>('/api/claude-account/token', { method: 'POST', body: JSON.stringify({ value }) });

/** Tailscale and HTTPS for the hub (src/tailscale-setup.ts), as GET /api/tailscale serves it to a machine owner. */
export type TailscaleAction = 'install' | 'up' | 'serve' | 'public-url';
export interface TailscaleStatus {
  installed: boolean;
  version: string | null;
  pinnedVersion: string | null;
  state: string | null;
  name: string | null;
  https: boolean;
  serve: boolean;
  other443: boolean;
  breakGlassForwarded: boolean;
  funnel: boolean;
  hubUrl: string | null;
}
export interface TailscaleStepView {
  id: TailscaleAction;
  title: string;
  done: boolean;
  blocked: string | null;
  changes: string[];
  command: string;
  link: { url: string; label: string } | null;
}
export interface TailscaleStepLine {
  at: string;
  step: TailscaleAction;
  state: 'started' | 'running' | 'waiting' | 'done' | 'failed';
  detail: string;
}
export interface TailscaleData {
  machineOwner: boolean;
  machineOwners: string[];
  login: string;
  instance: string;
  /** Whether this person may run a step (the server checks again). */
  allowed: boolean;
  why: string | null;
  busy: string | null;
  status: TailscaleStatus | null;
  steps: TailscaleStepView[];
  next: TailscaleAction | null;
  run: { step: TailscaleAction; startedAt: string; status: 'running' | 'waiting' | 'done' | 'failed' | 'stalled'; detail: string; lines: TailscaleStepLine[] } | null;
  /** Tailscale's login page for the waiting `up`: sent to machine owners only, never stored by the page. */
  loginUrl: string | null;
  requests: { id: string; args: string[]; by: string; at: string; status: string; detail: string; finishedAt?: string | null }[];
  script: { status: string; steps: string[] };
}
export const getTailscale = (fresh = false) => api<TailscaleData>(`/api/tailscale${fresh ? '?fresh=1' : ''}`);
export const tailscaleAction = (action: TailscaleAction) => api<{ ok: boolean }>('/api/machine/tailscale', { method: 'POST', body: JSON.stringify({ action, confirm: true }) });

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
  /** What it ran on, and its conversation's spend after it against the cap (src/chat-pick.ts). */
  model?: string;
  effort?: ChatEffort;
  conversation?: { id: string; spentUsd: number; capUsd: number };
}
export type ChatEffort = 'low' | 'medium' | 'high';
/** The chat's model and effort choice: unset fields run on routing's default and the CLI's default effort. */
export interface ChatPick { model?: string; effort?: ChatEffort }
/** What this person may pick on an instance (src/chat-pick.ts chatPickerView): a viewer gets canPick false and no models. */
export interface ChatPickerOptions { canPick: boolean; models: string[]; efforts: ChatEffort[]; defaultModel: string; capUsd: number }
export type ChatAnswerFile = { v: number; id: string; at: string; owner: boolean; filed: { number: number } | null } & ({ state: 'pending' } | { state: 'answered'; answer: ChatAnswer } | { state: 'refused'; why: string });

/** The chat on one instance: this page's (null), or a named one through the hub. */
const chatCall = <T,>(instance: string | null, path: string, init: RequestInit = {}) => (instance ? instanceApi<T>(instance, path, init) : api<T>(path, init));
/** `key` names one ask: a retry of the same POST returns the same question instead of running a second turn. */
export const askChat = (instance: string | null, question: string, key: string, attachments: string[] = [], pick?: ChatPick) => chatCall<{ id: string }>(instance, '/api/chat', { method: 'POST', body: JSON.stringify({ question, key, ...(attachments.length ? { attachments } : {}), ...(pick && (pick.model || pick.effort) ? { pick } : {}) }) });
export const chatPickerOptions = (instance: string | null) => chatCall<ChatPickerOptions>(instance, '/api/chat/options');

/** A chat attachment as the server keeps it (src/chat-attachments.ts): its random id, never its name, names it. */
export interface ChatAttachment { id: string; name: string; kind: 'image' | 'pdf' | 'text' | 'csv' | 'json' | 'office'; label: string; size: number; sha256: string }
export interface ChatAttachmentLimits { maxFileMb: number; maxMessageMb: number; retentionDays: number; maxFiles: number; extensions: string[] }
/** An upload's outcome: kept, or held back because it looks like it holds a secret (the kinds, never the value). */
/** `scanned`: false for an image, PDF or Office file, which the secret scan can't read. */
export type ChatUpload = { attachment: ChatAttachment; secretKinds: string[]; scanned?: boolean } | { secret: string[]; error: string };
const chatPath = async (instance: string | null, path: string) => (instance ? path.replace(/^\/api\//, `/api/i/${encodeURIComponent(instance)}/`) : apiPath(path));
export const chatAttachmentLimits = (instance: string | null) => chatCall<ChatAttachmentLimits>(instance, '/api/chat/attachments/limits');
/** The name header: its last 200 characters (what the server keeps; whole code points, so it always encodes), encoded. */
export const attachmentNameHeader = (name: string) => encodeURIComponent(Array.from(name).slice(-200).join(''));
/** Upload one file as the request body (streamed; its name in a header, never the URL). `anyway`: past a secret warning. */
export async function uploadChatAttachment(instance: string | null, file: Blob & { name: string }, anyway = false): Promise<ChatUpload> {
  const headers: Record<string, string> = { ...(await authHeaders()), 'content-type': 'application/octet-stream', 'x-attachment-name': attachmentNameHeader(file.name), ...(anyway ? { 'x-attach-anyway': '1' } : {}) };
  const res = await fetch(await chatPath(instance, '/api/chat/attachments'), { method: 'POST', body: file, headers });
  if (res.status === 409) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; secret?: { kinds?: string[] } };
    if (b.secret?.kinds) return { secret: b.secret.kinds, error: b.error ?? 'this file looks like it contains a secret' };
    throw new ApiError(b.error ?? 'HTTP 409', 409);
  }
  return answer<ChatUpload>(res);
}
export const removeChatAttachment = (instance: string | null, id: string) => chatCall<{ ok: boolean }>(instance, `/api/chat/attachments/${id}`, { method: 'DELETE' });
/** An attachment's bytes, through the dashboard with the normal sign-in (never a link with a key in it). */
export async function chatAttachmentBlob(instance: string | null, id: string): Promise<Blob> {
  const res = await fetch(await chatPath(instance, `/api/chat/attachments/${id}`), { headers: await authHeaders() });
  if (!res.ok) throw new ApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return res.blob();
}
/** A fresh request key (works outside secure contexts too, where randomUUID is missing). */
export const requestKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
export const chatAnswer = (instance: string | null, id: string) => chatCall<ChatAnswerFile>(instance, `/api/chat/${id}`);
export const fileChatDraft = (instance: string | null, id: string) => chatCall<{ ok: boolean; number: number }>(instance, `/api/chat/${id}/file-issue`, { method: 'POST', body: '{}' });

/** Chat conversations and Projects on one instance (src/chat-conversations.ts): owners' and writers' only. */
export interface ConversationItem { id: string; title: string; project: string | null; updatedAt: string; createdAt: string }
export interface ProjectItem { id: string; name: string; owner: string; shared: boolean; files: number; updatedAt: string; mine: boolean }
/** A Project as the server shows it: its files as attachments (the ones still there). */
export interface ChatProject { id: string; owner: string; name: string; instructions: string; files: ChatAttachment[]; shared: boolean; createdAt: string; updatedAt: string }
export interface Conversation { id: string; owner: string; title: string; project: string | null; createdAt: string; updatedAt: string }
/** A turn as the server shows it: the message and its files, and the answer file as the single-shot chat's (what this person may see of it). */
export type ConversationTurnView = ChatAnswerFile & { by: string; text: string; attachments: ChatAttachment[]; filed?: { number: number } | null };
export interface ConversationData { conversation: Conversation; project: { id: string; name: string } | null; turns: ConversationTurnView[] }
export interface Paged<T> { items: T[]; next: string | null }
const enc = encodeURIComponent;
export const listConversations = (instance: string | null, cursor?: string | null) => chatCall<Paged<ConversationItem>>(instance, `/api/chat/conversations${cursor ? `?cursor=${enc(cursor)}` : ''}`);
export const newConversation = (instance: string | null, project: string | null) => chatCall<{ conversation: Conversation }>(instance, '/api/chat/conversations', { method: 'POST', body: JSON.stringify({ project }) });
export const getConversation = (instance: string | null, id: string) => chatCall<ConversationData>(instance, `/api/chat/conversations/${enc(id)}`);
export const renameConversation = (instance: string | null, id: string, title: string) => chatCall<{ conversation: Conversation }>(instance, `/api/chat/conversations/${enc(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
export const deleteConversation = (instance: string | null, id: string) => chatCall<{ ok: boolean }>(instance, `/api/chat/conversations/${enc(id)}`, { method: 'DELETE' });
/** The message goes in the body, never the URL; `key` makes a retried send the same turn. */
export const sendConversationMessage = (instance: string | null, id: string, text: string, key: string, attachments: string[] = [], pick?: ChatPick) => chatCall<{ id: string }>(instance, `/api/chat/conversations/${enc(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, key, ...(attachments.length ? { attachments } : {}), ...(pick && (pick.model || pick.effort) ? { pick } : {}) }) });
export const fileConversationDraft = (instance: string | null, id: string, turn: string) => chatCall<{ ok: boolean; number: number }>(instance, `/api/chat/conversations/${enc(id)}/turns/${enc(turn)}/file-issue`, { method: 'POST', body: '{}' });
export const listProjects = (instance: string | null, cursor?: string | null) => chatCall<Paged<ProjectItem>>(instance, `/api/chat/projects${cursor ? `?cursor=${enc(cursor)}` : ''}`);
export const getProject = (instance: string | null, id: string) => chatCall<{ project: ChatProject }>(instance, `/api/chat/projects/${enc(id)}`);
export const saveProject = (instance: string | null, id: string | null, p: { name: string; instructions: string; files: string[]; shared?: boolean }) =>
  chatCall<{ project: ChatProject }>(instance, id ? `/api/chat/projects/${enc(id)}` : '/api/chat/projects', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(p) });
export const deleteProject = (instance: string | null, id: string) => chatCall<{ ok: boolean }>(instance, `/api/chat/projects/${enc(id)}`, { method: 'DELETE' });

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
/** One chat source's state for the Intake page's strip (counts only, never an id or a secret). */
export interface IntakeSourceSummary {
  name: 'discord' | SourceKind;
  state: 'on' | 'off' | 'none' | 'invalid';
  detail: string;
}
export interface IntakeView {
  reports: IntakeReport[];
  health: IntakeHealth;
  /** A server instance's chat sources; null where there are none (local mode). */
  sources?: IntakeSourceSummary[] | null;
  /** Whether this person may set the sources up (an owner of a server instance). */
  canSetUpSources?: boolean;
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

/** Repeated feedback (GET /api/constraints, src/checks-from-feedback.ts): constraints people's "no"s cluster into. */
export interface ConstraintItem {
  id: string;
  label: string;
  terms: string[];
  count: number;
  sightings: { key: string; source: string; by: string; at: string; ref: string; url: string | null; words: string }[];
  reverts: { url: string | null; at: string; words: string }[];
  status: 'proposed_pr' | 'proposed_issue' | 'dropped' | 'due' | 'held' | 'watching';
  proposal: { kind: 'pr' | 'issue'; number: number | null; url: string | null } | null;
  detail: string;
}
export interface Constraints {
  enabled: boolean;
  minSightings: number;
  maxPerWeek: number;
  usedThisWeek: number;
  constraints: ConstraintItem[];
}

/**
 * Trust (GET /api/trust, src/trust.ts): read-only measurement per instance, over 7 and 30 days, by risk area, with the
 * agent-count and verification recommendations. A figure a viewer may not see is null (cost always is, for them).
 */
export type RiskArea = 'money' | 'auth' | 'other';
export interface TrustArea {
  merges: number | null;
  failures: number | null;
  changeFailureRate: number | null;
  escapedBugs: number | null;
  restoreHours: number[] | null;
  medianRestoreHours: number | null;
  reviewed: number | null;
  revisedOrRejected: number | null;
  reviseRejectRate: number | null;
  checks: number | null;
  flakyChecks: number | null;
  flakyRate: number | null;
  cost: { usd: number; tokens: number; perMergedPrUsd: number | null; perMergedPrTokens: number | null } | null;
  verification: { tier: string; runs: number; medianMinutes: number; totalMinutes: number }[] | null;
}
export interface TrustWindow {
  days: number;
  since: string;
  total: TrustArea;
  byArea: Record<RiskArea, TrustArea> | null;
  failures: { issue: number; number: number | null; area: RiskArea; kind: 'reverted' | 'main_red' | 'fix_followed' | 'escaped'; by: number | null }[] | null;
  escapedMoney: number | null;
}
export interface Trust {
  until: string;
  windows: TrustWindow[];
  agents: { action: 'keep' | 'raise'; now: number; to: number; text: string; why: { rule: string; met: boolean }[] } | null;
  verification: { area: RiskArea; advice: 'heavier' | 'lighter' | 'keep' | 'too_few'; text: string }[] | null;
  definitions: string[];
  note: string;
  hidden: string[];
}

/**
 * Metrics (GET /api/metrics, src/merge-metrics.ts deliveryMetrics): over 7 and 30 days, the owner's and writers'. A
 * figure whose source has recorded nothing yet is `{ measured: false, why }`: "not measured yet", never a 0.
 */
export type Measure<T> = ({ measured: true } & T) | { measured: false; why: string };
export interface MetricsWindow {
  days: number;
  since: string;
  merges: Measure<{ total: number; perDay: number }>;
  mainRed: Measure<{ count: number; stillRed: boolean }>;
  timeToGreen: Measure<{ minutes: number[]; medianMinutes: number | null }>;
  reverts: Measure<{ opened: number; onRed: number; merged: number; redTimes: number; rate: number | null }>;
  fixForward: Measure<{ attempts: number; fixed: number; reverted: number; successRate: number | null }>;
  prCi: Measure<{ prs: number; medianMinutes: number | null; p90Minutes: number | null; slowest: { number: number; minutes: number }[] }>;
  startup: Measure<{ runs: number; medianSeconds: number | null; p90Seconds: number | null }>;
  flake: Measure<{ reruns: number; flaky: number; rate: number | null; quarantined: number }>;
}
export interface SlowTest {
  name: string;
  medianMs: number;
  maxMs: number;
  runs: number;
}
export interface Metrics {
  until: string;
  windows: MetricsWindow[];
  perDay: { day: string; merged: number }[] | null;
  slowTests: Measure<{ days: number; budgetS: number; runs: number; slowest: SlowTest[]; overBudget: SlowTest[]; overBudgetTotal: number }>;
  definitions: string[];
}

/**
 * Flaky tests (GET /api/flaky, src/flaky.ts; owners and writers): the quarantined checks, those released lately, and
 * the flake rate (flaky re-runs over red runs on the default branch) over 7 and 30 days.
 */
export interface FlakyTest {
  test: string;
  state: 'quarantined' | 'released';
  firstSeen: string;
  lastSeen: string;
  sightings: number;
  issue: number | null;
  url: string | null;
  passes: number;
  released: { at: string; how: 'passes' | 'owner'; by: string } | null;
}
export interface Flaky {
  releaseAfter: number;
  quarantined: FlakyTest[];
  released: FlakyTest[];
  rates: { days: number; redRuns: number; flakyReruns: number; rate: number | null }[];
  canClear: boolean;
}
/**
 * Harness evals (GET /api/harness-evals, src/harness-evals/; owners and writers): past tasks replayed through the real
 * coordinator, weekly and when the engine's src/ changes. Per run: success rate, cost, wall-clock and human
 * interventions per replay, and the change from its baseline; the latest run's tasks.
 */
export interface HarnessEvalRun {
  id: string;
  at: string;
  trigger: 'weekly' | 'change' | 'manual';
  engine: string | null;
  pr: number | null;
  runs: number;
  passed: number;
  successRate: number | null;
  costPerRun: number | null;
  wallMsPerRun: number | null;
  interventionsPerRun: number | null;
  costUsd: number;
  budgetUsd: number;
  stopped: boolean;
  error: string | null;
  successDelta: number | null;
  costDelta: number | null;
}
export interface HarnessEvals {
  enabled: boolean;
  runs: HarnessEvalRun[];
  latest: { task: string; heldOut: boolean; passed: number; samples: number; costUsd: number; outcomes: string[] }[];
}

export const clearFlaky = (test: string) => api<{ ok: boolean }>('/api/flaky/clear', { method: 'POST', body: JSON.stringify({ test }) });

/** WHY: item 33; mirrors LearningsView in src/learnings.ts (GET /api/learnings, owners and writers). */
export interface LearningGroup {
  fingerprint: string;
  root: string;
  outcome: string;
  cause: string;
  count: number;
  issues: number[];
  stages: { stage: string; count: number }[];
  first: string;
  last: string;
  ready: boolean;
  line: string;
  promotion: { state: 'requested' | 'filed' | 'failed'; by: string; line: string; pr: string | null; detail: string } | null;
}
export interface Learnings {
  minSightings: number;
  groups: LearningGroup[];
  canPromote: boolean;
}
/** Mirrors DelegationView in src/delegation.ts, with the instance's settings (GET /api/delegation, owners and writers). */
export interface DelegationApprover {
  by: string;
  role: 'owner' | 'writer' | null;
  approvals: number;
  unchanged: number;
  bad: number;
  medianWaitMs: number | null;
}
export interface DelegationCategory {
  category: string;
  waits: boolean;
  loosened: boolean;
  protected: boolean;
  prs: number[];
  clean: number;
  changed: number;
  reverted: number;
  mainRed: number;
  laterFix: number;
  held: number;
  wait: { medianMs: number; fastestMs: number; slowestMs: number; count: number } | null;
  approvers: DelegationApprover[];
  evidence: string[];
}
export interface Delegation {
  enabled: boolean;
  minClean: number | null;
  categories: DelegationCategory[];
  approvers: (DelegationApprover & { categories: string[] })[];
  suggestions: { category: string; direction: 'loosen' | 'tighten'; at: string; decision: string; receipts: string[]; answer: string | null; by: string | null; issue: number | null }[];
}
export const promoteLearning = (fingerprint: string, line: string) => api<{ ok: boolean }>('/api/learnings/promote', { method: 'POST', body: JSON.stringify({ fingerprint, line }) });

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
  /** A PR left to the owner as high-risk: each category it touches, plainly, with its first file ("changes the merge policy: src/merge-policy.ts"). */
  why?: { category: string; text: string }[];
  /** A decision or a held plan: its id, for its detail page (/decisions/<id>). */
  decision?: string;
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
  /** `reasons`: each of a PR hold's reasons whole (merge.decided), for the owner and writers; null otherwise. */
  waiting: { kind: WaitKind; label: string; detail: string | null; reasons?: string[] | null; since: string } | null;
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
  /** Why dispatch holds now, with its numbers and fix (a viewer's without fix or link); null or absent when it doesn't. */
  hold?: HoldBanner | null;
}

/** A governor hold as the Board and First run show it (src/governor-holds.ts holdBanner). */
export interface HoldBanner {
  kind: string;
  title: string;
  numbers: string | null;
  /** When it ends on its own (ISO): shown as "wait until <local time>". */
  wait: string | null;
  fix: string | null;
  link: { path: string; label: string } | null;
  since: string;
}

/** The disk floor on this machine now (src/governor-holds.ts diskFloorCheck), as doctor checks it. */
export interface DiskFloor {
  level: 'ok' | 'warn';
  detail: string;
  room: { freeGb: number; totalGb: number; freePct: number; floorGb: number; estGb: number; afterGb: number; shortGb: number; held: boolean };
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
/** A stream's path on one instance in this page's scope (as onInstance): through the hub to the named one, or this page's own server (null). No key: liveStream sends it. */
export async function instanceStream(instance: string | null, path: string, scope: Promise<InstanceScope> = instanceScope): Promise<string> {
  if (instance !== null && !(await scope).instances.includes(instance)) throw new Error(`instance ${instance} isn't selected`);
  return instance ? path.replace(/^\/api\//, `/api/i/${encodeURIComponent(instance)}/`) : apiPath(path);
}

/** An instance's health, as its sidebar dot shows it: green (nothing open), amber (needs a person soon), red (broken). */
export type HealthStatus = 'green' | 'amber' | 'red';

/**
 * A watchdog incident (GET /api/health/incidents; src/watchdog/). A viewer gets id, kind, instance, severity, title,
 * since and resolvedAt only; owners and writers also what broke, what was tried and the fix.
 */
export interface Incident {
  id: string;
  kind: string;
  instance: string | null;
  severity: 'red' | 'amber' | 'info';
  title: string;
  since: string;
  resolvedAt: string | null;
  lastSeen?: string;
  key?: string;
  detail?: string;
  fix?: string;
  tried?: string[];
}
export interface IncidentsView {
  instance: string | null;
  status: HealthStatus;
  open: Incident[];
  resolved: Incident[];
  detail: boolean;
}
/** One instance's incidents as the Health page read them (null name: this page's own server). */
export interface InstanceIncidents {
  name: string | null;
  view: IncidentsView | null;
  error: string | null;
  /** The hub says this instance's dashboard isn't answering (not merely that its incidents couldn't be read). */
  down?: boolean;
}

/**
 * Every instance's incidents this person may read: on a hub, each instance with a role on it, through its own server
 * (the hub checks the role again); off a hub, this page's own server. One that can't be read says why.
 */
export async function loadIncidents(h: HubInfo | null, get: (name: string | null, path: string) => Promise<IncidentsView> = (n, p) => (n ? instanceApi<IncidentsView>(n, p) : api<IncidentsView>(p))): Promise<InstanceIncidents[]> {
  const names: (string | null)[] = h?.instances.length ? h.instances.map((i) => i.name) : [null];
  return Promise.all(
    names.map(async (name) => {
      if (name && h?.instances.find((i) => i.name === name)?.up === false) return { name, view: null, error: "its dashboard isn't answering", down: true };
      try {
        return { name, view: await get(name, '/api/health/incidents'), error: null };
      } catch (e) {
        return { name, view: null, error: (e as Error).message };
      }
    }),
  );
}

/** The machine's incidents once each (a machine-wide one is in every instance's answer), open oldest first, resolved newest first. */
export function mergeIncidents(all: InstanceIncidents[]): { open: Incident[]; resolved: Incident[]; detail: boolean } {
  const byId = new Map<string, Incident>();
  for (const a of all) for (const x of [...(a.view?.open ?? []), ...(a.view?.resolved ?? [])]) if (!byId.has(x.id)) byId.set(x.id, x);
  const xs = [...byId.values()];
  return {
    open: xs.filter((x) => !x.resolvedAt).sort((a, b) => a.since.localeCompare(b.since)),
    resolved: xs.filter((x) => x.resolvedAt).sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!)),
    detail: all.some((a) => a.view?.detail),
  };
}

/**
 * A status dot: an instance's own status (green, amber, red), or unknown when its incidents couldn't be read (a
 * refusal, a timeout, a proxy blip): that is not "broken", and red stays for an open red incident or an instance
 * that isn't answering.
 */
export type DotStatus = HealthStatus | 'unknown';
/** Each instance's dot: its own server's status; red when the hub says it isn't answering; unknown when its incidents couldn't be read. */
export function statusOf(all: InstanceIncidents[]): Record<string, DotStatus> {
  return Object.fromEntries(all.map((a) => [a.name ?? '', a.view ? a.view.status : a.down ? 'red' : 'unknown']));
}
/** Why each instance's status couldn't be read (only those that couldn't), for the dot's hover and screen-reader text. */
export function whyOf(all: InstanceIncidents[]): Record<string, string> {
  return Object.fromEntries(all.filter((a) => !a.view && a.error).map((a) => [a.name ?? '', a.error!]));
}
/** One health refresh: the hub's list asked again (an instance down at page load can be up now), then each instance's incidents. */
export async function healthPass(refresh: () => Promise<HubInfo | null> = refreshHub, load: (h: HubInfo | null) => Promise<InstanceIncidents[]> = (h) => loadIncidents(h)): Promise<{ hub: HubInfo | null; status: Record<string, DotStatus>; why: Record<string, string> }> {
  const h = await refresh();
  const all = await load(h);
  return { hub: h, status: statusOf(all), why: whyOf(all) };
}

// ---------- Extend: Plugins (src/plugins/dashboard.ts) ----------

export interface PluginTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}
export interface PluginRecord {
  kind: 'plugin' | 'mcp';
  id: string;
  roles: string[];
  [k: string]: unknown;
}
export interface PluginEntry {
  id: string;
  kind: 'plugin' | 'mcp';
  label: string;
  on: boolean;
  reach: string[];
  roles?: string[];
  digest?: string;
  confirmed_at?: string;
  staged_by?: string;
  record?: PluginRecord;
}
export interface PluginPreview {
  kind: 'plugin' | 'mcp';
  id: string;
  fetched_at: string;
  source?: { url: string; sha: string; path?: string };
  inspection?: { name: string | null; version: string | null; refusals: string[]; skills: string[]; agents: string[]; commands: string[]; bin: string[]; flags: string[]; mcpServers: { name: string; envNames: string[] }[]; files: { path: string; size: number }[] };
  materialized?: { tree: string; transform: string[] } | null;
  runtime?: { type: 'plugin' | 'npm'; plugin?: string; server?: string; package?: string; version?: string; argv: string[] };
  envNames?: string[];
  snapshot?: { serverName: string | null; instructions: string | null; tools: PluginTool[] } | null;
  snapshotError?: string | null;
  snapshotWithSecrets?: boolean;
  snapshotNetwork?: string[];
  flags?: string[];
  refusals?: string[];
  /** For an update: how it differs from the approved one (files; an MCP server's tools). */
  diff?: { added: string[]; removed: string[]; changed: string[]; tools?: { added: string[]; removed: string[]; changed: { name: string; fields: string[] }[]; instructions: boolean } } | null;
}
export interface PluginUpdate {
  id: string;
  kind: 'plugin' | 'npm';
  from: string;
  to: string;
  fetch: Record<string, string>;
}
export interface PluginPending {
  id: string;
  roles: string[];
  digest: string;
  staged_at: string;
  staged_by: string;
  network?: string[];
  secrets?: string[];
  command: string;
}
export interface PluginsView {
  available: boolean;
  why?: string;
  role?: 'owner' | 'writer';
  instance?: string;
  problem?: string | null;
  offProblem?: string | null;
  entries?: PluginEntry[];
  waiting?: number;
  pending?: PluginPending[];
  previews?: PluginPreview[];
  fetchStatus?: { id: string; state: string; reason: string; at: string } | null;
  blocked?: Record<string, { at: string; diff: { added: string[]; removed: string[]; changed: { name: string; fields: string[] }[]; instructions: boolean } }> | null;
  requests?: { id: string; args: string[]; status: string; detail: string; at: string }[];
  updates?: { at: string | null; updates: PluginUpdate[] };
  audit?: { at: string; action: string; login?: string; by?: string; root?: boolean; detail?: unknown }[];
}
export interface PluginReview {
  ok: boolean;
  confirmed: boolean;
  digest?: string;
  command?: string;
  record?: PluginRecord;
  current?: { digest: string; record: PluginRecord } | null;
  changes?: string[];
}
export const getPlugins = () => api<PluginsView>('/api/plugins');
export const pluginAction = (action: 'fetch' | 'stage' | 'withdraw' | 'remove' | 'toggle', body: Record<string, unknown>) => api<PluginReview>(`/api/plugins/${action}`, { method: 'POST', body: JSON.stringify(body) });
/** Extend -> Automations (src/automations/view.ts): the owners' and writers' view. */
export type AutomationAction = 'create' | 'edit' | 'delete' | 'pause' | 'resume' | 'run' | 'rotate' | 'unbind';
export interface AutomationDef {
  id: string;
  name: string;
  owner?: string;
  enabled?: boolean;
  trigger: { kind: 'schedule'; cron: string } | { kind: 'github'; on: string; label?: string; command?: string } | { kind: 'discord'; command: string } | { kind: 'webhook' };
  gates?: { start: 'auto' | 'approve' };
  mode: 'task' | 'report';
  template: { title: string; outcome: string; done_when: ({ test: string } | { command: string; expect?: string })[]; trigger_text?: 'quoted' | 'none' };
  budget: { per_run_usd: number; per_day_usd: number };
  limits?: { runs_per_day: number; cooldown_minutes: number };
  chain?: { accept_from: string[] };
}
export interface AutomationItem extends AutomationDef {
  owner: string;
  enabled: boolean;
  limits: { runs_per_day: number; cooldown_minutes: number };
  when: string;
  summary: string[];
  next: string | null;
  today: { runs: number; spentUsd: number };
  runs: { run: string; at: string; trigger: { kind: string; ref: string | null; by: string | null }; depth: number; outcome: string; costUsd: number | null; outputs: { kind: string; number: number }[] }[];
  refused: { at: string; trigger: string; why: string }[];
  pausedBy: { by: string; role: string; why: string | null; at: string } | null;
  webhook: { path: string; bound: { name: string; at: string } | null; hasSecret: boolean } | null;
  waiting: string[];
}
export interface AutomationsView {
  unavailable?: string;
  limits: { enabled: boolean; off: string | null; maxRunsPerDay: number; maxConcurrent: number; dailyUsd: number };
  timezone: string;
  today: { runs: number; spentUsd: number };
  error: string | null;
  digest: string;
  actions: AutomationAction[];
  automations: AutomationItem[];
}
export interface AutomationPlan {
  ok: boolean;
  confirmed: boolean;
  action: AutomationAction;
  id: string;
  changes: string[];
  summary: string[];
  digest?: string;
  /** A webhook's new secret and its address path: in a Confirm's answer only, once. */
  secret?: string;
  path?: string;
}
/** Review (no digest, no confirm: nothing written) or Confirm (with the review's digest) one change to the automations. */
export const changeAutomation = (body: { action: AutomationAction; id?: string; automation?: AutomationDef; digest?: string; confirm?: boolean }) => api<AutomationPlan>('/api/automations', { method: 'POST', body: JSON.stringify(body) });

/** Extend -> Experiments (src/experiments/view.ts): the owners' and writers' view. */
export type ExpAction = 'start' | 'pause' | 'resume' | 'stop_job' | 'approve' | 'decline' | 'archive';
export interface ExpStage2 {
  size: number;
  meanCandidate: number | null;
  meanBest: number | null;
  spread: number | null;
  seeds: number;
  minutesCandidate: number;
  minutesBest: number;
}
export interface ExpLogRow {
  n: number;
  kind: 'baseline' | 'exploit' | 'explore' | 'combine' | 'seed';
  at: string;
  hypothesis: string;
  variable: string;
  stage: 0 | 1 | 2;
  stage2: ExpStage2[];
  seeds: number;
  motivation: string;
  change: { commit: string | null; files: string[] };
  config: Record<string, string | number>;
  minutes: number | null;
  waited_s: number | null;
  result: number | null;
  decision: string;
  why: string;
  step: string | null;
  parent: number | null;
}
interface ExpStudyBase {
  id: string;
  goal: string;
  kind: string;
  screen: { margin: number; seeds: number };
  ladder: string[];
  metric: { name: string; direction: 'min' | 'max'; min_delta: number };
  job: { max_minutes: number; gpus: number; output_gb: number };
  budget: { gpu_hours_per_day: number; agent_usd_per_day: number; agent_usd_total: number; max_jobs: number };
  exploration: { share: number; near_miss: number };
  editable: string[];
}
export type ExpStudy =
  | (ExpStudyBase & { started: false; startRefused: string | null })
  | (ExpStudyBase & {
      started: true;
      version: string;
      startedBy: string;
      phase: 'idle' | 'session' | 'awaiting_approval' | 'queued' | 'running';
      paused: boolean;
      archived: boolean;
      broken: boolean;
      hold: string | null;
      best: { n: number; value: number } | null;
      baseline: { n: number; value: number | null } | null;
      current: { n: number; job: string | null; kind: string; hypothesis: string; approval: string[]; since: string } | null;
      spend: { agentToday: number; agentPerDay: number; agentTotal: number; agentAll: number; gpuHoursToday: number; gpuHoursPerDay: number; jobs: number; maxJobs: number };
      counts: { jobs: number; kept: number; explore: number; crash: number; screened: number };
      held: { n: number; hypothesis: string; variable: string; why: string; commit: string | null; files: string[]; stage2: ExpStage2[]; monitor: { flagged: boolean; findings: string[] } | null } | null;
      points: { n: number; value: number | null; kept: boolean }[];
      log: ExpLogRow[];
    });
export interface ExperimentsView {
  unavailable?: string;
  setup: { state: 'on' | 'off' | 'unknown'; why: string | null; commands: { install: string; set: string; hash: string; add: string }; devices: number[] };
  error: string | null;
  actions: ExpAction[];
  approve: { above_minutes: number; above_gb: number } | null;
  studies: ExpStudy[];
}
export interface ExpPlan {
  ok: boolean;
  confirmed: boolean;
  action: ExpAction;
  study: string;
  summary: string[];
  changes: string[];
  digest?: string;
}
/** Review (nothing written) or Confirm (with the review's digest) one change to a study. */
export const changeExperiment = (body: { action: ExpAction; study: string; digest?: string; confirm?: boolean }) => api<ExpPlan>('/api/experiments', { method: 'POST', body: JSON.stringify(body) });
