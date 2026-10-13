// The chat channel (docs/intake.md, "Discord as the owner's channel"): open decisions and setup-console asks are
// posted in the configured channel, one thread each, and a reply in the thread answers them through the same code
// path as the dashboard (src/decide.ts, console/asks.ts), with the same roles, audited with via "discord".
// - Who: only allowed senders mapped to a GitHub login (discord.people); their role is that login's repo permission
//   (intake deps' roleOf, as the dashboard reads it). Anyone unmapped is ignored: nothing stored.
// - Someone who may not answer a thing (a writer on an owner decision) is recorded as a comment, never an answer.
// - A reply that doesn't name exactly one option answers nothing; the bot asks back with the options.
// - The first recorded answer stands; a later one is refused, naming who decided.
// - A secret (or a root step) posts only a dashboard link; a high-risk merge only a notice with links, no thread.
// Every post is recorded before it is sent (discord.posting) and after (discord.posted), so none is sent twice.
import type { EventPayload } from '../events/types.js';
import { ASK_EVENTS, asksFrom, asks as askApi, AskError } from '../console/asks.js';
import { answerDecision, auditWrite, firstAnswer } from '../decide.js';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { alreadyText, askBack, askPost, commentText, decidedText, decisionPost, mainWatchPost, parseChoice, readConfirm, type ChannelPost } from '../intake/channel.js';
import { REPLY_CHARS } from '../intake/discord.js';
import { acceptThread, checkSummary, confirmText, fallbackSummary, noAnswerText, notYourConfirmText, summaryRun, threadRun, threadRunDir, type ThreadRecord } from '../intake/explain.js';
import { redactString } from '../events/redact.js';
import { runRoute } from './model-routing.js';
import { NEVER_FROM_CHAT, mayAnswerAskFromChat, mayAnswerFromChat, personOf, type ChatPerson } from '../intake/people.js';
import { redactPii } from '../intake/redact.js';
import { IntakeMeter, reportId, storeRaw } from '../intake/store.js';
import type { IncomingReport, IntakeConfig, IntakeSource } from '../intake/report.js';
import { OWNER_DECISIONS } from '../dashboard-auth.js';
import { BRAND } from '../brand.js';
import { intakeCaps } from '../settings.js';
import { excerpt } from '../intake/decide.js';
import { ResearchOnDemand } from './research-on-demand.js';

/** The marker in an intake issue's body that ties it to its report, so it is never filed twice. */
const intakeMarker = (id: string) => `<!-- intake:${id} -->`;

/** What a thread is for: `decision:<id>`, `ask:<id>` or `idea:<id>` (the key of the post that opened it). */
type Target = string;

/** A decision's or ask's thread, as a reply in it is handled (Channel.threadTarget). */
interface ThreadTarget {
  what: 'decision' | 'ask';
  kind: string;
  id: string;
  issue: number | null;
  options: string[];
  /** Never answered from chat (a high-risk merge; a secret or root-step ask). */
  never: boolean;
  /** Answered (by whom, with what), or withdrawn (by ''). */
  closed: { answer: string; by: string } | null;
  mayAnswer: (role: ChatPerson['role']) => boolean;
  /** Who may answer it, in words. */
  who: string;
  /** Its fixed post (src/intake/channel.ts). */
  template: (o: { dashboardUrl: string; repo: string }) => string;
  record: () => Promise<ThreadRecord>;
  /** Record `option` as `who`'s answer, through the dashboard's own path. */
  answer: (option: string, who: ChatPerson) => { ok: true } | { ok: false; already?: { answer: string; by: string }; error?: string };
}

const base = (url: string) => url.replace(/\/+$/, '');

/** What makes an issue risky, in words: its high-risk labels, and a money path among its review level's reasons. */
export function riskNotes(labels: string[], reasons: string[]): string[] {
  const words: Record<string, string> = { 'money-path': 'money path', 'high-risk': 'high risk', 'size:L': 'large change' };
  const out = labels.map((l) => words[l]).filter((x): x is string => !!x);
  if (!out.includes('money path') && reasons.some((r) => /money/i.test(r))) out.push('money path');
  return out;
}

/** A plan's fields as plain lines (approach, steps, files, risks), for the record. */
export function planText(plan: Record<string, unknown>): string {
  return Object.entries(plan)
    .filter(([k]) => k !== 'design_change' && k !== 'questions')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') : typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
    .slice(0, 3000);
}

