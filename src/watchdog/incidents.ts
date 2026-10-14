// Incidents: what broke on this machine and needs a person, kept until it is resolved. One machine-wide store, in
// the slot directory every instance's coordinator can write (like the Discord identify gate's state), so any
// coordinator, and any module in it, reports into the same place:
//   raiseIncident(kind, key, detail, fix)  something is wrong now (again: the same open incident, not a new one)
//   resolveIncident(kind, key)             it is fine now
// An incident is one kind and key (a unit, a commit, a path, an instance's login): raising it while it is open
// updates it, resolving it closes it; one resolved within REOPEN_MS that breaks again is reopened, not new. The
// watchdog (./watchdog.ts) posts each incident once to the ops channel, and once more when it is resolved
// (./post.ts); the Health page lists them (GET /api/health/incidents).
//
// Never a secret: every text is redacted before it is stored, and again before it is posted. A title is fixed per
// kind (no data in it), so what a viewer is shown of an incident (viewer-events.ts) can't carry any either.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactString } from '../events/redact.js';
import { tryLock } from '../locks.js';
import { slotsDir } from '../os/index.js';
import { USAGE_INCIDENT } from '../usage-limit.js';
import { CONFIG_INCIDENT } from '../config/live.js';
import { DEPLOY_GATE_INCIDENT, POST_DEPLOY_INCIDENT, POST_DEPLOY_WAIT_INCIDENT } from '../deploy-gate/config.js';
import { TASK_BUDGET_INCIDENT } from '../coordinator/loop-control.js';

export const INCIDENTS_FILE = 'incidents.json';
const LOCK_FILE = 'incidents.lock';
/** A resolved incident that breaks again within this long is the same incident, reopened (no second post). */
export const REOPEN_MS = 15 * 60_000;
/** Resolved incidents kept for the history. */
export const HISTORY = 200;

/** red: something is down or unsafe and work stops; amber: it will be, or work is slow, unless someone acts. */
export type Severity = 'red' | 'amber';

/** The kinds the watchdog raises itself (and the usage pause the coordinator raises), each with its fixed title and severity. Other modules may raise their own. */
export const KINDS = {
  unit_down: { title: 'A service is down', severity: 'red' },
  crash_loop: { title: 'A service is crash-looping', severity: 'red' },
  update_rollback: { title: 'An engine update was rolled back', severity: 'red' },
  // Raised by the engine updater (scripts/machine/<cli>-update.cjs): one engine commit for hours while main moved on.
  update_stuck: { title: 'The engine is not updating', severity: 'amber' },
  claude_auth: { title: 'Claude sign-in is failing', severity: 'red' },
  claude_login_expiring: { title: 'A Claude login is about to expire', severity: 'amber' },
  github_auth: { title: 'GitHub access is failing', severity: 'red' },
  stalled: { title: 'Ready work is not moving', severity: 'amber' },
  auto_merge_stopped: { title: 'The main watch stopped auto-merge', severity: 'red' },
  disk_full: { title: 'Disk almost full', severity: 'red' },
  test_sandbox: { title: 'The test sandbox check is failing', severity: 'red' },
  helper_outdated: { title: 'The test sandbox helper is outdated: no test run starts', severity: 'red' },
  // Raised by the engine updater (scripts/machine/<cli>-update.cjs): after an install, an instance never said whether its sandbox check passed.
  update_sandbox_unconfirmed: { title: "An engine update couldn't confirm the test sandbox", severity: 'amber' },
  // Raised by the coordinator itself (src/usage-limit.ts), not a probe: runs wait for the limit's reset.
  [USAGE_INCIDENT]: { title: 'Claude usage limit reached: runs are paused', severity: 'amber' },
  // Raised by the coordinator (src/config/live.ts): the default branch's config is invalid; the last good one runs on.
  [CONFIG_INCIDENT]: { title: 'The config on the default branch is invalid', severity: 'amber' },
  // Raised by the coordinator (src/deploy-gate/gate.ts): someone moved the deploy branch; the gate refuses to move it.
  [DEPLOY_GATE_INCIDENT]: { title: 'The deploy branch moved outside the gate', severity: 'red' },
  // Raised by the coordinator (src/deploy-gate/post-deploy.ts): production failed its smoke check after a deploy.
  [POST_DEPLOY_INCIDENT]: { title: 'Production failed its post-deploy check', severity: 'red' },
  // Raised by the coordinator (src/deploy-gate/post-deploy.ts): the host didn't deploy the deploy branch's commit in time.
  [POST_DEPLOY_WAIT_INCIDENT]: { title: "Production didn't deploy the deploy branch's commit", severity: 'amber' },
  // Raised by the coordinator (src/coordinator/loop-control.ts): an issue's runs reached 85% of its agents.yaml budget.
  [TASK_BUDGET_INCIDENT]: { title: 'A task is near its budget', severity: 'amber' },
} as const satisfies Record<string, { title: string; severity: Severity }>;
export type WatchdogKind = keyof typeof KINDS;

