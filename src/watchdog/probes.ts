// The watchdog's triggers, each a pure function from what it read (unit states, the update log, disks, an
// instance's event log and files) to the findings that are true now. reconcile() turns findings into incidents:
// each finding raises its incident (once: raising an open one only updates it), and each open incident in the
// probe's scope that is no longer found is resolved (once). A probe that couldn't look (no systemd here, a disk it
// couldn't read) reports nothing for what it didn't see, so nothing is resolved on a guess.
import { BRAND } from '../brand.js';
import { helperFix } from '../testrun/helper.js';
import type { StoredEvent } from '../events/types.js';
import type { UnitState } from '../os/stats.js';
import type { UpdateEntry } from '../updates.js';
import { project } from '../projection.js';
import { openIncidents, raiseIncident, readIncidents, resolveIncident, type Incident, type Severity, type WatchdogKind } from './incidents.js';

export interface Finding {
  kind: WatchdogKind;
  key: string;
  instance: string | null;
  detail: string;
  fix: string;
  tried: string[];
  severity?: Severity;
}

/** Which open incidents a probe answers for: its kinds, for one instance (or the machine), or any; only these keys when given. */
export interface Scope {
  kinds: readonly WatchdogKind[];
  instance: string | null | 'any';
  /** The keys the probe could see this pass; an incident whose key it didn't see is left as it is. */
  keys?: ReadonlySet<string>;
}

/** Raise every finding and resolve every open incident in scope that wasn't found. */
export function reconcile(findings: Finding[], scope: Scope, o: { dir?: string; now?: Date } = {}): { raised: Incident[]; resolved: Incident[] } {
  const raised: Incident[] = [];
  const resolved: Incident[] = [];
  const opts = { ...(o.dir ? { dir: o.dir } : {}), ...(o.now ? { now: o.now } : {}) };
  for (const f of findings) {
    const r = raiseIncident(f.kind, f.key, f.detail, f.fix, { ...opts, instance: f.instance, tried: f.tried, ...(f.severity ? { severity: f.severity } : {}) });
    if (r.opened) raised.push(r.incident);
  }
  const found = new Set(findings.map((f) => `${f.kind}\n${f.key}`));
  for (const x of openIncidents(readIncidents(o.dir))) {
    if (!(scope.kinds as readonly string[]).includes(x.kind)) continue;
    if (scope.instance !== 'any' && x.instance !== scope.instance) continue;
    if (scope.keys && !scope.keys.has(x.key)) continue;
    if (found.has(`${x.kind}\n${x.key}`)) continue;
    const r = resolveIncident(x.kind, x.key, opts);
    if (r) resolved.push(r);
  }
  return { raised, resolved };
}

// ------------------------------------------------------------------ machine

/** The units the watchdog looks at: the hub, and each instance's coordinator and dashboard. */
export function watchedUnits(instances: string[]): { unit: string; instance: string | null; what: string }[] {
  return [
    { unit: `${BRAND.cli}-dashboard-hub.service`, instance: null, what: 'the dashboard hub' },
    ...instances.flatMap((name) => [
      { unit: `${BRAND.cli}-${name}.service`, instance: name, what: `instance ${name}'s coordinator` },
      { unit: `${BRAND.cli}-dashboard-${name}.service`, instance: name, what: `instance ${name}'s dashboard` },
    ]),
  ];
}

/** Restarts within this long that make a crash loop. */
export const CRASH_LOOP = { restarts: 3, windowMs: 15 * 60_000 } as const;

/** Restart counts seen per unit, oldest first: the watchdog keeps them between passes. */
export type RestartHistory = Map<string, { at: number; restarts: number }[]>;

