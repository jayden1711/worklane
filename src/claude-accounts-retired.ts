// Issue #736: the engine no longer manages Claude subscription accounts. Account profiles (several logins per agent
// user, each in <agent home>/.claude-profiles/<name>), failover between them on a usage limit, and the whole-login
// switch from a pasted token are gone. One person signs an instance's agent user in to the unmodified `claude`
// themselves, through Anthropic's own flow (sudo -u <agent user> -i claude auth login), or the instance uses an API key.
//
// What an older engine left is read here only to fail closed, never to pick a login:
//   - a run's login is always its user's own (resolve never changes it), and the whole ~/.claude-profiles of every
//     run's user stays on its denied reads, whatever names are in it, until the root step below removes it;
//   - an instance whose runs were on another profile at upgrade (profiles.json's "active") doesn't start, and says why
//     and what to do: the engine never copies or moves a login between profiles or users;
//   - every other leftover (profiles.json, profile-ops.jsonl, switch.jsonl, paused) is ignored, with a warning at start
//     and in doctor, naming the root step that removes it.
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { CLAUDE_ACCOUNT_DIR } from './claude-account.js';
import type { RunAs } from './runner.js';
import { asRoot } from './os/system-paths.js';

/** The root script on the machine: `status` stays, and `uninstall` removes what the removed commands left. */
export const CLAUDE_ACCOUNT_SCRIPT = asRoot.opt('current/scripts/setup/claude-account.sh');
/** The root step that removes the leftovers: each agent user's ~/.claude-profiles (as that user) and the files below. */
export const UNINSTALL_ACCOUNTS = `sudo bash ${CLAUDE_ACCOUNT_SCRIPT} uninstall`;
/** Where an older engine kept an agent user's extra logins, under its home. */
export const PROFILES_DIRNAME = '.claude-profiles';
/** What the removed commands kept in the claude-account dir (status.json is status's, and stays). */
export const RETIRED_FILES = ['profiles.json', 'profile-ops.jsonl', 'switch.jsonl', 'paused'] as const;
/** How a person signs an instance's agent user in now: as that user, through Anthropic's own flow. */
export const signinCommand = (agentUser = '<agent user>') => `sudo -u ${agentUser} -i claude auth login`;

/**
 * The runner's login hook (src/runner.ts CliRunner's `login`) for an instance: each run on its user's own login, as
 * it is (never a profile's dir), and that user's whole ~/.claude-profiles on its commands' deny list, with the agent
 * user's own login file, as before. Reads nothing: no leftover file can steer it.
 */
export function retiredLogin(o: { agentUser: string }) {
  return {
    resolve: (r: RunAs) => r,
    credentialFiles: (r: RunAs) => [posix.join(r.home, PROFILES_DIRNAME), ...(r.user === o.agentUser ? [posix.join(r.claudeConfigDir ?? posix.join(r.home, '.claude'), '.credentials.json')] : [])],
  };
}

/** What is left in the claude-account dir: each leftover file, and the instances profiles.json had on another profile. */
export interface RetiredLeftovers {
  files: string[];
  /** Instance -> the profile its runs were on. */
  onProfile: Record<string, string>;
  /** profiles.json is there and can't be read as JSON: which instance was on which profile can't be told. */
  unreadable: boolean;
  /** Instances (or "machine") with a failover setting left: ignored. */
  failover: string[];
}

