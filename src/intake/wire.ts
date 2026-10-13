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
import { INTAKE_FILE, loadIntakeConfig } from './config.js';
import { claimDiscord } from './discord-claims.js';
import { identifyGate, sessionStartLimit } from './discord-gate.js';
import { AlertsIntake } from './alerts.js';
import type { ReadOnlyQuery } from './bug-store.js';
import { DiscordIntake, type DiscordOptions } from './discord.js';
import type { IntakeConfig, IntakeSource } from './report.js';

export interface IntakeWiring {
  config: () => IntakeConfig | null;
  sources: IntakeSource[];
  roleOf?: RoleOf;
  /** The instance's name (its dashboard links name it). */
  name: string;
  /**
   * Connect Discord, after the start-up checks: no other instance on the machine claims one of its server+channel
   * pairs, and every discord.owners entry maps to an admin of the repo. A refusal leaves Discord off (the source is
   * removed) and says why; null when connected or when there is nothing to connect.
   */
  start: () => Promise<string | null>;
  /** Closes the Discord connection. */
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
  /** The instance's own GitHub token (for repo permissions). */
  githubToken: () => Promise<string>;
  githubApi?: string;
  /** Where every instance's home is (the clash check reads their intake.yaml); default the home's parent. */
  instancesDir?: string;
  /** The machine-wide directory for the identify gate and the bots' claims; default the agent slot directory. */
  machineDir?: string;
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
  const d = first.config.discord;
  const roleOf = o.roleOf ?? (Object.keys(d.people).length ? cachedRoles(repoPermission({ repo: o.repo, token: o.githubToken, ...(o.githubApi ? { api: o.githubApi } : {}) })) : undefined);
  if (d.enabled && d.guild) {
    if (!o.tokenFile) say('intake: discord is on but credentials.yaml has no intake.discord_token; the bot is not connected');
    else {
      const token = readFileSync(o.tokenFile, 'utf8').trim();
      const machine = o.machineDir ?? slotsDir();
      const f = o.discord?.fetch;
      const { now: _now, sleep: _sleep, alive: _alive, ...adapter } = o.discord ?? {};
      const gate = identifyGate({ dir: machine, token, owner: `discord identify ${name}`, ...(o.discord?.now ? { now: o.discord.now } : {}), ...(o.discord?.sleep ? { sleep: o.discord.sleep } : {}), limit: () => sessionStartLimit(token, f ?? fetch) });
      const bot = new DiscordIntake({ token, guild: d.guild, channels: d.channels, chatChannels: d.chat_channels, allowedSenders: d.allowed_senders, prefixes: d.prefixes, owners: d.owners, gate, log: say, ...adapter });
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
  // Production alerts: only when intake.yaml turns them on and the project has the owner's production read path.
  if (first.config.alerts.enabled) {
    if (!o.prodRead || !o.stateDir) say('intake: alerts are on but the project has no production read path (deploy.yaml prod_read); alerts are not pulled');
    else {
      const alerts = new AlertsIntake({ stateDir: o.stateDir, config: () => config()?.alerts ?? first.config.alerts, run: o.prodRead });
      sources.push({ name: alerts.name, take: () => alerts.take(), ack: (ids) => alerts.ack(ids), reply: () => alerts.reply() });
    }
  }
  return { config, sources, name, ...(roleOf ? { roleOf } : {}), start, stop };
}
