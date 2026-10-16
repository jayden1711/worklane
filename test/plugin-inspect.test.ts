import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { frontmatter, hasInlineShell, inspectPlugin } from '../src/plugins/inspect.js';
import { TREE_PREFIX, treeHash, TreeError } from '../src/plugins/tree.js';

/** A plugin directory from a map of relative path -> content (strings are written as is, objects as JSON). */
function plugin(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-'));
  for (const [p, c] of Object.entries(files)) {
    const f = join(root, ...p.split('/'));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, typeof c === 'string' ? c : JSON.stringify(c));
  }
  return root;
}
const skill = (name: string, extra = '', body = 'Do the thing.\n') => `---\nname: ${name}\ndescription: a skill\n${extra}---\n${body}`;
const GOOD = {
  '.claude-plugin/plugin.json': { name: 'review-kit', version: '1.2.0', description: 'x', author: { name: 'a' } },
  'skills/review/SKILL.md': skill('review'),
  'skills/review/scripts/check.sh': '#!/bin/sh\necho ok\n',
  'agents/reviewer.md': '---\nname: reviewer\ndescription: r\ntools: Read, Grep\n---\nReview.\n',
  'commands/status.md': '---\ndescription: s\n---\nShow status.\n',
  'bin/kit': '#!/bin/sh\n',
  '.mcp.json': { mcpServers: { docs: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } } } },
  'server.js': 'process.stdin.resume()\n',
};

test('a plugin of skills, agents, commands, bin and a stdio server inside it passes, listing exactly what it carries', () => {
  const r = inspectPlugin(plugin(GOOD));
  assert.deepEqual(r.refusals, []);
  assert.equal(r.name, 'review-kit');
  assert.deepEqual(r.skills, ['review']);
  assert.deepEqual(r.agents, ['reviewer']);
  assert.deepEqual(r.commands, ['status']);
  assert.deepEqual(r.bin, ['kit']);
  assert.deepEqual(r.mcpServers, [{ name: 'docs', argv: ['node', '${CLAUDE_PLUGIN_ROOT}/server.js'], envNames: ['DOCS_TOKEN'], from: '.mcp.json' }]);
  assert.ok(r.tree?.startsWith(TREE_PREFIX));
  // Env values are never part of what's shown: names only.
  assert.doesNotMatch(JSON.stringify(r.mcpServers), /\$\{DOCS_TOKEN\}/);
});

// Each refusal on its own: the fixture is GOOD plus one thing, and the reason must name it. Fail-without: drop the
// matching rule in src/plugins/inspect.ts and that row passes inspection.
const REFUSALS: [label: string, files: Record<string, string | object>, reason: RegExp][] = [
  ['hooks/hooks.json', { 'hooks/hooks.json': { hooks: {} } }, /hooks\/hooks\.json: hooks run commands/],
  ['manifest hooks', { '.claude-plugin/plugin.json': { name: 'k', hooks: './h.json' } }, /manifest "hooks"/],
  ['skill frontmatter hooks', { 'skills/x/SKILL.md': skill('x', 'hooks:\n  PreToolUse: []\n') }, /skills\/x\/SKILL\.md: "hooks"/],
  ['skill allowed-tools', { 'skills/x/SKILL.md': skill('x', 'allowed-tools: Bash(curl *)\n') }, /"allowed-tools"/],
  ['skill inline shell', { 'skills/x/SKILL.md': skill('x', '', 'Diff: !`git diff`\n') }, /inline shell/],
  ['skill fenced inline shell', { 'skills/x/SKILL.md': skill('x', '', '```!\ncurl x\n```\n') }, /inline shell/],
  ['command allowed-tools', { 'commands/c.md': '---\nallowed-tools: Bash\n---\nx\n' }, /commands\/c\.md: "allowed-tools"/],
  ['manifest command allowedTools', { '.claude-plugin/plugin.json': { name: 'k', commands: { c: { content: 'x', allowedTools: ['Bash'] } } } }, /commands\.c\.allowedTools/],
  ['agent permissionMode', { 'agents/a.md': '---\nname: a\npermissionMode: bypassPermissions\n---\nx\n' }, /"permissionMode"/],
  ['LSP server', { '.lsp.json': {} }, /\.lsp\.json: LSP/],
  ['manifest lspServers', { '.claude-plugin/plugin.json': { name: 'k', lspServers: {} } }, /manifest "lspServers"/],
  ['monitors', { 'monitors/monitors.json': [] }, /monitors/],
  ['experimental', { '.claude-plugin/plugin.json': { name: 'k', experimental: { monitors: [] } } }, /manifest "experimental"/],
  ['settings.agent', { 'settings.json': { agent: 'x' } }, /settings\.json: plugin settings/],
  ['manifest settings', { '.claude-plugin/plugin.json': { name: 'k', settings: { agent: 'x' } } }, /manifest "settings"/],
  ['an unknown manifest key', { '.claude-plugin/plugin.json': { name: 'k', gadgets: './g' } }, /manifest "gadgets": not a key this version reviews/],
  ['sensitive userConfig', { '.claude-plugin/plugin.json': { name: 'k', userConfig: { t: { type: 'string', title: 't', description: 'd', sensitive: true } } } }, /userConfig "t": sensitive/],
  ['an unapproved dependency', { '.claude-plugin/plugin.json': { name: 'k', dependencies: ['other'] } }, /dependency other: not approved/],
  ['an npx server', { '.mcp.json': { mcpServers: { s: { command: 'npx', args: ['-y', 'pkg'] } } } }, /"npx" fetches/],
  ['a uvx server', { '.mcp.json': { mcpServers: { s: { command: 'uvx', args: ['pkg'] } } } }, /"uvx" fetches/],
  ['a remote server', { '.mcp.json': { mcpServers: { s: { type: 'http', url: 'https://x.example' } } } }, /remote servers/],
  ['a headersHelper', { '.mcp.json': { mcpServers: { s: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], headersHelper: 'x' } } } }, /headersHelper/],
  ['a system binary as server', { '.mcp.json': { mcpServers: { s: { command: '/usr/bin/env', args: ['node'] } } } }, /must be a file inside the plugin/],
  ['node running a file outside', { '.mcp.json': { mcpServers: { s: { command: 'node', args: ['/tmp/x.js'] } } } }, /must be a file inside the plugin/],
  ['an .mcpb bundle', { '.claude-plugin/plugin.json': { name: 'k', mcpServers: 'https://x.example/s.mcpb' } }, /bundles/],
  ['a path out of the plugin', { '.claude-plugin/plugin.json': { name: 'k', skills: '../other' } }, /not a \.\/ path inside/],
  ['a marketplace file', { '.claude-plugin/marketplace.json': {} }, /only plugin\.json belongs/],
  ['a bidi file name', { 'skills/x/re‮adme.md': 'x' }, /refused path segment/],
];
for (const [label, extra, reason] of REFUSALS)
  test(`the inspector refuses ${label}`, () => {
    const r = inspectPlugin(plugin({ ...GOOD, ...extra }));
    assert.ok(r.refusals.some((x) => reason.test(x)), `refusals were: ${JSON.stringify(r.refusals)}`);
  });

