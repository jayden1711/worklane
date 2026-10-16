import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { type AllowlistEntry, type McpRecord, type PluginRecord, allowlistPath, approvalDigest, canonicalJson, FETCHES_PER_HOUR, parseRoles, pendingPath, previewDir, readAllowlist, storeDir, type ApprovalRecord } from '../src/plugins/approval.js';
import { confirm, confirmPlan, ingest, previewPluginServer, readPreview, recordOf, remove, stage, takeFetchSlot, withdraw } from '../src/plugins/root-ops.js';
import { treeHash } from '../src/plugins/tree.js';
import { repoRoot } from './helpers.js';

const me = process.getuid!();
/** An approved plugin entry's tree (these tests approve plugins only). */
const treeOf = (e: AllowlistEntry) => (e.record as PluginRecord).tree;
const SOURCE = { type: 'git' as const, url: 'https://example.com/o/kit.git', sha: 'a'.repeat(40) };

/** A fetched plugin directory, ingested as a preview for instance `i`, id `id`. */
function previewed(i: string, id: string, extra: Record<string, string> = {}) {
  const from = mkdtempSync(join(tmpdir(), 'fetched-'));
  const files: Record<string, string> = { '.claude-plugin/plugin.json': JSON.stringify({ name: id, version: '1.0.0' }), 'skills/a/SKILL.md': '---\nname: a\ndescription: a\n---\nA.\n', ...extra };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(from, p)), { recursive: true });
    writeFileSync(join(from, p), c);
  }
  return ingest({ instance: i, id, source: SOURCE, from, approvedIds: new Set() });
}
const digestFor = (i: string, id: string, roles: string[]) => approvalDigest(recordOf(readPreview(i, id), roles));
const stageAndConfirm = (i: string, id: string, roles = ['builder']) => {
  const digest = digestFor(i, id, roles);
  stage({ instance: i, id, roles, digest, by: 'wl-x' });
  return { digest, list: confirm({ instance: i, id, digest, by: 'root', allowlistOwnerUid: me }) };
};

test('preview, stage and confirm: the store holds exactly the approved bytes and the allowlist the reviewed record', () => {
  const p = previewed('alpha', 'kit');
  assert.ok(p.materialized);
  const { digest, list } = stageAndConfirm('alpha', 'kit');
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0]!.digest, digest);
  const e = readAllowlist('alpha', { ownerUid: me }).entries[0]!;
  assert.equal(treeHash(storeDir('alpha', 'kit', treeOf(e))), treeOf(e));
  assert.deepEqual(e.record.roles, ['builder']);
  assert.equal(existsSync(pendingPath()) && JSON.parse(readFileSync(pendingPath(), 'utf8')).entries.some((x: { id: string; instance: string }) => x.id === 'kit' && x.instance === 'alpha'), false, 'confirmed: no longer pending');
});

test('stage refuses a digest that is not what the preview and roles make now (fail-without: staging any digest)', () => {
  previewed('beta', 'kit');
  const other = digestFor('beta', 'kit', ['reviewer']);
  assert.throws(() => stage({ instance: 'beta', id: 'kit', roles: ['builder'], digest: other, by: 'wl-x' }), /changed since the review/);
});

test('a plugin with refusals has no approvable record', () => {
  previewed('gamma', 'bad', { 'hooks/hooks.json': '{"hooks":{}}' });
  assert.throws(() => digestFor('gamma', 'bad', ['builder']), /refusals/);
});

test('confirm refuses when the previewed files change after staging (fail-without: confirm trusting preview.json)', () => {
  previewed('delta', 'kit');
  const digest = digestFor('delta', 'kit', ['builder']);
  stage({ instance: 'delta', id: 'kit', roles: ['builder'], digest, by: 'wl-x' });
  writeFileSync(join(previewDir('delta', 'kit'), 'tree', 'skills', 'a', 'SKILL.md'), 'swapped');
  assert.throws(() => confirm({ instance: 'delta', id: 'kit', digest, by: 'root', allowlistOwnerUid: me }), /changed after inspection/);
  assert.equal(existsSync(allowlistPath('delta')), false);
});

