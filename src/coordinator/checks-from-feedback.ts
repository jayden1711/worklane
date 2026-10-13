// Repeated "no"s become checks: each tick (when checks_from_feedback is on) the log's sightings are clustered into
// constraints, and one constraint due a proposal gets it: a draft PR with an ast-grep rule and its test cases (the
// repo has sgconfig.yml) or a test, written by one run in a scratch worktree and checked before it is pushed; or an
// issue, when the constraint (its evidence's files, or the draft's) is in a protected area. The PR is never recorded
// as the harness's (no pr.opened) and its branch never auto-merges. See src/checks-from-feedback.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import { astGrepConfig, CHECK_SCHEMA, checkBrief, checkDraft, CHECKS_LABEL, clusterSightings, DEFAULT_SG_TEST_DIR, pathsIn, planProposals, proposalHistory, proposalIssueBody, proposalPrBody, readCheckAnswer, repoUrl, SGCONFIG_FILES, sightingsFromEvents, type CheckMode, type Constraint } from '../checks-from-feedback.js';
import type { EventPayload } from '../events/types.js';
import { FEEDBACK_CHECK_BRANCH_PREFIX } from '../merge-policy.js';
import { checkedPush } from '../push-check.js';
import { rolePrompt } from '../roles.js';
import { removeSandboxPlaceholders } from '../worktrees.js';
import { Gardener } from './gardener.js';

/** The drafting run reads the repo and writes only files (no shell beyond git's read commands and ast-grep). */
export const FEEDBACK_CHECK_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git grep:*)', 'Bash(ast-grep:*)'];
export const FEEDBACK_CHECK_DISALLOWED = ['NotebookEdit'];

export abstract class ChecksFromFeedback extends Gardener {
  /** The proposal in flight (one at a time). */
  protected feedbackChecksRun: Promise<void> = Promise.resolve();
  private feedbackChecksBusy = false;

  /** Start the next constraint's proposal, when one is due and none is running. */
  async checkFeedbackChecks(): Promise<void> {
    const cfg = this.d.cfg.project.checks_from_feedback;
    if (!cfg.enabled || this.feedbackChecksBusy || this.halt.signal.aborted || this.stopped || this.usagePause()) return;
    const events = this.d.log.read();
    const constraints = clusterSightings(sightingsFromEvents(events, this.d.cfg.project.owners.writers));
    const plan = planProposals(constraints, proposalHistory(events), { minSightings: cfg.min_sightings, maxPerWeek: cfg.max_proposals_per_week, now: this.d.now?.() ?? new Date() });
    const next = plan.propose[0];
    if (!next) return;
    this.feedbackChecksBusy = true;
    this.feedbackChecksRun = this.proposeCheck(next)
      .catch((e: Error) => void this.emit('coordinator.error', { instance: this.d.instance, where: 'checks from feedback', kind: 'error', message: e.message.slice(0, 500) }))
      .finally(() => {
        this.feedbackChecksBusy = false;
      });
  }

  /** Files the evidence is about: those its PRs' changes touched, and paths the words name. */
  private evidencePaths(c: Constraint): string[] {
    const issues = new Set([...c.sightings, ...c.reverts].map((s) => s.issue).filter((n) => n !== null));
    const files = this.d.log
      .read(0, ['change.proposed'])
      .map((e) => e.payload as EventPayload<'change.proposed'>)
      .filter((p) => issues.has(p.issue))
      .flatMap((p) => p.files);
    return [...new Set([...files, ...c.sightings.flatMap((s) => pathsIn(s.words))])];
  }

