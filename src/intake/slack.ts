// Slack source (docs/intake.md 2.7): a Slack app connected OUTBOUND over Socket Mode, so no port is opened on the
// machine and no public address is needed. The app subscribes to one event, `app_mention`: Slack tells it only about
// messages that mention it, in channels it was added to. Each event is dropped, in this order, before its text is
// read: another workspace's (on its team id alone), a bot's, a sender who isn't an allowed one (on their user id
// alone), a channel not listed or a direct message, and a mention with nothing after it. What is left is queued in
// memory for the coordinator's intake pass, like the Discord bot's messages. Replies go out through the Web API, in
// the message's own thread, escaped so no ping or link markup can form. Node's built-in WebSocket and fetch; no
// dependency. The two tokens live only in memory here.
//
// One Slack app serves ONE instance: Slack hands each event to just one of an app's open connections, so two
// instances on one app would each miss part of the messages. wire.ts claims the app machine-wide (source-claims.ts).
import type { Socket } from './discord.js';
import type { IncomingReport } from './report.js';

/** Slack's Web API. INVARIANT: a constant; no config, environment variable or request names another host. */
export const SLACK_API = 'https://slack.com/api';
/** The longest reply posted; anything longer is cut (the same as Discord's). */
export const SLACK_REPLY_CHARS = 500;
/** The longest text taken from one message. */
const MAX_TEXT = 4000;
/** Event ids remembered, so a redelivered envelope is never a second report. */
const SEEN_EVENTS = 2000;

/** apps.connections.open (or auth.test) answers after which retrying can't help: a bad, revoked or wrong-kind token. */
const FATAL_API = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'missing_scope', 'no_permission']);

/**
 * Is this the WebSocket URL Slack's API handed us? It comes from Slack's own response, so it is checked: wss only, on
 * a host under slack.com. Anything else is refused and no socket is opened.
 */
export function slackSocketUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'wss:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  return host === 'slack.com' || host.endsWith('.slack.com') ? u.toString() : null;
}

/** Text for Slack with `&`, `<` and `>` escaped: no <!channel>, <@U...> or <url|label> can form from it. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A message's text as a person reads it, before anything else sees it: the bot's own mention removed, other people's
 * mentions as `[mention]` (an id is personal data), a channel as its name, a mailto or tel link as its address (so
 * the redaction finds it), a link as its URL, and Slack's own escapes undone.
 */
export function slackPlainText(text: string, botUserId: string | null): string {
  let s = text;
  if (botUserId) s = s.split(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g')).join(' ');
  s = s
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '[mention]')
    .replace(/<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)(?:\|[^>]*)?>/g, '[mention]')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#[A-Z0-9]+>/g, '#channel')
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/<tel:([^|>]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return s.replace(/[ \t]+/g, ' ').trim();
}

export interface SlackOptions {
  /** The app-level token (xapp-, connections:write): opens the Socket Mode connection. */
  appToken: string;
  /** The bot token (xoxb-): who the bot is, a sender's display name, and the replies. */
  botToken: string;
  /** The one workspace (slack.team). */
  team: string;
  channels: string[];
  /** The only users whose mentions are taken (slack.allowed_senders); anyone else's is dropped unread. */
  allowedSenders: string[];
  connect?: (url: string) => Socket;
  fetch?: typeof fetch;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  now?: () => Date;
  /** Connection notes (never a token or message content). */
  log?: (line: string) => void;
}

interface Envelope {
  type?: unknown;
  envelope_id?: unknown;
  reason?: unknown;
  payload?: unknown;
}

interface MentionEvent {
  type?: unknown;
  user?: unknown;
  text?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  channel?: unknown;
  channel_type?: unknown;
  bot_id?: unknown;
  bot_profile?: unknown;
  subtype?: unknown;
}

const TS = /^\d{1,12}\.\d{1,8}$/;
const CHANNEL = /^[CG][A-Z0-9]{2,30}$/;

export class SlackIntake {
  readonly name = 'slack' as const;
  private socket: Socket | null = null;
  private stopped = true;
  private attempts = 0;
  /** The bot's own user id (auth.test), so its own mention is removed and its own messages dropped. */
  private botUserId: string | null = null;
  private queue: IncomingReport[] = [];
  private seenEvents: string[] = [];
  private seenSet = new Set<string>();
  private names = new Map<string, string | null>();
  /** Mentions seen and dropped, counted only. */
  dropped = 0;
  /** The same drops by reason: `place` (another workspace or channel, a DM), `bot`, `sender` (not allowed), `unaddressed`, `repeat` (a redelivery). */
  droppedBy: Record<'place' | 'bot' | 'sender' | 'unaddressed' | 'repeat', number> = { place: 0, bot: 0, sender: 0, unaddressed: 0, repeat: 0 };
  /** Envelopes acknowledged. */
  acked = 0;

