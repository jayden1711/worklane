// Work intake (docs/intake.md): pulling the sources, triage, filing or asking, replies, and recovery after a restart.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mayAnswer } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
import { loadMoneyPaths } from '../review.js';
import { intakeCaps, researchRepoAccess } from '../settings.js';
import { isAllowed, isTrusted, type IncomingReport, type IntakeConfig } from '../intake/report.js';
import { redactPii } from '../intake/redact.js';
import { IntakeMeter, purgeRaw, purgeSeen, rawIds, readRaw, reportId, seen, storeRaw } from '../intake/store.js';
import { candidates as intakeCandidates } from '../intake/dedupe.js';
import { acceptTriage } from '../intake/triage.js';
import { decide as intakeDecide, excerpt, NEEDS_INFO_REPLY, statusReply, type IntakeAction } from '../intake/decide.js';
import { checkReply, REPLIER_ROLE, replierDir, replierRun, type ReplyFacts, type ReplyStage } from '../intake/replier.js';
import { INTAKE_ROLE, intakeRun, writeIntakeBundle } from '../intake/run.js';
import { QuickReplies } from './quick-replies.js';
import { type CoordinatorDeps } from './shared.js';
import { runRoute } from './model-routing.js';

/** How often intake sources are pulled, by default. */
const INTAKE_PULL_MS = 30_000;
/** The labels intake puts on what it files, by triage kind; also where it looks for open issues a report may repeat. */
const INTAKE_KIND_LABEL: Record<string, string> = { bug: 'bug', feature: 'enhancement' };
/** Events that end a report's handling (with an intake.replied at stage info, for a report answered by a reply). */
const INTAKE_OUTCOMES = ['intake.filed', 'intake.awaiting', 'intake.commented', 'intake.grouped', 'intake.asked', 'intake.dropped'] as const;
/** What a sender is told when a restart cut off their report. */
const INTERRUPTED_REPLY = "Sorry, we couldn't finish handling your message. Could you send it again?";

export abstract class Intake extends QuickReplies {
  // ---------------------------------------------------------------- intake

  /**
   * Work intake (docs/intake.md), on the short timer: pull each enabled source (at most every `pullMs`), take each
   * new report through redaction, the caps, a read-only triage run and the policy (intake/decide.ts), then act on
   * the owner's answers and send status replies. Report text is data: nothing in it, and nothing the triage run
   * returns, can file `ready`, answer a decision or change config. One pass at a time; returns the pass in flight.
   */
  checkIntake(): Promise<void> {
    // Replies a person waits on are woken by their arrival; the timer is the fallback for one that was missed.
    void this.wakeQuick();
    const it = this.d.intake;
    if (!it || this.intakeRunning || this.halt.signal.aborted || this.stopped) return this.intakeQueue;
    const now = (this.d.now?.() ?? new Date()).getTime();
    if (now - this.intakePulledAt < (it.pullMs ?? INTAKE_PULL_MS)) return this.intakeQueue;
    this.intakePulledAt = now;
    this.intakeRunning = true;
    this.intakeQueue = this.intakePass(it)
      .catch((e: Error) => {
        this.emit('coordinator.error', { instance: this.d.instance, where: 'intake', kind: (e as { kind?: string }).kind ?? 'error', message: e.message.slice(0, 500) });
      })
      .finally(() => {
        this.intakeRunning = false;
      });
    return this.intakeQueue;
  }