export interface Incident {
  /** Stable for the incident's life: the Health page's anchor (#incident-<id>) and the post's link. */
  id: string;
  kind: string;
  key: string;
  /** The instance it is about; null for the machine (a disk, the hub, the updater). */
  instance: string | null;
  severity: Severity;
  /** Fixed per kind: never data. */
  title: string;
  /** What broke, redacted. */
  detail: string;
  /** The one action that fixes it, redacted. */
  fix: string;
  /** What the harness already tried on its own (restarts, a rollback, a retry), redacted. */
  tried: string[];
  since: string;
  lastSeen: string;
  resolvedAt: string | null;
  /** When the watchdog posted it, and its resolution; skipped: resolved before it was ever posted (never posted). */
  posted: { raised?: string; resolved?: string; skipped?: boolean };
}

export interface IncidentFile {
  incidents: Incident[];
  /** When each recent post went out, machine-wide (the rate limit). */
  posts: string[];
}

export interface RaiseOptions {
  instance?: string | null;
  severity?: Severity;
  tried?: string[];
  /** The store's directory; the machine's slot directory when unset. */
  dir?: string;
  now?: Date;
}

/** The store's directory: the machine's slot directory, which every instance's coordinator can write. */
export const incidentsDir = (dir?: string) => dir ?? slotsDir();

/** A Discord bot token's shape (three dot-separated base64url parts): never stored or posted, whoever's it is. */
export const DISCORD_TOKEN = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g;

/** A text with every secret-shaped string taken out. */
export const redactIncidentText = (s: string) => redactString(s).replace(DISCORD_TOKEN, '[REDACTED]');

const clip = (s: string, n: number) => {
  const r = redactIncidentText(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return r.length > n ? `${r.slice(0, n - 1)}…` : r;
};

/** The store as it is now; empty when missing or unreadable. */
export function readIncidents(dir?: string): IncidentFile {
  try {
    const j = JSON.parse(readFileSync(join(incidentsDir(dir), INCIDENTS_FILE), 'utf8')) as Partial<IncidentFile>;
    return { incidents: Array.isArray(j.incidents) ? j.incidents : [], posts: Array.isArray(j.posts) ? j.posts.filter((p) => typeof p === 'string') : [] };
  } catch {
    return { incidents: [], posts: [] };
  }
}

function writeIncidents(dir: string, f: IncidentFile): void {
  const file = join(dir, INCIDENTS_FILE);
  // Whole or not at all: a reader never sees half a file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o660 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Change the store under its lock: read, change, write. The change returns what the caller gets back. */
export function withIncidents<T>(dir: string | undefined, change: (f: IncidentFile) => T): T {
  const d = incidentsDir(dir);
  mkdirSync(d, { recursive: true });
  const lockPath = join(d, LOCK_FILE);
  for (let i = 0; ; i++) {
    const r = tryLock(lockPath, `incidents ${process.pid}`);
    if ('lock' in r) {
      try {
        const f = readIncidents(d);
        const out = change(f);
        // Open ones always stay; the history keeps the newest resolved.
        const resolved = f.incidents.filter((x) => x.resolvedAt).sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!)).slice(0, HISTORY);
        f.incidents = [...f.incidents.filter((x) => !x.resolvedAt), ...resolved];
        writeIncidents(d, f);
        return out;
      } finally {
        r.lock.release();
      }
    }
    // A holder keeps it for a read and a write: milliseconds. Give up after about 5 s rather than block a tick.
    if (i >= 250) throw new Error(`the incident store's lock (${lockPath}) stayed held`);
    pause(20);
  }
}

