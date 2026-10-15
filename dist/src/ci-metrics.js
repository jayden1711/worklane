import { recordable } from './test-durations.js';
/** At most one GitHub API call per this long. */
export const CI_METRICS_CALL_MS = 60_000;
/** Merged PRs this many days back are measured. */
export const CI_LOOKBACK_DAYS = 30;
/** The default branch's CI jobs are read for slow tests at most this often. */
export const SLOW_TESTS_EVERY_MS = 24 * 3_600_000;
/** A merge commit's CI is read once it is at least this old (its jobs have finished). */
export const SLOW_TESTS_SETTLE_MS = 2 * 3_600_000;
/** At most this many Actions jobs' logs per commit. */
export const MAX_JOBS = 10;
/** A merged PR's check runs are asked at most this many times before it is recorded as not measurable. */
export const CI_METRICS_TRIES = 3;
/**
 * A head's CI wall-clock from its check runs: the first one's start to the last required check's completion (every
 * check's when `required` is empty). Not measurable (wall_ms null, and why) when a required check never completed.
 */
export function prWallClock(runs, required) {
    const t = (s) => (s ? Date.parse(s) : NaN);
    const starts = runs.map((r) => t(r.startedAt)).filter(Number.isFinite);
    const none = (why) => ({ wall_ms: null, first_started: null, last_completed: null, why });
    if (!starts.length)
        return none('no check run started on the head');
    const first = Math.min(...starts);
    const done = (rs) => rs.filter((r) => r.status === 'completed').map((r) => t(r.completedAt)).filter(Number.isFinite);
    let last;
    if (required.length) {
        const ends = [];
        for (const name of required) {
            const e = done(runs.filter((r) => r.name === name));
            if (!e.length)
                return none(`the required check ${name} never completed on the head`);
            ends.push(Math.max(...e));
        }
        last = Math.max(...ends);
    }
    else {
        const e = done(runs);
        if (!e.length)
            return none('no check run completed on the head');
        last = Math.max(...e);
    }
    return { wall_ms: Math.max(0, Math.round(last - first)), first_started: new Date(first).toISOString(), last_completed: new Date(last).toISOString(), why: null };
}
const READS = ['merge.done', 'pr.closed', 'pr.opened', 'pr.ready', 'pr.status', 'ci.pr_timing', 'ci.test_durations'];
export class CiMetrics {
    d;
    lastCall = 0;
    tries = new Map();
    /** The Actions jobs of a commit still to read, one log per call. */
    jobs = [];
    constructor(d) {
        this.d = d;
    }
    now() {
        return this.d.now?.() ?? Date.now();
    }
    /** One GitHub call at most, when one is due: a job log queued, else a merged PR's timing, else the day's slow tests. */
    async step() {
        const now = this.now();
        if (now - this.lastCall < CI_METRICS_CALL_MS)
            return;
        const evs = this.d.events(READS);
        const P = (e) => e.payload;
        const next = this.jobs.shift();
        if (next) {
            this.lastCall = now;
            let parsed = { tests: [], parsed: 0 };
            let error = null;
            try {
                parsed = recordable(await this.d.api.jobLog(next.job.id));
            }
            catch (e) {
                error = e.message.slice(0, 500);
            }
            this.d.emit('ci.test_durations', { sha: next.sha, job: next.job.name.slice(0, 200), tests: parsed.tests, parsed: parsed.parsed, error });
            return;
        }
        // A merged PR in the lookback without its timing: the newest first.
        const since = now - CI_LOOKBACK_DAYS * 86_400_000;
        const timed = new Set(evs.filter((e) => e.type === 'ci.pr_timing').map((e) => Number(P(e).number)));
        const head = new Map();
        const merged = new Map();
        for (const e of evs) {
            const p = P(e);
            if (typeof p.number !== 'number')
                continue;
            if (typeof p.head === 'string' && /^[0-9a-f]{40}$/.test(p.head))
                head.set(p.number, p.head);
            if ((e.type === 'merge.done' || (e.type === 'pr.closed' && p.merged === true)) && Date.parse(e.ts) > since)
                merged.set(p.number, Date.parse(e.ts));
        }
        const todo = [...merged].filter(([n]) => !timed.has(n) && head.has(n)).sort((a, b) => b[1] - a[1])[0];
        if (todo) {
            const [number] = todo;
            const sha = head.get(number);
            this.lastCall = now;
            try {
                this.d.emit('ci.pr_timing', { number, head: sha, ...prWallClock(await this.d.api.checkRuns(sha), this.d.required()) });
                this.tries.delete(number);
            }
            catch (e) {
                const n = (this.tries.get(number) ?? 0) + 1;
                this.tries.set(number, n);
                if (n >= CI_METRICS_TRIES)
                    this.d.emit('ci.pr_timing', { number, head: sha, wall_ms: null, first_started: null, last_completed: null, why: `reading its check runs failed: ${e.message}`.slice(0, 500) });
            }
            return;
        }
        // The day's slow tests: the Actions jobs on the newest settled merge commit, unless read in the last day.
        const lastRead = Math.max(0, ...evs.filter((e) => e.type === 'ci.test_durations').map((e) => Date.parse(e.ts)));
        if (now - lastRead < SLOW_TESTS_EVERY_MS)
            return;
        const read = new Set(evs.filter((e) => e.type === 'ci.test_durations').map((e) => String(P(e).sha)));
        const commit = evs
            .filter((e) => e.type === 'merge.done' && typeof P(e).sha === 'string' && now - Date.parse(e.ts) >= SLOW_TESTS_SETTLE_MS && Date.parse(e.ts) > since)
            .map((e) => String(P(e).sha))
            .at(-1);
        if (!commit || read.has(commit))
            return;
        this.lastCall = now;
        let runs;
        try {
            runs = await this.d.api.checkRuns(commit);
        }
        catch {
            return; // tried again on a later pass
        }
        const jobs = runs.filter((r) => r.app === 'github-actions' && r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'failure')).slice(0, MAX_JOBS);
        if (!jobs.length) {
            this.d.emit('ci.test_durations', { sha: commit, job: '(none)', tests: [], parsed: 0, error: 'no finished GitHub Actions job on this commit' });
            return;
        }
        this.jobs = jobs.map((job) => ({ sha: commit, job }));
    }
}
//# sourceMappingURL=ci-metrics.js.map