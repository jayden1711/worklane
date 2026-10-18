// The gardener's schedule and run: due once per period at an off-hours time, one read-only run within its budget,
// every finding appended to the instance's one log issue, and a fix filed only for a pattern seen 3+ times, at most
// max_prs per run, never in a high-risk or safety-floor path. Filed without `ready`: the owner chooses which get
// built. See src/gardener.ts.
import type { ReviewConfig } from '../config/schema.js';
import { protectedCategories } from '../delegation.js';
import type { EventPayload } from '../events/types.js';
import { GARDENER_LABEL, GARDENER_LOG_LABEL, GARDENER_SCHEMA, gardenerBrief, gardenerDue, gardenerLogMarker, gardenerSignals, logEntry, patternHistory, readFindings, toFile, type Finding } from '../gardener.js';
import { waitCategoriesOf } from '../merge-policy.js';
import { computeLevel, loadMoneyPaths } from '../review.js';
import { rolePrompt } from '../roles.js';
import { Delegation } from './delegation.js';
import { DEFAULT_REVIEW, lockScopeOf } from './shared.js';
import { CORRECTIONS_DISALLOWED, CORRECTIONS_TOOLS } from './corrections.js';

export abstract class Gardener extends Delegation {
  /** The gardener run in flight. */
  protected gardenerRun: Promise<void> = Promise.resolve();
  private gardenerBusy = false;

  /** Start the gardener when it is due (one run at a time). */
  async checkGardener(): Promise<void> {
    const g = this.d.cfg.project.gardener;
    if (!g.enabled || this.gardenerBusy || this.halt.signal.aborted || this.stopped || this.usagePause() || this.authHeld() || this.diskHeld()) return;
    const last = (this.d.log.read(0, ['gardener.run']).at(-1)?.payload as EventPayload<'gardener.run'> | undefined)?.started_at ?? null;
    if (!gardenerDue(this.d.now?.() ?? new Date(), last, { everyDays: g.every_days, at: g.at })) return;
    this.gardenerBusy = true;
    const startedAt = (this.d.now?.() ?? new Date()).toISOString();
    this.gardenerRun = this.garden(startedAt)
      .catch((e: Error) => void this.emit('coordinator.error', { instance: this.d.instance, where: 'gardener', kind: 'error', message: e.message.slice(0, 500) }))
      .finally(() => {
        this.gardenerBusy = false;
      });
  }

  /** A path the gardener never fixes: anything the merge policy treats as high-risk, or a safety floor. */
  protected protectedPath(): (path: string) => boolean {
    const review: ReviewConfig = this.d.cfg.review ?? DEFAULT_REVIEW;
    const never = new Set([...protectedCategories(review), ...waitCategoriesOf(review)]);
    const money = loadMoneyPaths(this.d.repo, review.money_path_source);
    const scope = lockScopeOf(this.d);
    return (path) => Object.keys(computeLevel({ files: [{ path, added: 0, removed: 0 }], labels: [], moneyPaths: money, scope }, review).categories).some((c) => never.has(c));
  }

  private async garden(startedAt: string): Promise<void> {
    const g = this.d.cfg.project.gardener;
    const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
    const done = (outcome: string, o: { findings?: number; filed?: number[]; cost?: number; log?: number | null } = {}) =>
      void this.emit('gardener.run', { started_at: startedAt, findings: o.findings ?? 0, filed: o.filed ?? [], cost_usd: o.cost ?? 0, log_issue: o.log ?? this.gardenerLogIssue(), outcome });
    if (left <= 0) return done(`the daily budget ($${this.d.cfg.agents.daily_budget_usd}) is spent`);
    const events = this.d.log.read();
    const signals = gardenerSignals(events);
    const history = patternHistory(events);
    const role = this.d.cfg.agents.roles.gardener ?? this.d.cfg.agents.roles.workers!;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const r = await this.d.runner.run({
      env: this.projectEnv(),
      role: 'gardener',
      stateDir: this.d.stateDir,
      prompt: gardenerBrief(signals, history),
      appendSystemPrompt: rolePrompt(this.d.cfg, 'gardener'),
      cwd: this.d.repo,
      model: role.model,
      allowedTools: CORRECTIONS_TOOLS,
      disallowedTools: CORRECTIONS_DISALLOWED,
      maxTurns: 120,
      maxBudgetUsd: Math.max(0.1, Math.min(g.max_usd, left)),
      jsonSchema: GARDENER_SCHEMA,
      stallMs: 20 * 60_000,
      timeoutMs: this.commandTimeoutMs,
    });
    this.emit('run.cost', { issue: null, role: 'gardener', model: r.model, usd: r.costUsd, turns: r.turns });
    if (r.reason !== 'succeeded') return done(`the gardener run ended: ${r.reason} (${r.detail.slice(0, 300)})`, { cost: r.costUsd });
    const read = readFindings(r.structured);
    // The log's own signals are findings too, unless the run reported the same pattern.
    const findings: Finding[] = [...read.findings, ...signals.filter((s) => !read.findings.some((f) => f.pattern === s.pattern))];
    for (const f of findings) this.emit('gardener.finding', { pattern: f.pattern, kind: f.kind, where: f.where, detail: f.detail });
    const plan = toFile(findings, history, { maxPrs: g.max_prs, isProtected: this.protectedPath() });
    const filed: { pattern: string; issue: number }[] = [];
    for (const f of plan.file) {
      const n = await this.d.backlog.createIssue(f.fix!.title, `${f.fix!.body}\n\n_From the gardener: pattern \`${f.pattern}\`, seen in ${f.where.length} place(s) this run. Label it \`ready\` to have it built._`, [GARDENER_LABEL]);
      this.emit('gardener.filed', { pattern: f.pattern, issue: n });
      filed.push({ pattern: f.pattern, issue: n });
    }
    const log = await this.ensureGardenerLog();
    await this.d.backlog.comment(log, logEntry({ at: startedAt, findings, filed, held: plan.held, refused: read.refused, costUsd: r.costUsd }));
    done('done', { findings: findings.length, filed: filed.map((f) => f.issue), cost: r.costUsd, log });
  }

  private gardenerLogIssue(): number | null {
    for (const e of this.d.log.read(0, ['gardener.run']).reverse()) {
      const n = (e.payload as EventPayload<'gardener.run'>).log_issue;
      if (n) return n;
    }
    return null;
  }

  /** The instance's one log issue: the one recorded, or found by its marker, or opened now. */
  private async ensureGardenerLog(): Promise<number> {
    const known = this.gardenerLogIssue();
    if (known) return known;
    const marker = gardenerLogMarker(this.d.instance);
    const found = (await this.d.backlog.list(GARDENER_LOG_LABEL)).find((i) => i.body.includes(marker));
    if (found) return found.number;
    return this.d.backlog.createIssue(`Gardener log (${this.d.instance})`, `What the gardener finds on each run, appended below. Fixes are filed as their own issues (label \`${GARDENER_LABEL}\`) only for a pattern seen 3 or more times.\n\n${marker}`, [GARDENER_LOG_LABEL]);
  }
}