export function retiredLeftovers(dir = CLAUDE_ACCOUNT_DIR): RetiredLeftovers {
  const files = RETIRED_FILES.filter((f) => {
    try {
      lstatSync(join(dir, f));
      return true;
    } catch (e) {
      // Present but unseen (a permission) counts as present: unsure is never "nothing left".
      return (e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR';
    }
  });
  const out: RetiredLeftovers = { files, onProfile: {}, unreadable: false, failover: [] };
  if (!files.includes('profiles.json')) return out;
  let p: { active?: unknown; failover?: { machine?: unknown; instances?: unknown } };
  try {
    p = (JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')) ?? {}) as typeof p;
    if (typeof p !== 'object') throw new Error('not an object');
  } catch {
    return { ...out, unreadable: true };
  }
  // Every active entry not on default, whatever else the file says of it (staged, unknown, a strange name).
  if (p.active && typeof p.active === 'object') {
    for (const [inst, a] of Object.entries(p.active as Record<string, unknown>)) {
      const profile = (a as { profile?: unknown } | null)?.profile;
      if (profile !== 'default') out.onProfile[inst] = typeof profile === 'string' ? profile.slice(0, 40) : '(unnamed)';
    }
  }
  if (p.failover?.machine) out.failover.push('machine');
  if (p.failover?.instances && typeof p.failover.instances === 'object') out.failover.push(...Object.keys(p.failover.instances as object));
  return out;
}

/** Why this instance doesn't start (its runs were on another profile, or that can't be told), or null when it may. */
export function retiredAccountGate(instance: string, dir = CLAUDE_ACCOUNT_DIR): string | null {
  const l = retiredLeftovers(dir);
  const what = `As root, remove what profiles left: ${UNINSTALL_ACCOUNTS}. Then sign its agent user in yourself, if it isn't (${signinCommand()}), or give the instance an API key (credentials.sh ${instance} api-key), and start it again`;
  if (l.unreadable) return `${join(dir, 'profiles.json')} can't be read, so whether this instance's runs were on another Claude account profile can't be told. Account profiles were removed (#736) and the engine never moves a login between profiles or users. ${what}`;
  const profile = l.onProfile[instance];
  if (profile === undefined) return null;
  return `its runs were on Claude account profile "${profile}", and account profiles were removed (#736): the engine never moves a login between profiles or users, so it starts no run on another one. ${what}`;
}

/** The warning at start for leftovers that refuse nothing: ignored, with the step that removes them. Null: none. */
export function retiredAccountWarning(dir = CLAUDE_ACCOUNT_DIR): string | null {
  const l = retiredLeftovers(dir);
  if (!l.files.length) return null;
  return `Claude account profiles, failover and the account switch were removed (#736); what they left is ignored: ${l.files.map((f) => join(dir, f)).join(', ')}${l.failover.length ? ` (a failover setting for ${l.failover.join(', ')})` : ''}. Remove it, as root: ${UNINSTALL_ACCOUNTS}`;
}

/** Doctor's check: null with nothing left; a failure while an instance is refused for it, else a warning. */
export function claudeAccountLeftoverCheck(dir = CLAUDE_ACCOUNT_DIR): { name: string; level: 'fail' | 'warn'; detail: string } | null {
  const l = retiredLeftovers(dir);
  if (!l.files.length) return null;
  const refused = Object.entries(l.onProfile).map(([i, p]) => `${i} (its runs were on profile ${p})`);
  const lines = [
    'Claude account profiles, failover and the account switch were removed (#736); this machine still has what they left, which the engine ignores:',
    ...l.files.map((f) => `- ${join(dir, f)}`),
    ...(l.failover.length ? [`- a failover setting for ${l.failover.join(', ')} (no account is ever moved to)`] : []),
    ...(l.unreadable ? ["- profiles.json can't be read: every instance is refused until it is removed"] : []),
    ...(refused.length ? [`Refused at start until it is removed: ${refused.join(', ')}.`] : []),
    `Remove it, as root (each agent user's ~/${PROFILES_DIRNAME} too, as that user): ${UNINSTALL_ACCOUNTS}`,
    `Then sign each agent user in yourself if it isn't: ${signinCommand()}`,
  ];
  return { name: 'Claude account profiles removed', level: refused.length || l.unreadable ? 'fail' : 'warn', detail: lines.join('\n') };
}

/** The Machine page's notice: what is left, the instances refused for it, and the root step. Null: nothing left. */
export function retiredView(dir = CLAUDE_ACCOUNT_DIR): { files: string[]; refused: string[]; unreadable: boolean; command: string } | null {
  const l = retiredLeftovers(dir);
  if (!l.files.length) return null;
  return { files: l.files, refused: Object.keys(l.onProfile).sort(), unreadable: l.unreadable, command: UNINSTALL_ACCOUNTS };
}
