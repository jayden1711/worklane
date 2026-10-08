// The coordinator: deterministic code (no LLM) that claims, schedules,
// verifies, levels, lands and deploys. Every step is an event; the next
// step is decided from events plus GitHub, so a restart picks up where the
// log says it was. Agents only ever propose: they commit on their own
// branch in their own worktree; everything outward-facing happens here.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { actionable, ownerFor, parseContract, type Backlog, type DoneWhenList, type Issue } from './backlog/types.js';
import { claim, release, renew, type Lease } from './claims.js';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { globToRegExp } from './guardrails/glob.js';
import { childEnv } from './os/index.js';
import { computeLevel, loadMoneyPaths, type ChangeFile, type Level } from './review.js';
import { issueBrief, REPRO_SCHEMA, rolePrompt, VERDICT_SCHEMA, WORKER_SCHEMA } from './roles.js';
import type { AgentRunner, RunResult } from './runner.js';
import { scanPath } from './scan/secrets.js';
import { tryAgentSlot } from './slots.js';
import { countAssertions } from './vacuity.js';
import { createWorktree, removeWorktree, type WorktreeOptions } from './worktrees.js';

export interface CoordinatorDeps {
  cfg: Config;
  log: EventLog;
  backlog: Backlog;
  runner: AgentRunner;
  /** The coordinator's own clone of the project (it fetches, lands and pushes here). */
  repo: string;
  remote?: string;
  instance: string;
  stateDir: string;
  /** Slot directory override (tests). */
  slotsDir?: string;
  maxAttempts?: number;
  leaseMs?: number;
}

const COMMAND_TIMEOUT_MS = 2 * 3600_000;

function sh(command: string, cwd: string, timeoutMs = COMMAND_TIMEOUT_MS) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env: childEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.error ? null : r.status, tail: out.trim().split('\n').slice(-20).join('\n'), out };
}

export class Coordinator {
  private readonly remote: string;
  private readonly wt: WorktreeOptions;
  private active = new Map<number, Promise<void>>();
  private landing = false;
  private stopped = false;

  constructor(private d: CoordinatorDeps) {
    this.remote = d.remote ?? 'origin';
    this.wt = { repo: d.repo, root: d.cfg.tests.worktree.root, stateDir: d.stateDir, setup: d.cfg.tests.worktree.setup };
  }

  private get branch() {
    return this.d.cfg.project.project.default_branch;
  }
  private git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  private emit<T extends Parameters<EventLog['append']>[0]>(type: T, payload: EventPayload<T>) {
    return this.d.log.append(type, payload, this.d.instance);
  }
  private events(issue?: number): StoredEvent[] {
    const all = this.d.log.read();
    return issue === undefined ? all : all.filter((e) => (e.payload as { issue?: number }).issue === issue);
  }

