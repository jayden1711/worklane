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
import { spawnSync } from 'node:child_process';
import { BRAND } from '../brand.js';
import type { CommitCheck, PullRequest } from '../backlog/types.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { requiredOutcomes } from '../pr-watch.js';

// ---------------------------------------------------------------- the test-run contract

// What src/testrun/ exposes (the test-run spec's interface between the tracks), restated here so this module builds
// and is tested with a fake until that one lands; the coordinator is handed the real one as `testRuns`.
export interface TestRunRequest {
  repo: string;
  sha: string;
  kind: 'fast' | 'full';
  prs: number[];
  changedFiles?: string[];
  shard?: { index: number; total: number };
}
export interface TierResult {
  tier: string;
  ok: boolean;
  durationMs: number;
  summary: string;
  logRef: string;
}
export interface TestRunResult {
  id: string;
  sha: string;
  kind: 'fast' | 'full';
  ok: boolean;
  tiers: TierResult[];
}
export interface TestRuns {
  /** Queues, waits for a slot and the lock, runs, wipes, records events. */
  startTestRun(req: TestRunRequest): Promise<TestRunResult>;
  /** GitHub check runs via the App, one per tier, on `sha`. */
  postChecks(sha: string, result: TestRunResult, checkNames: string[]): Promise<void>;
}

export interface PrBatchConfig {
  enabled: boolean;
  max: number;
  shards: number;
  fast_checks: string[];
  full_checks: string[];
}

// ---------------------------------------------------------------- state, from the log

export interface BatchEntry {
  issue: number;
  number: number;
  head: string;
}
type Step = EventPayload<'pr_batch.step'>;
type StepName = Step['step'];

export interface BatchView {
  id: string;
  parent: string | null;
  prs: BatchEntry[];
  sha: string | null;
  base: string | null;
  steps: StepName[];
  /** The batch's own full run, when it ended. */
  run: Step['run'];
  /** Built and not yet finished or abandoned. */
  open: boolean;
  at: string;
  last: string;
}

export interface BatchState {
  /** PRs waiting for a batch, in the order they became ready. */
  queue: BatchEntry[];
  batches: Map<string, BatchView>;
  /** `number@head` -> the green batch whose full check was posted on that head. */
  posted: Map<string, string>;
  /** `number@head` -> why it went back to its author (a culprit, or it doesn't merge onto the base). */
  returned: Map<string, Step>;
  /** The base the latest base-red check found failing on its own, if any. */
  baseRed: string | null;
}

const key = (number: number, head: string) => `${number}@${head}`;
export const PR_BATCH_EVENTS = ['pr_batch.queued', 'pr_batch.step', 'pr.closed'] as const;

