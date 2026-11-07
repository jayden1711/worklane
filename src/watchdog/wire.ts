// The watchdog for one instance's coordinator, as the service runs it: its event log and state files, the agent
// user's Claude sign-in, its GitHub token, the machine's units, update log and disks, and its ops channel (its
// intake.yaml's discord.ops_channel, else the machine's watchdog.json) with its own Discord bot token.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStopFile, stopFilePath } from '../auto-merge-stop.js';
import type { StoredEvent } from '../events/types.js';
import { instancesDir } from '../instance.js';
import type { IntakeConfig } from '../intake/report.js';
import { diskFree, slotsDir } from '../os/index.js';
import { statSlotFile, type SlotPathLike } from '../slot-file.js';
import { unitStates } from '../os/stats.js';
import { claudeAuthStatusJson, type RunAs } from '../runner.js';
import { emergencyStop } from '../slots.js';
import { updateLog } from '../updates.js';
import { machineChanges } from '../machine.js';
import type { IncidentSink } from '../usage-limit.js';
import { githubOkAt } from '../github/seen.js';
import { watchdogConfig } from './config.js';
import { raiseIncident, resolveIncident } from './incidents.js';
import { discordPoster } from './post.js';
import { startWatchdog, type WatchdogDeps } from './watchdog.js';

/** What a disk finding calls the slot directory. */
export const SLOT_DIR_LABEL = 'the machine slot directory';

/** The machine's disks to watch: the slot directory's and the instances', once per volume. */
export function machineDisks(paths: SlotPathLike[] = [slotsDir(), instancesDir()]): { path: string; usedPct: number; freeGb: number }[] {
  const seen = new Set<number>();
  const out: { path: string; usedPct: number; freeGb: number }[] = [];
  for (const p of paths) {
    try {
      const dev = statSlotFile(p).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const d = diskFree(p);
      // The slot dir is a slot path (#772), named here by what it is: its path never leaves src/slot-file.ts.
      out.push({ path: typeof p === 'string' ? p : SLOT_DIR_LABEL, usedPct: 100 - d.freePct, freeGb: d.freeGb });
    } catch {
      // not there, or unreadable: not measured
    }
  }
  return out;
}

/** The instances on this machine, by their homes' names. */
export function machineInstances(dir = instancesDir()): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-z][a-z0-9-]{0,40}$/.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The auto-merge stop file in an instance's state dir, when there is one. */
export function readStop(stateDir: string): { reason: string; by: string | null } | null {
  const stop = readStopFile(stopFilePath(stateDir));
  return stop ? { reason: stop.reason, by: stop.by } : null;
}

export function watchdogForInstance(o: {
  instance: string;
  stateDir: string;
  log: { read(after?: number): StoredEvent[] };
  env: NodeJS.ProcessEnv;
  /** The agent user, on the login its runs use now (a function: an account profile switch changes it). */
  runAs?: RunAs | (() => RunAs);
  tokens?: () => Promise<string>;
  intake?: () => IntakeConfig | null;
  discordTokenFile?: string;
  say?: (line: string) => void;
}): { stop: () => void } {
  const deps: WatchdogDeps = {
    instance: o.instance,
    events: () => o.log.read(),
    stop: () => readStop(o.stateDir),
    emergency: () => !!emergencyStop(),
    auth: () => {
      const s = claudeAuthStatusJson(o.env, typeof o.runAs === 'function' ? o.runAs() : o.runAs);
      return s ? { loggedIn: s.loggedIn, ...(typeof s.expiresAt === 'string' ? { expiresAt: s.expiresAt } : {}) } : null;
    },
    // The same token source the coordinator's GitHub clients use: a call of theirs that succeeds is seen here.
    ...(o.tokens ? { githubToken: o.tokens, githubOkAt: () => githubOkAt(o.tokens!) } : {}),
    instances: () => machineInstances(),
    units: (u) => unitStates(u),
    updates: () => updateLog(),
    machineChanges: () => machineChanges(),
    disks: () => machineDisks(),
    config: () => watchdogConfig(),
    poster: () => {
      const cfg = watchdogConfig();
      const d = o.intake?.()?.discord;
      const channel = d?.ops_channel ?? cfg.opsChannel;
      if (!channel || !d?.enabled || !o.discordTokenFile) return null;
      let token: string;
      try {
        token = readFileSync(o.discordTokenFile, 'utf8').trim();
      } catch {
        return null;
      }
      if (!token) return null;
      return { poster: discordPoster({ token: () => token, channel }), dashboardUrl: d.dashboard_url ?? cfg.dashboardUrl, secrets: [token] };
    },
    ...(o.say ? { log: o.say } : {}),
  };
  return startWatchdog(deps);
}

/**
 * The incident sink a coordinator reports into (the usage-limit pause, src/usage-limit.ts): each incident is this
 * instance's, in the machine's store the watchdog posts from and the Health page lists. Never throws: a store that
 * can't be written leaves the pause to its own events and banner.
 */
export function incidentSink(instance: string, dir?: SlotPathLike): IncidentSink {
  const o = { instance, ...(dir ? { dir } : {}) };
  return {
    raiseIncident: (kind, key, detail, fix) => {
      try {
        raiseIncident(kind, key, detail, fix, o);
      } catch {
        // the pause still shows on the dashboard and in its events
      }
    },
    resolveIncident: (kind, key) => {
      try {
        resolveIncident(kind, key, dir ? { dir } : {});
      } catch {
        // as above
      }
    },
  };
}