  /** USD spent today (UTC) by all runs, from the log. */
  spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    return this.d.log.read(0, ['run.cost']).filter((e) => e.ts.startsWith(day)).reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
  }

  // ---------------------------------------------------------------- tick

  /** One deterministic pass: reconcile, handle approvals, land, dispatch. */
  async tick(): Promise<void> {
    let dispatched = 0;
    let reconciled = 0;
    try {
      reconciled = await this.reconcile();
      await this.handleDecisions();
      await this.landNext();
      dispatched = await this.dispatch();
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.instance, where: 'tick', kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    }
    this.emit('coordinator.tick', { instance: this.d.instance, dispatched, reconciled });
  }

  /**
   * After a crash or restart: a task that was mid-pipeline (claimed, not yet
   * queued for landing or waiting on a decision) has no live run anymore, so
   * it's released and requeued; its history stays in the log. Queued
   * landings and open decisions resume from the log on their own.
   */
  async recover(): Promise<number[]> {
    const requeued: number[] = [];
    for (const e of this.d.log.read(0, ['issue.claimed'])) {
      const n = (e.payload as { issue: number }).issue;
      if (this.isTerminal(n) || this.active.has(n) || requeued.includes(n)) continue;
      const after = this.events(n).filter((x) => x.id > e.id);
      const waiting = after.some((x) => x.type === 'land.queued' || x.type === 'decision.asked');
      if (waiting) continue;
      this.releaseClaim(n, 'coordinator restarted mid-task; requeued');
      await this.d.backlog.removeLabel(n, 'agent:working');
      await this.d.backlog.addLabels(n, ['ready']);
      await this.d.backlog.comment(n, `[${BRAND.cli}] The coordinator restarted while this was in progress; requeued from the start.`);
      requeued.push(n);
    }
    return requeued;
  }

  /** Wait for in-flight task pipelines (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()]);
  }

  stop() {
    this.stopped = true;
  }

  private async reconcile(): Promise<number> {
    // Tasks whose issue was closed elsewhere are cancelled, never re-dispatched.
    let n = 0;
    for (const e of this.d.log.read(0, ['issue.claimed'])) {
      const issue = (e.payload as { issue: number }).issue;
      if (this.isTerminal(issue)) continue;
      const gh = await this.d.backlog.get(issue);
      if (gh.state === 'closed') {
        this.emit('issue.released', { issue, instance: this.d.instance, why: 'issue closed on GitHub' });
        n++;
      }
    }
    return n;
  }

  private isTerminal(issue: number): boolean {
    const last = this.events(issue).filter((e) => ['issue.released', 'deploy.verified', 'land.result', 'issue.claimed'].includes(e.type)).at(-1);
    if (!last) return true;
    if (last.type === 'issue.released' || last.type === 'deploy.verified') return true;
    if (last.type === 'land.result') return (last.payload as { outcome: string }).outcome === 'landed' && !this.d.cfg.deploy?.environments.some((x) => !x.production && x.trigger);
    return false;
  }

  private async dispatch(): Promise<number> {
    if (this.stopped) return 0;
    const workers = this.d.cfg.agents.roles.workers;
    if (!workers?.enabled) return 0;
    if (this.active.size >= (workers.count ?? 1)) return 0;
    if (this.spentToday() >= this.d.cfg.agents.daily_budget_usd) return 0;
    for (const issue of await this.d.backlog.list('ready')) {
      if (this.active.has(issue.number) || !this.isTerminal(issue.number)) continue;
      const act = await actionable(issue, this.d.cfg.project.owners.writers, this.d.backlog);
      const contract = parseContract(issue.body);
      this.emit('issue.seen', { issue: issue.number, title: issue.title, labels: issue.labels, author: issue.author, owner: null, actionable: act.actionable && contract.ok, why: act.actionable ? (contract.ok ? act.why : contract.why) : act.why });
      if (!act.actionable) continue;
      if (!contract.ok) {
        const seen = this.events(issue.number).some((e) => e.type === 'contract.missing');
        if (!seen) {
          this.emit('contract.missing', { issue: issue.number, why: contract.why });
          await this.d.backlog.comment(issue.number, `[${BRAND.cli}] Not starting: ${contract.why}. Add a \`\`\`done_when block (no contract, no build).`);
        }
        continue;
      }
      const slot = tryAgentSlot(`${BRAND.cli} ${this.d.cfg.project.project.name} #${issue.number}`, this.d.slotsDir);
      if (!slot) return 0; // machine at its cap: try again next tick
      const p = this.runTask(issue, contract.done_when)
        .catch((e: Error) => {
          this.emit('coordinator.error', { instance: this.d.instance, where: `task #${issue.number}`, kind: 'error', message: e.message.slice(0, 500) });
        })
        .finally(() => {
          slot.release();
          this.active.delete(issue.number);
        });
      this.active.set(issue.number, p);
      return 1;
    }
    return 0;
  }

  // ---------------------------------------------------------------- task pipeline

  private paths(issue: number) {
    return { name: `issue-${issue}`, branch: `${BRAND.cli}/issue-${issue}`, taskFile: join(this.d.stateDir, 'tasks', `issue-${issue}.json`) };
  }

  async runTask(issue: Issue, doneWhen: DoneWhenList): Promise<void> {
    const n = issue.number;
    this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
    const base = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
    const lease: Lease = { instance: this.d.instance, run_id: randomBytes(4).toString('hex'), issue: n, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString(), base };
    const won = claim(lease, { repo: this.d.repo, remote: this.remote });
    if (!won.won) {
      this.emit('issue.claim_lost', { issue: n, instance: this.d.instance, holder: won.holder?.instance ?? null });
      return;
    }
    let leaseSha = won.sha;
    const owner = ownerFor(issue, [], this.d.cfg.project.owners, (g, p) => globToRegExp(g).test(p));
    this.emit('contract.agreed', { issue: n, done_when: doneWhen as Record<string, unknown>[], by: issue.author });
    this.emit('issue.claimed', { issue: n, instance: this.d.instance, lease: leaseSha, base, owner });
    await this.d.backlog.removeLabel(n, 'ready');
    await this.d.backlog.addLabels(n, ['agent:working']);
    if (!issue.assignees.length) await this.d.backlog.setAssignees(n, [owner]);
    await this.d.backlog.comment(n, `[${BRAND.cli}] Claimed by \`${this.d.instance}\` (owner @${owner}, agent delegate: worker). Base \`${base.slice(0, 8)}\`, lease \`${leaseSha.slice(0, 8)}\`.`);
    const heartbeat = setInterval(() => {
      const next = renew({ ...lease, expires_at: new Date(Date.now() + (this.d.leaseMs ?? 3 * 3600_000)).toISOString() }, leaseSha, { repo: this.d.repo, remote: this.remote });
      if (next) leaseSha = next;
    }, 20 * 60_000);
    heartbeat.unref();

    const { name, branch, taskFile } = this.paths(n);
    try {
      const { path, setupErrors } = createWorktree(this.wt, name, branch, base);
      if (setupErrors.length) throw new Error(`worktree setup failed: ${setupErrors.join('; ')}`);
      mkdirSync(dirname(taskFile), { recursive: true });
      writeFileSync(taskFile, JSON.stringify({ id: `issue-${n}`, done_when: doneWhen }));

      const repro = doneWhen.some((d) => 'repro' in d && d.repro) ? await this.reproduce(issue, doneWhen, base, path) : null;
      // The frozen test is off-limits to the worker: its hook denies writes to it.
      if (repro?.path) writeFileSync(taskFile, JSON.stringify({ id: `issue-${n}`, done_when: doneWhen, frozen: [repro.path] }));
      const maxAttempts = this.d.maxAttempts ?? 3;
      let feedback: string[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const out = await this.build(issue, doneWhen, path, taskFile, repro, feedback, attempt);
        if (out.stop) return;
        const head = this.git(path, 'rev-parse', 'HEAD');
        const change = this.inspect(n, path, base, head, repro);
        if ('rejected' in change) {
          this.emit('change.rejected', { issue: n, why: change.rejected });
          feedback = [`Your previous attempt was rejected: ${change.rejected}`];
          continue;
        }
        const checks = this.verify(n, path, head, doneWhen, repro);
        if (checks.some((c) => c.status !== 'pass')) {
          feedback = [`Independent checks failed on your last attempt:`, ...checks.filter((c) => c.status !== 'pass').map((c) => `- ${c.check}: ${c.status}\n${c.tail}`)];
          continue;
        }
        const verdict = await this.evaluate(issue, doneWhen, path, base, head, change.patchHash, checks, repro, change.tampered);
        if (!verdict.patch_correct && attempt < maxAttempts) {
          feedback = [`The independent evaluator rejected your change: ${verdict.advice}`];
          continue;
        }
        const lvl = computeLevel(
          { files: change.files, labels: issue.labels, moneyPaths: loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source), verdict, ...(out.raise || change.tampered.length || repro?.unavailable ? { requested: out.raise ?? 'L2' } : {}) },
          this.d.cfg.review ?? DEFAULT_REVIEW,
        );
        this.emit('review.level_set', { issue: n, head, level: lvl.level, reasons: [...lvl.reasons, ...change.tampered.map((t) => `tamper guard: ${t}`), ...(repro?.unavailable ? [`no reproduction: ${repro.unavailable}`] : [])] });
        await this.d.backlog.removeLabel(n, 'agent:working');
        await this.d.backlog.addLabels(n, ['in-review', `review:${lvl.level}`]);
        if (out.lesson) this.emit('lesson.proposed', { issue: n, ...out.lesson });
        if (lvl.level === 'L3') {
          await this.ask('land', n, owner, `Approve landing #${n} (${lvl.level})?`, ['approve', 'reject'], verdict.patch_correct ? 'approve' : 'reject', [`head ${head.slice(0, 8)}`, ...lvl.reasons, `evaluator: ${verdict.confidence}; ${verdict.advice || 'no concerns'}`]);
        } else {
          this.emit('land.queued', { issue: n, head, level: lvl.level });
        }
        return;
      }
      await this.block(n, owner, `no passing change after ${maxAttempts} attempts`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async reproduce(issue: Issue, doneWhen: DoneWhenList, base: string, workerPath: string): Promise<{ path: string; hash: string } & { unavailable?: string }> {
    const n = issue.number;
    const name = `issue-${n}-repro`;
    const { path } = createWorktree(this.wt, name, `${BRAND.cli}/issue-${n}-repro`, base);
    try {
      const role = this.d.cfg.agents.roles.evaluator!;
      const r = await this.d.runner.run({
        role: 'evaluator-repro',
        stateDir: this.d.stateDir,
        prompt: issueBrief(issue, doneWhen),
        appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'evaluator-repro'),
        cwd: path,
        model: role.model,
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
        maxTurns: 40,
        maxBudgetUsd: role.budget_usd ?? 3,
        jsonSchema: REPRO_SCHEMA,
        stallMs: 15 * 60_000,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      this.cost(n, 'evaluator-repro', r);
      const s = r.structured as { test_path?: string; not_reproducible?: string } | undefined;
      const unavailable = (why: string) => {
        this.emit('repro.unavailable', { issue: n, why });
        return { path: '', hash: '', unavailable: why };
      };
      if (r.reason !== 'succeeded' || !s) return unavailable(`evaluator run ${r.reason}`);
      if (s.not_reproducible || !s.test_path) return unavailable(s.not_reproducible ?? 'no test path');
      const changed = this.git(path, 'diff', '--name-only', base).split('\n').filter(Boolean).concat(this.git(path, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));
      if (changed.some((f) => f !== s.test_path)) return unavailable(`repro run changed more than the test: ${changed.join(', ')}`);
      if (!existsSync(join(path, s.test_path))) return unavailable(`test ${s.test_path} not found`);
      const one = this.d.cfg.tests.runner.one;
      if (!one) return unavailable('tests.yaml runner.one is not set');
      const onBase = sh(one.replaceAll('{file}', s.test_path), path);
      if (onBase.code === 0) return unavailable(`the test passes on the unfixed code, so it doesn't reproduce the issue`);
      // Freeze it: commit the test into the worker's branch; its hash is checked later.
      mkdirSync(dirname(join(workerPath, s.test_path)), { recursive: true });
      cpSync(join(path, s.test_path), join(workerPath, s.test_path));
      this.git(workerPath, 'add', s.test_path);
      this.git(workerPath, '-c', `user.name=${BRAND.cli}`, '-c', `user.email=${BRAND.cli}@localhost`, 'commit', '-q', '-m', `Add reproduction test for #${n} (frozen)`);
      const hash = createHash('sha256').update(readFileSync(join(workerPath, s.test_path))).digest('hex');
      this.emit('repro.frozen', { issue: n, path: s.test_path, hash, fails_on_base: true });
      return { path: s.test_path, hash };
    } finally {
      removeWorktree(this.wt, name);
    }
  }

  private async build(issue: Issue, doneWhen: DoneWhenList, path: string, taskFile: string, repro: { path: string } | null, feedback: string[], attempt: number) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.workers!;
    const model = issue.labels.includes('size:L') && role.hard_issues_model ? role.hard_issues_model : role.model;
    const remaining = Math.max(0.5, this.d.cfg.agents.daily_budget_usd - this.spentToday());
    const extra = [...(repro?.path ? [`Frozen reproduction test (must pass; never edit): ${repro.path}`] : []), ...this.answers(n), ...(feedback.length ? ['', ...feedback] : [])];
    let pid = -1;
    const r: RunResult = await this.d.runner.run({
      role: 'worker',
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'worker'),
      cwd: path,
      model,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...this.d.cfg.guardrails.pre_approved],
      maxTurns: 200,
      maxBudgetUsd: Math.min(role.budget_usd ?? 10, remaining),
      jsonSchema: WORKER_SCHEMA,
      taskFile,
      stallMs: 20 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStart: (p) => {
        pid = p;
        this.emit('run.started', { issue: n, role: 'worker', model, worktree: path, pid: p, pgid: p, attempt });
      },
    });
    void pid;
    this.cost(n, 'worker', r);
    this.emit('run.finished', { issue: n, role: 'worker', reason: r.reason, detail: r.detail.slice(0, 1000) });
    const s = (r.structured ?? {}) as { summary?: string; lesson?: { worked: string; failed: string; fix: string }; blocked?: string; ask?: { question: string; options: string[]; recommendation: string }; raise_review?: Level };
    const owner = this.ownerOf(n);
    if (r.reason === 'rate_limited' || r.reason === 'budget_exhausted' || r.reason === 'auth_mismatch') {
      await this.block(n, owner, `worker run ended: ${r.reason} (${r.detail})`, false);
      return { stop: true as const };
    }
    if (s.ask) {
      await this.ask('question', n, owner, s.ask.question, s.ask.options, s.ask.recommendation, [s.summary ?? '']);
      return { stop: true as const };
    }
    if (s.blocked) {
      await this.block(n, owner, s.blocked);
      return { stop: true as const };
    }
    return { stop: false as const, ...(s.lesson ? { lesson: s.lesson } : {}), ...(s.raise_review ? { raise: s.raise_review } : {}) };
  }

  /** Mechanical checks on what the worker produced, before anyone trusts it. */
  private inspect(n: number, path: string, base: string, head: string, repro: { path: string; hash: string } | null) {
    if (repro?.path && (!existsSync(join(path, repro.path)) || createHash('sha256').update(readFileSync(join(path, repro.path))).digest('hex') !== repro.hash)) {
      return { rejected: `modified the frozen reproduction test ${repro.path}` };
    }
    if (this.git(path, 'status', '--porcelain')) return { rejected: 'uncommitted changes left in the worktree; commit your work' };
    const names = this.git(path, 'diff', '--name-only', `${base}..${head}`).split('\n').filter(Boolean);
    const workerFiles = repro?.path ? names.filter((f) => f !== repro.path) : names;
    if (!workerFiles.length) return { rejected: 'no changes committed' };
    const protectedRes = this.d.cfg.guardrails.protected_paths.map((g) => globToRegExp(g));
    const prot = names.filter((f) => protectedRes.some((re) => re.test(f)));
    if (prot.length) return { rejected: `changes protected harness files: ${prot.join(', ')}` };
    const scan = scanPath(path);
    if (scan.status === 'leaks') return { rejected: `secret scan found ${scan.findings.length} possible secret(s) in the worktree` };
    if (scan.status === 'unavailable') return { rejected: `secret scan could not run (${scan.error}); not accepting an unscanned change` };
    const numstat = this.git(path, 'diff', '--numstat', `${base}..${head}`).split('\n').filter(Boolean);
    const files: ChangeFile[] = numstat.map((l) => {
      const [a, r, p] = l.split('\t');
      const added = this.git(path, 'diff', '-U0', `${base}..${head}`, '--', p!).split('\n').filter((x) => x.startsWith('+') && !x.startsWith('+++')).map((x) => x.slice(1));
      return { path: p!, added: Number(a) || 0, removed: Number(r) || 0, addedLines: added };
    });
    // Tamper guard: tests deleted, skipped, focused, or with fewer assertions.
    const tampered: string[] = [];
    const pattern = this.d.cfg.tests.vacuity?.assertion_pattern ?? '\\b(assert|expect|check)\\b';
    const testRes = (this.d.cfg.tests.vacuity?.test_globs ?? ['test/**', '**/*.test.*']).map((g) => globToRegExp(g));
    for (const f of files.filter((x) => testRes.some((re) => re.test(x.path)))) {
      const after = existsSync(join(path, f.path)) ? readFileSync(join(path, f.path), 'utf8') : null;
      let before: string | null = null;
      try {
        before = this.git(path, 'show', `${base}:${f.path}`);
      } catch {
        // new file
      }
      if (before !== null && after === null) tampered.push(`deleted test ${f.path}`);
      if (after !== null && /\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/.test((f.addedLines ?? []).join('\n'))) tampered.push(`skipped/focused tests in ${f.path}`);
      if (before !== null && after !== null && countAssertions(after, pattern) < countAssertions(before, pattern)) tampered.push(`fewer assertions in ${f.path}`);
    }
    const lines = files.reduce((s, f) => s + f.added + f.removed, 0);
    const patchHash = createHash('sha256').update(this.git(path, 'diff', `${base}..${head}`)).digest('hex');
    this.emit('change.proposed', { issue: n, branch: this.paths(n).branch, base, head, files: names, lines, patch_hash: patchHash });
    return { files, tampered, patchHash };
  }

  /** The coordinator's own run of the contract: it never trusts the agent's word or its Stop gate alone. */
  private verify(n: number, path: string, head: string, doneWhen: DoneWhenList, repro: { path: string } | null) {
    const checks: { check: string; status: 'pass' | 'fail' | 'unavailable'; exitCode: number | null; tail: string }[] = [];
    const run = (command: string) => {
      const r = sh(command, path);
      const busy = this.d.cfg.tests.stop_gate.busy_patterns.some((p) => new RegExp(p, 'm').test(r.out));
      checks.push({ check: command, status: busy || r.code === null ? 'unavailable' : r.code === 0 ? 'pass' : 'fail', exitCode: r.code, tail: r.tail });
    };
    const one = this.d.cfg.tests.runner.one;
    for (const d of doneWhen) {
      if ('command' in d) run(d.command);
      else if ('test' in d) {
        if (one) run(one.replaceAll('{file}', d.test));
        else checks.push({ check: `test ${d.test}`, status: 'unavailable', exitCode: null, tail: 'tests.yaml runner.one not set' });
      }
    }
    if (repro?.path && one) run(one.replaceAll('{file}', repro.path));
    for (const c of this.d.cfg.tests.checks) run(c);
    this.emit('check.result', { issue: n, head, stage: 'verify', checks: checks.map(({ tail: _t, ...c }) => c) });
    return checks;
  }

  private async evaluate(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, head: string, patchHash: string, checks: { check: string; status: string }[], repro: { path: string } | null, tampered: string[]) {
    const n = issue.number;
    const role = this.d.cfg.agents.roles.evaluator!;
    const extra = [
      `Base commit: ${base}. Head: ${head}. Inspect with: git diff ${base}..${head}`,
      `Reproduction test: ${repro?.path || 'none'}`,
      `Coordinator's check results: ${checks.map((c) => `${c.check}=${c.status}`).join(', ') || 'none'}`,
      ...(tampered.length ? [`Tamper guard flags: ${tampered.join('; ')}`] : []),
    ];
    const r = await this.d.runner.run({
      role: 'evaluator-verdict',
      stateDir: this.d.stateDir,
      prompt: issueBrief(issue, doneWhen, extra),
      appendSystemPrompt: rolePrompt(this.d.cfg.dir, 'evaluator-verdict'),
      cwd: path,
      model: role.model,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      maxTurns: 60,
      maxBudgetUsd: role.budget_usd ?? 5,
      jsonSchema: VERDICT_SCHEMA,
      stallMs: 15 * 60_000,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    this.cost(n, 'evaluator-verdict', r);
    const s = r.structured as { patch_correct?: boolean; test_correct?: boolean; confidence?: 'high' | 'medium' | 'low'; advice?: string } | undefined;
    // No verdict is a failed verdict, never a pass.
    const v = {
      patch_correct: r.reason === 'succeeded' && s?.patch_correct === true,
      test_correct: r.reason === 'succeeded' && s?.test_correct !== false,
      confidence: (r.reason === 'succeeded' && s?.confidence) || 'low',
      advice: r.reason === 'succeeded' ? (s?.advice ?? '') : `evaluator run ${r.reason}: ${r.detail}`,
    } as const;
    if (this.git(path, 'rev-parse', 'HEAD') !== head) throw new Error('the worktree moved during evaluation; the verdict would not match the patch');
    this.emit('eval.verdict', { issue: n, head, patch_hash: patchHash, ...v });
    return v;
  }

  private cost(issue: number, role: string, r: RunResult) {
    this.emit('run.cost', { issue, role, model: r.model, usd: r.costUsd, turns: r.turns });
  }

  private ownerOf(issue: number): string {
    const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
    return (c?.payload as { owner?: string } | undefined)?.owner ?? this.d.cfg.project.owners.default;
  }

  private async ask(kind: 'land' | 'question', issue: number, owner: string, question: string, options: string[], recommendation: string, receipts: string[]) {
    const id = `d-${issue}-${randomBytes(3).toString('hex')}`;
    this.emit('decision.asked', { id, kind, issue, owner, question, options, recommendation, receipts });
    await this.d.backlog.addLabels(issue, ['needs:decision']);
    await this.d.backlog.comment(
      issue,
      `[${BRAND.cli}] @${owner} decision needed: **${question}**\n\nOptions: ${options.join(' / ')}. Recommendation: **${recommendation}**.\n\n${receipts.map((r) => `- ${r}`).join('\n')}\n\nReply \`/${BRAND.cli} ${options.join('` or `/' + BRAND.cli + ' ')}\` (owner or a writer), or run \`${BRAND.cli} decide ${id} <option>\`.`,
    );
  }

  private async block(issue: number, owner: string, why: string, release_ = true) {
    await this.d.backlog.addLabels(issue, ['blocked']);
    await this.d.backlog.removeLabel(issue, 'agent:working');
    await this.d.backlog.comment(issue, `[${BRAND.cli}] @${owner} blocked: ${why}`);
    if (release_) this.releaseClaim(issue, why);
  }

  private releaseClaim(issue: number, why: string) {
    const c = this.events(issue).filter((e) => e.type === 'issue.claimed').at(-1);
    const lease = (c?.payload as { lease?: string } | undefined)?.lease;
    if (lease) release(issue, lease, { repo: this.d.repo, remote: this.remote });
    this.emit('issue.released', { issue, instance: this.d.instance, why });
    try {
      removeWorktree(this.wt, this.paths(issue).name);
    } catch {
      // not ours or already gone
    }
  }

  // ---------------------------------------------------------------- decisions

  /** Decisions answered by CLI (decision.answered) or by a writer's `/<cli> <option>` comment. */
  private async handleDecisions() {
    const writers = new Set(this.d.cfg.project.owners.writers.map((w) => w.toLowerCase()));
    const cmd = new RegExp(`^/${BRAND.cli}\\s+(\\S+)`, 'm');
    for (const asked of this.d.log.read(0, ['decision.asked'])) {
      const q = asked.payload as EventPayload<'decision.asked'>;
      if (q.issue === null) continue;
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
        // A worker's question: release and requeue; the next run gets the answer in its brief.
        await this.d.backlog.comment(q.issue, `[${BRAND.cli}] @${a.by} answered: ${a.answer}. Requeued.`);
        this.releaseClaim(q.issue, `question answered by ${a.by}`);
        await this.d.backlog.removeLabel(q.issue, 'in-review');
        await this.d.backlog.addLabels(q.issue, ['ready']);
      }
    }
  }

  /** Answers to this issue's earlier questions, for the next worker's brief. */
  private answers(issue: number): string[] {
    const asked = new Map(this.d.log.read(0, ['decision.asked']).map((e) => [(e.payload as { id: string }).id, e.payload as EventPayload<'decision.asked'>]));
    return this.d.log
      .read(0, ['decision.answered'])
      .map((e) => e.payload as EventPayload<'decision.answered'>)
      .filter((a) => asked.get(a.id)?.issue === issue && asked.get(a.id)?.kind === 'question')
      .map((a) => `Owner decision: "${asked.get(a.id)!.question}" -> ${a.answer} (by ${a.by})`);
  }

  // ---------------------------------------------------------------- landing

  private async landNext() {
    if (this.landing) return;
    const queued = this.d.log.read(0, ['land.queued']).filter((q) => !this.d.log.read(q.id, ['land.result']).some((r) => (r.payload as { issue: number }).issue === (q.payload as { issue: number }).issue));
    const next = queued[0];
    if (!next) return;
    this.landing = true;
    try {
      await this.land(next.payload as EventPayload<'land.queued'>);
    } finally {
      this.landing = false;
    }
  }

  /** Serial landing: rebase onto the tip, pre-land steps, tests, secret scan, fast-forward push. */
  private async land(q: EventPayload<'land.queued'>) {
    const n = q.issue;
    const name = `land-${n}`;
    const result = (outcome: EventPayload<'land.result'>['outcome'], landed: string | null, detail: string) => this.emit('land.result', { issue: n, outcome, landed, detail: detail.slice(0, 2000) });
    if (this.d.cfg.project.land_mode === 'pr') {
      result('rejected', null, 'land_mode pr: opening and merging PRs arrives with the dashboard (step 3); land manually for now');
      return;
    }
    const claimed = this.events(n).filter((e) => e.type === 'issue.claimed').at(-1)!.payload as EventPayload<'issue.claimed'>;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
      const tip = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
      const { path, setupErrors } = createWorktree(this.wt, name, `${BRAND.cli}/land-${n}`, tip);
      try {
        if (setupErrors.length) return result('error', null, `land worktree setup failed: ${setupErrors.join('; ')}`);
        const pick = spawnSync('git', ['cherry-pick', `${claimed.base}..${q.head}`], { cwd: path, encoding: 'utf8' });
        if (pick.status !== 0) {
          spawnSync('git', ['cherry-pick', '--abort'], { cwd: path });
          result('conflict', null, `does not apply cleanly on ${tip.slice(0, 8)}; never guessing at conflicts`);
          return this.block(n, claimed.owner, `conflicts with ${this.branch}; needs a rebase`);
        }
        for (const step of this.d.cfg.tests.land.pre) {
          const r = sh(step, path);
          if (r.code !== 0) return result('error', null, `pre-land step failed: ${step}\n${r.tail}`);
        }
        if (this.git(path, 'status', '--porcelain')) {
          this.git(path, 'add', '-A');
          this.git(path, '-c', `user.name=${BRAND.cli}`, '-c', `user.email=${BRAND.cli}@localhost`, 'commit', '-q', '-m', `Pre-land steps for #${n}`);
        }
        const tests = sh(this.d.cfg.tests.runner.changed, path);
        if (tests.code !== 0) {
          result('red', null, `tests failed on the rebased change:\n${tests.tail}`);
          return this.block(n, claimed.owner, `tests fail after rebasing onto ${this.branch}`);
        }
        const scan = scanPath(path);
        if (scan.status !== 'clean') return result('rejected', null, `secret scan ${scan.status} at landing`);
        const head = this.git(path, 'rev-parse', 'HEAD');
        // A plain (non-force) push only succeeds if the tip hasn't moved: compare-and-swap.
        const push = spawnSync('git', ['push', this.remote, `${head}:refs/heads/${this.branch}`], { cwd: path, encoding: 'utf8' });
        if (push.status !== 0) {
          if (attempt < 2 && /rejected|fetch first|non-fast-forward/.test(push.stderr)) continue;
          return result('error', null, `push failed: ${push.stderr.trim().split('\n').pop()}`);
        }
        result('landed', head, `landed on ${this.branch}`);
        await this.afterLand(n, head, claimed.owner);
        return;
      } finally {
        removeWorktree(this.wt, name);
      }
    }
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
    const ok = await this.deploy(staging.name, staging.trigger!, staging.verify, sha);
    await this.d.backlog.comment(n, ok ? `[${BRAND.cli}] Landed \`${sha.slice(0, 8)}\` and verified it on ${staging.name}.` : `[${BRAND.cli}] @${owner} landed \`${sha.slice(0, 8)}\` but ${staging.name} is NOT serving it. Not closing.`);
    if (ok) await this.d.backlog.close(n);
    else await this.d.backlog.addLabels(n, ['blocked']);
  }

  /** Trigger a deploy, then confirm the environment serves the exact sha. A skipped deploy is a failure. */
  async deploy(env: string, trigger: string, verify: string, sha: string, polls = 60, pollMs = 15_000): Promise<boolean> {
    this.emit('deploy.requested', { env, sha });
    const t = sh(trigger, this.d.repo);
    if (t.code !== 0) {
      this.emit('deploy.failed', { env, sha, why: `trigger failed: ${t.tail}` });
      return false;
    }
    for (let i = 0; i < polls; i++) {
      const v = sh(verify, this.d.repo, 120_000);
      if (v.code === 0 && v.out.includes(sha)) {
        this.emit('deploy.verified', { env, sha });
        return true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    this.emit('deploy.failed', { env, sha, why: `${env} did not report ${sha.slice(0, 8)} after ${(polls * pollMs) / 60_000} min` });
    return false;
  }
}

const DEFAULT_REVIEW = {
  version: 1 as const,
  levels: {
    L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
    L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
    L2_notify: { when: ['app-non-money-large', 'dependency', 'test-machinery'] },
    L3_human: { when: ['money-path', 'migration', 'auth', 'secrets', 'deploy-config', 'release-config', 'harness-config', 'guardrail-config', 'deletes-data'], over_lines: 800 },
  },
};