/** Down (failed or stopped) and crash-looping units. Units not installed here (not-found) are not looked at. */
export function unitFindings(states: UnitState[], units: ReturnType<typeof watchedUnits>, history: RestartHistory, now: number): { findings: Finding[]; seen: Set<string> } {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const s of states) {
    const u = units.find((x) => x.unit === s.unit);
    if (!u || s.loadState === 'not-found' || !s.activeState) continue;
    seen.add(s.unit);
    const h = [...(history.get(s.unit) ?? []), ...(s.restarts === null ? [] : [{ at: now, restarts: s.restarts }])].filter((x) => now - x.at <= CRASH_LOOP.windowMs);
    history.set(s.unit, h);
    const grew = h.length ? h.at(-1)!.restarts - h[0]!.restarts : 0;
    const restarting = s.subState === 'auto-restart';
    const unitCmd = `systemctl status ${s.unit}; journalctl -u ${s.unit} -n 100`;
    if (grew >= CRASH_LOOP.restarts || (restarting && grew > 0)) {
      findings.push({ kind: 'crash_loop', key: s.unit, instance: u.instance, detail: `${u.what} (${s.unit}) keeps restarting: ${grew} restart${grew === 1 ? '' : 's'} in the last ${CRASH_LOOP.windowMs / 60_000} min (${s.activeState}/${s.subState ?? '?'})`, fix: `Read why it exits (${unitCmd}) and fix that; it restarts on its own once it stays up`, tried: [`systemd restarted it ${grew} time${grew === 1 ? '' : 's'}`] });
    } else if (s.activeState === 'failed' || s.activeState === 'inactive') {
      findings.push({ kind: 'unit_down', key: s.unit, instance: u.instance, detail: `${u.what} (${s.unit}) is ${s.activeState}${s.subState ? ` (${s.subState})` : ''}`, fix: `Read why it stopped (${unitCmd}), then start it: sudo systemctl start ${s.unit}`, tried: s.restarts ? [`systemd restarted it ${s.restarts} time${s.restarts === 1 ? '' : 's'} before giving up`] : [] });
    }
  }
  return { findings, seen };
}

/** A rolled-back engine update (held or not), until a later install. */
export function updateFindings(log: UpdateEntry[]): Finding[] {
  const last = [...log].reverse().find((e) => e.event === 'installed' || e.event === 'rolled_back');
  if (!last || last.event !== 'rolled_back') return [];
  const sha = (last.from ?? last.to ?? 'unknown').slice(0, 12);
  const why = last.reason ?? (last.migration ? `instance ${last.migration.instance}'s migration failed: ${last.migration.error}` : last.failed?.length ? `failed: ${last.failed.join('; ')}` : 'its checks after the install failed');
  const tried = [`rolled back to ${last.back ? last.back.slice(0, 12) : 'the previous engine'}`, ...(last.held ? [`held ${sha}: the updater skips it until a newer commit`] : [])];
  return [{ kind: 'update_rollback', key: sha, instance: null, detail: `the update to ${sha} was rolled back${last.held ? ' and is held' : ''}: ${why}`, fix: 'Read the rollback on the Machine page (the update log), fix it in a new commit; the hold lifts when a newer one installs', tried }];
}

/** The share of a disk in use at or above which the watchdog alerts. */
export const DISK_PCT = 85;

/** Disks at or over the limit. `disks`: each path measured, with how much of its volume is used. */
export function diskFindings(disks: { path: string; usedPct: number; freeGb: number }[], limit = DISK_PCT): Finding[] {
  return disks
    .filter((d) => d.usedPct >= limit)
    .map((d) => ({ kind: 'disk_full' as const, key: d.path, instance: null, detail: `the volume holding ${d.path} is ${Math.round(d.usedPct)}% full (${d.freeGb.toFixed(1)} GB free; the limit is ${limit}%)`, fix: `Free space on that volume (old worktrees, logs, caches), or grow it`, tried: [] }));
}

// ------------------------------------------------------------------ instance

/** Default hours ready work may sit with nothing moving before it's flagged (watchdog.json stall_hours). */
export const STALL_HOURS = 6;
/** Event types that mean the instance is getting on with its work. */
const PROGRESS = new Set(['issue.claimed', 'run.started', 'run.finished', 'pr.opened', 'pr.ready', 'merge.done', 'land.result', 'check.result', 'decision.asked', 'issue.blocked']);
/** GitHub error kinds (src/github/errors.ts) that mean the instance's token or its permissions are wrong. */
const GITHUB_AUTH_KINDS = new Set(['unauthenticated', 'insufficient_scope', 'insufficient_role', 'sso_required', 'forbidden']);
/** How far back a failure counts: one hour for sign-in and GitHub access. */
export const AUTH_WINDOW_MS = 3600_000;
/** A login that expires within this long is flagged. */
export const LOGIN_EXPIRY_MS = 3 * 86_400_000;

