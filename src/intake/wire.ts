// Intake for one instance, as the service runs it: the instance's own intake.yaml (in its home, 0600) and, when
// that enables Discord, its own bot token (credentials.yaml intake.discord_token). Off by default: an instance
// with no intake.yaml gets no intake at all; one whose intake.yaml leaves Discord off gets no Discord source (no
// connection, nothing posted or read). Roles for the chat channel come from the instance's own repo, as the
// dashboard reads them. Nothing here is shared between instances, except, machine-wide, the identify gate (one
// bot token may serve several instances: discord-gate.ts) and each running bot's claim of its server and channels
// (discord-claims.ts: two instances never act in the same channel).
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { cachedRoles, repoPermission, type RoleOf } from '../dashboard-auth.js';
import { slotsDir } from '../os/index.js';
import type { SlotPathLike } from '../slot-file.js';
import { INTAKE_FILE, loadIntakeConfig } from './config.js';
import { claimDiscord } from './discord-claims.js';
import { identifyGate, sessionStartLimit } from './discord-gate.js';
import { AlertsIntake } from './alerts.js';
import { GitHubBacklog } from '../backlog/github.js';
import type { Backlog } from '../backlog/types.js';
import { GitHubIssuesIntake } from './github.js';
import type { ReadOnlyQuery } from './bug-store.js';
import { DiscordIntake, type DiscordOptions } from './discord.js';
import { LinearIntake } from './linear.js';
import { SlackIntake, type SlackOptions } from './slack.js';
import { claimKey, claimSource } from './source-claims.js';
import type { IntakeConfig, IntakeSource } from './report.js';

export interface IntakeWiring {
  config: () => IntakeConfig | null;
  sources: IntakeSource[];
  roleOf?: RoleOf;
  /** The instance's name (its dashboard links name it). */
  name: string;
  /**
   * Connect Discord, after the start-up checks: no other instance on the machine claims one of its server+channel
   * pairs, and every discord.owners entry maps to an admin of the repo. Then Slack (its bot token names the configured
   * workspace, and no other instance runs the same Slack app) and Linear (no other instance takes the same team and
   * label). A refusal leaves that source off (it is removed) and says why; null when every source started or there is
   * nothing to start.
   */
  start: () => Promise<string | null>;
  /** Closes the Discord and Slack connections and releases the claims. */
  stop: () => void;
}

/** Why discord.owners can't stand: an entry whose login isn't an admin on the repo (or couldn't be confirmed as one). */
export async function ownersProblem(cfg: IntakeConfig, repo: string, roleOf: RoleOf | undefined): Promise<string | null> {
  for (const id of cfg.discord.owners) {
    const login = cfg.discord.people[id];
    if (!login) return `discord.owners: ${id} is not mapped to a GitHub login in discord.people`;
    let role: string | null = null;
    try {
      role = roleOf ? await roleOf(login, { fresh: true }) : null;
    } catch {
      role = null;
    }
    if (role !== 'owner') return `discord.owners: ${id} maps to @${login}, who is ${role ? `a ${role}` : 'not confirmed'} on ${repo}, not an admin; every Discord owner must map to a GitHub admin of the repo (take them out of discord.owners, or make @${login} an admin)`;
  }
  return null;
}

/** The Discord bot as the coordinator's chat source: what it takes, how it answers, and its wake-up on arrival. */
export function discordSource(bot: DiscordIntake): IntakeSource {
  return {
    name: 'discord',
    take: async () => bot.take(),
    takeNow: async (which) => bot.takeWhere(which),
    onArrival: (fn) => bot.onArrival(fn),
    typing: (where) => bot.typing(where),
    reply: (t, text, opts) => bot.reply(t.id, text, opts?.mentions),
    openThread: (c, text, name, from) => bot.openThread(c, text, name, from),
    watch: (t) => bot.watch(t),
    dm: (user, text) => bot.dm(user, text),
  };
}

/** The instance's bot token, from the file credentials.yaml intake.discord_token names (the bot and `discord channels` both read it here). */
export const readDiscordToken = (tokenFile: string): string => readFileSync(tokenFile, 'utf8').trim();
/** An intake credential (a Slack token, the Linear key) from the file credentials.yaml names: the coordinator's own, 0400. */
export const readIntakeSecret = (file: string): string => readFileSync(file, 'utf8').trim();

/** The Slack app as the coordinator's source: a plain report source (no threads of its own, no chat). */
export function slackSource(bot: SlackIntake): IntakeSource {
  return { name: 'slack', take: () => bot.take(), reply: (t, text) => bot.reply(t.id, text) };
}

/**
 * The intake deps for one instance, or null when it has no intake.yaml (intake off). A config that is refused
 * (unsafe permissions, invalid) is reported and leaves intake off. Discord connects only on start(), when its
 * config enables it, the instance has a token file and the start-up checks pass.
 */
