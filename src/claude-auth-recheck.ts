// The owner's "Re-check the Claude sign-in" (the dashboard's banner for a held login, src/claude-auth-failure.ts):
// the dashboard can't run claude as the agent user, the coordinator can, so the dashboard leaves a request file in
// the instance's state dir and the coordinator's next tick takes it and makes the one minimal real call
// (CoordinatorBase.checkHeldLogins, one a minute at most however often it is asked). The file names who asked; it
// carries nothing else.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { groupOnlyDir } from './os/index.js';

const FILE = 'claude-auth-recheck.json';

/** The dashboard's side: ask for a re-check (a second ask before it is taken replaces the first). */
export function requestAuthRecheck(stateDir: string, by: string, now = new Date()): void {
  groupOnlyDir(stateDir);
  const tmp = join(stateDir, `.${FILE}.${randomBytes(3).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify({ v: 1, by: by.slice(0, 200), at: now.toISOString() }), { mode: 0o600 });
  renameSync(tmp, join(stateDir, FILE));
}

/** The coordinator's side: the request, if there is one (taken: removed), else null. */
export function takeAuthRecheck(stateDir: string): { by: string; at: string } | null {
  const f = join(stateDir, FILE);
  if (!existsSync(f)) return null;
  let r: { by: string; at: string } | null = null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as { v?: unknown; by?: unknown; at?: unknown };
    if (j.v === 1 && typeof j.by === 'string' && typeof j.at === 'string') r = { by: j.by, at: j.at };
  } catch {
    // unreadable: dropped
  }
  rmSync(f, { force: true });
  return r;
}