  /**
   * At start-up, before any pass: end what a restart cut off, exactly once and without running any agent again.
   * A reply recorded as being sent but never as sent is marked unknown (not resent). A report taken but without an
   * outcome is filed if its issue exists (found by its marker), else dropped as interrupted, and its sender asked
   * once to send it again. Each writes an outcome, so a second restart finds nothing to do.
   */
  async recoverIntake(): Promise<void> {
    const it = this.d.intake;
    if (!it) return;
    // The chat channel's posts cut off by a restart, and its threads, taken again.
    this.channelRecover();
    this.channelRewatch();
    const sent = new Set(this.d.log.read(0, ['intake.replied']).map((e) => `${(e.payload as { id: string }).id}\0${(e.payload as { stage: string }).stage}`));
    for (const e of this.d.log.read(0, ['intake.replying'])) {
      const p = e.payload as EventPayload<'intake.replying'>;
      if (sent.has(`${p.id}\0${p.stage}`)) continue;
      this.emit('intake.replied', { id: p.id, stage: p.stage, ok: false, unknown: true });
      sent.add(`${p.id}\0${p.stage}`);
    }
    const ended = new Set<string>();
    for (const e of this.d.log.read(0, [...INTAKE_OUTCOMES, 'intake.replied'])) {
      const p = e.payload as { id: string; stage?: string };
      // A reply is an outcome only for a report whose action was the reply (asking for details).
      if (e.type !== 'intake.replied' || p.stage === 'info' || p.stage === 'interrupted') ended.add(p.id);
    }
    const received = new Set(this.d.log.read(0, ['intake.received']).map((e) => (e.payload as { id: string }).id));
    const cfg = it.config();
    // Stored but never recorded as received (a crash between the two): recorded now, so it can be ended.
    for (const id of rawIds(this.d.stateDir)) {
      if (received.has(id)) continue;
      const raw = readRaw(this.d.stateDir, id);
      if (!raw) continue;
      const redacted = redactPii(raw.text, { names: [...(raw.sender.name ? [raw.sender.name] : []), ...(cfg?.redact.names ?? [])], patterns: cfg?.redact.patterns ?? [] });
      this.emit('intake.received', { id, source: raw.source, sender: createHash('sha256').update(`${raw.sender.source}\0${raw.sender.id}`).digest('hex').slice(0, 12), excerpt: excerpt(redacted) });
      received.add(id);
    }
    for (const id of received) {
      if (ended.has(id)) continue;
      const raw = readRaw(this.d.stateDir, id);
      const issue = await this.intakeIssueFor(id, ['ready', ...Object.values(INTAKE_KIND_LABEL)]).catch(() => null);
      if (issue !== null) {
        const ready = (await this.d.backlog.get(issue)).labels.includes('ready');
        this.emit('intake.filed', { id, issue, ready });
        if (!sent.has(`${id}\0filed`)) await this.intakeReply(id, raw, 'filed', statusReply('filed', raw && cfg ? isTrusted(raw.sender, cfg) : false));
        continue;
      }
      this.emit('intake.dropped', { id, reason: 'interrupted' });
      await this.intakeReply(id, raw, 'interrupted', INTERRUPTED_REPLY);
    }
  }

