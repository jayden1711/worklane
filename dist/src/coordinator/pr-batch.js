// PR-mode batching (tests.yaml land.pr_batch): the PR-mode twin of the direct-landing batches in landing.ts.
// A PR ready on its fast checks waits in a queue. A batch of them, in the order they became ready, is merged into
// one commit on a local `<cli>/batch-<n>` branch, and that commit gets one full test run (sharded). Green: the
// passing full check is posted on each PR's head and the PR watch hands each one to the merge policy (auto-merge
// where it allows, the owner otherwise). Red: a binary search over the batch's prefixes finds the first culprit,
// which goes back to its author with the failing tier; the green prefix before it merges; the rest is batched again.
//
// Never merge untested: a PR may merge only with every fast check passing on its head and a passing full run from a
// batch that held exactly that head (mayMerge, called right before the merge). A PR whose head changes leaves its
// batch. Every step is an event, so a restart resumes a green batch's checks and abandons anything else (its PRs go
// back in the queue), and nothing is merged twice.
import { TestRunHeld } from '../testrun/gate.js';
import { GPU_NO_REPEAT, gpuRunsNotToRepeat } from '../testrun/gpu.js';
import { spawnSync } from 'node:child_process';
import { BRAND } from '../brand.js';
import { requiredOutcomes } from '../pr-watch.js';
const key = (number, head) => `${number}@${head}`;
export const PR_BATCH_EVENTS = ['pr_batch.queued', 'pr_batch.step', 'pr.closed'];
/** The batches and the queue, folded from the log (`pr_batch.*` and `pr.closed`; other events are ignored). */
export function batchState(events) {
    const latest = new Map();
    const batches = new Map();
    const posted = new Map();
    const returned = new Map();
    const gone = new Set();
    let baseRed = null;
    for (const e of events) {
        if (e.type === 'pr_batch.queued') {
            const p = e.payload;
            const prior = latest.get(p.number);
            if (!prior || prior.entry.head !== p.head)
                latest.set(p.number, { entry: { issue: p.issue, number: p.number, head: p.head, ...(p.by ? { by: p.by } : {}) }, order: e.id });
        }
        else if (e.type === 'pr.closed') {
            latest.delete(e.payload.number);
        }
        else if (e.type === 'pr_batch.step') {
            const s = e.payload;
            let b = batches.get(s.id);
            if (!b) {
                b = { id: s.id, parent: s.parent, prs: [], sha: null, base: null, steps: [], run: null, trees: [], open: false, at: e.ts, last: e.ts };
                batches.set(s.id, b);
            }
            b.steps.push(s.step);
            b.last = e.ts;
            if (s.step === 'built')
                Object.assign(b, { prs: s.prs, sha: s.sha, base: s.base, trees: s.trees ?? [], open: true });
            if (s.step === 'green' || s.step === 'red')
                b.run = s.run;
            if (s.step === 'finished' || s.step === 'abandoned' || s.step === 'gpu_held')
                b.open = false;
            for (const p of s.prs) {
                if (s.step === 'checks_posted')
                    posted.set(key(p.number, p.head), s.id);
                // Main is no longer what the batch tested for it: untested again, back in the queue.
                if (s.step === 'stale' && posted.get(key(p.number, p.head)) === s.id)
                    posted.delete(key(p.number, p.head));
                // gpu_held: a GPU run of its batch timed out, was killed or was cut off; never batched again at this head.
                if (s.step === 'culprit' || s.step === 'conflict' || s.step === 'gpu_held')
                    returned.set(key(p.number, p.head), s);
                if (s.step === 'dropped')
                    gone.add(key(p.number, p.head));
            }
            if (s.step === 'error' && s.tier === BASE_TIER)
                baseRed = s.base;
            if (s.step === 'green' && s.base === baseRed)
                baseRed = null;
        }
    }
    const inFlight = new Set([...batches.values()].filter((b) => b.open).flatMap((b) => b.prs.map((p) => key(p.number, p.head))));
    const queue = [...latest.values()]
        .filter(({ entry: q }) => {
        const k = key(q.number, q.head);
        return !posted.has(k) && !returned.has(k) && !gone.has(k) && !inFlight.has(k);
    })
        .sort((a, b) => a.order - b.order)
        .map((x) => x.entry);
    return { queue, batches, posted, returned, baseRed };
}
/** The tier name a base-red check records: the base fails the full run with no PR in it. */
const BASE_TIER = '(base)';
/** Each batch the queue started (bisection steps folded into theirs), oldest first. */
export function batchSummaries(events) {
    const st = batchState(events);
    const rootOf = (id) => {
        const b = st.batches.get(id);
        return b?.parent ? rootOf(b.parent) : id;
    };
    const extra = new Map();
    for (const e of events) {
        if (e.type !== 'pr_batch.step')
            continue;
        const s = e.payload;
        const x = extra.get(rootOf(s.id)) ?? { passed: [], culprits: [], requeued: [], dropped: [], stale: [] };
        extra.set(rootOf(s.id), x);
        const nums = s.prs.map((p) => p.number);
        if (s.step === 'checks_posted')
            x.passed.push(...nums);
        if (s.step === 'culprit')
            x.culprits.push(...nums.map((number) => ({ number, tier: s.tier })));
        if (s.step === 'requeued')
            x.requeued.push(...nums);
        if (s.step === 'stale')
            x.stale.push(...nums);
        if (s.step === 'dropped')
            x.dropped.push(...nums);
    }
    const out = [];
    for (const b of st.batches.values()) {
        if (b.parent)
            continue;
        const x = extra.get(b.id) ?? { passed: [], culprits: [], requeued: [], dropped: [], stale: [] };
        const status = b.steps.includes('abandoned')
            ? 'abandoned'
            : b.steps.includes('green')
                ? 'green'
                : b.steps.includes('red')
                    ? b.open
                        ? 'bisecting'
                        : 'red'
                    : b.steps.includes('built')
                        ? b.open
                            ? 'testing'
                            : 'empty'
                        : 'empty';
        const list = (ns) => [...new Set(ns)].map((n) => `#${n}`).join(', ');
        const parts = [
            x.passed.length ? `passed ${list(x.passed)}` : '',
            ...x.culprits.map((c) => `returned #${c.number} (${c.tier ?? 'full run'} failed)`),
            x.requeued.length ? `re-batched ${list(x.requeued)}` : '',
            x.stale.length ? `main moved before ${list(x.stale)} merged: tested again` : '',
            x.dropped.length ? `dropped ${list(x.dropped)} (head changed or closed)` : '',
        ].filter(Boolean);
        out.push({ id: b.id, status, open: b.open, prs: b.prs.map((p) => ({ issue: p.issue, number: p.number })), passed: [...new Set(x.passed)], culprits: x.culprits, requeued: [...new Set(x.requeued)], dropped: [...new Set(x.dropped)], at: b.at, last: b.last, detail: parts.join('; ') });
    }
    return out;
}
/** Where one PR head stands with the batches: queued, in a batch being tested, passed, returned, or not in them. */
export function prBatchStatus(events, number, head) {
    return prBatchStatusIn(batchState(events), number, head);
}
/** prBatchStatus on a batch state already folded (WHY: the Board asks it for every open PR; one fold serves them all). */
export function prBatchStatusIn(st, number, head) {
    const k = key(number, head);
    const posted = st.posted.get(k);
    if (posted)
        return { status: 'passed', batch: posted };
    const back = st.returned.get(k);
    if (back)
        return { status: 'returned', batch: back.id };
    const open = [...st.batches.values()].find((b) => b.open && !b.parent && b.prs.some((p) => p.number === number && p.head === head));
    if (open)
        return { status: 'testing', batch: open.id };
    if (st.queue.some((q) => q.number === number && q.head === head))
        return { status: 'queued', batch: null };
    return null;
}
// ---------------------------------------------------------------- batch size
/** The pass rate assumed before there is history, and how many PRs' worth of weight it carries. */
export const PRIOR_PASS_RATE = 0.9;
const PRIOR_WEIGHT = 10;
/** How many recent PR outcomes the pass rate is taken over. */
const PASS_RATE_WINDOW = 200;
/**
 * The share of PRs that pass the full run: of the PR heads that recently came out of a batch, those that passed (their
 * full check posted) against those found to be culprits, smoothed toward PRIOR_PASS_RATE while there is little history.
 */
