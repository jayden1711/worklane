// The local dashboard server: static UI plus a small API over the event
// log. It binds to loopback only and requires a per-install token, which only
// two kinds of caller hold: the hub, which names the signed-in person on each
// request (their role here is then read from their permission on this
// instance's repo, never taken from the caller), and the owner on this machine
// (the break-glass: no person named, never through a proxy; it grants owner).
// It reads the log read-only, pushes changes over one SSE stream, and records
// every write a person makes (answers, settings, chat, console) in the audit.
// See dashboard-auth.ts.
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { EventLog } from './events/log.js';
import { redactString } from './events/redact.js';
import type { StoredEvent } from './events/types.js';
import { checkResults, inbox, prsView, project } from './projection.js';
import { instancesDir, loadInstance, readPolicy } from './instance.js';
import { backlogFor, instanceEnv, instanceTokens, siteForInstance, siteForRoot } from './service.js';
import { askChat, ChatError, chatAnswer, validateDraft, type ChatAnswerFile } from './chat.js';
import { mayAnswer, type Backlog } from './backlog/types.js';
import { readRun, runsForIssue } from './run-record.js';
import { emergencyStop, slotStatus, type EmergencyStop } from './slots.js';
import { healthView } from './health.js';
import { ConsoleError, liveRuns, sendMessage, stopRun } from './console.js';
import { readFeed, type FeedItem } from './run-feed.js';
import { cpuCount } from './os/index.js';
import { machineStats, type MachineStats } from './os/stats.js';
import { MACHINE_CHANGES, MACHINE_HELPER, machineChanges, setSlotCap, setUpdates, SLOTS_MAX, SLOTS_MIN, type Exec } from './machine.js';
import { UPDATES_CONFIG, UPDATES_LOG, updateLog, updateSettings } from './updates.js';
import { changeSetting, currentValue, loadLimits, SETTING_KEYS, SettingsError, type SettingKey } from './settings.js';
import { researchForRun } from './research.js';
import { PolicyFile } from './instance.js';
import { parseDocument } from 'yaml';
import { buildReport } from './reports.js';
import { intakeHealth, intakeReports } from './intake/view.js';
import { throughput } from './throughput.js';
import { digestMarkdown, waitingOnYou } from './digest.js';
import { assertLoopbackHost, breakGlassAllowed, cachedRoles, isOwner, isWriter, LOGIN_HEADER, mayAnswerKind, repoPermission, validLogin, type Role, type RoleOf } from './dashboard-auth.js';

/**
 * What the Settings page shows: the config's shape and choices, read-only.
 * Commands, connection fingerprints and deploy details stay out; editing
 * happens in the project's config folder, through review like any change.
 */
export function settingsView(cfg: Config) {
  return {
    configDir: BRAND.configDir,
    project: { name: cfg.project.project.name, repo: cfg.project.project.repo, landMode: cfg.project.land_mode, runtime: cfg.project.agent_runtime },
    owners: cfg.project.owners,
    reports: cfg.project.reports,
    governor: cfg.project.governor,
    agents: {
      budget: cfg.agents.daily_budget_usd,
      roles: Object.entries(cfg.agents.roles).map(([name, r]) => ({ name, enabled: r!.enabled, model: r!.model, count: r!.count ?? null })),
    },
    tests: { gates: cfg.tests.gates, batchMax: cfg.tests.land.batch_max, nightlyAt: cfg.tests.nightly_at ?? null, tiers: Object.keys(cfg.tests.tiers ?? {}), baselineParser: !!cfg.tests.failures },
    review: cfg.review ? { levels: Object.fromEntries(Object.entries(cfg.review.levels).map(([k, v]) => [k, (v as { when: string[] }).when]))} : null,
    guardrails: { rules: cfg.guardrails.rules.length, protectedPaths: cfg.guardrails.protected_paths, secretPaths: cfg.guardrails.secret_paths.length, network: cfg.guardrails.network ? 'restricted' : 'open', preApproved: cfg.guardrails.pre_approved },
    deploy: cfg.deploy ? { environments: cfg.deploy.environments.map((e) => ({ name: e.name, production: e.production })), prodRead: !!cfg.deploy.prod_read } : null,
  };
}

export interface DashboardOptions {
  root: string;
  cfg: Config;
  eventsDb: string;
  stateDir: string;
  /** The login recorded for the break-glass (the token used on this machine with no person named): the owner's. */
  user: string;
  /**
   * A signed-in person's role on this instance, from their permission on its repo (cached at most 5 minutes);
   * none when unset, so every person the hub names is refused.
   */
  roleOf?: RoleOf;
  /** The instance this server serves (recorded in the audit); none for a checkout. */
  instance?: string;
  /** Where it listens: loopback only (127.0.0.1 when unset); anything else is refused. */
  host?: string;
  port?: number;
  webDir?: string;
  pollMs?: number;
  /** Where the coordinator's service log is (the Logs page); none when unset. */
  logs?: LogSource;
  /** Reads a unit's journal; journalctl as this user when unset. */
  journalReader?: JournalReader;
  /** The machine's slots directory (agent slots and the emergency STOP file); the usual one when unset. */
  slotsDir?: string;
  /** The instance's policy file (its auto-merge kill switch and settings); none for a checkout. */
  policyFile?: string | null;
  /** The machine and service stats for the health view; the OS adapter's machineStats when unset. */
  machineStats?: () => MachineStats | null;
  /** The backlog a confirmed chat draft is filed to (the instance's); made when first needed. */
  backlog?: () => Backlog;
  /** The machine's limits file for settings; the system one when unset. */
  limitsPath?: string;
  /** Machine settings: how the helper is run (sudo), and where its change log and the updater's files are. The system's when unset. */
  machine?: { exec?: Exec; changesPath?: string; updatesConfigPath?: string; updatesLogPath?: string };
}

/**
 * The emergency stop as the dashboard shows it, read-only: whether one is in
 * force on this machine now (the STOP file), and whether this instance's
 * coordinator has halted for it (its own emergency.stop event since then).
 */