export abstract class Channel extends ResearchOnDemand {
  /** The chat source, when it can open threads. */
  protected chatSource(): IntakeSource | null {
    const s = this.d.intake?.sources.find((x) => x.name === 'discord');
    return s?.openThread && s.watch ? s : null;
  }

  /**
   * File a report's issue at most once: its body carries `<!-- intake:<id> -->`, and an open issue with that marker
   * (filed before a crash, its event never written) is reused instead of filing a second one.
   */
  protected async intakeFileOnce(id: string, title: string, body: string, labels: string[]): Promise<number> {
    const found = await this.intakeIssueFor(id, labels);
    if (found !== null) return found;
    return this.d.backlog.createIssue(title, `${body}\n\n${intakeMarker(id)}`, labels);
  }

  /** The open issue filed for this report, if any, among issues with these labels. */
  protected async intakeIssueFor(id: string, labels: string[]): Promise<number | null> {
    for (const label of labels) {
      const hit = (await this.d.backlog.list(label)).find((i) => i.body.includes(intakeMarker(id)));
      if (hit) return hit.number;
    }
    return null;
  }

  /** Is the channel on: Discord enabled, someone mapped. Off, the intake goes on as before. */
  protected channelOn(cfg: IntakeConfig): boolean {
    return cfg.discord.enabled && Object.keys(cfg.discord.people).length > 0 && this.chatSource() !== null;
  }

  /** Each of the bot's threads and what it is for, from the posts recorded. */
  protected channelThreads(): Map<string, Target> {
    const out = new Map<string, Target>();
    for (const e of this.d.log.read(0, ['discord.posted'])) {
      const p = e.payload as EventPayload<'discord.posted'>;
      if (p.thread && p.ok) out.set(p.thread, p.key);
    }
    return out;
  }

  /** At start-up and each pass: the source takes replies in every thread of ours again (it forgets on restart). */
  protected channelRewatch() {
    const src = this.chatSource();
    if (!src) return;
    for (const t of this.channelThreads().keys()) src.watch!(t);
  }

  /** Keys posted (or being posted) already: each is sent at most once. */
  protected postedKeys(): Set<string> {
    return new Set(this.d.log.read(0, ['discord.posting']).map((e) => (e.payload as { key: string }).key));
  }

  /** A post cut off by a restart (recorded as posting, never as posted) is marked unknown, never resent. */
  protected channelRecover() {
    const done = new Set(this.d.log.read(0, ['discord.posted']).map((e) => (e.payload as { key: string }).key));
    for (const k of this.postedKeys()) if (!done.has(k)) this.emit('discord.posted', { key: k, thread: null, ok: false, unknown: true });
  }

  /** Send one post, once per key. A thread post returns the thread's id (opened on the message `from` when given). */
  protected async channelSend(src: IntakeSource, key: string, where: { channel: string; from?: string } | { thread: string }, post: ChannelPost): Promise<string | null> {
    if (this.postedKeys().has(key)) return null;
    this.emit('discord.posting', { key });
    let thread: string | null = null;
    let ok = false;
    try {
      if (post.kind === 'thread' && 'channel' in where) {
        thread = await src.openThread!(where.channel, post.text, post.name, where.from);
        ok = thread !== null;
      } else {
        ok = await src.reply('thread' in where ? { kind: 'thread', id: where.thread } : { kind: 'channel', id: where.channel }, post.text);
      }
    } catch {
      ok = false;
      thread = null;
    }
    this.emit('discord.posted', { key, thread, ok });
    return thread;
  }

  /** Say something in a thread, once per key. */
  protected say(src: IntakeSource, thread: string, key: string, text: string) {
    return this.channelSend(src, key, { thread }, { kind: 'notice', text });
  }

