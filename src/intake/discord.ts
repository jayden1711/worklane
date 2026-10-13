// Chat-bot source: a bot connected OUTBOUND to Discord's gateway (no port is
// opened on the machine). It keeps only messages in the configured channels of
// the one configured server that are addressed to it; everything else (other
// servers, other channels, direct messages) is dropped on receipt and never
// stored. Replies go out through the REST API. Node's built-in
// WebSocket and fetch; no dependency. The token lives only in memory here.
import { addressed } from './addressing.js';
import type { IncomingReport } from './report.js';

export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
export const API = 'https://discord.com/api/v10';
/** GUILD_MESSAGES | MESSAGE_CONTENT: the least the bot needs to read addressed messages. No direct messages. */
export const INTENTS = (1 << 9) | (1 << 15);
/** The longest reply the bot sends; anything longer is cut. */
export const REPLY_CHARS = 500;

/** The part of WebSocket the adapter uses, so tests can pass a fake. */
export interface Socket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: 'message' | 'close' | 'open', fn: (ev: { data?: unknown; code?: number }) => void): void;
}

export interface DiscordOptions {
  token: string;
  /** The one server (guild) the bot reads; a message from any other is dropped. */
  guild: string;
  channels: string[];
  /** Chat channels (intake.yaml discord.chat_channels): every message from an allowed sender there is taken, no mention needed. */
  chatChannels?: string[];
  /** The only users whose messages are taken (discord.allowed_senders); anyone else's is dropped unread. */
  allowedSenders: string[];
  prefixes: string[];
  connect?: (url: string) => Socket;
  fetch?: typeof fetch;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  now?: () => Date;
}

interface MessageCreate {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username?: string; global_name?: string; bot?: boolean };
}

export class DiscordIntake {
  private socket: Socket | null = null;
  private seq: number | null = null;
  private heartbeat: unknown = null;
  private botId: string | null = null;
  /**
   * Messages received and not yet taken. Known loss: this lives in memory only, so messages that arrived in the few
   * seconds before a coordinator crash (or that the gateway delivered while it was down) are not recovered; the
   * gateway has no acknowledgement to hold them. A replay of a message already taken is deduped by its id.
   */
  private queue: IncomingReport[] = [];
  /** Told of each chat-channel message and thread reply as it is queued: the coordinator answers those at once. */
  private arrival: ((r: IncomingReport) => void)[] = [];
  /** The bot's own threads (decisions, asks, conversations) whose replies it takes. */
  private threads = new Set<string>();
  /** Messages seen and dropped (not addressed, another server or channel, a DM, from a bot), counted only. */
  dropped = 0;
  /** The same drops by reason: `sender` (not an allowed sender), `bot`, `place` (another server or channel, a DM), `unaddressed`. */
  droppedBy: Record<'sender' | 'bot' | 'place' | 'unaddressed', number> = { sender: 0, bot: 0, place: 0, unaddressed: 0 };

  constructor(private o: DiscordOptions) {}

  start() {
    const ws = (this.o.connect ?? ((u) => new WebSocket(u) as unknown as Socket))(GATEWAY_URL);
    this.socket = ws;
    ws.addEventListener('message', (ev) => this.onFrame(String(ev.data ?? '')));
    ws.addEventListener('close', () => this.stopHeartbeat());
  }

  stop() {
    this.stopHeartbeat();
    this.socket?.close(1000);
    this.socket = null;
  }

  /** Reports received since the last call. */
  take(): IncomingReport[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** Reports received and not yet taken that match `which`, taken now; the rest stay queued. */
  takeWhere(which: (r: IncomingReport) => boolean): IncomingReport[] {
    const out = this.queue.filter(which);
    this.queue = this.queue.filter((r) => !out.includes(r));
    return out;
  }

  /** Call `fn` for each chat-channel message and thread reply once it is queued (an in-process wake-up, no I/O). */
  onArrival(fn: (r: IncomingReport) => void) {
    this.arrival.push(fn);
  }

  /** Discord's typing indicator in `channel` (shown about 10 s, or until the bot posts). False on any failure. */
  async typing(channel: string): Promise<boolean> {
    const r = await (this.o.fetch ?? fetch)(`${API}/channels/${encodeURIComponent(channel)}/typing`, { method: 'POST', headers: { authorization: `Bot ${this.o.token}` } });
    return r.ok;
  }

  private stopHeartbeat() {
    if (this.heartbeat !== null) (this.o.clearInterval ?? clearInterval)(this.heartbeat as ReturnType<typeof setInterval>);
    this.heartbeat = null;
  }

  private send(op: number, d: unknown) {
    this.socket?.send(JSON.stringify({ op, d }));
  }

  private onFrame(raw: string) {
    let f: { op: number; d: unknown; s?: number | null; t?: string | null };
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof f.s === 'number') this.seq = f.s;
    if (f.op === 10) {
      // Hello: heartbeat at the given interval, then identify.
      const ms = (f.d as { heartbeat_interval: number }).heartbeat_interval;
      this.heartbeat = (this.o.setInterval ?? setInterval)(() => this.send(1, this.seq), ms);
      this.send(2, { token: this.o.token, intents: INTENTS, properties: { os: 'node', browser: 'intake', device: 'intake' } });
    } else if (f.op === 1) {
      this.send(1, this.seq);
    } else if (f.op === 0 && f.t === 'READY') {
      this.botId = (f.d as { user: { id: string } }).user.id;
    } else if (f.op === 0 && f.t === 'MESSAGE_CREATE') {
      this.onMessage(f.d as MessageCreate);
    }
  }