test('a dependency that is approved for the instance is allowed', () => {
  const r = inspectPlugin(plugin({ ...GOOD, '.claude-plugin/plugin.json': { name: 'k', dependencies: ['base-kit'] } }), { approved: new Set(['base-kit']) });
  assert.deepEqual(r.refusals, []);
});

test('the inspector never executes anything from the plugin (fail-without: any exec of a plugin file touches the sentinel)', () => {
  const sentinel = join(mkdtempSync(join(tmpdir(), 'sentinel-')), 'ran');
  const sh = `#!/bin/sh\ntouch '${sentinel}'\n`;
  const root = plugin({ ...GOOD, 'bin/kit': sh, 'server.js': `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')\n`, 'skills/review/scripts/check.sh': sh });
  for (const f of ['bin/kit', 'skills/review/scripts/check.sh']) chmodSync(join(root, ...f.split('/')), 0o755);
  inspectPlugin(root);
  assert.equal(existsSync(sentinel), false);
});

test('wl-tree-v1 changes with any byte, any file added, and the exec bit; not with creation order', () => {
  const a = plugin({ 'a.md': 'x', 'b/c.md': 'y' });
  const h = treeHash(a);
  assert.equal(treeHash(plugin({ 'b/c.md': 'y', 'a.md': 'x' })), h, 'creation order must not matter');
  assert.notEqual(treeHash(plugin({ 'a.md': 'X', 'b/c.md': 'y' })), h);
  assert.notEqual(treeHash(plugin({ 'a.md': 'x', 'b/c.md': 'y', 'd.md': '' })), h);
  chmodSync(join(a, 'a.md'), 0o755);
  assert.notEqual(treeHash(a), h);
});

test('wl-tree-v1 refuses a symlink and a hard link, never hashing around them', () => {
  const s = plugin({ 'a.md': 'x' });
  symlinkSync('/etc/passwd', join(s, 'link'));
  assert.throws(() => treeHash(s), TreeError);
  const l = plugin({ 'a.md': 'x' });
  linkSync(join(l, 'a.md'), join(l, 'b.md'));
  assert.throws(() => treeHash(l), TreeError);
  // And the inspector turns that into a refusal, not a crash.
  assert.match(inspectPlugin(s).refusals.join('\n'), /symlink/);
});

test('wl-tree-v1 refuses past its file and byte caps', () => {
  assert.throws(() => treeHash(plugin({ a: 'x', b: 'y' }), { maxFiles: 1, maxBytes: 100 }), /more than 1 files/);
  assert.throws(() => treeHash(plugin({ a: 'x'.repeat(10) }), { maxFiles: 10, maxBytes: 5 }), /bytes/);
});

test('frontmatter and inline shell detection match what Claude Code would act on, not look-alikes', () => {
  assert.deepEqual(frontmatter('---\nname: a\n---\nbody').data, { name: 'a' });
  assert.equal(hasInlineShell('run !`date` now'), true);
  assert.equal(hasInlineShell('KEY=!`cmd`'), false, 'Claude Code leaves ! after another character as text');
  assert.equal(hasInlineShell('plain `code` and ! bang'), false);
});
