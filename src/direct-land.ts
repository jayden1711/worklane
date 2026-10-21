// land_mode direct only on a protected default branch (the owner's decision). A direct land is the harness pushing
// the default branch itself; on a branch GitHub doesn't protect (a private repo on GitHub Free answers 403 or 404),
// nothing would stop a bad push, and the main watch is off in direct mode. So:
//   - at start-up the coordinator asks GitHub, with the main watch's own protection check (MainWatchApi.protection),
//     and refuses to start unless GitHub enforces the branch's protection; a check that errors refuses too;
//   - every direct land asks again just before its push, and pushes nothing unless the answer is "enforced".
// A remote that is a local path (a bare repo on disk: the demo, the tests) has no protection to ask about: allowed.
import { spawnSync } from './os/child-process.js';
import { existsSync } from 'node:fs';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import type { MainWatchApi } from './main-watch.js';

export type Protection = Pick<MainWatchApi, 'protection'>;

/** Whether `remote` in `repo` is a path on this machine (or file://), not a host that could protect a branch. */
export function localRemote(repo: string, remote: string): boolean {
  const r = spawnSync('git', ['remote', 'get-url', remote], { cwd: repo, encoding: 'utf8' });
  const url = r.status === 0 ? r.stdout.trim() : '';
  if (!url) return false;
  return url.startsWith('file://') || existsSync(url);
}

/**
 * Why a direct land may not push `branch` of `repo`, or null when GitHub enforces its protection. Never throws: a
 * check that fails (an error, the network down) is a refusal that says the protection couldn't be checked.
 */
export async function directLandRefusal(api: Protection | undefined, o: { repo: string; branch: string; local: boolean }): Promise<string | null> {
  const fix = 'use land_mode: pr, or turn on branch protection';
  if (!api && o.local) return null;
  if (!api) return `land_mode: direct pushes ${o.branch} itself, and ${o.repo}'s branch protection can't be checked (no GitHub access), so nothing is known to stop a bad push; ${fix}`;
  let p: 'enforced' | 'none';
  try {
    p = await api.protection(o.branch);
  } catch (e) {
    return `land_mode: direct pushes ${o.branch} itself, and ${o.repo}'s branch protection couldn't be checked (${(e as Error).message.split('\n')[0]!.slice(0, 300)}), so nothing is known to stop a bad push; ${fix}, then start it again`;
  }
  if (p === 'enforced') return null;
  return `land_mode: direct pushes ${o.branch} itself, and ${o.repo} has no branch protection, so nothing would stop a bad push; ${fix}`;
}

/** The kind of the coordinator.error a refused direct land records (at start-up, and at a land): health shows it. */
export const DIRECT_LAND_REFUSED = 'direct_land_refused';

/**
 * At start-up, before anything else runs: with land_mode direct, refuse to start unless the default branch is
 * protected. The refusal is recorded (coordinator.error, where start-up) so health and the dashboard show it, and
 * returned to be printed; null: start.
 */
export async function directLandStartGate(o: { landMode: 'direct' | 'pr'; api: Protection | undefined; local: boolean; repo: string; branch: string; label: string; log: EventLog; actor: string }): Promise<string | null> {
  if (o.landMode !== 'direct') return null;
  const why = await directLandRefusal(o.api, o);
  if (!why) return null;
  const message = `${o.label} not started: ${why}`;
  o.log.append('coordinator.error', { instance: o.actor, where: 'start-up', kind: DIRECT_LAND_REFUSED, message: message.slice(0, 1000) }, o.actor);
  return message;
}

/**
 * A refused direct land not since cleared (by a coordinator that started, or a land that pushed): its message, for
 * health to say first. Null when there is none.
 */
export function directLandProblem(events: readonly StoredEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'coordinator.started') return null;
    if (e.type === 'land.batch' && (e.payload as EventPayload<'land.batch'>).outcome === 'landed') return null;
    if (e.type === 'coordinator.error' && (e.payload as EventPayload<'coordinator.error'>).kind === DIRECT_LAND_REFUSED) return (e.payload as EventPayload<'coordinator.error'>).message;
  }
  return null;
}
