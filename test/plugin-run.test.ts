import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allowlistPath, approvalDigest, emptyPluginRoot, storeDir, type AllowlistEntry, type ApprovalRecord, type PluginRecord } from '../src/plugins/approval.js';
import { loadedSetProblem, pluginsForRun, PluginRunError, PLUGINS_OFF_FILE } from '../src/plugins/run.js';
import { treeHash } from '../src/plugins/tree.js';
import { childEnv } from '../src/os/index.js';
import { cliArgs, CliRunner, PLUGIN_LOCKS } from '../src/runner.js';
import { STDIN_LINE } from './helpers.js';

const isWindows = process.platform === 'win32';
const treeOf = (e: AllowlistEntry) => (e.record as PluginRecord).tree;

/** An approved plugin `id` for `instance`, its copy in the store, and its allowlist entry. */
function approved(instance: string, id: string, roles: string[]): AllowlistEntry {
  const tmp = mkdtempSync(join(tmpdir(), 'store-src-'));
  mkdirSync(join(tmp, 'skills', 'a'), { recursive: true });
  writeFileSync(join(tmp, 'skills', 'a', 'SKILL.md'), `---\nname: a\ndescription: ${id}\n---\nA.\n`);
  const tree = treeHash(tmp);
  const dir = storeDir(instance, id, tree);
  mkdirSync(join(dir, 'skills', 'a'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'a', 'SKILL.md'), readFileSync(join(tmp, 'skills', 'a', 'SKILL.md')));
  const record: ApprovalRecord = {
    v: 1, kind: 'plugin', instance, id, source: { type: 'git', url: 'https://example.com/o/r.git', sha: 'a'.repeat(40) }, name: id, version: null,
    fetchedTree: tree, tree, transform: [], components: { skills: ['a'], agents: [], commands: [], outputStyles: [], bin: [] }, mcpServers: [], options: [], flags: [], roles,
  };
  return { record, digest: approvalDigest(record), staged_at: 'x', staged_by: 'wl-x', confirmed_at: 'y' };
}
const home = () => mkdtempSync(join(tmpdir(), 'inst-home-'));

test('a run gets the approved plugins for its role only, from root\'s store, minus what the owner switched off', () => {
  const a = approved('one', 'kit', ['builder']);
  const b = approved('one', 'docs', ['builder', 'reviewer']);
  const h = home();
  assert.deepEqual(pluginsForRun({ instance: 'one', instanceHome: h, role: 'builder', entries: [a, b] }).ids, ['kit', 'docs']);
  assert.deepEqual(pluginsForRun({ instance: 'one', instanceHome: h, role: 'reviewer', entries: [a, b] }).ids, ['docs']);
  assert.deepEqual(pluginsForRun({ instance: 'one', instanceHome: h, role: 'planner', entries: [a, b] }).ids, []);
  writeFileSync(join(h, PLUGINS_OFF_FILE), 'off: [docs]\n');
  const r = pluginsForRun({ instance: 'one', instanceHome: h, role: 'builder', entries: [a, b] });
  assert.deepEqual(r.ids, ['kit']);
  assert.deepEqual(r.dirs, [storeDir('one', 'kit', treeOf(a))]);
});

test('an unreadable switch-off list switches every plugin off (it can only take away)', () => {
  const a = approved('two', 'kit', ['builder']);
  const h = home();
  writeFileSync(join(h, PLUGINS_OFF_FILE), 'off: "kit"\n');
  assert.deepEqual(pluginsForRun({ instance: 'two', instanceHome: h, role: 'builder', entries: [a] }).ids, []);
});

test('a run never starts on an approved copy that changed on disk (fail-without: trusting the store unchecked)', () => {
  const a = approved('three', 'kit', ['builder']);
  writeFileSync(join(storeDir('three', 'kit', treeOf(a)), 'skills', 'a', 'extra.md'), 'added later');
  assert.throws(() => pluginsForRun({ instance: 'three', instanceHome: home(), role: 'builder', entries: [a] }), PluginRunError);
});

