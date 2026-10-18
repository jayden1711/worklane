// Chat-bot source: a bot connected OUTBOUND to Discord's gateway (no port is
// opened on the machine). It keeps only messages in the configured channels of
// the one configured server that are addressed to it; everything else (other
// servers, other channels, direct messages) is dropped on receipt and never
// stored. Replies go out through the REST API. Node's built-in
// WebSocket and fetch; no dependency. The token lives only in memory here.
//
// One bot may serve several instances on one machine (one token, installed in several servers): each instance
// opens its own gateway session with it, identifies through the machine-wide gate (discord-gate.ts: Discord's
// identify limits are per token), and drops every event of another server the moment it arrives, before anything
// of it is read further, stored or logged. A dropped connection resumes its session (no new identify) or, when
// Discord says it can't, identifies again through the gate.
import { addressed } from './addressing.js';
import type { GateResult } from './discord-gate.js';
import type { IncomingReport } from './report.js';

export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
export const API = 'https://discord.com/api/v10';
/** GUILD_MESSAGES | MESSAGE_CONTENT: the least the bot needs to read addressed messages. No direct messages. */
export const INTENTS = (1 << 9) | (1 << 15);
/** The longest reply the bot sends; anything longer is cut (fitPost). */
export const REPLY_CHARS = 500;

const TICK = 96;
/**
 * `text` cut to at most `max` characters for a post. The cut never splits an emoji (a surrogate pair) or a run of
 * backticks, and what it keeps has an even number of backticks: while that is odd, the cut moves back to before the
 * last run. So a code span (a pair of single backticks with none inside, as `lit` in review-packet.ts builds) is kept
 * whole or dropped whole, never left open for the rest of the post to render as markdown. Text that fits is unchanged.
 */
export function fitPost(text: string, max: number): string {
  if (text.length <= max) return text;
  const tick = (i: number) => text.charCodeAt(i) === TICK;
  let end = Math.max(0, max);
  while (end > 0 && tick(end - 1) && tick(end)) end--;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  let ticks = 0;
  for (let i = 0; i < end; i++) if (tick(i)) ticks++;
  while (ticks % 2) {
    while (!tick(end - 1)) end--;
    while (end > 0 && tick(end - 1)) (end--, ticks--);
  }
  return text.slice(0, end);
}

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
  /** discord.owners: the only users a post may ever mention, and only in the bot's own threads or the ops channel. */
  owners?: string[];
  /** discord.ops_channel: the one channel (not a thread of the bot's) a post may mention owners in. */
  opsChannel?: string;
  /** The machine-wide identify gate (discord-gate.ts). Absent: identify at once (tests). */
  gate?: () => Promise<GateResult>;
  connect?: (url: string) => Socket;
  fetch?: typeof fetch;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  now?: () => Date;
  /** Connection notes (never a token or message content). */
  log?: (line: string) => void;
}

