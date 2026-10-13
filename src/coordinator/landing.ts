// Landing: the land queue and batches, the gates before landing, opening PRs, and what follows a landing (deploy).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BRAND } from '../brand.js';
import { type DoneWhenList } from '../backlog/types.js';
import { claim, release } from '../claims.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import { computeLevel, loadMoneyPaths } from '../review.js';
import type { ReviewConfig } from '../config/schema.js';
import { waitCategoriesOf } from '../merge-policy.js';
import { effectiveClass, prBodyHead, prBodyProblems, riskClassOf } from '../pr-rules.js';
import { checkedPush } from '../push-check.js';
import { DIRECT_LAND_REFUSED, directLandRefusal, localRemote } from '../direct-land.js';
import { receiptLines } from '../receipts.js';
import { scanRange } from '../scan/secrets.js';
import { fullRunLock } from '../slots.js';
import { baselineGate, latestBaseline } from '../baseline.js';
import { createWorktree, removeWorktree } from '../worktrees.js';
import { Decisions } from './decisions.js';
import { sh, evalLines, pushRefusal, DEFAULT_REVIEW } from './shared.js';
import { slotDeferringSince } from './wait-caps.js';

export abstract class Landing extends Decisions {
  // ---------------------------------------------------------------- landing

  /** Queued changes without a final landing result, oldest first. "deferred" isn't final. */
  private landQueue(): EventPayload<'land.queued'>[] {
    const out: EventPayload<'land.queued'>[] = [];
    for (const q of this.d.log.read(0, ['land.queued'])) {
      const p = q.payload as EventPayload<'land.queued'>;
      const final = this.d.log.read(q.id, ['land.result']).some((r) => (r.payload as { issue: number; outcome: string }).issue === p.issue && (r.payload as { outcome: string }).outcome !== 'deferred');
      if (!final && !out.some((x) => x.issue === p.issue)) out.push(p);
    }
    return out;
  }

  private filesOf(issue: number, head: string): string[] {
    const e = this.events(issue).filter((x) => x.type === 'change.proposed' && (x.payload as { head: string }).head === head).at(-1);
    return (e?.payload as { files?: string[] } | undefined)?.files ?? [];
  }

  /** Seed with the oldest; add later changes whose files don't overlap, at most one L3, up to batch_max. */
  buildBatch(queue: EventPayload<'land.queued'>[]): EventPayload<'land.queued'>[] {
    const max = this.d.cfg.tests.land.batch_max;
    const batch: EventPayload<'land.queued'>[] = [];
    const files = new Set<string>();
    for (const q of queue) {
      if (batch.length >= max) break;
      const f = this.filesOf(q.issue, q.head);
      if (batch.length && f.some((x) => files.has(x))) continue;
      if (q.level === 'L3' && batch.some((b) => b.level === 'L3')) continue;
      batch.push(q);
      f.forEach((x) => files.add(x));
    }
    return batch;
  }

  private directRefused: string | null = null;
  private remoteIsLocal: boolean | undefined;

  /**
   * Why a direct land may not push the default branch now, or null: GitHub must enforce its protection, asked now
   * (src/direct-land.ts). A refusal is recorded once until the answer changes (coordinator.error: health and the
   * dashboard show it); the queue waits, and lands once protection is back.
   */
  private async directLandBlocked(): Promise<string | null> {
    this.remoteIsLocal ??= localRemote(this.d.repo, this.remote);
    const why = await directLandRefusal(this.d.protection, { repo: this.d.cfg.project.project.repo, branch: this.branch, local: this.remoteIsLocal });
    if (why && why !== this.directRefused) this.emit('coordinator.error', { instance: this.d.instance, where: 'direct land', kind: DIRECT_LAND_REFUSED, message: `nothing pushed: ${why}`.slice(0, 1000) });
    this.directRefused = why;
    return why;
  }

