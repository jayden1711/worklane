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
import { alreadyText, askBack, askPost, commentText, decidedText, decisionPost, mainWatchPost, parseChoice, type ChannelPost } from '../intake/channel.js';
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
    if (!this.channelOn(cfg)) return { rest: reports.filter((r) => r.thread?.kind !== 'thread'), ignored: reports.filter((r) => r.thread?.kind === 'thread') };
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
        if (r.thread?.kind === 'thread') ignored.push(r);
        else rest.push(r);
        continue;
      }
      // Each message is taken once (the seen ledger), however often the gateway delivers it.
      if (!storeRaw(this.d.stateDir, r)) continue;
      await this.threadReply(cfg, src, r, person, r.thread!.id, target);
    }
    return { rest, ignored };
  }

  /** A mapped person's reply in a decision's or ask's thread. */
  private async threadReply(cfg: IntakeConfig, src: IntakeSource, r: IncomingReport, who: ChatPerson, thread: string, target: Target) {
    const id = reportId(r);
    const redacted = excerpt(redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns }));
    const record = (outcome: EventPayload<'discord.reply'>['outcome'], answer: string | null = null, kept: string | null = null) =>
      this.emit('discord.reply', { id, thread, target, by: who.login, outcome, answer, excerpt: kept });
    const reply = (text: string) => this.say(src, thread, `reply:${id}`, text);
    const [what, key] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
    if (what === 'decision') {
      const q = this.d.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).find((x) => x.id === key);
      if (!q) return;
      // Never from chat, whoever replies and whatever they say (a thread for one is never opened; this is the floor).
      if (NEVER_FROM_CHAT.has(q.kind)) {
        record('refused');
        return reply('This is approved only on GitHub or the dashboard; a reply here changes nothing.');
      }
      const first = firstAnswer(this.d.log, q.id);
      if (first) {
        record('already');
        return reply(alreadyText(first.answer, first.by));
      }
      if (!mayAnswerFromChat(q.kind, who.role)) {
        record('comment', null, redacted);
        if (q.issue !== null) await this.d.backlog.comment(q.issue, `[${BRAND.cli}] @${who.login} commented in chat on decision ${q.id} (a comment, not an answer):\n\n> ${redacted}`);
        return reply(commentText(who.login, OWNER_DECISIONS.has(q.kind) ? 'an admin' : 'an admin or a writer'));
      }
      const choice = parseChoice(r.text, q.options);
      if (!('answer' in choice)) {
        record('ambiguous');
        return reply(askBack(q.options));
      }
      // The dashboard's own decide path: the same checks, record and audit, with via "discord".
      const got = answerDecision(this.d.log, { id: q.id, answer: choice.answer, who: { login: who.login, role: who.role!, via: 'discord' }, instance: this.d.instance, repo: this.d.cfg.project.project.repo });
      if (!got.ok && got.status === 409) {
        record('already');
        return reply(alreadyText(got.answer!, got.by!));
      }
      if (!got.ok) {
        record('refused');
        return reply(got.error.slice(0, 400));
      }
      record('answered', choice.answer);
      return this.say(src, thread, `decided:${target}`, decidedText(choice.answer, who.login));
    }
    if (what === 'ask') {
      const a = asksFrom(this.d.log.read(0, [...ASK_EVENTS])).find((x) => x.id === key);
      if (!a) return;
      if (a.status !== 'open') {
        record('already');
        return reply(a.answer ? alreadyText(a.answer.answer, a.answer.by) : 'This was withdrawn; your reply changes nothing.');
      }
      if (!mayAnswerAskFromChat(a, who.role)) {
        record(a.kind === 'question' || a.kind === 'approve_link' ? 'comment' : 'refused', null, redacted);
        return reply(commentText(who.login, a.kind === 'question' && a.writersMayAnswer ? 'an admin or a writer' : 'an admin'));
      }
      const options = a.kind === 'question' ? a.options : ['approved', 'declined'];
      const choice = parseChoice(r.text, options);
      if (!('answer' in choice)) {
        record('ambiguous');
        return reply(askBack(options));
      }
      try {
        askApi(this.d.log).answer(a.id, { by: who.login, role: who.role, answer: choice.answer });
      } catch (e) {
        if (e instanceof AskError && e.status === 409) {
          record('already');
          return reply('This was answered already; your reply changes nothing.');
        }
        if (e instanceof AskError) {
          record('refused');
          return reply(e.message.slice(0, 400));
        }
        throw e;
      }
      auditWrite(this.d.log, { login: who.login, role: who.role!, via: 'discord' }, this.d.instance, 'ask.answered', { id: a.id, kind: a.kind, answer: choice.answer });
      record('answered', choice.answer);
      return this.say(src, thread, `decided:${target}`, decidedText(choice.answer, who.login));
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
    // Decided elsewhere (the dashboard, GitHub, the CLI): the thread says so, once.
    for (const [thread, target] of this.channelThreads()) {
      if (posted.has(`decided:${target}`)) continue;
      const [what, key] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
      const done = what === 'decision' ? answers.get(key) : what === 'ask' ? all.find((a) => a.id === key)?.answer : undefined;
      if (done) await this.say(src, thread, `decided:${target}`, decidedText(done.answer, done.by));
    }
  }
}