  /**
   * The chat source's messages, before intake triages them: replies in the bot's threads are handled here; with the
   * channel on, a message from anyone unmapped is ignored (nothing stored, counted only). Returns the messages
   * left for intake, and those dropped by rule (to acknowledge).
   */
  protected async channelInbound(cfg: IntakeConfig, reports: IncomingReport[]): Promise<{ rest: IncomingReport[]; ignored: IncomingReport[] }> {
    // Off (no mapping, or Discord off for this instance): nothing is read as a thread reply.
    if (!this.channelOn(cfg)) return { rest: reports.filter((r) => r.thread?.kind === 'channel' || !r.thread), ignored: reports.filter((r) => r.thread && r.thread.kind !== 'channel') };
    const src = this.chatSource()!;
    const threads = this.channelThreads();
    const rest: IncomingReport[] = [];
    const ignored: IncomingReport[] = [];
    const meter = () => new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
    for (const r of reports) {
      const person = await personOf(cfg, r.sender.id, this.d.intake?.roleOf);
      if (!person) {
        // Unmapped: ignored entirely, before anything of the message is stored.
        meter().countDrop('unmapped');
        ignored.push(r);
        continue;
      }
      const target = r.thread?.kind === 'thread' ? threads.get(r.thread.id) : undefined;
      if (!target) {
        // A reply in a thread that isn't one of this instance's: never an answer here, and never a report.
        // A chat-channel message is never a report either (src/coordinator/channel-chat.ts takes those first).
        if (r.thread?.kind === 'thread' || r.thread?.kind === 'chat') ignored.push(r);
        else rest.push(r);
        continue;
      }
      // Each message is taken once (the seen ledger), however often the gateway delivers it.
      if (!storeRaw(this.d.stateDir, r)) continue;
      await this.threadReply(cfg, src, r, person, r.thread!.id, target);
    }
    return { rest, ignored };
  }