export function intakeForInstance(o: {
  home: string;
  repo: string;
  /** The instance's name; default the home's directory name. */
  instance?: string;
  /** credentials.yaml intake.discord_token: the token file's path. */
  tokenFile?: string | undefined;
  /** credentials.yaml intake.slack_app_token, slack_bot_token and linear_api_key: the files' paths. */
  slackAppTokenFile?: string | undefined;
  slackBotTokenFile?: string | undefined;
  linearKeyFile?: string | undefined;
  /** Tests: the Slack adapter's socket, fetch and timer, and Linear's fetch. */
  slack?: Pick<SlackOptions, 'connect' | 'fetch' | 'setTimeout'>;
  linearFetch?: typeof fetch;
  /** The instance's own GitHub token (for repo permissions). */
  githubToken: () => Promise<string>;
  githubApi?: string;
  /** Where every instance's home is (the clash check reads their intake.yaml); default the home's parent. */
  instancesDir?: string;
  /** The machine-wide directory for the identify gate and the bots' claims; default the agent slot directory. */
  machineDir?: SlotPathLike;
  /** Tests: the adapter's socket, fetch and timers, the gate's clock, and roles. */
  discord?: Pick<DiscordOptions, 'connect' | 'fetch' | 'setInterval' | 'clearInterval' | 'setTimeout'> & { now?: () => number; sleep?: (ms: number) => Promise<void>; alive?: (pid: number) => boolean };
  roleOf?: RoleOf;
  log?: (line: string) => void;
  /**
   * The production read path (deploy.yaml prod_read, through the owner's platform login and the read-only role on the
   * production service), or undefined when the project has none: then no production source is wired.
   */
  prodRead?: ReadOnlyQuery | undefined;
  /** The instance's state directory (where a production source keeps its cursor); required with prodRead. */
  stateDir?: string;
  // WHY: injectable so tests never reach GitHub; default the instance's repo with its own token.
  issues?: Pick<Backlog, 'list' | 'comment'>;
}): IntakeWiring | null {
  const file = join(o.home, INTAKE_FILE);
  const first = loadIntakeConfig(file);
  if (!first) return null;
  const say = o.log ?? ((l: string) => console.error(l));
  if ('error' in first) {
    say(`intake off: ${first.error}`);
    return null;
  }
  for (const w of first.warnings) say(`intake: ${w}`);
  const name = o.instance ?? basename(o.home);
  // Read again on every pass, so a change applies without a restart; a broken edit turns intake off, not open.
  const config = () => {
    const c = loadIntakeConfig(file);
    return c && 'config' in c ? c.config : null;
  };
  const sources: IntakeSource[] = [];
  let stop = () => {};
  let start = async (): Promise<string | null> => null;
  const machineDir = () => o.machineDir ?? slotsDir();
  const d = first.config.discord;
  const roleOf = o.roleOf ?? (Object.keys(d.people).length ? cachedRoles(repoPermission({ repo: o.repo, token: o.githubToken, ...(o.githubApi ? { api: o.githubApi } : {}) })) : undefined);
  if (d.enabled && d.guild) {
    if (!o.tokenFile) say('intake: discord is on but credentials.yaml has no intake.discord_token; the bot is not connected');
    else {
      const token = readDiscordToken(o.tokenFile);
      const machine = machineDir();
      const f = o.discord?.fetch;
      const { now: _now, sleep: _sleep, alive: _alive, ...adapter } = o.discord ?? {};
      const gate = identifyGate({ dir: machine, token, owner: `discord identify ${name}`, ...(o.discord?.now ? { now: o.discord.now } : {}), ...(o.discord?.sleep ? { sleep: o.discord.sleep } : {}), limit: () => sessionStartLimit(token, f ?? fetch) });
      const bot = new DiscordIntake({ token, guild: d.guild, channels: d.channels, chatChannels: d.chat_channels, allowedSenders: d.allowed_senders, prefixes: d.prefixes, owners: d.owners, ...(d.ops_channel ? { opsChannel: d.ops_channel } : {}), gate, log: say, ...adapter });
      const source = discordSource(bot);
      sources.push(source);
      let release = () => {};
      start = async () => {
        const refuse = (why: string) => {
          sources.splice(sources.indexOf(source), 1);
          say(`discord not started: ${why}`);
          return why;
        };
        const owners = await ownersProblem(first.config, o.repo, roleOf);
        if (owners) return refuse(owners);
        const claim = await claimDiscord({ instance: name, config: first.config, instancesDir: o.instancesDir ?? dirname(o.home), claimsDir: machine, ...(o.discord?.alive ? { alive: o.discord.alive } : {}), ...(o.discord?.sleep ? { sleep: o.discord.sleep } : {}) });
        if ('error' in claim) return refuse(claim.error);
        release = claim.release;
        bot.start();
        return null;
      };
      stop = () => {
        bot.stop();
        release();
      };
    }
  }
  // Slack and Linear start after Discord, each through its own start-up checks; a refusal leaves only that one off.
  const starts: (() => Promise<string | null>)[] = [];
  const stops: (() => void)[] = [];
  const sl = first.config.slack;
  if (sl.enabled && sl.team) {
    if (!o.slackAppTokenFile || !o.slackBotTokenFile) say('intake: slack is on but credentials.yaml lacks intake.slack_app_token or intake.slack_bot_token; Slack is not connected');
    else {
      const bot = new SlackIntake({ appToken: readIntakeSecret(o.slackAppTokenFile), botToken: readIntakeSecret(o.slackBotTokenFile), team: sl.team, channels: sl.channels, allowedSenders: sl.allowed_senders, log: say, ...(o.slack ?? {}) });
      const source = slackSource(bot);
      sources.push(source);
      let release = () => {};
      starts.push(async () => {
        const refuse = (why: string) => {
          sources.splice(sources.indexOf(source), 1);
          say(`slack not started: ${why}`);
          return `slack: ${why}`;
        };
        const me = await bot.identify();
        if ('error' in me) return refuse(me.error);
        const claim = await claimSource({ kind: 'slack', instance: name, key: claimKey('slack', me.team, me.user), claimsDir: machineDir(), ...(o.discord?.alive ? { alive: o.discord.alive } : {}), ...(o.discord?.sleep ? { sleep: o.discord.sleep } : {}) });
        if ('error' in claim) return refuse(claim.error);
        release = claim.release;
        bot.start();
        return null;
      });
      stops.push(() => {
        bot.stop();
        release();
      });
    }
  }
  const li = first.config.linear;
  if (li.enabled && li.team && li.label) {
    if (!o.linearKeyFile) say('intake: linear is on but credentials.yaml has no intake.linear_api_key; Linear is not read');
    else if (!o.stateDir) say('intake: linear is on but the instance has no state directory; Linear is not read');
    else {
      const linear = new LinearIntake({ apiKey: readIntakeSecret(o.linearKeyFile), stateDir: o.stateDir, config: () => config()?.linear ?? li, ...(o.linearFetch ? { fetch: o.linearFetch } : {}) });
      // INVARIANT: nothing is pulled until this instance holds the claim (start(), below).
      let claimed = false;
      const source: IntakeSource = { ...linear.source(), take: () => (claimed ? linear.take() : Promise.resolve([])) };
      sources.push(source);
      let release = () => {};
      starts.push(async () => {
        const claim = await claimSource({ kind: 'linear', instance: name, key: claimKey('linear', li.team!, li.label!), claimsDir: machineDir(), ...(o.discord?.alive ? { alive: o.discord.alive } : {}), ...(o.discord?.sleep ? { sleep: o.discord.sleep } : {}) });
        if ('error' in claim) {
          sources.splice(sources.indexOf(source), 1);
          say(`linear not started: ${claim.error}`);
          return `linear: ${claim.error}`;
        }
        release = claim.release;
        claimed = true;
        return null;
      });
      stops.push(() => {
        claimed = false;
        release();
      });
    }
  }
  const startDiscord = start;
  const stopDiscord = stop;
  start = async () => {
    const why = [await startDiscord()];
    for (const s of starts) why.push(await s());
    const refused = why.filter((w): w is string => !!w);
    return refused.length ? refused.join('; ') : null;
  };
  stop = () => {
    stopDiscord();
    for (const s of stops) s();
  };
  // Production alerts: only when intake.yaml turns them on and the project has the owner's production read path.
  if (first.config.alerts.enabled) {
    if (!o.prodRead || !o.stateDir) say('intake: alerts are on but the project has no production read path (deploy.yaml prod_read); alerts are not pulled');
    else {
      const alerts = new AlertsIntake({ stateDir: o.stateDir, config: () => config()?.alerts ?? first.config.alerts, run: o.prodRead });
      sources.push({ name: alerts.name, take: () => alerts.take(), ack: (ids) => alerts.ack(ids), reply: () => alerts.reply() });
    }
  }
  if (first.config.github.enabled) {
    if (!o.stateDir) say('intake: github is on but the instance has no state directory; issues are not pulled');
    else {
      const backlog = o.issues ?? new GitHubBacklog(o.repo, o.githubToken, fetch, o.githubApi);
      sources.push(new GitHubIssuesIntake({ backlog, stateDir: o.stateDir, config: () => config()?.github ?? first.config.github }).source());
    }
  }
  return { config, sources, name, ...(roleOf ? { roleOf } : {}), start, stop };
}
