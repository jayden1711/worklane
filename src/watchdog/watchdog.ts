// The watchdog: every instance's coordinator runs one, on its own timer. Each looks after its own instance (Claude
// sign-in, GitHub access, stalled work, the main watch's stop, the test sandbox). The machine's own checks (the
// services, engine updates, disks) and the posting each run in one coordinator only, elected by a lock in the slot
// directory held for as long as that coordinator lives (another takes over when it dies):
//   watchdog.lock       the machine checks; every coordinator competes
//   watchdog-post.lock  the posting; only coordinators that can post (an ops channel and a Discord token) compete
// so the machine has one poster, and every incident is posted once wherever it was raised.
import { join } from 'node:path';
import type { StoredEvent } from '../events/types.js';
import { tryLock, type Lock } from '../locks.js';
import type { UnitState } from '../os/stats.js';
import type { UpdateEntry } from '../updates.js';
import { incidentsDir } from './incidents.js';
import { postPending, type Poster } from './post.js';
import { diskFindings, INSTANCE_KINDS, instanceFindings, reconcile, unitFindings, updateFindings, watchedUnits, type InstanceFacts, type RestartHistory } from './probes.js';
import type { WatchdogConfig } from './config.js';

/** How often the watchdog looks: once a minute. The agent's Claude sign-in is asked at most every AUTH_EVERY_MS. */
export const WATCHDOG_EVERY_MS = 60_000;
export const AUTH_EVERY_MS = 30 * 60_000;

export interface WatchdogDeps {
  /** This coordinator's instance. */
  instance: string;
  /** The machine-wide directory (the slot directory); the incident store and the locks are there. */
  dir?: string;
  /** The instance's event log. */
  events: () => StoredEvent[];
  /** The auto-merge stop file, when there is one. */
  stop: () => { reason: string; by: string | null } | null;
  emergency: () => boolean;
  /** The agent user's Claude sign-in (claude auth status, never the token); null when it can't be asked. */
  auth?: () => { loggedIn: boolean; expiresAt?: string | null } | null;
  /** Mints (or reads) the instance's GitHub token: a throw is a GitHub access failure. */
  githubToken?: () => Promise<string>;
  /** The machine checks' inputs. */
  instances: () => string[];
  units: (units: string[]) => UnitState[] | null;
  updates: () => UpdateEntry[];
  disks: () => { path: string; usedPct: number; freeGb: number }[];
  config: () => WatchdogConfig;
  /** Where this coordinator would post (its ops channel and bot), read every pass; null when it can't. */
  poster: () => { poster: Poster; dashboardUrl: string | null; secrets: string[] } | null;
  now?: () => Date;
  log?: (line: string) => void;
}

export class Watchdog {
  private machineLock: Lock | null = null;
  private postLock: Lock | null = null;
  private history: RestartHistory = new Map();
  private auth: { at: number; value: ReturnType<NonNullable<WatchdogDeps['auth']>> } | null = null;
  /** When the probe first said signed out, of the probes in a row that say so; null while it says signed in. */
  private authFailingSince: number | null = null;
  private running = false;

  /** Stopped (its coordinator is shutting down): it never takes a role again, even from a pass already under way. */
  private stopped = false;

  constructor(private d: WatchdogDeps) {}

  private get dir() {
    return incidentsDir(this.d.dir);
  }

  /** Whether this coordinator holds the machine checks / the posting now (tests, and the log). */
  get elected() {
    return { machine: !!this.machineLock, post: !!this.postLock };
  }

  /** Take `which` if it's free (or its holder is dead); keep it once held. */
  private take(which: 'machine' | 'post'): boolean {
    // A coordinator that is shutting down takes no part in the election: a running one takes over.
    if (this.stopped) return false;
    const held = which === 'machine' ? this.machineLock : this.postLock;
    if (held) return true;
    const r = tryLock(join(this.dir, which === 'machine' ? 'watchdog.lock' : 'watchdog-post.lock'), `watchdog ${this.d.instance} ${process.pid}`);
    if (!('lock' in r)) return false;
    if (which === 'machine') this.machineLock = r.lock;
    else this.postLock = r.lock;
    this.d.log?.(`watchdog: this instance now ${which === 'machine' ? 'runs the machine checks' : 'posts incidents'} for the machine`);
    return true;
  }

