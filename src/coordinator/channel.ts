// The chat channel (docs/intake.md, "Discord as the owner's channel"): open decisions and setup-console asks are
// posted in the configured channel, one thread each, and a reply in the thread answers them through the same code
// path as the dashboard (src/decide.ts, console/asks.ts), with the same roles, audited with via "discord".
// - Who: only allowed senders mapped to a GitHub login (discord.people); their role is that login's repo permission
//   (intake deps' roleOf, as the dashboard reads it). Anyone unmapped is ignored: nothing stored.
// - Someone who may not answer a thing (a writer on an owner decision) is recorded as a comment, never an answer.
// - A reply that doesn't name exactly one option answers nothing; the bot asks back with the options.
// - The first recorded answer stands; a later one is refused, naming who decided.
// - A secret (or a root step) posts only a dashboard link; with discord.owners set, in a thread where an owner may
//   reply "link" for a one-time link to it by DM (nothing typed there is kept).
// - A high-risk merge (an L3 landing decision; a PR the merge policy left to an owner): without discord.owners, a
//   notice with links only; with them, a thread that only they answer, naming its number ("approve 12"), through
//   the same decide and merge checks as on the dashboard; the other owners are pinged in it once it's approved.
// Every post is recorded before it is sent (discord.posting) and after (discord.posted), so none is sent twice.
import type { EventPayload } from '../events/types.js';
import { ASK_EVENTS, asksFrom, asks as askApi, AskError } from '../console/asks.js';
import { answerDecision, auditWrite, firstAnswer, mergeApproval } from '../decide.js';
import { issueSetupLink, LINK_TTL_MS } from '../console/links.js';
import type { Ask } from '../console/asks.js';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { alreadyText, approvedText, askBack, askPost, asksForLink, commentText, decidedText, decisionPost, dmText, highRiskAskBack, mainWatchPost, mergePost, usagePausePost, notOwnerText, parseChoice, parseHighRisk, readConfirm, SETUP_NOT_OWNER_TEXT, SETUP_THREAD_TEXT, wrongNumberText, type ChannelPost } from '../intake/channel.js';
import { REPLY_CHARS } from '../intake/discord.js';
import { acceptThread, checkSummary, confirmText, fallbackSummary, noAnswerText, notYourConfirmText, summaryRun, threadRun, threadRunDir, type ThreadRecord } from '../intake/explain.js';
import { redactString } from '../events/redact.js';
import { runRoute } from './model-routing.js';
import { NEVER_FROM_CHAT, mayAnswerAskFromChat, mayAnswerFromChat, mayApproveHighRisk, personOf, type ChatPerson } from '../intake/people.js';
import { redactPii } from '../intake/redact.js';
import { IntakeMeter, markSeen, reportId, storeRaw } from '../intake/store.js';
import type { IncomingReport, IntakeConfig, IntakeSource } from '../intake/report.js';
import { OWNER_DECISIONS } from '../dashboard-auth.js';
import { BRAND } from '../brand.js';
import { currentValue, intakeCaps } from '../settings.js';
import { trustDigest, trustView, trustWeek } from '../trust.js';
import { excerpt } from '../intake/decide.js';
import { ResearchOnDemand } from './research-on-demand.js';

/** The marker in an intake issue's body that ties it to its report, so it is never filed twice. */
const intakeMarker = (id: string) => `<!-- intake:${id} -->`;

/** What a thread is for: `decision:<id>`, `ask:<id>`, `merge:<number>@<head>` or `idea:<id>` (the key of the post that opened it). */
export type Target = string;

/** A decision's or ask's thread, as a reply in it is handled (Channel.threadTarget). */
/** What a high-risk approval (or rejection) from a thread did. */
type ApprovalResult = { ok: true } | { ok: false; already?: { answer: string; by: string }; error?: string };

