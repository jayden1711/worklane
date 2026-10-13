// Replies a person is waiting on: chat-channel messages (src/coordinator/channel-chat.ts) and replies in a decision's
// or ask's thread (src/coordinator/channel.ts), answered as they arrive instead of on the intake pass's clock.
// - Event-driven: the Discord gateway runs in this process, so a message it queues wakes a pass at once
//   (IntakeSource.onArrival). One pass at a time: a wake during a pass makes one more pass after it, never a second
//   pass alongside. The short timer still calls it, so nothing waits on a wake that was missed.
// - The pass only takes and accepts (the same checks and exactly-once store as before); each reply then runs in
//   its own small lane: in order within a channel or thread, at most QUICK_RUNS at once per instance, and never
//   behind agent runs (their runs are `interactive`: src/runner.ts loginStartLock). They take no agent slot.
// - Typing: shown as soon as a message is accepted and sent again every TYPING_EVERY_MS until its reply is posted;
//   one indicator per channel however many replies are on their way, stopped on the first failure (a rate limit
//   included) and after TYPING_MAX_MS at most.
// Ideas (an ideas channel, an idea's thread) stay on the intake pass: they are reports, not replies.
import { isAllowed, type IncomingReport, type IntakeConfig, type IntakeSource } from '../intake/report.js';
import { IntakeMeter } from '../intake/store.js';
import { intakeCaps } from '../settings.js';
import { ChannelChat } from './channel-chat.js';
import type { CoordinatorDeps } from './shared.js';

/** Replies running at once per instance (chat and thread questions together). Agent slots don't count them. */
export const QUICK_RUNS = 2;
/** Discord shows typing for about 10 s: it is sent again before then. */
export const TYPING_EVERY_MS = 8_000;
/** The longest one channel's indicator is kept alive (a chat run's timeout). */
export const TYPING_MAX_MS = 10 * 60_000;
/** After a failed typing send (a 429 among them): no indicator in that channel for this long. */
export const TYPING_PAUSE_MS = 60_000;

export abstract class QuickReplies extends ChannelChat {
  private quickBusy = false;
  private quickAgain = false;
  private quickPass: Promise<void> = Promise.resolve();
  /** Per channel or thread: the replies on their way, in order. */
  private quickLanes = new Map<string, Promise<void>>();
  private quickActive = 0;
  private quickWaiting: (() => void)[] = [];
  private typingIn = new Map<string, { n: number; end: () => void }>();
  /** A channel whose typing send failed: none is sent there again until then. */
  private typingPausedUntil = new Map<string, number>();

  constructor(d: CoordinatorDeps) {
    super(d);
    for (const s of d.intake?.sources ?? []) if (s.name === 'discord') s.onArrival?.(() => void this.wakeQuick());
  }

  /**
   * Is this a reply a person is waiting on: a chat-channel message, or a reply in a decision's, ask's or owner merge's
   * thread (an L3 approval; a setup step's link)? Those are taken here only, never by the intake pass too.
   */
  private quick(threads: Map<string, string>) {
    return (r: IncomingReport) => r.thread?.kind === 'chat' || (r.thread?.kind === 'thread' && /^(?:decision|ask|merge):/.test(threads.get(r.thread.id) ?? ''));
  }

  /** What the intake pass takes from the chat source: everything else (with no quick path, everything). */
  protected intakeTake(src: IntakeSource): Promise<IncomingReport[]> {
    if (!src.takeNow || src.name !== 'discord') return src.take();
    const quick = this.quick(this.channelThreads());
    return src.takeNow((r) => !quick(r));
  }

  /** A pass over the waiting replies, now; coalesced: one at a time, and a wake during one makes one more. */
  wakeQuick(): Promise<void> {
    if (this.quickBusy) {
      this.quickAgain = true;
      return this.quickPass;
    }
    this.quickBusy = true;
    this.quickPass = (async () => {
      try {
        do {
          this.quickAgain = false;
          await this.quickTake();
        } while (this.quickAgain && !this.stopped && !this.halt.signal.aborted);
      } catch (e) {
        this.emit('coordinator.error', { instance: this.d.instance, where: 'quick replies', kind: (e as { kind?: string }).kind ?? 'error', message: (e as Error).message.slice(0, 500) });
      } finally {
        this.quickBusy = false;
      }
    })();
    return this.quickPass;
  }

