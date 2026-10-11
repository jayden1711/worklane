import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { healthView } from '../src/health.js';
import { loadOffsiteConfig, maybeOffsiteBackup, OffsiteConfig, offsiteBackup, offsiteLine, offsiteStatus, VARS } from '../src/offsite-backup.js';
import { buildReport } from '../src/reports.js';
import { repoRoot } from './helpers.js';

/** Stand-ins for the owner's tools: AES-256-GCM with a key file, and a directory as the remote. Run through the shell like real ones. */
function tools() {
  const dir = mkdtempSync(join(tmpdir(), 'offsite-tools-'));
  const remote = join(dir, 'remote');
  mkdirSync(remote);
  const key = join(dir, 'backup.key');
  writeFileSync(key, 'a key only the owner has');
  const script = join(dir, 'tool.cjs');
  writeFileSync(
    script,
    `const fs = require('node:fs'), c = require('node:crypto'), path = require('node:path');
const [, , mode, arg] = process.argv;
const IN = process.env[${JSON.stringify(VARS.in)}], OUT = process.env[${JSON.stringify(VARS.out)}], NAME = process.env[${JSON.stringify(VARS.name)}];
const k = () => c.createHash('sha256').update(fs.readFileSync(arg)).digest();
if (mode === 'enc') { const iv = c.randomBytes(12); const ci = c.createCipheriv('aes-256-gcm', k(), iv); const ct = Buffer.concat([ci.update(fs.readFileSync(IN)), ci.final()]); fs.writeFileSync(OUT, Buffer.concat([iv, ci.getAuthTag(), ct])); }
else if (mode === 'dec') { const b = fs.readFileSync(IN); const d = c.createDecipheriv('aes-256-gcm', k(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); fs.writeFileSync(OUT, Buffer.concat([d.update(b.subarray(28)), d.final()])); }
else if (mode === 'copy') fs.copyFileSync(IN, OUT);
else if (mode === 'put') fs.copyFileSync(IN, path.join(arg, NAME));
else if (mode === 'get') { const f = path.join(arg, NAME); if (fs.existsSync(f)) fs.copyFileSync(f, OUT); }
else if (mode === 'garbage') fs.writeFileSync(OUT, c.randomBytes(200));
else { process.stderr.write('boom: ' + mode); process.exit(3); }
`,
  );
  // Commands run in bash on every platform: forward slashes keep Windows paths intact inside its double quotes.
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  const cmd = (mode: string, arg = '') => `${q(process.execPath)} ${q(script)} ${mode}${arg ? ` ${q(arg)}` : ''}`;
  const config = (over: Partial<Record<'encrypt' | 'put' | 'get' | 'decrypt', string>> = {}) =>
    OffsiteConfig.parse({ version: 1, destination: 'test remote', encrypt: cmd('enc', key), put: cmd('put', remote), get: cmd('get', remote), decrypt: cmd('dec', key), ...over });
  return { dir, remote, key, cmd, config };
}

function logWithEvents() {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'offsite-log-')), 'events.db'));
  for (let i = 0; i < 5; i++) log.append('coordinator.started', { instance: 'secret-instance-name', pid: 100 + i, version: '0.0.0' }, 'test');
  return log;
}

test('an off-machine backup is encrypted before it leaves, and verified by fetching the remote copy back and decrypting it', async () => {
  const t = tools();
  const log = logWithEvents();
  const r = await offsiteBackup(log, t.config());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lastId, log.lastId());
  const sent = readdirSync(t.remote);
  assert.deepEqual(sent, [`${r.key}.enc`]);
  const bytes = readFileSync(join(t.remote, sent[0]!));
  assert.ok(!bytes.subarray(0, 15).equals(Buffer.from('SQLite format 3')), 'not a readable database');
  assert.ok(!bytes.includes(Buffer.from('secret-instance-name')), 'no event text in the remote copy');
  log.close();
});

test('an encrypt command that leaves the snapshot readable is refused, and nothing is sent', async () => {
  const t = tools();
  const log = logWithEvents();
  const r = await offsiteBackup(log, t.config({ encrypt: t.cmd('copy') }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /left the snapshot readable; nothing was sent/);
  assert.deepEqual(readdirSync(t.remote), []);
  log.close();
});

test('success needs the remote copy: a failed put, a missing copy or one that does not decrypt is a failure', async () => {
  const t = tools();
  const log = logWithEvents();
  const put = await offsiteBackup(log, t.config({ put: t.cmd('fail-put') }));
  assert.equal(put.ok, false);
  assert.match(put.error!, /put command exited 3: boom: fail-put/);
  const missing = await offsiteBackup(log, t.config({ get: t.cmd('get', join(t.dir, 'elsewhere')) }));
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /read-back found nothing/);
  const garbled = await offsiteBackup(log, t.config({ get: t.cmd('garbage') }));
  assert.equal(garbled.ok, false);
  assert.match(garbled.error!, /decrypt command exited/);
  log.close();
});