export interface InstanceFacts {
  instance: string;
  events: StoredEvent[];
  now: number;
  stallHours?: number;
  /** The auto-merge stop file (state/auto-merge-stopped.json), when there is one. */
  stop: { reason: string; by: string | null } | null;
  /** The agent user's Claude sign-in, as `claude auth status` reports it (never the token); null: not checked. */
  auth: { loggedIn: boolean; expiresAt?: string | null } | null;
  /** When the probe first said signed out, of the probes in a row that say so (ms); unset: not known. */
  authFailingSince?: number;
  /** Why the instance's GitHub token couldn't be had just now (an App token that wouldn't mint); null when it was. */
  githubTokenError: string | null;
  /** An emergency stop is in force: no work moves, on purpose. */
  emergency: boolean;
}

const at = (e: StoredEvent) => Date.parse(e.ts);

/** Every instance-level trigger: Claude sign-in and login expiry, GitHub access, stalled work, auto-merge stopped, the test sandbox. */
export function instanceFindings(f: InstanceFacts): Finding[] {
  const out: Finding[] = [];
  const i = f.instance;
  const recent = f.events.filter((e) => f.now - at(e) <= AUTH_WINDOW_MS);

  // Claude: a run stopped on a login mismatch since the last run that finished well, or the CLI says signed out.
  const lastAuthFail = [...recent].reverse().find((e) => e.type === 'run.finished' && (e.payload as { reason: string }).reason === 'auth_mismatch');
  const okAfter = lastAuthFail && f.events.some((e) => e.id > lastAuthFail.id && e.type === 'run.finished' && (e.payload as { reason: string }).reason === 'succeeded');
  const refreshes = recent.filter((e) => e.type === 'run.transient_retry' && (e.payload as { cause: string }).cause === 'token_refresh').length;
  // A probe that says signed out counts only while no run on the login has succeeded since it started saying so: a run
  // that finished well had a working login, so the probe was wrong (or the login came back), and no one is needed.
  const since = f.authFailingSince;
  const probeOut = f.auth?.loggedIn === false && !(since !== undefined && f.events.some((e) => at(e) >= since && e.type === 'run.finished' && (e.payload as { reason: string }).reason === 'succeeded'));
  if ((lastAuthFail && !okAfter) || probeOut) {
    const why = probeOut ? "the agent user's claude auth status says it is signed out" : `a run stopped on its Claude login: ${String((lastAuthFail!.payload as { detail: string }).detail).slice(0, 200)}`;
    out.push({ kind: 'claude_auth', key: i, instance: i, detail: why, fix: "Sign the instance's agent user in to Claude again (a new setup-token for that user), then check it with claude auth status as that user", tried: refreshes ? [`retried ${refreshes} run${refreshes === 1 ? '' : 's'} after a token refresh in the last hour`] : [] });
  }
  const exp = f.auth?.expiresAt ? Date.parse(f.auth.expiresAt) : NaN;
  if (f.auth?.loggedIn && Number.isFinite(exp) && exp - f.now <= LOGIN_EXPIRY_MS) {
    const days = Math.max(0, Math.floor((exp - f.now) / 86_400_000));
    out.push({ kind: 'claude_login_expiring', key: i, instance: i, detail: exp <= f.now ? `the agent user's Claude login expired on ${f.auth.expiresAt!.slice(0, 10)}` : `the agent user's Claude login expires in ${days} day${days === 1 ? '' : 's'}, on ${f.auth.expiresAt!.slice(0, 10)}`, fix: "Renew the agent user's Claude login (a new setup-token for that user) before then", tried: [] });
  }

  // GitHub: the token wouldn't mint, or a call failed on the token or its permissions in the last hour.
  const ghFail = [...recent].reverse().find((e) => e.type === 'coordinator.error' && GITHUB_AUTH_KINDS.has((e.payload as { kind: string }).kind));
  if (f.githubTokenError || ghFail) {
    const p = ghFail?.payload as { where: string; kind: string; message: string } | undefined;
    out.push({ kind: 'github_auth', key: i, instance: i, detail: f.githubTokenError ? `the instance's GitHub token couldn't be had: ${f.githubTokenError}` : `${p!.where}: GitHub refused the instance's token (${p!.kind}): ${p!.message}`, fix: "Check the instance's GitHub App: installed on the repo, with the permissions the setup lists, and its private key in place (or replace an expired token)", tried: ['retries every tick; nothing that needs GitHub can move until it works'] });
  }
  const perm = [...f.events].reverse().find((e) => e.type === 'testrun.checks_permission');
  const level = (perm?.payload as { level?: string } | undefined)?.level;
  if (perm && (level === 'none' || level === 'read')) {
    out.push({ kind: 'github_auth', key: `${i}:checks`, instance: i, detail: `the GitHub App can't post check runs (checks: ${level})`, fix: "Give the instance's GitHub App the Checks: write permission, and accept it on the installation", tried: ['test runs go on; their results are not posted as checks'] });
  }

  // Ready work and nothing moving for stall_hours (not while an emergency stop holds everything on purpose).
  const hours = f.stallHours ?? STALL_HOURS;
  if (!f.emergency) {
    const ready = project(f.events).tasks.filter((t) => t.status === 'ready');
    const last = [...f.events].reverse().find((e) => PROGRESS.has(e.type));
    const since = last ? at(last) : f.events.length ? at(f.events[0]!) : f.now;
    if (ready.length && f.now - since >= hours * 3600_000) {
      const idle = Math.floor((f.now - since) / 3600_000);
      out.push({ kind: 'stalled', key: i, instance: i, detail: `${ready.length} ready issue${ready.length === 1 ? '' : 's'} (${ready.slice(0, 5).map((t) => `#${t.issue}`).join(', ')}) and nothing has moved for ${idle} h`, fix: "Look at the instance's Board and Logs for what holds it (a full slot cap, the budget, a paused run window, a coordinator error)", tried: [] });
    }
  }

  // The main watch stopped auto-merge on an unaccounted commit.
  if (f.stop && f.stop.by === 'main_watch') {
    const u = [...f.events].reverse().find((e) => e.type === 'main_watch.unaccounted')?.payload as { sha: string; revert: string | null } | undefined;
    out.push({ kind: 'auto_merge_stopped', key: i, instance: i, detail: `auto-merge is stopped: ${f.stop.reason}`, fix: 'Look at the commit; when it is accounted for (or reverted), an admin clears the stop on the dashboard', tried: ['stopped auto-merge', ...(u?.revert ? [`opened a revert PR: ${u.revert}`] : [])] });
  }

  // The test sandbox's own check (the helper's check): no test run starts until it passes.
  const sandbox = [...f.events].reverse().find((e) => e.type === 'testrun.sandbox')?.payload as { ok: boolean; detail: string } | undefined;
  if (sandbox && !sandbox.ok) {
    out.push({ kind: 'test_sandbox', key: i, instance: i, detail: `the test sandbox check failed: ${sandbox.detail}`, fix: `Run the machine's check (sudo bash scripts/setup/test-user.sh check ${i}) and fix its FAIL lines; no restart needed`, tried: ['no test run starts until it passes; each open PR has a check that says so', 'checked again by itself, every 5 minutes at most; test runs go on when it passes'] });
  }

  // The sandbox helper's protocol isn't this engine's (an engine update that didn't reinstall the root helper).
  const helper = [...f.events].reverse().find((e) => e.type === 'testrun.helper')?.payload as { ok: boolean; have: number | null; need: number; detail: string } | undefined;
  if (helper && !helper.ok) {
    out.push({ kind: 'helper_outdated', key: i, instance: i, detail: helper.detail, fix: helperFix(i), tried: ['no test run starts; each PR gets a check that says so', 'asked again when the instance starts'] });
  }
  return out;
}

/** The instance-level kinds: an instance's own probe answers for these, for itself only. */
export const INSTANCE_KINDS = ['claude_auth', 'claude_login_expiring', 'github_auth', 'stalled', 'auto_merge_stopped', 'test_sandbox', 'helper_outdated'] as const satisfies readonly WatchdogKind[];
