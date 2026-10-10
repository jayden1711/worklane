import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tidyState } from '../src/state-tidy.js';

const posix = process.platform !== 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;

/** A state dir as an engine before the fix left it: 0644/0664 files, 0775 directories. */
function oldState() {
  const state = join(mkdtempSync(join(tmpdir(), 'inst-')), 'state');
  for (const d of ['backups', 'runs', 'tasks']) mkdirSync(join(state, d), { recursive: true });
  const files: Record<string, number> = {
    'events.db': 0o644,
    'worktrees.json': 0o664,
    'backups/events-2026-10-10T20-05-00-000Z-41.db': 0o644,
    'backups/events-2026-10-10T22-17-00-000Z-77.db': 0o664,
    'runs/run-1.json': 0o644,
    'tasks/issue-63.json': 0o664,
    'dashboard-token': 0o600,
  };
  for (const [f, m] of Object.entries(files)) {
    writeFileSync(join(state, f), '{}');
    if (posix) chmodSync(join(state, f), m);
  }
  if (posix) for (const d of ['', 'backups', 'runs', 'tasks']) chmodSync(join(state, d), 0o775);
  return state;
}

test('at start, everything under state/ is closed to others: backups, runs, old tasks, all of it', { skip: !posix && 'POSIX modes' }, () => {
  const state = oldState();
  const t = tidyState(state);
  for (const p of ['.', 'events.db', 'worktrees.json', 'backups', 'backups/events-2026-10-10T20-05-00-000Z-41.db', 'backups/events-2026-10-10T22-17-00-000Z-77.db', 'runs', 'runs/run-1.json', 'tasks', 'tasks/issue-63.json']) {
    assert.equal(statSync(join(state, p)).mode & 0o007, 0, `${p} is ${mode(join(state, p)).toString(8)}`);
  }
  assert.equal(mode(join(state, 'backups')), 0o770);
  assert.equal(mode(join(state, 'runs', 'run-1.json')), 0o660);
  assert.equal(mode(join(state, 'dashboard-token')), 0o600, 'a 0600 file stays 0600');
  assert.ok(t.tightened.includes('backups/events-2026-10-10T22-17-00-000Z-77.db'));
  assert.ok(t.tightened.includes('runs'));
  assert.ok(!t.tightened.includes('dashboard-token'));
  // Nothing left to do the second time.
  assert.deepEqual(tidyState(state).tightened, []);
});

test('symlinks under state/ are neither followed nor changed', { skip: !posix && 'POSIX modes' }, () => {
  const state = oldState();
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'f');
  writeFileSync(outside, 'x');
  chmodSync(outside, 0o644);
  symlinkSync(outside, join(state, 'link'));
  tidyState(state);
  assert.equal(mode(outside), 0o644, 'the file a link points to is left alone');
});

test('once task files live beside the checkout, the old state/tasks/ is removed (its issue-N.json files only)', () => {
  const state = oldState();
  const agentTasksDir = join(mkdtempSync(join(tmpdir(), 'srv-')), 'tasks');
  const t = tidyState(state, { agentTasksDir });
  assert.deepEqual(t.removedTasks, ['issue-63.json']);
  assert.ok(!existsSync(join(state, 'tasks')), 'the emptied directory goes too');
  // Something else in there is not ours to delete: kept, and so is the directory.
  const again = oldState();
  writeFileSync(join(again, 'tasks', 'notes.txt'), 'mine');
  tidyState(again, { agentTasksDir });
  assert.ok(existsSync(join(again, 'tasks', 'notes.txt')));
  assert.ok(!existsSync(join(again, 'tasks', 'issue-63.json')));
});

test('without separate users, state/tasks/ is where task files live: kept', () => {
  const state = oldState();
  const t = tidyState(state);
  assert.deepEqual(t.removedTasks, []);
  assert.ok(existsSync(join(state, 'tasks', 'issue-63.json')));
  // And a configured task dir that is state/tasks itself is never emptied.
  tidyState(state, { agentTasksDir: join(state, 'tasks') });
  assert.ok(existsSync(join(state, 'tasks', 'issue-63.json')));
});

test('the coordinator runs the pass at start, before it opens the log, and records what it did', async () => {
  const { readFileSync } = await import('node:fs');
  const { repoRoot } = await import('./helpers.js');
  const src = readFileSync(join(repoRoot, 'src', 'service.ts'), 'utf8');
  const run = src.slice(src.indexOf('async function runSite('));
  const tidy = run.indexOf('tidyState(state');
  assert.ok(tidy > 0 && tidy < run.indexOf('new EventLog('), 'tidyState runs before the log is opened');
  assert.ok(run.indexOf('tryLock(') < tidy, 'and only once this coordinator holds the lock');
  assert.match(run, /log\.append\('state\.tidied'/);
});