  private async intakePass(it: NonNullable<CoordinatorDeps['intake']>): Promise<void> {
    const cfg = it.config();
    if (!cfg) return;
    purgeRaw(this.d.stateDir, cfg.raw_retention_days);
    purgeSeen(this.d.stateDir);
    const error = (where: string, e: unknown) => this.emit('coordinator.error', { instance: this.d.instance, where, kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
    for (const src of it.sources) {
      if (!cfg[src.name].enabled) continue;
      let got: IncomingReport[];
      try {
        // Replies a person waits on aren't taken here: src/coordinator/quick-replies.ts answers them as they arrive.
        got = await this.intakeTake(src);
      } catch (e) {
        error(`intake ${src.name}`, e);
        continue;
      }
      // An adapter speaks only for its own source: trust is looked up per source. Each conversation in arrival order.
      const mine = got.filter((x) => x.source === src.name);
      // Only allowed senders, on the sender id alone: anyone else's message is never stored or replied to, only counted.
      const notAllowed = mine.filter((r) => !isAllowed(r.sender, cfg));
      if (notAllowed.length) {
        const meter = new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
        for (const _ of notAllowed) meter.countDrop('not_allowed');
      }
      const sorted = mine.filter((r) => isAllowed(r.sender, cfg)).sort((a, b) => (a.thread?.id ?? '').localeCompare(b.thread?.id ?? '') || a.receivedAt.localeCompare(b.receivedAt) || a.sourceId.localeCompare(b.sourceId));
      // The chat channel first (src/coordinator/channel.ts): replies in its threads, and anyone unmapped ignored.
      const { rest: inbound, ignored } = src.name === 'discord' ? await this.channelInbound(cfg, sorted) : { rest: sorted, ignored: [] as IncomingReport[] };
      // Only a message in an ideas channel (or a source with no threads) is ever a report: never a chat-channel one.
      const batch = inbound.filter((r) => !r.thread || r.thread.kind === 'channel');
      for (const r of batch) {
        // Paused on the usage limit: the report isn't taken (so not acknowledged); it comes again after the reset.
        if (this.halt.signal.aborted || this.stopped || this.usagePause()) break;
        try {
          await this.intakeReport(cfg, r);
        } catch (e) {
          error(`intake ${src.name} report`, e);
        }
      }
      // Only what is recorded (its id in the seen ledger), or dropped by rule, is acknowledged; the rest comes again.
      const recorded = [...sorted.filter((r) => seen(this.d.stateDir, r)), ...notAllowed, ...ignored].map((r) => r.sourceId);
      if (recorded.length && src.ack) await src.ack(recorded).catch((e: unknown) => error(`intake ${src.name} ack`, e));
      if (this.halt.signal.aborted || this.stopped) return;
    }
    await this.intakeDecisions(cfg);
    await this.intakeStatus(cfg);
    this.channelRewatch();
    await this.channelOutbound(cfg);
  }

  /** One new report, from its raw text to its action. A report already stored is never taken again. */
  private async intakeReport(cfg: IntakeConfig, r: IncomingReport): Promise<void> {
    if (!storeRaw(this.d.stateDir, r)) return;
    const id = reportId(r);
    const sender = createHash('sha256').update(`${r.sender.source}\0${r.sender.id}`).digest('hex').slice(0, 12);
    const redacted = redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns });
    this.emit('intake.received', { id, source: r.source, sender, excerpt: excerpt(redacted) });
    const drop = (reason: string) => void this.emit('intake.dropped', { id, reason: reason.slice(0, 500) });
    const settings = this.d.settings?.().settings ?? {};
    const caps = intakeCaps(settings, cfg.caps);
    const meter = new IntakeMeter(this.d.stateDir, caps, () => (this.d.now?.() ?? new Date()).getTime());
    const admit = meter.admit(sender, redacted);
    if (!admit.ok) return drop(admit.reason);
    const can = meter.canDraft();
    if (!can.ok) return drop(can.reason);
    const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
    if (left <= 0) return drop('budget');
    const recent = this.intakeRecent(id);
    const shown = intakeCandidates(redacted, await this.intakeOpenIssues(), recent);
    const bundleDir = writeIntakeBundle({ instanceRoot: dirname(this.d.repo), gid: this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, id, redacted, source: r.source, candidates: shown, recent: recent.map(({ id: rid, text }) => ({ id: rid, text })) });
    const spec = intakeRun({ bundleDir, repoAccess: researchRepoAccess(settings), repo: this.d.repo });
    const role = this.d.cfg.agents.roles.researcher ?? this.d.cfg.agents.roles.workers!;
    // From here until its outcome is recorded, a restart finds this report started and ends it (recoverIntake).
    this.emit('intake.started', { id });
    const run = await this.d.runner.run({
      ...spec,
      stateDir: this.d.stateDir,
      ...runRoute(this.d.cfg, 'intake_triage'),
      maxTurns: 30,
      maxBudgetUsd: Math.max(0.05, Math.min(role.budget_usd ?? 1, caps.max_usd_per_day, left)),
      stallMs: 10 * 60_000,
      timeoutMs: 30 * 60_000,
    });
    this.cost(null, INTAKE_ROLE, run);
    meter.recordDraft(run.costUsd);
    if (run.reason !== 'succeeded') return drop(`triage run ended: ${run.reason}`);
    const got = acceptTriage(run.structured);
    if (!got.ok) return drop(`triage not accepted: ${got.why}`);
    const trusted = isTrusted(r.sender, cfg);
    const action = intakeDecide({ report: r, redacted, triage: got.triage, trusted, shown, moneyPaths: this.intakeMoneyPaths() });
    // A refused draft makes it needs_info, whatever kind the agent chose (decide.ts).
    const refused = action.action === 'reply' ? action.refused : undefined;
    this.emit('intake.triaged', { id, kind: refused ? 'needs_info' : got.triage.kind, reproduction: got.triage.reproduction?.result ?? null, ignored: got.dropped, ...(refused ? { draft_refused: refused.slice(0, 500) } : {}) });
    await this.intakeAct(r, id, trusted, action);
  }

