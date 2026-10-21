// The default branch's tip as a coordinator's watch learns it from the remote (ls-remote: `defaultTip`), for the merge
// gate's tests that build a coordinator and call its gate directly, with no tick (#784 round 7: the gate measures a PR's
// change from that tip, and holds or waits when it is unknown or the clone's ref says otherwise).
import { execFileSync, spawnSync } from 'node:child_process';

/** The clone's `origin/main` (set to `base` when there is none) as the tip the remote gave the coordinator `c`. */
export function knownTip(c: unknown, dir: string, base: string): void {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) execFileSync('git', ['update-ref', 'refs/remotes/origin/main', base], { cwd: dir });
  (c as { defaultTip: string }).defaultTip = r.status === 0 ? r.stdout.trim() : base;
}