export function passRate(st) {
    const passed = Math.min(st.posted.size, PASS_RATE_WINDOW);
    const failed = Math.min([...st.returned.values()].filter((s) => s.step === 'culprit').length, PASS_RATE_WINDOW);
    return (passed + PRIOR_PASS_RATE * PRIOR_WEIGHT) / (passed + failed + PRIOR_WEIGHT);
}
/**
 * Full runs per PR for a batch of k at pass rate p: the batch's one run shared by k PRs, plus, for each PR expected to
 * fail (1 - p of them), a bisection of log2(k) runs and one run to test the rest again. A batch of one is one run.
 */
export function runsPerPr(k, p) {
    if (k <= 1)
        return 1;
    return 1 / k + (1 - p) * (Math.log2(k) + 1);
}
/** The batch size with the fewest full runs per PR at this pass rate, from 1 to `max` (about ln 2 / (1 - p)). */
export function batchSize(p, max) {
    let best = 1;
    for (let k = 2; k <= max; k++)
        if (runsPerPr(k, p) < runsPerPr(best, p))
            best = k;
    return best;
}
// ---------------------------------------------------------------- the merge guard
/**
 * May this PR merge at this head? Only with every fast check passing on the head and a passing full run from a batch
 * that held exactly this head, whose full check was posted on it. Fails closed (no fast checks configured: no).
 */
