import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, dirStore, type BackupStore } from '../src/events/backup.js';
import { EventLog } from '../src/events/log.js';
import { redactString } from '../src/events/redact.js';

const tmpLog = () => new EventLog(join(mkdtempSync(join(tmpdir(), 'ev-')), 'events.db'));
const seen = (issue: number) => ({ issue, title: 't', labels: [], author: 'a', owner: 'a', actionable: true, why: '' });

test('events are validated, typed and append-only at the database level', () => {
  const log = tmpLog();
  const e = log.append('issue.seen', seen(1), 'coordinator');
  assert.equal(e.id, 1);
  assert.throws(() => log.append('issue.seen', { issue: -1 } as never, 'x'), 'invalid payloads are rejected');
  assert.throws(() => log.db.exec('UPDATE events SET type = 1'), /append-only/);
  assert.throws(() => log.db.exec('DELETE FROM events'), /append-only/);
  assert.equal(log.read().length, 1);
});

test('payloads are redacted before they are stored', () => {
  const log = tmpLog();
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  log.append('run.finished', { issue: 1, role: 'worker', reason: 'failed', detail: `export GH_TOKEN=${token}; psql postgres://app:hunter2@db:5432/app` }, 'c');
  const raw = (log.db.prepare('SELECT payload FROM events').get() as { payload: string }).payload;
  assert.doesNotMatch(raw, new RegExp(token));
  assert.doesNotMatch(raw, /hunter2/);
  assert.match(raw, /postgres:\/\/app:\[REDACTED\]@db/);
  assert.equal(redactString('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'), 'Authorization: Bearer [REDACTED]');
});

test('backup succeeds only after a verified read-back', async () => {
  const log = tmpLog();
  for (let i = 1; i <= 5; i++) log.append('issue.seen', seen(i), 'c');
  const r = await backup(log, dirStore(mkdtempSync(join(tmpdir(), 'bk-'))));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lastId, 5);
});

test('regression: a store that accepts writes but keeps nothing is reported as a failed backup', async () => {
  const log = tmpLog();
  log.append('issue.seen', seen(1), 'c');
  const blackHole: BackupStore = { name: 'black-hole', async put() {}, async get() { return null; } };
  const r = await backup(log, blackHole);
  assert.equal(r.ok, false);
  assert.match(r.error!, /read-back found nothing/);
});

test('regression: a store that keeps a stale or corrupted copy is reported as a failed backup', async () => {
  const log = tmpLog();
  log.append('issue.seen', seen(1), 'c');
  let stale: Buffer | null = null;
  const staleStore: BackupStore = {
    name: 'stale',
    async put(_k, data) {
      stale ??= data; // keeps only the first copy ever written
    },
    async get() {
      return stale;
    },
  };
  assert.equal((await backup(log, staleStore)).ok, true);
  log.append('issue.seen', seen(2), 'c');
  const second = await backup(log, staleStore);
  assert.equal(second.ok, false);
  assert.match(second.error!, /checksum mismatch|holds events up to/);
  const corrupt: BackupStore = { name: 'corrupt', async put() {}, async get() { return Buffer.from('not a database'); } };
  assert.equal((await backup(log, corrupt)).ok, false);
});
