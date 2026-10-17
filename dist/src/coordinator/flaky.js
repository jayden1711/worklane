// The flaky-test gate in front of "the default branch went red" (src/flaky.ts). The merge flow hands it each
// auto-merge commit's required check outcomes; it answers wait (a re-run is going) or the outcomes as the harness's
// red/green decision should count them:
//   - a failing check not quarantined is re-run once on the same commit: an Actions job by re-running its workflow
//     run's failed jobs, a test-run check by running its tiers again (and posting the checks again). Until the
//     re-run is in, wait; failed again (or it can't re-run, or took longer than rerun_timeout_min) is real and stays
//     a failure; passed is flaky: quarantined (one issue per test, ever), and counted as passed.
//   - a quarantined check that fails counts as passed; one that passes counts toward its release.
// Nothing here changes a check on GitHub or what the updater requires.
import { HeldTime, startRefusal, TestRunHeld } from '../testrun/gate.js';
import { BRAND } from '../brand.js';
import { afterResult, classifyRerun, failed, FLAKY_EVENTS, isQuarantined, issueBody, issueTitle, quarantine } from '../flaky.js';
import { noVerdict } from './pr-batch.js';
export class FlakyGate {
    d;
    /** A test-run re-run's checks by commit: each check's outcome once it finished (lost on a restart: the posted check is read then). */
    testRunReruns = new Map();
    /** Time each re-run spent held at the start gate: not counted against rerun_timeout_min. */
    heldTime = new HeldTime();
    constructor(d) {
        this.d = d;
    }
    get now() {
        return this.d.now?.() ?? Date.now();
    }
    emit(type, payload) {
        this.d.log.append(type, payload, this.d.actor);
    }
    error(where, e) {
        this.emit('coordinator.error', { instance: this.d.actor, where, kind: e.kind ?? 'error', message: e.message.slice(0, 500) });
    }
    /** The required checks of the default branch's commit `sha`, as the harness's red/green decision counts them; or wait. */
    async judge(o) {
        const cfg = this.d.config();
        const events = this.d.log.read(0, [...FLAKY_EVENTS]);
        const requested = events.filter((e) => e.type === 'flaky.rerun_requested' && e.payload.sha === o.sha).at(-1);
        const done = events.filter((e) => e.type === 'flaky.rerun_result' && e.payload.sha === o.sha).at(-1)?.payload;
        let outcomes = o.outcomes;
        let flaky = [];
        let real = [];
        if (done)
            ({ flaky, real } = done);
        else if (requested) {
            const r = await this.resolve(o.sha, o.number, requested.payload, Date.parse(requested.payload.at), outcomes, cfg);
            if (!r)
                return { wait: true };
            ({ flaky, real } = r);
        }
        else if (cfg.rerun) {
            const q = quarantine(events);
            const blocking = outcomes.filter((c) => failed(c.outcome) && !isQuarantined(q, c.name));
            const via = blocking.length ? this.routes(blocking) : [];
            if (via.some((v) => v.how !== 'none')) {
                // A workflow run can't re-run its failed jobs while it is still going: the rest finish first.
                if (outcomes.some((c) => c.outcome === 'pending'))
                    return { wait: false, outcomes: outcomes.map((c) => (blocking.includes(c) ? { ...c, outcome: 'pending' } : c)), flaky: [], quarantined: [] };
                await this.request(o.sha, o.number, blocking, via);
                return { wait: true };
            }
        }
        // Flaky on this commit: counted as passed (its failure was the flake).
        // Real (failed again, couldn't re-run, or the re-run timed out): a failure, whatever the check shows now.
        outcomes = outcomes.map((c) => (flaky.includes(c.name) && failed(c.outcome) ? { ...c, outcome: 'pass' } : real.includes(c.name) && !failed(c.outcome) ? { ...c, outcome: 'fail' } : c));
        const q = quarantine(this.d.log.read(0, [...FLAKY_EVENTS]));
        const quarantined = outcomes.filter((c) => failed(c.outcome) && isQuarantined(q, c.name)).map((c) => c.name);
        if (quarantined.length)
            outcomes = outcomes.map((c) => (quarantined.includes(c.name) ? { ...c, outcome: 'pass' } : c));
        if (!o.outcomes.some((c) => c.outcome === 'pending'))
            await this.observe(o.sha, o.outcomes, flaky, cfg);
        return { wait: false, outcomes, flaky, quarantined };
    }
    /** How each failing check can be re-run: a test-run check by its tiers, an Actions job by its run, else not. */
    routes(blocking) {
        const testRunChecks = new Set(Object.values(this.d.testRuns?.checkNames() ?? {}));
        return blocking.map((c) => {
            if (testRunChecks.has(c.name) && this.d.testRuns)
                return { check: c.name, how: 'test_run', id: c.id ?? null, why: null };
            if (c.id !== undefined && this.d.backlog.rerunFailedJobs)
                return { check: c.name, how: 'actions', id: c.id, why: null };
            return { check: c.name, how: 'none', id: c.id ?? null, why: c.id === undefined ? 'a commit status, not a check run: nothing to re-run' : "this tracker can't re-run checks" };
        });
    }
    async request(sha, number, blocking, via) {
        const actions = via.filter((v) => v.how === 'actions' && v.id !== null).map((v) => v.id);
        if (actions.length) {
            let res = new Map();
            try {
                res = await this.d.backlog.rerunFailedJobs(actions);
            }
            catch (e) {
                this.error(`re-run of ${sha.slice(0, 8)}'s failed jobs`, e);
                for (const id of actions)
                    res.set(id, { ok: false, why: 'forbidden', detail: e.message.slice(0, 300) });
            }
            for (const v of via) {
                const r = v.how === 'actions' && v.id !== null ? res.get(v.id) : undefined;
                if (r && !r.ok)
                    Object.assign(v, { how: 'none', why: `GitHub refused the re-run (${r.why}): ${r.detail}` });
            }
        }
        const tr = via.filter((v) => v.how === 'test_run').map((v) => v.check);
        if (tr.length)
            this.startTestRunRerun(sha, tr);
        this.emit('flaky.rerun_requested', { sha, number, failed: blocking.map((c) => c.name), via, at: new Date(this.now).toISOString() });
    }
    /** Run the tiers behind `checks` again on `sha` in the background, and post their checks again. */
    startTestRunRerun(sha, checks) {
        const tr = this.d.testRuns;
        const names = tr.checkNames();
        const kinds = new Set();
        for (const t of this.d.tiers())
            if (checks.includes(names[t.name] ?? ''))
                kinds.add(t.kind);
        this.testRunReruns.set(sha, 'running');
        void (async () => {
            const got = new Map();
            try {
                this.d.fetch();
                for (const kind of kinds) {
                    const r = await tr.startTestRun({ repo: this.d.clone, sha, kind, prs: [] });
                    // A check passes when every tier behind it passed in a run that gave a verdict; anything else can't clear it.
                    const verdict = noVerdict(r) === null;
                    for (const name of checks) {
                        const tiers = r.tiers.filter((t) => (names[t.tier] ?? `test-run/${t.tier}`) === name);
                        if (tiers.length)
                            got.set(name, verdict && tiers.every((t) => t.ok) ? 'pass' : 'fail');
                    }
                    await tr.postChecks(sha, r, names).catch((e) => this.error(`checks of the re-run on ${sha.slice(0, 8)}`, e));
                }
            }
            catch (e) {
                // WHY: held at the start gate (src/testrun/gate.ts) is no verdict: the re-run starts again once the gate lets it.
                if (e instanceof TestRunHeld) {
                    this.testRunReruns.set(sha, { held: checks });
                    this.heldTime.held(sha, this.now, true);
                    return;
                }
                this.error(`test-run re-run of ${sha.slice(0, 8)}`, e);
            }
            for (const c of checks)
                if (!got.has(c))
                    got.set(c, 'fail');
            this.testRunReruns.set(sha, got);
        })();
    }
    /** The re-run's verdict, once every check is in (or the wait timed out); null while it runs. */
    async resolve(sha, number, req, at, outcomes, cfg) {
        const mem = this.testRunReruns.get(sha);
        if (mem && typeof mem === 'object' && 'held' in mem) {
            const held = startRefusal() !== null;
            this.heldTime.held(sha, this.now, held);
            if (!held)
                this.startTestRunRerun(sha, mem.held);
            return null;
        }
        const now = (v) => {
            if (v.how === 'none')
                return 'fail';
            if (v.how === 'test_run' && mem instanceof Map)
                return mem.get(v.check) ?? 'fail';
            if (v.how === 'test_run' && mem === 'running')
                return null;
            // An Actions re-run (or a test-run re-run from before a restart): the check run that replaced the failing one.
            const c = outcomes.find((x) => x.name === v.check);
            if (!c || c.outcome === 'pending' || c.outcome === 'missing' || (v.id !== null && c.id === v.id))
                return null;
            return c.outcome === 'pass' ? 'pass' : 'fail';
        };
        const timedOut = this.now - at - this.heldTime.ms(sha, this.now) >= cfg.rerun_timeout_min * 60_000;
        const v = classifyRerun(req.via.map((x) => ({ check: x.check, now: now(x) })), timedOut);
        if (v.waiting.length)
            return null;
        this.testRunReruns.delete(sha);
        this.emit('flaky.rerun_result', { sha, number, flaky: v.flaky, real: v.real, timed_out: v.timedOut });
        for (const test of v.flaky)
            await this.quarantine(test, sha, cfg);
        return v;
    }
    /** Quarantine a test seen flaky on `sha`: a new one gets its issue; one quarantined already, a sighting. */
    async quarantine(test, sha, cfg) {
        const was = quarantine(this.d.log.read(0, [...FLAKY_EVENTS])).get(test);
        if (was?.state === 'quarantined') {
            this.emit('flaky.sighted', { test, sha, sightings: was.sightings + 1 });
            if (!was.issue)
                await this.fileIssue(test, sha, cfg);
            return;
        }
        let issue = was?.issue ?? null;
        if (issue) {
            await this.d.backlog.comment(issue, `[${BRAND.cli}] \`${test}\` was flaky again on \`${sha.slice(0, 8)}\` (it failed, then passed on a re-run of the same commit) and is quarantined again.`).catch((e) => this.error(`flaky issue #${issue}`, e));
        }
        else
            issue = await this.createIssue(test, sha, cfg);
        this.emit('flaky.quarantined', { test, sha, issue, url: issue ? this.issueUrl(issue) : null, again: !!was });
    }
    issueUrl(n) {
        return `https://github.com/${this.d.repo}/issues/${n}`;
    }
    async createIssue(test, sha, cfg) {
        try {
            return await this.d.backlog.createIssue(issueTitle(test), issueBody({ test, sha, branch: this.d.branch, product: BRAND.name, releaseAfter: cfg.release_after_passes }), []);
        }
        catch (e) {
            this.error(`flaky issue for ${test}`, e);
            return null;
        }
    }
    /** A quarantined test whose issue couldn't be filed: filed now, recorded as a quarantine with it. */
    async fileIssue(test, sha, cfg) {
        const issue = await this.createIssue(test, sha, cfg);
        if (issue)
            this.emit('flaky.quarantined', { test, sha, issue, url: this.issueUrl(issue), again: true });
    }
    /** Each quarantined test's result on `sha` (once per commit): passes in a row, and its release at release_after_passes. */
    async observe(sha, outcomes, flakyHere, cfg) {
        const events = this.d.log.read(0, [...FLAKY_EVENTS]);
        const seen = new Set(events.filter((e) => e.type === 'flaky.observed' && e.payload.sha === sha).map((e) => e.payload.test));
        const q = quarantine(events);
        for (const c of outcomes) {
            const t = q.get(c.name);
            if (!t || t.state !== 'quarantined' || seen.has(c.name) || flakyHere.includes(c.name))
                continue;
            if (c.outcome !== 'pass' && !failed(c.outcome))
                continue;
            const r = afterResult(t.passes, c.outcome === 'pass', cfg.release_after_passes);
            this.emit('flaky.observed', { test: c.name, sha, ok: c.outcome === 'pass', passes: r.passes });
            // Failing again while quarantined: one more sighting (and its issue filed now, if that failed before).
            if (c.outcome !== 'pass') {
                this.emit('flaky.sighted', { test: c.name, sha, sightings: t.sightings + 1 });
                if (!t.issue)
                    await this.fileIssue(c.name, sha, cfg);
            }
            if (!r.release)
                continue;
            this.emit('flaky.released', { test: c.name, how: 'passes', by: this.d.actor, passes: r.passes });
            if (t.issue)
                await this.d.backlog.comment(t.issue, `[${BRAND.cli}] \`${c.name}\` passed ${r.passes} times in a row on ${this.d.branch} (the last on \`${sha.slice(0, 8)}\`): out of quarantine, it blocks again.`).catch((e) => this.error(`flaky issue #${t.issue}`, e));
        }
    }
}
//# sourceMappingURL=flaky.js.map