export function stopStatus(inForce: EmergencyStop | null, record: { lastStop: { at: string; by: string; reason: string; running: number } | null; lastResume: string | null }) {
  const since = inForce?.at ? Date.parse(inForce.at) : NaN;
  const halted = !!inForce && !!record.lastStop && (Number.isNaN(since) || Date.parse(record.lastStop.at) >= since) && !(record.lastResume && Date.parse(record.lastResume) > Date.parse(record.lastStop.at));
  return {
    inForce,
    /** This coordinator acknowledged it: halted its agents (how many were running) and starts none. */
    halted: halted ? { at: record.lastStop!.at, running: record.lastStop!.running } : null,
    lastStop: record.lastStop,
    lastResume: record.lastResume,
  };
}

export { mayAnswer };

/** Who is asking: a signed-in person the hub named (their role read from the repo), or the owner's break-glass. */
export interface Who {
  login: string;
  role: Role;
  via: 'session' | 'break-glass';
}

/** Who may read the next report's preview (spend, and the throughput section): the instance's owners and writers. */
export const mayReadReports = (role: Role | null | undefined) => isWriter(role);
/** Who may read intake reports (redacted, but people's words): the instance's owners and writers. */
export const mayReadIntake = (role: Role | null | undefined) => isWriter(role);
/** Who may read throughput (what runs cost, where PRs waited): the instance's owners and writers. */
export const mayReadThroughput = (role: Role | null | undefined) => isWriter(role);
/** Who may read what waits on the owner (the digest): the instance's owners and writers. */
export const mayReadDigest = (role: Role | null | undefined) => isWriter(role);
/**
 * Who may read agent runs (every route under /api/runs: a run's record, its live feed, a research run's
 * searches and pages): the instance's owners and writers. Writing to a run (a console message, a stop)
 * stays the owner's alone, checked on those routes as well.
 */
export const mayReadRuns = (role: Role | null | undefined) => isWriter(role);

/** Why a reader is refused something that is the owners' and writers' to read. */
const writersOnly = (what: string, who: Who) => `${what} for the instance's owners and writers (admin or write on its repo); @${who.login} is a ${who.role}`;

/**
 * Every path that serves agent runs, which the run-reading gate covers whatever route is added there:
 * everything under /api/runs, and the list of live runs (/api/live).
 */
export const isRunsPath = (pathname: string) => pathname === '/api/runs' || pathname.startsWith('/api/runs/') || pathname === '/api/live';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

/**
 * A page of the engine's docs on its public repository, from package.json (docs aren't in the package);
 * null when the package names no https repository.
 */
export function docsUrl(page: string, repository: unknown = enginePackage().repository): string | null {
  const raw = typeof repository === 'string' ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof raw !== 'string') return null;
  const base = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https:\/\/[^/\s]+\/[^\s]+$/.test(base) ? `${base}/blob/main/docs/${page}.md` : null;
}
const enginePackage = (): { repository?: unknown } => JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { repository?: unknown };

/**
 * Which log and state a dashboard reads. A project checkout's own, or, with
 * an instance, that instance's: run it as the instance's coordinator user,
 * the only user that can read (and, for answers, write) the instance's log.
 */
export function dashboardSite(root: string, instance?: string, dir = instancesDir()): { root: string; cfg: Config; eventsDb: string; stateDir: string; port: number; logs: LogSource; policyFile: string | null; backlog: () => Backlog; roleOf?: RoleOf } {
  const i = instance ? loadInstance(instance, dir) : null;
  const s = i ? siteForInstance(i) : siteForRoot(root);
  // An instance's service on Linux is the systemd unit the setup scripts install; elsewhere the coordinator writes its own log file.
  const logs = { unit: instance ? `${BRAND.cli}-${instance}.service` : null, file: join(s.stateDir, 'coordinator.log') };
  // The backlog the coordinator files to, made when first needed: an instance's with its App's tokens.
  const backlog = () => (i ? backlogFor(s.cfg, s.root, s.stateDir, instanceTokens(i, instanceEnv(i))) : backlogFor(s.cfg, s.root, s.stateDir));
  // A signed-in person's role here: their permission on the instance's repo, read with the instance's own token.
  const roleOf = i ? cachedRoles(repoPermission({ repo: i.repo.repo, token: instanceTokens(i, instanceEnv(i)), api: process.env[`${BRAND.envPrefix}_GITHUB_API`] ?? 'https://api.github.com' })) : undefined;
  return { root: s.root, cfg: s.cfg, eventsDb: s.logPath, stateDir: s.stateDir, port: instance ? instancePort(instance) : 4317, logs, policyFile: i ? join(i.home, 'policy.yaml') : null, backlog, ...(roleOf ? { roleOf } : {}) };
}

/**
 * A chat answer as this dashboard's user may see it: the owner gets it whole; anyone else the answer and its
 * citations, never a draft or a proposal (the coordinator answers them read-only already; this holds it here too).
 */
export function chatAnswerFor(f: ChatAnswerFile, owner: boolean): ChatAnswerFile {
  if (owner || f.state !== 'answered') return f;
  return { ...f, answer: { ...f.answer, issueDraft: null, actions: [], refusedActions: [], readOnly: true } };
}

/** Where a filed chat draft is recorded, so the same draft is never filed twice. */
const filedPath = (stateDir: string, id: string) => join(stateDir, 'chat', 'filed', `${id}.json`);

/**
 * What the health view reads: the OS adapter's snapshot of the machine, the
 * harness's slice and this instance's service (when there is one), and the
 * volumes of the checkout and the state dir.
 */
export function healthStats(o: { serviceUnit: string | null; root: string; stateDir: string }): MachineStats {
  return machineStats({ units: [`${BRAND.cli}.slice`, ...(o.serviceUnit ? [o.serviceUnit] : [])], paths: [...new Set([o.root, o.stateDir])] });
}

/**
 * The machine-wide settings as the Settings page shows them: the agent slot cap now (and its bounds), whether
 * engine updates are on (null when the updater isn't set up here), who may change them, and their history:
 * the helper's change log and the updater's log, newest first.
 */
export function machineView(o: Pick<DashboardOptions, 'cfg' | 'user' | 'slotsDir' | 'machine'> & { role?: Role | null }) {
  const owner = o.cfg.project.owners.default;
  const slots = slotStatus(o.slotsDir);
  const updates = updateSettings(o.machine?.updatesConfigPath ?? UPDATES_CONFIG);
  return {
    owner,
    user: o.user,
    canChange: isOwner(o.role),
    helper: MACHINE_HELPER,
    slots: { cap: slots.cap, running: slots.agents.length, min: SLOTS_MIN, max: SLOTS_MAX },
    updates: updates ? { configured: true as const, enabled: updates.enabled, branch: updates.branch, requiredChecks: updates.required_checks } : { configured: false as const, enabled: null },
    changes: machineChanges(o.machine?.changesPath ?? MACHINE_CHANGES).reverse(),
    history: updateLog(o.machine?.updatesLogPath ?? UPDATES_LOG).reverse(),
  };
}

