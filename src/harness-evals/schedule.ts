// When the harness eval suite runs: on this machine, from the nightly window (tests.yaml nightly_at), at most once a
// day; weekly, and when the engine running here changed src/ since the last run. Which engine is running comes from
// the engine itself: its git commit, or the commit its install directory is named after (/opt/<cli>/<sha>).
import { gitSpawnSync } from '../os/git.js';
import { existsSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nightlyDue } from '../nightly.js';

/** The engine's own root (dist/src/harness-evals/ is three levels down). */
export const ENGINE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const SHA = /^[0-9a-f]{40}$/;

/** The commit of the engine running this code, or null when it can't tell. */
export function engineSha(root: string = ENGINE_ROOT): string | null {
  if (existsSync(join(root, '.git'))) {
    const r = gitSpawnSync(['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = r.status === 0 ? r.stdout.trim() : '';
    if (SHA.test(sha)) return sha;
  }
  try {
    const name = basename(realpathSync(root));
    return SHA.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Did src/ change between two commits, in the first of these clones that has both? null: none can tell. */
export function srcChanged(from: string, to: string, clones: string[]): boolean | null {
  for (const cwd of clones) {
    if (!existsSync(join(cwd, '.git'))) continue;
    const r = gitSpawnSync(['diff', '--quiet', from, to, '--', 'src/'], { cwd, stdio: 'ignore' });
    if (r.status === 0) return false;
    if (r.status === 1) return true;
  }
  return null;
}

export const WEEK_MS = 7 * 86_400_000;
/** When the nightly window opens if tests.yaml sets no nightly_at. */
export const DEFAULT_EVAL_AT = '03:00';

/**
 * Whether a run is due now, and why. Past the nightly time today with no run yet today; then a change first (the
 * engine is not the last run's and src/ changed since it, or nothing tells), else weekly (none in the last 7 days).
 * The first run of all is a weekly one (a change needs a run before it to compare with), unless weekly runs are off.
 */
export function harnessEvalDue(o: {
  now: Date;
  at: string | undefined;
  weekly: boolean;
  onChange: boolean;
  /** Day (YYYY-MM-DD, local) of the last run, of any trigger. */
  lastRunDay: string | null;
  /** When the last weekly run ended (ISO). */
  lastWeekly: string | null;
  /** The engine the last run evaluated. */
  lastEngine: string | null;
  engine: string | null;
  changed: (from: string, to: string) => boolean | null;
}): 'weekly' | 'change' | null {
  if (!nightlyDue(o.at ?? DEFAULT_EVAL_AT, o.lastRunDay, o.now)) return null;
  if (o.onChange && o.engine && (o.lastEngine ? o.engine !== o.lastEngine && o.changed(o.lastEngine, o.engine) !== false : !o.weekly)) return 'change';
  if (o.weekly && (!o.lastWeekly || o.now.getTime() - Date.parse(o.lastWeekly) >= WEEK_MS - 3600_000)) return 'weekly';
  return null;
}