const meta = (kind: string) => (KINDS as Record<string, { title: string; severity: Severity } | undefined>)[kind];

/**
 * Something is wrong: open an incident of this kind and key, or update the open one (its detail, fix and what was
 * tried; never a second incident). Returns the incident and whether it is new (or reopened).
 */
export function raiseIncident(kind: string, key: string, detail: string, fix: string, o: RaiseOptions = {}): { incident: Incident; opened: boolean } {
  const now = (o.now ?? new Date()).toISOString();
  const nowMs = Date.parse(now);
  return withIncidents(o.dir, (f) => {
    const fields = { detail: clip(detail, 600), fix: clip(fix, 300), tried: (o.tried ?? []).map((t) => clip(t, 200)).slice(0, 5) };
    const open = f.incidents.find((x) => x.kind === kind && x.key === key && !x.resolvedAt);
    if (open) {
      Object.assign(open, fields, { lastSeen: now }, o.severity ? { severity: o.severity } : {});
      return { incident: open, opened: false };
    }
    const recent = f.incidents.find((x) => x.kind === kind && x.key === key && x.resolvedAt && nowMs - Date.parse(x.resolvedAt) < REOPEN_MS);
    if (recent) {
      // Its resolution was posted: post it again as broken. Not posted yet: as if it had never resolved.
      if (recent.posted.resolved) recent.posted = {};
      else delete recent.posted.skipped;
      Object.assign(recent, fields, { lastSeen: now, resolvedAt: null }, o.severity ? { severity: o.severity } : {});
      return { incident: recent, opened: true };
    }
    const m = meta(kind);
    const incident: Incident = { id: randomBytes(5).toString('hex'), kind, key: clip(key, 200), instance: o.instance ?? null, severity: o.severity ?? m?.severity ?? 'amber', title: m?.title ?? kind.replace(/_/g, ' '), ...fields, since: now, lastSeen: now, resolvedAt: null, posted: {} };
    f.incidents.push(incident);
    return { incident, opened: true };
  });
}

/** It is fine now: close the open incident of this kind and key. Returns it, or null when none was open. */
export function resolveIncident(kind: string, key: string, o: Pick<RaiseOptions, 'dir' | 'now'> = {}): Incident | null {
  const now = (o.now ?? new Date()).toISOString();
  return withIncidents(o.dir, (f) => {
    const open = f.incidents.find((x) => x.kind === kind && x.key === key && !x.resolvedAt);
    if (!open) return null;
    open.resolvedAt = now;
    return open;
  });
}

/** The open incidents, oldest first. */
export const openIncidents = (f: IncidentFile) => f.incidents.filter((x) => !x.resolvedAt).sort((a, b) => a.since.localeCompare(b.since));

/** Green: nothing open; amber: something will need a person; red: something is down or unsafe. */
export type HealthStatus = 'green' | 'amber' | 'red';

/** An instance's status from the open incidents about it and about the machine. */
export function healthStatus(incidents: Incident[], instance: string | null): HealthStatus {
  const mine = incidents.filter((x) => !x.resolvedAt && (x.instance === null || x.instance === instance));
  return mine.some((x) => x.severity === 'red') ? 'red' : mine.length ? 'amber' : 'green';
}
