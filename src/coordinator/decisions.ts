// Decisions: held plans, refused hosts, and the owner's answers on issues.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import type { ReviewConfig } from '../config/schema.js';
import { type DoneWhenList, type Issue } from '../backlog/types.js';
import { claim, release } from '../claims.js';
import type { EventPayload } from '../events/types.js';
import { loadMoneyPaths } from '../review.js';
import { issueBrief } from '../roles.js';
import { checkedPush } from '../push-check.js';
import { domainDecision, withAllowedHost, type DomainAnswer, type RefusedRequest } from '../domain-requests.js';
import { decisionsMade, objection, PLAN_DISALLOWED, PLAN_SCHEMA, PLAN_TOOLS, planAnswer, planComment, planDecision, planExtra, planHoldReasons, readPlan, type Plan, type PlanAnswer } from '../plan-mode.js';
import { Recovery } from './recovery.js';
import { laneOf, DEFAULT_REVIEW } from './shared.js';
import { routeRun } from './model-routing.js';

export abstract class Decisions extends Recovery {
  // ---------------------------------------------------------------- decisions

  /** Decisions answered by CLI (decision.answered) or by a writer's `/<cli> <option>` comment. */
  /**
   * The plan for a size:M/L task. After the owner approved a held plan: that plan. Otherwise a read-only plan
   * run (with the owner's note after a revise), posted on the issue; one touching high-risk or design-level
   * areas is held as the owner's decision (the claim is released and the task stops: 'stop').
   */
  protected async planStep(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, owner: string): Promise<{ plan: Plan; commentsAt: number } | { stop: true }> {
    const n = issue.number;
    const last = this.events(n).filter((e) => e.type === 'plan.posted' || e.type === 'plan.decided').at(-1);
    const decided = last?.type === 'plan.decided' ? (last.payload as EventPayload<'plan.decided'>) : null;
    if (decided?.answer === 'approve') {
      const posted = this.events(n).filter((e) => e.type === 'plan.posted').at(-1)!.payload as EventPayload<'plan.posted'>;
      return { plan: posted.plan as unknown as Plan, commentsAt: (await this.d.backlog.comments(n)).length };
    }
    const note = decided?.answer === 'revise' ? decided.note : null;
    const workers = this.d.cfg.agents.roles.workers!;
    const planModel = routeRun(this.d.cfg, 'planner');
    const r = await this.d.runner.run({
      env: this.projectEnv(),
      role: 'planner',
      ...laneOf(issue),
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, [...planExtra(), ...decisionsMade(this.d.log.read(0, ['decision.asked', 'decision.answered'])), ...(note ? ['', `The owner asked for a revised plan: ${note}`] : [])]),
      cwd: path,
      model: planModel,
      allowedTools: PLAN_TOOLS,
      disallowedTools: PLAN_DISALLOWED,
      maxTurns: 60,
      maxBudgetUsd: Math.min(workers.budget_usd ?? 10, Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday())),
      jsonSchema: PLAN_SCHEMA,
      stallMs: 20 * 60_000,
      timeoutMs: this.commandTimeoutMs,
      onStart: (p) => this.emit('run.started', { issue: n, role: 'planner', model: planModel, worktree: path, pid: p, pgid: p, attempt: 1 }),
    });
    this.cost(n, 'planner', r);
    this.emit('run.finished', { issue: n, role: 'planner', reason: r.reason, detail: r.detail.slice(0, 1000) });
    if (r.reason !== 'succeeded') {
      await this.block(n, owner, `the plan run ended: ${r.reason} (${r.detail.slice(0, 300)})`);
      return { stop: true };
    }
    const plan = readPlan(r.structured);
    if ('invalid' in plan) {
      await this.block(n, owner, plan.invalid);
      return { stop: true };
    }
    const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
    const reasons = planHoldReasons(plan, { review, moneyPaths: loadMoneyPaths(this.d.repo, review.money_path_source), existsAtBase: (d) => spawnSync('git', ['cat-file', '-e', `${base}:${d}`], { cwd: this.d.repo }).status === 0 });
    await this.d.backlog.comment(n, planComment(plan, owner, reasons));
    const commentsAt = (await this.d.backlog.comments(n)).length;
    if (reasons.length) {
      const d = planDecision(reasons);
      const id = await this.ask('plan', n, owner, d.question, d.options, d.recommendation, d.receipts);
      this.emit('plan.posted', { issue: n, plan: plan as unknown as Record<string, unknown>, held: true, reasons, comments_at: commentsAt, decision: id });
      await this.d.backlog.removeLabel(n, 'agent:working');
      this.releaseClaim(n, 'plan held for the owner');
      return { stop: true };
    }
    this.emit('plan.posted', { issue: n, plan: plan as unknown as Record<string, unknown>, held: false, reasons: [], comments_at: commentsAt, decision: null });
    return { plan, commentsAt };
  }

  /** An objection to a plan that is being built: the task stops (blocked, saying who objected and why). */
  protected async planObjected(n: number, owner: string, commentsAt: number): Promise<boolean> {
    const o = objection(await this.d.backlog.comments(n), commentsAt, [owner, ...this.d.cfg.project.owners.writers]);
    if (!o) return false;
    this.emit('plan.objected', { issue: n, by: o.by, why: o.why.slice(0, 500) });
    await this.block(n, owner, `@${o.by} objected to the plan: ${o.why}`);
    return true;
  }

  /** The owner's answer on a held plan: approve and revise put the task back to ready; reject stops it. */
  private async handlePlanDecision(askedId: number, q: EventPayload<'decision.asked'>, writers: Set<string>, cmd: RegExp) {
    const n = q.issue!;
    if (this.d.log.read(askedId, ['plan.decided']).some((e) => (e.payload as { decision: string }).decision === q.id)) return;
    let a = this.d.log.read(askedId, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === q.id);
    let body = '';
    if (!a) {
      const reply = (await this.d.backlog.comments(n))
        .filter((c) => writers.has(c.author.toLowerCase()))
        .map((c) => ({ by: c.author, body: c.body, m: c.body.match(cmd) }))
        .filter((x) => x.m && q.options.includes(x.m[1]!))
        .at(-1);
      if (!reply) return;
      body = reply.body;
      a = this.emit('decision.answered', { id: q.id, by: reply.by, answer: reply.m![1]! }).payload;
    }
    const act = planAnswer(a.answer, body);
    const answer = a.answer as PlanAnswer;
    this.emit('plan.decided', { issue: n, decision: q.id, answer, by: a.by, note: act.act === 'replan' ? act.note.slice(0, 2000) : '' });
    await this.d.backlog.removeLabel(n, 'needs:decision');
    if (act.act === 'stop') {
      await this.d.backlog.comment(n, `[${BRAND.cli}] @${a.by} rejected the plan; nothing is built.`);
      return;
    }
    await this.d.backlog.addLabels(n, ['ready']);
    await this.d.backlog.comment(n, `[${BRAND.cli}] @${a.by} ${act.act === 'build' ? 'approved the plan; the build starts with it' : `asked for a revised plan: ${act.note}`}.`);
  }

  /** Each newly refused host for a task: recorded, and asked of the owner, once per task and host. */
  protected async noteRefusedHosts(issue: number, role: string, run: string | null, refused: RefusedRequest[]) {
    const asked = new Set(this.d.log.read(0, ['network.domain_requested']).map((e) => e.payload as EventPayload<'network.domain_requested'>).filter((p) => p.issue === issue).map((p) => p.host));
    for (const r of refused) {
      if (asked.has(r.host)) continue;
      asked.add(r.host);
      const d = domainDecision({ ...r, issue, role, run: run ?? 'unknown' }, `${BRAND.configDir}/guardrails.yaml`);
      const id = await this.ask('domain', issue, this.ownerOf(issue), d.question, d.options, d.recommendation, d.receipts);
      this.emit('network.domain_requested', { issue, host: r.host, role, run, tool: r.tool, what: r.what.slice(0, 300), decision: id });
    }
  }

  /** The owner's answer on a refused host: recorded, and an allow-repo answer opens the config change as a PR. */
  private async handleDomainDecision(askedId: number, q: EventPayload<'decision.asked'>, writers: Set<string>, cmd: RegExp) {
    const issue = q.issue!;
    if (this.d.log.read(askedId, ['network.domain_decided']).some((e) => (e.payload as { decision: string }).decision === q.id)) return;
    const req = this.d.log.read(askedId, ['network.domain_requested']).map((e) => e.payload as EventPayload<'network.domain_requested'>).find((p) => p.decision === q.id);
    if (!req) return;
    let a = this.d.log.read(askedId, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === q.id);
    if (!a) {
      const reply = (await this.d.backlog.comments(issue))
        .filter((c) => writers.has(c.author.toLowerCase()))
        .map((c) => ({ by: c.author, m: c.body.match(cmd) }))
        .filter((x) => x.m && q.options.includes(x.m[1]!))
        .at(-1);
      if (!reply) return;
      a = this.emit('decision.answered', { id: q.id, by: reply.by, answer: reply.m![1]! }).payload;
    }
    await this.d.backlog.removeLabel(issue, 'needs:decision');
    const answer = a.answer as DomainAnswer;
    let pr: string | null = null;
    let detail = '';
    if (answer === 'allow-repo') {
      const r = await this.proposeAllowedHost(req.host);
      pr = r.pr;
      detail = r.detail;
    } else detail = answer === 'allow-once' ? "the task's next run may reach it" : 'nothing changes';
    this.emit('network.domain_decided', { issue, host: req.host, decision: q.id, answer, by: a.by, pr, detail: detail.slice(0, 500) });
    await this.d.backlog.comment(issue, `[${BRAND.cli}] ${req.host}: @${a.by} answered ${answer}. ${pr ? `Proposed as ${pr}; it applies once merged.` : detail}`);
  }

  /**
   * The guardrails change that allows a host for this repo, opened as a pull request on its own branch (built
   * from the default branch with git plumbing: no worktree, no setup). Never applied in place.
   */
  private async proposeAllowedHost(host: string): Promise<{ pr: string | null; detail: string }> {
    const file = `${BRAND.configDir}/guardrails.yaml`;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const base = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const shown = spawnSync('git', ['show', `${base}:${file}`], { cwd: this.d.repo, encoding: 'utf8' });
    if (shown.status !== 0) return { pr: null, detail: `${file} isn't on ${this.branch}, so no change was proposed` };
    const next = withAllowedHost(shown.stdout, host);
    if (next === null) return { pr: null, detail: `${host} is already allowed on ${this.branch}` };
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: this.d.repo, encoding: 'utf8', input: next }).stdout.trim();
    const index = join(this.d.stateDir, `allow-${randomBytes(3).toString('hex')}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: this.identity.name, GIT_AUTHOR_EMAIL: this.identity.email, GIT_COMMITTER_NAME: this.identity.name, GIT_COMMITTER_EMAIL: this.identity.email };
    const g = (args: string[], input?: string) => {
      const r = spawnSync('git', args, { cwd: this.d.repo, encoding: 'utf8', env, ...(input !== undefined ? { input } : {}) });
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim().slice(-300)}`);
      return r.stdout.trim();
    };
    let head: string;
    try {
      g(['read-tree', base]);
      g(['update-index', '--cacheinfo', `100644,${blob},${file}`]);
      head = g(['commit-tree', g(['write-tree']), '-p', base], `Allow agents to reach ${host}\n\nThe owner answered allow-repo to a refused request for ${host}.\n`);
    } finally {
      rmSync(index, { force: true });
    }
    const branch = `${BRAND.cli}/allow-${host.replace(/[^A-Za-z0-9.-]/g, '-')}`;
    const push = checkedPush({ cwd: this.d.repo, remote: this.remote, base, head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, guard: this.pushGuard(), force: true });
    if (!push.ok) return { pr: null, detail: `the config change couldn't be pushed: ${'refused' in push ? push.refused.join('; ') : push.error.split('\n').pop()}` };
    const opened = await this.d.backlog.openPr(branch, this.branch, `Allow agents to reach ${host}`, `Adds \`${host}\` to \`${file}\` \`network.allow\`, as the owner answered (allow-repo) to an agent's refused request for it. It applies once a human merges this; ${BRAND.name} never merges its own config changes.`);
    return { pr: opened.url, detail: '' };
  }

  protected async handleDecisions() {
    const writers = new Set(this.d.cfg.project.owners.writers.map((w) => w.toLowerCase()));
    const cmd = new RegExp(`^/${BRAND.cli}\\s+(\\S+)`, 'm');
    for (const asked of this.d.log.read(0, ['decision.asked'])) {
      const q = asked.payload as EventPayload<'decision.asked'>;
      if (q.issue === null) continue;
      if (q.kind === 'domain') {
        await this.handleDomainDecision(asked.id, q, writers, cmd);
        continue;
      }
      if (q.kind === 'plan') {
        await this.handlePlanDecision(asked.id, q, writers, cmd);
        continue;
      }
      const later = this.events(q.issue).filter((e) => e.id > asked.id);
      // Already acted on: something moved the task on since the question.
      if (later.some((e) => e.type === 'land.queued' || e.type === 'issue.released')) continue;
      let a = this.d.log.read(asked.id, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === q.id);
      if (!a) {
        const reply = (await this.d.backlog.comments(q.issue))
          .filter((c) => writers.has(c.author.toLowerCase()))
          .map((c) => ({ by: c.author, m: c.body.match(cmd) }))
          .filter((x) => x.m && q.options.includes(x.m[1]!))
          .at(-1);
        if (!reply) continue;
        a = this.emit('decision.answered', { id: q.id, by: reply.by, answer: reply.m![1]! }).payload;
      }
      await this.d.backlog.removeLabel(q.issue, 'needs:decision');
      if (q.kind === 'land') {
        const level = this.events(q.issue).filter((e) => e.type === 'review.level_set').at(-1)?.payload as EventPayload<'review.level_set'> | undefined;
        if (a.answer === 'approve' && level) this.emit('land.queued', { issue: q.issue, head: level.head, level: level.level });
        else {
          await this.d.backlog.comment(q.issue, `[${BRAND.cli}] Not landing: @${a.by} answered ${a.answer}.`);
          this.releaseClaim(q.issue, `landing ${a.answer} by ${a.by}`);
        }
      } else {
        const issue = await this.d.backlog.get(q.issue);
        this.releaseClaim(q.issue, `question answered by ${a.by}`);
        await this.d.backlog.removeLabel(q.issue, 'in-review');
        if (issue.labels.includes('type:investigation') && a.answer !== 'investigate-more') {
          // Investigations never turn into code changes on their own.
          await this.d.backlog.comment(
            q.issue,
            a.answer === 'close'
              ? `[${BRAND.cli}] @${a.by} closed the investigation.`
              : `[${BRAND.cli}] @${a.by} approved a fix. Give the fix its own done_when contract (in this issue or a new one), remove \`type:investigation\`, and mark it ready.`,
          );
          if (a.answer === 'close') await this.d.backlog.close(q.issue);
        } else {
          // A worker's question: release and requeue; the next run gets the answer in its brief.
          await this.d.backlog.comment(q.issue, `[${BRAND.cli}] @${a.by} answered: ${a.answer}. Requeued.`);
          await this.d.backlog.addLabels(q.issue, ['ready']);
        }
      }
    }
  }

  /** Answers to this issue's earlier questions, for the next worker's brief. */
  protected answers(issue: number): string[] {
    const asked = new Map(this.d.log.read(0, ['decision.asked']).map((e) => [(e.payload as { id: string }).id, e.payload as EventPayload<'decision.asked'>]));
    return this.d.log
      .read(0, ['decision.answered'])
      .map((e) => e.payload as EventPayload<'decision.answered'>)
      .filter((a) => asked.get(a.id)?.issue === issue && asked.get(a.id)?.kind === 'question')
      .map((a) => `Owner decision: "${asked.get(a.id)!.question}" -> ${a.answer} (by ${a.by})`)
      .concat(this.researchNote(issue));
  }
}