/** The batches and the queue, folded from the log (`pr_batch.*` and `pr.closed`; other events are ignored). */
export function batchState(events: StoredEvent[]): BatchState {
  const latest = new Map<number, { entry: BatchEntry; order: number }>();
  const batches = new Map<string, BatchView>();
  const posted = new Map<string, string>();
  const returned = new Map<string, Step>();
  const gone = new Set<string>();
  let baseRed: string | null = null;
  for (const e of events) {
    if (e.type === 'pr_batch.queued') {
      const p = e.payload as EventPayload<'pr_batch.queued'>;
      const prior = latest.get(p.number);
      if (!prior || prior.entry.head !== p.head) latest.set(p.number, { entry: { issue: p.issue, number: p.number, head: p.head }, order: e.id });
    } else if (e.type === 'pr.closed') {
      latest.delete((e.payload as EventPayload<'pr.closed'>).number);
    } else if (e.type === 'pr_batch.step') {
      const s = e.payload as Step;
      let b = batches.get(s.id);
      if (!b) {
        b = { id: s.id, parent: s.parent, prs: [], sha: null, base: null, steps: [], run: null, open: false, at: e.ts, last: e.ts };
        batches.set(s.id, b);
      }
      b.steps.push(s.step);
      b.last = e.ts;
      if (s.step === 'built') Object.assign(b, { prs: s.prs, sha: s.sha, base: s.base, open: true });
      if (s.step === 'green' || s.step === 'red') b.run = s.run;
      if (s.step === 'finished' || s.step === 'abandoned') b.open = false;
      for (const p of s.prs) {
        if (s.step === 'checks_posted') posted.set(key(p.number, p.head), s.id);
        if (s.step === 'culprit' || s.step === 'conflict') returned.set(key(p.number, p.head), s);
        if (s.step === 'dropped') gone.add(key(p.number, p.head));
      }
      if (s.step === 'error' && s.tier === BASE_TIER) baseRed = s.base;
      if (s.step === 'green' && s.base === baseRed) baseRed = null;
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
export function passRate(st: Pick<BatchState, 'posted' | 'returned'>): number {
  const passed = Math.min(st.posted.size, PASS_RATE_WINDOW);
  const failed = Math.min([...st.returned.values()].filter((s) => s.step === 'culprit').length, PASS_RATE_WINDOW);
  return (passed + PRIOR_PASS_RATE * PRIOR_WEIGHT) / (passed + failed + PRIOR_WEIGHT);
}

/**
 * Full runs per PR for a batch of k at pass rate p: the batch's one run shared by k PRs, plus, for each PR expected to
 * fail (1 - p of them), a bisection of log2(k) runs and one run to test the rest again. A batch of one is one run.
 */
export function runsPerPr(k: number, p: number): number {
  if (k <= 1) return 1;
  return 1 / k + (1 - p) * (Math.log2(k) + 1);
}

/** The batch size with the fewest full runs per PR at this pass rate, from 1 to `max` (about ln 2 / (1 - p)). */
export function batchSize(p: number, max: number): number {
  let best = 1;
  for (let k = 2; k <= max; k++) if (runsPerPr(k, p) < runsPerPr(best, p)) best = k;
  return best;
}

// ---------------------------------------------------------------- the merge guard

/**
 * May this PR merge at this head? Only with every fast check passing on the head and a passing full run from a batch
 * that held exactly this head, whose full check was posted on it. Fails closed (no fast checks configured: no).
 */
export function mayMerge(o: { events: StoredEvent[]; number: number; head: string; checks: CommitCheck[]; fastChecks: string[] }): { ok: true; batch: string } | { ok: false; why: string } {
  if (!o.fastChecks.length) return { ok: false, why: 'no fast checks are configured (tests.yaml land.pr_batch.fast_checks)' };
  const fast = requiredOutcomes(o.fastChecks, o.checks).filter((c) => c.outcome !== 'pass');
  if (fast.length) return { ok: false, why: `fast checks not passing on ${o.head.slice(0, 8)}: ${fast.map((c) => `${c.name} ${c.outcome}`).join(', ')}` };
  const st = batchState(o.events);
  const id = st.posted.get(key(o.number, o.head));
  const b = id ? st.batches.get(id) : undefined;
  if (!b || !b.steps.includes('green') || !b.run?.ok || !b.prs.some((p) => p.number === o.number && p.head === o.head)) {
    return { ok: false, why: `no passing full run from a batch that held ${o.head.slice(0, 8)}` };
  }
  return { ok: true, batch: b.id };
}

// ---------------------------------------------------------------- the batcher

export interface PrBatchDeps {
  log: EventLog;
  instance: string;
  /** The coordinator's clone: batch commits are made here (never pushed) and the test runs read them from it. */
  repo: string;
  remote: string;
  branch: string;
  identity: { name: string; email: string };
  config: () => PrBatchConfig;
  /** The test-run service (src/testrun/); null: batching can't run, so nothing merges (fail closed). */
  testRuns: TestRuns | null;
  pullRequest(n: number): Promise<PullRequest>;
  comment(n: number, body: string): Promise<void>;
  addLabels(n: number, labels: string[]): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
  ownerOf(issue: number): string;
  /** A PR whose batch passed and whose full check is posted on its head: the merge policy decides it next. */
  tested(e: BatchEntry): void;
  now?: () => number;
}

interface Live extends BatchEntry {
  branch: string;
}

/** After an error (a failed fetch, a test-run service that threw), wait this long before the next batch. */
const RETRY_MS = 5 * 60_000;

export class PrBatcher {
  private running: Promise<void> | null = null;
  private recovered = false;
  private notWired = false;
  private nextTryAt = 0;

  constructor(private readonly d: PrBatchDeps) {}

  private get now() {
    return this.d.now?.() ?? Date.now();
  }

  private emit<T extends 'pr_batch.queued' | 'pr_batch.step' | 'coordinator.error'>(type: T, payload: EventPayload<T>) {
    this.d.log.append(type, payload, this.d.instance);
  }

  private step(id: string, step: StepName, prs: BatchEntry[], o: Partial<Omit<Step, 'id' | 'step' | 'prs'>> = {}) {
    this.emit('pr_batch.step', {
      id,
      step,
      prs: prs.map((p) => ({ issue: p.issue, number: p.number, head: p.head })),
      sha: o.sha ?? null,
      base: o.base ?? null,
      parent: o.parent ?? null,
      tier: o.tier ?? null,
      run: o.run ?? null,
      detail: (o.detail ?? '').slice(0, 2000),
    });
  }

  state(): BatchState {
    return batchState(this.d.log.read(0, [...PR_BATCH_EVENTS]));
  }

  /** Put a PR ready on its fast checks in the queue at this head (once; not again after it was returned or dropped). */
  enqueue(e: BatchEntry): boolean {
    const st = this.state();
    const k = key(e.number, e.head);
    if (st.posted.has(k) || st.returned.has(k)) return false;
    const last = this.d.log
      .read(0, ['pr_batch.queued', 'pr_batch.step'])
      .filter((x) => (x.type === 'pr_batch.queued' ? (x.payload as EventPayload<'pr_batch.queued'>).number === e.number : (x.payload as Step).step === 'dropped' && (x.payload as Step).prs.some((p) => p.number === e.number)))
      .at(-1);
    if (last?.type === 'pr_batch.queued' && (last.payload as EventPayload<'pr_batch.queued'>).head === e.head) return false;
    if (last?.type === 'pr_batch.step' && (last.payload as Step).prs.some((p) => p.number === e.number && p.head === e.head)) return false;
    this.emit('pr_batch.queued', { issue: e.issue, number: e.number, head: e.head });
    return true;
  }

  /** The green batch whose full check was posted on this head, or null. */
  testedIn(number: number, head: string): string | null {
    return this.state().posted.get(key(number, head)) ?? null;
  }

  /** Why this head went back to its author, or null. */
  returnedFor(number: number, head: string): string | null {
    const s = this.state().returned.get(key(number, head));
    if (!s) return null;
    return s.step === 'conflict' ? `does not merge onto ${this.d.branch} in batch ${s.id}` : `returned from batch ${s.id}: the full run's ${s.tier ?? '?'} tier failed with it`;
  }

  /** One pass: start the next batch in the background, unless one is running (or a restart left one to settle first). */
  tick(): void {
    if (this.running || this.now < this.nextTryAt) return;
    if (!this.d.testRuns) {
      if (!this.notWired && this.state().queue.length) {
        this.notWired = true;
        this.emit('coordinator.error', { instance: this.d.instance, where: 'pr-batch', kind: 'config', message: 'tests.yaml land.pr_batch is on, but no test-run service is wired in, so queued PRs wait (nothing merges untested)' });
      }
      return;
    }
    if (this.recovered && !this.state().queue.length) return;
    this.running = (async () => {
      try {
        if (!this.recovered) {
          await this.recover('a restart cut it off before its run ended');
          this.recovered = true;
        }
        if (this.state().queue.length) await this.runOne();
      } catch (e) {
        this.nextTryAt = this.now + RETRY_MS;
        this.emit('coordinator.error', { instance: this.d.instance, where: 'pr-batch', kind: 'error', message: (e as Error).message.slice(0, 500) });
        try {
          await this.recover(`stopped by an error: ${(e as Error).message.slice(0, 300)}`);
        } catch {
          // left for the next restart's recovery
        }
      }
    })().finally(() => {
      this.running = null;
    });
  }

  /** Wait for the running batch (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Settle every batch still open (a restart, or an error, cut its run off): a green one finishes posting its full
   * checks on the heads that haven't moved; any other is abandoned, and its PRs are back in the queue.
   */
  async recover(why: string): Promise<void> {
    for (const b of this.state().batches.values()) {
      if (!b.open) continue;
      if (b.steps.includes('green') && b.run?.ok && b.sha) {
        const st = this.state();
        const left = b.prs.filter((p) => !st.posted.has(key(p.number, p.head)));
        const live = await this.live(b.id, left);
        await this.pass(b.id, live, { id: b.run.id, sha: b.sha, kind: 'full', ok: true, tiers: b.run.tiers });
        this.step(b.id, 'resumed', live, { detail: why });
        this.finish(b.id, b.prs);
      } else {
        this.step(b.id, 'abandoned', b.prs, { detail: why });
        this.dropRef(b.id);
      }
    }
  }

  private nextId(): string {
    const ids = new Set(this.d.log.read(0, ['pr_batch.step']).map((e) => (e.payload as Step).id));
    return `batch-${ids.size + 1}`;
  }

  private refOf(id: string) {
    return `refs/heads/${BRAND.cli}/${id}`;
  }

  private git(...args: string[]) {
    return spawnSync('git', args, { cwd: this.d.repo, encoding: 'utf8' });
  }

  private gitOk(...args: string[]): string {
    const r = this.git(...args);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
    return r.stdout.trim();
  }

  private dropRef(id: string) {
    this.git('update-ref', '-d', this.refOf(id));
  }

  private finish(id: string, prs: BatchEntry[], detail = '') {
    this.step(id, 'finished', prs, { detail });
    this.dropRef(id);
  }

  /** The entries still open at the same head; each one that isn't leaves the batch (`dropped`). */
  private async live(id: string, entries: BatchEntry[]): Promise<Live[]> {
    const out: Live[] = [];
    for (const e of entries) {
      const pr = await this.d.pullRequest(e.number);
      if (pr.state !== 'open') this.step(id, 'dropped', [e], { detail: `the PR is ${pr.state}` });
      else if (pr.headSha !== e.head) this.step(id, 'dropped', [e], { detail: `its head moved from ${e.head.slice(0, 8)} to ${pr.headSha.slice(0, 8)}` });
      else out.push({ ...e, branch: pr.head });
    }
    return out;
  }

  /** Fetch the default branch and each PR's branch; the base is the default branch's tip. */
  private fetch(entries: Live[]): string {
    const refs = [`+refs/heads/${this.d.branch}:refs/remotes/${this.d.remote}/${this.d.branch}`, ...entries.map((e) => `+refs/heads/${e.branch}:refs/remotes/${this.d.remote}/${e.branch}`)];
    this.gitOk('fetch', '-q', this.d.remote, ...refs);
    for (const e of entries) this.gitOk('cat-file', '-e', `${e.head}^{commit}`);
    return this.gitOk('rev-parse', `refs/remotes/${this.d.remote}/${this.d.branch}`);
  }

  /** Merge each entry, in order, onto `base` (merge commits, no worktree), under the batch's branch. */
  private build(id: string, entries: Live[], base: string): { sha: string; included: Live[]; conflicts: Live[]; skipped: Live[] } {
    let commit = base;
    const included: Live[] = [];
    const conflicts: Live[] = [];
    const skipped: Live[] = [];
    const ident = ['-c', `user.name=${this.d.identity.name}`, '-c', `user.email=${this.d.identity.email}`];
    for (const e of entries) {
      const m = this.git('merge-tree', '--write-tree', '--no-messages', commit, e.head);
      if (m.status === 0) {
        const tree = m.stdout.split('\n')[0]!.trim();
        commit = this.gitOk(...ident, 'commit-tree', '--no-gpg-sign', tree, '-p', commit, '-p', e.head, '-m', `${BRAND.name} ${id}: #${e.number} (${e.head.slice(0, 8)})`);
        included.push(e);
      } else if (m.status === 1) {
        // A conflict with the base itself goes back to its author; one only with a PR ahead of it waits for a later batch.
        const alone = commit === base ? m : this.git('merge-tree', '--write-tree', '--no-messages', base, e.head);
        (alone.status === 1 ? conflicts : skipped).push(e);
      } else throw new Error(`git merge-tree failed: ${(m.stderr || m.stdout).trim().slice(-300)}`);
    }
    if (included.length) this.gitOk('update-ref', this.refOf(id), commit);
    return { sha: commit, included, conflicts, skipped };
  }

  /** One full run of `sha`, in `shards` parallel runs, as one result. Fails closed on a run of another commit or kind. */
  private async test(sha: string, prs: BatchEntry[]): Promise<TestRunResult> {
    const shards = Math.max(1, this.d.config().shards);
    const base = { repo: this.d.repo, sha, kind: 'full' as const, prs: prs.map((p) => p.number) };
    const reqs: TestRunRequest[] = shards === 1 ? [base] : Array.from({ length: shards }, (_, index) => ({ ...base, shard: { index, total: shards } }));
    const results = await Promise.all(reqs.map((r) => this.d.testRuns!.startTestRun(r)));
    const tiers = new Map<string, TierResult>();
    for (const r of results) {
      if (r.sha !== sha || r.kind !== 'full') tiers.set('(run)', { tier: '(run)', ok: false, durationMs: 0, summary: `the test run reported ${r.kind} on ${r.sha.slice(0, 8)}, not full on ${sha.slice(0, 8)}`, logRef: r.id });
      for (const t of r.tiers) {
        const prior = tiers.get(t.tier);
        tiers.set(
          t.tier,
          prior
            ? { tier: t.tier, ok: prior.ok && t.ok, durationMs: Math.max(prior.durationMs, t.durationMs), summary: `${prior.summary}; ${t.summary}`.slice(0, 1000), logRef: `${prior.logRef} ${t.logRef}`.slice(0, 1000) }
            : t,
        );
      }
    }
    const all = [...tiers.values()];
    const ok = results.every((r) => r.ok) && all.length > 0 && all.every((t) => t.ok);
    return { id: results.map((r) => r.id).join('+'), sha, kind: 'full', ok, tiers: all };
  }

  private runOf(r: TestRunResult): NonNullable<Step['run']> {
    return { id: r.id, ok: r.ok, tiers: r.tiers.map((t) => ({ tier: t.tier, ok: t.ok, durationMs: Math.max(0, t.durationMs), summary: t.summary.slice(0, 1000), logRef: t.logRef.slice(0, 500) })) };
  }

  /** Build, test and settle one batch from the head of the queue. */
  private async runOne(): Promise<void> {
    const cfg = this.d.config();
    const st = this.state();
    const size = batchSize(passRate(st), cfg.max);
    if (st.baseRed && st.baseRed === this.fetch([])) {
      // The base fails the full run on its own: hold the queue until the default branch moves.
      this.nextTryAt = this.now + 60_000;
      return;
    }
    const id = this.nextId();
    const entries = await this.live(id, st.queue.slice(0, size));
    if (!entries.length) return this.finish(id, [], 'every PR in it left the queue');
    const base = this.fetch(entries);
    const b = this.build(id, entries, base);
    for (const e of b.conflicts) {
      this.step(id, 'conflict', [e], { base, detail: `does not merge onto ${this.d.branch} at ${base.slice(0, 8)}` });
      await this.tell(e, `does not merge cleanly onto ${this.d.branch} at \`${base.slice(0, 8)}\`, so it can't be batched. It is batched again once its head changes.`);
    }
    if (!b.included.length) return this.finish(id, [], 'no PR merged onto the base');
    const skipped = b.skipped.length ? ` (${b.skipped.map((e) => `#${e.number}`).join(', ')} conflict with a PR ahead of them: next batch)` : '';
    this.step(id, 'built', b.included, { sha: b.sha, base, detail: `batch of ${b.included.length} (size ${size}, max ${cfg.max})${skipped}` });
    const r = await this.test(b.sha, b.included);
    this.step(id, r.ok ? 'green' : 'red', b.included, { sha: b.sha, base, run: this.runOf(r), tier: failingTier(r)?.tier ?? null });
    const live = await this.live(id, b.included);
    if (live.length !== b.included.length) {
      if (live.length) this.step(id, 'requeued', live, { detail: 'a PR left the batch after its run, so the rest is tested again without it' });
      return this.finish(id, b.included);
    }
    if (r.ok) {
      await this.pass(id, live, r);
      return this.finish(id, b.included);
    }
    if (live.length === 1) await this.bisectOne(id, live[0]!, base, r);
    else await this.bisect(id, live, base, r);
    this.finish(id, b.included);
  }

  /** Post the passing full check on each head (once), then hand each PR to the merge policy. */
  private async pass(id: string, entries: BatchEntry[], r: TestRunResult) {
    const names = this.d.config().full_checks;
    for (const e of entries) {
      if (this.state().posted.has(key(e.number, e.head))) continue;
      await this.d.testRuns!.postChecks(e.head, r, names);
      this.step(id, 'checks_posted', [e], { sha: r.sha });
      this.d.tested(e);
    }
  }

  /**
   * A red batch of one: its PR is the culprit, unless the base alone fails too (then nothing is blamed and the
   * queue waits for the default branch to move).
   */
  private async bisectOne(id: string, e: BatchEntry, base: string, r: TestRunResult) {
    if (await this.baseFails(id, base, [e])) return;
    await this.giveBack(id, e, r, base, []);
  }

  private async baseFails(id: string, base: string, prs: BatchEntry[]): Promise<boolean> {
    const r = await this.test(base, []);
    if (r.ok) return false;
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
  private async bisect(root: string, entries: Live[], base: string, rootRun: TestRunResult) {
    let lo = 0;
    let hi = entries.length;
    let failing = rootRun;
    let greenPrefix: { id: string; run: TestRunResult } | null = null;
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
      this.step(id, 'built', prefix, { sha: b.sha, base, parent: root, detail: `bisecting ${root}: the first ${mid} of ${entries.length}` });
      const r = await this.test(b.sha, prefix);
      this.step(id, r.ok ? 'green' : 'red', prefix, { sha: b.sha, base, parent: root, run: this.runOf(r), tier: failingTier(r)?.tier ?? null });
      this.finish(id, prefix);
      if (r.ok) {
        lo = mid;
        greenPrefix = { id, run: r };
      } else {
        hi = mid;
        failing = r;
      }
    }
    const live = await this.live(root, entries);
    if (live.length !== entries.length) {
      if (live.length) this.step(root, 'requeued', live, { detail: 'a PR left the batch while it was bisected, so the rest is tested again without it' });
      return;
    }
    if (hi === 1 && (await this.baseFails(root, base, entries))) return;
    if (greenPrefix) await this.pass(greenPrefix.id, entries.slice(0, lo), greenPrefix.run);
    await this.giveBack(root, entries[hi - 1]!, failing, base, entries.slice(0, hi - 1));
    const rest = entries.slice(hi);
    if (rest.length) this.step(root, 'requeued', rest, { detail: `after the culprit #${entries[hi - 1]!.number}: tested again in the next batch` });
  }

  /** The culprit goes back to its author (the issue's owner), with the failing tier; its head leaves the queue. */
  private async giveBack(id: string, e: BatchEntry, r: TestRunResult, base: string, ahead: BatchEntry[]) {
    const t = failingTier(r);
    this.step(id, 'culprit', [e], { base, tier: t?.tier ?? null, run: this.runOf(r), detail: t ? `${t.tier}: ${t.summary}` : 'the full run failed' });
    const on = `${this.d.branch} at \`${base.slice(0, 8)}\`${ahead.length ? ` with ${ahead.map((a) => `#${a.number}`).join(', ')}` : ''}`;
    await this.tell(
      e,
      `returned from ${id}: the full run's \`${t?.tier ?? '?'}\` tier failed with this PR on top of ${on}, and passes without it.${t ? `\n\n${t.summary.slice(0, 800)}${t.logRef ? `\n\nLog: ${t.logRef}` : ''}` : ''}\n\nIt is batched again once a new head passes its fast checks.`,
      ['ci-failing'],
    );
  }

  private async tell(e: BatchEntry, text: string, labels: string[] = []) {
    try {
      await this.d.removeLabel(e.number, 'merge-ready');
      if (labels.length) await this.d.addLabels(e.number, labels);
      await this.d.comment(e.number, `[${BRAND.cli}] @${this.d.ownerOf(e.issue)} ${text}`);
    } catch (err) {
      this.emit('coordinator.error', { instance: this.d.instance, where: `pr-batch #${e.number}`, kind: 'error', message: (err as Error).message.slice(0, 500) });
    }
  }
}

/** The first failing tier of a run (a run marked failed with every tier passing reports itself). */
export function failingTier(r: TestRunResult): TierResult | null {
  if (r.ok) return null;
  return r.tiers.find((t) => !t.ok) ?? { tier: '(run)', ok: false, durationMs: 0, summary: 'the run failed with no failing tier reported', logRef: r.id };
}
