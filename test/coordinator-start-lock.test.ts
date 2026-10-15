// The local coordinator's service starts while the dashboard is writing the event log. The first-run page's Start runs
// `systemctl --user enable --now` and then writes its audit event; that write's close is the last connection to the
// log, so it checkpoints and drops the WAL under an exclusive lock, at the moment the new coordinator opens the log.
// The coordinator must wait that lock out, never exit 2 with "database is locked" (the wizard's real-systemd run saw
// the unit exit 2 at once after "Started", and systemd's restart left it 'activating').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { BRAND } from '../src/brand.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { childEnv } from '../src/os/index.js';
import { exampleProject, repoRoot } from './helpers.js';

/** Another process takes the log's exclusive lock (with a write, as a closing connection's checkpoint does) and holds it `ms`. */
async function holdLock(path: string, ms: number): Promise<{ done: Promise<number | null> }> {
  const src = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock_holder (x); INSERT INTO lock_holder VALUES (1); COMMIT;");
    process.stdout.write('locked\\n');
    setTimeout(() => db.close(), ${ms});
  `;
  const c = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise<number | null>((r) => c.once('exit', r));
  await new Promise<void>((resolve, reject) => {
    c.stdout.once('data', () => resolve());
    c.once('exit', (code) => reject(new Error(`the lock holder exited (${code}) before taking the lock`)));
  });
  return { done };
}

const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stderr: string }>((res) => {
    const p = spawn(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += String(d)));
    p.on('exit', (status) => res({ status, stderr }));
  });

test("regression: the local coordinator's start waits out another process's lock on the event log, never exits 2 'database is locked'", async () => {
  const { dir } = exampleProject();
  // A file backlog: this start never asks GitHub for anything.
  const cfg = join(dir, BRAND.configDir, 'config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^backlog: github/m, 'backlog: file'));
  const state = mkdtempSync(join(tmpdir(), 'coord-lock-'));
  const env = childEnv({ [`${BRAND.envPrefix}_STATE_DIR`]: state });
  // Its state dir from its root, as a service's coordinator finds it: no agent run's inherited one.
  delete env[`${BRAND.envPrefix}_PROJECT_STATE_DIR`];
  // The log as the dashboard left it (setup mode made it), where the coordinator finds it under this state dir.
  const inherited = process.env[`${BRAND.envPrefix}_PROJECT_STATE_DIR`];
  delete process.env[`${BRAND.envPrefix}_PROJECT_STATE_DIR`];
  const key = basename(projectStateDir(dir));
  if (inherited !== undefined) process.env[`${BRAND.envPrefix}_PROJECT_STATE_DIR`] = inherited;
  const db = join(state, 'projects', key, 'events.db');
  new EventLog(db).close();
  const held = await holdLock(db, 700);
  const r = await run(['coordinator', 'run', '--root', dir, '--once'], env);
  assert.equal(await held.done, 0);
  assert.doesNotMatch(r.stderr, /database is locked/, r.stderr);
  assert.equal(r.status, 0, r.stderr);
});

test("regression: opening the event log for writing waits out another process's lock; journal_mode no longer runs before the wait is set", async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'coord-lock-')), 'events.db');
  new EventLog(db).close();
  const held = await holdLock(db, 300);
  const log = new EventLog(db);
  try {
    log.append('run.started', { issue: 1, role: 'worker', model: 'sonnet', worktree: '/w', pid: 1, pgid: 1, attempt: 1 }, 'coordinator');
    assert.equal(log.read().length, 1);
  } finally {
    log.close();
  }
  assert.equal(await held.done, 0);
});

test('an events database is opened only through openWaiting (src/events/open.ts) or openReadOnly, which set the lock wait first', () => {
  const src = join(repoRoot, 'src');
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const allowed = [join('events', 'open.ts'), join('events', 'read-only.ts')];
  const found = files(src)
    .filter((f) => !allowed.includes(relative(src, f)))
    .filter((f) => /new DatabaseSync\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(repoRoot, f));
  assert.deepEqual(found, [], 'open it with openWaiting (or openReadOnly) instead');
});
