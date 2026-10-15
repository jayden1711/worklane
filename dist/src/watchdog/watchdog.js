// The watchdog: every instance's coordinator runs one, on its own timer. Each looks after its own instance (Claude
// sign-in, GitHub access, stalled work, the main watch's stop, the test sandbox). The machine's own checks (the
// services, engine updates, disks) and the posting each run in one coordinator only, elected by a lock in the slot
// directory held for as long as that coordinator lives (another takes over when it dies):
//   watchdog.lock       the machine checks; every coordinator competes
//   watchdog-post.lock  the posting; only coordinators that can post (an ops channel and a Discord token) compete
// so the machine has one poster, and every incident is posted once wherever it was raised.
import { join } from 'node:path';
import { tryLock } from '../locks.js';
import { isNetworkFailure } from '../github/errors.js';
import { incidentsDir } from './incidents.js';
import { postPending } from './post.js';
import { diskFindings, INSTANCE_KINDS, instanceFindings, reconcile, signerFindings, stagedSignerFindings, unitFindings, updateFindings, watchedUnits } from './probes.js';
/** How often the watchdog looks: once a minute. The agent's Claude sign-in is asked at most every AUTH_EVERY_MS. */
export const WATCHDOG_EVERY_MS = 60_000;
export const AUTH_EVERY_MS = 30 * 60_000;
export class Watchdog {
    d;
    machineLock = null;
    postLock = null;
    history = new Map();
    auth = null;
    /** When the probe first said signed out, of the probes in a row that say so; null while it says signed in. */
    authFailingSince = null;
    running = false;
    /** Why GitHub last refused the instance's token; kept while GitHub can't be reached, since no answer says it's fixed. */
    tokenRefused = null;
    /** The passes in a row whose token request never reached GitHub; null once one does. */
    unreachable = null;
    /** Stopped (its coordinator is shutting down): it never takes a role again, even from a pass already under way. */
    stopped = false;
    constructor(d) {
        this.d = d;
    }
    get dir() {
        return incidentsDir(this.d.dir);
    }
    /** Whether this coordinator holds the machine checks / the posting now (tests, and the log). */
    get elected() {
        return { machine: !!this.machineLock, post: !!this.postLock };
    }
    /** Take `which` if it's free (or its holder is dead); keep it once held. */
    take(which) {
        // A coordinator that is shutting down takes no part in the election: a running one takes over.
        if (this.stopped)
            return false;
        const held = which === 'machine' ? this.machineLock : this.postLock;
        if (held)
            return true;
        const r = tryLock(join(this.dir, which === 'machine' ? 'watchdog.lock' : 'watchdog-post.lock'), `watchdog ${this.d.instance} ${process.pid}`);
        if (!('lock' in r))
            return false;
        if (which === 'machine')
            this.machineLock = r.lock;
        else
            this.postLock = r.lock;
        this.d.log?.(`watchdog: this instance now ${which === 'machine' ? 'runs the machine checks' : 'posts incidents'} for the machine`);
        return true;
    }
    /** One pass: this instance's checks; the machine's, if elected; the posts, if elected to post. */
    async pass() {
        if (this.running || this.stopped)
            return;
        this.running = true;
        try {
            const now = (this.d.now ?? (() => new Date()))();
            const cfg = this.d.config();
            const opts = { dir: this.dir, now };
            await this.instancePass(now, cfg, opts);
            if (this.take('machine'))
                this.machinePass(now, cfg, opts);
            const p = this.d.poster();
            if (!p) {
                // It can't post any more (its ops channel or Discord went): let another that can take over.
                this.postLock?.release();
                this.postLock = null;
            }
            else if (this.take('post'))
                await postPending({ poster: p.poster, dashboardUrl: p.dashboardUrl, secrets: p.secrets, dir: this.dir, now: this.d.now ?? (() => new Date()) });
        }
        finally {
            this.running = false;
        }
    }
    async instancePass(now, cfg, opts) {
        if (this.d.auth && (!this.auth || now.getTime() - this.auth.at >= AUTH_EVERY_MS)) {
            let value = null;
            try {
                value = this.d.auth();
            }
            catch {
                value = null;
            }
            // Not asked successfully: keep what was known (a login doesn't expire because a check couldn't run).
            if (value || !this.auth)
                this.auth = { at: now.getTime(), value };
            if (value)
                this.authFailingSince = value.loggedIn ? null : (this.authFailingSince ?? now.getTime());
        }
        if (this.d.githubToken) {
            try {
                await this.d.githubToken();
                this.tokenRefused = null;
                this.unreachable = null;
            }
            catch (e) {
                const why = errorLine(e);
                if (isNetworkFailure(e)) {
                    // GitHub never answered: not an auth failure. A refusal seen before stands (nothing says it's fixed).
                    this.unreachable = { passes: (this.unreachable?.passes ?? 0) + 1, since: this.unreachable?.since ?? now.getTime(), detail: why };
                }
                else {
                    this.tokenRefused = why;
                    this.unreachable = null;
                }
            }
        }
        const okAt = this.d.githubOkAt?.() ?? null;
        const facts = { instance: this.d.instance, events: this.d.events(), now: now.getTime(), stallHours: cfg.stallHours, stop: this.d.stop(), auth: this.auth?.value ?? null, ...(this.authFailingSince !== null ? { authFailingSince: this.authFailingSince } : {}), githubTokenError: this.tokenRefused, githubUnreachable: this.unreachable, githubOkAt: okAt, emergency: this.d.emergency() };
        // A login's expiry is this probe's to resolve only when it knows one (another module may report it otherwise).
        const kinds = facts.auth?.expiresAt ? INSTANCE_KINDS : INSTANCE_KINDS.filter((k) => k !== 'claude_login_expiring');
        reconcile(instanceFindings(facts), { kinds, instance: this.d.instance }, opts);
    }
    machinePass(now, cfg, opts) {
        const units = watchedUnits(this.d.instances());
        const states = this.d.units(units.map((u) => u.unit));
        // No unit states on this platform: nothing is known about them, so nothing is raised or resolved.
        if (states) {
            const { findings, seen } = unitFindings(states, units, this.history, now.getTime());
            reconcile(findings, { kinds: ['unit_down', 'crash_loop'], instance: 'any', keys: seen }, opts);
        }
        reconcile(updateFindings(this.d.updates()), { kinds: ['update_rollback'], instance: null }, opts);
        // A release signer added (updates.sh --signer or --confirm-signer): an alert each, open for a day.
        if (this.d.machineChanges)
            reconcile(signerFindings(this.d.machineChanges(), now.getTime()), { kinds: ['update_signer_added'], instance: null }, opts);
        // A signer staged from a dashboard: an alert each too, open for a day.
        if (this.d.machineChanges)
            reconcile(stagedSignerFindings(this.d.machineChanges(), now.getTime()), { kinds: ['update_signer_staged'], instance: 'any' }, opts);
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
/** An error's first line, with the code of what it was caused by (fetch's "fetch failed" says why only there). */
function errorLine(e) {
    const first = String(e?.message ?? e).split('\n')[0];
    const code = e?.cause?.code;
    return (typeof code === 'string' && !first.includes(code) ? `${first} (${code})` : first).slice(0, 300);
}
/** Run a watchdog on its own timer until stopped; a failed pass is logged and the next one tries again. */
export function startWatchdog(d, everyMs = WATCHDOG_EVERY_MS) {
    const w = new Watchdog(d);
    const run = () => void w.pass().catch((e) => d.log?.(`watchdog: ${e.message.slice(0, 300)}`));
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
//# sourceMappingURL=watchdog.js.map