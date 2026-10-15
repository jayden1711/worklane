// Versioned migrations for what the engine keeps on disk: config files (the project's config dir and an
// instance's own files, each with a top-level `version`) and state (the event log's schema, as SQLite's
// user_version, each step recorded in its schema_migrations table). `doctor` lists what is pending,
// `migrate` applies it after a backup, and the coordinator refuses to start while any is pending, or when a
// file or the log is newer than this engine.
//
// Adding the next migration: append { to: N, what, apply } to CONFIG_MIGRATIONS or STATE_MIGRATIONS (and for a
// config change, raise the schema's `version: z.literal(...)` to N in the same PR). A config step edits the
// parsed YAML document in place (comments are kept); the version is stamped by the framework. A state step runs
// inside one transaction with the version bump and its record. Nothing here touches events themselves: the log
// stays append-only. test/migrations.test.ts shows how to test one.
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openReadOnly } from './events/read-only.js';
import { openWaiting } from './events/open.js';
import { parseDocument, type Document } from 'yaml';
import { BRAND } from './brand.js';
import { replaceFileAtomically } from './os/index.js';

export interface ConfigMigration {
  to: number;
  what: string;
  /** Edit one file's document (its name, e.g. `tests.yaml`, says which kind it is). */
  apply: (doc: Document, file: string) => void;
}
export interface StateMigration {
  to: number;
  what: string;
  /** Applied when the coordinator starts, needing no `migrate`: only for a step that changes nothing users see. */
  auto?: boolean;
  apply: (db: DatabaseSync) => void;
}

export const CONFIG_MIGRATIONS: ConfigMigration[] = [{ to: 1, what: 'version 1: the first config schema (no change)', apply: () => {} }];
export const STATE_MIGRATIONS: StateMigration[] = [{ to: 1, what: 'version 1: the event log as the engine first kept it (no change)', auto: true, apply: () => {} }];

const latest = (ms: { to: number }[]) => Math.max(0, ...ms.map((m) => m.to));
/** The event log's schema version a new log is created at. */
export const STATE_VERSION = latest(STATE_MIGRATIONS);

/** Instance files with a version, in the instance home. */
export const INSTANCE_FILES = ['instance.yaml', 'policy.yaml', 'credentials.yaml', 'intake.yaml'];

/** One pending step: a config file or the event log, from its version to the latest. */
export interface Pending {
  kind: 'config' | 'state';
  path: string;
  from: number;
  to: number;
  steps: string[];
  /** Every step may run at start, without `migrate`. */
  auto: boolean;
}

export interface MigrationPlan {
  pending: Pending[];
  /** Files or logs at a version this engine doesn't know: written by a newer engine. */
  newer: string[];
  /** Files that couldn't be read as YAML: loading the config reports these in full. */
  unreadable: string[];
}

export interface Targets {
  /** Config files that carry a top-level `version`. */
  configFiles: string[];
  /** The event log, if there is one yet. */
  eventsDb?: string;
}

/** The versioned files in a project's config dir. */
export function projectConfigFiles(root: string): string[] {
  const dir = join(root, BRAND.configDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => join(dir, f));
}

/** An instance's versioned files: its own (instance, policy, credentials, intake) and its repo's config dir. */
export function instanceTargets(home: string): Targets {
  const own = INSTANCE_FILES.map((f) => join(home, f)).filter((f) => existsSync(f));
  let repo: string[] = [];
  try {
    const path = (parseDocument(readFileSync(join(home, 'instance.yaml'), 'utf8')).toJS() as { repos?: { path?: string }[] }).repos?.[0]?.path;
    if (path) repo = projectConfigFiles(path);
  } catch {
    // loading the instance reports it
  }
  return { configFiles: [...own, ...repo], eventsDb: join(home, 'state', 'events.db') };
}

const userVersion = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

/** What is pending for these targets. Read-only. */
export function planMigrations(t: Targets, lists: { config?: ConfigMigration[]; state?: StateMigration[] } = {}): MigrationPlan {
  const config = lists.config ?? CONFIG_MIGRATIONS;
  const state = lists.state ?? STATE_MIGRATIONS;
  const plan: MigrationPlan = { pending: [], newer: [], unreadable: [] };
  for (const f of t.configFiles) {
    let doc: Document;
    try {
      doc = parseDocument(readFileSync(f, 'utf8'));
      if (doc.errors.length) throw doc.errors[0];
    } catch {
      plan.unreadable.push(f);
      continue;
    }
    const from = doc.get('version');
    if (typeof from !== 'number') continue; // not a versioned file
    if (from > latest(config)) plan.newer.push(`${f} is at config version ${from}; this engine knows up to ${latest(config)}`);
    const steps = config.filter((m) => m.to > from).sort((a, b) => a.to - b.to);
    if (steps.length) plan.pending.push({ kind: 'config', path: f, from, to: steps.at(-1)!.to, steps: steps.map((m) => m.what), auto: false });
  }
  if (t.eventsDb && existsSync(t.eventsDb)) {
    const db = openReadOnly(t.eventsDb);
    try {
      const from = userVersion(db);
      if (from > latest(state)) plan.newer.push(`${t.eventsDb} is at state version ${from}; this engine knows up to ${latest(state)}`);
      const steps = state.filter((m) => m.to > from).sort((a, b) => a.to - b.to);
      if (steps.length) plan.pending.push({ kind: 'state', path: t.eventsDb, from, to: steps.at(-1)!.to, steps: steps.map((m) => m.what), auto: steps.every((m) => m.auto === true) });
    } finally {
      db.close();
    }
  }
  return plan;
}

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-');