/** Close codes after which reconnecting can't help (bad token, bad intents, a shard problem): the bot stays off. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes after which the session can't be resumed: identify again. */
const FRESH_CLOSE = new Set([4007, 4009]);

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
  /** The gateway session (from READY), resumed after a dropped connection instead of identifying again. */
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private stopped = true;
  private attempts = 0;
  /** Identifies sent by this adapter (each one counts against the token's daily session starts). */
  identifies = 0;
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
    this.stopped = false;
    this.open(GATEWAY_URL);
  }

  private open(url: string) {
    const ws = (this.o.connect ?? ((u) => new WebSocket(u) as unknown as Socket))(url);
    this.socket = ws;
    ws.addEventListener('message', (ev) => {
      if (this.socket === ws) this.onFrame(String(ev.data ?? ''));
    });
    ws.addEventListener('close', (ev) => {
      if (this.socket !== ws) return;
      this.stopHeartbeat();
      this.socket = null;
      this.reconnectLater(ev.code ?? 1006);
    });
  }

  /** After a dropped connection: resume (or identify again) after a backoff; never after a fatal close or stop(). */
  private reconnectLater(code: number) {
    if (this.stopped) return;
    if (FATAL_CLOSE.has(code)) {
      this.stopped = true;
      this.o.log?.(`discord: the gateway closed the connection (code ${code}); not reconnecting until the instance restarts`);
      return;
    }
    if (FRESH_CLOSE.has(code)) this.forgetSession();
    const ms = Math.min(60_000, 1000 * 2 ** this.attempts++);
    (this.o.setTimeout ?? setTimeout)(() => {
      if (!this.stopped && !this.socket) this.open(this.resumeUrl && this.sessionId ? `${this.resumeUrl.replace(/\/+$/, '')}/?v=10&encoding=json` : GATEWAY_URL);
    }, ms);
  }

  /** Drop the current connection and open another (Discord asked us to reconnect). */
  private reconnectNow() {
    const ws = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    ws?.close(4000);
    this.reconnectLater(4000);
  }

  private forgetSession() {
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
  }

  stop() {
    this.stopped = true;
    this.stopHeartbeat();
    const ws = this.socket;
    this.socket = null;
    ws?.close(1000);
  }

  /** Identify, once the machine-wide gate lets this one go (Discord's identify limits are per token). */
  private async identify() {
    const ws = this.socket;
    if (this.o.gate) {
      const g = await this.o.gate();
      if (this.stopped || this.socket !== ws) return;
      if (!g.ok) {
        this.o.log?.(`discord: identify deferred ${Math.round(g.retryInMs / 1000)}s: ${g.why}`);
        (this.o.setTimeout ?? setTimeout)(() => {
          if (!this.stopped && this.socket === ws) void this.identify();
        }, g.retryInMs);
        return;
      }
    }
    this.identifies++;
    this.send(2, { token: this.o.token, intents: INTENTS, properties: { os: 'node', browser: 'intake', device: 'intake' } });
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
      // Hello: heartbeat at the given interval, then resume the session we had, or identify (through the gate).
      const ms = (f.d as { heartbeat_interval: number }).heartbeat_interval;
      this.stopHeartbeat();
      this.heartbeat = (this.o.setInterval ?? setInterval)(() => this.send(1, this.seq), ms);
      if (this.sessionId) this.send(6, { token: this.o.token, session_id: this.sessionId, seq: this.seq });
      else void this.identify();
    } else if (f.op === 1) {
      this.send(1, this.seq);
    } else if (f.op === 7) {
      // Reconnect: Discord wants this connection gone; the session is resumed on the next.
      this.reconnectNow();
    } else if (f.op === 9) {
      // Invalid session: resumable (d true) or not; not, a fresh identify, through the gate.
      if (f.d !== true || !this.sessionId) {
        this.forgetSession();
        void this.identify();
      } else this.send(6, { token: this.o.token, session_id: this.sessionId, seq: this.seq });
    } else if (f.op === 0) {
      this.onDispatch(f.t ?? '', f.d);
    }
  }

  /**
   * A dispatch. One bot may sit in several servers (one per instance that uses its token): an event of any other
   * server, or a message of no server (a DM), is dropped here, on its guild id alone, before anything else of it
   * is read.
   */
  private onDispatch(t: string, d: unknown) {
    if (t === 'READY') {
      const r = d as { user: { id: string }; session_id?: unknown; resume_gateway_url?: unknown };
      this.botId = r.user.id;
      this.sessionId = typeof r.session_id === 'string' ? r.session_id : null;
      this.resumeUrl = typeof r.resume_gateway_url === 'string' && r.resume_gateway_url.startsWith('wss://') ? r.resume_gateway_url : null;
      this.attempts = 0;
      return;
    }
    if (t === 'RESUMED') {
      this.attempts = 0;
      return;
    }
    const guild = d && typeof d === 'object' ? (d as { guild_id?: unknown }).guild_id : undefined;
    if (t === 'MESSAGE_CREATE' ? guild !== this.o.guild : guild !== undefined && guild !== this.o.guild) {
      this.dropped++;
      this.droppedBy.place++;
      return;
    }
    if (t === 'MESSAGE_CREATE') this.onMessage(d as MessageCreate);
  }

  private onMessage(m: MessageCreate) {
    const drop = (why: keyof DiscordIntake['droppedBy']) => {
      this.dropped++;
      this.droppedBy[why]++;
    };
    // Another server's message, or a DM (no guild), never gets this far (onDispatch); checked again here.
    if (m.guild_id !== this.o.guild) return drop('place');
    if (m.author.bot || (this.botId && m.author.id === this.botId)) return drop('bot');
    // Only allowed senders, checked on the author id before anything of the message is read.
    if (!this.o.allowedSenders.includes(m.author.id)) return drop('sender');
    const inThread = this.threads.has(m.channel_id);
    const inChat = !inThread && (this.o.chatChannels ?? []).includes(m.channel_id);
    if (!inThread && !inChat && !this.o.channels.includes(m.channel_id)) return drop('place');
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
      const r = await f(`${API}/channels/${encodeURIComponent(channel)}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: fitPost(text, REPLY_CHARS), allowed_mentions: { parse: [] } }) });
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

  /**
   * Reply in the same channel, at most REPLY_CHARS, pinging nobody, except `mentions`: users among discord.owners,
   * and only in one of the bot's own threads or the ops channel (a direct push's alert; anywhere else, or anyone
   * else, is never pinged).
   */
  async reply(threadId: string, content: string, mentions: string[] = []): Promise<boolean> {
    const may = this.threads.has(threadId) || (!!this.o.opsChannel && threadId === this.o.opsChannel);
    const users = may ? [...new Set(mentions)].filter((u) => SNOWFLAKE.test(u) && (this.o.owners ?? []).includes(u)) : [];
    const tail = users.length ? ` ${users.map((u) => `<@${u}>`).join(' ')}` : '';
    const r = await (this.o.fetch ?? fetch)(`${API}/channels/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${this.o.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: `${fitPost(content, REPLY_CHARS - tail.length)}${tail}`, allowed_mentions: { parse: [], ...(users.length ? { users } : {}) } }),
    });
    return r.ok;
  }

  /**
   * A direct message to one user, outbound only: open (or reuse) the DM channel and post in it, at most REPLY_CHARS,
   * pinging nobody. The DM channel is never watched: a reply there is dropped like every incoming DM.
   */
  async dm(user: string, content: string): Promise<boolean> {
    if (!SNOWFLAKE.test(user)) return false;
    const f = this.o.fetch ?? fetch;
    const headers = { authorization: `Bot ${this.o.token}`, 'content-type': 'application/json' };
    const c = await f(`${API}/users/@me/channels`, { method: 'POST', headers, body: JSON.stringify({ recipient_id: user }) });
    if (!c.ok) return false;
    const id = String(((await c.json()) as { id?: unknown }).id ?? '');
    if (!SNOWFLAKE.test(id)) return false;
    const r = await f(`${API}/channels/${encodeURIComponent(id)}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: fitPost(content, REPLY_CHARS), allowed_mentions: { parse: [] } }) });
    return r.ok;
  }
}

const SNOWFLAKE = /^\d{5,25}$/;
