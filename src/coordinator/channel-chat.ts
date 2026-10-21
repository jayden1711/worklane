// The chat channels (docs/intake.md 2.1.3): in intake.yaml's discord.chat_channels, the bot is a conversational
// assistant for mapped admins and writers. It replies to every message of theirs (no mention needed), with the
// channel's recent conversation, the instance's state (open issues, pull requests, decisions, recent runs, from the
// event log and run records the coordinator already has) and read-only Read, Glob and Grep of the checkout.
//
// What it can never do is not a prompt rule only: this module's one action is posting a checked reply. A chat
// message is never a report (never triaged or filed), never a thread reply (never answers a decision or ask), and
// the run's output is one string; nothing here files, answers, changes a setting or starts or stops anything. The
// run itself is the channel-chat role in its own lane (src/intake/chat.ts): the instance's agent user, sandboxed,
// with exactly Read, Glob and Grep inside the checkout and no credential, key, config or .env file.
//
// Costs: its own daily cap (discord.chat_max_usd_per_day), and every run counts against the instance's daily budget
// (run.cost). Over either, it says so once that day and is quiet until the next.
// Anyone unmapped, a viewer, and any channel not listed: ignored, nothing stored.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contextFromEvents, recentRuns } from '../chat.js';
import { redactString } from '../events/redact.js';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
import { intakeCaps } from '../settings.js';
import { CHAT_BUDGET_TEXT, CHAT_FAILED_TEXT, CHAT_REFUSED_TEXT, chatCapText, chatLinks, chatPrompt, chatRun, checkChatReply, type ChatTurn } from '../intake/chat.js';
import { CHAT_ROLE } from '../guard/chat.js';
import { mayAddIdea, personOf, type ChatPerson } from '../intake/people.js';
import { redactPii } from '../intake/redact.js';
import type { IncomingReport, IntakeConfig, IntakeSource } from '../intake/report.js';
import { IntakeMeter, reportId, storeRaw } from '../intake/store.js';
import { Conversation } from './conversation.js';
import { AuthPaused } from './shared.js';
import { AUTH_FAILED_CHAT_TEXT } from '../claude-auth-failure.js';
import type { RunResult } from '../runner.js';

/** Turns of a channel's conversation a reply sees. */
const HISTORY_TURNS = 10;

export abstract class ChannelChat extends Conversation {
  private chatOn(cfg: IntakeConfig) {
    return this.channelOn(cfg) && cfg.discord.chat_channels.length > 0;
  }

  /** Chat-channel messages first: each one from a mapped admin or writer gets a reply; anything else is ignored. */
  protected override async channelInbound(cfg: IntakeConfig, reports: IncomingReport[]): Promise<{ rest: IncomingReport[]; ignored: IncomingReport[] }> {
    const chats = reports.filter((r) => r.thread?.kind === 'chat');
    const out = await super.channelInbound(cfg, reports.filter((r) => r.thread?.kind !== 'chat'));
    if (!chats.length) return out;
    for (const r of chats) {
      const person = await this.acceptChat(cfg, r);
      if (person === 'ignored') out.ignored.push(r);
      else if (person) await this.chatReply(cfg, this.chatSource()!, r, person);
    }
    return out;
  }