test('an allowlist that can\'t be trusted refuses the run instead of meaning "no plugins"', () => {
  // One this user wrote, where root's should be: not root's, so no run of the instance starts (readAllowlist's own
  // cases are in plugin-approval.test.ts).
  mkdirSync(dirname(allowlistPath('six')), { recursive: true });
  writeFileSync(allowlistPath('six'), JSON.stringify({ version: 1, instance: 'six', entries: [] }));
  assert.throws(() => pluginsForRun({ instance: 'six', instanceHome: home(), role: 'builder' }), /plugins: .* isn't root's/);
});

test('the loaded-set check: only what the run passed, plus Claude Code\'s own built-ins', () => {
  const want = { pluginDirs: ['/store/kit'], mcpServers: [] };
  assert.equal(loadedSetProblem({ plugins: [{ path: '/store/kit', source: 'kit@inline' }, { path: 'builtin', source: 'cc-plugin-telemetry@builtin' }], mcp_servers: [] }, want), null);
  assert.match(loadedSetProblem({ plugins: [{ path: '/store/kit' }, { path: '/home/user/.claude/plugins/cache/m/p/1', source: 'p@m' }] }, want) ?? '', /plugin p@m/);
  assert.match(loadedSetProblem({ plugins: [] }, want) ?? '', /did not load/);
  assert.match(loadedSetProblem({ plugins: [{ path: '/store/kit' }], mcp_servers: [{ name: 'plugin:x:y', source: 'plugin' }] }, want) ?? '', /MCP server plugin:x:y/);
});

test('cliArgs passes one --plugin-dir per approved directory and nothing else', () => {
  const req = { prompt: 'p', model: 'm', cwd: '/', allowedTools: ['Read'], maxTurns: 1, maxBudgetUsd: 1, stallMs: 1, timeoutMs: 1, role: 'builder' };
  const a = cliArgs(req, undefined, undefined, ['/s/a', '/s/b']);
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--plugin-dir'), ['/s/a', '/s/b']);
  assert.equal(cliArgs(req).includes('--plugin-dir'), false);
});

/** A stand-in claude that records its argv, env and --settings, and prints an init event listing `loaded` plugins. */
function fakeClaude(loaded: (args: string[]) => { path: string; source: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const log = join(dir, 'seen.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const i = args.indexOf('--settings');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, settings: i >= 0 ? JSON.parse(args[i + 1]) : null, pluginRoot: process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? null }));
const loaded = (${loaded.toString()})(args);
console.log(JSON.stringify({ type: 'system', subtype: 'init', plugins: loaded, mcp_servers: [] }));
setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 })), 300);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, seen: () => (existsSync(log) ? (JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; settings: Record<string, unknown> | null; pluginRoot: string | null }) : null) };
}
const req = (cwd: string) => ({ prompt: 'p', model: 'm', cwd, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000, role: 'builder' });

