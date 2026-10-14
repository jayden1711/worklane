// Fix-forward, the coordinator's side (the plan and the state: src/fix-forward.ts). The merge flow hands it each real
// red of the default branch after an auto-merge (start); on every pass (step) it moves the open one on: the culprit's
// bisect, the fix tasks, the revert when they fail, and the default branch going green again. Its revert, its stop
// and its ops posts are the merge flow's (deps). Only the latest fix task's PR auto-merges while the branch is red
// (holds).
import { HeldTime, startRefusal, TestRunHeld } from '../testrun/gate.js';
import { BRAND } from '../brand.js';
import type { Backlog } from '../backlog/types.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, EventType, StoredEvent } from '../events/types.js';
import { nextStep, type BisectVerdict } from '../bisect.js';
import { failed as isFailure, FLAKY_EVENTS, isQuarantined, quarantine } from '../flaky.js';
import { candidateVerdict, episodes, FIX_FORWARD_EVENTS, FIX_FORWARD_LABEL, fixIssue, greenText, MAX_CANDIDATES, openEpisode, redText, revertEvidence, revertFirstReasons, type Episode } from '../fix-forward.js';
import { subjectPrNumber } from '../main-watch.js';
import { requiredOutcomes, type RequiredCheck } from '../pr-watch.js';
import { noVerdict, type TestRuns } from './pr-batch.js';
import { logTail } from './shared.js';

/** The default branch's commits, read with git in the coordinator's clone. */
export interface FixForwardGit {
  /** Fetch the default branch; its tip, or null. */
  tip(): string | null;
  /** A commit's first parent, or null. */
  parent(sha: string): string | null;
  isAncestor(a: string, b: string): boolean;
  /** The first-parent commits after `from` up to `to`, oldest first. */
  firstParents(from: string, to: string): string[];
  subject(sha: string): string;
  /** The files a commit changes against its first parent. */
  files(sha: string): string[];
  /** Its diff against its first parent. */
  diff(sha: string): string;
}

export interface FixForwardDeps {
  log: EventLog;
  actor: string;
  backlog: Backlog;
  branch: string;
  /** owner/name: links. */
  repo: string;
  /** The coordinator's clone (a test-run probe runs from it). */
  clone: string;
  git: FixForwardGit;
  config: () => { max_attempts: number; revert_first_paths: string[] };
  /** The project's required_checks. */
  required: () => string[];
  /** A probe not done in this many minutes counts as untestable (config.yaml flaky.rerun_timeout_min). */
  probeTimeoutMin: () => number;
  testRuns: TestRuns | null;
  tiers: () => { name: string; kind: 'fast' | 'full' }[];
  /** The review categories (src/review.ts computeLevel, with the money-path list) of these files. */
  categories: (files: string[]) => Record<string, string[]>;
  /** Open the culprit's revert PR (and stop auto-merge, tell the owner): the merge flow's. */
  revert: (o: { ep: Episode; culprit: string; number: number | null; title: string; evidence: string }) => Promise<{ url: string; number: number } | null>;
  /** Nothing to revert or fix: stop auto-merge and tell the owner (the merge flow's). */
  giveUp: (o: { ep: Episode; reason: string }) => Promise<void>;
  /** One ops post, once per key: sent (or had been), limited (try again later), or off (nowhere to post). */
  post: (key: string, text: string) => Promise<'sent' | 'limited' | 'off'>;
  /** How often the branch's tip is looked at (ms). */
  pollMs: () => number;
  now?: () => number;
}

export const redKey = (sha: string) => `fix-forward-red:${sha}`;
export const greenKey = (sha: string) => `fix-forward-green:${sha}`;
/** The comment that attaches the culprit to a fix PR, once. */
const CULPRIT_MARK = '<!-- fix-forward culprit -->';

type Payload<T extends EventType> = EventPayload<T>;

export class FixForward {
  /** Test-run probes in this process, by candidate: running, or each failing check's result. */
  private probes = new Map<string, 'running' | 'held' | Map<string, 'pass' | 'fail'>>();
  /** Time each probe spent held at the start gate: not counted against its timeout. */
  private heldTime = new HeldTime();
  private lookedAt = -Infinity;
  private attached = new Set<number>();