  protected async landNext() {
    // Safety floor: under an emergency stop the queue waits; it lands once the stop is lifted.
    if (this.landing || this.emergencyInForce()) return;
    const queue = this.landQueue();
    if (!queue.length) return;
    this.landing = true;
    try {
      if (this.d.cfg.project.land_mode === 'pr') for (const q of queue) await this.proposePr(q);
      // Direct: not even the gates run while the branch is unprotected (asked again just before the push, too).
      else if (!(await this.directLandBlocked())) await this.landBatch(this.buildBatch(queue));
    } finally {
      this.landing = false;
    }
  }

  private gateTiers(batch: EventPayload<'land.queued'>[]): string[] {
    const gates = this.d.cfg.tests.gates;
    const money = loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source);
    const touchesMoney = batch.some((q) => this.filesOf(q.issue, q.head).some((f) => money.some((re) => re.test(f))) || this.events(q.issue).some((e) => e.type === 'issue.seen' && (e.payload as { labels: string[] }).labels.includes('money-path')));
    return [...new Set([...gates.land, ...(touchesMoney ? gates.money_path : [])])];
  }

  private tierCommand(name: string): { command: string; exclusive: boolean } {
    const t = this.d.cfg.tests.tiers.find((x) => x.name === name);
    if (t) return { command: t.command, exclusive: t.exclusive };
    if (name === 'full') return { command: this.d.cfg.tests.runner.full, exclusive: true };
    return { command: this.d.cfg.tests.runner.changed, exclusive: false };
  }

  /** Run the land gates: baseline-aware, a failure retried once (flake), exclusive tiers under the machine-wide lock. */
  private async runGates(path: string, tiers: string[]): Promise<{ ok: true; notes: string[]; durations: number[] } | { ok: false; deferred: boolean; note: string }> {
    const notes: string[] = [];
    /** Each tier's passing run, in ms (a flake's retry is the run that counts). */
    const durations: number[] = [];
    for (const tier of tiers) {
      const { command, exclusive } = this.tierCommand(tier);
      let lock: { release(): void } | null = null;
      if (exclusive) {
        const got = await fullRunLock(`${BRAND.cli} ${this.d.cfg.project.project.name} land gate ${tier}`, 5_000, this.d.slotsDir);
        if (!('lock' in got)) return { ok: false, deferred: true, note: `tier ${tier} needs the machine-wide full-run slot (held by ${got.holder?.owner ?? 'another run'}); deferred` };
        lock = got.lock;
      }
      try {
        let verdict = null as ReturnType<typeof baselineGate> | null;
        let tail = '';
        let ms = 0;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const t0 = Date.now();
          const r = await this.project(command, path);
          ms = Math.max(0, Date.now() - t0);
          verdict = baselineGate(r.code, r.out, this.d.cfg.tests.failures, latestBaseline(this.d.log));
          tail = r.tail;
          if (verdict.outcome === 'pass') break;
        }
        if (verdict!.outcome === 'fail') return { ok: false, deferred: false, note: `${tier}: ${verdict!.note}${verdict!.newFailures.length ? `: ${verdict!.newFailures.join(', ')}` : ''}\n${tail}` };
        notes.push(`${tier}: ${verdict!.note}`);
        durations.push(ms);
      } finally {
        lock?.release();
      }
    }
    return { ok: true, notes, durations };
  }

  /**
   * Land a batch on the tip in one tested commit. On a red gate: retry once
   * (flake), then split in half and land each half on its own (bors-style
   * bisection); a single change that's still red is ejected with the evidence.
   */
  private async landBatch(batch: EventPayload<'land.queued'>[]): Promise<void> {
    if (!batch.length) return;
    const id = `b-${randomBytes(3).toString('hex')}`;
    const issues = batch.map((q) => q.issue);
    const result = (n: number, outcome: EventPayload<'land.result'>['outcome'], landed: string | null, detail: string) => this.emit('land.result', { issue: n, outcome, landed, detail: `[batch ${id}] ${detail}`.slice(0, 2000) });
    const ownerOf = (n: number) => (this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>).owner;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    this.emit('land.batch', { id, issues, tip, outcome: 'started', detail: '' });
    const name = `land-${id}`;
    const { path, setupErrors } = createWorktree(this.wt, name, `${BRAND.cli}/${name}`, tip);
    let applied: EventPayload<'land.queued'>[] = [];
    let split = false;
    try {
      if (setupErrors.length) {
        for (const n of issues) {
          result(n, 'error', null, `land worktree setup failed: ${setupErrors.join('; ')}`);
          await this.block(n, ownerOf(n), `landing failed: the land worktree's setup failed: ${setupErrors.join('; ')}`);
        }
        return;
      }
      for (const q of batch) {
        const claimed = this.events(q.issue).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>;
        const pick = spawnSync('git', ['cherry-pick', `${claimed.base}..${q.head}`], { cwd: path, encoding: 'utf8' });
        if (pick.status !== 0) {
          spawnSync('git', ['cherry-pick', '--abort'], { cwd: path });
          result(q.issue, 'conflict', null, `does not apply cleanly on ${tip.slice(0, 8)}${applied.length ? ` after ${applied.map((a) => `#${a.issue}`).join(', ')}` : ''}; never guessing at conflicts`);
          await this.block(q.issue, ownerOf(q.issue), `conflicts with ${this.branch}; needs a rebase`);
          continue;
        }
        applied.push(q);
      }
      if (!applied.length) return;
      for (const step of this.d.cfg.tests.land.pre) {
        const r = await this.project(step, path);
        if (r.code !== 0) {
          for (const q of applied) {
            result(q.issue, 'error', null, `pre-land step failed: ${step}\n${r.tail}`);
            await this.block(q.issue, ownerOf(q.issue), `landing failed: the pre-land step \`${step}\` failed\n${r.tail.split('\n').slice(-5).join('\n')}`);
          }
          return;
        }
      }
      if (this.git(path, 'status', '--porcelain')) {
        this.git(path, 'add', '-A');
        this.git(path, '-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`, 'commit', '-q', '-m', `Pre-land steps for ${applied.map((a) => `#${a.issue}`).join(', ')}`);
      }
      const gates = await this.runGates(path, this.gateTiers(applied));
      if (!gates.ok) {
        if (gates.deferred) {
          for (const q of applied) {
            // Capped by time: a slot held past the timeout (a wedged run, a leaked lock) goes to the owner instead of
            // waiting for ever; a long full run that ends within it just delays the land.
            const queuedAt = this.d.log.read(0, ['land.queued']).filter((e) => (e.payload as { issue: number }).issue === q.issue).at(-1)?.id ?? 0;
            const prior = this.d.log
              .read(queuedAt, ['land.result'])
              .filter((e) => (e.payload as EventPayload<'land.result'>).issue === q.issue)
              .map((e) => ({ ...(e.payload as EventPayload<'land.result'>), at: Date.parse(e.ts) }));
            const now = Date.now();
            const since = slotDeferringSince([...prior, { outcome: 'deferred', detail: gates.note, at: now }])!;
            const timeoutMin = this.d.cfg.tests.land.defer_timeout_minutes;
            if (now - since < timeoutMin * 60_000) {
              result(q.issue, 'deferred', null, gates.note);
              continue;
            }
            const why = `deferred for ${Math.round((now - since) / 60_000)} min (tests.yaml land.defer_timeout_minutes: ${timeoutMin}), every time because ${gates.note.replace(/; deferred$/, '')}`;
            result(q.issue, 'error', null, why);
            this.emit('wait.capped', { issue: q.issue, number: null, kind: 'deferred_landing', detail: why.slice(0, 1000) });
            await this.block(q.issue, ownerOf(q.issue), `landing ${why}. Label it \`ready\` again once the slot is free.`);
          }
          this.emit('land.batch', { id, issues, tip, outcome: 'deferred', detail: gates.note.slice(0, 500) });
          return;
        }
        if (applied.length === 1) {
          const q = applied[0]!;
          result(q.issue, 'red', null, gates.note);
          this.emit('land.batch', { id, issues, tip, outcome: 'red', detail: gates.note.slice(0, 500) });
          await this.block(q.issue, ownerOf(q.issue), `land gate red after rebasing onto ${this.branch}: ${gates.note.split('\n')[0]}`);
          return;
        }
        this.emit('land.batch', { id, issues: applied.map((q) => q.issue), tip, outcome: 'split', detail: gates.note.slice(0, 500) });
        split = true;
        return;
      }
      const scan = await scanRange(path, `${tip}..HEAD`);
      if (scan.status !== 'clean') {
        for (const q of applied) {
          result(q.issue, 'rejected', null, `secret scan ${scan.status} at landing`);
          await this.block(q.issue, ownerOf(q.issue), `landing failed: the secret scan at landing found ${scan.status === 'leaks' ? 'possible secrets' : 'it could not run'}; nothing was pushed`);
        }
        return;
      }
      const head = this.git(path, 'rev-parse', 'HEAD');
      // A stop that came in while the gates ran: left queued, landed once it's lifted.
      if (this.emergencyInForce()) {
        for (const q of applied) result(q.issue, 'deferred', null, 'emergency stop in force; lands once it is lifted');
        return;
      }
      // The branch's protection, asked again right before the push: none (or no answer) and nothing is pushed.
      const unprotected = await this.directLandBlocked();
      if (unprotected) {
        for (const q of applied) result(q.issue, 'deferred', null, `not pushed: ${unprotected}`);
        return;
      }
      // A plain (non-force) push only succeeds if the tip hasn't moved: compare-and-swap.
      const push = checkedPush({ cwd: path, remote: this.remote, base: tip, head, ref: `refs/heads/${this.branch}`, limits: this.d.cfg.guardrails.push, guard: this.pushGuard(this.d.cfg.project.land_mode === 'direct') });
      if (!push.ok && 'refused' in push) {
        for (const q of applied) {
          this.emit('push.refused', { issue: q.issue, head, stage: 'push', reasons: push.refused });
          result(q.issue, 'rejected', null, `push refused: ${push.refused.join('; ')}`);
          await this.block(q.issue, ownerOf(q.issue), pushRefusal(push.refused));
        }
        return;
      }
      if (!push.ok) {
        // The tip moved under us: leave them queued; the next tick rebuilds on the new tip.
        for (const q of applied) result(q.issue, 'deferred', null, `push rejected (tip moved): ${push.error.split('\n').pop()}`);
        return;
      }
      this.emit('check.result', { issue: applied[0]!.issue, head, stage: 'land', checks: gates.notes.map((note, i) => ({ check: note, status: 'pass' as const, exitCode: 0, duration_ms: gates.durations[i] ?? 0 })) });
      this.emit('land.batch', { id, issues: applied.map((q) => q.issue), tip, outcome: 'landed', detail: gates.notes.join('; ') });
      for (const q of applied) result(q.issue, 'landed', head, `landed on ${this.branch} (${gates.notes.join('; ')})`);
      for (const q of applied) await this.afterLand(q.issue, head, ownerOf(q.issue));
    } finally {
      removeWorktree(this.wt, name);
      if (split) {
        const mid = Math.ceil(applied.length / 2);
        await this.landBatch(applied.slice(0, mid));
        await this.landBatch(applied.slice(mid));
      }
      applied = [];
    }
  }

  /**
   * land_mode pr: push the task's own branch and open a pull request for a
   * human to merge. The coordinator never merges and never pushes the
   * default branch; the PR closes the issue when it's merged.
   */
  private async proposePr(q: EventPayload<'land.queued'>) {
    const n = q.issue;
    const branch = this.paths(n).branch;
    if (branch === this.branch) throw new Error(`refusing to push the default branch ${this.branch} in pr mode`);
    const claimedBase = (this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>).base;
    const push = checkedPush({ cwd: this.d.repo, remote: this.remote, base: claimedBase, head: q.head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, guard: this.pushGuard(), force: true });
    if (!push.ok && 'refused' in push) {
      this.emit('push.refused', { issue: n, head: q.head, stage: 'push', reasons: push.refused });
      this.emit('land.result', { issue: n, outcome: 'rejected', landed: null, detail: `push refused: ${push.refused.join('; ')}`.slice(0, 2000) });
      await this.block(n, this.ownerOf(n), pushRefusal(push.refused));
      return;
    }
    if (!push.ok) {
      this.emit('land.result', { issue: n, outcome: 'error', landed: null, detail: `pushing ${branch} failed: ${push.error.slice(-500)}` });
      await this.block(n, this.ownerOf(n), `could not push the task branch ${branch}`);
      return;
    }
    const last = <T>(type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => this.events(n).filter((e) => e.type === type).at(-1)?.payload as T | undefined;
    const lvl = last<{ level: string; reasons: string[] }>('review.level_set');
    const verdict = last<EventPayload<'eval.verdict'>>('eval.verdict');
    const checks = last<EventPayload<'check.result'>>('check.result');
    const browser = last<EventPayload<'browser.evidence'>>('browser.evidence');
    const doneWhen = (last<EventPayload<'contract.agreed'>>('contract.agreed')?.done_when ?? []) as DoneWhenList;
    const issue = await this.d.backlog.get(n);
    // The top of the body (src/pr-rules.ts): the worker's intent, and the risk class computed from the changed paths,
    // raised (never lowered) by the worker's own claim. A body without both is refused: no PR opens.
    const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
    const files = this.changeFiles(this.d.repo, claimedBase, q.head);
    const level = computeLevel({ files, labels: issue.labels, moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source) }, review);
    const computed = riskClassOf({ paths: files.map((f) => f.path), level, waitCategories: waitCategoriesOf(review) });
    const claims = last<EventPayload<'worker.claims'>>('worker.claims');
    const cls = effectiveClass(computed.cls, claims?.risk_class);
    const why = cls === computed.cls ? computed.why : [`raised from ${computed.cls} by the worker`, ...computed.why];
    const body = [
      prBodyHead({ intent: claims?.intent ?? '', cls, why }),
      '',
      `Closes #${n}`,
      '',
      `Opened by ${BRAND.name}. It merges this itself only if the instance's merge policy allows (required checks green on the evaluated commit, nothing high-risk, design-level, big or in doubt); otherwise it waits for a human.`,
      '',
      `**Review level:** ${lvl?.level ?? '?'}${lvl?.reasons.length ? ` (${lvl.reasons.slice(0, 6).join('; ')})` : ''}`,
      `**Independent evaluator:** ${verdict ? `${verdict.patch_correct ? 'approves' : 'rejects'}, confidence ${verdict.confidence}${verdict.unverified_claims?.length ? ` (lowered: ${verdict.unverified_claims.length} unverified claim(s))` : ''}${verdict.advice ? `: ${verdict.advice.slice(0, 500)}` : ''}` : 'none'}`,
      ...evalLines(this.instructionResults(n)),
      '',
      ...receiptLines({ checks: checks?.checks ?? [], doneWhen, unverified: verdict?.unverified_claims ?? [] }),
      ...(browser?.head === q.head ? ['', ...browser.lines] : []),
    ].join('\n');
    const refused = prBodyProblems(body, computed.cls);
    if (refused.length) {
      this.emit('land.result', { issue: n, outcome: 'rejected', landed: null, detail: `PR body refused: ${refused.join('; ')}`.slice(0, 2000) });
      await this.block(n, this.ownerOf(n), `no PR opened for ${branch}: its body was refused (${refused.join('; ')})`);
      return;
    }
    let url: string;
    try {
      // A draft until its required checks pass on the commit the evaluator approved (the PR watcher marks it ready).
      const pr = await this.d.backlog.openPr(branch, this.branch, `${issue.title} (#${n})`, body, { draft: true, headSha: q.head });
      url = pr.url;
      this.emit('pr.opened', { issue: n, number: pr.number, url, head: q.head, draft: pr.draft });
    } catch (e) {
      this.emit('land.result', { issue: n, outcome: 'error', landed: null, detail: `opening the PR failed: ${(e as Error).message.slice(0, 500)}` });
      await this.block(n, this.ownerOf(n), `could not open a PR for ${branch}`);
      return;
    }
    this.emit('land.result', { issue: n, outcome: 'pr_opened', landed: null, detail: url });
    const claimed = this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>;
    release(n, claimed.lease, { repo: this.d.repo, remote: this.remote });
    try {
      removeWorktree(this.wt, this.paths(n).name);
    } catch {
      // already gone
    }
    await this.d.backlog.comment(n, `[${BRAND.cli}] Opened ${url} for review. Merging it closes this issue.`);
    this.emit('issue.released', { issue: n, instance: this.d.instance, why: 'pr opened' });
  }

  private async afterLand(n: number, sha: string, owner: string) {
    const claimed = this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>;
    release(n, claimed.lease, { repo: this.d.repo, remote: this.remote });
    try {
      removeWorktree(this.wt, this.paths(n).name);
    } catch {
      // already gone
    }
    await this.d.backlog.removeLabel(n, 'in-review');
    const staging = this.d.cfg.deploy?.environments.find((e) => !e.production && e.trigger);
    if (!staging) {
      await this.d.backlog.comment(n, `[${BRAND.cli}] Landed \`${sha.slice(0, 8)}\` on ${this.branch}. No deploy target configured, so done means landed.`);
      await this.d.backlog.close(n);
      this.emit('issue.released', { issue: n, instance: this.d.instance, why: 'landed' });
      return;
    }
    const ok = await this.deploy(staging.name, staging.trigger!, staging.verify, sha, n);
    await this.d.backlog.comment(n, ok ? `[${BRAND.cli}] Landed \`${sha.slice(0, 8)}\` and verified it on ${staging.name}.` : `[${BRAND.cli}] @${owner} landed \`${sha.slice(0, 8)}\` but ${staging.name} is NOT serving it. Not closing.`);
    if (ok) await this.d.backlog.close(n);
    else {
      await this.d.backlog.addLabels(n, ['blocked']);
      // Released (the claim already was, above), so relabelling it `ready` requeues it.
      this.emit('issue.released', { issue: n, instance: this.d.instance, why: `deploy to ${staging.name} failed` });
    }
  }

  /**
   * Trigger a deploy, then confirm the environment serves the exact sha. A skipped deploy is a failure. `issue`:
   * the issue whose landing triggered it, recorded on each deploy event (so deploy.verified ends that task).
   */
  async deploy(env: string, trigger: string, verify: string, sha: string, issue?: number, polls = 60, pollMs = 15_000): Promise<boolean> {
    const of = issue === undefined ? {} : { issue };
    this.emit('deploy.requested', { env, sha, ...of });
    const t = await sh(trigger, this.d.repo);
    if (t.code !== 0) {
      this.emit('deploy.failed', { env, sha, why: `trigger failed: ${t.tail}`, ...of });
      return false;
    }
    for (let i = 0; i < polls; i++) {
      const v = await sh(verify, this.d.repo, 120_000);
      if (v.code === 0 && v.out.includes(sha)) {
        this.emit('deploy.verified', { env, sha, ...of });
        return true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    this.emit('deploy.failed', { env, sha, why: `${env} did not report ${sha.slice(0, 8)} after ${(polls * pollMs) / 60_000} min`, ...of });
    return false;
  }
}
