// The coordinator's fast test runs (src/testrun/): one tick step that runs tests.yaml test_run's fast tiers on every
// open PR's head, the harness's, the owner's and bots' alike, and posts them as checks. A PR whose head moves gets a
// new run, and the superseded one is cancelled. Full tiers run per batch of approved PRs (PR mode, Track PB); a bot's
// PR gets those only once the owner approved it (fullRunAllowed).
import { execFileSync } from 'node:child_process';
import { BRAND } from '../brand.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import type { RunHost } from '../testrun/host.js';
import { ChecksPermissionMissing, type TestRunRequest, type TestRunResult } from '../testrun/index.js';

/** A PR as the test runs need it. */
export interface OpenPr {
  number: number;
  headSha: string;
  base: string;
  author: string;
  bot: boolean;
}

type Fetch = typeof fetch;

/** Open PRs, one listing (at most 100: the newest first). */
export async function listOpenPrs(repo: string, token: () => Promise<string>, f: Fetch = fetch, api = 'https://api.github.com'): Promise<OpenPr[]> {
  const res = await f(`${api}/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=desc`, {
    headers: { authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} listing open PRs`);
  const prs = (await res.json()) as { number: number; head: { sha: string }; base: { ref: string }; user?: { login?: string; type?: string } | null }[];
  return prs.map((p) => ({ number: p.number, headSha: p.head.sha, base: p.base.ref, author: p.user?.login ?? '', bot: p.user?.type === 'Bot' || /\[bot\]$/.test(p.user?.login ?? '') }));
}

/** Whether a PR may have its full tiers run (a batch): a bot's only once the owner approved it. */
export function fullRunAllowed(pr: Pick<OpenPr, 'bot'>, ownerApproved: boolean): boolean {
  return !pr.bot || ownerApproved;
}

export interface PrTestRunDeps {
  log: EventLog;
  actor: string;
  /** The coordinator's clone and its remote. */
  repo: string;
  remote: string;
  host: RunHost;
  listPrs: () => Promise<OpenPr[]>;
  start: (req: TestRunRequest, o: { signal: AbortSignal }) => Promise<TestRunResult>;
  post: (sha: string, result: TestRunResult) => Promise<void>;
  /** How often open PRs are listed (one API call; default 90 s, within the shared rate limit). */
  pollMs?: number;
  /** At most this many runs queued or running at once from here (default 12). */
  maxInFlight?: number;
  now?: () => number;
  /** Fetch a PR's head into the clone; returns the fetched commit (tests inject this). */
  fetchPr?: (pr: OpenPr) => string;
  /** The files a PR changes against its base (tests inject this). */
  changed?: (pr: OpenPr) => string[];
}

interface InFlight {
  sha: string;
  controller: AbortController;
  done: Promise<void>;
}

/** Runs started but never finished: a coordinator stopped during them. Their ids. */
export function unfinishedRuns(events: readonly StoredEvent[]): string[] {
  const started = new Set<string>();
  for (const e of events) {
    if (e.type === 'testrun.started') started.add((e.payload as EventPayload<'testrun.started'>).id);
    if (e.type === 'testrun.finished') started.delete((e.payload as EventPayload<'testrun.finished'>).id);
  }
  return [...started];
}

export class PrTestRuns {
  private inFlight = new Map<number, InFlight>();
  /** pr -> heads whose fast run finished (from the log, so a restart doesn't run them again). */
  private finished = new Map<number, Set<string>>();
  private lastPoll = 0;

  constructor(private d: PrTestRunDeps) {
    const queued = new Map<string, EventPayload<'testrun.queued'>>();
    for (const e of d.log.read(0, ['testrun.queued', 'testrun.finished'])) {
      if (e.type === 'testrun.queued') queued.set((e.payload as EventPayload<'testrun.queued'>).id, e.payload as EventPayload<'testrun.queued'>);
      else {
        const p = e.payload as EventPayload<'testrun.finished'>;
        // An interrupted or errored run runs again; a cancelled one was superseded.
        if (p.kind !== 'fast' || p.outcome !== 'done' || !queued.has(p.id)) continue;
        for (const n of p.prs) this.finished.set(n, new Set([...(this.finished.get(n) ?? []), p.sha]));
      }
    }
  }

  /** At start: wipe what a stopped coordinator's runs left, and record them as interrupted. */
  async recover(): Promise<string[]> {
    const ids = unfinishedRuns(this.d.log.read(0, ['testrun.started', 'testrun.finished']));
    for (const id of ids) {
      const queued = this.d.log.read(0, ['testrun.queued']).map((e) => e.payload as EventPayload<'testrun.queued'>).find((p) => p.id === id);
      const w = await this.d.host.wipe(id).catch((e: Error) => ({ ok: false, left: [e.message.slice(0, 200)] }));
      if (!w.ok) this.d.log.append('testrun.wipe_failed', { id, left: w.left.slice(0, 20) }, this.d.actor);
      this.d.log.append('testrun.finished', { id, sha: queued?.sha ?? '0000000', kind: queued?.kind ?? 'fast', prs: queued?.prs ?? [], ok: false, outcome: 'interrupted', results: [], detail: 'the coordinator stopped during the run; wiped at start' }, this.d.actor);
    }
    return ids;
  }

  private fetchPr(pr: OpenPr): string {
    if (this.d.fetchPr) return this.d.fetchPr(pr);
    const ref = `refs/${BRAND.cli}/test-run/${pr.number}`;
    const git = (...a: string[]) => execFileSync('git', ['-C', this.d.repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim();
    git('fetch', '-q', this.d.remote, `+refs/pull/${pr.number}/head:${ref}`, `+refs/heads/${pr.base}:refs/remotes/${this.d.remote}/${pr.base}`);
    return git('rev-parse', `${ref}^{commit}`);
  }

  private changed(pr: OpenPr): string[] {
    if (this.d.changed) return this.d.changed(pr);
    const out = execFileSync('git', ['-C', this.d.repo, 'diff', '--name-only', '-z', `${this.d.remote}/${pr.base}...${pr.headSha}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    return out.split('\0').filter(Boolean);
  }

  /** One pass: list open PRs (at most every pollMs), cancel superseded runs, start runs for new heads. */
  async tick(): Promise<{ started: number[]; cancelled: number[] }> {
    const now = (this.d.now ?? Date.now)();
    const out = { started: [] as number[], cancelled: [] as number[] };
    if (now - this.lastPoll < (this.d.pollMs ?? 90_000)) return out;
    this.lastPoll = now;
    const prs = await this.d.listPrs();
    const open = new Map(prs.map((p) => [p.number, p]));
    for (const [n, f] of this.inFlight) {
      const pr = open.get(n);
      if (!pr || pr.headSha !== f.sha) {
        f.controller.abort();
        out.cancelled.push(n);
      }
    }
    for (const pr of prs) {
      if (this.inFlight.size >= (this.d.maxInFlight ?? 12)) break;
      const cur = this.inFlight.get(pr.number);
      if (cur && cur.sha === pr.headSha) continue;
      if (this.finished.get(pr.number)?.has(pr.headSha)) continue;
      let sha: string;
      let changedFiles: string[];
      try {
        sha = this.fetchPr(pr);
        // The head moved between the listing and the fetch: the next pass runs the newer one.
        if (sha !== pr.headSha) continue;
        changedFiles = this.changed(pr);
      } catch (e) {
        this.d.log.append('coordinator.error', { instance: this.d.actor, where: `test run of #${pr.number}`, kind: 'fetch', message: (e as Error).message.slice(0, 500) }, this.d.actor);
        continue;
      }
      const controller = new AbortController();
      const entry: InFlight = { sha, controller, done: Promise.resolve() };
      entry.done = this.runOne(pr, sha, changedFiles, controller).finally(() => {
        if (this.inFlight.get(pr.number) === entry) this.inFlight.delete(pr.number);
      });
      this.inFlight.set(pr.number, entry);
      out.started.push(pr.number);
    }
    return out;
  }

  private async runOne(pr: OpenPr, sha: string, changedFiles: string[], controller: AbortController): Promise<void> {
    let result: TestRunResult;
    try {
      result = await this.d.start({ repo: this.d.repo, sha, kind: 'fast', prs: [pr.number], changedFiles }, { signal: controller.signal });
    } catch (e) {
      this.d.log.append('coordinator.error', { instance: this.d.actor, where: `test run of #${pr.number}`, kind: 'error', message: (e as Error).message.slice(0, 500) }, this.d.actor);
      return;
    }
    if (controller.signal.aborted) return; // superseded: its head is no longer the PR's, so no check on it
    this.finished.set(pr.number, new Set([...(this.finished.get(pr.number) ?? []), sha]));
    try {
      await this.d.post(sha, result);
    } catch (e) {
      // A missing permission is recorded (testrun.checks_failed) and shown in health; anything else is an error.
      if (!(e instanceof ChecksPermissionMissing)) this.d.log.append('coordinator.error', { instance: this.d.actor, where: `checks for #${pr.number}`, kind: 'error', message: (e as Error).message.slice(0, 500) }, this.d.actor);
    }
  }

  /** Wait for the runs in flight (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()].map((f) => f.done));
  }

  stop(): void {
    for (const f of this.inFlight.values()) f.controller.abort();
  }
}