  constructor(private readonly d: FixForwardDeps) {}

  private get now() {
    return this.d.now?.() ?? Date.now();
  }

  private emit<T extends EventType>(type: T, payload: Payload<T>) {
    this.d.log.append(type, payload, this.d.actor);
  }

  private error(where: string, e: unknown) {
    this.emit('coordinator.error', { instance: this.d.actor, where: `fix-forward: ${where}`, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
  }

  private events(): StoredEvent[] {
    return this.d.log.read(0, [...FIX_FORWARD_EVENTS]);
  }

  /** The red default branch being worked on, or null. */
  open(): Episode | null {
    return openEpisode(this.events());
  }

  /** Whether issue `n` is one of fix-forward's own fix tasks (so the dispatcher works it whoever filed it). */
  isFixTask(n: number): boolean {
    return this.events().some((e) => e.type === 'fix_forward.attempt' && (e.payload as Payload<'fix_forward.attempt'>).issue === n);
  }

  /**
   * Why PR `number` (for issue `issue`) doesn't auto-merge now, or null: while the default branch is red, only the
   * latest fix task's PR does.
   */
  holds(issue: number): string | null {
    const ep = this.open();
    if (!ep) return null;
    const last = ep.attempts.at(-1);
    if (last && !last.failed && !ep.finished && last.attempt.issue === issue) return null;
    return `${this.d.branch} is red (since ${ep.started.sha.slice(0, 8)}): only its fix PR merges until it is green again`;
  }

  // ---------------------------------------------------------------- start

  /** A real red on `sha` after auto-merging PR `number`: take it on, unless the branch was red already (the open one covers it). */
  async start(o: { sha: string; number: number | null; failed: string[] }): Promise<void> {
    if (this.open() || episodes(this.events()).some((e) => e.started.sha === o.sha)) return;
    const g = this.d.git;
    g.tip();
    const parent = g.parent(o.sha);
    let lastGreen: string | null = null;
    let line: string[] = [];
    if (parent && (await this.state(parent)) === 'green') {
      lastGreen = parent;
      line = [o.sha];
    } else {
      const known = this.knownGreen().find((s) => s !== o.sha && g.isAncestor(s, o.sha));
      const since = known ? g.firstParents(known, o.sha) : [];
      if (known && since.length && since.length <= MAX_CANDIDATES && since.at(-1) === o.sha) {
        lastGreen = known;
        line = since;
      }
    }
    const merges = new Map(this.d.log.read(0, ['merge.done']).map((e) => [(e.payload as Payload<'merge.done'>).sha, e.payload as Payload<'merge.done'>]));
    const candidates = line.map((sha) => {
      const m = merges.get(sha);
      const subject = g.subject(sha);
      return { sha, number: m?.number ?? subjectPrNumber(subject), title: (m?.title ?? subject).slice(0, 300) };
    });
    this.emit('fix_forward.started', { sha: o.sha, number: o.number, failed: o.failed, last_green: lastGreen, candidates });
    const ep = this.open()!;
    if (!lastGreen) {
      const reason = `${this.d.branch} was not green before it (\`${parent?.slice(0, 8) ?? '?'}\`), and no commit known green is within ${MAX_CANDIDATES} first-parent commits before it, so there is no culprit to find, fix or revert`;
      await this.finish(ep, 'gave_up', reason);
      await this.d.giveUp({ ep: this.open()!, reason });
      return;
    }
    await this.move(ep);
  }

  /** Default-branch commits known green, newest first: post-merge checks and earlier recoveries. */
  private knownGreen(): string[] {
    const out: string[] = [];
    for (const e of this.d.log.read(0, ['merge.main_result', 'fix_forward.green'])) {
      if (e.type === 'merge.main_result' && (e.payload as Payload<'merge.main_result'>).outcome === 'green') out.push((e.payload as Payload<'merge.main_result'>).sha);
      if (e.type === 'fix_forward.green') out.push((e.payload as Payload<'fix_forward.green'>).tip);
    }
    return out.reverse();
  }

  // ---------------------------------------------------------------- each pass

  async step(): Promise<void> {
    await this.outbound();
    const ep = this.open();
    if (!ep) return;
    if (this.now - this.lookedAt < this.d.pollMs()) return;
    this.lookedAt = this.now;
    await this.move(ep);
    await this.outbound();
  }

  private async move(ep: Episode): Promise<void> {
    const tip = this.d.git.tip();
    if (tip && tip !== ep.started.sha && this.d.git.isAncestor(ep.started.sha, tip) && (await this.state(tip)) === 'green') return this.greenAgain(ep, tip);
    if (ep.finished) return;
    if (!ep.culprit) {
      await this.bisect(ep);
      ep = this.open()!;
      if (!ep.culprit) return;
    }
    const cfg = this.d.config();
    if (ep.culprit!.revert_first.length) return this.revert(ep, `the culprit ${ep.culprit!.revert_first.join('; ')}: reverted at once, no fix tried`);
    if (cfg.max_attempts === 0) return this.revert(ep, 'fix_forward.max_attempts is 0: reverted at once');
    const last = ep.attempts.at(-1);
    if (!last) return this.attempt(ep, 1);
    if (last.failed) return last.attempt.attempt < cfg.max_attempts ? this.attempt(ep, last.attempt.attempt + 1) : this.revert(ep, `no fix turned ${this.d.branch} green within ${cfg.max_attempts} attempt(s) (fix_forward.max_attempts)`);
    await this.judge(ep, last, tip);
    // It failed just now: the next attempt, or the revert, without waiting a pass.
    const after = this.open();
    if (after?.attempts.at(-1)?.failed) await this.move(after);
  }

  /**
   * A default-branch commit's state as the harness counts it: a harness merge by its post-merge check (after the
   * flaky re-run); anything else by its required checks, quarantined ones not counting.
   */
  private async state(sha: string): Promise<'green' | 'red' | 'pending'> {
    const judged = this.d.log.read(0, ['merge.main_result']).filter((e) => (e.payload as Payload<'merge.main_result'>).sha === sha).at(-1)?.payload as Payload<'merge.main_result'> | undefined;
    if (judged) return judged.outcome === 'green' ? 'green' : judged.outcome === 'red' ? 'red' : 'pending';
    if (this.d.log.read(0, ['merge.done']).some((e) => (e.payload as Payload<'merge.done'>).sha === sha)) return 'pending';
    const required = this.d.required();
    if (!required.length) return 'pending';
    const q = quarantine(this.d.log.read(0, [...FLAKY_EVENTS]));
    const out = requiredOutcomes(required, await this.d.backlog.checks(sha)).filter((c) => !(isFailure(c.outcome) && isQuarantined(q, c.name)));
    if (out.some((c) => isFailure(c.outcome))) return 'red';
    return out.every((c) => c.outcome === 'pass') ? 'green' : 'pending';
  }

  // ---------------------------------------------------------------- the culprit

  private async bisect(ep: Episode): Promise<void> {
    const cands = ep.started.candidates;
    for (let i = 0; i < cands.length + 2; i++) {
      const tested = this.open()!.tested;
      const commits = cands.map((c): { sha: string; verdict: BisectVerdict } => {
        if (c.sha === ep.started.sha) return { sha: c.sha, verdict: 'bad' };
        const t = tested.get(c.sha);
        return { sha: c.sha, verdict: t ? t.verdict : 'untested' };
      });
      const s = nextStep(commits);
      if (s.state === 'found') return this.named(ep, s.culprit, cands.length === 1 ? 'only' : 'bisect', null);
      if (s.state === 'range') return this.named(ep, null, 'range', { from: s.from, to: s.to });
      const done = s.state === 'wait' ? await this.resolve(ep, s.sha, tested.get(s.sha)!) : await this.probe(ep, s.sha);
      if (!done) return; // a probe is running: next pass
    }
  }

  private tested(ep: Episode, candidate: string, verdict: Payload<'fix_forward.tested'>['verdict'], via: Payload<'fix_forward.tested'>['via'], ids: number[], detail: string) {
    this.emit('fix_forward.tested', { sha: ep.started.sha, candidate, verdict, via, ids, detail: detail.slice(0, 500) });
  }

  private async onCandidate(ep: Episode, sha: string): Promise<RequiredCheck[]> {
    return requiredOutcomes(ep.started.failed, await this.d.backlog.checks(sha));
  }

  /** Test candidate `sha` on its own: the checks already on it, else a test run or an Actions re-run. True: a verdict is in. */
  private async probe(ep: Episode, sha: string): Promise<boolean> {
    const out = await this.onCandidate(ep, sha);
    const v = candidateVerdict(out);
    if (v === 'good' || v === 'bad') {
      this.tested(ep, sha, v, 'checks', [], `its own checks: ${out.map((c) => `${c.name} ${c.outcome}`).join(', ')}`);
      return true;
    }
    if (v === 'pending') {
      this.tested(ep, sha, 'pending', 'checks', [], 'its checks are still running');
      return false;
    }
    const names = this.d.testRuns?.checkNames() ?? {};
    const trChecks = new Set(Object.values(names));
    if (this.d.testRuns && ep.started.failed.every((c) => trChecks.has(c))) {
      this.startTestRun(ep, sha);
      this.tested(ep, sha, 'pending', 'test_run', [], `a test run of ${ep.started.failed.join(', ')} on it`);
      return false;
    }
    const ids = out.map((c) => c.id);
    if (this.d.backlog.rerunFailedJobs && ids.length && ids.every((x) => x !== undefined)) {
      try {
        const r = await this.d.backlog.rerunFailedJobs(ids as number[]);
        const refused = [...r.values()].find((x) => !x.ok);
        if (!refused) {
          this.tested(ep, sha, 'pending', 'actions', ids as number[], `its jobs for ${ep.started.failed.join(', ')} re-run`);
          return false;
        }
        this.tested(ep, sha, 'skip', 'actions', ids as number[], `GitHub refused the re-run: ${'why' in refused ? refused.why : ''}`);
        return true;
      } catch (e) {
        this.tested(ep, sha, 'skip', 'actions', ids as number[], `the re-run failed: ${(e as Error).message}`);
        return true;
      }
    }
    this.tested(ep, sha, 'skip', 'none', [], `no check run on it to re-run, and no test run behind ${ep.started.failed.join(', ')}`);
    return true;
  }

  /** A probe asked for earlier: its verdict once in (true), or still running (false); not done in time: skip. */
  private async resolve(ep: Episode, sha: string, t: Payload<'fix_forward.tested'> & { at: string }): Promise<boolean> {
    if (this.now - Date.parse(t.at) - this.heldTime.ms(sha, this.now) >= this.d.probeTimeoutMin() * 60_000) {
      this.probes.delete(sha);
      this.tested(ep, sha, 'skip', t.via, t.ids, `not done in ${this.d.probeTimeoutMin()} min`);
      return true;
    }
    if (t.via === 'test_run') {
      const mem = this.probes.get(sha);
      if (!mem) {
        this.startTestRun(ep, sha); // lost with a restart: run it again
        return false;
      }
      // WHY: held at the start gate (src/testrun/gate.ts) is no verdict: it runs once the gate lets it, its timeout paused.
      if (mem === 'held') {
        const held = startRefusal() !== null;
        this.heldTime.held(sha, this.now, held);
        if (!held) this.startTestRun(ep, sha);
        return false;
      }
      if (mem === 'running') return false;
      this.probes.delete(sha);
      const results = ep.started.failed.map((c) => mem.get(c) ?? 'fail');
      const verdict = mem.size && results.every((r) => r === 'pass') ? 'good' : mem.size ? 'bad' : 'skip';
      this.tested(ep, sha, verdict, 'test_run', [], `the test run: ${ep.started.failed.map((c) => `${c} ${mem.get(c) ?? 'no verdict'}`).join(', ')}`);
      return true;
    }
    const out = (await this.onCandidate(ep, sha)).map((c) => (c.id !== undefined && t.ids.includes(c.id) && t.via === 'actions' ? { ...c, outcome: 'pending' as const } : c));
    const v = candidateVerdict(out);
    if (v === 'pending') return false;
    this.tested(ep, sha, v === 'untested' ? 'skip' : v, t.via, t.ids, `${t.via === 'actions' ? 'the re-run' : 'its checks'}: ${out.map((c) => `${c.name} ${c.outcome}`).join(', ')}`);
    return true;
  }

  /** Run the tiers behind the failing checks on candidate `sha`, in the background. */
  private startTestRun(ep: Episode, sha: string) {
    const tr = this.d.testRuns!;
    const names = tr.checkNames();
    const tiers = this.d.tiers().filter((t) => ep.started.failed.includes(names[t.name] ?? ''));
    this.probes.set(sha, 'running');
    void (async () => {
      const got = new Map<string, 'pass' | 'fail'>();
      try {
        for (const kind of [...new Set(tiers.map((t) => t.kind))]) {
          const r = await tr.startTestRun({ repo: this.d.clone, sha, kind, prs: [] });
          if (noVerdict(r) !== null) continue;
          for (const name of ep.started.failed) {
            const ts = r.tiers.filter((x) => (names[x.tier] ?? `test-run/${x.tier}`) === name);
            if (ts.length) got.set(name, ts.every((x) => x.ok) ? 'pass' : 'fail');
          }
        }
      } catch (e) {
        if (e instanceof TestRunHeld) {
          this.probes.set(sha, 'held');
          this.heldTime.held(sha, this.now, true);
          return;
        }
        this.error(`test run of ${sha.slice(0, 8)}`, e);
      }
      this.probes.set(sha, got);
    })();
  }

  /** The culprit is named (or only the range it is in). */
  private named(ep: Episode, culprit: string | null, how: 'only' | 'bisect' | 'range', range: { from: string; to: string } | null) {
    const c = culprit ? ep.started.candidates.find((x) => x.sha === culprit) : null;
    let revertFirst: string[] = [];
    if (culprit) {
      const files = this.d.git.files(culprit);
      revertFirst = revertFirstReasons({ files, globs: this.d.config().revert_first_paths, categories: this.d.categories(files) });
    }
    this.emit('fix_forward.culprit', { sha: ep.started.sha, culprit, number: c?.number ?? null, title: c?.title ?? '', how, range, revert_first: revertFirst });
  }

  // ---------------------------------------------------------------- fix tasks

  /** Fix task `n`: an issue the dispatcher works like any task, with the failure, the culprit and the merged PRs. */
  private async attempt(ep: Episode, n: number): Promise<void> {
    const logs: string[] = [];
    for (const c of requiredOutcomes(ep.started.failed, await this.d.backlog.checks(ep.started.sha))) {
      if (c.id === undefined) {
        logs.push(`### ${c.name}\n(not a check run: no log to read)`);
        continue;
      }
      try {
        const l = await this.d.backlog.jobLog(c.id);
        logs.push(`### ${c.name}\n${l.ok ? logTail(l.text) : `(the log can't be read: ${l.why})`}`);
      } catch (e) {
        logs.push(`### ${c.name}\n(the log can't be read: ${(e as Error).message.slice(0, 200)})`);
      }
    }
    const culprit = ep.culprit?.culprit ?? null;
    const diff = culprit ? this.d.git.diff(culprit) : '';
    const { title, body } = fixIssue(ep, { branch: this.d.branch, repo: this.d.repo, attempt: n, logs, diff, product: BRAND.name });
    let issue: number;
    try {
      issue = await this.d.backlog.createIssue(title, body, ['ready', FIX_FORWARD_LABEL]);
    } catch (e) {
      this.error('filing the fix task', e);
      return; // tried again on the next pass
    }
    this.emit('fix_forward.attempt', { sha: ep.started.sha, attempt: n, issue, culprit: ep.culprit?.number ?? null });
  }

  /** The PR the fix task opened (the latest pr.opened for its issue since the attempt), or null. */
  private fixPr(a: Episode['attempts'][number]): Payload<'pr.opened'> | null {
    return (this.d.log.read(a.id, ['pr.opened']).filter((e) => (e.payload as Payload<'pr.opened'>).issue === a.attempt.issue).at(-1)?.payload as Payload<'pr.opened'> | undefined) ?? null;
  }

  /** The running fix task: failed (ended without a PR, its PR gave up or closed, or merged and still red), or not yet. */
  private async judge(ep: Episode, a: Episode['attempts'][number], tip: string | null): Promise<void> {
    const n = a.attempt.issue;
    const fail = (why: string) => this.emit('fix_forward.attempt_failed', { sha: ep.started.sha, attempt: a.attempt.attempt, issue: n, why: why.slice(0, 1000) });
    const after = this.d.log.read(a.id, ['issue.blocked', 'issue.no_change', 'issue.closed']).filter((e) => (e.payload as { issue: number }).issue === n);
    const pr = this.fixPr(a);
    if (!pr) {
      const end = after[0];
      if (!end) return;
      if (end.type === 'issue.blocked') return fail(`the fix task was blocked: ${(end.payload as Payload<'issue.blocked'>).why}`);
      if (end.type === 'issue.no_change') return fail(`the fix task changed nothing: ${(end.payload as Payload<'issue.no_change'>).why}`);
      return fail('the fix task was closed without a PR');
    }
    await this.attachCulprit(ep, pr.number);
    const prEvents = this.d.log.read(a.id, ['ci_fix.gave_up', 'pr.closed', 'merge.done']).filter((e) => (e.payload as { number: number }).number === pr.number);
    const gaveUp = prEvents.find((e) => e.type === 'ci_fix.gave_up');
    if (gaveUp) return fail(`its PR #${pr.number}'s checks fail and its CI fix runs gave up: ${(gaveUp.payload as Payload<'ci_fix.gave_up'>).reason}`);
    const closed = prEvents.find((e) => e.type === 'pr.closed')?.payload as Payload<'pr.closed'> | undefined;
    if (closed && !closed.merged) return fail(`its PR #${pr.number} was closed without merging`);
    const merged = prEvents.find((e) => e.type === 'merge.done')?.payload as Payload<'merge.done'> | undefined;
    if (!merged && !closed?.merged) return;
    if (!tip || (merged && !this.d.git.isAncestor(merged.sha, tip))) return;
    if ((await this.state(tip)) === 'red') fail(`its PR #${pr.number} merged${merged ? ` as \`${merged.sha.slice(0, 8)}\`` : ''}, and ${this.d.branch} is still red on \`${tip.slice(0, 8)}\``);
  }

  /** Name the culprit on the fix PR, once. */
  private async attachCulprit(ep: Episode, pr: number) {
    if (this.attached.has(pr)) return;
    try {
      if (!(await this.d.backlog.comments(pr)).some((c) => c.body.includes(CULPRIT_MARK))) {
        const c = ep.culprit;
        const who = c?.culprit ? `${c.number ? `#${c.number}` : ''} (\`${c.culprit.slice(0, 8)}\`${c.how === 'bisect' ? ', bisected' : ''})`.trim() : `not named: one of ${c?.range?.from.slice(0, 8)}..${c?.range?.to.slice(0, 8)}`;
        await this.d.backlog.comment(pr, `[${BRAND.cli}] Fix-forward for ${this.d.branch}, red on \`${ep.started.sha.slice(0, 8)}\` (${ep.started.failed.join(', ')}). Culprit: ${who}. Until ${this.d.branch} is green again only this PR auto-merges; if no fix is green within the attempts, the culprit is reverted.\n${CULPRIT_MARK}`);
      }
      this.attached.add(pr);
    } catch (e) {
      this.error(`naming the culprit on #${pr}`, e);
    }
  }

  // ---------------------------------------------------------------- ends

  private async finish(ep: Episode, outcome: 'fixed' | 'reverted' | 'gave_up', detail: string, o: { by?: number | null; revert?: { url: string; number: number } | null } = {}) {
    this.emit('fix_forward.finished', { sha: ep.started.sha, outcome, attempts: ep.attempts.length, culprit: ep.culprit?.number ?? null, by: o.by ?? null, revert: o.revert ?? null, detail: detail.slice(0, 1000) });
  }

  private async revert(ep: Episode, why: string): Promise<void> {
    const c = ep.culprit;
    if (!c?.culprit) {
      const reason = `${why}, but the culprit isn't named (${c?.range ? `one of ${c.range.from.slice(0, 8)}..${c.range.to.slice(0, 8)}; the commits between couldn't be tested` : 'no culprit'}), so nothing is reverted`;
      await this.finish(ep, 'gave_up', reason);
      await this.d.giveUp({ ep: this.open()!, reason });
      return;
    }
    const r = await this.d.revert({ ep, culprit: c.culprit, number: c.number, title: c.title, evidence: revertEvidence(ep, { repo: this.d.repo, why }) });
    if (r) await this.finish(ep, 'reverted', why, { revert: r });
    else await this.finish(ep, 'gave_up', `${why}, but opening the revert PR failed`);
  }

  /** Green again on `tip`: by a fix PR, the culprit's revert, or something else. */
  private async greenAgain(ep: Episode, tip: string) {
    const merged = new Map<number, string | null>();
    for (const e of this.d.log.read(ep.id, ['merge.done', 'pr.closed'])) {
      const p = e.payload as { number: number; merged?: boolean; sha?: string };
      if (e.type === 'merge.done') merged.set(p.number, p.sha!);
      else if (p.merged && !merged.has(p.number)) merged.set(p.number, null);
    }
    // A fix PR that merged and left the branch red (its attempt failed) is not what made it green.
    const fixPrs = ep.attempts.filter((a) => !a.failed).map((a) => this.fixPr(a)?.number).filter((x): x is number => x !== undefined);
    const fixedBy = fixPrs.find((n) => merged.has(n) && (merged.get(n) === null || this.d.git.isAncestor(merged.get(n)!, tip))) ?? null;
    let reverted: number | null = null;
    const rv = ep.finished?.revert;
    if (!fixedBy && rv) {
      try {
        if ((await this.d.backlog.pullRequest(rv.number)).state === 'merged') reverted = ep.culprit?.number ?? null;
      } catch (e) {
        this.error(`the revert PR #${rv.number}`, e);
      }
    }
    if (!ep.finished) await this.finish(ep, 'fixed', fixedBy ? `fixed by #${fixedBy}` : `green again on ${tip.slice(0, 8)}`, { by: fixedBy });
    this.emit('fix_forward.green', { sha: ep.started.sha, tip, fixed_by: fixedBy, reverted });
  }

  // ---------------------------------------------------------------- the ops channel

  /** Each red default branch's posts not sent yet: red once its culprit is named (or it ended), green once it is. */
  private async outbound() {
    for (const ep of episodes(this.events())) {
      if (ep.culprit || ep.finished) {
        if ((await this.d.post(redKey(ep.started.sha), redText(ep, { branch: this.d.branch, next: this.next(ep) }))) === 'limited') return;
      }
      if (ep.green && (await this.d.post(greenKey(ep.started.sha), greenText(ep, ep.green, { branch: this.d.branch }))) === 'limited') return;
    }
  }

  private next(ep: Episode): string {
    if (ep.finished?.outcome === 'reverted') return `Reverting it: ${ep.finished.revert?.url ?? ''} (waits for a human).`;
    if (ep.finished?.outcome === 'gave_up') return `Nothing automatic: ${ep.finished.detail}. Auto-merge is stopped.`;
    if (ep.culprit?.revert_first.length) return 'Reverting it at once (a protected path).';
    const a = ep.attempts.at(-1);
    return a ? `Fix task #${a.attempt.issue} is on it; only its PR merges until ${this.d.branch} is green.` : `A fix task is starting; only its PR merges until ${this.d.branch} is green.`;
  }
}

