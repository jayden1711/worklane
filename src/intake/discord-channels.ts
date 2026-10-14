// `discord channels`: the text and announcement channels an instance's bot can see, one line each as
// "<server> / #<channel> <id>", so the owner can copy ids into intake.yaml (superfan.channel and the like) without
// Discord's Developer Mode. Read-only by construction: the only request this module can make is a GET (getJson
// takes no method), and it writes no file, event or log. The token is the instance's own (credentials.yaml
// intake.discord_token, read by readDiscordToken as the bot reads it); it goes only into the Authorization header,
// and every message that leaves this module has it scrubbed out (INVARIANT: no output or thrown error holds it).
import { BRAND } from '../brand.js';
import { instanceFilesProblem, instancesDir, listInstances, loadInstanceCredentials } from '../instance.js';
import { API } from './discord.js';
import { readDiscordToken } from './wire.js';

/** Discord channel types listed: GUILD_TEXT (0) and GUILD_ANNOUNCEMENT (5); the ones a bot posts in. */
export const LISTED_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5]);
/** Retries on a 429 before giving up, and the longest retry-after waited out (longer: say when to come back). */
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_S = 60;

export class DiscordChannelsError extends Error {}

export interface ListOptions {
  token: string;
  fetch?: typeof fetch;
  /** Discord's REST base; tests point it at a fake server. */
  api?: string;
  sleep?: (ms: number) => Promise<void>;
}

interface Guild {
  id: string;
  name: string;
}
interface Channel {
  id: string;
  name: string;
  type: number;
}

/** Remove every occurrence of the token from a message (and so from anything a server echoed back). */
export function scrubToken(text: string, token: string): string {
  return token ? text.split(token).join('[token]') : text;
}

/** One GET, with the 429 retry-after handled; any other failure is a DiscordChannelsError with a scrubbed message. */
async function getJson<T>(path: string, o: ListOptions): Promise<T> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fail = (m: string) => new DiscordChannelsError(scrubToken(m, o.token));
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      // INVARIANT: method is GET and the token is in a header only, never in the URL.
      r = await f(`${o.api ?? API}${path}`, { method: 'GET', headers: { authorization: `Bot ${o.token}`, 'user-agent': `${BRAND.cli} discord-channels` }, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw fail(`could not reach Discord (GET ${path}): ${(e as Error).message}`);
    }
    if (r.status === 429) {
      const body = (await r.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Number(r.headers.get('retry-after') ?? body.retry_after ?? 1);
      const s = Number.isFinite(wait) && wait >= 0 ? wait : 1;
      if (attempt >= RATE_LIMIT_RETRIES || s > MAX_RETRY_WAIT_S) throw fail(`Discord rate-limited GET ${path}; try again in ${Math.ceil(s)}s`);
      await sleep(Math.ceil(s * 1000));
      continue;
    }
    if (r.status === 401) throw fail(`Discord refused the bot token (401 on GET ${path}): it was reset or is wrong; install the current one with credentials.sh <instance> intake-discord`);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      let detail = text;
      try {
        detail = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // WHY: not JSON; the raw text (cut short) is the detail.
      }
      throw fail(`Discord answered ${r.status} to GET ${path}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    try {
      return (await r.json()) as T;
    } catch (e) {
      throw fail(`Discord sent a reply that is not JSON for GET ${path}: ${(e as Error).message}`);
    }
  }
}

/** Every text and announcement channel in every server the bot is in, as "<server> / #<channel> <id>", sorted. */
export async function listDiscordChannels(o: ListOptions): Promise<string[]> {
  const guilds: Guild[] = [];
  for (let after = ''; ; ) {
    const page = await getJson<Guild[]>(`/users/@me/guilds?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`, o);
    guilds.push(...page);
    if (page.length < 200) break;
    after = page[page.length - 1]!.id;
  }
  const rows: { guild: string; channel: string; id: string }[] = [];
  for (const g of guilds) {
    const channels = await getJson<Channel[]>(`/guilds/${encodeURIComponent(g.id)}/channels`, o);
    for (const c of channels) if (LISTED_CHANNEL_TYPES.has(c.type)) rows.push({ guild: g.name, channel: c.name, id: c.id });
  }
  rows.sort((a, b) => a.guild.localeCompare(b.guild) || a.channel.localeCompare(b.channel) || a.id.localeCompare(b.id));
  return rows.map((r) => `${r.guild} / #${r.channel} ${r.id}`);
}

export interface CommandOptions {
  instance?: string | undefined;
  dir?: string;
  fetch?: typeof fetch;
  api?: string;
  sleep?: (ms: number) => Promise<void>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** The CLI command: pick the instance, read its token, print the channels. Exit 0, or 1 with one scrubbed line. */
export async function discordChannelsCommand(o: CommandOptions = {}): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l));
  const err = o.err ?? ((l: string) => console.error(l));
  const dir = o.dir ?? instancesDir();
  let token = '';
  try {
    let name = o.instance;
    if (!name) {
      const all = listInstances(dir);
      if (all.length !== 1) {
        err(all.length ? `more than one instance here (${all.join(', ')}); pass --instance <name>` : `no instance here (${dir}); run this as the instance's user, or pass --instance <name>`);
        return 1;
      }
      name = all[0]!;
    }
    let file: string | undefined;
    try {
      file = loadInstanceCredentials(name, dir).credentials.intake?.discord_token;
    } catch (e) {
      err(`instance ${name}: ${instanceFilesProblem(e)}`);
      return 1;
    }
    if (!file) {
      err(`instance ${name} has no bot token: credentials.yaml names no intake.discord_token (credentials.sh ${name} intake-discord installs one)`);
      return 1;
    }
    try {
      token = readDiscordToken(file);
    } catch (e) {
      err(`instance ${name}: can't read its bot token file ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'}); run this as the instance's user`);
      return 1;
    }
    if (!token) {
      err(`instance ${name}: its bot token file ${file} is empty`);
      return 1;
    }
    const lines = await listDiscordChannels({ token, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.api ? { api: o.api } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) });
    for (const l of lines) out(l);
    return 0;
  } catch (e) {
    // WHY: the last net: whatever was thrown, its message is scrubbed and its stack (which could hold it) is dropped.
    err(scrubToken(`discord channels: ${(e as Error).message ?? String(e)}`, token));
    return 1;
  }
}
