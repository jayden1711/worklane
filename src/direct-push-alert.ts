// The direct-push alert: where GitHub doesn't protect the default branch, a commit that lands on it without a PR (a
// direct push, which GitHub's commit-to-PR link confirms no merged PR has; or a force-push that rewrote it) is posted
// to the Discord ops channel at once, mentioning the owners: on top of the main watch's stop, alert and revert PR
// (src/main-watch.ts, coordinator/merge-flow.ts). One post per commit, within the machine-wide limit of ops posts
// (watchdog/post.ts takeOpsPost). The owners are intake.yaml's discord.owners mapped in discord.people; without any,
// it posts without a mention and the dashboard says why. config.yaml main_watch.direct_push_alert: false turns it off.
//
// The post names the commit, who pushed it (a GitHub login only, never an email), its subject (redacted) and the
// dashboard's main-watch view. Nothing else: no diff, no credentials.
import type { EventPayload } from './events/types.js';
import type { IntakeConfig } from './intake/report.js';
import { scrub } from './watchdog/post.js';

/** The post's key (discord.posting / discord.posted): one per commit. */
export const directPushKey = (sha: string) => `direct-push:${sha}`;

/** Discord's message limit is 2000 characters; the post and its mentions stay under it. */
const MAX_CHARS = 1800;

/** Where the dashboard shows the main watch (the Machine page's protection section). */
export const mainWatchLink = (dashboardUrl: string) => `${dashboardUrl.replace(/\/+$/, '')}/machine#main-watch`;

/** Where the alert goes: the ops channel and the dashboard's address; or why it can't be posted. */
export function alertTarget(cfg: IntakeConfig | null): { channel: string; dashboardUrl: string } | { why: string } {
  if (!cfg) return { why: 'no intake.yaml on this instance, so no Discord ops channel' };
  if (!cfg.discord.enabled) return { why: 'Discord is off in intake.yaml' };
  if (!cfg.discord.ops_channel) return { why: 'no discord.ops_channel in intake.yaml' };
  if (!cfg.discord.dashboard_url) return { why: 'no discord.dashboard_url in intake.yaml' };
  return { channel: cfg.discord.ops_channel, dashboardUrl: cfg.discord.dashboard_url };
}

/**
 * Who the post mentions: each of discord.owners mapped to a GitHub login in discord.people. `note`: why nobody is
 * mentioned (shown on the dashboard), or null.
 */
export function ownerMentions(cfg: IntakeConfig): { mentions: string[]; note: string | null } {
  const owners = cfg.discord.owners;
  const mentions = owners.filter((id) => Object.hasOwn(cfg.discord.people, id));
  if (mentions.length) return { mentions, note: null };
  if (!owners.length) return { mentions, note: 'posted without a mention: intake.yaml has no discord.owners to mention' };
  return { mentions, note: 'posted without a mention: none of intake.yaml discord.owners is mapped to a GitHub login in discord.people' };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The post: what landed without a PR, who pushed it, its subject, and the dashboard's main-watch view. */
export function directPushText(p: EventPayload<'main_watch.direct_push'>, o: { branch: string; dashboardUrl: string; secrets?: string[] }): string {
  const short = p.sha.slice(0, 12);
  const head = p.kind === 'rewrite' ? `**${o.branch} was force-pushed** (rewritten, not through a PR): its tip is now \`${short}\` ${p.url}` : `**Pushed to ${o.branch} without a PR**: \`${short}\` ${p.url}`;
  const by = p.pusher ? (p.pusher_from === 'activity' ? `Pushed by: ${p.pusher} (GitHub)` : `Pushed by: unknown; the commit's GitHub author is ${p.pusher}`) : 'Pushed by: unknown';
  const subject = oneLine(p.subject).slice(0, 300);
  const lines = [head, by, `Subject: ${subject || '(none)'}`, `Auto-merge is stopped; the main watch: ${mainWatchLink(o.dashboardUrl)}`];
  const text = scrub(lines.join('\n'), o.secrets ?? []);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}