  /**
   * Whether a chat-channel message gets a reply: its sender when it does (the message is stored, taken once);
   * `ignored` when chat is off, the channel isn't listed, or the sender is unmapped or a viewer (nothing stored);
   * null when it was taken before (the gateway delivered it again).
   */
  protected async acceptChat(cfg: IntakeConfig, r: IncomingReport): Promise<ChatPerson | 'ignored' | null> {
    // Chat off, or a channel no longer listed: never a report, never stored.
    if (!this.chatOn(cfg) || !cfg.discord.chat_channels.includes(r.thread!.id)) return 'ignored';
    const person = await personOf(cfg, r.sender.id, this.d.intake?.roleOf);
    // Unmapped: ignored entirely, before anything of the message is stored. A viewer gets no reply either.
    if (!person || !mayAddIdea(person.role)) {
      new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime()).countDrop(person ? 'not_writer' : 'unmapped');
      return 'ignored';
    }
    // Each message is taken once (the seen ledger), however often the gateway delivers it.
    return storeRaw(this.d.stateDir, r) ? person : null;
  }

  private historyFile(channel: string) {
    return join(this.d.stateDir, 'intake', 'chat', `${channel.replace(/\D/g, '')}.json`);
  }

  /** The channel's recent conversation (redacted, in the coordinator's private store). */
  protected chatHistory(channel: string): ChatTurn[] {
    try {
      return (JSON.parse(readFileSync(this.historyFile(channel), 'utf8')) as ChatTurn[]).slice(-HISTORY_TURNS);
    } catch {
      return [];
    }
  }

  private keepTurn(channel: string, turn: ChatTurn) {
    ownerOnlyDir(join(this.d.stateDir, 'intake'));
    ownerOnlyDir(join(this.d.stateDir, 'intake', 'chat'));
    writeOwnerOnly(this.historyFile(channel), JSON.stringify([...this.chatHistory(channel), turn].slice(-HISTORY_TURNS)));
  }

  /** The instance's state as the chat sees it: open issues, pull requests, open decisions, recent runs. Redacted. */
  protected chatState(): string {
    const ctx = contextFromEvents(this.d.log.read());
    const issues = ctx.issues.filter((i) => i.status !== 'closed').slice(-40);
    const prs = ctx.prs.filter((p) => p.state !== 'merged' && p.state !== 'closed').slice(-30);
    const runs = recentRuns(this.d.stateDir, 15);
    return redactString(
      [
        `Instance ${this.d.instance}, repository ${this.d.cfg.project.project.repo}.`,
        `Open issues:\n${issues.map((i) => `- #${i.number} (${i.status}) ${i.title}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`).join('\n') || '(none recorded)'}`,
        `Open pull requests:\n${prs.map((p) => `- #${p.number} (${p.state})${p.issue !== null ? ` for issue #${p.issue}` : ''}: ${p.title}`).join('\n') || '(none recorded)'}`,
        `Open decisions:\n${ctx.decisions.map((d) => `- ${d.id}: ${d.question.slice(0, 300)} (options: ${d.options.join(', ')})`).join('\n') || '(none)'}`,
        `Recent runs:\n${runs.map((r) => `- ${r.role}${r.issue !== null ? ` on issue #${r.issue}` : ''}: ${r.reason ?? 'running'}`).join('\n') || '(none recorded)'}`,
      ].join('\n\n'),
    );
  }

  /** One reply: within the chat's cap and the daily budget, a channel-chat run, its reply checked, then posted. */
  protected async chatReply(cfg: IntakeConfig, src: IntakeSource, r: IncomingReport, who: ChatPerson) {
    const id = reportId(r);
    const channel = r.thread!.id;
    const say = (key: string, text: string) => this.say(src, channel, `chat:${id}:${key}`, text);
    const done = (outcome: 'answered' | 'refused' | 'failed' | 'capped', messages: number, why: string | null) => this.emit('discord.chat', { id, channel, by: who.login, outcome, messages, why });
    const meter = new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
    const cap = cfg.discord.chat_max_usd_per_day;
    const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
    if (!meter.canChat(cap) || left <= 0) {
      const over = !meter.canChat(cap) ? 'chat_cap' : 'budget';
      done('capped', 0, over);
      // Said once a day; quiet after that until the next day.
      if (meter.chatCapNotice()) await say('capped', over === 'chat_cap' ? chatCapText(cap) : CHAT_BUDGET_TEXT);
      return;
    }
    const message = redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns });
    const history = this.chatHistory(channel);
    const spec = chatRun({ repo: this.d.repo, model: cfg.discord.chat_model, prompt: chatPrompt({ state: this.chatState(), history, by: who.login, message }) });
    let run: RunResult;
    try {
      run = await this.d.runner.run({
        ...spec,
        stateDir: this.d.stateDir,
        route: { kind: 'other', fallback: cfg.discord.chat_model },
        // A person is waiting: the run doesn't queue behind agent runs on the login (src/runner.ts loginStartLock).
        interactive: true,
        maxBudgetUsd: Math.max(0.05, Math.min(1, cap - meter.chatSpent(), left)),
        stallMs: 5 * 60_000,
        timeoutMs: 10 * 60_000,
      });
    } catch (e) {
      // The login is held (or this run was the one refused): the reply says so, never the generic failure text.
      if (!(e instanceof AuthPaused)) throw e;
      done('failed', 0, 'claude sign-in failed');
      return void (await say('auth-failed', AUTH_FAILED_CHAT_TEXT));
    }
    this.cost(null, CHAT_ROLE, run);
    meter.recordChat(run.costUsd);
    if (run.reason !== 'succeeded') {
      done('failed', 0, `the run ended: ${run.reason}`);
      return void (await say('failed', CHAT_FAILED_TEXT));
    }
    // One string is all that is read from the run; anything else it returns is ignored.
    const checked = checkChatReply((run.structured as { reply?: unknown } | undefined)?.reply, { links: chatLinks(this.d.cfg.project.project.repo, cfg.discord.dashboard_url) });
    if (!checked.ok) {
      done('refused', 0, checked.why.slice(0, 300));
      return void (await say('refused', CHAT_REFUSED_TEXT));
    }
    for (const [i, text] of checked.posts.entries()) await say(String(i), text);
    this.keepTurn(channel, { at: r.receivedAt, by: who.login, said: message.slice(0, 4000), reply: checked.posts.join('\n').slice(0, 6000) });
    done('answered', checked.posts.length, null);
  }
}