export function mayMerge(o) {
    if (!o.fastChecks.length)
        return { ok: false, why: 'no fast checks are configured (tests.yaml land.pr_batch.fast_checks)' };
    const fast = requiredOutcomes(o.fastChecks, o.checks).filter((c) => c.outcome !== 'pass');
    if (fast.length)
        return { ok: false, why: `fast checks not passing on ${o.head.slice(0, 8)}: ${fast.map((c) => `${c.name} ${c.outcome}`).join(', ')}` };
    const st = batchState(o.events);
    const id = st.posted.get(key(o.number, o.head));
    const b = id ? st.batches.get(id) : undefined;
    if (!b || !b.steps.includes('green') || !b.run?.ok || !b.prs.some((p) => p.number === o.number && p.head === o.head)) {
        return { ok: false, why: `no passing full run from a batch that held ${o.head.slice(0, 8)}` };
    }
    return { ok: true, batch: b.id };
}
/**
 * A green batch merges strictly in batch order, each PR onto exactly the commit the batch tested it on: the batch's
 * base for the first, and for each next one the merge of the PR before it, whose tree must be the batch's tree after
 * that PR. (GitHub's merge commit, `merge_method: merge`, of the head onto that tip gives the same tree the batch
 * tested.) Anything else and this PR and those after it are stale: main is no longer what was tested, so they are
 * tested again. A PR ahead of it still to merge (open at its head, its own turn pending): wait.
 */
export function mergeTurn(o) {
    const st = batchState(o.events);
    const id = st.posted.get(key(o.number, o.head));
    const b = id ? st.batches.get(id) : undefined;
    if (!b?.base)
        return { act: 'wait', why: `no green batch holds ${o.head.slice(0, 8)}` };
    const i = b.prs.findIndex((p) => p.number === o.number && p.head === o.head);
    const merged = new Map();
    const closed = new Set();
    const head = new Map();
    const ownerWait = new Set();
    for (const e of o.events) {
        const p = e.payload;
        if (e.type === 'merge.done')
            merged.set(key(Number(p.number), String(p.head)), String(p.sha));
        else if (e.type === 'pr.closed' && !p.merged)
            closed.add(Number(p.number));
        else if (e.type === 'pr.status' || e.type === 'pr.opened')
            head.set(Number(p.number), String(p.head));
        else if (e.type === 'merge.decided') {
            const k = key(Number(p.number), String(p.head));
            if (p.auto)
                ownerWait.delete(k);
            else
                ownerWait.add(k);
        }
    }
    const rest = b.prs.slice(i).filter((p) => !merged.has(key(p.number, p.head)));
    const stale = (why) => ({ act: 'stale', batch: b.id, prs: rest, why });
    let expected = b.base;
    for (let j = 0; j < i; j++) {
        const p = b.prs[j];
        const k = key(p.number, p.head);
        const m = merged.get(k);
        if (m) {
            const tree = o.treeOf(m);
            if (b.trees[j] && tree !== b.trees[j])
                return stale(`#${p.number} merged as ${m.slice(0, 8)}, whose tree is not the one the batch tested`);
            expected = m;
            continue;
        }
        if (closed.has(p.number) || (head.get(p.number) ?? p.head) !== p.head || st.posted.get(k) !== b.id)
            return stale(`#${p.number}, ahead of it in ${b.id}, left the batch without merging`);
        if (ownerWait.has(k))
            return stale(`#${p.number}, ahead of it in ${b.id}, waits for the owner`);
        return { act: 'wait', why: `#${p.number} merges first (batch order in ${b.id})` };
    }
    if (o.tip !== expected)
        return stale(`main is at ${o.tip.slice(0, 8)}, not ${expected.slice(0, 8)} as ${b.id} tested: something else landed`);
    return { act: 'merge', batch: b.id };
}
/**
 * Why a run gave no verdict on the code, or null when it did (it passed, or a tier that ran failed). Cancelled,
 * interrupted or errored runs never count as red: they would start a bisection and blame a PR for nothing.
 */
export function noVerdict(r) {
    if (r.outcome && r.outcome !== 'done')
        return `the test run was ${r.outcome === 'cancelled' ? 'cancelled' : 'stopped by an error'}`;
    if (!r.tiers.length)
        return 'the test run reported no tiers';
    const notRun = r.tiers.filter((t) => !t.ok && !t.logRef);
    if (notRun.length)
        return `tiers that never ran: ${notRun.map((t) => `${t.tier} (${t.summary.split('\n')[0].slice(0, 120)})`).join(', ')}`;
    if (!r.ok && r.tiers.every((t) => t.ok))
        return 'the test run failed with every tier passing';
    return null;
}
/** A run that gave no verdict: its batch is abandoned and batched again, nobody blamed. */
class NoVerdict extends Error {
}
/**
 * A GPU command of the batch's run timed out or was killed (src/testrun/gpu.ts): no verdict, nobody blamed, and the
 * batch's PRs are never batched again at these heads by themselves (a new head is).
 */