test('acceptance: an instance run gets its plugins, the empty plugin root and the locks; anything else loaded stops it', { skip: isWindows && 'POSIX stand-in claude' }, async () => {
  const a = approved('five', 'kit', ['builder']);
  mkdirSync(emptyPluginRoot('five'), { recursive: true });
  const plugins = ({ role }: { role: string }) => pluginsForRun({ instance: 'five', instanceHome: home(), role, entries: [a] });
  const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
  const passed = (args: string[]) => args.flatMap((x, i) => (args[i - 1] === '--plugin-dir' ? [{ path: x, source: 'kit@inline' }] : []));
  let c = fakeClaude(passed);
  let r = await new CliRunner('cli', childEnv(), c.bin, undefined, undefined, undefined, {}, undefined, undefined, undefined, plugins).run(req(cwd));
  assert.equal(r.reason, 'succeeded', r.detail);
  const seen = c.seen()!;
  assert.deepEqual(seen.args.filter((x, i) => seen.args[i - 1] === '--plugin-dir'), [storeDir('five', 'kit', treeOf(a))]);
  assert.equal(seen.pluginRoot, emptyPluginRoot('five'));
  for (const [k, v] of Object.entries(PLUGIN_LOCKS)) assert.deepEqual(seen.settings![k], v, k);

  // Something the run didn't pass shows in the init event (fail-without: the init check): the run is stopped.
  c = fakeClaude((args) => [...((a2) => a2.flatMap((x, i) => (a2[i - 1] === '--plugin-dir' ? [{ path: x, source: 'kit@inline' }] : [])))(args), { path: '/home/user/.claude/plugins/cache/m/evil/1', source: 'evil@m' }]);
  r = await new CliRunner('cli', childEnv(), c.bin, undefined, undefined, undefined, {}, undefined, undefined, undefined, plugins).run(req(cwd));
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /loaded what the run didn't pass: plugin evil@m/);

  // A tampered copy: claude never starts.
  writeFileSync(join(storeDir('five', 'kit', treeOf(a)), 'x.md'), 'later');
  c = fakeClaude(passed);
  r = await new CliRunner('cli', childEnv(), c.bin, undefined, undefined, undefined, {}, undefined, undefined, undefined, plugins).run(req(cwd));
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /changed on disk[\s\S]*not starting/);
  assert.equal(c.seen(), null, 'claude never ran');
});

test('acceptance: a run with approved MCP servers gets the connector config, their exact tool names, the lock admitting only the connector, and its ticket ended', { skip: isWindows && 'POSIX stand-in claude' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
  const ended: string[] = [];
  const mcp = {
    instance: 'six',
    register: async (role: string) => (role === 'builder' ? { ticket: 'e'.repeat(64), servers: [{ id: 'notes', tools: ['echo'] }] } : null),
    end: async (t: string) => void ended.push(t),
  };
  // The stand-in lists the MCP servers its --mcp-config names, as claude's init event does.
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const log = join(dir, 'seen.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const s = args.indexOf('--settings'), m = args.indexOf('--mcp-config'), t = args.indexOf('--allowedTools');
const config = m >= 0 ? JSON.parse(fs.readFileSync(args[m + 1], 'utf8')) : null;
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ settings: JSON.parse(args[s + 1]), config, tools: t >= 0 ? args.slice(t + 1, args.findIndex((a, i) => i > t && a.startsWith('--'))) : [] }));
console.log(JSON.stringify({ type: 'system', subtype: 'init', plugins: [], mcp_servers: Object.keys(config ? config.mcpServers : {}).map((name) => ({ name, status: 'connected' })) }));
setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 })), 200);
`,
  );
  chmodSync(bin, 0o755);
  const plugins = () => ({ dirs: [], ids: [], pluginRoot: null });
  const r = await new CliRunner('cli', childEnv(), bin, undefined, undefined, undefined, {}, undefined, undefined, undefined, plugins, mcp).run({ ...req(cwd), allowedTools: ['Read'] });
  assert.equal(r.reason, 'succeeded', r.detail);
  const seen = JSON.parse(readFileSync(log, 'utf8')) as { settings: { allowedMcpServers: { serverCommand: string[] }[] }; config: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }; tools: string[] };
  const notes = seen.config.mcpServers.notes!;
  assert.deepEqual(notes.args.slice(-3), ['mcp-connect', 'six', 'notes']);
  assert.deepEqual(seen.settings.allowedMcpServers, [{ serverCommand: [notes.command, ...notes.args] }], 'the lock admits exactly the connector');
  assert.deepEqual(seen.tools, ['Read', 'mcp__notes__echo']);
  assert.match(Object.values(notes.env).join(''), /^e{64}$/, 'the ticket, nothing else');
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(ended, ['e'.repeat(64)], 'the ticket ended with the run');
});