/** The record of applied state steps, inside the event log (not an event: the log's own bookkeeping). */
const RECORD = 'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, what TEXT NOT NULL, applied_at TEXT NOT NULL)';

/** Stamp a new event log at the latest state version (called once, when the log is created). */
export function stampNewLog(db: DatabaseSync, now = new Date()) {
  db.exec(RECORD);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, what, applied_at) VALUES (?, ?, ?)').run(STATE_VERSION, 'created at this version', now.toISOString());
  db.exec(`PRAGMA user_version = ${STATE_VERSION}`);
}

/** A file or log and the backup made of it before it was migrated. */
export interface Backup {
  kind: 'config' | 'state';
  path: string;
  backup: string;
}

/** Put backups back: each file as it was; a log as it was, without the write-ahead files of the migrated one. */
export function restoreBackups(made: Backup[]): void {
  for (const b of [...made].reverse()) {
    copyFileSync(b.backup, b.path);
    if (b.kind === 'state') for (const x of ['-wal', '-shm']) rmSync(`${b.path}${x}`, { force: true });
  }
}

/** A migration failed; every file and log it had touched was restored from its backup first. */
export class MigrationFailed extends Error {
  constructor(
    message: string,
    readonly restored: Backup[],
  ) {
    super(message);
  }
}

/**
 * Apply every pending step (only the `auto` ones with `onlyAuto`), each file or log backed up first beside it
 * (`<name>.bak-v<from>-<time>`). Returns what was applied and the backups. A file or log newer than this engine
 * is never touched. If any step fails, everything this call migrated is restored and MigrationFailed is thrown:
 * all or nothing.
 */
export function applyMigrations(t: Targets, o: { config?: ConfigMigration[]; state?: StateMigration[]; onlyAuto?: boolean; now?: () => Date } = {}): { applied: Pending[]; backups: string[]; made: Backup[] } {
  const config = o.config ?? CONFIG_MIGRATIONS;
  const state = o.state ?? STATE_MIGRATIONS;
  const now = (o.now ?? (() => new Date()))();
  const plan = planMigrations(t, { config, state });
  const applied: Pending[] = [];
  const backups: string[] = [];
  const made: Backup[] = [];
  try {
    for (const p of plan.pending) {
      if (o.onlyAuto && !p.auto) continue;
      migrateOne(p, now, config, state, made);
      backups.push(made.at(-1)!.backup);
      applied.push(p);
    }
  } catch (e) {
    restoreBackups(made);
    throw new MigrationFailed(`${(e as Error).message}; every file migrated was restored from its backup`, made);
  }
  return { applied, backups, made };
}

function migrateOne(p: Pending, now: Date, config: ConfigMigration[], state: StateMigration[], made: Backup[]): void {
  {
    const backup = `${p.path}.bak-v${p.from}-${stamp(now)}`;
    if (p.kind === 'config') {
      const doc = parseDocument(readFileSync(p.path, 'utf8'));
      copyFileSync(p.path, backup);
      made.push({ kind: 'config', path: p.path, backup });
      for (const m of config.filter((x) => x.to > p.from).sort((a, b) => a.to - b.to)) {
        m.apply(doc, basename(p.path));
        doc.set('version', m.to);
      }
      replaceFileAtomically(p.path, doc.toString(), statSync(p.path).mode & 0o777);
    } else {
      const db = openWaiting(p.path);
      try {
        db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        made.push({ kind: 'state', path: p.path, backup });
        db.exec(RECORD);
        for (const m of state.filter((x) => x.to > p.from).sort((a, b) => a.to - b.to)) {
          db.exec('BEGIN IMMEDIATE');
          try {
            m.apply(db);
            db.prepare('INSERT INTO schema_migrations (version, what, applied_at) VALUES (?, ?, ?)').run(m.to, m.what, now.toISOString());
            db.exec(`PRAGMA user_version = ${m.to}`);
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        }
      } finally {
        db.close();
      }
    }
  }
}

/** Why the coordinator can't start on these targets, or null: anything newer than this engine, or a pending step `migrate` must apply. */
export function migrationGate(t: Targets, lists: { config?: ConfigMigration[]; state?: StateMigration[] } = {}): string | null {
  // Steps that change nothing users see run here, at start; the rest wait for the owner's `migrate`.
  applyMigrations(t, { ...lists, onlyAuto: true });
  const plan = planMigrations(t, lists);
  const lines = [...plan.newer.map((n) => `${n}: update the engine, or restore the backup made before it was migrated`), ...plan.pending.map((p) => `${p.path}: ${p.kind} version ${p.from} -> ${p.to} pending (${p.steps.join('; ')})`)];
  return lines.length ? `${lines.join('\n')}\nrun \`${BRAND.cli} migrate\` (it backs each file up first), then start again` : null;
}