/** The runs live now, for the Agents page; their held messages' text only for the owner, who may control them. */
export function liveView(o: Pick<DashboardOptions, 'stateDir' | 'cfg' | 'user'> & { role?: Role | null }) {
  const owner = o.cfg.project.owners.default;
  const canControl = isOwner(o.role);
  return { owner, canControl, runs: liveRuns(o.stateDir).map((r) => ({ ...r, pending: canControl ? r.pending : r.pending.map((m) => ({ id: m.id, by: m.by, at: m.at, text: '' })) })) };
}

/**
 * A run's feed after `after`; while the run is live but its feed isn't written yet, nothing so far (not an error).
 * Reading it is the runs gate's to allow (the owner and the writers), as for the rest of a run's record; only a
 * message or a stop is the owner's alone (sendMessage, stopRun).
 */
function feedOrWait(o: Pick<DashboardOptions, 'stateDir'>, run: string, after: number): { items: FeedItem[]; ended: boolean } {
  const f = readFeed(o.stateDir, run, after);
  if (f) return f;
  if (liveRuns(o.stateDir).some((r) => r.run === run)) return { items: [], ended: false };
  throw new ConsoleError(`no feed for run ${run}`);
}

/**
 * What the run page's console needs: whether the run is live, whether this user (the owner) may message or
 * stop it, its messages held until the agent's turn ends, and the console's events for it (queued, delivered,
 * dropped, stopped, refused), oldest first.
 */
export function consoleView(o: Pick<DashboardOptions, 'stateDir' | 'cfg' | 'user' | 'eventsDb'> & { role?: Role | null }, run: string) {
  const owner = o.cfg.project.owners.default;
  const canControl = isOwner(o.role);
  const live = liveRuns(o.stateDir).find((r) => r.run === run) ?? null;
  const events = readEvents(o.eventsDb)
    .filter((e) => e.type.startsWith('console.') && ((e.payload as { run?: string }).run === run))
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return { at: e.ts, type: e.type.slice('console.'.length), id: (p.id as string | undefined) ?? null, by: (p.by as string | undefined) ?? null, text: canControl ? ((p.text as string | undefined) ?? null) : null, why: (p.why as string | undefined) ?? null };
    });
  const settled = new Set(events.filter((e) => e.type === 'message_delivered' || e.type === 'message_dropped').map((e) => e.id));
  const held = events.filter((e) => e.type === 'message_queued' && !settled.has(e.id));
  return { owner, canControl, live: !!live, pending: canControl ? (live?.pending ?? []) : [], held, events };
}

/**
 * Where each instance setting lives in the repo's config, or null when the repo's config can't set it.
 * Every setting key must say (a Record over SettingKey): a new key without a place doesn't compile.
 */
const REPO_PLACE: Record<SettingKey, { file: string; path: string[] } | null> = {
  workers: { file: 'agents.yaml', path: ['roles', 'workers', 'count'] },
  daily_budget_usd: { file: 'agents.yaml', path: ['daily_budget_usd'] },
  'ci_repair.enabled': { file: 'agents.yaml', path: ['roles', 'ci_repair', 'enabled'] },
  'ci_repair.max_fixes_per_pr': { file: 'agents.yaml', path: ['roles', 'ci_repair', 'max_fixes_per_pr'] },
  run_windows: { file: 'config.yaml', path: ['agent_runtime', 'run_windows'] },
  stuck_guard: null,
  'research.max_searches_per_day': null,
  'research.max_fetches_per_day': null,
  'research.max_usd_per_day': null,
  'research.repo_access': null,
  // Intake's caps default from intake.yaml in the instance home, never from the repo's config.
  'intake.reports_per_sender_per_day': null,
  'intake.drafts_per_day': null,
  'intake.max_usd_per_day': null,
};

const defines = (obj: unknown, path: string[]): boolean => {
  let at = obj;
  for (const k of path) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, k)) return false;
    at = (at as Record<string, unknown>)[k];
  }
  return at !== undefined && at !== null;
};

/** The repo's config files as written, before the schema's defaults: what the repo itself defines. Unreadable: none. */
export function repoConfigFiles(dir: string): (file: string) => unknown {
  const cache = new Map<string, unknown>();
  return (file) => {
    if (!cache.has(file)) {
      let raw: unknown;
      try {
        raw = parseDocument(readFileSync(join(dir, file), 'utf8')).toJS();
      } catch {
        raw = undefined;
      }
      cache.set(file, raw);
    }
    return cache.get(file);
  };
}

/**
 * Where a setting's value in effect comes from: the instance's policy when it sets the key (its dotted path),
 * else the repo's config when that defines it, else the engine's own default.
 */
export function settingSource(key: SettingKey, instance: unknown, repo: (file: string) => unknown): 'instance' | 'repo' | 'engine' {
  if (defines(instance, key.split('.'))) return 'instance';
  const place = REPO_PLACE[key];
  return place && defines(repo(place.file), place.path) ? 'repo' : 'engine';
}

/**
 * The Settings page's instance section: each setting's value in effect and where it comes from (the
 * instance's policy, the repo's config, or the engine's default), the bounds a new value must keep (the machine's limits and
 * the policy's own ceilings), and whether this dashboard's user, the owner, may change them.
 */
