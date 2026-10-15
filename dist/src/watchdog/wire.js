// The watchdog for one instance's coordinator, as the service runs it: its event log and state files, the agent
// user's Claude sign-in, its GitHub token, the machine's units, update log and disks, and its ops channel (its
// intake.yaml's discord.ops_channel, else the machine's watchdog.json) with its own Discord bot token.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { instancesDir } from '../instance.js';
import { diskFree, slotsDir } from '../os/index.js';
import { unitStates } from '../os/stats.js';
import { claudeAuthStatusJson } from '../runner.js';
import { emergencyStop } from '../slots.js';
import { updateLog } from '../updates.js';
import { machineChanges } from '../machine.js';
import { githubOkAt } from '../github/seen.js';
import { watchdogConfig } from './config.js';
import { raiseIncident, resolveIncident } from './incidents.js';
import { discordPoster } from './post.js';
import { startWatchdog } from './watchdog.js';
/** The machine's disks to watch: the slot directory's and the instances', once per volume. */
export function machineDisks(paths = [slotsDir(), instancesDir()]) {
    const seen = new Set();
    const out = [];
    for (const p of paths) {
        try {
            const dev = statSync(p).dev;
            if (seen.has(dev))
                continue;
            seen.add(dev);
            const d = diskFree(p);
            out.push({ path: p, usedPct: 100 - d.freePct, freeGb: d.freeGb });
        }
        catch {
            // not there, or unreadable: not measured
        }
    }
    return out;
}
/** The instances on this machine, by their homes' names. */
export function machineInstances(dir = instancesDir()) {
    try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-z][a-z0-9-]{0,40}$/.test(e.name)).map((e) => e.name);
    }
    catch {
        return [];
    }
}
/** The auto-merge stop file in an instance's state dir, when there is one. */
export function readStop(stateDir) {
    const file = join(stateDir, 'auto-merge-stopped.json');
    if (!existsSync(file))
        return null;
    try {
        const j = JSON.parse(readFileSync(file, 'utf8'));
        return { reason: String(j.reason ?? 'stopped'), by: typeof j.by === 'string' ? j.by : null };
    }
    catch {
        return { reason: 'the stop file is unreadable', by: null };
    }
}
export function watchdogForInstance(o) {
    const deps = {
        instance: o.instance,
        events: () => o.log.read(),
        stop: () => readStop(o.stateDir),
        emergency: () => !!emergencyStop(),
        auth: () => {
            const s = claudeAuthStatusJson(o.env, o.runAs);
            return s ? { loggedIn: s.loggedIn, ...(typeof s.expiresAt === 'string' ? { expiresAt: s.expiresAt } : {}) } : null;
        },
        // The same token source the coordinator's GitHub clients use: a call of theirs that succeeds is seen here.
        ...(o.tokens ? { githubToken: o.tokens, githubOkAt: () => githubOkAt(o.tokens) } : {}),
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
            if (!channel || !d?.enabled || !o.discordTokenFile)
                return null;
            let token;
            try {
                token = readFileSync(o.discordTokenFile, 'utf8').trim();
            }
            catch {
                return null;
            }
            if (!token)
                return null;
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
export function incidentSink(instance, dir) {
    const o = { instance, ...(dir ? { dir } : {}) };
    return {
        raiseIncident: (kind, key, detail, fix) => {
            try {
                raiseIncident(kind, key, detail, fix, o);
            }
            catch {
                // the pause still shows on the dashboard and in its events
            }
        },
        resolveIncident: (kind, key) => {
            try {
                resolveIncident(kind, key, dir ? { dir } : {});
            }
            catch {
                // as above
            }
        },
    };
}
//# sourceMappingURL=wire.js.map