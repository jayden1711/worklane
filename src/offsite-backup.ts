// Off-machine backups of the event log, encrypted, verified by reading the
// remote copy back. The owner supplies four commands in a file in the instance
// home (never in the repo, which agents can change): encrypt, put, get and
// decrypt. So any tool works (age or openssl to encrypt; a mounted drive,
// rclone or an S3-compatible CLI to store) and the harness never holds the key:
// only the owner's decrypt command names it. Paths reach the commands through
// environment variables, never spliced into the command line.
//
// Success is what events/backup.ts already requires of any store: the copy read
// back (here: fetched from the destination and decrypted) has the snapshot's
// checksum and latest event id. An encrypt command that leaves the snapshot
// readable is refused before anything is sent.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { BRAND } from './brand.js';
import { backup, type BackupResult, type BackupStore } from './events/backup.js';
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import { shellCommand } from './os/index.js';

/** The file, in the instance home beside policy.yaml, that turns off-machine backups on. */
export const OFFSITE_FILE = 'offsite-backup.yaml';

/** What each command gets: the file to read, the file to write, and the copy's name at the destination. */
export const VARS = { in: `${BRAND.envPrefix}_BACKUP_IN`, out: `${BRAND.envPrefix}_BACKUP_OUT`, name: `${BRAND.envPrefix}_BACKUP_NAME` } as const;

const command = z.string().min(1);
export const OffsiteConfig = z.strictObject({
  version: z.literal(1),
  /** Where the copies go, as a label for reports and the health panel (e.g. "rclone remote, nightly bucket"). */
  destination: z.string().min(1).max(200),
  /** How often a copy is made; a failed attempt is retried within the hour. */
  every_hours: z.number().positive().max(24).default(6),
  /** Reads $IN (the snapshot), writes $OUT (its encrypted form). */
  encrypt: command,
  /** Reads $IN (the encrypted copy), stores it at the destination as $NAME. */
  put: command,
  /** Fetches $NAME from the destination into $OUT. */
  get: command,
  /** Reads $IN (the fetched copy), writes $OUT (the snapshot again). The only command that needs the key. */
  decrypt: command,
  timeout_minutes: z.number().int().positive().max(120).default(10),
});
export type OffsiteConfig = z.infer<typeof OffsiteConfig>;

/** A copy older than this is reported as stale. */
export const STALE_HOURS = 24;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

/** The owner's config, or null when there's none (off-machine backups are off). A file anyone else could change is refused: it runs commands. */
export function loadOffsiteConfig(path: string): { config: OffsiteConfig } | { error: string } | null {
  if (!existsSync(path)) return null;
  // Where files have POSIX owners and modes (not Windows, which has neither getuid nor meaningful mode bits).
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null) {
    const st = statSync(path);
    if (st.mode & 0o022) return { error: `${path} is writable by its group or others; it names commands to run, so only its owner may change it (chmod 600)` };
    if (st.uid !== uid && st.uid !== 0) return { error: `${path} belongs to another user; it must be this service's own file (or root's)` };
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `${path}: not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const r = OffsiteConfig.safeParse(raw);
  if (!r.success) return { error: `${path}: ${r.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}` };
  return { config: r.data };
}

function run(what: string, cmd: string, vars: Partial<Record<keyof typeof VARS, string>>, cwd: string, timeoutMs: number) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(vars)) env[VARS[k as keyof typeof VARS]] = v;
  // The same shell as every project command (bash with pipefail; Git for Windows' bash there).
  const [file, args] = shellCommand(cmd);
  const r = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (r.error) throw new Error(`${what} command could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${what} command exited ${r.status ?? `on ${r.signal}`}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
}

/** A backup store made of the owner's commands; `tmp` is a private scratch dir the caller removes. */
export function commandStore(c: OffsiteConfig, tmp: string): BackupStore {
  const ms = c.timeout_minutes * 60_000;
  return {
    name: `off-machine (${c.destination})`,
    async put(key, data) {
      const plain = join(tmp, 'snapshot.db');
      const enc = join(tmp, 'snapshot.enc');
      writeFileSync(plain, data, { mode: 0o600 });
      try {
        run('encrypt', c.encrypt, { in: plain, out: enc, name: `${key}.enc` }, tmp, ms);
      } finally {
        rmSync(plain, { force: true });
      }
      const sealed = existsSync(enc) ? readFileSync(enc) : null;
      if (!sealed?.length) throw new Error(`the encrypt command wrote nothing to $${VARS.out}`);
      // Never send a readable snapshot: the output must not be the database (or contain it).
      if (sealed.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER) || sealed.includes(data.subarray(0, Math.min(4096, data.length)))) {
        throw new Error('the encrypt command left the snapshot readable; nothing was sent');
      }
      run('put', c.put, { in: enc, name: `${key}.enc` }, tmp, ms);
    },
    async get(key) {
      const fetched = join(tmp, 'fetched.enc');
      const opened = join(tmp, 'fetched.db');
      run('get', c.get, { out: fetched, name: `${key}.enc` }, tmp, ms);
      if (!existsSync(fetched)) return null;
      run('decrypt', c.decrypt, { in: fetched, out: opened, name: `${key}.enc` }, tmp, ms);
      return existsSync(opened) ? readFileSync(opened) : null;
    },
  };
}

