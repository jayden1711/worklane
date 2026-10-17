// The coordinator on a full disk: it never dies of it, and it starts no new work until there is room again.
//   - A write to the event log the storage refuses (SQLITE_FULL, an I/O error, ENOSPC) is kept in memory, in order
//     (EventLog's buffer), and the instance raises a red disk_full incident. No new test run, agent run or batch
//     starts; runs in flight go on, and a finished run's check is still posted (it needs no disk).
//   - step() (on its own timer) writes the kept events again, with backoff. Work resumes once they are written and
//     every watched filesystem is above the floor; then the incident is resolved.
//   - The floor: before any test run or agent run starts, each watched filesystem (the instance's state, the test
//     runs' base) must have the larger of min_free_gb GiB and min_free_pct % of its size free (watchdog.json; 10 GiB
//     and 5% by default). Below it nothing starts, and the same incident is raised amber.
// The incident store may be on the full disk too: a raise or resolve it refuses is said in the journal and kept here,
// and written on a later step, once there is room.
import { BRAND } from './brand.js';
import { diskFree } from './os/index.js';
import { raiseIncident, resolveIncident } from './watchdog/incidents.js';
import { testRunBasePath } from './os/system-paths.js';
/** Where the sandbox keeps test runs' workspaces and stores (scripts/setup/test-user.sh). */
export const TEST_RUN_BASE = testRunBasePath();
/** The default floor: the larger of this many GiB and this share of the filesystem, free. */
export const FLOOR_GB = 10;
export const FLOOR_PCT = 5;
export const DISK_INCIDENT = 'disk_full';
/** The first retry of the kept events, and the longest wait between retries. */
export const RETRY_MIN_MS = 5_000;
export const RETRY_MAX_MS = 60_000;
const GIB = 2 ** 30;
/** An open incident's detail (free space, events kept) is written again at most this often. */
const REFRESH_MS = 5 * 60_000;
/** The bytes a filesystem of `totalBytes` must keep free. */
export const floorBytes = (f, totalBytes) => Math.max(f.gb * GIB, (f.pct / 100) * totalBytes);
const gb = (b) => `${(b / GIB).toFixed(1)} GiB`;
function measure(path) {
    try {
        const d = diskFree(path);
        return { freeBytes: d.freeGb * 1e9, totalBytes: d.totalGb * 1e9 };
    }
    catch {
        return null;
    }
}
export class DiskGuard {
    d;
    nextRetryAt = 0;
    wait = RETRY_MIN_MS;
    /** The incident's severity as the store has it from here (null: none open; undefined: not known yet, at start). */
    stored = undefined;
    storedAt = 0;
    reportedDropped = 0;
    saidFull = false;
    off;
    constructor(d) {
        this.d = d;
        this.off = d.log.onWriteFailure((f) => this.writeFailed(f));
    }
    get now() {
        return (this.d.now ?? Date.now)();
    }
    say(line) {
        (this.d.say ?? ((l) => console.error(l)))(line);
    }
    /** The watched filesystems below the floor now. */
    low() {
        const floor = this.d.floor();
        const out = [];
        for (const path of this.d.paths) {
            const m = (this.d.free ?? measure)(path);
            if (!m)
                continue;
            const f = floorBytes(floor, m.totalBytes);
            if (m.freeBytes < f)
                out.push({ path, ...m, floor: f });
        }
        return out;
    }
    /**
     * Why no new work may start now (a test run, an agent run, a batch), or null. INVARIANT: null only while no event
     * waits to be written and every watched filesystem is above the floor.
     */
    held() {
        const b = this.d.log.buffered();
        if (b.count)
            return `the disk is full: the event log can't be written (${b.failure?.reason ?? 'the storage refused it'}); ${b.count} events wait in memory`;
        const low = this.low();
        if (low.length) {
            // WHY: a start refused for the floor raises the incident at once, not at the next step.
            this.sync(low);
            return `free disk is below the floor: ${low.map((l) => `${l.path} has ${gb(l.freeBytes)} free, the floor is ${gb(l.floor)}`).join('; ')}`;
        }
        return null;
    }
    writeFailed(f) {
        // WHY: one line when the log first fails, not one per retry while it waits.
        if (!this.saidFull)
            this.say(`${BRAND.cli} coordinator ${this.d.instance}: the event log can't be written (${f.reason}): events are kept in memory, in order, and written again when there is room; no new test run, agent run or batch starts until then`);
        this.saidFull = true;
        this.sync();
    }
    /** One pass: write the kept events again (with backoff), and bring the incident in line. Never throws on a full disk. */
    step() {
        const b = this.d.log.buffered();
        if (b.count && this.now >= this.nextRetryAt) {
            const r = this.d.log.flush();
            if (r.error) {
                this.wait = Math.min(this.wait * 2, RETRY_MAX_MS);
                this.nextRetryAt = this.now + this.wait;
            }
            else {
                this.wait = RETRY_MIN_MS;
                this.nextRetryAt = 0;
                this.saidFull = false;
                this.say(`${BRAND.cli} coordinator ${this.d.instance}: the event log is written again: ${r.written} kept events written, in order`);
            }
        }
        const dropped = this.d.log.buffered().dropped;
        if (dropped > this.reportedDropped && !this.d.log.buffered().count) {
            this.reportedDropped = dropped;
            this.d.log.append('coordinator.error', { instance: this.d.instance, where: 'event log', kind: 'disk_full', message: `${dropped} events were lost: the disk stayed full past the in-memory buffer's limit` }, this.d.instance);
        }
        this.sync();
    }
    /** Raise, update or resolve the incident as things are now; one the store refuses waits for a later step. */
    sync(low = this.low()) {
        if (!this.d.incidents)
            return;
        const b = this.d.log.buffered();
        const want = b.count ? 'red' : low.length ? 'amber' : null;
        const paused = 'new test runs, agent runs and batches';
        const flight = this.d.inFlight?.();
        const where = this.d.paths.map((p) => {
            const m = (this.d.free ?? measure)(p);
            return m ? `${p}: ${gb(m.freeBytes)} free of ${gb(m.totalBytes)}` : null;
        }).filter(Boolean).join('; ');
        const detail = want === 'red'
            ? `the event log (${this.d.log.path}) can't be written: ${b.failure?.reason ?? 'the storage refused it'}. ${b.count} events wait in memory (lost if the coordinator restarts${b.dropped ? `; ${b.dropped} lost already` : ''}). Paused: ${paused}${flight !== undefined ? `; ${flight} in flight go on` : ''}. ${where}`
            : `free disk is below the floor (${low.map((l) => `${l.path}: ${gb(l.freeBytes)} free, floor ${gb(l.floor)}`).join('; ')}). Paused: ${paused}${flight !== undefined ? `; ${flight} in flight go on` : ''}`;
        // WHY: the store is written when the state changes, and an open incident's numbers refreshed every REFRESH_MS, not on every start refused.
        if (want === this.stored && (want === null || this.now - this.storedAt < REFRESH_MS))
            return;
        try {
            if (want) {
                const floor = this.d.floor();
                raiseIncident(DISK_INCIDENT, this.d.instance, detail, `Free space on that filesystem (old worktrees, logs, caches, docker images), or grow it. Work resumes by itself once the kept events are written and each filesystem has the larger of ${floor.gb} GiB and ${floor.pct}% free (watchdog.json min_free_gb, min_free_pct)`, { instance: this.d.instance, severity: want, ...(this.d.incidents.dir ? { dir: this.d.incidents.dir } : {}) });
            }
            else {
                // WHY: at start too: an incident a coordinator that died left open is resolved once things are fine.
                const was = resolveIncident(DISK_INCIDENT, this.d.instance, this.d.incidents.dir ? { dir: this.d.incidents.dir } : {});
                if (was)
                    this.say(`${BRAND.cli} coordinator ${this.d.instance}: disk space is back above the floor and the event log is written: new work starts again`);
            }
            this.stored = want;
            this.storedAt = this.now;
        }
        catch (e) {
            // INVARIANT: the incident stays wanted (this.stored unchanged), so a later step writes it once there is room.
            this.say(`${BRAND.cli} coordinator ${this.d.instance}: the ${DISK_INCIDENT} incident (${want ?? 'resolved'}) couldn't be written to the incident store: ${e.message.slice(0, 200)}; kept in memory, written when there is room. ${detail}`);
        }
    }
    stop() {
        this.off();
    }
}
/**
 * The guard for a coordinator's site: its state dir, and the test runs' base when it runs test runs. INVARIANT: the
 * incident names the instance by its name, as the Health page and the watchdog filter on it, never the process's
 * user@host id; a site with no instance (local mode) says it in the journal only.
 */
export function siteDiskGuard(o) {
    return new DiskGuard({
        log: o.log,
        instance: o.instance ?? o.actor,
        paths: [o.stateDir, ...(o.testRuns ? [TEST_RUN_BASE] : [])],
        floor: o.floor,
        ...(o.instance ? { incidents: o.incidentsDir ? { dir: o.incidentsDir } : {} } : {}),
        ...(o.inFlight ? { inFlight: o.inFlight } : {}),
        ...(o.say ? { say: o.say } : {}),
    });
}
/** Run a guard's step on its own timer until stopped; a failure that isn't the disk's is said in the journal, and the next step tries again. */
export function startDiskGuard(g, everyMs = RETRY_MIN_MS, say = (l) => console.error(l)) {
    const t = setInterval(() => {
        try {
            g.step();
        }
        catch (e) {
            say(`disk guard: ${e.message.slice(0, 300)}`);
        }
    }, everyMs);
    t.unref();
    return () => {
        clearInterval(t);
        g.stop();
    };
}
//# sourceMappingURL=disk-guard.js.map