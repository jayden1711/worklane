import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { docsUrl, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { exampleProject, repoRoot } from './helpers.js';

const calm = { at: new Date().toISOString(), platform: 'linux', memory: null, load: null, units: null, disks: [], unavailable: [] };

async function health(append: (log: EventLog) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-offsite-'));
  const log = new EventLog(join(dir, 'events.db'));
  append(log);
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', slotsDir: join(dir, 'slots'), machineStats: () => calm });
  try {
    const r = await fetch(`${d.url.split('/?')[0]}/api/health`, { headers: { authorization: `Bearer ${d.token}` } });
    return (await r.json()) as { offsiteBackup: { destination: string; lastOkAt: string | null; lastOkKey: string | null; lastError: string | null; stale: boolean } | null; docs: { backups: string | null } };
  } finally {
    await d.close();
  }
}

test('the health view carries the off-machine backup for the panel: null when never set up; the last verified copy; stale with the latest error', async () => {
  const none = await health(() => {});
  assert.equal(none.offsiteBackup, null, 'never set up');
  const ok = await health((log) => log.append('backup.offsite', { ok: true, destination: 'rclone remote', key: 'events-1.db.age', last_id: 1 }, 'c'));
  assert.equal(ok.offsiteBackup?.destination, 'rclone remote');
  assert.equal(ok.offsiteBackup?.lastOkKey, 'events-1.db.age');
  assert.equal(ok.offsiteBackup?.stale, false);
  const failing = await health((log) => log.append('backup.offsite', { ok: false, destination: 'rclone remote', key: 'events-2.db.age', last_id: 2, error: 'put exited 1: remote unreachable' }, 'c'));
  assert.equal(failing.offsiteBackup?.lastOkAt, null);
  assert.equal(failing.offsiteBackup?.stale, true, 'never verified is stale');
  assert.match(String(failing.offsiteBackup?.lastError), /remote unreachable/);
});

test('the docs link comes from the package\'s repository, not a hardcoded host', async () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { repository: { url: string } };
  const base = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  assert.equal((await health(() => {})).docs.backups, `${base}/blob/main/docs/backups.md`, 'served with the health view');
  assert.equal(docsUrl('backups', { url: 'git+https://example.org/acme/engine.git' }), 'https://example.org/acme/engine/blob/main/docs/backups.md');
  assert.equal(docsUrl('backups', 'https://example.org/acme/engine'), 'https://example.org/acme/engine/blob/main/docs/backups.md');
  assert.equal(docsUrl('backups', { url: 'git@example.com:acme/engine.git' }), null, 'only an https repository makes a link');
  assert.equal(docsUrl('backups', null), null);
});