export function instanceSettingsView(o: Pick<DashboardOptions, 'policyFile' | 'cfg' | 'user' | 'limitsPath'> & { role?: Role | null }) {
  const owner = o.cfg.project.owners.default;
  const base = { owner, user: o.user, canChange: !!o.policyFile && isOwner(o.role), keys: [...SETTING_KEYS] };
  if (!o.policyFile) return { ...base, available: false as const, why: "settings belong to an instance: this dashboard serves a checkout, whose config comes from the repo" };
  let limits: ReturnType<typeof loadLimits> | null = null;
  let limitsError: string | null = null;
  try {
    limits = loadLimits(o.limitsPath);
  } catch (e) {
    limitsError = (e as Error).message;
  }
  let policy: PolicyFile;
  try {
    policy = PolicyFile.parse(parseDocument(readFileSync(o.policyFile, 'utf8')).toJS());
  } catch (e) {
    return { ...base, canChange: false, available: false as const, why: `the instance policy can't be read: ${(e as Error).message.split('\n')[0]}` };
  }
  const s = policy.settings;
  const repo = repoConfigFiles(o.cfg.dir);
  return {
    ...base,
    canChange: base.canChange && !limitsError,
    available: true as const,
    limits,
    limitsError,
    ceilings: { max_workers: policy.agents.max_workers, daily_usd: policy.budget.daily_usd },
    settings: SETTING_KEYS.map((key) => ({ key, value: currentValue(o.cfg, s, key), source: settingSource(key, s, repo) })),
  };
}

/** A research run for its page: each search, each fetch (refused or not), and every cap it stopped at. */
export function researchView(events: { type: string; payload: unknown }[], run: string) {
  const capped = events.filter((e) => e.type === 'research.capped' && (e.payload as { run?: string | null }).run === run).map((e) => String((e.payload as { why?: string }).why ?? ''));
  return { ...researchForRun(events, run), capped };
}

/** Open PRs, and those needing a person: waiting on their review, or a CI fix that gave up. */
export const prCounts = (prs: { state: string; phase: string }[]) => ({
  open: prs.filter((p) => p.state === 'open').length,
  needYou: prs.filter((p) => p.phase === 'waiting' || p.phase === 'gave_up').length,
});

/**
 * Whether this instance merges its own PRs now, read-only, from the same three
 * places the coordinator reads: the instance policy's kill switch (auto_merge,
 * re-read every time), the repo's review.yaml merge.auto, and the stop file a
 * red main after an auto-merge leaves until the operator clears it. Without an
 * instance (a checkout) there is no policy, so nothing auto-merges.
 */
export function autoMergeState(o: { policyFile: string | null; repoAuto: boolean | null; stateDir: string }) {
  let policy: boolean | null = null;
  let policyProblem: string | null = null;
  if (o.policyFile) {
    const r = readPolicy(o.policyFile);
    if (r.policy) policy = r.policy.auto_merge;
    else {
      policy = false;
      policyProblem = `the instance policy can't be read (${r.errors.map((e) => e.message).join('; ') || 'unreadable'}), so auto-merge counts as off`;
    }
  }
  const stopFile = join(o.stateDir, 'auto-merge-stopped.json');
  let stopped: string | null = null;
  if (existsSync(stopFile)) {
    try {
      stopped = String((JSON.parse(readFileSync(stopFile, 'utf8')) as { reason?: string }).reason ?? 'stopped');
    } catch {
      stopped = 'the stop file is unreadable';
    }
  }
  const on = policy === true && o.repoAuto !== false && !stopped;
  const why = !o.policyFile
    ? 'no instance: only an instance merges its own PRs'
    : policy !== true
      ? (policyProblem ?? "the instance policy's kill switch (auto_merge) is off")
      : o.repoAuto === false
        ? "the repo's review.yaml turns auto-merge off"
        : stopped
          ? `stopped: ${stopped}; the operator clears it`
          : 'on: PRs the merge rules allow merge themselves';
  return { on, policy, repo: o.repoAuto, stopped, why };
}

/** Where the coordinator's service output is: its systemd unit's journal and/or the log file a launchd or user service writes. */
export interface LogSource {
  unit: string | null;
  file: string | null;
}

export interface LogEntry {
  at: string | null;
  /** syslog priority (0 emergency .. 7 debug), when the journal gives one. */
  priority: number | null;
  message: string;
}

export interface ServiceLog {
  source: 'journal' | 'file' | 'none';
  unit: string | null;
  entries: LogEntry[];
  /** Why nothing could be read, and what fixes it. */
  problem: string | null;
}

/** Reads a unit's journal as the current user. Injected in tests. */
export type JournalReader = (unit: string, lines: number) => { status: number | null; stdout: string; stderr: string };