  /** Every pass and every reply on its way, finished. */
  async quickIdle(): Promise<void> {
    await this.quickPass;
    while (this.quickLanes.size) await Promise.all([...this.quickLanes.values()]);
  }

  private async quickTake(): Promise<void> {
    if (this.stopped || this.halt.signal.aborted) return;
    const cfg = this.d.intake?.config();
    const src = this.chatSource();
    if (!cfg || !cfg.discord.enabled || !src?.takeNow) return;
    const threads = this.channelThreads();
    const got = (await src.takeNow(this.quick(threads))).filter((r) => r.source === 'discord');
    const meter = () => new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
    for (const r of got.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.sourceId.localeCompare(b.sourceId))) {
      // The same checks as the intake pass, in the same order: allowed senders, then the channel's own rules.
      if (!isAllowed(r.sender, cfg)) {
        meter().countDrop('not_allowed');
        continue;
      }
      const where = r.thread!.id;
      if (r.thread!.kind === 'chat') {
        const who = await this.acceptChat(cfg, r);
        if (who && who !== 'ignored') this.quickReply(src, where, () => this.chatReply(cfg, src, r, who));
        continue;
      }
      // Off (no mapping, or Discord off): nothing is read as a thread reply, as on the intake pass.
      if (!this.channelOn(cfg)) continue;
      const got2 = await this.acceptThreadReply(cfg, r, threads, meter);
      if (got2 && got2 !== 'ignored' && got2 !== 'rest') this.quickReply(src, where, () => this.threadReply(cfg, src, r, got2.person, where, got2.target));
    }
  }

  /** One accepted message's reply: typing from now until it is posted, in order in its channel, within QUICK_RUNS. */
  private quickReply(src: IntakeSource, where: string, reply: () => Promise<unknown>) {
    const stopTyping = this.typing(src, where);
    const prev = this.quickLanes.get(where) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(async () => {
        if (this.stopped || this.halt.signal.aborted) return;
        await this.quickSlot();
        try {
          await reply();
        } finally {
          this.quickRelease();
        }
      })
      .catch((e: Error) => {
        this.emit('coordinator.error', { instance: this.d.instance, where: 'quick reply', kind: (e as { kind?: string }).kind ?? 'error', message: e.message.slice(0, 500) });
      })
      .finally(() => {
        stopTyping();
        if (this.quickLanes.get(where) === next) this.quickLanes.delete(where);
      });
    this.quickLanes.set(where, next);
  }

  private quickSlot(): Promise<void> {
    if (this.quickActive < QUICK_RUNS) {
      this.quickActive++;
      return Promise.resolve();
    }
    return new Promise((r) => this.quickWaiting.push(r));
  }

  private quickRelease() {
    const next = this.quickWaiting.shift();
    if (next) next();
    else this.quickActive--;
  }

  /**
   * Keep the typing indicator up in `where` until every reply that asked for it called its stop. One indicator per
   * channel; a failed send (a rate limit, any error) ends it, and none is started there for TYPING_PAUSE_MS after.
   */
  private typing(src: IntakeSource, where: string): () => void {
    const now = () => (this.d.now?.() ?? new Date()).getTime();
    let entry = this.typingIn.get(where);
    if (!entry) {
      if (!src.typing || (this.typingPausedUntil.get(where) ?? 0) > now()) return () => {};
      let timer: ReturnType<typeof setInterval> | null = null;
      let cap: ReturnType<typeof setTimeout> | null = null;
      const fresh = {
        n: 0,
        end: () => {
          if (timer) clearInterval(timer);
          if (cap) clearTimeout(cap);
          timer = cap = null;
          if (this.typingIn.get(where) === fresh) this.typingIn.delete(where);
        },
      };
      const failed = () => {
        this.typingPausedUntil.set(where, now() + TYPING_PAUSE_MS);
        fresh.end();
      };
      const send = () => {
        if (this.typingIn.get(where) !== fresh) return;
        src.typing!(where).then((ok) => void (ok || failed()), failed);
      };
      this.typingIn.set(where, fresh);
      entry = fresh;
      send();
      timer = setInterval(send, this.d.intake?.typingMs ?? TYPING_EVERY_MS);
      cap = setTimeout(fresh.end, TYPING_MAX_MS);
      timer.unref?.();
      cap.unref?.();
    }
    const mine = entry;
    mine.n++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--mine.n <= 0) mine.end();
    };
  }
}
