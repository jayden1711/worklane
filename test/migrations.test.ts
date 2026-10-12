// Versioned migrations: config files and the event log's schema each move through numbered steps, once each,
// recorded, after a backup. The coordinator refuses to start while a step is pending or anything is newer than
// the engine. The real list holds only the no-op version 1; these tests add a version 2 of each kind, the way
// the next real migration will be written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BRAND } from '../src/brand.js';
import { EventLog } from '../src/events/log.js';
import { applyMigrations, CONFIG_MIGRATIONS, instanceTargets, migrationGate, planMigrations, projectConfigFiles, STATE_MIGRATIONS, STATE_VERSION, type ConfigMigration, type StateMigration } from '../src/migrations.js';
import { doctor } from '../src/doctor.js';
import { runCoordinator } from '../src/service.js';

/** A project config dir with a versioned tests.yaml (a comment kept), a file without a version, and an event log. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'mig-'));
  mkdirSync(join(root, BRAND.configDir));
  writeFileSync(join(root, BRAND.configDir, 'tests.yaml'), '# how the tests run\nversion: 1\nfull_cmd: "npm test" # the whole suite\n');
  writeFileSync(join(root, BRAND.configDir, 'notes.yaml'), 'not: versioned\n');
  const db = join(root, 'state', 'events.db');
  mkdirSync(join(root, 'state'));
  new EventLog(db).close();
  return { root, db, targets: { configFiles: projectConfigFiles(root), eventsDb: db } };
}

/** A version 2 of each: the config renames a key, the state adds a table. Counts how often each step runs. */
function nextVersion() {
  const ran = { config: 0, state: 0 };
  const config: ConfigMigration[] = [
    ...CONFIG_MIGRATIONS,
    {
      to: 2,
      what: 'version 2: tests.yaml full_cmd is now full',
      apply: (doc, file) => {
        ran.config++;
        if (file !== 'tests.yaml' || !doc.has('full_cmd')) return;
        doc.set('full', doc.get('full_cmd'));
        doc.delete('full_cmd');
      },
    },
  ];
  const state: StateMigration[] = [...STATE_MIGRATIONS, { to: 2, what: 'version 2: a table of run summaries', apply: (db) => (ran.state++, db.exec('CREATE TABLE run_summaries (id TEXT PRIMARY KEY)')) }];
  return { config, state, ran };
}

const recorded = (db: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return { version: (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, rows: (d.prepare('SELECT version, what FROM schema_migrations ORDER BY version').all() as { version: number; what: string }[]).map((r) => [r.version, r.what]) };
  } finally {
    d.close();
  }
};

test('a new event log starts at the current state version, recorded; nothing is pending for a current project', () => {
  const p = project();
  assert.equal(STATE_VERSION, 1);
  assert.deepEqual(recorded(p.db), { version: 1, rows: [[1, 'created at this version']] });
  assert.deepEqual(planMigrations(p.targets), { pending: [], newer: [], unreadable: [] });
  assert.equal(migrationGate(p.targets), null);
});