class GpuHeld extends Error {
}
/**
 * Whether a green batch's PRs are still merging (posted, not merged, not closed, not left to the owner, posted in
 * the last half hour). The next batch waits for them: built on the main they're about to change, it would be stale.
 */
export function mergesPending(events, now) {
    const st = batchState(events);
    const merged = new Set();
    const closed = new Set();
    const owner = new Map();
    for (const e of events) {
        const p = e.payload;
        if (e.type === 'merge.done')
            merged.add(key(Number(p.number), String(p.head)));
        else if (e.type === 'pr.closed')
            closed.add(Number(p.number));
        else if (e.type === 'merge.decided')
            owner.set(key(Number(p.number), String(p.head)), !p.auto);
    }
    for (const [k, id] of st.posted) {
        const b = st.batches.get(id);
        // A person's PR merges when they merge it, not the harness: nothing waits on it.
        const person = b?.prs.some((p) => key(p.number, p.head) === k && p.by);
        if (person || merged.has(k) || owner.get(k) || closed.has(Number(k.split('@')[0])) || !b || now - Date.parse(b.last) > 30 * 60_000)
            continue;
        return true;
    }
    return false;
}
/** After an error (a failed fetch, a test-run service that threw), wait this long before the next batch. */
const RETRY_MS = 5 * 60_000;
export class PrBatcher {
    d;
    running = null;
    recovered = false;
    notWired = false;
    nextTryAt = 0;
    stopping = false;
    /** The batch whose run is in flight: what drops it, and the signal that cancels its run. */
    current = null;
    constructor(d) {
        this.d = d;
    }
    /** Cancel the in-flight run: its batch is abandoned and batched again. */
    cancel(why) {
        const c = this.current;
        if (!c || c.controller.signal.aborted)
            return;
        c.why = why;
        c.controller.abort(new Error(why));
    }
    /** The PR watch saw this PR: a head that moved off the one in the running batch, or a closed PR, cancels its run. */
    observe(number, head, state) {
        const e = this.current?.prs.find((p) => p.number === number);
        if (!e)
            return;
        if (state !== 'open')
            this.cancel(`#${number} is ${state}`);
        else if (head !== e.head)
            this.cancel(`#${number}'s head moved to ${head.slice(0, 8)}`);
    }
    /** Main moved off the running batch's base: its result would be stale, so its run is cancelled. */
    mainMoved(tip) {
        if (this.current && tip && tip !== this.current.base)
            this.cancel(`${this.d.branch} moved to ${tip.slice(0, 8)}`);
    }
    /** The coordinator is stopping: cancel the run in flight and start nothing new. */
    stop() {
        this.stopping = true;
        this.cancel('the coordinator is stopping');
    }
    get now() {
        return this.d.now?.() ?? Date.now();
    }
    emit(type, payload) {
        this.d.log.append(type, payload, this.d.instance);
    }
    step(id, step, prs, o = {}) {
        this.emit('pr_batch.step', {
            id,
            step,
            prs: prs.map((p) => ({ issue: p.issue, number: p.number, head: p.head, ...(p.by ? { by: p.by } : {}) })),
            sha: o.sha ?? null,
            base: o.base ?? null,
            parent: o.parent ?? null,
            tier: o.tier ?? null,
            run: o.run ?? null,
            detail: (o.detail ?? '').slice(0, 2000),
            ...(o.trees ? { trees: o.trees } : {}),
        });
    }
    state() {
        return batchState(this.d.log.read(0, [...PR_BATCH_EVENTS]));
    }
    /** Put a PR ready on its fast checks in the queue at this head (once; not again after it was returned or dropped). */
    enqueue(e) {
        const st = this.state();
        const k = key(e.number, e.head);
        if (st.posted.has(k) || st.returned.has(k))
            return false;
        const last = this.d.log
            .read(0, ['pr_batch.queued', 'pr_batch.step'])
            .filter((x) => (x.type === 'pr_batch.queued' ? x.payload.number === e.number : x.payload.step === 'dropped' && x.payload.prs.some((p) => p.number === e.number)))
            .at(-1);
        if (last?.type === 'pr_batch.queued' && last.payload.head === e.head)
            return false;
        if (last?.type === 'pr_batch.step' && last.payload.prs.some((p) => p.number === e.number && p.head === e.head))
            return false;
        this.emit('pr_batch.queued', { issue: e.issue, number: e.number, head: e.head, ...(e.by ? { by: e.by } : {}) });
        return true;
    }
    /** The green batch whose full check was posted on this head, or null. */
    testedIn(number, head) {
        return this.state().posted.get(key(number, head)) ?? null;
    }
    /** Why this head went back to its author, or null. */
    returnedFor(number, head) {
        const s = this.state().returned.get(key(number, head));
        if (!s)
            return null;
        if (s.step === 'gpu_held')
            return `held from batch ${s.id}: ${GPU_NO_REPEAT}`;
        return s.step === 'conflict' ? `does not merge onto ${this.d.branch} in batch ${s.id}` : `returned from batch ${s.id}: the full run's ${s.tier ?? '?'} tier failed with it`;
    }
    /** One pass: start the next batch in the background, unless one is running (or a restart left one to settle first). */
    tick() {
        if (this.running || this.stopping || this.now < this.nextTryAt)
            return;
        if (!this.d.testRuns) {
            if (!this.notWired && this.state().queue.length) {
                this.notWired = true;
                this.emit('coordinator.error', { instance: this.d.instance, where: 'pr-batch', kind: 'config', message: 'tests.yaml land.pr_batch is on, but no test-run service is wired in, so queued PRs wait (nothing merges untested)' });
            }
            return;
        }
        if (this.recovered && !this.state().queue.length)
            return;
        if (this.recovered && this.d.mergesSettled && !this.d.mergesSettled())
            return;
        this.running = (async () => {
            try {
                if (!this.recovered) {
                    await this.recover('a restart cut it off before its run ended');
                    this.recovered = true;
                }
                if (this.state().queue.length)
                    await this.runOne();
            }
            catch (e) {
                this.nextTryAt = this.now + RETRY_MS;
                this.emit('coordinator.error', { instance: this.d.instance, where: 'pr-batch', kind: 'error', message: e.message.slice(0, 500) });
                try {
                    await this.recover(`stopped by an error: ${e.message.slice(0, 300)}`);
                }
                catch {
                    // left for the next restart's recovery
                }
            }
        })().finally(() => {
            this.running = null;
        });
    }
    /** Wait for the running batch (tests and graceful shutdown). */
    async idle() {
        while (this.running)
            await this.running;
    }
    /**
     * Settle every batch still open (a restart, or an error, cut its run off): a green one finishes posting its full
     * checks on the heads that haven't moved; any other is abandoned, and its PRs are back in the queue.
     */
    async recover(why) {
        for (const b of this.state().batches.values()) {
            if (!b.open)
                continue;
            if (b.steps.includes('green') && b.run?.ok && b.sha) {
                const st = this.state();
                const left = b.prs.filter((p) => !st.posted.has(key(p.number, p.head)));
                const live = await this.live(b.id, left);
                await this.pass(b.id, live, { id: b.run.id, sha: b.sha, kind: 'full', ok: true, tiers: b.run.tiers });
                this.step(b.id, 'resumed', live, { detail: why });
                this.finish(b.id, b.prs);
            }
            else if (b.sha && gpuRunsNotToRepeat(this.d.log.read(0, ['testrun.queued', 'testrun.started', 'testrun.finished']), b.sha).length) {
                // A GPU run of it was cut off (the coordinator or the machine stopped): never run again by itself.
                await this.holdGpu(b.id, b.prs, `${why}, during a GPU run`);
            }
            else {
                this.step(b.id, 'abandoned', b.prs, { detail: why });
                this.dropRef(b.id);
            }
        }
    }
    /** A batch whose GPU run timed out, was killed or was cut off: held, each PR told why; nobody blamed. */
    async holdGpu(id, prs, why) {
        for (const b of this.state().batches.values())
            if (b.open && b.parent === id)
                this.step(b.id, 'abandoned', b.prs, { parent: id, detail: why });
        this.step(id, 'gpu_held', prs, { detail: `${why}; ${GPU_NO_REPEAT}`.slice(0, 2000) });
        this.dropRef(id);
        for (const e of prs)
            await this.tell(e, `its full run in ${id} was not finished: ${why}. ${GPU_NO_REPEAT[0].toUpperCase()}${GPU_NO_REPEAT.slice(1)}.`);
    }
    nextId() {
        const ids = new Set(this.d.log.read(0, ['pr_batch.step']).map((e) => e.payload.id));
        return `batch-${ids.size + 1}`;
    }
    refOf(id) {
        return `refs/heads/${BRAND.cli}/${id}`;
    }
    git(...args) {
        return spawnSync('git', args, { cwd: this.d.repo, encoding: 'utf8' });
    }
    gitOk(...args) {
        const r = this.git(...args);
        if (r.status !== 0)
            throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
        return r.stdout.trim();
    }
    dropRef(id) {
        this.git('update-ref', '-d', this.refOf(id));
    }
    finish(id, prs, detail = '') {
        this.step(id, 'finished', prs, { detail });
        this.dropRef(id);
    }
    /** The entries still open at the same head; each one that isn't leaves the batch (`dropped`). */
    async live(id, entries) {
        const out = [];
        for (const e of entries) {
            const pr = await this.d.pullRequest(e.number);
            if (pr.state !== 'open')
                this.step(id, 'dropped', [e], { detail: `the PR is ${pr.state}` });
            else if (pr.headSha !== e.head)
                this.step(id, 'dropped', [e], { detail: `its head moved from ${e.head.slice(0, 8)} to ${pr.headSha.slice(0, 8)}` });
            else
                out.push({ ...e, branch: pr.head, pr });
        }
        return out;
    }
    /** Fetch the default branch and each PR's branch; the base is the default branch's tip. */
    fetch(entries) {
        const refs = [`+refs/heads/${this.d.branch}:refs/remotes/${this.d.remote}/${this.d.branch}`, ...entries.map((e) => `+refs/heads/${e.branch}:refs/remotes/${this.d.remote}/${e.branch}`)];
        this.gitOk('fetch', '-q', this.d.remote, ...refs);
        for (const e of entries)
            this.gitOk('cat-file', '-e', `${e.head}^{commit}`);
        return this.gitOk('rev-parse', `refs/remotes/${this.d.remote}/${this.d.branch}`);
    }
    /** Merge each entry, in order, onto `base` (merge commits, no worktree), under the batch's branch. */
    build(id, entries, base) {
        let commit = base;
        const trees = [];
        const included = [];
        const conflicts = [];
        const skipped = [];
        const ident = ['-c', `user.name=${this.d.identity.name}`, '-c', `user.email=${this.d.identity.email}`];
        for (const e of entries) {
            const m = this.git('merge-tree', '--write-tree', '--no-messages', commit, e.head);
            if (m.status === 0) {
                const tree = m.stdout.split('\n')[0].trim();
                commit = this.gitOk(...ident, 'commit-tree', '--no-gpg-sign', tree, '-p', commit, '-p', e.head, '-m', `${BRAND.name} ${id}: #${e.number} (${e.head.slice(0, 8)})`);
                included.push(e);
                trees.push(tree);
            }
            else if (m.status === 1) {
                // A conflict with the base itself goes back to its author; one only with a PR ahead of it waits for a later batch.
                const alone = commit === base ? m : this.git('merge-tree', '--write-tree', '--no-messages', base, e.head);
                (alone.status === 1 ? conflicts : skipped).push(e);
            }
            else
                throw new Error(`git merge-tree failed: ${(m.stderr || m.stdout).trim().slice(-300)}`);
        }
        if (included.length)
            this.gitOk('update-ref', this.refOf(id), commit);
        return { sha: commit, trees, included, conflicts, skipped };
    }
    /** One full run of `sha`, in `shards` parallel runs, as one result. Fails closed on a run of another commit or kind. */
    async test(sha, prs) {
        const shards = Math.max(1, this.d.config().shards);
        const base = { repo: this.d.repo, sha, kind: 'full', prs: prs.map((p) => p.number) };
        const reqs = shards === 1 ? [base] : Array.from({ length: shards }, (_, i) => ({ ...base, shard: { index: i + 1, total: shards } }));
        const signal = this.current?.controller.signal;
        let results;
        try {
            results = await Promise.all(reqs.map((r) => this.d.testRuns.startTestRun(r, signal ? { signal } : {})));
        }
        catch (e) {
            // WHY: held at the gate (src/testrun/gate.ts) is no verdict: the batch is abandoned, nobody blamed, batched again.
            if (e instanceof TestRunHeld)
                throw new NoVerdict(`its run was held: ${e.reason}`);
            throw e;
        }
        // No verdict (cancelled, interrupted, errored, a tier that never ran): never red, never bisected.
        if (signal?.aborted)
            throw new NoVerdict(`its run was cancelled: ${this.current?.why ?? 'cancelled'}`);
        // A GPU command stopped at its cap or killed: never red (no bisection would run it again), never batched again.
        const stopped = results.find((r) => r.gpuStopped);
        if (stopped)
            throw new GpuHeld(`a GPU command of its run ${stopped.id} timed out or was killed`);
        for (const r of results) {
            if (r.sha !== sha || r.kind !== 'full')
                throw new NoVerdict(`the test run reported ${r.kind} on ${r.sha.slice(0, 8)}, not full on ${sha.slice(0, 8)}`);
            const why = noVerdict(r);
            if (why)
                throw new NoVerdict(why);
        }
        const tiers = new Map();
        for (const r of results) {
            for (const t of r.tiers) {
                const prior = tiers.get(t.tier);
                tiers.set(t.tier, prior
                    ? { tier: t.tier, ok: prior.ok && t.ok, durationMs: Math.max(prior.durationMs, t.durationMs), summary: `${prior.summary}; ${t.summary}`.slice(0, 1000), logRef: `${prior.logRef} ${t.logRef}`.slice(0, 1000) }
                    : t);
            }
        }
        const all = [...tiers.values()];
        const ok = results.every((r) => r.ok) && all.length > 0 && all.every((t) => t.ok);
        return { id: results.map((r) => r.id).join('+'), sha, kind: 'full', ok, tiers: all };
    }
    runOf(r) {
        return { id: r.id, ok: r.ok, tiers: r.tiers.map((t) => ({ tier: t.tier, ok: t.ok, durationMs: Math.max(0, t.durationMs), summary: t.summary.slice(0, 1000), logRef: t.logRef.slice(0, 500) })) };
    }
    /** Build, test and settle one batch from the head of the queue. */
    async runOne() {
        const cfg = this.d.config();
        const st = this.state();
        const size = batchSize(passRate(st), cfg.max);
        if (st.baseRed && st.baseRed === this.fetch([])) {
            // The base fails the full run on its own: hold the queue until the default branch moves.
            this.nextTryAt = this.now + 60_000;
            return;
        }
        const id = this.nextId();
        const { entries, alone } = await this.select(id, st.queue, size);
        if (!entries.length)
            return this.finish(id, [], 'every PR in it left the queue');
        const base = this.fetch(entries);
        this.current = { id, prs: entries, base, controller: new AbortController(), why: null };
        try {
            await this.runBatch(id, entries, base, size, alone);
        }
        catch (e) {
            if (e instanceof GpuHeld)
                return await this.holdGpu(id, entries, e.message);
            if (!(e instanceof NoVerdict))
                throw e;
            await this.abandon(id, entries, e.message);
        }
        finally {
            this.current = null;
        }
    }
    /**
     * A run with no verdict: the batch (and a bisection step in flight) is abandoned, PRs that left are dropped, and the
     * rest are batched again. Nobody is blamed. Not cancelled by us (an errored run, a setup step that failed): wait a
     * while first, and say why.
     */
    async abandon(id, entries, why) {
        await this.live(id, entries);
        for (const b of this.state().batches.values())
            if (b.open && b.parent === id)
                this.step(b.id, 'abandoned', b.prs, { parent: id, detail: why });
        this.step(id, 'abandoned', entries, { detail: `${why}; batched again, nobody blamed` });
        this.dropRef(id);
        if (!this.current?.controller.signal.aborted) {
            this.nextTryAt = this.now + RETRY_MS;
            this.emit('coordinator.error', { instance: this.d.instance, where: `pr-batch ${id}`, kind: 'no_verdict', message: why.slice(0, 500) });
        }
    }
    async runBatch(id, entries, base, size, alone) {
        const cfg = this.d.config();
        const b = this.build(id, entries, base);
        for (const e of b.conflicts) {
            this.step(id, 'conflict', [e], { base, detail: `does not merge onto ${this.d.branch} at ${base.slice(0, 8)}` });
            await this.tell(e, `does not merge cleanly onto ${this.d.branch} at \`${base.slice(0, 8)}\`, so it can't be batched. It is batched again once its head changes.`);
        }
        if (!b.included.length)
            return this.finish(id, [], 'no PR merged onto the base');
        const skipped = b.skipped.length ? ` (${b.skipped.map((e) => `#${e.number}`).join(', ')} conflict with a PR ahead of them: next batch)` : '';
        this.step(id, 'built', b.included, { sha: b.sha, base, trees: b.trees, detail: alone ? `alone: ${alone}` : `batch of ${b.included.length} (size ${size}, max ${cfg.max})${skipped}` });
        const r = await this.test(b.sha, b.included);
        this.step(id, r.ok ? 'green' : 'red', b.included, { sha: b.sha, base, run: this.runOf(r), tier: failingTier(r)?.tier ?? null });
        const live = await this.live(id, b.included);
        if (live.length !== b.included.length) {
            if (live.length)
                this.step(id, 'requeued', live, { detail: 'a PR left the batch after its run, so the rest is tested again without it' });
            return this.finish(id, b.included);
        }
        if (r.ok) {
            await this.pass(id, live, r);
            return this.finish(id, b.included);
        }
        if (live.length === 1)
            await this.bisectOne(id, live[0], base, r);
        else
            await this.bisect(id, live, base, r);
        this.finish(id, b.included);
    }
    /**
     * The next batch from the queue, in order: up to `size` PRs the policy would auto-merge. A PR it would leave to the
     * owner never shares a batch: at the head of the queue it is a batch of one; further back it keeps its place.
     */
    async select(id, queue, size) {
        const out = [];
        for (const q of queue) {
            if (out.length >= size)
                break;
            const [l] = await this.live(id, [q]);
            if (!l)
                continue;
            const why = this.d.waitsForOwner?.(l, l.pr) ?? null;
            if (why) {
                if (!out.length)
                    return { entries: [l], alone: why };
                continue;
            }
            out.push(l);
        }
        return { entries: out, alone: null };
    }
    /** These PRs' green batch no longer matches main: tested again in a later batch. */
    stale(id, prs, why) {
        if (prs.length)
            this.step(id, 'stale', prs, { detail: why });
    }
    /** Post the passing full check on each head (once), then hand each PR to the merge policy. */
    async pass(id, entries, r) {
        const names = this.d.testRuns.checkNames();
        for (const e of entries) {
            if (this.state().posted.has(key(e.number, e.head)))
                continue;
            await this.d.testRuns.postChecks(e.head, r, names);
            this.step(id, 'checks_posted', [e], { sha: r.sha });
            this.d.tested(e);
        }
    }
    /**
     * A red batch of one: its PR is the culprit, unless the base alone fails too (then nothing is blamed and the
     * queue waits for the default branch to move).
     */
    async bisectOne(id, e, base, r) {
        if (await this.baseFails(id, base, [e]))
            return;
        await this.giveBack(id, e, r, base, []);
    }
    async baseFails(id, base, prs) {
        const r = await this.test(base, []);
        if (r.ok)
            return false;
        const t = failingTier(r);
        this.step(id, 'error', [], { base, sha: base, tier: BASE_TIER, run: this.runOf(r), detail: `${this.d.branch} at ${base.slice(0, 8)} fails the full run with no PR in it (${t?.tier ?? '?'}: ${t?.summary ?? ''}); nothing blamed` });
        this.step(id, 'requeued', prs, { detail: 'the base is red' });
        return true;
    }
    /**
     * A red batch: binary search over its prefixes (each tested on the same base) for the first one that fails. The PR
     * that turns it red is the culprit; the longest green prefix before it passed in a batch that held exactly those
     * heads, so it merges; the PRs after the culprit go back in the queue to be tested again.
     */
    async bisect(root, entries, base, rootRun) {
        let lo = 0;
        let hi = entries.length;
        let failing = rootRun;
        let greenPrefix = null;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            const id = this.nextId();
            const prefix = entries.slice(0, mid);
            const b = this.build(id, prefix, base);
            if (b.included.length !== prefix.length) {
                this.step(root, 'error', [], { detail: `bisecting: the prefix of ${prefix.length} no longer merges onto ${base.slice(0, 8)}` });
                this.step(root, 'requeued', entries, { detail: 'bisection stopped' });
                return;
            }
            this.step(id, 'built', prefix, { sha: b.sha, base, parent: root, trees: b.trees, detail: `bisecting ${root}: the first ${mid} of ${entries.length}` });
            const r = await this.test(b.sha, prefix);
            this.step(id, r.ok ? 'green' : 'red', prefix, { sha: b.sha, base, parent: root, run: this.runOf(r), tier: failingTier(r)?.tier ?? null });
            this.finish(id, prefix);
            if (r.ok) {
                lo = mid;
                greenPrefix = { id, run: r };
            }
            else {
                hi = mid;
                failing = r;
            }
        }
        const live = await this.live(root, entries);
        if (live.length !== entries.length) {
            if (live.length)
                this.step(root, 'requeued', live, { detail: 'a PR left the batch while it was bisected, so the rest is tested again without it' });
            return;
        }
        if (hi === 1 && (await this.baseFails(root, base, entries)))
            return;
        if (greenPrefix)
            await this.pass(greenPrefix.id, entries.slice(0, lo), greenPrefix.run);
        await this.giveBack(root, entries[hi - 1], failing, base, entries.slice(0, hi - 1));
        const rest = entries.slice(hi);
        if (rest.length)
            this.step(root, 'requeued', rest, { detail: `after the culprit #${entries[hi - 1].number}: tested again in the next batch` });
    }
    /** The culprit goes back to its author (the issue's owner), with the failing tier; its head leaves the queue. */
    async giveBack(id, e, r, base, ahead) {
        const t = failingTier(r);
        this.step(id, 'culprit', [e], { base, tier: t?.tier ?? null, run: this.runOf(r), detail: t ? `${t.tier}: ${t.summary}` : 'the full run failed' });
        const on = `${this.d.branch} at \`${base.slice(0, 8)}\`${ahead.length ? ` with ${ahead.map((a) => `#${a.number}`).join(', ')}` : ''}`;
        await this.tell(e, `returned from ${id}: the full run's \`${t?.tier ?? '?'}\` tier failed with this PR on top of ${on}, and passes without it.${t ? `\n\n${t.summary.slice(0, 800)}${t.logRef ? `\n\nLog: ${t.logRef}` : ''}` : ''}\n\nIt is batched again once a new head passes its fast checks.`, ['ci-failing']);
    }
    async tell(e, text, labels = []) {
        try {
            await this.d.removeLabel(e.number, 'merge-ready');
            if (labels.length)
                await this.d.addLabels(e.number, labels);
            await this.d.comment(e.number, `[${BRAND.cli}] @${e.by ?? this.d.ownerOf(e.issue)} ${text}`);
        }
        catch (err) {
            this.emit('coordinator.error', { instance: this.d.instance, where: `pr-batch #${e.number}`, kind: 'error', message: err.message.slice(0, 500) });
        }
    }
}
/** The first failing tier of a run (a run marked failed with every tier passing reports itself). */
export function failingTier(r) {
    if (r.ok)
        return null;
    return r.tiers.find((t) => !t.ok) ?? { tier: '(run)', ok: false, durationMs: 0, summary: 'the run failed with no failing tier reported', logRef: r.id };
}
//# sourceMappingURL=pr-batch.js.map