  /** One pass: this instance's checks; the machine's, if elected; the posts, if elected to post. */
  async pass(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const now = (this.d.now ?? (() => new Date()))();
      const cfg = this.d.config();
      const opts = { dir: this.dir, now };
      await this.instancePass(now, cfg, opts);
      if (this.take('machine')) this.machinePass(now, cfg, opts);
      const p = this.d.poster();
      if (!p) {
        // It can't post any more (its ops channel or Discord went): let another that can take over.
        this.postLock?.release();
        this.postLock = null;
      } else if (this.take('post')) await postPending({ poster: p.poster, dashboardUrl: p.dashboardUrl, secrets: p.secrets, dir: this.dir, now: this.d.now ?? (() => new Date()) });
    } finally {
      this.running = false;
    }
  }

  private async instancePass(now: Date, cfg: WatchdogConfig, opts: { dir: string; now: Date }) {
    if (this.d.auth && (!this.auth || now.getTime() - this.auth.at >= AUTH_EVERY_MS)) {
      let value: ReturnType<NonNullable<WatchdogDeps['auth']>> = null;
      try {
        value = this.d.auth();
      } catch {
        value = null;
      }
      // Not asked successfully: keep what was known (a login doesn't expire because a check couldn't run).
      if (value || !this.auth) this.auth = { at: now.getTime(), value };
      if (value) this.authFailingSince = value.loggedIn ? null : (this.authFailingSince ?? now.getTime());
    }
    let githubTokenError: string | null = null;
    if (this.d.githubToken) {
      try {
        await this.d.githubToken();
      } catch (e) {
        githubTokenError = (e as Error).message.split('\n')[0]!.slice(0, 300);
      }
    }
    const facts: InstanceFacts = { instance: this.d.instance, events: this.d.events(), now: now.getTime(), stallHours: cfg.stallHours, stop: this.d.stop(), auth: this.auth?.value ?? null, ...(this.authFailingSince !== null ? { authFailingSince: this.authFailingSince } : {}), githubTokenError, emergency: this.d.emergency() };
    // A login's expiry is this probe's to resolve only when it knows one (another module may report it otherwise).
    const kinds = facts.auth?.expiresAt ? INSTANCE_KINDS : INSTANCE_KINDS.filter((k) => k !== 'claude_login_expiring');
    reconcile(instanceFindings(facts), { kinds, instance: this.d.instance }, opts);
  }

  private machinePass(now: Date, cfg: WatchdogConfig, opts: { dir: string; now: Date }) {
    const units = watchedUnits(this.d.instances());
    const states = this.d.units(units.map((u) => u.unit));
    // No unit states on this platform: nothing is known about them, so nothing is raised or resolved.
    if (states) {
      const { findings, seen } = unitFindings(states, units, this.history, now.getTime());
      reconcile(findings, { kinds: ['unit_down', 'crash_loop'], instance: 'any', keys: seen }, opts);
    }
    reconcile(updateFindings(this.d.updates()), { kinds: ['update_rollback'], instance: null }, opts);
    const disks = this.d.disks();
    reconcile(diskFindings(disks, cfg.diskPct), { kinds: ['disk_full'], instance: null, keys: new Set(disks.map((x) => x.path)) }, opts);
  }

  stop() {
    this.stopped = true;
    this.machineLock?.release();
    this.postLock?.release();
    this.machineLock = this.postLock = null;
  }
}

/** Run a watchdog on its own timer until stopped; a failed pass is logged and the next one tries again. */
export function startWatchdog(d: WatchdogDeps, everyMs = WATCHDOG_EVERY_MS): { watchdog: Watchdog; stop: () => void } {
  const w = new Watchdog(d);
  const run = () => void w.pass().catch((e: Error) => d.log?.(`watchdog: ${e.message.slice(0, 300)}`));
  const t = setInterval(run, everyMs);
  t.unref();
  setTimeout(run, 5_000).unref();
  return {
    watchdog: w,
    stop: () => {
      clearInterval(t);
      w.stop();
    },
  };
}