  private async proposeCheck(c: Constraint): Promise<void> {
    const keys = c.sightings.map((s) => s.key);
    const isProtected = this.protectedPath();
    const touched = this.evidencePaths(c).filter(isProtected);
    if (touched.length) return this.fileIssue(c, keys, `the evidence is about ${touched.slice(0, 5).join(', ')}`, null);
    const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
    if (left <= 0) return;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const dir = join(this.d.stateDir, 'feedback-checks', c.id);
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.d.repo });
    try {
      this.git(this.d.repo, 'worktree', 'add', '-q', '--detach', dir, tip);
      const mode = checkMode(dir);
      const role = this.d.cfg.agents.roles.corrections ?? this.d.cfg.agents.roles.workers!;
      const r = await this.d.runner.run({
        env: this.projectEnv(),
        role: 'feedback-checks',
        stateDir: this.d.stateDir,
        prompt: checkBrief(c, mode),
        appendSystemPrompt: rolePrompt(this.d.cfg, 'feedback-checks'),
        cwd: dir,
        model: role.model,
        allowedTools: FEEDBACK_CHECK_TOOLS,
        disallowedTools: FEEDBACK_CHECK_DISALLOWED,
        maxTurns: 80,
        maxBudgetUsd: Math.min(role.budget_usd ?? 3, Math.max(0.1, left)),
        jsonSchema: CHECK_SCHEMA,
        stallMs: 20 * 60_000,
        timeoutMs: this.commandTimeoutMs,
      });
      this.emit('run.cost', { issue: null, role: 'feedback-checks', model: r.model, usd: r.costUsd, turns: r.turns });
      const drop = (why: string, failed: boolean) => void this.emit('feedback_check.dropped', { constraint: c.id, keys, why: why.slice(0, 1000), failed });
      if (r.reason !== 'succeeded') return drop(`the drafting run ended: ${r.reason} (${r.detail.slice(0, 300)})`, true);
      const a = readCheckAnswer(r.structured);
      if (a.act === 'none') return drop(`no check fits: ${a.why}`, false);
      if (a.act === 'invalid') return drop(a.why, true);
      removeSandboxPlaceholders(dir);
      this.git(dir, 'add', '-A', '--', '.');
      const files = this.git(dir, 'diff', '--cached', '--name-status', '--no-renames')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [status, path] = l.split('\t') as [string, string];
          return { status, path, content: status.startsWith('D') ? '' : readFileSync(join(dir, path), 'utf8') };
        });
      const ok = checkDraft(mode, files);
      if (!ok.ok) return drop(`the draft was refused: ${ok.why}`, true);
      const draft = files.map((f) => `\`${f.path}\`:\n\n\`\`\`\n${f.content.slice(0, 4000)}\n\`\`\``).join('\n\n');
      const inProtected = files.map((f) => f.path).filter(isProtected);
      if (inProtected.length) return this.fileIssue(c, keys, `the check itself would go in ${inProtected.join(', ')}`, draft);
      this.git(dir, '-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-s', '-m', `${a.title}\n\nA check proposed from repeated feedback (constraint ${c.id}, seen ${c.sightings.length} times).`);
      const head = this.git(dir, 'rev-parse', 'HEAD');
      const branch = `${FEEDBACK_CHECK_BRANCH_PREFIX}${c.id}`;
      const push = checkedPush({ cwd: dir, remote: this.remote, base: tip, head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, guard: this.pushGuard(), force: true });
      if (!push.ok) return drop(`the push was refused: ${('refused' in push ? push.refused.join('; ') : push.error).slice(0, 500)}`, true);
      const pr = await this.d.backlog.openPr(branch, this.branch, a.title, proposalPrBody({ c, mode, summary: a.summary, brand: BRAND.name }), { draft: true, headSha: head });
      await this.d.backlog.addLabels(pr.number, [CHECKS_LABEL]).catch(() => undefined);
      this.emit('feedback_check.proposed', { constraint: c.id, keys, kind: 'pr', number: pr.number, url: pr.url, mode: mode.kind, why: a.summary.slice(0, 1000) });
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.d.repo });
      spawnSync('git', ['worktree', 'prune'], { cwd: this.d.repo });
    }
  }

  /** A protected area: an issue for a person to decide the check (never `ready`: no agent builds it). */
  private async fileIssue(c: Constraint, keys: string[], why: string, draft: string | null): Promise<void> {
    const title = `Repeated feedback, a protected area: ${c.label.slice(0, 90)}`;
    const n = await this.d.backlog.createIssue(title, proposalIssueBody({ c, why, draft, brand: BRAND.name }), [CHECKS_LABEL]);
    const repo = repoUrl(this.d.log.read(0, ['pr.opened', 'merge.done']));
    const url = repo ? `${repo}/issues/${n}` : `#${n}`;
    this.emit('feedback_check.proposed', { constraint: c.id, keys, kind: 'issue', number: n, url, mode: 'issue', why: why.slice(0, 1000) });
  }
}

/** Where the check goes: ast-grep's rule and test dirs when the checkout has sgconfig.yml with a rule dir, else a test. */
export function checkMode(dir: string): CheckMode {
  for (const f of SGCONFIG_FILES) {
    if (!existsSync(join(dir, f))) continue;
    const sg = astGrepConfig(readFileSync(join(dir, f), 'utf8'));
    if (sg) return { kind: 'ast-grep', ruleDir: sg.ruleDir, testDir: sg.testDir ?? DEFAULT_SG_TEST_DIR, sgconfig: f, addTestDir: sg.testDir === null };
  }
  return { kind: 'test' };
}
