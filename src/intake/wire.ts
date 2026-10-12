// Intake for one instance, as the service runs it: the instance's own intake.yaml (in its home, 0600) and, when
// that enables Discord, its own bot token (credentials.yaml intake.discord_token). Off by default: an instance
// with no intake.yaml gets no intake at all; one whose intake.yaml leaves Discord off gets no Discord source (no
// connection, nothing posted or read). Roles for the chat channel come from the instance's own repo, as the
// dashboard reads them. Nothing here is shared between instances.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cachedRoles, repoPermission, type RoleOf } from '../dashboard-auth.js';
import { INTAKE_FILE, loadIntakeConfig } from './config.js';
import { DiscordIntake, type DiscordOptions } from './discord.js';
import type { IntakeConfig, IntakeSource } from './report.js';

export interface IntakeWiring {
  config: () => IntakeConfig | null;
  sources: IntakeSource[];
  roleOf?: RoleOf;
  /** Closes the Discord connection. */
  stop: () => void;
}

/**
 * The intake deps for one instance, or null when it has no intake.yaml (intake off). A config that is refused
 * (unsafe permissions, invalid) is reported and leaves intake off. Discord connects only when its config enables
 * it and the instance has a token file.
 */
export function intakeForInstance(o: {
  home: string;
  repo: string;
  /** credentials.yaml intake.discord_token: the token file's path. */
  tokenFile?: string | undefined;
  /** The instance's own GitHub token (for repo permissions). */
  githubToken: () => Promise<string>;
  githubApi?: string;
  /** Tests: the adapter's socket and fetch. */
  discord?: Pick<DiscordOptions, 'connect' | 'fetch' | 'setInterval' | 'clearInterval'>;
  log?: (line: string) => void;
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
  // Read again on every pass, so a change applies without a restart; a broken edit turns intake off, not open.
  const config = () => {
    const c = loadIntakeConfig(file);
    return c && 'config' in c ? c.config : null;
  };
  const sources: IntakeSource[] = [];
  let stop = () => {};
  const d = first.config.discord;
  if (d.enabled && d.guild) {
    if (!o.tokenFile) say('intake: discord is on but credentials.yaml has no intake.discord_token; the bot is not connected');
    else {
      const bot = new DiscordIntake({ token: readFileSync(o.tokenFile, 'utf8').trim(), guild: d.guild, channels: d.channels, allowedSenders: d.allowed_senders, prefixes: d.prefixes, ...(o.discord ?? {}) });
      bot.start();
      stop = () => bot.stop();
      sources.push({ name: 'discord', take: async () => bot.take(), reply: (t, text) => bot.reply(t.id, text), openThread: (c, text, name, from) => bot.openThread(c, text, name, from), watch: (t) => bot.watch(t) });
    }
  }
  const roleOf = Object.keys(d.people).length ? cachedRoles(repoPermission({ repo: o.repo, token: o.githubToken, ...(o.githubApi ? { api: o.githubApi } : {}) })) : undefined;
  return { config, sources, ...(roleOf ? { roleOf } : {}), stop };
}