  /**
   * What a thread is for, read from the log: its record (for the summary and questions), its options, whether it
   * is closed (answered, or withdrawn), who may answer it, and how an answer is recorded (the dashboard's own path).
   */
  private threadTarget(target: Target): ThreadTarget | null {
    const [what, key] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
    if (what === 'decision') {
      const q = this.d.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).find((x) => x.id === key);
      if (!q) return null;
      const first = firstAnswer(this.d.log, q.id);
      return {
        what,
        kind: q.kind,
        id: q.id,
        issue: q.issue,
        options: q.options,
        never: NEVER_FROM_CHAT.has(q.kind),
        closed: first ? { answer: first.answer, by: first.by } : null,
        mayAnswer: (role) => mayAnswerFromChat(q.kind, role),
        who: OWNER_DECISIONS.has(q.kind) ? 'an admin' : 'an admin or a writer',
        template: (o) => decisionPost(q, o).text,
        record: () => this.decisionRecord(q),
        answer: (option, who) => {
          // The dashboard's own decide path: the same checks, record and audit, with via "discord".
          const got = answerDecision(this.d.log, { id: q.id, answer: option, who: { login: who.login, role: who.role!, via: 'discord' }, instance: this.d.instance, repo: this.d.cfg.project.project.repo });
          return got.ok ? { ok: true } : got.status === 409 ? { ok: false, already: { answer: got.answer!, by: got.by! } } : { ok: false, error: got.error };
        },
      };
    }
    if (what === 'ask') {
      const a = asksFrom(this.d.log.read(0, [...ASK_EVENTS])).find((x) => x.id === key);
      if (!a) return null;
      const options = a.kind === 'question' ? a.options : ['approved', 'declined'];
      return {
        what,
        kind: a.kind,
        id: a.id,
        issue: null,
        options,
        never: a.kind !== 'question' && a.kind !== 'approve_link',
        closed: a.status !== 'open' ? (a.answer ? { answer: a.answer.answer, by: a.answer.by } : { answer: '', by: '' }) : null,
        mayAnswer: (role) => mayAnswerAskFromChat(a, role),
        who: a.kind === 'question' && a.writersMayAnswer ? 'an admin or a writer' : 'an admin',
        template: (o) => askPost(a, o).text,
        record: async () => ({ kind: 'setup', issue: null, question: redactString(a.title), options, recommendation: '', ...(a.detail ? { plan: redactString(a.detail) } : {}), risk: { level: null, notes: [] } }),
        answer: (option, who) => {
          try {
            askApi(this.d.log).answer(a.id, { by: who.login, role: who.role, answer: option });
          } catch (e) {
            if (e instanceof AskError && e.status === 409) return { ok: false, already: { answer: '', by: '' } };
            if (e instanceof AskError) return { ok: false, error: e.message };
            throw e;
          }
          auditWrite(this.d.log, { login: who.login, role: who.role!, via: 'discord' }, this.d.instance, 'ask.answered', { id: a.id, kind: a.kind, answer: option });
          return { ok: true };
        },
      };
    }
    return null;
  }

  /**
   * A decision's record, from what the coordinator holds: the decision, its issue (title and text), the latest plan
   * posted on it, and the risk (the issue's review level, from review.level_set or its review:L label, and what
   * makes it risky: a money path, a high-risk label, a large change). Redacted.
   */
  protected async decisionRecord(q: EventPayload<'decision.asked'>): Promise<ThreadRecord> {
    let issue: { title: string; body: string; labels: string[] } | null = null;
    if (q.issue !== null) {
      try {
        const i = await this.d.backlog.get(q.issue);
        issue = { title: i.title, body: i.body, labels: i.labels };
      } catch {
        // a tracker hiccup: the record without the issue's text
      }
    }
    const mine = q.issue === null ? [] : this.d.log.read(0, ['plan.posted', 'review.level_set']).filter((e) => (e.payload as { issue?: number }).issue === q.issue);
    const plan = mine.filter((e) => e.type === 'plan.posted').at(-1)?.payload as EventPayload<'plan.posted'> | undefined;
    const set = mine.filter((e) => e.type === 'review.level_set').at(-1)?.payload as EventPayload<'review.level_set'> | undefined;
    const labels = issue?.labels ?? [];
    const level = set?.level ?? labels.map((l) => l.match(/^review:(L[0-3])$/)?.[1]).find((x): x is string => !!x) ?? null;
    return {
      kind: q.kind,
      issue: q.issue,
      ...(issue ? { title: redactString(issue.title), issueText: redactString(issue.body.replace(/<!--[\s\S]*?-->/g, '')) } : {}),
      question: redactString(q.question),
      options: q.options,
      recommendation: q.recommendation,
      ...(plan ? { plan: redactString(planText(plan.plan)) } : {}),
      risk: { level, notes: riskNotes(labels, set?.reasons ?? []) },
    };
  }

  /** The pick waiting for its confirmation in a thread, if any: the latest one asked and not since confirmed or dropped. */
  private pendingConfirm(thread: string): EventPayload<'discord.confirm'> | null {
    const last = this.d.log.read(0, ['discord.confirm']).map((e) => e.payload as EventPayload<'discord.confirm'>).filter((p) => p.thread === thread).at(-1);
    return last?.stage === 'asked' ? last : null;
  }

  /** What is left today for an intake run: 0 over intake's spend cap (intake.max_usd_per_day), else the daily budget's rest. */
  protected intakeSpendLeft(cfg: IntakeConfig): number {
    const can = new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime()).canDraft();
    if (!can.ok && can.reason === 'spend_cap') return 0;
    return Math.max(0, this.d.cfg.agents.daily_budget_usd - this.spentToday());
  }

  /** A short no-tools run for a thread (its summary, or reading a message), counted against intake's spend cap. */
  private async threadModelRun(cfg: IntakeConfig, spec: ReturnType<typeof summaryRun>, kind: 'intake_summary' | 'intake_thread'): Promise<unknown> {
    const left = this.intakeSpendLeft(cfg);
    if (left <= 0) return undefined;
    const run = await this.d.runner.run({ ...spec, stateDir: this.d.stateDir, ...runRoute(this.d.cfg, kind), maxBudgetUsd: Math.max(0.05, Math.min(0.25, left)), stallMs: 2 * 60_000, timeoutMs: 5 * 60_000 });
    this.cost(null, spec.role, run);
    new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime()).recordSpend(run.costUsd);
    return run.reason === 'succeeded' ? (run.structured ?? null) : undefined;
  }

  /**
   * A mapped person's reply in a decision's or ask's thread. Exact option words answer it (as on the dashboard); a
   * plain-language pick is asked back ("Confirm: approve?") and recorded only on the same person's following yes; a
   * question is answered from the record and never answers anything.
   */
  private async threadReply(cfg: IntakeConfig, src: IntakeSource, r: IncomingReport, who: ChatPerson, thread: string, target: Target) {
    const id = reportId(r);
    const full = redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns });
    const redacted = excerpt(full);
    const record = (outcome: EventPayload<'discord.reply'>['outcome'], answer: string | null = null, kept: string | null = null) =>
      this.emit('discord.reply', { id, thread, target, by: who.login, outcome, answer, excerpt: kept });
    const reply = (text: string) => this.say(src, thread, `reply:${id}`, text);
    const t = this.threadTarget(target);
    if (!t) return;
    // Never from chat, whoever replies and whatever they say (a thread for one is never opened; this is the floor).
    if (t.never) {
      record('refused');
      return reply(t.what === 'decision' ? 'This is approved only on GitHub or the dashboard; a reply here changes nothing.' : 'This is answered only on the dashboard; a reply here changes nothing.');
    }
    if (t.closed) {
      record('already');
      return reply(t.closed.by ? alreadyText(t.closed.answer, t.closed.by) : t.what === 'ask' ? 'This was withdrawn; your reply changes nothing.' : 'This was answered already; your reply changes nothing.');
    }
    const comment = async () => {
      record('comment', null, redacted);
      if (t.what === 'decision' && t.issue !== null) await this.d.backlog.comment(t.issue, `[${BRAND.cli}] @${who.login} commented in chat on decision ${t.id} (a comment, not an answer):\n\n> ${redacted}`);
      return reply(commentText(who.login, t.who));
    };
    const answer = async (option: string) => {
      const got = t.answer(option, who);
      if (!got.ok && got.already) {
        record('already');
        return reply(got.already.by ? alreadyText(got.already.answer, got.already.by) : 'This was answered already; your reply changes nothing.');
      }
      if (!got.ok) {
        record('refused');
        return reply((got.error ?? 'refused').slice(0, 400));
      }
      record('answered', option);
      return this.say(src, thread, `decided:${target}`, decidedText(option, who.login));
    };
    const c = readConfirm(r.text);
    // A plain-language pick waits for its confirmation: only the same person's explicit yes records it.
    const pending = this.pendingConfirm(thread);
    if (pending) {
      if (pending.by.toLowerCase() === who.login.toLowerCase()) {
        this.emit('discord.confirm', { ...pending, stage: c === 'yes' ? 'confirmed' : 'dropped', msg: id });
        if (c === 'yes') return t.mayAnswer(who.role) ? answer(pending.option) : comment();
      } else if (c === 'yes' || c === 'vague') {
        record('ambiguous');
        return reply(notYourConfirmText(pending.by, pending.option));
      }
    }
    // Who may talk in a thread at all: an admin or a writer (a question, a pick); anyone else's reply is a comment.
    if (who.role !== 'owner' && who.role !== 'writer') return comment();
    // Exact option words answer directly, as before.
    const choice = parseChoice(r.text, t.options);
    if ('answer' in choice) return t.mayAnswer(who.role) ? answer(choice.answer) : comment();
    // A bare yes or ok with nothing to confirm names no option: asked back, with no run.
    if (c !== 'change') {
      record('ambiguous');
      return reply(askBack(t.options));
    }
    // A question or a plain-language pick: the thread run reads it from the record. Nothing it returns answers.
    const dash = base(cfg.discord.dashboard_url ?? '');
    const rec = await t.record();
    const links = [dash, ...(t.issue !== null ? [`https://github.com/${this.d.cfg.project.project.repo}/issues/${t.issue}`] : [])].filter(Boolean);
    const cwd = threadRunDir(dirname(this.d.repo), this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, `thread-${id}`);
    const raw = await this.threadModelRun(cfg, threadRun({ cwd, record: rec, message: full }), 'intake_thread');
    const got = acceptThread(raw, rec, links);
    if (got.intent === 'question') {
      record('question', null, redacted);
      for (const [i, text] of got.answer.entries()) await this.say(src, thread, `reply:${id}:${i}`, text);
      return;
    }
    if (got.intent === 'choice') {
      if (!t.mayAnswer(who.role)) return comment();
      this.emit('discord.confirm', { thread, target, by: who.login, option: got.option, stage: 'asked', msg: id });
      record('confirm', got.option);
      return reply(confirmText(got.option));
    }
    record('ambiguous');
    return reply(raw === undefined && dash ? `${noAnswerText(`${dash}/${t.what === 'ask' ? 'setup' : 'inbox'}`)} ${askBack(t.options)}`.slice(0, REPLY_CHARS) : askBack(t.options));
  }

  /**
   * Each open decision's or ask's thread, once: a plain-language summary from the intake-summary role, posted only
   * when it passes the facts check (checkSummary); else the fixed template and the dashboard link. Within intake's
   * spend cap; over it, the template.
   */
  private async explainThreads(cfg: IntakeConfig, src: IntakeSource): Promise<void> {
    const done = new Set(this.d.log.read(0, ['discord.explained']).map((e) => (e.payload as { target: string }).target));
    const dash = base(cfg.discord.dashboard_url ?? '');
    const repo = this.d.cfg.project.project.repo;
    for (const [thread, target] of this.channelThreads()) {
      if (done.has(target) || !(target.startsWith('decision:') || target.startsWith('ask:'))) continue;
      const t = this.threadTarget(target);
      if (!t || t.never || t.closed) continue;
      const rec = await t.record();
      const page = `${dash}/${t.what === 'ask' ? 'setup' : 'inbox'}`;
      const issueUrl = t.issue !== null ? `https://github.com/${repo}/issues/${t.issue}` : undefined;
      const cwd = threadRunDir(dirname(this.d.repo), this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, `summary-${createHash('sha256').update(target).digest('hex').slice(0, 16)}`);
      const raw = await this.threadModelRun(cfg, summaryRun({ cwd, record: rec }), 'intake_summary');
      const checked = raw === undefined ? { ok: false as const, why: 'no summary (the spend cap, or the run ended)' } : checkSummary(raw, rec, { ...(issueUrl ? { issueUrl } : {}), dashboardUrl: page });
      this.emit('discord.explained', { target, thread, used: checked.ok ? 'summary' : 'template', why: checked.ok ? null : checked.why.slice(0, 300) });
      const posts = checked.ok ? checked.posts : [fallbackSummary(t.template({ dashboardUrl: dash, repo }), page)];
      for (const [i, text] of posts.entries()) await this.say(src, thread, `explain:${target}:${i}`, text);
    }
  }

  /**
   * Post what waits on a person: each open decision and ask, once, in the asks channel (a thread each, or a notice
   * with a link); and in each thread, once, who decided it when it was decided elsewhere.
   */
  protected async channelOutbound(cfg: IntakeConfig): Promise<void> {
    const channel = cfg.discord.asks_channel;
    if (!this.channelOn(cfg) || !channel || !cfg.discord.dashboard_url) return;
    const src = this.chatSource()!;
    const posted = this.postedKeys();
    const answers = new Map(this.d.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).reverse().map((a) => [a.id, a]));
    const o = { dashboardUrl: cfg.discord.dashboard_url, repo: this.d.cfg.project.project.repo };
    for (const e of this.d.log.read(0, ['decision.asked'])) {
      const q = e.payload as EventPayload<'decision.asked'>;
      if (answers.has(q.id) || posted.has(`decision:${q.id}`)) continue;
      await this.channelSend(src, `decision:${q.id}`, { channel }, decisionPost(q, o));
    }
    const all = asksFrom(this.d.log.read(0, [...ASK_EVENTS]));
    for (const a of all) {
      if (a.status !== 'open' || posted.has(`ask:${a.id}`)) continue;
      await this.channelSend(src, `ask:${a.id}`, { channel }, askPost(a, o));
    }
    // The main watch's alerts: one notice per unaccounted commit.
    for (const e of this.d.log.read(0, ['main_watch.unaccounted'])) {
      const u = e.payload as EventPayload<'main_watch.unaccounted'>;
      if (!posted.has(`main-watch:${u.sha}`)) await this.channelSend(src, `main-watch:${u.sha}`, { channel }, mainWatchPost(u, o));
    }
    // Each new thread explained in plain language, once.
    await this.explainThreads(cfg, src);
    // Decided elsewhere (the dashboard, GitHub, the CLI): the thread says so, once.
    for (const [thread, target] of this.channelThreads()) {
      if (posted.has(`decided:${target}`)) continue;
      const [what, key] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
      const done = what === 'decision' ? answers.get(key) : what === 'ask' ? all.find((a) => a.id === key)?.answer : undefined;
      if (done) await this.say(src, thread, `decided:${target}`, decidedText(done.answer, done.by));
    }
  }
}