  constructor(private o: SlackOptions) {}

  private async api(method: string, token: string, body: Record<string, unknown> | URLSearchParams): Promise<Record<string, unknown>> {
    const json = !(body instanceof URLSearchParams);
    const r = await (this.o.fetch ?? fetch)(`${SLACK_API}/${method}`, {
      method: 'POST',
      // INVARIANT: the token goes in the Authorization header only, never in a URL or a body.
      headers: { authorization: `Bearer ${token}`, 'content-type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' },
      body: json ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    try {
      const out = (await r.json()) as unknown;
      return out && typeof out === 'object' ? (out as Record<string, unknown>) : { ok: false, error: 'bad_response' };
    } catch {
      return { ok: false, error: 'bad_response' };
    }
  }

  /**
   * Who the bot is (auth.test with the bot token): its user id and workspace. Refused when the token is bad or belongs
   * to another workspace than slack.team. Called before connecting (wire.ts claims the app by it).
   */
  async identify(): Promise<{ team: string; user: string } | { error: string }> {
    let r: Record<string, unknown>;
    try {
      r = await this.api('auth.test', this.o.botToken, new URLSearchParams());
    } catch (e) {
      return { error: `could not reach Slack (auth.test): ${(e as Error).name}` };
    }
    if (r.ok !== true) return { error: `the bot token was refused by Slack (auth.test: ${String(r.error ?? 'error').slice(0, 60)})` };
    const team = typeof r.team_id === 'string' ? r.team_id : '';
    const user = typeof r.user_id === 'string' ? r.user_id : '';
    if (!team || !user) return { error: 'auth.test did not say which workspace and bot user the token is' };
    if (team !== this.o.team) return { error: `the bot token belongs to workspace ${team}, not slack.team (${this.o.team})` };
    this.botUserId = user;
    return { team, user };
  }

  /** Connect: ask Slack for a Socket Mode URL with the app-level token, then open it. Reconnects on its own. */
  start() {
    this.stopped = false;
    void this.open();
  }

  stop() {
    this.stopped = true;
    const ws = this.socket;
    this.socket = null;
    ws?.close(1000);
  }

  private async open() {
    if (this.stopped) return;
    let r: Record<string, unknown>;
    try {
      r = await this.api('apps.connections.open', this.o.appToken, new URLSearchParams());
    } catch (e) {
      this.o.log?.(`slack: could not reach Slack (apps.connections.open): ${(e as Error).name}`);
      return this.reconnectLater();
    }
    if (this.stopped) return;
    if (r.ok !== true) {
      const err = String(r.error ?? 'error').slice(0, 60);
      if (FATAL_API.has(err)) {
        this.stopped = true;
        this.o.log?.(`slack: the app-level token was refused (${err}); not reconnecting until the instance restarts`);
        return;
      }
      this.o.log?.(`slack: apps.connections.open failed (${err})`);
      return this.reconnectLater();
    }
    const url = slackSocketUrl(r.url);
    if (!url) {
      this.o.log?.("slack: apps.connections.open gave a URL that isn't wss:// on slack.com; not connecting");
      return this.reconnectLater();
    }
    const ws = (this.o.connect ?? ((u) => new WebSocket(u) as unknown as Socket))(url);
    this.socket = ws;
    ws.addEventListener('message', (ev) => {
      if (this.socket === ws) this.onFrame(ws, String(ev.data ?? ''));
    });
    ws.addEventListener('close', () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.reconnectLater();
    });
  }

  private reconnectLater() {
    if (this.stopped) return;
    const ms = Math.min(60_000, 1000 * 2 ** this.attempts++);
    (this.o.setTimeout ?? setTimeout)(() => {
      if (!this.stopped && !this.socket) void this.open();
    }, ms);
  }

  private onFrame(ws: Socket, raw: string) {
    let f: Envelope;
    try {
      f = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (f.type === 'hello') {
      this.attempts = 0;
      return;
    }
    if (f.type === 'disconnect') {
      if (f.reason === 'link_disabled') {
        this.o.log?.('slack: Socket Mode was turned off for the app; not reconnecting until the instance restarts');
        this.stop();
        return;
      }
      // Slack refreshes connections: open a new one now.
      this.socket = null;
      ws.close(1000);
      this.attempts = 0;
      void this.open();
      return;
    }
    if (f.type === 'events_api') this.onEvent(f.payload);
    // Every envelope is acknowledged (so Slack doesn't send it again), whatever became of it: dropped ones too.
    if (typeof f.envelope_id === 'string' && f.envelope_id.length <= 200) {
      ws.send(JSON.stringify({ envelope_id: f.envelope_id }));
      this.acked++;
    }
  }

  private drop(why: keyof SlackIntake['droppedBy']) {
    this.dropped++;
    this.droppedBy[why]++;
  }

  /** One event: dropped in order (workspace, bot, sender, place, addressing) before its text is read. */
  private onEvent(payload: unknown) {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { team_id?: unknown; event_id?: unknown; event?: unknown };
    // Another workspace's event: dropped on its team id alone, before the event is looked at.
    if (p.team_id !== this.o.team) return this.drop('place');
    const eventId = typeof p.event_id === 'string' ? p.event_id : null;
    if (eventId && this.seenSet.has(eventId)) return this.drop('repeat');
    if (eventId) {
      this.seenSet.add(eventId);
      this.seenEvents.push(eventId);
      if (this.seenEvents.length > SEEN_EVENTS) this.seenSet.delete(this.seenEvents.shift()!);
    }
    const e = (p.event && typeof p.event === 'object' ? p.event : {}) as MentionEvent;
    if (e.type !== 'app_mention') return this.drop('place');
    if (e.bot_id !== undefined || e.bot_profile !== undefined || e.subtype !== undefined || (this.botUserId && e.user === this.botUserId)) return this.drop('bot');
    // Only allowed senders, checked on the user id before anything of the message is read.
    if (typeof e.user !== 'string' || !this.o.allowedSenders.includes(e.user)) return this.drop('sender');
    const channel = typeof e.channel === 'string' ? e.channel : '';
    if (!CHANNEL.test(channel) || !this.o.channels.includes(channel) || e.channel_type === 'im' || e.channel_type === 'mpim') return this.drop('place');
    const ts = typeof e.ts === 'string' && TS.test(e.ts) ? e.ts : null;
    if (!ts) return this.drop('place');
    const text = typeof e.text === 'string' ? slackPlainText(e.text, this.botUserId).slice(0, MAX_TEXT) : '';
    if (!text) return this.drop('unaddressed');
    const root = typeof e.thread_ts === 'string' && TS.test(e.thread_ts) ? e.thread_ts : ts;
    this.queue.push({
      source: 'slack',
      sourceId: `${channel}:${ts}`,
      sender: { source: 'slack', id: e.user },
      text,
      receivedAt: (this.o.now ?? (() => new Date()))().toISOString(),
      // Replies go in the message's thread (the thread it was in, or a new one on it).
      thread: { kind: 'channel', id: `${channel}:${root}` },
    });
  }

  /** A sender's display name (users.info), only so the redaction can take it out of their text. Null on any failure. */
  private async nameOf(user: string): Promise<string | null> {
    if (this.names.has(user)) return this.names.get(user)!;
    let name: string | null = null;
    try {
      const r = await this.api('users.info', this.o.botToken, new URLSearchParams({ user }));
      const u = r.ok === true && r.user && typeof r.user === 'object' ? (r.user as { real_name?: unknown; profile?: { display_name?: unknown; real_name?: unknown } }) : null;
      const pick = [u?.profile?.display_name, u?.profile?.real_name, u?.real_name].find((x) => typeof x === 'string' && x.trim().length >= 2);
      name = typeof pick === 'string' ? pick.trim().slice(0, 100) : null;
    } catch {
      name = null;
    }
    if (this.names.size > 500) this.names.clear();
    this.names.set(user, name);
    return name;
  }

  /** Reports received since the last call, each with its sender's display name (for the redaction) when Slack gives one. */
  async take(): Promise<IncomingReport[]> {
    const out = this.queue;
    this.queue = [];
    for (const r of out) {
      const name = await this.nameOf(r.sender.id);
      if (name) r.sender = { ...r.sender, name };
    }
    return out;
  }

  /**
   * Reply in the message's thread (`<channel>:<thread ts>`), only in a listed channel, at most SLACK_REPLY_CHARS,
   * escaped (no ping, no link markup), no link previews.
   */
  async reply(thread: string, text: string): Promise<boolean> {
    const m = /^([CG][A-Z0-9]{2,30}):(\d{1,12}\.\d{1,8})$/.exec(thread);
    if (!m || !this.o.channels.includes(m[1]!)) return false;
    const r = await this.api('chat.postMessage', this.o.botToken, {
      channel: m[1],
      thread_ts: m[2],
      text: escapeSlack(text.slice(0, SLACK_REPLY_CHARS)),
      link_names: false,
      parse: 'none',
      unfurl_links: false,
      unfurl_media: false,
    });
    return r.ok === true;
  }
}
