// The owner's conditions on #527's sudoers lines: (1) npm registries are root's allowlist; (2) unapproved server code
// runs as a throwaway identity with no network, no secrets and nothing writable the broker reads; (3) snapshot and
// preview runs are rate-capped (that one is in plugin-approval.test.ts, next to the fetch cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockResolvedProblem, readMcpRegistries } from '../src/plugins/hosts.js';
import { parseSnapshotOutput, snapshotJob, THROWAWAY_PROPERTIES, throwawayCommand } from '../src/mcp/throwaway.js';
import { repoRoot } from './helpers.js';

const helper = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as {
  parsePlugin: (a: string[], hosts?: string[], registries?: string[]) => Record<string, string> | null;
  mcpRegistries: (file: string, uid: number) => string[];
};
const me = process.getuid!();
const NPMJS = ['registry.npmjs.org'];

test('(1) mcp-fetch only from root\'s registries: absent means registry.npmjs.org alone; another registry, or a list root doesn\'t own alone, is refused (helper and engine)', () => {
  const d = mkdtempSync(join(tmpdir(), 'regs-'));
  const f = join(d, 'mcp-registries.json');
  assert.deepEqual(helper.mcpRegistries(f, me), NPMJS);
  assert.deepEqual(readMcpRegistries(f, me).registries, NPMJS);
  writeFileSync(f, JSON.stringify({ registries: ['npm.example.org'] }));
  chmodSync(f, 0o644);
  assert.deepEqual(helper.mcpRegistries(f, me), ['npm.example.org']);
  assert.deepEqual(helper.mcpRegistries(f, me + 1), []);
  assert.deepEqual(readMcpRegistries(f, me + 1).registries, []);
  chmodSync(f, 0o666);
  assert.deepEqual(helper.mcpRegistries(f, me), []);
  // Fail-without: the helper's registry check.
  assert.deepEqual(helper.parsePlugin(['mcp-fetch', 'notes', '@scope/notes', '1.2.3'], [], NPMJS), { action: 'mcp-fetch', id: 'notes', pkg: '@scope/notes', version: '1.2.3', registry: 'registry.npmjs.org' });
  assert.equal(helper.parsePlugin(['mcp-fetch', 'notes', '@scope/notes', '1.2.3', 'npm.evil.example'], [], NPMJS), null);
  assert.equal(helper.parsePlugin(['mcp-fetch', 'notes', '@scope/notes', '1.2.3'], [], []), null, 'no registry allowed: none');
});

test('(1) every package the lockfile names must come from the registry: another host, a git source, a link or plain http is refused', () => {
  const lock = (resolved: Record<string, object>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...resolved } });
  const ok = { 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' } };
  assert.equal(lockResolvedProblem(lock(ok), 'registry.npmjs.org'), null);
  for (const bad of [
    { 'node_modules/b': { resolved: 'https://evil.example/b-1.0.0.tgz' } },
    { 'node_modules/b': { resolved: 'git+ssh://git@github.com/o/b.git#abc' } },
    { 'node_modules/b': { resolved: 'http://registry.npmjs.org/b/-/b-1.0.0.tgz' } },
    { 'node_modules/b': { resolved: 'https://registry.npmjs.org.evil.example/b.tgz' } },
    { 'node_modules/b': { link: true, resolved: '../b' } },
    { 'node_modules/b': { version: '1.0.0' } },
  ]) assert.notEqual(lockResolvedProblem(lock({ ...ok, ...bad }), 'registry.npmjs.org'), null, JSON.stringify(bad));
});

test('(2) an unapproved server\'s snapshot runs as a throwaway user: no network, homes hidden, the system read-only, its code read-only, never the broker\'s user', () => {
  const cmd = throwawayCommand({ node: '/usr/local/bin/node', engineCli: '/opt/e/dist/src/cli.js', runtime: { type: 'plugin', plugin: 'kit', tree: `wl-tree-v1:sha256:${'0'.repeat(64)}`, server: 'notes', argv: ['node', '${CLAUDE_PLUGIN_ROOT}/server.js'] }, codeDir: '/var/lib/x/store/kit/abc', unit: 'u' });
  const props = cmd.flatMap((x, i) => (cmd[i - 1] === '--property' ? [x] : []));
  for (const p of ['DynamicUser=yes', 'PrivateNetwork=yes', 'ProtectHome=yes', 'ProtectSystem=strict', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'ReadOnlyPaths=/var/lib/x/store/kit/abc']) assert.ok(props.includes(p), p);
  assert.ok(!props.some((p) => /^(User|Group|SupplementaryGroups)=/.test(p)), 'never a named user (the broker\'s, or anyone\'s)');
  assert.ok(!props.some((p) => /^Environment=.*(SECRET|TOKEN|KEY)/i.test(p)), 'no secret in its environment');
  assert.deepEqual([...THROWAWAY_PROPERTIES].filter((p) => p.startsWith('RestrictAddressFamilies')), ['RestrictAddressFamilies=AF_UNIX']);
});

test('(2) root reads the throwaway run\'s output as data: a snapshot that fits the schema, or an error; nothing else', () => {
  const snap = { serverName: 's', instructions: null, tools: [{ name: 't', inputSchema: {} }] };
  assert.deepEqual(parseSnapshotOutput(`noise\n${JSON.stringify({ snapshot: snap })}\n`, 0).snapshot, snap);
  assert.match(parseSnapshotOutput(JSON.stringify({ snapshot: { tools: 'rm -rf /' } }), 0).error ?? '', /not a snapshot/);
  assert.match(parseSnapshotOutput('', 1, 'boom').error ?? '', /printed no result/);
  assert.equal(parseSnapshotOutput(JSON.stringify({ error: 'x' }), 0).error, 'x');
});

test('(2) the snapshot job starts the server from its code and prints its tools as one line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-'));
  writeFileSync(
    join(dir, 'server.js'),
    `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
     if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'s'}}})+'\\n');
     else if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}}]}})+'\\n');}});`,
  );
  const out = JSON.parse(await snapshotJob(dir, [process.execPath, '${CLAUDE_PLUGIN_ROOT}/server.js'])) as { snapshot: { tools: { name: string }[] } };
  assert.deepEqual(out.snapshot.tools.map((t) => t.name), ['echo']);
});

test('(2) a server that dies at start: the snapshot job says why, with its last stderr lines or the spawn error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-'));
  writeFileSync(join(dir, 'server.js'), `process.stderr.write('Error: Cannot find module x\\n'); process.exit(1);`);
  const died = JSON.parse(await snapshotJob(dir, [process.execPath, '${CLAUDE_PLUGIN_ROOT}/server.js'])) as { error: string };
  assert.match(died.error, /Cannot find module x/);
  const missing = JSON.parse(await snapshotJob(dir, [join(dir, 'no-such-command')])) as { error: string };
  assert.match(missing.error, /ENOENT/);
});