  /** The project's money paths, for marking a draft that names one high-risk; none when unset or unreadable. */
  private intakeMoneyPaths(): RegExp[] {
    try {
      return loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source);
    } catch {
      return [];
    }
  }

  private async intakeAct(r: IncomingReport, id: string, trusted: boolean, a: IntakeAction): Promise<void> {
    const owner = this.d.cfg.project.owners.default;
    switch (a.action) {
      case 'file': {
        const n = await this.intakeFileOnce(id, a.title, a.body, a.labels);
        this.emit('intake.filed', { id, issue: n, ready: a.labels.includes('ready') });
        return this.intakeReply(id, r, 'filed', statusReply('filed', trusted));
      }
      case 'decision': {
        // The draft waits in the coordinator's private state; the decision names only its report.
        ownerOnlyDir(join(this.d.stateDir, 'intake'));
        ownerOnlyDir(join(this.d.stateDir, 'intake', 'drafts'));
        writeOwnerOnly(join(this.d.stateDir, 'intake', 'drafts', `${id}.json`), JSON.stringify({ title: a.title, body: a.body, labels: a.labels }));
        const decision = await this.ask('intake', null, owner, `File this report (via ${r.source}) as an issue: "${a.title.slice(0, 150)}"?`, a.options, 'approve', [`intake:${id}`, 'sender not trusted: approve files it ready, edit files it without ready, reject drops it']);
        this.emit('intake.awaiting', { id, decision });
        return;
      }
      case 'comment':
        await this.d.backlog.comment(a.issue, a.body);
        this.emit('intake.commented', { id, issue: a.issue });
        return this.intakeReply(id, r, 'filed', statusReply('filed', trusted));
      case 'group':
        this.emit('intake.grouped', { id, with: a.with });
        return this.intakeReply(id, r, 'filed', statusReply('filed', trusted));
      case 'reply':
        return this.intakeReply(id, r, 'info', a.text);
      case 'ask_owner': {
        const decision = await this.ask('intake', null, owner, `A question via ${r.source}: ${a.text.slice(0, 500)}`, ['answered'], 'answered', [`intake:${id}`]);
        this.emit('intake.asked', { id, decision });
        return this.intakeReply(id, r, 'question', a.reply);
      }
      case 'drop':
        this.emit('intake.dropped', { id, reason: a.reason.slice(0, 500) });
        return;
    }
  }

  /**
   * A reply into the report's thread, sent at most once: the intent is recorded first, so a crash between sending
   * and recording is found at start-up and marked unknown, never sent again (a person's phone gets at most one).
   * Its text is the engine's own, never the agent's.
   */
  private async intakeReply(id: string, r: IncomingReport | null, stage: string, text: string): Promise<void> {
    this.emit('intake.replying', { id, stage });
    const src = r ? this.d.intake?.sources.find((x) => x.name === r.source) : undefined;
    let ok = false;
    if (src && r?.thread) {
      try {
        ok = await src.reply(r.thread, await this.casualReply(id, r, stage, text));
      } catch {
        ok = false;
      }
    }
    this.emit('intake.replied', { id, stage, ok });
  }

  /**
   * The reply's text: the casual replier's when casual replies are on and its reply passes every check in code,
   * else the engine's fixed `fixed`. Its inputs are the redacted message and the facts only; one run, no tools,
   * within intake's daily spend cap. Which text was used, and why, is recorded.
   */
  private async casualReply(id: string, r: IncomingReport, stage: string, fixed: string): Promise<string> {
    const cfg = this.d.intake?.config();
    const facts: ReplyStage | null = stage === 'filed' || stage === 'merged' || stage === 'deployed' || stage === 'question' ? stage : stage === 'info' && fixed === NEEDS_INFO_REPLY ? 'needs_info' : null;
    if (!cfg?.casual_replies || !facts) return fixed;
    const use = (text: string, why: string | null) => {
      this.emit('intake.reply_checked', { id, stage, used: why === null ? 'casual' : 'fixed', why });
      return text;
    };
    const meter = new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
    const can = meter.canDraft();
    if (!can.ok && can.reason === 'spend_cap') return use(fixed, 'spend_cap');
    const trusted = isTrusted(r.sender, cfg);
    const issue = trusted ? this.intakeIssues().get(id) : undefined;
    const f: ReplyFacts = { stage: facts, trusted, ...(issue !== undefined ? { issue } : {}) };
    const redacted = redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns });
    const cwd = replierDir(dirname(this.d.repo), this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, id, stage);
    const run = await this.d.runner.run({ ...replierRun({ cwd, redacted, facts: f }), stateDir: this.d.stateDir, ...runRoute(this.d.cfg, 'intake_replier'), maxBudgetUsd: 0.25, stallMs: 2 * 60_000, timeoutMs: 5 * 60_000 });
    this.cost(null, REPLIER_ROLE, run);
    meter.recordSpend(run.costUsd);
    if (run.reason !== 'succeeded') return use(fixed, `the run ended: ${run.reason}`);
    const checked = checkReply((run.structured as { reply?: unknown } | undefined)?.reply, { redacted, facts: f });
    return checked.ok ? use(checked.text, null) : use(fixed, checked.why.slice(0, 300));
  }

  /** Open issues a report may repeat: those with the labels intake files under, and ready work. */
  private async intakeOpenIssues(): Promise<{ number: number; title: string; body: string }[]> {
    const out = new Map<number, { number: number; title: string; body: string }>();
    for (const label of [...Object.values(INTAKE_KIND_LABEL), 'ready']) {
      try {
        for (const i of await this.d.backlog.list(label)) out.set(i.number, { number: i.number, title: i.title, body: i.body });
      } catch {
        // a tracker hiccup: fewer candidates, never a failed report
      }
    }
    return [...out.values()];
  }

  /** The last week's reports (redacted excerpts, from the log), with the issue each joined. */
  private intakeRecent(except: string): { id: string; text: string; issue?: number }[] {
    const since = (this.d.now?.() ?? new Date()).getTime() - 7 * 86_400_000;
    const issueOf = this.intakeIssues();
    return this.d.log
      .read(0, ['intake.received'])
      .filter((e) => Date.parse(e.ts) >= since && (e.payload as { id: string }).id !== except)
      .slice(-50)
      .map((e) => {
        const p = e.payload as EventPayload<'intake.received'>;
        const n = issueOf.get(p.id);
        return { id: p.id, text: p.excerpt, ...(n !== undefined ? { issue: n } : {}) };
      });
  }

  /** The issue each report was filed as or joined. */
  private intakeIssues(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.d.log.read(0, ['intake.filed', 'intake.commented', 'intake.decided'])) {
      const p = e.payload as { id: string; issue: number | null };
      if (typeof p.issue === 'number') out.set(p.id, p.issue);
    }
    return out;
  }

  /**
   * Answers on intake decisions, each acted on once: approve files the draft `ready`, edit files it without `ready`
   * (to fix up first), reject drops it. A question's answer is only recorded. The owner or any of the project's
   * writers may answer (or the instance's own CLI, run on its machine); anyone else's answer is ignored. Who
   * answered is recorded on intake.decided.
   */
  private async intakeDecisions(cfg: IntakeConfig): Promise<void> {
    const done = new Set(this.d.log.read(0, ['intake.decided']).map((e) => (e.payload as { decision: string }).decision));
    const answers = this.d.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
    for (const e of this.d.log.read(0, ['decision.asked'])) {
      const q = e.payload as EventPayload<'decision.asked'>;
      if (q.kind !== 'intake' || done.has(q.id)) continue;
      // A role on the answer: the instance's own dashboard read the person as an owner or writer of its repo.
      const a = answers.find((x) => x.id === q.id && (x.by === this.d.instance || x.role !== undefined || mayAnswer(q.owner, x.by, this.d.cfg.project.owners)));
      const rid = q.receipts.find((x) => x.startsWith('intake:'))?.slice('intake:'.length);
      if (!a || !rid || !/^[0-9a-f]{20}$/.test(rid)) continue;
      const file = join(this.d.stateDir, 'intake', 'drafts', `${rid}.json`);
      let issue: number | null = null;
      if (existsSync(file) && (a.answer === 'approve' || a.answer === 'edit')) {
        const d = JSON.parse(readFileSync(file, 'utf8')) as { title: string; body: string; labels: string[] };
        issue = await this.intakeFileOnce(rid, d.title, d.body, a.answer === 'approve' ? ['ready', ...d.labels] : d.labels);
      }
      this.emit('intake.decided', { id: rid, decision: q.id, answer: a.answer, by: a.by, issue });
      rmSync(file, { force: true });
      const raw = readRaw(this.d.stateDir, rid);
      if (issue !== null) await this.intakeReply(rid, raw, 'filed', statusReply('filed', raw ? isTrusted(raw.sender, cfg) : false));
    }
  }

  /** "Fixed" and "live" replies: once the report's issue merges, and once a verified deploy includes that merge. */
  private async intakeStatus(cfg: IntakeConfig): Promise<void> {
    const issueOf = this.intakeIssues();
    if (!issueOf.size) return;
    const merged = new Map<number, string | null>();
    for (const e of this.d.log.read(0, ['merge.done', 'land.result', 'pr.closed'])) {
      const p = e.payload as { issue: number; sha?: string; landed?: string | null; outcome?: string; merged?: boolean };
      if (e.type === 'merge.done') merged.set(p.issue, p.sha!);
      else if (e.type === 'land.result' && p.outcome === 'landed') merged.set(p.issue, p.landed ?? null);
      else if (e.type === 'pr.closed' && p.merged && !merged.has(p.issue)) merged.set(p.issue, null);
    }
    const deployed = this.d.log.read(0, ['deploy.verified']).map((e) => (e.payload as { sha: string }).sha);
    const replied = new Set(
      this.d.log.read(0, ['intake.replying', 'intake.replied']).map((e) => {
        const p = e.payload as { id: string; stage: string };
        return `${p.id}\0${p.stage}`;
      }),
    );
    // A deploy includes a merge when it is that commit or a later one on top of it.
    const includes = (deploy: string, sha: string) => {
      if (deploy === sha) return true;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', sha, deploy], { cwd: this.d.repo, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    for (const [rid, n] of issueOf) {
      if (!merged.has(n)) continue;
      const sha = merged.get(n)!;
      const needMerged = !replied.has(`${rid}\0merged`);
      const needDeployed = !replied.has(`${rid}\0deployed`) && sha !== null && deployed.some((d) => includes(d, sha));
      if (!needMerged && !needDeployed) continue;
      const raw = readRaw(this.d.stateDir, rid);
      const trusted = raw ? isTrusted(raw.sender, cfg) : false;
      if (needMerged) await this.intakeReply(rid, raw, 'merged', statusReply('merged', trusted));
      if (needDeployed) await this.intakeReply(rid, raw, 'deployed', statusReply('deployed', trusted));
    }
  }
}