  private onMessage(m: MessageCreate) {
    const drop = (why: keyof DiscordIntake['droppedBy']) => {
      this.dropped++;
      this.droppedBy[why]++;
    };
    if (m.author.bot || (this.botId && m.author.id === this.botId)) return drop('bot');
    // Only allowed senders, checked on the author id before anything of the message is read.
    if (!this.o.allowedSenders.includes(m.author.id)) return drop('sender');
    // A DM has no guild: dropped like any message outside the configured server.
    const inThread = this.threads.has(m.channel_id);
    const inChat = !inThread && (this.o.chatChannels ?? []).includes(m.channel_id);
    if (m.guild_id !== this.o.guild || (!inThread && !inChat && !this.o.channels.includes(m.channel_id))) return drop('place');
    const mentions = this.botId ? [`<@${this.botId}>`, `<@!${this.botId}>`] : [];
    // In the bot's own thread every message is a reply to it, and in a chat channel every message is to it (a
    // mention, if any, removed); in a channel, only an addressed one counts.
    const text = inThread ? m.content.trim() || null : inChat ? addressed(m.content, [], mentions) ?? (m.content.trim() || null) : addressed(m.content, this.o.prefixes, mentions);
    if (!text) return drop('unaddressed');
    const r: IncomingReport = {
      source: 'discord',
      sourceId: m.id,
      sender: { source: 'discord', id: m.author.id, ...(m.author.global_name || m.author.username ? { name: m.author.global_name ?? m.author.username! } : {}) },
      text,
      receivedAt: (this.o.now ?? (() => new Date()))().toISOString(),
      thread: { kind: inThread ? 'thread' : inChat ? 'chat' : 'channel', id: m.channel_id },
    };
    this.queue.push(r);
    if (inThread || inChat) {
      for (const fn of this.arrival) {
        try {
          fn(r);
        } catch {
          // a listener's failure never loses the message: it stays queued for the next pass
        }
      }
    }
  }

  /** Take replies in this thread of the bot's. */
  watch(thread: string) {
    this.threads.add(thread);
  }

  /**
   * Post in `channel` (at most REPLY_CHARS, pinging nobody) and open a thread on the post, or on the message `from`
   * when given (a person's idea). The thread is watched from then on. Returns its id, or null on any failure.
   */
  async openThread(channel: string, text: string, name: string, from?: string): Promise<string | null> {
    const f = this.o.fetch ?? fetch;
    const headers = { authorization: `Bot ${this.o.token}`, 'content-type': 'application/json' };
    let on = from;
    if (!on) {
      const r = await f(`${API}/channels/${encodeURIComponent(channel)}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: text.slice(0, REPLY_CHARS), allowed_mentions: { parse: [] } }) });
      if (!r.ok) return null;
      on = String(((await r.json()) as { id?: unknown }).id ?? '');
      if (!/^\d{5,25}$/.test(on)) return null;
    }
    const t = await f(`${API}/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(on)}/threads`, { method: 'POST', headers, body: JSON.stringify({ name: name.slice(0, 100) || 'thread', auto_archive_duration: 10080 }) });
    if (!t.ok) return null;
    const id = String(((await t.json()) as { id?: unknown }).id ?? '');
    if (!/^\d{5,25}$/.test(id)) return null;
    this.watch(id);
    // On a person's message, the text is the bot's first reply in the new thread.
    if (from && !(await this.reply(id, text))) return null;
    return id;
  }

  /** Reply in the same channel, at most REPLY_CHARS. */
  async reply(threadId: string, content: string): Promise<boolean> {
    const r = await (this.o.fetch ?? fetch)(`${API}/channels/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${this.o.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, REPLY_CHARS), allowed_mentions: { parse: [] } }),
    });
    return r.ok;
  }
}
