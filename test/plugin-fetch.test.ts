import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fetchGitPlugin, FetchError, materialize, sourceProblem } from '../src/plugins/fetch.js';
import { inspectPlugin } from '../src/plugins/inspect.js';
import { treeHash } from '../src/plugins/tree.js';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();

/** A local repo with a plugin under plugins/kit, committed twice; the first commit's SHA and the second's. */
function repo(): { url: string; first: string; second: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-repo-'));
  g(dir, 'init', '-q');
  const w = (p: string, c: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  w('plugins/kit/.claude-plugin/plugin.json', JSON.stringify({ name: 'kit', version: '1.0.0' }));
  w('plugins/kit/skills/a/SKILL.md', '---\nname: a\ndescription: a\n---\nA.\n');
  w('plugins/kit/.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.js'] } } }));
  w('plugins/kit/s.js', '');
  w('README.md', 'outside the plugin');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'one');
  const first = g(dir, 'rev-parse', 'HEAD');
  w('plugins/kit/skills/a/SKILL.md', '---\nname: a\ndescription: a\n---\nA, changed.\n');
  g(dir, 'commit', '-qam', 'two');
  return { url: `file://${dir}`, first, second: g(dir, 'rev-parse', 'HEAD'), dir };
}
const dest = () => join(mkdtempSync(join(tmpdir(), 'plugin-dest-')), 'p');

test('a source must be an https URL and a full SHA; file URLs only when a test allows them', () => {
  assert.match(sourceProblem({ url: 'https://example.com/o/r.git', sha: 'abc' }) ?? '', /40-character/);
  assert.match(sourceProblem({ url: 'http://example.com/o/r', sha: 'a'.repeat(40) }) ?? '', /https/);
  assert.match(sourceProblem({ url: 'https://u:p@example.com/o/r', sha: 'a'.repeat(40) }) ?? '', /https/);
  assert.match(sourceProblem({ url: 'file:///tmp/r', sha: 'a'.repeat(40) }) ?? '', /https/);
  assert.match(sourceProblem({ url: 'https://example.com/o/r', sha: 'a'.repeat(40), path: '../x' }) ?? '', /plain subdirectory/);
  assert.equal(sourceProblem({ url: 'https://example.com/o/r.git', sha: 'a'.repeat(40), path: 'plugins/kit' }), null);
});

test('fetch gets exactly the named commit, only the plugin directory, and no .git (fail-without: a fetch of the branch tip)', () => {
  const r = repo();
  const d = dest();
  fetchGitPlugin({ url: r.url, sha: r.first, path: 'plugins/kit' }, d, { allowFileUrls: true });
  assert.match(readFileSync(join(d, 'skills', 'a', 'SKILL.md'), 'utf8'), /^---[\s\S]*\nA\.\n$/);
  assert.equal(existsSync(join(d, '.git')), false);
  assert.equal(existsSync(join(d, 'README.md')), false);
  const d2 = dest();
  fetchGitPlugin({ url: r.url, sha: r.second, path: 'plugins/kit' }, d2, { allowFileUrls: true });
  assert.notEqual(treeHash(d), treeHash(d2));
});

test('fetch refuses a commit the repository does not have, and a path that is not in it', () => {
  const r = repo();
  assert.throws(() => fetchGitPlugin({ url: r.url, sha: 'f'.repeat(40) }, dest(), { allowFileUrls: true }), FetchError);
  assert.throws(() => fetchGitPlugin({ url: r.url, sha: r.first, path: 'nope' }, dest(), { allowFileUrls: true }), FetchError);
});

test('a committed symlink arrives as a symlink, so the inspector refuses the plugin', () => {
  const r = repo();
  symlinkSync('/etc/passwd', join(r.dir, 'plugins', 'kit', 'leak'));
  g(r.dir, 'add', '-A');
  g(r.dir, 'commit', '-qm', 'link');
  const d = dest();
  fetchGitPlugin({ url: r.url, sha: g(r.dir, 'rev-parse', 'HEAD'), path: 'plugins/kit' }, d, { allowFileUrls: true });
  assert.match(inspectPlugin(d).refusals.join('\n'), /symlink/);
});

test('materialize removes the MCP config Claude Code would run, records each change, and hashes the result', () => {
  const r = repo();
  const d = dest();
  fetchGitPlugin({ url: r.url, sha: r.first, path: 'plugins/kit' }, d, { allowFileUrls: true });
  const ins = inspectPlugin(d);
  assert.deepEqual(ins.refusals, []);
  const out = dest();
  const m = materialize(d, ins, out);
  assert.equal(existsSync(join(out, '.mcp.json')), false);
  assert.deepEqual(m.transform, ['MCP server "s" (from .mcp.json) is run by the broker, not by Claude Code', 'removed .mcp.json']);
  assert.equal(m.tree, treeHash(out));
  assert.notEqual(m.tree, ins.tree);
  assert.deepEqual(inspectPlugin(out).mcpServers, [], 'the materialized copy carries no MCP server for Claude Code to start');
});

test('materialize refuses a refused plugin, and a directory that changed after inspection', () => {
  const r = repo();
  const d = dest();
  fetchGitPlugin({ url: r.url, sha: r.first, path: 'plugins/kit' }, d, { allowFileUrls: true });
  const ins = inspectPlugin(d);
  writeFileSync(join(d, 'skills', 'a', 'SKILL.md'), 'swapped');
  assert.throws(() => materialize(d, ins, dest()), /changed since it was inspected/);
  assert.throws(() => materialize(d, { ...ins, refusals: ['x'] }, dest()), /refused: x/);
});