test('confirm refuses a digest other than the staged one, and anything not staged', () => {
  previewed('eps', 'kit');
  const digest = digestFor('eps', 'kit', ['builder']);
  assert.throws(() => confirmPlan({ instance: 'eps', id: 'kit', digest }), /nothing staged/);
  stage({ instance: 'eps', id: 'kit', roles: ['builder'], digest, by: 'wl-x' });
  assert.throws(() => confirmPlan({ instance: 'eps', id: 'kit', digest: `sha256:${'0'.repeat(64)}` }), /not sha256:0+: nothing confirmed/);
  assert.equal(withdraw({ instance: 'eps', id: 'kit', by: 'wl-x' }), true);
  assert.throws(() => confirmPlan({ instance: 'eps', id: 'kit', digest }), /nothing staged/);
});

test('a staged approval lapses after 24 hours', () => {
  previewed('zeta', 'kit');
  const digest = digestFor('zeta', 'kit', ['builder']);
  stage({ instance: 'zeta', id: 'kit', roles: ['builder'], digest, by: 'wl-x', now: Date.now() - 25 * 3_600_000 });
  assert.throws(() => confirmPlan({ instance: 'zeta', id: 'kit', digest }), /nothing staged/);
});

test('an update is a new approval: the old pin stays until the new one is confirmed, then is replaced', () => {
  previewed('eta', 'kit');
  const first = treeOf(stageAndConfirm('eta', 'kit').list.entries[0]!);
  previewed('eta', 'kit', { 'skills/a/SKILL.md': '---\nname: a\ndescription: a\n---\nA, newer.\n' });
  const digest = digestFor('eta', 'kit', ['builder']);
  stage({ instance: 'eta', id: 'kit', roles: ['builder'], digest, by: 'wl-x' });
  assert.equal(treeOf(readAllowlist('eta', { ownerUid: me }).entries[0]!), first, 'staging changes nothing approved');
  confirm({ instance: 'eta', id: 'kit', digest, by: 'root', allowlistOwnerUid: me });
  const after = readAllowlist('eta', { ownerUid: me }).entries;
  assert.equal(after.length, 1);
  assert.notEqual(treeOf(after[0]!), first);
});

test('remove only deletes the named entry', () => {
  previewed('theta', 'one');
  previewed('theta', 'two');
  stageAndConfirm('theta', 'one');
  stageAndConfirm('theta', 'two');
  assert.equal(remove({ instance: 'theta', id: 'one', by: 'wl-x', allowlistOwnerUid: me }), true);
  assert.deepEqual(readAllowlist('theta', { ownerUid: me }).entries.map((e) => e.record.id), ['two']);
  assert.equal(remove({ instance: 'theta', id: 'one', by: 'wl-x', allowlistOwnerUid: me }), false);
});

test('the allowlist fails closed: wrong owner, group-writable, another instance, a record that does not match its digest', () => {
  assert.deepEqual(readAllowlist('nothing', { ownerUid: me }).entries, [], 'no file: no plugins');
  previewed('iota', 'kit');
  stageAndConfirm('iota', 'kit');
  const f = allowlistPath('iota');
  assert.throws(() => readAllowlist('iota'), /isn't root's/);
  chmodSync(f, 0o664);
  assert.throws(() => readAllowlist('iota', { ownerUid: me }), /writable by its group/);
  chmodSync(f, 0o644);
  assert.throws(() => readAllowlist('kappa', { ownerUid: me, file: f }), /for instance iota/);
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  doc.entries[0].record.roles = ['builder', 'reviewer'];
  writeFileSync(f, JSON.stringify(doc));
  assert.throws(() => readAllowlist('iota', { ownerUid: me }), /digest doesn't match/);
});

test('fetches are capped per instance per hour', () => {
  const now = Date.now();
  for (let i = 0; i < FETCHES_PER_HOUR; i++) takeFetchSlot('lambda', now);
  assert.throws(() => takeFetchSlot('lambda', now), /at most/);
  takeFetchSlot('mu', now);
  takeFetchSlot('lambda', now + 3_600_001);
});

test('canonical JSON and roles are one text per value', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] }), '{"a":[{"c":"x","d":2}],"b":1}');
  assert.deepEqual(parseRoles('reviewer+builder+builder'), ['builder', 'reviewer']);
  assert.equal(parseRoles('builder;id'), null);
  const r = { v: 1 } as unknown as ApprovalRecord;
  assert.throws(() => approvalDigest(r));
});

