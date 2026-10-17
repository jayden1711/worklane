// Engine updates, as the machine's updater records them (scripts/machine/<cli>-update.cjs, run
// by a root timer): whether they're on, and each attempt, install, refusal and rollback. Read-only
// here; turning them on or off goes through the machine helper (src/machine.ts setUpdates).
import { readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { asRoot, etcPath, optPath, varLibPath } from './os/system-paths.js';
export const UPDATES_CONFIG = etcPath('updates.json');
export const UPDATES_LOG = varLibPath('updates.jsonl');
/** The updater's last pass that found nothing newer (event "current"), or its last refusal or wait. */
export const UPDATES_STATE = varLibPath('update-state.json');
/** The engine the machine's services run: a link to /opt/<cli>/<sha>. */
export const ENGINE_CURRENT = optPath('current');
/** held: a commit that was rolled back, skipped until a newer one or until an admin releases it at a root shell (updates.sh --release-hold). */
/** The root command that releases a hold; nothing a coordinator or the dashboard can do releases one. */
export const RELEASE_HOLD = `sudo bash ${asRoot.opt('current/scripts/setup/updates.sh')} --release-hold`;
/** The held rollback, if the newest install or held rollback in the log is one. */
export function heldUpdate(log) {
    const last = [...log].reverse().find((e) => e.event === 'installed' || (e.event === 'rolled_back' && e.held));
    if (!last || last.event !== 'rolled_back')
        return null;
    const reason = last.reason ?? (last.failed?.length ? `rolled back: ${last.failed.join('; ')}` : 'rolled back');
    return { at: last.at, sha: last.from ?? null, reason, migration: !!last.migration || /migration failed/.test(reason) };
}
const EVENTS = new Set(['attempt', 'chose', 'installed', 'rolled_back', 'held', 'refused', 'waiting', 'build_failed', 'error', 'signers_changed', 'canary_filed', 'canary_passed', 'canary_failed']);
/** The channel an updates.json selects: "release" only when it says so; absent (an existing install) is main. */
export function updateChannel(j) {
    return j.channel === 'release' ? 'release' : 'main';
}
/** The updater's settings, or null when it isn't set up on this machine. */
export function updateSettings(path = UPDATES_CONFIG) {
    try {
        const j = JSON.parse(readFileSync(path, 'utf8'));
        return {
            enabled: j.enabled === true,
            channel: updateChannel(j),
            repo_url: typeof j.repo_url === 'string' ? j.repo_url : '',
            branch: typeof j.branch === 'string' ? j.branch : 'main',
            required_checks: Array.isArray(j.required_checks) ? j.required_checks.filter((c) => typeof c === 'string') : [],
            canary: canarySettings(j.canary),
        };
    }
    catch {
        return null;
    }
}
/** The update log, newest last; torn or unknown lines are skipped. */
export function updateLog(path = UPDATES_LOG, limit = 200) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const j = JSON.parse(line);
            if (typeof j.at === 'string' && EVENTS.has(j.event))
                out.push(j);
        }
        catch {
            // torn line
        }
    }
    return out.slice(-limit);
}
export const CANARY_TIME_LIMIT_MINUTES = 120;
function canarySettings(c) {
    const o = (c ?? {});
    if (typeof o.instance !== 'string' || typeof o.repo !== 'string' || !o.instance || !o.repo)
        return null;
    const min = Number(o.time_limit_minutes);
    return { instance: o.instance, repo: o.repo, timeLimitMinutes: Number.isFinite(min) && min > 0 ? min : CANARY_TIME_LIMIT_MINUTES };
}
/** The engine the services run: its commit (the link's target) and version (its package.json); null where there's none. */
export function installedEngine(current = ENGINE_CURRENT) {
    let sha = null;
    try {
        const target = basename(readlinkSync(current));
        sha = /^[0-9a-f]{40}$/.test(target) ? target : null;
    }
    catch {
        // not a link: no updater-installed engine here
    }
    let version = null;
    try {
        const v = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')).version;
        version = typeof v === 'string' ? v : null;
    }
    catch {
        // no package.json
    }
    return { sha, version };
}
/** The state file's "current" entry, as the updater writes it on a pass with nothing newer; null for anything else. */
export function lastCheck(path = UPDATES_STATE) {
    let j;
    try {
        j = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
    const o = j;
    if (!o || o.event !== 'current' || typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at)))
        return null;
    if (o.channel !== 'release' && o.channel !== 'main')
        return null;
    const str = (v) => (typeof v === 'string' && v.length <= 200 ? v : null);
    return { at: o.at, channel: o.channel, sha: str(o.sha), version: str(o.version), newest: str(o.newest) };
}
export function updatesPanel(log, settings, installed, drain = null, checked = null) {
    const lastOf = (f) => [...log].reverse().find(f) ?? null;
    const install = lastOf((e) => e.event === 'installed');
    const rolled = lastOf((e) => e.event === 'rolled_back');
    const rollbackNow = rolled && (!install || rolled.at >= install.at) ? rolled : null;
    const held = heldUpdate(log);
    const result = lastOf((e) => e.event === 'canary_passed' || e.event === 'canary_failed');
    const filed = lastOf((e) => e.event === 'canary_filed');
    const running = filed && (!result || filed.at > result.at) ? filed : null;
    return {
        configured: !!settings,
        enabled: settings ? settings.enabled : null,
        installed,
        lastInstall: install ? { at: install.at, from: install.from ?? null, to: install.to ?? null } : null,
        // Only while it is still about the engine installed now: an install since makes it stale.
        lastCheck: checked && (!install || checked.at >= install.at) && (!checked.sha || !installed.sha || checked.sha === installed.sha) ? checked : null,
        rollback: rollbackNow
            ? { at: rollbackNow.at, sha: rollbackNow.from ?? null, reason: rollbackNow.reason ?? (rollbackNow.failed?.length ? `rolled back: ${rollbackNow.failed.join('; ')}` : 'rolled back'), held: !!held && held.at === rollbackNow.at, canary: !!rollbackNow.canary }
            : null,
        drain,
        canary: {
            settings: settings?.canary ?? null,
            running: running ? { at: running.at, trigger: running.trigger === 'update' ? 'update' : 'daily', issue: running.issue ?? null, url: running.url ?? null, deadline: running.deadline ?? null } : null,
            last: result
                ? {
                    at: result.at,
                    passed: result.event === 'canary_passed',
                    trigger: result.trigger === 'update' ? 'update' : 'daily',
                    stage: result.stage ?? null,
                    why: result.reason ?? null,
                    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : null,
                    timedOut: result.timed_out === true,
                    issue: typeof result.issue === 'number' ? { number: result.issue, url: result.url ?? null } : null,
                    pr: result.pr ?? null,
                    sha: result.to ?? null,
                }
                : null,
        },
    };
}
//# sourceMappingURL=updates.js.map