const journalctl: JournalReader = (unit, lines) => {
  const r = spawnSync('journalctl', ['--unit', unit, '--output', 'json', '--lines', String(lines), '--no-pager', '--quiet'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
};

const clip = (s: string) => redactString(s.length > 2000 ? `${s.slice(0, 2000)} …` : s);

/**
 * The coordinator's service log, read-only, as the dashboard's user (the
 * instance's coordinator user): its unit's journal, or else its log file.
 * An unprivileged user reads only journal files it owns: with the journal
 * kept on disk and split per user (systemd's default), that is exactly its
 * own service's lines, and no other instance's.
 */
export function readServiceLog(src: LogSource, lines = 200, read: JournalReader = journalctl): ServiceLog {
  let problem: string | null = null;
  if (src.unit) {
    const r = read(src.unit, lines);
    if (r.status === 0) {
      const entries: LogEntry[] = [];
      for (const l of r.stdout.split('\n')) {
        if (!l.trim()) continue;
        try {
          const j = JSON.parse(l) as { MESSAGE?: string | number[] | null; PRIORITY?: string; __REALTIME_TIMESTAMP?: string };
          const msg = typeof j.MESSAGE === 'string' ? j.MESSAGE : Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE).toString('utf8') : '';
          const us = Number(j.__REALTIME_TIMESTAMP);
          entries.push({ at: Number.isFinite(us) && us > 0 ? new Date(us / 1000).toISOString() : null, priority: j.PRIORITY !== undefined && /^\d$/.test(j.PRIORITY) ? Number(j.PRIORITY) : null, message: clip(msg) });
        } catch {
          // not a journal record
        }
      }
      if (entries.length) return { source: 'journal', unit: src.unit, entries, problem: null };
      problem = `no lines of ${src.unit} this user can read. Either the service hasn't logged yet, or the journal isn't kept on disk split per user, so the service's own user can't read its lines: run scripts/setup/journal.sh on the machine (as an admin).`;
    } else {
      problem = `journalctl couldn't read ${src.unit}: ${(r.stderr || `exit ${r.status}`).trim().split('\n').pop()}`;
    }
  }
  if (src.file && existsSync(src.file)) {
    const text = readFileSync(src.file, 'utf8');
    const entries = text.split('\n').filter((l) => l.trim()).slice(-lines).map((message) => ({ at: null, priority: null, message: clip(message) }));
    return { source: 'file', unit: src.unit, entries, problem: entries.length ? null : problem };
  }
  return { source: 'none', unit: src.unit, entries: [], problem: problem ?? 'no service log found: the coordinator runs in the foreground or as a service without a log file' };
}

/** An instance's dashboard port, the same every time (so a tunnel to it can be set up once): 4400-4899, from its name. */
export const instancePort = (name: string) => 4400 + (createHash('sha256').update(name).digest().readUInt32BE(0) % 500);

/** Where the built web UI is served from: dist/web next to this module's dist/src (`npm run build:web` writes it there). */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

/** Whether the web UI is built where the dashboard serves it. */
export const webUiBuilt = (dir = DEFAULT_WEB_DIR) => existsSync(join(dir, 'index.html'));

/** Whether a request carries this token (?t= or a bearer header), compared in constant time. */
export function tokenGiven(req: IncomingMessage, url: URL, token: string): boolean {
  const given = url.searchParams.get('t') ?? (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The built UI; anything unknown falls back to index.html (client-side routes). Never a file outside webDir. */
/** The marker a hub puts on the page it serves, so the UI asks for the hub's instances only there (else /api/hub is a 404). */
export const HUB_MARKER = '<meta name="dashboard-hub" content="1">';

export function serveStatic(webDir: string, url: URL, res: ServerResponse, opts: { hub?: boolean } = {}): void {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = resolve(webDir, rel);
  if (!file.startsWith(resolve(webDir) + sep) && file !== resolve(webDir)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || !extname(file)) file = join(webDir, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('dashboard UI not built: run `npm run build:web` in the engine');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-store' : 'max-age=3600' });
  if (opts.hub && extname(file) === '.html') {
    const html = readFileSync(file, 'utf8');
    return void res.end(html.includes('</head>') ? html.replace('</head>', `${HUB_MARKER}</head>`) : `${HUB_MARKER}${html}`);
  }
  res.end(readFileSync(file));
}

export function dashboardToken(stateDir: string): string {
  const f = join(stateDir, 'dashboard-token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  mkdirSync(stateDir, { recursive: true });
  const t = randomBytes(24).toString('base64url');
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

function readEvents(dbPath: string, after = 0): StoredEvent[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(after) as { id: number; ts: string; type: string; actor: string; source: string; payload: string }[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }) as StoredEvent);
  } finally {
    db.close();
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export function startDashboard(opts: DashboardOptions): Promise<{ server: Server; url: string; token: string; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  try {
    assertLoopbackHost(host);
  } catch (e) {
    return Promise.reject(e);
  }
  const token = dashboardToken(opts.stateDir);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const viewsFile = join(opts.stateDir, 'dashboard-views.json');
  const clients = new Set<ServerResponse>();
  let lastId = readEvents(opts.eventsDb).at(-1)?.id ?? 0;

  const owners = opts.cfg.project.owners;
  const repo = opts.cfg.project.project.repo;

  /**
   * Who is asking, or why not. The token is required either way. With a person named (the hub signed them in),
   * their role is their permission on this instance's repo, never one the caller sends; without, it is the
   * owner's break-glass, accepted only from this machine's loopback and never through a proxy.
   */
  const identify = async (req: IncomingMessage, url: URL): Promise<Who | { status: number; error: string; login?: string }> => {
    if (!tokenGiven(req, url, token)) return { status: 401, error: 'missing or wrong token; sign in through the hub, or open the URL printed by `dashboard` on this machine' };
    const named = req.headers[LOGIN_HEADER];
    if (named !== undefined) {
      if (!validLogin(named)) return { status: 400, error: 'not a GitHub login' };
      const role = opts.roleOf ? await opts.roleOf(named) : null;
      if (!role) return { status: 403, login: named, error: `@${named} has no access to this instance: it needs at least read access to ${repo}` };
      return { login: named, role, via: 'session' };
    }
    if (!breakGlassAllowed(req)) return { status: 403, error: "the token is the owner's break-glass: accepted only on this machine, never through a proxy" };
    return { login: opts.user || owners.default, role: 'owner', via: 'break-glass' };
  };

  /** Every write a person makes, recorded with who (login and role), how they came in, the instance and what was done. */
  const audit = (who: Who, action: string, detail: Record<string, unknown>) => {
    const log = new EventLog(opts.eventsDb);
    try {
      log.append('dashboard.audit', { login: who.login, role: who.role, via: who.via, instance: opts.instance ?? null, action, detail }, who.login, 'human');
    } finally {
      log.close();
    }
  };

  const state = (who: Who) => {
    const events = readEvents(opts.eventsDb);
    const p = project(events);
    const slots = slotStatus(opts.slotsDir);
    return {
      brand: { name: BRAND.name, cli: BRAND.cli },
      project: { name: opts.cfg.project.project.name, repo: opts.cfg.project.project.repo, landMode: opts.cfg.project.land_mode },
      user: who.login,
      role: who.role,
      via: who.via,
      owners: opts.cfg.project.owners,
      budget: opts.cfg.agents.daily_budget_usd,
      slots: { cap: slots.cap, running: slots.agents.length, agents: slots.agents, fullRun: slots.fullRun },
      ...p,
      decisions: p.decisions.map((d) => ({ ...d, canAnswer: mayAnswerKind(d.kind, who.role) })),
      // Whether this viewer may read intake reports, so the page asks for them only when it will get them.
      canReadIntake: mayReadIntake(who.role),
      // Whether this viewer may read the throughput panel, so the page asks for it only when it will get it.
      canReadThroughput: mayReadThroughput(who.role),
      // Whether this viewer may read the report preview, so the page asks for it only when it will get it.
      canReadReports: mayReadReports(who.role),
      // Whether this viewer may read agent runs, so the page asks for them only when it will get them.
      canReadRuns: mayReadRuns(who.role),
      // Whether this viewer may read what waits on the owner, so the page asks only when it will get it.
      canReadDigest: mayReadDigest(who.role),
      // Whether this viewer may write at all (viewers are read-only), and see the audit log (owners only).
      canWrite: isWriter(who.role),
      canReadAudit: isOwner(who.role),
      // Every cost figure is Claude Code's own estimate of a run's cost, not money billed.
      costBasis: 'estimate' as const,
      emergency: stopStatus(emergencyStop(opts.slotsDir), p.emergency),
      inbox: inbox(p, who.login),
      // For the sidebar: open PRs, and how many wait for a person or gave up on CI.
      prCounts: prCounts(prsView(events).prs),
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        const id = await identify(req, url);
        // The hub asks this of each instance, to list only the ones the person has a role on.
        if (url.pathname === '/api/role' && req.method === 'GET') {
          if ('status' in id) return id.status === 403 && id.login ? json(res, 200, { login: id.login, role: null }) : json(res, id.status, { error: id.error });
          return json(res, 200, { login: id.login, role: id.role, via: id.via });
        }
        if ('status' in id) return json(res, id.status, { error: id.error });
        const who = id;
        const isOwnerHere = isOwner(who.role);
        // Viewers are read-only: every write is refused before any route sees it, whatever route is added later.
        if (req.method !== 'GET' && req.method !== 'HEAD' && !isWriter(who.role)) return json(res, 403, { error: `@${who.login} is a viewer here (read on ${repo}): read-only` });
        if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state(who));
        // The audit log: every write made on this dashboard, newest first; the owners' to read.
        if (url.pathname === '/api/audit' && req.method === 'GET') {
          if (!isOwnerHere) return json(res, 403, { error: `the audit log is for the instance's owners (admin on ${repo}); @${who.login} is a ${who.role}` });
          return json(res, 200, { entries: readEvents(opts.eventsDb).filter((e) => e.type === 'dashboard.audit').reverse().slice(0, 500).map((e) => ({ id: e.id, at: e.ts, ...(e.payload as object) })) });
        }
        // The next report's preview (with the throughput section, which the posted report leaves out): the owner's and
        // the writers', like the throughput it carries.
        if (url.pathname === '/api/report' && req.method === 'GET') {
          if (!mayReadReports(who.role)) return json(res, 403, { error: writersOnly('the report preview is', who) });
          const events = readEvents(opts.eventsDb);
          const last = [...events].reverse().find((e) => e.type === 'report.posted');
          return json(res, 200, { report: buildReport(events, opts.cfg, { since: last ? new Date(last.ts) : new Date(Date.now() - 12 * 3_600_000), throughput: true }).markdown });
        }
        if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settingsView(opts.cfg));
        if (url.pathname === '/api/events' && req.method === 'GET') {
          const evs = readEvents(opts.eventsDb, Number(url.searchParams.get('after') ?? 0)).filter((e) => e.type !== 'coordinator.tick');
          const issue = url.searchParams.get('issue');
          // One issue's whole history, or the recent tail of everything.
          return json(res, 200, issue ? evs.filter((e) => (e.payload as { issue?: number }).issue === Number(issue)) : evs.slice(-500));
        }
        if (url.pathname === '/api/logs' && req.method === 'GET') {
          const lines = Math.min(1000, Math.max(1, Number(url.searchParams.get('lines') ?? 200) || 200));
          return json(res, 200, readServiceLog(opts.logs ?? { unit: null, file: null }, lines, opts.journalReader));
        }
        // Agent runs are the owner's and the writers' to read: one gate in front of every path that serves them.
        if (isRunsPath(url.pathname) && !mayReadRuns(who.role)) return json(res, 403, { error: writersOnly('agent runs are', who) });
        // Agent runs, as the runner recorded them in this state dir: an issue's list, or one run in full.
        if (url.pathname === '/api/runs' && req.method === 'GET') {
          const issue = Number(url.searchParams.get('issue'));
          if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { error: 'issue must be a number' });
          return json(res, 200, runsForIssue(opts.stateDir, issue));
        }
        // The chat: ask a question (a request the coordinator answers), poll for the answer, and, for the owner,
        // file a draft it proposed: the stored draft, validated again here, with `ready`, through this instance's backlog.
        if (url.pathname === '/api/chat' && req.method === 'POST') {
          const body = (await readBody(req)) as { question?: string; key?: unknown };
          try {
            // `key`: the client's request key, so a retried POST is the same question, not a second turn.
            const asked = askChat({ stateDir: opts.stateDir, question: String(body.question ?? ''), by: who.login, ...(body.key !== undefined ? { key: String(body.key) } : {}) });
            audit(who, 'chat.asked', { id: asked.id });
            return json(res, 200, asked);
          } catch (e) {
            if (e instanceof ChatError) return json(res, 400, { error: e.message });
            throw e;
          }
        }
        const chat = url.pathname.match(/^\/api\/chat\/([0-9]+-[a-f0-9]+)(\/file-issue)?$/);
        if (chat) {
          const f = chatAnswer(opts.stateDir, chat[1]!);
          if (!f) return json(res, 404, { error: `no chat question ${chat[1]}` });
          if (!chat[2] && req.method === 'GET') {
            const rec = existsSync(filedPath(opts.stateDir, chat[1]!)) ? (JSON.parse(readFileSync(filedPath(opts.stateDir, chat[1]!), 'utf8')) as { number?: number }) : null;
            const filed = typeof rec?.number === 'number' ? { number: rec.number } : null;
            return json(res, 200, { ...chatAnswerFor(f, isOwnerHere), owner: isOwnerHere, filed });
          }
          if (chat[2] && req.method === 'POST') {
            if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may file a draft; @${who.login} is a ${who.role}` });
            if (f.state !== 'answered' || !f.answer.issueDraft) return json(res, 400, { error: 'this answer has no issue draft' });
            if (existsSync(filedPath(opts.stateDir, chat[1]!))) return json(res, 409, { error: 'this draft was filed already', ...(JSON.parse(readFileSync(filedPath(opts.stateDir, chat[1]!), 'utf8')) as object) });
            // The draft as the answer file has it, never one from the request, checked again as the harness will.
            const d = validateDraft(f.answer.issueDraft.title, f.answer.issueDraft.body);
            if (!d.ok) return json(res, 400, { error: `the draft isn't one the harness can take: ${d.why}` });
            if (!opts.backlog) return json(res, 400, { error: 'this dashboard has no backlog to file to' });
            // Claimed before filing (created only if absent), so two confirms at once file it once; released if filing fails.
            mkdirSync(join(opts.stateDir, 'chat', 'filed'), { recursive: true });
            try {
              writeFileSync(filedPath(opts.stateDir, chat[1]!), JSON.stringify({ filing: true, at: new Date().toISOString(), by: who.login }), { mode: 0o600, flag: 'wx' });
            } catch {
              return json(res, 409, { error: 'this draft is being filed already' });
            }
            let number: number;
            try {
              number = await opts.backlog().createIssue(d.title, d.body, ['ready']);
            } catch (e) {
              rmSync(filedPath(opts.stateDir, chat[1]!), { force: true });
              throw e;
            }
            writeFileSync(filedPath(opts.stateDir, chat[1]!), JSON.stringify({ number, at: new Date().toISOString(), by: who.login }), { mode: 0o600 });
            audit(who, 'chat.draft_filed', { id: chat[1]!, issue: number });
            return json(res, 200, { ok: true, number });
          }
        }
        // A research run's searches and fetches (refusals marked) and where it stopped at a cap; who may read it
        // is the runs gate's to say (the owner and the writers), as for the rest of the run.
        const research = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/research$/);
        if (research && req.method === 'GET') return json(res, 200, researchView(readEvents(opts.eventsDb), research[1]!));
        // The console: the live runs, one run's live feed (SSE while it runs), and the owner's message and stop.
        if (url.pathname === '/api/live' && req.method === 'GET') return json(res, 200, liveView({ ...opts, user: who.login, role: who.role }));
        const con = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/(feed|live|console|message|stop)$/);
        if (con) {
          const [, run, what] = con as unknown as [string, string, string];
          const consoleError = (e: unknown) => {
            if (!(e instanceof ConsoleError)) throw e;
            return json(res, /only the owner/.test(e.message) ? 403 : /isn't live|no feed/.test(e.message) ? 404 : 400, { error: e.message });
          };
          if (what === 'console' && req.method === 'GET') return json(res, 200, consoleView({ ...opts, user: who.login, role: who.role }, run));
          if (what === 'feed' && req.method === 'GET') {
            try {
              return json(res, 200, feedOrWait(opts, run, Number(url.searchParams.get('after') ?? -1)));
            } catch (e) {
              return consoleError(e);
            }
          }
          if (what === 'live' && req.method === 'GET') {
            let after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? -1);
            if (!Number.isInteger(after)) after = -1;
            try {
              feedOrWait(opts, run, after); // the run must have a feed or be live
            } catch (e) {
              return consoleError(e);
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
            res.write('retry: 2000\nevent: hello\ndata: {}\n\n');
            let done = false;
            const tick = () => {
              if (done) return;
              let f: { items: FeedItem[]; ended: boolean };
              try {
                f = feedOrWait(opts, run, after);
              } catch {
                return;
              }
              for (const it of f.items) {
                res.write(`id: ${it.seq}\nevent: item\ndata: ${JSON.stringify(it)}\n\n`);
                after = it.seq;
              }
              if (f.ended) {
                done = true;
                clearInterval(poll);
                clearInterval(keep);
                res.write('event: end\ndata: {}\n\n');
                res.end();
              }
            };
            const poll = setInterval(tick, opts.pollMs ?? 500);
            const keep = setInterval(() => !done && res.write(': ping\n\n'), 25_000);
            req.on('close', () => {
              done = true;
              clearInterval(poll);
              clearInterval(keep);
            });
            tick();
            return;
          }
          if ((what === 'message' || what === 'stop') && req.method === 'POST') {
            const body = (await readBody(req)) as { text?: string };
            try {
              const r = what === 'message' ? sendMessage({ stateDir: opts.stateDir, cfg: opts.cfg, run, text: String(body.text ?? ''), by: who.login, owner: isOwnerHere }) : stopRun({ stateDir: opts.stateDir, cfg: opts.cfg, run, by: who.login, owner: isOwnerHere });
              audit(who, what === 'message' ? 'console.message' : 'console.stop', { run, request: r.id });
              return json(res, 200, { ok: true, ...r });
            } catch (e) {
              return consoleError(e);
            }
          }
        }
        if (url.pathname.startsWith('/api/runs/') && req.method === 'GET') {
          const run = readRun(opts.stateDir, decodeURIComponent(url.pathname.slice('/api/runs/'.length)));
          return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
        }
        // Pull requests the harness opened, their checks, fix runs and merge calls, and this instance's auto-merge state.
        if (url.pathname === '/api/prs' && req.method === 'GET') {
          return json(res, 200, { ...prsView(readEvents(opts.eventsDb)), autoMerge: autoMergeState({ policyFile: opts.policyFile ?? null, repoAuto: opts.cfg.review?.merge.auto ?? null, stateDir: opts.stateDir }) });
        }
        // Machine health: memory, CPU and disk, check times and slowdowns, the runs' usage per day, suggestions.
        // Intake: each report (redacted) and what became of it, and the numbers for the health panel. The owner's
        // and the writers' to read, like the runs.
        if (url.pathname === '/api/intake' && req.method === 'GET') {
          if (!mayReadIntake(who.role)) return json(res, 403, { error: writersOnly('intake reports are', who) });
          const events = readEvents(opts.eventsDb);
          return json(res, 200, { reports: intakeReports(events), health: intakeHealth(events) });
        }
        // Throughput: merged PRs, cost per merged PR by stage, where PRs waited for the owner, the top costs with a
        // tuning each. The owner's and the writers' to read, like the runs it is made of.
        if (url.pathname === '/api/throughput' && req.method === 'GET') {
          if (!mayReadThroughput(who.role)) return json(res, 403, { error: writersOnly('throughput is', who) });
          return json(res, 200, throughput(readEvents(opts.eventsDb)));
        }
        // Waiting on you: every owner-held state open now, with how long it has waited, and the digest's Markdown
        // (what the daily GitHub comment posts). The owner's and the writers', like runs.
        if (url.pathname === '/api/waiting' && req.method === 'GET') {
          if (!mayReadDigest(who.role)) return json(res, 403, { error: writersOnly('what waits on the owner is', who) });
          const digest = waitingOnYou(readEvents(opts.eventsDb));
          return json(res, 200, { ...digest, markdown: digestMarkdown(digest, { project: opts.cfg.project.project.name }) });
        }
        if (url.pathname === '/api/health' && req.method === 'GET') {
          let stats: MachineStats | null = null;
          try {
            stats = (opts.machineStats ?? (() => healthStats({ serviceUnit: opts.logs?.unit ?? null, root: opts.root, stateDir: opts.stateDir })))();
          } catch {
            // no stats: the view says unknown
          }
          return json(res, 200, { ...healthView(readEvents(opts.eventsDb), stats, { cores: cpuCount(), diskLabels: { [opts.root]: 'the checkout', [opts.stateDir]: 'the state dir' } }), docs: { backups: docsUrl('backups') } });
        }
        // The instance's own settings (policy.yaml): what's in effect, the bounds, and, for the owner, a change.
        if (url.pathname === '/api/instance-settings' && req.method === 'GET') return json(res, 200, instanceSettingsView({ ...opts, user: who.login, role: who.role }));
        if (url.pathname === '/api/instance-settings' && req.method === 'POST') {
          if (!opts.policyFile) return json(res, 400, { error: 'settings are an instance\'s: this dashboard serves a checkout' });
          const body = (await readBody(req)) as { key?: string; value?: unknown };
          try {
            const r = changeSetting({ policyPath: opts.policyFile, cfg: opts.cfg, eventsDb: opts.eventsDb, key: String(body.key ?? ''), value: body.value, by: who.login, owner: isOwnerHere, ...(opts.limitsPath ? { limitsPath: opts.limitsPath } : {}) });
            audit(who, 'settings.changed', { key: String(body.key ?? ''), from: r.from, to: r.to });
            return json(res, 200, { ok: true, ...r });
          } catch (e) {
            if (e instanceof SettingsError) return json(res, /only the owner/.test(e.message) ? 403 : 400, { error: e.message });
            throw e;
          }
        }
        // Machine-wide settings (the slot cap, engine updates) and their history. A change goes through the
        // machine helper (sudo, src/machine.ts) as this server's user, the instance's coordinator; only the owner may ask.
        const machine = () => machineView({ ...opts, user: who.login, role: who.role });
        if (url.pathname === '/api/machine' && req.method === 'GET') return json(res, 200, machine());
        if (url.pathname === '/api/machine' && req.method === 'POST') {
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may change machine settings; @${who.login} is a ${who.role}` });
          const body = (await readBody(req)) as { what?: string; value?: unknown };
          const exec = opts.machine?.exec;
          let r;
          if (body.what === 'slots') r = setSlotCap(Number(body.value), ...(exec ? [exec] : []));
          else if (body.what === 'updates') {
            if (typeof body.value !== 'boolean') return json(res, 400, { error: 'updates is on (true) or off (false)' });
            r = setUpdates(body.value, ...(exec ? [exec] : []));
          } else return json(res, 400, { error: 'what is slots or updates' });
          if (!r.ok) return json(res, 400, { error: r.error });
          audit(who, 'machine.changed', { what: body.what, value: body.value });
          return json(res, 200, { ok: true, output: r.output, machine: machine() });
        }
        if (url.pathname === '/api/checks' && req.method === 'GET') {
          const issue = Number(url.searchParams.get('issue'));
          if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { error: 'issue must be a number' });
          return json(res, 200, checkResults(readEvents(opts.eventsDb), issue));
        }
        if (url.pathname === '/api/stream' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? lastId);
          res.write(`retry: 3000\nid: ${Math.max(since, lastId)}\nevent: hello\ndata: {}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        if (url.pathname === '/api/decide' && req.method === 'POST') {
          const body = (await readBody(req)) as { id?: string; answer?: string };
          const log = new EventLog(opts.eventsDb);
          try {
            const q = log.read(0, ['decision.asked']).find((e) => (e.payload as { id: string }).id === body.id)?.payload as { options: string[]; owner: string; kind: string } | undefined;
            if (!q) return json(res, 404, { error: `no decision ${body.id}` });
            if (!mayAnswerKind(q.kind, who.role)) return json(res, 403, { error: `@${who.login} can't answer this: a ${q.kind === 'plan' ? 'held plan' : 'high-risk merge'} is for the instance's owners (admin on ${repo}); @${who.login} is a ${who.role}` });
            if (!body.answer || !q.options.includes(body.answer)) return json(res, 400, { error: `answer must be one of ${q.options.join(', ')}` });
            const answered = log.read(0, ['decision.answered']).some((e) => (e.payload as { id: string }).id === body.id);
            if (answered) return json(res, 409, { error: 'already answered' });
            // With the role this server read, so the coordinator acts on a writer's answer (an intake approval) too.
            const e = log.append('decision.answered', { id: body.id!, by: who.login, answer: body.answer, role: who.role === 'owner' ? 'owner' : 'writer' }, who.login, 'human');
            audit(who, 'decision.answered', { id: body.id!, kind: q.kind, answer: body.answer });
            return json(res, 200, { ok: true, event: e.id });
          } finally {
            log.close();
          }
        }
        if (url.pathname === '/api/views') {
          if (req.method === 'GET') return json(res, 200, existsSync(viewsFile) ? JSON.parse(readFileSync(viewsFile, 'utf8')) : []);
          if (req.method === 'PUT') {
            const views = await readBody(req);
            if (!Array.isArray(views) || views.length > 50) return json(res, 400, { error: 'views must be an array (max 50)' });
            writeFileSync(viewsFile, JSON.stringify(views, null, 2));
            audit(who, 'views.saved', { count: views.length });
            return json(res, 200, { ok: true });
          }
        }
        return json(res, 404, { error: 'not found' });
      }
      serveStatic(webDir, url, res);
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  // The coordinator writes the log from another process: poll it and fan new events out.
  const poll = setInterval(() => {
    if (!clients.size) return;
    const fresh = readEvents(opts.eventsDb, lastId);
    if (!fresh.length) return;
    lastId = fresh.at(-1)!.id;
    const visible = fresh.filter((e) => e.type !== 'coordinator.tick');
    const msg = `id: ${lastId}\nevent: change\ndata: ${JSON.stringify({ lastId, types: [...new Set(visible.map((e) => e.type))] })}\n\n`;
    for (const c of clients) c.write(msg);
  }, opts.pollMs ?? 1000);
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);

  return new Promise((resolveStart) => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveStart({
        server,
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/?t=${token}`,
        token,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(poll);
            clearInterval(ping);
            for (const c of clients) c.end();
            server.close(() => r());
          }),
      });
    });
  });
}
