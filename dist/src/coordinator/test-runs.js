// The coordinator's fast test runs (src/testrun/): one tick step that runs tests.yaml test_run's fast tiers on every
// open PR's head, the harness's, the owner's and bots' alike, and posts them as checks. A PR whose head moves gets a
// new run, and the superseded one is cancelled. Full tiers run per batch of approved PRs (PR mode, Track PB): the
// harness's, and people's PRs from this listing (merge-flow.ts batchPeoplesPrs): a mapped admin's or writer's once its
// fast checks pass; a bot's or an unmapped author's only once an admin approved it.
import { execFileSync } from 'node:child_process';
import { BRAND } from '../brand.js';
import { ChecksPermissionMissing } from '../testrun/index.js';
import { SANDBOX_STEP } from '../testrun/run.js';
import { startRefusal, TestRunHeld } from '../testrun/gate.js';
/** Open PRs, one listing (at most 100: the newest first). */
export async function listOpenPrs(repo, token, f = fetch, api = 'https://api.github.com') {
    const res = await f(`${api}/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=desc`, {
        headers: { authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok)
        throw new Error(`GitHub ${res.status} listing open PRs`);
    const prs = (await res.json());
    return prs.map((p) => ({ number: p.number, headSha: p.head.sha, base: p.base.ref, author: p.user?.login ?? '', bot: p.user?.type === 'Bot' || /\[bot\]$/.test(p.user?.login ?? '') }));
}
/** Whether a PR may have its full tiers run (a batch): a bot's only once the owner approved it. */
export function fullRunAllowed(pr, ownerApproved) {
    return !pr.bot || ownerApproved;
}
/** Runs started but never finished: a coordinator stopped during them. Their ids. */
export function unfinishedRuns(events) {
    const started = new Set();
    for (const e of events) {
        if (e.type === 'testrun.started')
            started.add(e.payload.id);
        if (e.type === 'testrun.finished')
            started.delete(e.payload.id);
    }
    return [...started];
}
/** What a check posted while the event log can't be written says (the run's own events wait in memory). */
export const EVENTS_KEPT_NOTE = "The instance's disk is full: this run's record waits in memory and is written to its log when there is room. The result above is the run's.";
export class PrTestRuns {
    d;
    inFlight = new Map();
    /** pr -> heads whose fast run finished (from the log, so a restart doesn't run them again). */
    finished = new Map();
    /**
     * pr -> the head whose run was refused because the sandbox's check is failing: its "test runs are off" check is
     * posted once, and the head runs for real once the check passes (sandboxPassed).
     */
    refused = new Map();
    lastPoll = 0;
    /** The latest listing of open PRs (the coordinator batches people's PRs from it: no listing of its own). */
    openPrs = [];
    /** Aborted when the coordinator stops: every run from here, and the batches' (batchTestRuns), is cancelled and wiped. */
    stopped = new AbortController();
    constructor(d) {
        this.d = d;
        const queued = new Map();
        for (const e of d.log.read(0, ['testrun.queued', 'testrun.finished'])) {
            if (e.type === 'testrun.queued')
                queued.set(e.payload.id, e.payload);
            else {
                const p = e.payload;
                // An interrupted or errored run runs again; a cancelled one was superseded.
                if (p.kind !== 'fast' || p.outcome !== 'done' || !queued.has(p.id))
                    continue;
                for (const n of p.prs)
                    this.finished.set(n, new Set([...(this.finished.get(n) ?? []), p.sha]));
            }
        }
    }
    /** At start: wipe what a stopped coordinator's runs left, and record them as interrupted. */
    async recover() {
        const ids = unfinishedRuns(this.d.log.read(0, ['testrun.started', 'testrun.finished']));
        for (const id of ids) {
            const queued = this.d.log.read(0, ['testrun.queued']).map((e) => e.payload).find((p) => p.id === id);
            const w = await this.d.host.wipe(id).catch((e) => ({ ok: false, left: [e.message.slice(0, 200)] }));
            if (!w.ok)
                this.d.log.append('testrun.wipe_failed', { id, left: w.left.slice(0, 20) }, this.d.actor);
            this.d.log.append('testrun.finished', { id, sha: queued?.sha ?? '0000000', kind: queued?.kind ?? 'fast', prs: queued?.prs ?? [], ok: false, outcome: 'interrupted', results: [], detail: 'the coordinator stopped during the run; wiped at start' }, this.d.actor);
        }
        return ids;
    }
    fetchPr(pr) {
        if (this.d.fetchPr)
            return this.d.fetchPr(pr);
        const ref = `refs/${BRAND.cli}/test-run/${pr.number}`;
        const git = (...a) => execFileSync('git', ['-C', this.d.repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim();
        git('fetch', '-q', this.d.remote, `+refs/pull/${pr.number}/head:${ref}`, `+refs/heads/${pr.base}:refs/remotes/${this.d.remote}/${pr.base}`);
        return git('rev-parse', `${ref}^{commit}`);
    }
    changed(pr) {
        if (this.d.changed)
            return this.d.changed(pr);
        const out = execFileSync('git', ['-C', this.d.repo, 'diff', '--name-only', '-z', `${this.d.remote}/${pr.base}...${pr.headSha}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
        return out.split('\0').filter(Boolean);
    }
    /** One pass: list open PRs (at most every pollMs), cancel superseded runs, start runs for new heads. */
    async tick() {
        const now = (this.d.now ?? Date.now)();
        const out = { started: [], cancelled: [] };
        if (now - this.lastPoll < (this.d.pollMs ?? 90_000))
            return out;
        this.lastPoll = now;
        const prs = await this.d.listPrs();
        this.openPrs = prs;
        const open = new Map(prs.map((p) => [p.number, p]));
        for (const [n, f] of this.inFlight) {
            const pr = open.get(n);
            if (!pr || pr.headSha !== f.sha) {
                f.controller.abort();
                out.cancelled.push(n);
            }
        }
        for (const pr of prs) {
            if (this.inFlight.size >= (this.d.maxInFlight ?? 12))
                break;
            const cur = this.inFlight.get(pr.number);
            if (cur && cur.sha === pr.headSha)
                continue;
            if (this.finished.get(pr.number)?.has(pr.headSha))
                continue;
            // INVARIANT: nothing starts (not even the fetch, which writes refs) while the disk is full or below its floor;
            // the heads not started are started from a later listing, once there is room.
            // WHY: the gate is asked here too (src/testrun/gate.ts), so a held head isn't fetched each listing only to be refused.
            if (startRefusal())
                break;
            // WHY: one "test runs are off" check per head while the sandbox's check fails, not one every listing.
            if (this.refused.get(pr.number) === pr.headSha && !this.ready())
                continue;
            let sha;
            let changedFiles;
            try {
                sha = this.fetchPr(pr);
                // The head moved between the listing and the fetch: the next pass runs the newer one.
                if (sha !== pr.headSha)
                    continue;
                changedFiles = this.changed(pr);
            }
            catch (e) {
                this.d.log.append('coordinator.error', { instance: this.d.actor, where: `test run of #${pr.number}`, kind: 'fetch', message: e.message.slice(0, 500) }, this.d.actor);
                continue;
            }
            const controller = new AbortController();
            const entry = { sha, controller, done: Promise.resolve() };
            entry.done = this.runOne(pr, sha, changedFiles, controller).finally(() => {
                if (this.inFlight.get(pr.number) === entry)
                    this.inFlight.delete(pr.number);
            });
            this.inFlight.set(pr.number, entry);
            out.started.push(pr.number);
        }
        return out;
    }
    async runOne(pr, sha, changedFiles, controller) {
        let result;
        try {
            result = await this.d.start({ repo: this.d.repo, sha, kind: 'fast', prs: [pr.number], changedFiles }, { signal: controller.signal });
        }
        catch (e) {
            // WHY: held at the gate is no result: the head isn't finished, so a later listing runs it once there is room.
            if (e instanceof TestRunHeld)
                return;
            this.d.log.append('coordinator.error', { instance: this.d.actor, where: `test run of #${pr.number}`, kind: 'error', message: e.message.slice(0, 500) }, this.d.actor);
            return;
        }
        if (controller.signal.aborted)
            return; // superseded: its head is no longer the PR's, so no check on it
        // WHY: the result is known, and posting it needs no disk: the check goes up, saying its record waits in memory.
        if (this.d.log.buffered().count)
            result = { ...result, note: EVENTS_KEPT_NOTE };
        // INVARIANT: a refused head is never "finished": it gets its real run as soon as the sandbox's check passes.
        if (result.setup?.step === SANDBOX_STEP)
            this.refused.set(pr.number, sha);
        else {
            this.refused.delete(pr.number);
            this.finished.set(pr.number, new Set([...(this.finished.get(pr.number) ?? []), sha]));
        }
        try {
            await this.d.post(sha, result);
        }
        catch (e) {
            // A missing permission is recorded (testrun.checks_failed) and shown in health; anything else is an error.
            if (!(e instanceof ChecksPermissionMissing))
                this.d.log.append('coordinator.error', { instance: this.d.actor, where: `checks for #${pr.number}`, kind: 'error', message: e.message.slice(0, 500) }, this.d.actor);
        }
    }
    /** False while the sandbox's check is failing: every run is refused, and nothing else may go through the service. */
    ready() {
        return this.d.sandbox?.ok ?? true;
    }
    /**
     * The sandbox's check passed (at start, or after failing): what a stopped coordinator's runs left is wiped, and the
     * next tick lists the PRs at once and runs every head that only got a "test runs are off" check.
     */
    async sandboxPassed() {
        this.lastPoll = 0;
        await this.recover();
    }
    /** The open PRs as last listed (empty before the first listing). */
    listing() {
        return this.openPrs;
    }
    /** Wait for the runs in flight (tests and shutdown). */
    async idle() {
        while (this.inFlight.size)
            await Promise.all([...this.inFlight.values()].map((f) => f.done));
    }
    stop() {
        this.d.sandbox?.stop();
        this.stopped.abort();
        for (const f of this.inFlight.values())
            f.controller.abort();
    }
}
//# sourceMappingURL=test-runs.js.map