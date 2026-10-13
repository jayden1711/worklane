// The weekly optimization pass, wired (src/optimize.ts): once a week, the top target (a declared benchmark, or the
// slowest test the metrics recorded) is run N times on main for a baseline, then filed as a normal task, built on
// the strongest model with the profile and the one rule. Before its PR opens, the coordinator runs the benchmark N
// times on the change: only a median better than main's by more than the noise goes on to the PR (every normal
// gate, the usual merge policy), with the numbers and raw runs in its body; anything else is discarded and closed
// with why. A hard stop at budget_usd a week, counted from the run.cost of the week's optimization tasks.
import { BRAND } from '../brand.js';
import type { Actionability, Issue } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import { judge, OPTIMIZE_LABEL, optimizeDue, optimizeIssue, pickTarget, readMetric, sample, slowestTests, targetByKey, targets, type Sample, type Target } from '../optimize.js';
import { createWorktreeAsync, removeWorktree } from '../worktrees.js';
import { PrHygiene } from './pr-hygiene.js';

const DAY = 24 * 3600_000;
type Pass = EventPayload<'optimize.pass'>;
type Measured = { runs: number[]; out: string } | { error: string };

export abstract class Optimizer extends PrHygiene {
  /** The pass in flight. */
  protected optimizeRun: Promise<void> = Promise.resolve();
  private optimizeBusy = false;

  private passes(): Pass[] {
    return this.d.log.read(0, ['optimize.pass']).map((e) => e.payload as Pass);
  }

  private results(): EventPayload<'optimize.result'>[] {
    return this.d.log.read(0, ['optimize.result']).map((e) => e.payload as EventPayload<'optimize.result'>);
  }

  /** The pass that filed this issue: an optimization task is only one this instance filed and recorded. */
  protected optimizePassOf(n: number): Pass | null {
    return this.passes().find((p) => p.issue === n) ?? null;
  }

  /** The dispatcher's say for an optimization task this instance filed itself (its own log is the proof); else null. */
  protected optimizeTask(issue: Issue): Actionability | null {
    if (!issue.labels.includes(OPTIMIZE_LABEL) || issue.state !== 'open' || !issue.labels.includes('ready')) return null;
    return this.optimizePassOf(issue.number) ? { actionable: true, why: 'an optimization task this instance filed (optimize.pass)' } : null;
  }

  /** The week's passes: started in the 7 days before now. */
  private weekPasses(): Pass[] {
    const now = this.nowMs();
    return this.passes().filter((p) => Date.parse(p.started_at) > now - 7 * DAY);
  }

  /** USD the week's optimization tasks have spent: every run.cost booked to their issues. */
  protected optimizeSpent(): number {
    const issues = new Set(this.weekPasses().flatMap((p) => (p.issue ? [p.issue] : [])));
    return this.d.log.read(0, ['run.cost']).reduce((s, e) => {
      const p = e.payload as EventPayload<'run.cost'>;
      return p.issue !== null && issues.has(p.issue) ? s + p.usd : s;
    }, 0);
  }

  /** What the week's optimization budget has left (a hard stop at 0). */
  protected optimizeLeft(): number {
    return this.d.cfg.project.optimize.budget_usd - this.optimizeSpent();
  }

  /** Start the pass when it is due (one at a time). */
  async checkOptimize(): Promise<void> {
    const o = this.d.cfg.project.optimize;
    if (!o.enabled || this.optimizeBusy || this.halt.signal.aborted || this.stopped || this.usagePause()) return;
    const now = this.d.now?.() ?? new Date();
    if (!optimizeDue(now, this.passes().at(-1)?.started_at ?? null, o)) return;
    this.optimizeBusy = true;
    this.optimizeRun = this.optimizePass(now.toISOString())
      .catch((e: Error) => void this.emit('coordinator.error', { instance: this.d.instance, where: 'optimize', kind: 'error', message: e.message.slice(0, 500) }))
      .finally(() => {
        this.optimizeBusy = false;
      });
  }

  /** The target's command N times in `cwd`: every run's number, or why it can't be measured. */
  private async measure(t: Target, cwd: string): Promise<Measured> {
    const runs: number[] = [];
    let out = '';
    for (let i = 1; i <= t.repeats; i++) {
      const t0 = Date.now();
      const r = await this.project(t.command, cwd);
      const wall = Math.max(0, Date.now() - t0);
      if (r.code !== 0) return { error: `run ${i} of \`${t.command}\` exited ${r.code ?? 'without a code'}: ${r.tail.slice(-300)}` };
      const v = readMetric(t.metric, r.out, wall);
      if (v === null) return { error: `run ${i} of \`${t.command}\` printed no number for its metric` };
      runs.push(v);
      out = r.out;
    }
    return { runs, out };
  }

  /** Measure at a commit of the default branch, in a scratch worktree removed after. */
  private async measureAt(t: Target, sha: string, withProfile: boolean): Promise<(Measured & { profile?: string }) | { error: string }> {
    const name = 'optimize-base';
    const { path, setupErrors } = await createWorktreeAsync(this.wt, name, `${BRAND.cli}/${name}`, sha);
    try {
      if (setupErrors.length) return { error: `worktree setup failed: ${setupErrors.join('; ')}` };
      const m = await this.measure(t, path);
      if ('error' in m || !withProfile) return m;
      const profile = t.profile ? (await this.project(t.profile, path)).out : m.out;
      return { ...m, profile };
    } finally {
      try {
        removeWorktree(this.wt, name);
      } catch {
        // already gone
      }
    }
  }

