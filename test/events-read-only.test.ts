// A read-only read of the events database waits out another connection's lock instead of failing. In WAL mode a reader
// still meets one: the last connection to close checkpoints and drops the WAL under an exclusive lock (any process's
// close, or a log the garbage collector closes). Without a wait the read threw "database is locked" and the dashboard
// answered 500 (a phone-layout run in CI saw /api/usage do it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { startDashboard } from '../src/dashboard.js';
import { readBaseline } from '../src/baseline.js';
import { loadConfig } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import { exampleProject, exampleRoles, repoRoot } from './helpers.js';

/**
 * Another process takes the database file's exclusive lock (with a write, as a closing connection's checkpoint does),
 * says so, and lets go after `ms`. Resolves once the lock is held; `done` once that process has exited.
 */
async function holdLock(path: string, ms: number): Promise<{ done: Promise<number | null> }> {
  const src = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO events (ts, type, actor, source, payload) VALUES ('${new Date().toISOString()}', 'run.started', 'coordinator', 'coordinator', '{\\"issue\\":4,\\"role\\":\\"worker\\",\\"model\\":\\"sonnet\\",\\"worktree\\":\\"/w\\",\\"pid\\":2,\\"pgid\\":2,\\"attempt\\":1}'); COMMIT;");
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

test("regression: /api/usage while another process holds the events database's lock waits for it and answers, never 500", async () => {
  const { dir, stateDir } = exampleProject();
  const eventsDb = join(mkdtempSync(join(tmpdir(), 'read-only-')), 'events.db');
  const log = new EventLog(eventsDb);
  log.append('run.started', { issue: 3, role: 'worker', model: 'sonnet', worktree: '/w', pid: 1, pgid: 1, attempt: 1 }, 'coordinator');
  log.close();
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'read-only-slots-')) });
  try {
    const held = await holdLock(eventsDb, 300);
    const res = await fetch(`${d.url.split('/?')[0]}/api/usage`, { headers: { authorization: `Bearer ${d.token}` } });
    const body = (await res.json()) as { error?: string; today?: { runs: number } };
    assert.equal(res.status, 200, `answered, not ${res.status} ${JSON.stringify(body)}`);
    assert.equal(body.today?.runs, 2, "today's runs, the held write's included: it waited for the lock to go");
    assert.equal(await held.done, 0);
  } finally {
    await d.close();
  }
});

test('regression: a hook reading the baseline while another process holds the lock waits for it', async () => {
  const eventsDb = join(mkdtempSync(join(tmpdir(), 'read-only-')), 'events.db');
  const log = new EventLog(eventsDb);
  log.append('baseline.recorded', { sha: 'abc1234', failing: ['test/a.test.ts'] }, 'coordinator');
  log.close();
  const held = await holdLock(eventsDb, 300);
  assert.equal(readBaseline(eventsDb)?.sha, 'abc1234');
  assert.equal(await held.done, 0);
});

test('an events database is opened read-only only through openReadOnly (src/events/read-only.ts), which waits on a lock', () => {
  const src = join(repoRoot, 'src');
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const found = files(src)
    .filter((f) => relative(src, f) !== join('events', 'read-only.ts'))
    .filter((f) => /new DatabaseSync\([^)]*readOnly/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(repoRoot, f));
  assert.deepEqual(found, [], 'open it with openReadOnly instead');
});
