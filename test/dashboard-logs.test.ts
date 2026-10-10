import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { dashboardSite, readServiceLog, startDashboard, type JournalReader } from '../src/dashboard.js';
import { initInstance } from '../src/instance.js';
import { agentIsSelf, exampleProject, repoRoot } from './helpers.js';

const rec = (message: unknown, us: number, priority = '6') => JSON.stringify({ MESSAGE: message, PRIORITY: priority, __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: 'x.service' });

test('the service log comes from the unit\'s journal, read as this user, with secrets redacted', () => {
  const asked: [string, number][] = [];
  const read: JournalReader = (unit, lines) => {
    asked.push([unit, lines]);
    const token = `ghp_${'a'.repeat(36)}`;
    return { status: 0, stderr: '', stdout: [rec('tick: 0 dispatched', 1_700_000_000_000_000), rec(`push failed with ${token}`, 1_700_000_001_000_000, '3'), rec([104, 105], 1_700_000_002_000_000), 'not json'].join('\n') };
  };
  const log = readServiceLog({ unit: 'x.service', file: null }, 50, read);
  assert.deepEqual(asked, [['x.service', 50]]);
  assert.equal(log.source, 'journal');
  assert.equal(log.problem, null);
  assert.deepEqual(log.entries.map((e) => [e.priority, e.message]), [[6, 'tick: 0 dispatched'], [3, 'push failed with gh*_[REDACTED]'], [6, 'hi']]);
  assert.equal(log.entries[0]!.at, new Date(1_700_000_000_000).toISOString());
});

test('a journal this user can\'t read says why and how to fix it; a log file is read instead when there is one', () => {
  const empty: JournalReader = () => ({ status: 0, stdout: '', stderr: '' });
  const none = readServiceLog({ unit: 'x.service', file: null }, 50, empty);
  assert.equal(none.source, 'none');
  assert.match(none.problem!, /journal\.sh/);
  const missing: JournalReader = () => ({ status: null, stdout: '', stderr: 'spawnSync journalctl ENOENT' });
  const dir = mkdtempSync(join(tmpdir(), 'dash-logs-'));
  const file = join(dir, 'coordinator.log');
  writeFileSync(file, Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const fromFile = readServiceLog({ unit: 'x.service', file }, 3, missing);
  assert.equal(fromFile.source, 'file');
  assert.deepEqual(fromFile.entries.map((e) => e.message), ['line 2', 'line 3', 'line 4'], 'the last lines');
  assert.equal(fromFile.problem, null);
  const nothing = readServiceLog({ unit: null, file: join(dir, 'nope.log') });
  assert.equal(nothing.source, 'none');
  assert.ok(nothing.problem);
});

test('an instance\'s dashboard reads its own unit\'s journal and log file; the route serves it with the token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance('shop', repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\n');
  const site = dashboardSite(repo, 'shop', dir);
  assert.deepEqual(site.logs, { unit: `${BRAND.cli}-shop.service`, file: join(home, 'state', 'coordinator.log') });
  assert.equal(dashboardSite(repo).logs.unit, null, 'a checkout has no unit');
  const units: string[] = [];
  const d = await startDashboard({ root: repo, cfg: loadConfig(repo), eventsDb: site.eventsDb, stateDir: site.stateDir, user: 'example-owner', logs: site.logs, journalReader: (u) => (units.push(u), { status: 0, stderr: '', stdout: rec('started', 1_700_000_000_000_000) }) });
  try {
    const base = d.url.split('/?')[0]!;
    assert.equal((await fetch(`${base}/api/logs`)).status, 401);
    const r = (await (await fetch(`${base}/api/logs?lines=5000`, { headers: { authorization: `Bearer ${d.token}` } })).json()) as { source: string; entries: { message: string }[] };
    assert.equal(r.source, 'journal');
    assert.equal(r.entries[0]!.message, 'started');
    assert.deepEqual(units, [`${BRAND.cli}-shop.service`]);
  } finally {
    await d.close();
  }
});

test('the journal setup script keeps it on disk split per user, through a dotted temp file, and adds no one to a journal group', () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'journal.sh'), 'utf8');
  assert.match(sh, /Storage=persistent\\nSplitMode=uid/);
  assert.ok(sh.indexOf('> "$tmp"') < sh.indexOf('mv -f "$tmp" "$conf"'), 'written to the temp name, then moved into place');
  assert.match(sh, /tmp="\$dir\/\.50-/);
  assert.doesNotMatch(sh, /usermod|gpasswd|adduser/, 'no group memberships: adm and systemd-journal read every service\'s journal');
});