test('a migration runs once and is recorded: backed up first, the config edited in place (comments kept), the log at the new version', () => {
  const p = project();
  const next = nextVersion();
  const plan = planMigrations(p.targets, next);
  assert.deepEqual(plan.pending.map((x) => [x.kind, x.from, x.to, x.auto]), [['config', 1, 2, false], ['state', 1, 2, false]], 'notes.yaml has no version: not a migrated file');
  const r = applyMigrations(p.targets, { ...next, now: () => new Date('2026-10-12T03:00:00Z') });
  assert.equal(r.applied.length, 2);
  for (const b of r.backups) assert.ok(existsSync(b), b);
  assert.match(r.backups[0]!, /tests\.yaml\.bak-v1-2026-10-12T03-00-00-000Z$/);
  assert.equal(readFileSync(r.backups[0]!, 'utf8'), '# how the tests run\nversion: 1\nfull_cmd: "npm test" # the whole suite\n', 'the backup is the file as it was');
  const tests = readFileSync(join(p.root, BRAND.configDir, 'tests.yaml'), 'utf8');
  assert.match(tests, /^# how the tests run\nversion: 2\n/);
  assert.match(tests, /full: npm test/);
  assert.doesNotMatch(tests, /full_cmd/);
  assert.equal(readFileSync(join(p.root, BRAND.configDir, 'notes.yaml'), 'utf8'), 'not: versioned\n', 'an unversioned file is never touched');
  assert.deepEqual(recorded(p.db), { version: 2, rows: [[1, 'created at this version'], [2, 'version 2: a table of run summaries']] });
  assert.equal(recorded(r.backups[1]!).version, 1, 'the log backed up before the step');
  // Again: nothing pending, nothing runs a second time.
  assert.deepEqual(applyMigrations(p.targets, next).applied, []);
  assert.deepEqual(next.ran, { config: 1, state: 1 });
  // And the event log still opens and appends after the step.
  const log = new EventLog(p.db);
  log.append('emergency.resume', { instance: 'alice' }, 'test');
  log.close();
});

test('all or nothing: a failing step restores every file and log the run had migrated, and says so', () => {
  const p = project();
  const before = readFileSync(join(p.root, BRAND.configDir, 'tests.yaml'), 'utf8');
  const next = nextVersion();
  next.state[1] = { to: 2, what: 'version 2: fails', apply: () => { throw new Error('disk full'); } };
  assert.throws(() => applyMigrations(p.targets, next), (e: Error & { restored?: { path: string }[] }) => /disk full; every file migrated was restored from its backup/.test(e.message) && e.restored!.length === 2);
  assert.equal(readFileSync(join(p.root, BRAND.configDir, 'tests.yaml'), 'utf8'), before, 'the config migrated before the failure is back');
  assert.equal(recorded(p.db).version, 1);
});

test('an unmigrated config or log refuses start, saying to run migrate; a step marked auto is applied at start instead', () => {
  const p = project();
  const next = nextVersion();
  const why = migrationGate(p.targets, next)!;
  assert.match(why, /tests\.yaml: config version 1 -> 2 pending \(version 2: tests\.yaml full_cmd is now full\)/);
  assert.match(why, /events\.db: state version 1 -> 2 pending/);
  assert.match(why, new RegExp(`run \`${BRAND.cli} migrate\``));
  assert.equal(next.ran.config + next.ran.state, 0, 'the gate applies nothing that needs migrate');
  // A legacy log (no version at all, as every log before this change): its no-op version 1 is applied at start.
  const legacy = mkdtempSync(join(tmpdir(), 'mig-legacy-'));
  const db = new DatabaseSync(join(legacy, 'events.db'));
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL)');
  db.close();
  const t = { configFiles: [], eventsDb: join(legacy, 'events.db') };
  assert.deepEqual(planMigrations(t).pending.map((x) => [x.kind, x.from, x.to, x.auto]), [['state', 0, 1, true]]);
  assert.equal(migrationGate(t), null);
  assert.deepEqual(recorded(t.eventsDb), { version: 1, rows: [[1, 'version 1: the event log as the engine first kept it (no change)']] });
});

test('the coordinator refuses to start on a log newer than this engine, before loading anything', async () => {
  const state = mkdtempSync(join(tmpdir(), 'mig-state-'));
  process.env[`${BRAND.envPrefix}_PROJECT_STATE_DIR`] = state;
  try {
    const db = new DatabaseSync(join(state, 'events.db'));
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY)');
    db.exec('PRAGMA user_version = 99');
    db.close();
    const errors: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(' '));
    try {
      assert.equal(await runCoordinator(mkdtempSync(join(tmpdir(), 'mig-root-')), { once: true }), 1);
    } finally {
      console.error = err;
    }
    assert.match(errors.join('\n'), /coordinator not started: .*events\.db is at state version 99; this engine knows up to 1/);
    // doctor says the same.
    const m = doctor(mkdtempSync(join(tmpdir(), 'mig-root-'))).find((c) => c.name === 'migrations')!;
    assert.equal(m.level, 'fail');
    assert.match(m.detail, /state version 99[\s\S]*newer than this engine/);
  } finally {
    delete process.env[`${BRAND.envPrefix}_PROJECT_STATE_DIR`];
  }
});

test("an instance's targets: its own versioned files, its repo's config dir and its event log", () => {
  const home = mkdtempSync(join(tmpdir(), 'mig-inst-'));
  const repo = project();
  writeFileSync(join(home, 'instance.yaml'), `version: 1\nname: alice\nrepos:\n  - path: ${JSON.stringify(repo.root)}\n    repo: example-org/shop\n`);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 5 }\n');
  const t = instanceTargets(home);
  assert.deepEqual(t.configFiles.map((f) => f.split(/[\\/]/).pop()), ['instance.yaml', 'policy.yaml', 'notes.yaml', 'tests.yaml']);
  assert.equal(t.eventsDb, join(home, 'state', 'events.db'));
  assert.deepEqual(readdirSync(home).sort(), ['instance.yaml', 'policy.yaml'], 'reading the targets writes nothing');
});
