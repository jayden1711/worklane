import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RunRecorder, readRun } from '../src/run-record.js';
import { approvalDigest, readAllowlist, type AllowlistEntry, type McpRecord } from '../src/plugins/approval.js';
import { cachedUpdates, checkUpdates, githubRepoOfUrl, previewDiff, UPDATES_FILE } from '../src/plugins/updates.js';
import { confirm, ingest, readPreview, recordOf, stage } from '../src/plugins/root-ops.js';

const me = process.getuid!();
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

function approvedPlugin(instance: string, files: Record<string, string>): AllowlistEntry {
  const from = mkdtempSync(join(tmpdir(), 'fetched-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(from, p)), { recursive: true });
    writeFileSync(join(from, p), c);
  }
  ingest({ instance, id: 'kit', source: { type: 'git', url: 'https://github.com/o/kit.git', sha: SHA1, path: 'plugins/kit' }, from, approvedIds: new Set() });
  const d = approvalDigest(recordOf(readPreview(instance, 'kit'), ['builder']));
  stage({ instance, id: 'kit', roles: ['builder'], digest: d, by: 'wl-x' });
  confirm({ instance, id: 'kit', digest: d, by: 'root', allowlistOwnerUid: me });
  return readAllowlist(instance, { ownerUid: me }).entries[0]!;
}
const npmEntry = (version: string): AllowlistEntry => {
  const record: McpRecord = { v: 1, kind: 'mcp', instance: 'u', id: 'notes', runtime: { type: 'npm', package: '@scope/notes', version, integrity: 'sha512-AA==', lockfile: `sha256:${'0'.repeat(64)}`, tree: `wl-tree-v1:sha256:${'0'.repeat(64)}`, argv: ['node'] }, secrets: [], network: [], snapshot: null, snapshotHash: null, snapshotWithSecrets: false, flags: [], roles: ['builder'] };
  return { record, digest: approvalDigest(record), staged_at: 'x', staged_by: 'y', confirmed_at: 'z' };
};

test('the update check offers what is newer upstream, never installs, and asks only public read-only endpoints', async () => {
  const kit = approvedPlugin('ua', { '.claude-plugin/plugin.json': '{"name":"kit"}', 'skills/a/SKILL.md': 'A' });
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    asked.push(url);
    if (url.includes('/repos/o/kit/commits')) return [{ sha: SHA2 }];
    if (url.includes('registry.npmjs.org')) return { 'dist-tags': { latest: '2.0.0' } };
    throw new Error('no');
  };
  const ups = await checkUpdates([kit, npmEntry('1.0.0')], fetchJson);
  assert.deepEqual(ups.map((u) => [u.id, u.from, u.to]), [['kit', SHA1, SHA2], ['notes', '1.0.0', '2.0.0']]);
  assert.deepEqual(ups[0]!.fetch, { kind: 'plugin', id: 'kit', url: 'https://github.com/o/kit.git', sha: SHA2, path: 'plugins/kit' });
  assert.deepEqual(asked, ['https://api.github.com/repos/o/kit/commits?per_page=1&path=plugins%2Fkit', 'https://registry.npmjs.org/@scope%2fnotes']);
  assert.equal(readAllowlist('ua', { ownerUid: me }).entries[0]!.digest, kit.digest, 'nothing approved changed');
  // Up to date: nothing offered. Not github.com: not asked.
  assert.deepEqual(await checkUpdates([npmEntry('2.0.0')], fetchJson), []);
  assert.equal(githubRepoOfUrl('https://gitlab.com/o/kit.git'), null);
});

test('the cached list is refreshed at most daily, and an update approved since is no longer offered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  const e = npmEntry('1.0.0');
  let calls = 0;
  const fetchJson = async () => (calls++, { 'dist-tags': { latest: '2.0.0' } });
  assert.deepEqual(cachedUpdates(dir, [e], { fetchJson }).updates, []);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(dir, UPDATES_FILE)));
  assert.deepEqual(cachedUpdates(dir, [e], { fetchJson }).updates.map((u) => u.to), ['2.0.0']);
  assert.equal(calls, 1, 'not asked again within the day');
  assert.deepEqual(cachedUpdates(dir, [npmEntry('2.0.0')], { fetchJson }).updates, [], 'approved since');
});

test('an update\'s preview lists the files that differ from the approved copy', () => {
  const kit = approvedPlugin('ub', { '.claude-plugin/plugin.json': '{"name":"kit"}', 'skills/a/SKILL.md': 'A', 'skills/b/SKILL.md': 'B' });
  const from = mkdtempSync(join(tmpdir(), 'fetched-'));
  for (const [p, c] of Object.entries({ '.claude-plugin/plugin.json': '{"name":"kit"}', 'skills/a/SKILL.md': 'A, changed', 'skills/c/SKILL.md': 'C' })) {
    mkdirSync(dirname(join(from, p)), { recursive: true });
    writeFileSync(join(from, p), c);
  }
  ingest({ instance: 'ub', id: 'kit', source: { type: 'git', url: 'https://github.com/o/kit.git', sha: SHA2 }, from, approvedIds: new Set() });
  assert.deepEqual(previewDiff('ub', readPreview('ub', 'kit'), kit), { added: ['skills/c/SKILL.md'], removed: ['skills/b/SKILL.md'], changed: ['skills/a/SKILL.md'] });
});

test('a run record keeps what the session loaded beyond Claude Code (its init event), never the built-ins', () => {
  const state = mkdtempSync(join(tmpdir(), 'runs-'));
  const r = new RunRecorder(state, { role: 'builder', model: 'm', cwd: '/w' });
  r.line({ type: 'system', subtype: 'init', plugins: [{ name: 'kit', path: '/store/kit' }, { name: 'cc-plugin-telemetry', path: 'builtin' }], mcp_servers: [{ name: 'notes', status: 'connected' }] });
  const file = r.finish({ reason: 'succeeded', costUsd: 0, turns: 1, model: 'm' })!;
  assert.deepEqual(readRun(state, r.id)?.loaded, { plugins: ['kit'], mcpServers: ['notes'] });
  assert.doesNotMatch(readFileSync(file, 'utf8'), /cc-plugin-telemetry/);
});
