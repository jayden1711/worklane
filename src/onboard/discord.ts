// The chat bot's token, checked before it's installed: read-only calls that send nothing (who the bot is, and
// its application's gateway intents), and the invite link with the least the bot needs.
import { API, INTENTS } from '../intake/discord.js';

type Fetch = typeof fetch;

/** Application flags: the message-content privileged intent, turned on (for bots in up to 100 servers, or verified). */
export const FLAG_MESSAGE_CONTENT = 1 << 19;
export const FLAG_MESSAGE_CONTENT_VERIFIED = 1 << 18;
/** The gateway intents intake connects with need the message-content one (INTENTS includes 1 << 15). */
export const NEEDS_MESSAGE_CONTENT = (INTENTS & (1 << 15)) !== 0;

/** What intake does in a server: see the channels, read messages and their history, reply (in threads too). */
export const BOT_PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;
export const BOT_PERMISSION_BITS = Object.values(BOT_PERMISSIONS).reduce((a, b) => a | b, 0n);

export interface BotCheck {
  ok: boolean;
  /** The bot's application id (its client id, for the invite). */
  appId: string | null;
  botName: string | null;
  messageContent: boolean;
  problem: string | null;
}

export interface DiscordCheck {
  check(token: string): Promise<BotCheck>;
}

/** GET /users/@me and /applications/@me with the bot token. No message is sent; nothing is written. */
export function discordApi(fetchImpl: Fetch = fetch, api = API): DiscordCheck {
  return {
    async check(token) {
      const h = { authorization: `Bot ${token}` };
      const me = await fetchImpl(`${api}/users/@me`, { headers: h });
      if (me.status === 401) return { ok: false, appId: null, botName: null, messageContent: false, problem: 'Discord refused the token (401): copy it again from the Bot page (Reset Token)' };
      if (!me.ok) return { ok: false, appId: null, botName: null, messageContent: false, problem: `Discord ${me.status} checking the token` };
      const u = (await me.json()) as { id?: string; username?: string; bot?: boolean };
      if (!u.bot) return { ok: false, appId: null, botName: u.username ?? null, messageContent: false, problem: "that is a user's token, not a bot's: use the token on the application's Bot page" };
      const app = await fetchImpl(`${api}/applications/@me`, { headers: h });
      if (!app.ok) return { ok: false, appId: null, botName: u.username ?? null, messageContent: false, problem: `Discord ${app.status} reading the bot's application` };
      const a = (await app.json()) as { id?: string; flags?: number };
      const flags = a.flags ?? 0;
      const messageContent = (flags & (FLAG_MESSAGE_CONTENT | FLAG_MESSAGE_CONTENT_VERIFIED)) !== 0;
      return {
        ok: messageContent || !NEEDS_MESSAGE_CONTENT,
        appId: a.id ?? null,
        botName: u.username ?? null,
        messageContent,
        problem: messageContent ? null : 'the Message Content Intent is off: intake reads what people write, so turn it on (Bot page, Privileged Gateway Intents)',
      };
    },
  };
}

export const developerPortal = (appId: string) => `https://discord.com/developers/applications/${encodeURIComponent(appId)}/bot`;

/** The invite: the bot scope with the permissions above only. */
export function inviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=${BOT_PERMISSION_BITS.toString()}`;
}

/** A bot token's shape, as credentials.sh intake-discord checks it. */
export const DISCORD_TOKEN = /^[A-Za-z0-9._-]{50,100}$/;