  private async optimizePass(startedAt: string): Promise<void> {
    const o = this.d.cfg.project.optimize;
    const done = (outcome: string, x: Partial<Pick<Pass, 'target' | 'issue' | 'baseline' | 'unit' | 'lower_is_better'>> = {}) =>
      void this.emit('optimize.pass', { started_at: startedAt, target: x.target ?? null, unit: x.unit ?? '', lower_is_better: x.lower_is_better ?? true, issue: x.issue ?? null, baseline: x.baseline ?? null, outcome: outcome.slice(0, 1000) });
    if (this.d.cfg.project.land_mode !== 'pr') return done('land_mode is not pr: an optimization only ever lands through a PR');
    if (this.optimizeLeft() <= 0) return done(`the week's optimization budget ($${o.budget_usd}) is spent ($${this.optimizeSpent().toFixed(2)})`);
    const week = new Set(this.weekPasses().flatMap((p) => (p.issue ? [p.issue] : [])));
    if (this.results().filter((r) => r.outcome === 'improved' && week.has(r.issue)).length >= o.max_prs) return done(`this week's ${o.max_prs} optimization PR(s) are already open`);
    const pending = this.passes().find((p) => p.issue && !this.results().some((r) => r.issue === p.issue));
    if (pending?.issue && (await this.d.backlog.get(pending.issue)).state === 'open') return done(`the last optimization task, #${pending.issue}, is still open`);
    const all = targets(o, this.d.cfg.benchmarks, slowestTests(this.d.log.read(), this.nowMs()));
    const tried = (key: string) => {
      const p = this.passes().filter((x) => x.target === key).at(-1);
      return p ? Date.parse(p.started_at) : null;
    };
    const t = pickTarget(all, tried);
    if (!t) return done(`no target: no benchmark in ${BRAND.configDir}/benchmarks.yaml${o.slow_test_command ? ' and no slow test recorded this week' : ', and no slow_test_command for the slowest tests'}`);
    const meta = { target: t.key, unit: t.unit, lower_is_better: t.lowerIsBetter };
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const sha = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const m = await this.measureAt(t, sha, true);
    if ('error' in m) return done(`the baseline could not be measured: ${m.error}`, meta);
    const base = sample(m.runs);
    const baseline = { sha, runs: base.runs, median: base.median, mad: base.mad };
    const brief = optimizeIssue(t, base, sha, 'profile' in m ? (m.profile ?? '') : '');
    const n = await this.d.backlog.createIssue(brief.title, brief.body, [OPTIMIZE_LABEL, 'ready']);
    done('filed', { ...meta, issue: n, baseline });
  }

  /**
   * An optimization task's change, measured before its PR: true goes on to the PR (the numbers recorded for its
   * body); false: discarded and closed with why (already done here). Main's numbers are measured again when the
   * task's base is not the commit the baseline was measured on.
   */
  protected async optimizeGate(n: number, pass: Pass, path: string, base: string, head: string): Promise<boolean> {
    const key = pass.target!;
    const t = targetByKey(key, this.d.cfg.project.optimize, this.d.cfg.benchmarks);
    let before: (Sample & { sha: string }) | null = pass.baseline;
    const discard = async (why: string, after: (Sample & { sha: string }) | null = null, v: { gain: number; pct: number; noise: number } | null = null) => {
      this.emit('optimize.result', { issue: n, target: key, head, outcome: 'discarded', why: why.slice(0, 1000), before, after, gain: v?.gain ?? null, pct: v?.pct ?? null, noise: v?.noise ?? null });
      await this.optimizeDiscard(n, why, before, after);
      return false;
    };
    if (!t) return discard(`the target ${key} is no longer declared`);
    if (!before || before.sha !== base) {
      const m = await this.measureAt(t, base, false);
      if ('error' in m) return discard(`main's numbers could not be measured again at ${base.slice(0, 12)}: ${m.error}`);
      before = { ...sample(m.runs), sha: base };
    }
    const m = await this.measure(t, path);
    if ('error' in m) return discard(`the benchmark failed on the change: ${m.error}`);
    const after = { ...sample(m.runs), sha: head };
    const v = judge(before, after, t.lowerIsBetter, t.unit);
    if (!v.improved) return discard(v.why, after, v);
    this.emit('optimize.result', { issue: n, target: key, head, outcome: 'improved', why: v.why.slice(0, 1000), before, after, gain: v.gain, pct: v.pct, noise: v.noise });
    return true;
  }

  /** Discarded: said on the issue with the numbers, closed, and the claim and worktree released. */
  protected async optimizeDiscard(n: number, why: string, before: (Sample & { sha: string }) | null = null, after: (Sample & { sha: string }) | null = null): Promise<void> {
    const runs = (s: Sample & { sha: string }, label: string) => `- ${label} \`${s.sha.slice(0, 12)}\`: median ${s.median}, MAD ${s.mad}; runs ${s.runs.join(', ')}`;
    await this.d.backlog.removeLabel(n, 'agent:working');
    await this.d.backlog.comment(n, [`[${BRAND.cli}] Optimization discarded, no PR: ${why}`, ...(before ? [runs(before, 'before (main)')] : []), ...(after ? [runs(after, 'after')] : [])].join('\n'));
    await this.d.backlog.close(n);
    this.releaseClaim(n, `optimization discarded: ${why}`.slice(0, 500));
  }
}