test('the service hook: none without a config, one attempt when due, recorded either way; a broken config alerts', async () => {
  const t = tools();
  const log = logWithEvents();
  const path = join(t.dir, 'offsite-backup.yaml');
  assert.equal(loadOffsiteConfig(path), null);
  assert.equal(await maybeOffsiteBackup(log, path, 'test'), null, 'not set up: nothing happens');
  assert.equal(log.read(0, ['backup.offsite']).length, 0);
  // JSON is YAML; the commands' quotes survive it.
  writeFileSync(path, JSON.stringify({ version: 1, destination: 'test remote', every_hours: 6, encrypt: t.cmd('enc', t.key), put: t.cmd('put', t.remote), get: t.cmd('get', t.remote), decrypt: t.cmd('dec', t.key) }), { mode: 0o600 });
  const now = new Date();
  const first = await maybeOffsiteBackup(log, path, 'test', now);
  assert.equal(first?.ok, true, first?.error);
  assert.equal(await maybeOffsiteBackup(log, path, 'test', new Date(now.getTime() + 3_600_000)), null, 'not due an hour later');
  const later = await maybeOffsiteBackup(log, path, 'test', new Date(now.getTime() + 7 * 3_600_000));
  assert.equal(later?.ok, true);
  assert.equal(log.read(0, ['backup.offsite']).length, 2);
  if (process.platform !== 'win32') {
    chmodSync(path, 0o664);
    const broken = await maybeOffsiteBackup(log, path, 'test', new Date(now.getTime() + 8 * 3_600_000));
    assert.equal(broken?.ok, false);
    assert.match(broken!.error!, /^config: .*writable by its group or others/);
  }
  writeFileSync(path, 'version: 2\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  assert.match((loadOffsiteConfig(path) as { error: string }).error, /version/);
  log.close();
});

let id = 0;
const T0 = Date.parse('2026-10-05T06:00:00Z');
const ev = (h: number, payload: object): StoredEvent => ({ id: ++id, ts: new Date(T0 + h * 3_600_000).toISOString(), type: 'backup.offsite' as never, actor: 'c', source: 'coordinator', payload: payload as never });
const ok = (h: number) => ev(h, { ok: true, destination: 'test remote', key: `events-${h}.db`, last_id: 9 });
const failed = (h: number) => ev(h, { ok: false, destination: 'test remote', key: `events-${h}.db`, last_id: 9, error: 'put command exited 1: network unreachable' });
const at = (h: number) => new Date(T0 + h * 3_600_000);

test('status, report line and health field: fresh, stale after a day (with the latest error), never verified, not set up', () => {
  assert.equal(offsiteStatus([]), null);
  assert.equal(offsiteLine(null), null);
  const fresh = offsiteStatus([ok(0)], at(2))!;
  assert.equal(fresh.stale, false);
  assert.equal(offsiteLine(fresh), '**Off-machine backup**: verified 2 h ago (test remote).');
  const stale = offsiteStatus([ok(0), failed(29)], at(30))!;
  assert.equal(stale.stale, true);
  assert.equal(stale.lastOkKey, 'events-0.db');
  assert.match(offsiteLine(stale)!, /^\*\*Off-machine backup is stale\*\*: the last verified copy is 30 h old; the latest attempt failed: put command exited 1: network unreachable\./);
  assert.match(offsiteLine(offsiteStatus([failed(0)], at(1)))!, /no copy has been verified yet/);
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  assert.match(buildReport([ok(0), failed(29)], cfg, { since: at(20), now: at(30), slot: '18:00', weekly: false }).markdown, /\*\*Off-machine backup is stale\*\*/);
  assert.doesNotMatch(buildReport([], cfg, { since: at(20), now: at(30), slot: '18:00', weekly: false }).markdown, /Off-machine/);
  const h = healthView([ok(0), failed(29)], null, { now: at(30) });
  assert.equal(h.offsiteBackup?.lastOkAt, new Date(T0).toISOString());
  assert.ok(h.suggestions.some((s) => s.startsWith('Off-machine backup is stale')));
  assert.equal(healthView([], null).offsiteBackup, null);
});
