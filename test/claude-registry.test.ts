// R1185as D1: the claude CLI's top-level commands are found by probing every word that opens a string literal in the
// binary (scripts/ci/claude-registry.mjs), not by parsing its command table: a command routed by an argv fast path, a
// hidden one named through a variable, and one declared with its arguments are all found. A stand-in binary here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
type Entry = { version?: string; sha256: string; probedAt?: string; commands: string[] };
type Cache = Record<string, Entry>;
type Registry = {
  candidates: (bin: string) => string[];
  readCache: (text?: string) => Cache;
  cacheText: (c: Cache) => string;
  cacheProblems: (sha256: string, cache: Cache, listed: string[], earlier: string[], platform?: string) => string[];
  claudeCommands: (bin: string, o?: { concurrency?: number; timeoutMs?: number }) => Promise<{ commands: string[]; unread: string[] }>;
  listedCommands: (src: string, name?: string) => string[];
};
const registry = async () => (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'claude-registry.mjs')).href)) as Registry;

/** A stand-in claude: its bytes hold the strings a real build would; it answers `<word> --help` as the CLI does. */
function standIn(dir: string): string {
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!${process.execPath}
// strings a build holds: a fast path, a hidden command named through a variable, a command with its arguments, prose
const fast = ["remote", "sync"]; var HID="apply-project-settings"; const decl = "purge [path]"; const prose = 'claude exited before its init event';
const slow = "hang"; const quiet = "mute";
const [w, h] = process.argv.slice(2);
if (w === '--help') { console.log('Usage: claude [options] [command] [prompt]'); process.exit(0); }
if (h !== '--help') process.exit(2);
if (w === 'hang') setTimeout(() => {}, 60000);
else if (w === 'mute') process.exit(0);
else if (fast.includes(w)) { console.error('You must be logged in to use Remote Control.'); process.exit(1); }
else if (w === HID || w === 'purge') console.log('Usage: claude ' + w + ' [options]');
else console.log('Usage: claude [options] [command] [prompt]');
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test('R1185as D1: every word that opens a string literal in the binary is a candidate, a declared command with its arguments too', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-registry-'));
  try {
    const c = (await registry()).candidates(standIn(dir));
    for (const w of ['remote', 'sync', 'apply-project-settings', 'purge', 'claude', 'hang', 'mute']) assert.ok(c.includes(w), `${w} is a candidate`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1185as D1: a word is a command when `claude <word> --help` gives anything but the main usage line; a probe with no answer is unread, never dropped', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-registry-'));
  try {
    const r = await (await registry()).claudeCommands(standIn(dir), { concurrency: 4, timeoutMs: 3000 });
    assert.deepEqual(r.commands, ['apply-project-settings', 'purge', 'remote', 'sync']);
    assert.deepEqual(r.unread, ['hang', 'mute']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1185as D1: the lint lists are read from their one line each', async () => {
  const { listedCommands } = await registry();
  const src = "const EARLIER_COMMANDS = ['config'];\nconst SUBCOMMANDS = ['doctor', 'mcp'];\n";
  assert.deepEqual(listedCommands(src), ['doctor', 'mcp']);
  assert.deepEqual(listedCommands(src, 'EARLIER_COMMANDS'), ['config']);
  assert.throws(() => listedCommands('const SUBCOMMANDS = [\n];\n'), /no one-line/);
});

test('R1185as (the cache): the committed probe results round-trip, one entry per platform, and a binary none was probed from fails with what to run where', async () => {
  const { readCache, cacheText, cacheProblems } = await registry();
  const c: Cache = {
    'darwin-arm64': { version: '9.9.9', sha256: 'f'.repeat(64), probedAt: '2026-11-12', commands: ['doctor', 'mcp', 'remote'] },
    'linux-x64': { version: '9.9.9', sha256: 'e'.repeat(64), probedAt: '2026-11-12', commands: ['doctor', 'mcp', 'remote', 'sync'] },
  };
  assert.deepEqual(readCache(cacheText(c)), c);
  assert.equal(cacheText(c).match(/^\/\/ check-table: never-shrink\nexport const [A-Z0-9_]+_COMMANDS = \[$/gm)?.length, 2, 'each list is marked never-shrink');
  // Each platform's own binary is checked against its own entry's commands.
  assert.deepEqual(cacheProblems('f'.repeat(64), c, ['doctor', 'mcp', 'remote'], [], 'darwin-arm64'), []);
  assert.match(cacheProblems('e'.repeat(64), c, ['doctor', 'mcp', 'remote'], [], 'linux-x64')[0]!, /lacks sync/);
  const other = cacheProblems('d'.repeat(64), c, ['doctor', 'mcp', 'remote'], [], 'linux-x64');
  assert.equal(other.length, 1);
  assert.match(other[0]!, /re-run scripts\/ci\/claude-registry\.mjs --write for the new pin, on linux-x64/);
  assert.match(cacheProblems('d'.repeat(64), { 'darwin-arm64': c['darwin-arm64']! }, [], [], 'linux-x64')[0]!, /it has no linux-x64 entry/);
  assert.deepEqual(cacheProblems('f'.repeat(64), c, ['doctor', 'mcp', 'remote', 'config'], ['config'], 'darwin-arm64'), []);
  assert.match(cacheProblems('f'.repeat(64), c, ['doctor', 'mcp', 'remote', 'config'], [], 'darwin-arm64')[0]!, /holds config/);
});

test('R1185as (the cache): each committed platform entry\'s command set is the launch lint\'s SUBCOMMANDS, EARLIER_COMMANDS aside', async () => {
  const { readCache, cacheProblems, listedCommands } = await registry();
  const cache = readCache();
  const lint = readFileSync(join(repoRoot, 'test', 'claude-launch-lint.test.ts'), 'utf8');
  for (const [platform, e] of Object.entries(cache)) {
    assert.deepEqual(cacheProblems(e.sha256, cache, listedCommands(lint), listedCommands(lint, 'EARLIER_COMMANDS'), platform), [], platform);
    assert.ok(e.commands.length >= 40, `${platform}: ${e.commands.length} commands`);
  }
});