interface ThreadTarget {
  what: 'decision' | 'ask' | 'merge';
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
  answer: (option: string, who: ChatPerson) => ApprovalResult;
  /**
   * A high-risk merge with Discord owners: only they answer it, naming `number` (the PR's; a landing decision's
   * issue, which has no PR yet). `merge`: a PR's merge, else a landing decision. `reject`: whether one can be.
   */
  highRisk?: { number: number; merge: boolean; approve: (who: ChatPerson) => Promise<ApprovalResult>; reject?: (who: ChatPerson) => Promise<ApprovalResult> };
  /** A secret or root-step ask with Discord owners: a reply only asks for its one-time link; nothing typed is kept. */
  setupStep?: Ask;
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
  /**
   * The merge flow's (merge-flow.ts): an owner's approval, from a thread, of PR `number` waiting for an owner at
   * `head`, after the same checks a merge needs (the head unchanged, its required checks green, auto-merge not
   * stopped); recorded, and merged on the next pass through the normal merge path.
   */
  protected abstract chatApproveMerge(number: number, head: string, who: ChatPerson): Promise<ApprovalResult>;
  /** Why auto-merge is stopped on this instance (the main watch, a red main), or null (merge-flow.ts). */
  abstract autoMergeStopped(): string | null;

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
        // Mentions only ever ping discord.owners, and only in the bot's own threads or the ops channel: the adapter's rule.
        ok = await src.reply('thread' in where ? { kind: 'thread', id: where.thread } : { kind: 'channel', id: where.channel }, post.text, post.kind === 'notice' && post.mentions?.length ? { mentions: post.mentions } : undefined);
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
      const got = await this.acceptThreadReply(cfg, r, threads, meter);
      if (got === 'ignored') ignored.push(r);
      else if (got === 'rest') rest.push(r);
      else if (got) await this.threadReply(cfg, src, r, got.person, r.thread!.id, got.target);
    }
    return { rest, ignored };
  }

  /**
   * A message from the chat source, before it is handled: a reply in one of the bot's threads, taken (stored, once),
   * with who sent it and what the thread is for; `ignored` (unmapped, or a reply in a thread that isn't ours, or a
   * chat-channel one: nothing stored); `rest` for intake; null when it was taken before.
   */
  protected async acceptThreadReply(cfg: IntakeConfig, r: IncomingReport, threads: Map<string, Target>, meter: () => IntakeMeter): Promise<{ person: ChatPerson; target: Target } | 'ignored' | 'rest' | null> {
    const person = await personOf(cfg, r.sender.id, this.d.intake?.roleOf);
    if (!person) {
      // Unmapped: ignored entirely, before anything of the message is stored.
      meter().countDrop('unmapped');
      return 'ignored';
    }
    const target = r.thread?.kind === 'thread' ? threads.get(r.thread.id) : undefined;
    // A reply in a thread that isn't one of this instance's: never an answer here, and never a report.
    // A chat-channel message is never a report either (src/coordinator/channel-chat.ts takes those first).
    if (!target) return r.thread?.kind === 'thread' || r.thread?.kind === 'chat' ? 'ignored' : 'rest';
    // Each message is taken once (the seen ledger), however often the gateway delivers it. In a setup step's thread
    // nothing of the message is kept, not even privately: a secret might be typed there by mistake.
    return (this.isSetupStep(target) ? markSeen(this.d.stateDir, r) : storeRaw(this.d.stateDir, r)) ? { person, target } : null;
  }

  /**
   * What a thread is for, read from the log: its record (for the summary and questions), its options, whether it
   * is closed (answered, or withdrawn), who may answer it, and how an answer is recorded (the dashboard's own path).
   */
  /** A secret or root-step ask's thread. */
  private isSetupStep(target: Target): boolean {
    if (!target.startsWith('ask:')) return false;
    const a = asksFrom(this.d.log.read(0, [...ASK_EVENTS])).find((x) => x.id === target.slice(4));
    return a?.kind === 'paste_secret' || a?.kind === 'root_step';
  }

  /** Why nothing may be approved now, whatever it is: an emergency stop, or auto-merge stopped (the main watch). */
  private approvalHold(): string | null {
    if (this.emergencyInForce()) return 'an emergency stop is in force; nothing is approved';
    const stopped = this.autoMergeStopped();
    return stopped ? `auto-merge is stopped on this instance (${stopped.slice(0, 200)}); an admin clears it on the dashboard first. Nothing is approved` : null;
  }

  /** PRs the merge policy left to an owner, still open: the latest merge.decided per PR, when it wasn't auto. */
  protected waitingMerges(): { issue: number; number: number; head: string; reasons: string[]; url: string }[] {
    const out = new Map<number, { issue: number; number: number; head: string; reasons: string[]; url: string }>();
    const urls = new Map<number, string>();
    for (const e of this.d.log.read(0, ['pr.opened', 'merge.decided', 'merge.done', 'pr.closed'])) {
      if (e.type === 'pr.opened') {
        const p = e.payload as EventPayload<'pr.opened'>;
        urls.set(p.number, p.url);
      } else if (e.type === 'merge.decided') {
        const p = e.payload as EventPayload<'merge.decided'>;
        if (p.auto) out.delete(p.number);
        else out.set(p.number, { issue: p.issue, number: p.number, head: p.head, reasons: p.reasons, url: urls.get(p.number) ?? '' });
      } else out.delete((e.payload as { number: number }).number);
    }
    return [...out.values()];
  }

  private threadTarget(target: Target, cfg: IntakeConfig): ThreadTarget | null {
    const [what, key] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
    const owners = cfg.discord.owners.length > 0;
    if (what === 'merge') {
      const m = key.match(/^(\d+)@([0-9a-f]{7,40})$/);
      if (!m) return null;
      const number = Number(m[1]);
      const head = m[2]!;
      const waiting = this.waitingMerges().find((w) => w.number === number);
      const approved = mergeApproval(this.d.log, number, head);
      const merged = this.d.log.read(0, ['merge.done']).some((e) => (e.payload as EventPayload<'merge.done'>).number === number);
      const issue = waiting?.issue ?? null;
      const post = (o: { dashboardUrl: string }) => mergePost({ number, issue: issue ?? 0, head, url: waiting?.url ?? '', reasons: waiting?.reasons ?? [] }, o).text;
      return {
        what,
        kind: 'merge',
        id: key,
        issue,
        options: ['approve'],
        never: false,
        // Approved (by whom), merged, or no longer waiting at this head (a new head, closed): nothing to answer.
        closed: approved ? { answer: 'approve', by: approved.by } : merged || !waiting || waiting.head !== head ? { answer: '', by: '' } : null,
        mayAnswer: () => false,
        who: 'an owner listed for Discord approvals',
        template: (o) => post(o),
        record: async () => ({ kind: 'merge', issue, question: `merge PR #${number}`, options: ['approve'], recommendation: '', risk: { level: null, notes: [] } }),
        answer: () => ({ ok: false, error: `reply "approve ${number}"` }),
        highRisk: { number, merge: true, approve: (who) => this.chatApproveMerge(number, head, who) },
      };
    }
    if (what === 'decision') {
      const asked = this.d.log.read(0, ['decision.asked']).find((e) => (e.payload as EventPayload<'decision.asked'>).id === key);
      const q = asked?.payload as EventPayload<'decision.asked'> | undefined;
      if (!asked || !q) return null;
      const first = firstAnswer(this.d.log, q.id);
      // The dashboard's own decide path: the same checks, record and audit, with via "discord".
      const viaDecide = (option: string, who: ChatPerson): ApprovalResult => {
        const got = answerDecision(this.d.log, { id: q.id, answer: option, who: { login: who.login, role: who.role!, via: 'discord' }, instance: this.d.instance, repo: this.d.cfg.project.project.repo });
        return got.ok ? { ok: true } : got.status === 409 ? { ok: false, already: { answer: got.answer!, by: got.by! } } : { ok: false, error: got.error };
      };
      // A landing decision with Discord owners: they approve it by its issue's number, if the change it is about is
      // still the one decided on (no new attempt since), and nothing holds merges.
      const highRisk: ThreadTarget['highRisk'] =
        NEVER_FROM_CHAT.has(q.kind) && owners && q.issue !== null
          ? {
              number: q.issue,
              merge: false,
              approve: async (who) => {
                const since = this.d.log.read(asked.id, ['review.level_set', 'land.queued', 'issue.released']).filter((e) => (e.payload as { issue: number }).issue === q.issue);
                if (since.some((e) => e.type === 'review.level_set')) return { ok: false, error: `#${q.issue} was changed again since this decision (a new head); nothing is approved: the new head gets its own decision` };
                if (since.length) return { ok: false, error: `#${q.issue} was already acted on since this decision; nothing is approved` };
                const hold = this.approvalHold();
                return hold ? { ok: false, error: hold } : viaDecide('approve', who);
              },
              reject: async (who) => viaDecide('reject', who),
            }
          : undefined;
      return {
        what,
        kind: q.kind,
        id: q.id,
        issue: q.issue,
        options: q.options,
        never: NEVER_FROM_CHAT.has(q.kind) && !highRisk,
        closed: first ? { answer: first.answer, by: first.by } : null,
        mayAnswer: (role) => mayAnswerFromChat(q.kind, role),
        who: OWNER_DECISIONS.has(q.kind) ? 'an admin' : 'an admin or a writer',
        template: (o) => decisionPost(q, { ...o, owners }).text,
        record: () => this.decisionRecord(q),
        answer: viaDecide,
        ...(highRisk ? { highRisk } : {}),
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
        template: (o) => askPost(a, { ...o, owners }).text,
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
        ...(owners && (a.kind === 'paste_secret' || a.kind === 'root_step') ? { setupStep: a } : {}),
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
    // A question in a thread has a person waiting: it doesn't queue behind agent runs (src/runner.ts loginStartLock).
    const run = await this.d.runner.run({ ...spec, stateDir: this.d.stateDir, ...runRoute(this.d.cfg, kind), ...(kind === 'intake_thread' ? { interactive: true } : {}), maxBudgetUsd: Math.max(0.05, Math.min(0.25, left)), stallMs: 2 * 60_000, timeoutMs: 5 * 60_000 });
    this.cost(null, spec.role, run);
    new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime()).recordSpend(run.costUsd);
    return run.reason === 'succeeded' ? (run.structured ?? null) : undefined;
  }

  /**
   * A mapped person's reply in a decision's or ask's thread. Exact option words answer it (as on the dashboard); a
   * plain-language pick is asked back ("Confirm: approve?") and recorded only on the same person's following yes; a
   * question is answered from the record and never answers anything.
   */
  protected async threadReply(cfg: IntakeConfig, src: IntakeSource, r: IncomingReport, who: ChatPerson, thread: string, target: Target) {
    const t0 = this.threadTarget(target, cfg);
    if (!t0) return;
    // A setup step's thread: before anything of the message is read further (nothing of it is kept).
    if (t0.setupStep) return this.setupStepReply(cfg, src, r, who, thread, target, t0.setupStep, t0.closed !== null);
    const id = reportId(r);
    const full = redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns });
    const redacted = excerpt(full);
    const record = (outcome: EventPayload<'discord.reply'>['outcome'], answer: string | null = null, kept: string | null = null) =>
      this.emit('discord.reply', { id, thread, target, by: who.login, outcome, answer, excerpt: kept });
    const reply = (text: string) => this.say(src, thread, `reply:${id}`, text);
    const t = t0;
    if (t.highRisk) return this.highRiskReply(cfg, src, r, who, thread, target, t, t.highRisk, { record, reply, redacted });
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
    // A held plan's thread also takes "approve plan <n>"; one naming another number answers nothing.
    const choice = parseChoice(r.text, t.options, t.kind === 'plan' && t.issue !== null ? { plan: t.issue } : {});
    if ('answer' in choice) return t.mayAnswer(who.role) ? answer(choice.answer) : comment();
    if (choice.wrongNumber !== undefined && t.issue !== null) {
      record('ambiguous');
      return reply(wrongNumberText(t.issue, choice.wrongNumber));
    }
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
   * A reply in a high-risk thread (an L3 landing decision, or a PR waiting for an owner). Only an owner listed in
   * discord.owners whose login is an admin now may answer it, and only by naming its number: "approve 12". Anyone
   * else's reply is a comment. No model reads these replies. Approved, the other owners are pinged in the thread.
   */
  private async highRiskReply(
    cfg: IntakeConfig,
    src: IntakeSource,
    r: IncomingReport,
    who: ChatPerson,
    thread: string,
    target: Target,
    t: ThreadTarget,
    h: NonNullable<ThreadTarget['highRisk']>,
    io: { record: (outcome: EventPayload<'discord.reply'>['outcome'], answer?: string | null, kept?: string | null) => unknown; reply: (text: string) => Promise<unknown>; redacted: string },
  ) {
    const { record, reply, redacted } = io;
    if (t.closed) {
      record('already');
      return reply(t.closed.by ? alreadyText(t.closed.answer, t.closed.by) : h.merge ? `PR #${h.number} no longer waits at this head; your reply changes nothing.` : 'This was answered already; your reply changes nothing.');
    }
    if (!mayApproveHighRisk(cfg, r.sender.id, who.role)) {
      record('comment', null, redacted);
      if (t.issue !== null) await this.d.backlog.comment(t.issue, `[${BRAND.cli}] @${who.login} commented in chat on high-risk ${h.merge ? `PR #${h.number}` : `decision ${t.id}`} (a comment, not an approval):\n\n> ${redacted}`);
      return reply(notOwnerText(who.login));
    }
    const p = parseHighRisk(r.text);
    if (!p || (p.act === 'approve' && p.number === null) || (p.act === 'reject' && !h.reject)) {
      record('ambiguous');
      return reply(p?.act === 'reject' ? `Nothing here rejects PR #${h.number}: leave it, or close it on GitHub. ${highRiskAskBack(h.number, false)}` : highRiskAskBack(h.number, !!h.reject));
    }
    if (p.number !== null && p.number !== h.number) {
      record('refused');
      return reply(wrongNumberText(h.number, p.number));
    }
    const got = await (p.act === 'approve' ? h.approve(who) : h.reject!(who));
    if (!got.ok && got.already) {
      record('already');
      return reply(got.already.by ? alreadyText(got.already.answer, got.already.by) : 'This was answered already; your reply changes nothing.');
    }
    if (!got.ok) {
      record('refused');
      return reply(`Not ${p.act === 'approve' ? 'approved' : 'rejected'}: ${(got.error ?? 'refused').slice(0, 400)}`);
    }
    record('answered', p.act);
    // The one place a post pings anyone: the other Discord owners, in this thread.
    const others = cfg.discord.owners.filter((o) => o !== r.sender.id);
    const text = p.act === 'approve' ? approvedText(h.number, who.login, h.merge) : decidedText('reject', who.login);
    return this.channelSend(src, `decided:${target}`, { thread }, { kind: 'notice', text, ...(p.act === 'approve' && others.length ? { mentions: others } : {}) });
  }

  /**
   * A reply in a setup step's thread (a secret or a root step). It never answers the step and nothing of it is kept:
   * from an owner listed in discord.owners, "link" gets them a one-time link to the step's paste box by DM (bound to
   * the step and their GitHub login; src/console/links.ts); anything else, or anyone else, gets the fixed reply.
   */
  private async setupStepReply(cfg: IntakeConfig, src: IntakeSource, r: IncomingReport, who: ChatPerson, thread: string, target: Target, a: Ask, closed: boolean) {
    const id = reportId(r);
    const record = (outcome: EventPayload<'discord.reply'>['outcome']) => this.emit('discord.reply', { id, thread, target, by: who.login, outcome, answer: null, excerpt: null });
    const reply = (text: string) => this.say(src, thread, `reply:${id}`, text);
    const dash = base(cfg.discord.dashboard_url ?? '');
    if (closed) {
      record('already');
      return reply('This setup step is no longer waiting; nothing here changes it.');
    }
    if (!mayApproveHighRisk(cfg, r.sender.id, who.role)) {
      record('comment');
      return reply(SETUP_NOT_OWNER_TEXT);
    }
    if (!asksForLink(r.text)) {
      record('ambiguous');
      return reply(SETUP_THREAD_TEXT);
    }
    if (!dash || !src.dm) {
      record('refused');
      return reply(`Open it on the dashboard: ${dash}/setup`);
    }
    const { token } = issueSetupLink(this.d.log, { ask: a.id, login: who.login, now: (this.d.now?.() ?? new Date()).getTime() });
    // The token in the path, never a query; the page exchanges it by POST.
    const url = `${dash}/setup/link/${encodeURIComponent(this.d.intake?.name ?? '-')}/${token}`;
    let sent = false;
    try {
      sent = await src.dm(r.sender.id, dmText({ title: a.title, login: who.login, url, minutes: LINK_TTL_MS / 60_000 }));
    } catch {
      sent = false;
    }
    record(sent ? 'link' : 'refused');
    return reply(sent ? `Sent @${who.login} a one-time link to this step by DM (it works once, for ${LINK_TTL_MS / 60_000} minutes).` : `I couldn't send you a DM (are direct messages from this server's members open?). Open it on the dashboard: ${dash}/setup`);
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
      const t = this.threadTarget(target, cfg);
      if (!t || t.never || t.closed || t.highRisk || t.setupStep) continue;
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
   * The weekly trust digest (src/trust.ts): once per week (Monday, UTC), a plain message in the ops channel, when one
   * is set. Read-only measurement: it posts numbers and a recommendation, and changes nothing.
   */
  protected async trustDigestOutbound(cfg: IntakeConfig): Promise<void> {
    const channel = cfg.discord.ops_channel;
    const src = this.chatSource();
    if (!cfg.discord.enabled || !channel || !src) return;
    const now = this.d.now?.() ?? new Date();
    const key = `trust-digest:${trustWeek(now)}`;
    if (this.postedKeys().has(key)) return;
    const agents = Number(currentValue(this.d.cfg, this.d.settings?.().settings ?? {}, 'workers'));
    const text = trustDigest(trustView(this.d.log.read(0), { agents, now }), { instance: this.d.instance, dashboardUrl: cfg.discord.dashboard_url ?? null });
    await this.channelSend(src, key, { channel }, { kind: 'notice', text });
  }

  /**
   * Post what waits on a person: each open decision and ask, once, in the asks channel (a thread each, or a notice
   * with a link); and in each thread, once, who decided it when it was decided elsewhere.
   */
  protected async channelOutbound(cfg: IntakeConfig): Promise<void> {
    await this.trustDigestOutbound(cfg);
    const channel = cfg.discord.asks_channel;
    if (!this.channelOn(cfg) || !channel || !cfg.discord.dashboard_url) return;
    const src = this.chatSource()!;
    const posted = this.postedKeys();
    const answers = new Map(this.d.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).reverse().map((a) => [a.id, a]));
    const o = { dashboardUrl: cfg.discord.dashboard_url, repo: this.d.cfg.project.project.repo, owners: cfg.discord.owners.length > 0 };
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
    // PRs the merge policy left to an owner: with Discord owners, a thread each (per head) they approve it in.
    if (o.owners) {
      for (const w of this.waitingMerges()) {
        const key = `merge:${w.number}@${w.head}`;
        if (!posted.has(key)) await this.channelSend(src, key, { channel }, mergePost(w, o));
      }
    }
    // The main watch's alerts: one notice per unaccounted commit.
    for (const e of this.d.log.read(0, ['main_watch.unaccounted'])) {
      const u = e.payload as EventPayload<'main_watch.unaccounted'>;
      if (!posted.has(`main-watch:${u.sha}`)) await this.channelSend(src, `main-watch:${u.sha}`, { channel }, mainWatchPost(u, o));
    }
    // The usage-limit pause in force: one notice for it, with its reset time.
    const pause = this.usagePause();
    if (pause && !posted.has(`usage-limit:${pause.id}`)) await this.channelSend(src, `usage-limit:${pause.id}`, { channel }, usagePausePost(pause, { dashboardUrl: o.dashboardUrl, instance: this.d.instance, now: this.nowMs() }));
    // Each new thread explained in plain language, once.
    await this.explainThreads(cfg, src);
    // Decided elsewhere (the dashboard, GitHub, the CLI): the thread says so, once.
    for (const [thread, target] of this.channelThreads()) {
      const [what, key] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
      if (what === 'merge' && !posted.has(`merged:${target}`)) {
        // Merged (on GitHub, or after an approval here): the thread says so, once.
        const [number, head] = [Number(key.split('@')[0]), key.split('@')[1]];
        const m = this.d.log.read(0, ['merge.done']).map((e) => e.payload as EventPayload<'merge.done'>).find((x) => x.number === number && x.head === head);
        if (m) await this.say(src, thread, `merged:${target}`, `Merged: PR #${number} is on the default branch (${m.sha.slice(0, 8)}).`);
        continue;
      }
      if (what === 'merge' || posted.has(`decided:${target}`)) continue;
      const done = what === 'decision' ? answers.get(key) : what === 'ask' ? all.find((a) => a.id === key)?.answer : undefined;
      if (done) await this.say(src, thread, `decided:${target}`, decidedText(done.answer, done.by));
    }
  }
}
