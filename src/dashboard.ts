// The local dashboard server: static UI plus a small API over the event
// log. It binds to 127.0.0.1, requires a per-install token, reads the log
// read-only, and pushes changes over one SSE stream. Its only write is a
// human answering a decision, recorded as an event like the CLI does, and
// only by that decision's owner or one of the project's writers.
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { siteForInstance, siteForRoot } from './service.js';
import { readRun, runsForIssue } from './run-record.js';
import { emergencyStop, slotStatus, type EmergencyStop } from './slots.js';
import { buildReport } from './reports.js';

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
  user: string;
  port?: number;
  webDir?: string;
  pollMs?: number;
  /** Where the coordinator's service log is (the Logs page); none when unset. */
  logs?: LogSource;
  /** Reads a unit's journal; journalctl as this user when unset. */
  journalReader?: JournalReader;
  /** The machine's slots directory (agent slots and the emergency STOP file); the usual one when unset. */
  slotsDir?: string;
  /** The instance's policy file (its auto-merge kill switch); none for a checkout. */
  policyFile?: string | null;
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

/** Who may answer a decision from the dashboard: its owner, or one of the project's writers. GitHub logins are case-insensitive. */
export function mayAnswer(owner: string, user: string, owners: { writers: string[] }): boolean {
  const u = user.toLowerCase();
  return !!u && (owner.toLowerCase() === u || owners.writers.some((w) => w.toLowerCase() === u));
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

/**
 * Which log and state a dashboard reads. A project checkout's own, or, with
 * an instance, that instance's: run it as the instance's coordinator user,
 * the only user that can read (and, for answers, write) the instance's log.
 */
export function dashboardSite(root: string, instance?: string, dir = instancesDir()): { root: string; cfg: Config; eventsDb: string; stateDir: string; port: number; logs: LogSource; policyFile: string | null } {
  const i = instance ? loadInstance(instance, dir) : null;
  const s = i ? siteForInstance(i) : siteForRoot(root);
  // An instance's service on Linux is the systemd unit the setup scripts install; elsewhere the coordinator writes its own log file.
  const logs = { unit: instance ? `${BRAND.cli}-${instance}.service` : null, file: join(s.stateDir, 'coordinator.log') };
  return { root: s.root, cfg: s.cfg, eventsDb: s.logPath, stateDir: s.stateDir, port: instance ? instancePort(instance) : 4317, logs, policyFile: i ? join(i.home, 'policy.yaml') : null };
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
export function serveStatic(webDir: string, url: URL, res: ServerResponse): void {
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
  const token = dashboardToken(opts.stateDir);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const viewsFile = join(opts.stateDir, 'dashboard-views.json');
  const clients = new Set<ServerResponse>();
  let lastId = readEvents(opts.eventsDb).at(-1)?.id ?? 0;

  const authed = (req: IncomingMessage, url: URL) => tokenGiven(req, url, token);

  const state = () => {
    const events = readEvents(opts.eventsDb);
    const p = project(events);
    const slots = slotStatus(opts.slotsDir);
    return {
      brand: { name: BRAND.name, cli: BRAND.cli },
      project: { name: opts.cfg.project.project.name, repo: opts.cfg.project.project.repo, landMode: opts.cfg.project.land_mode },
      user: opts.user,
      owners: opts.cfg.project.owners,
      budget: opts.cfg.agents.daily_budget_usd,
      slots: { cap: slots.cap, running: slots.agents.length, agents: slots.agents, fullRun: slots.fullRun },
      ...p,
      decisions: p.decisions.map((d) => ({ ...d, canAnswer: mayAnswer(d.owner, opts.user, opts.cfg.project.owners) })),
      // Every cost figure is Claude Code's own estimate of a run's cost, not money billed.
      costBasis: 'estimate' as const,
      emergency: stopStatus(emergencyStop(opts.slotsDir), p.emergency),
      inbox: inbox(p, opts.user),
      // For the sidebar: open PRs, and how many wait for a person or gave up on CI.
      prCounts: prCounts(prsView(events).prs),
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!authed(req, url)) return json(res, 401, { error: 'missing or wrong token; open the URL printed by `dashboard`' });
        if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state());
        if (url.pathname === '/api/report' && req.method === 'GET') {
          const events = readEvents(opts.eventsDb);
          const last = [...events].reverse().find((e) => e.type === 'report.posted');
          return json(res, 200, { report: buildReport(events, opts.cfg, { since: last ? new Date(last.ts) : new Date(Date.now() - 12 * 3_600_000) }).markdown });
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
        // Agent runs, as the runner recorded them in this state dir: an issue's list, or one run in full.
        if (url.pathname === '/api/runs' && req.method === 'GET') {
          const issue = Number(url.searchParams.get('issue'));
          if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { error: 'issue must be a number' });
          return json(res, 200, runsForIssue(opts.stateDir, issue));
        }
        if (url.pathname.startsWith('/api/runs/') && req.method === 'GET') {
          const run = readRun(opts.stateDir, decodeURIComponent(url.pathname.slice('/api/runs/'.length)));
          return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
        }
        // Pull requests the harness opened, their checks, fix runs and merge calls, and this instance's auto-merge state.
        if (url.pathname === '/api/prs' && req.method === 'GET') {
          return json(res, 200, { ...prsView(readEvents(opts.eventsDb)), autoMerge: autoMergeState({ policyFile: opts.policyFile ?? null, repoAuto: opts.cfg.review?.merge.auto ?? null, stateDir: opts.stateDir }) });
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
            const q = log.read(0, ['decision.asked']).find((e) => (e.payload as { id: string }).id === body.id)?.payload as { options: string[]; owner: string } | undefined;
            if (!q) return json(res, 404, { error: `no decision ${body.id}` });
            if (!mayAnswer(q.owner, opts.user, opts.cfg.project.owners)) return json(res, 403, { error: `@${opts.user} can't answer this: it's for @${q.owner} (or one of the project's writers)` });
            if (!body.answer || !q.options.includes(body.answer)) return json(res, 400, { error: `answer must be one of ${q.options.join(', ')}` });
            const answered = log.read(0, ['decision.answered']).some((e) => (e.payload as { id: string }).id === body.id);
            if (answered) return json(res, 409, { error: 'already answered' });
            const e = log.append('decision.answered', { id: body.id!, by: opts.user, answer: body.answer }, opts.user, 'human');
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
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveStart({
        server,
        url: `http://127.0.0.1:${port}/?t=${token}`,
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
