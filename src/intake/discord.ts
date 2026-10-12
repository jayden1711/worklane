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
  /** Messages seen and dropped (not addressed, another server or channel, a DM, from a bot), counted only. */
  dropped = 0;

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
    const drop = () => {
      this.dropped++;
    };
    if (m.author.bot || (this.botId && m.author.id === this.botId)) return drop();
    // A DM has no guild: dropped like any message outside the configured server.
    if (m.guild_id !== this.o.guild || !this.o.channels.includes(m.channel_id)) return drop();
    const mentions = this.botId ? [`<@${this.botId}>`, `<@!${this.botId}>`] : [];
    const text = addressed(m.content, this.o.prefixes, mentions);
    if (!text) return drop();
    this.queue.push({
      source: 'discord',
      sourceId: m.id,
      sender: { source: 'discord', id: m.author.id, ...(m.author.global_name || m.author.username ? { name: m.author.global_name ?? m.author.username! } : {}) },
      text,
      receivedAt: (this.o.now ?? (() => new Date()))().toISOString(),
      thread: { kind: 'channel', id: m.channel_id },
    });
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