test('only the root operations write the allowlist (fail-without: any other module building its path)', () => {
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
  const users = files(join(repoRoot, 'src')).filter((f) => /\ballowlistPath\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(repoRoot, f));
  assert.deepEqual(users.sort(), ['src/plugins/approval.ts', 'src/plugins/root-ops.ts']);
});

test('an MCP server in an approved plugin: previewed from the approved copy, staged with its hosts and secrets\' names, confirmed like any approval', () => {
  previewed('nu', 'kit', { '.mcp.json': JSON.stringify({ mcpServers: { notes: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.js'], env: { NOTES_TOKEN: '${NOTES_TOKEN}' } } } }), 's.js': '' });
  stageAndConfirm('nu', 'kit');
  const snapshot = { serverName: 'notes', instructions: null, tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } }] };
  const p = previewPluginServer({ instance: 'nu', id: 'kit-notes', plugin: 'kit', server: 'notes', snapshot: { snapshot, error: null, withSecrets: false, network: [] }, allowlistOwnerUid: me });
  assert.deepEqual(p.envNames, ['NOTES_TOKEN']);
  const mcp = { network: ['api.example.com'], secrets: ['NOTES_TOKEN'] };
  const digest = approvalDigest(recordOf(readPreview('nu', 'kit-notes'), ['builder'], mcp));
  // The hosts and secrets are part of what is approved: other ones are another digest.
  assert.throws(() => stage({ instance: 'nu', id: 'kit-notes', roles: ['builder'], digest, by: 'wl-x', mcp: { ...mcp, network: ['evil.example'] } }), /changed since the review/);
  stage({ instance: 'nu', id: 'kit-notes', roles: ['builder'], digest, by: 'wl-x', mcp });
  confirm({ instance: 'nu', id: 'kit-notes', digest, by: 'root', allowlistOwnerUid: me });
  const e = readAllowlist('nu', { ownerUid: me }).entries.find((x) => x.record.id === 'kit-notes')!.record as McpRecord;
  assert.deepEqual([e.kind, e.network, e.secrets, e.snapshot?.tools.map((t) => t.name)], ['mcp', ['api.example.com'], ['NOTES_TOKEN'], ['echo']]);
  // The plugin's MCP config never reaches Claude Code: the approved copy has none.
  assert.equal(existsSync(join(storeDir('nu', 'kit', treeOf(readAllowlist('nu', { ownerUid: me }).entries.find((x) => x.record.id === 'kit')!)), '.mcp.json')), false);
});

test('a snapshot taken with secrets is valid only for the network it was taken with', () => {
  previewed('xi', 'kit', { '.mcp.json': JSON.stringify({ mcpServers: { notes: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.js'] } } }), 's.js': '' });
  stageAndConfirm('xi', 'kit');
  const snapshot = { serverName: 'notes', instructions: null, tools: [] };
  previewPluginServer({ instance: 'xi', id: 'kit-notes', plugin: 'kit', server: 'notes', snapshot: { snapshot, error: null, withSecrets: true, network: ['api.example.com'] }, allowlistOwnerUid: me });
  assert.throws(() => recordOf(readPreview('xi', 'kit-notes'), ['builder'], { network: ['api.example.com', 'other.example'], secrets: [] }), /taken with network api\.example\.com/);
  assert.ok(recordOf(readPreview('xi', 'kit-notes'), ['builder'], { network: ['api.example.com'], secrets: [] }));
});