/** One off-machine backup, verified by reading the remote copy back and decrypting it. */
export async function offsiteBackup(log: EventLog, c: OffsiteConfig, now = new Date()): Promise<BackupResult> {
  const tmp = mkdtempSync(join(tmpdir(), `${BRAND.cli}-offsite-`));
  try {
    return await backup(log, commandStore(c, tmp), now);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface OffsiteEvent {
  ok: boolean;
  destination: string;
  key: string;
  last_id: number;
  error?: string;
}

const offsiteEvents = (events: StoredEvent[]) => events.filter((e) => e.type === 'backup.offsite');

/** Due: no attempt yet, the last copy is `every_hours` old, or the last attempt failed over an hour ago. */
export function offsiteDue(events: StoredEvent[], c: OffsiteConfig, now = new Date()): boolean {
  const last = offsiteEvents(events).at(-1);
  if (!last) return true;
  const age = now.getTime() - Date.parse(last.ts);
  return (last.payload as OffsiteEvent).ok ? age >= c.every_hours * 3_600_000 : age >= 3_600_000;
}

/** Called by the service about once an hour: runs a backup when one is due and records the outcome either way. */
export async function maybeOffsiteBackup(log: EventLog, configPath: string, actor: string, now = new Date()): Promise<OffsiteEvent | null> {
  const loaded = loadOffsiteConfig(configPath);
  if (!loaded) return null;
  const events = log.read(0, ['backup.offsite']);
  if ('error' in loaded) {
    // A broken config is a failed backup: it must alert, not go quiet. Recorded at most once an hour.
    const last = events.at(-1);
    if (last && now.getTime() - Date.parse(last.ts) < 3_600_000) return null;
    const ev: OffsiteEvent = { ok: false, destination: configPath, key: '', last_id: log.lastId(), error: `config: ${loaded.error}` };
    log.append('backup.offsite', ev, actor);
    return ev;
  }
  if (!offsiteDue(events, loaded.config, now)) return null;
  const r = await offsiteBackup(log, loaded.config, now);
  const ev: OffsiteEvent = { ok: r.ok, destination: loaded.config.destination, key: r.key, last_id: r.lastId, ...(r.error ? { error: r.error.slice(0, 500) } : {}) };
  log.append('backup.offsite', ev, actor);
  return ev;
}

export interface OffsiteStatus {
  destination: string;
  /** The last copy verified by reading it back, or null if none ever was. */
  lastOkAt: string | null;
  lastOkKey: string | null;
  lastAttemptAt: string;
  /** The latest attempt's error, when it failed. */
  lastError: string | null;
  /** Hours since the last verified copy (null: never). */
  ageHours: number | null;
  /** No verified copy, or the last one is over a day old. */
  stale: boolean;
}

/** The off-machine backup's state from the log, or null if it was never set up (no attempt recorded). */
export function offsiteStatus(events: StoredEvent[], now = new Date()): OffsiteStatus | null {
  const all = offsiteEvents(events);
  const last = all.at(-1);
  if (!last) return null;
  const okEv = [...all].reverse().find((e) => (e.payload as OffsiteEvent).ok);
  const lastP = last.payload as OffsiteEvent;
  const ageHours = okEv ? Math.round(((now.getTime() - Date.parse(okEv.ts)) / 3_600_000) * 10) / 10 : null;
  return {
    destination: ((okEv ?? last).payload as OffsiteEvent).destination,
    lastOkAt: okEv?.ts ?? null,
    lastOkKey: okEv ? (okEv.payload as OffsiteEvent).key : null,
    lastAttemptAt: last.ts,
    lastError: lastP.ok ? null : (lastP.error ?? 'failed'),
    ageHours,
    stale: ageHours === null || ageHours > STALE_HOURS,
  };
}

const hrs = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h)} h`);

/** The report line: every report when set up; a warning when the last verified copy is over a day old. */
export function offsiteLine(s: OffsiteStatus | null): string | null {
  if (!s) return null;
  if (!s.stale) return `**Off-machine backup**: verified ${hrs(s.ageHours!)} ago (${s.destination}).`;
  const when = s.lastOkAt ? `the last verified copy is ${hrs(s.ageHours!)} old` : 'no copy has been verified yet';
  return `**Off-machine backup is stale**: ${when}${s.lastError ? `; the latest attempt failed: ${s.lastError.slice(0, 200)}` : ''}. Check the commands in the instance's ${OFFSITE_FILE}.`;
}
