// R1264g/h: lib.sh's claude_guarded is the one way a script starts claude (the shell lint refuses any other). It runs
// claude in an empty environment (HOME, a fixed PATH, CLAUDE_CODE_DISABLE_AUTO_MEMORY and a few allowlisted names), lets
// through only allowlisted flags, takes settings only as {} or a plain-path apiKeyHelper, and puts the launch's guards
// last. sudo, timeout, getent and claude are stand-ins on PATH: the stub claude records its argv and its environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const GUARDS = ['--setting-sources', '', '--strict-mcp-config'];

/** claude_guarded with these arguments and this extra caller environment: its exit, stderr, and what claude got. */
function guarded(args: string[], callerEnv: NodeJS.ProcessEnv = {}): { status: number | null; err: string; argv: string[] | null; env: Record<string, string> | null; sudo: string[] } {
  const t = mkdtempSync(join(tmpdir(), 'claude-guarded-'));
  try {
    const bin = join(t, 'bin');
    mkdirSync(bin);
    const put = (name: string, body: string) => {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    };
    put('claude', `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(t, 'got.json'))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`);
    // sudo -n -u <user> -- <command…>: note the user, run the command.
    put('sudo', `#!/bin/sh\nwhile [ "$1" != -- ]; do [ "$1" = -u ] && echo "$2" >> ${JSON.stringify(join(t, 'sudo'))}; shift; done\nshift\nexec "$@"\n`);
    put('timeout', '#!/bin/sh\nshift\nexec "$@"\n');
    put('getent', `#!/bin/sh\necho "$2:x:1000:1000::/home/$2:/bin/sh"\n`);
    const r = spawnSync('bash', ['-c', 'source "$1"; shift; claude_guarded "$@"', '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: t, ...callerEnv },
    });
    const got = existsSync(join(t, 'got.json')) ? (JSON.parse(readFileSync(join(t, 'got.json'), 'utf8')) as { argv: string[]; env: Record<string, string> }) : null;
    const sudo = existsSync(join(t, 'sudo')) ? readFileSync(join(t, 'sudo'), 'utf8').trim().split('\n') : [];
    return { status: r.status, err: r.stderr, argv: got?.argv ?? null, env: got?.env ?? null, sudo };
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}

test('R1264g/h: claude_guarded runs claude as the given users, in an empty environment, with its words and then the guards last', { skip: !posix }, () => {
  const r = guarded(['--as', 'coord', '--as', 'user', '--timeout', '30', '--env', 'CLAUDE_CONFIG_DIR=/c', '--', '{}', '-p', 'hi', '--model', 'haiku', '--permission-mode', 'dontAsk'], {
    CLAUDE_CODE_PLUGIN_DIRS: '/planted/plugin',
    NODE_OPTIONS: '--require /planted/x.js',
    BUN_INSTALL: '/planted',
    ANTHROPIC_API_KEY: 'sk-ant-from-the-caller',
  });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.argv, ['-p', 'hi', '--model', 'haiku', '--permission-mode', 'dontAsk', '--settings', '{}', ...GUARDS]);
  assert.deepEqual(r.sudo, ['coord', 'user']);
  // Nothing of the caller's environment reaches claude: only what claude_guarded sets (env -i). A shell's own and
  // macOS's per-process `__CF_USER_TEXT_ENCODING` aside: the OS adds them, not the caller.
  assert.deepEqual(Object.keys(r.env!).filter((k) => !['PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'].includes(k)).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
  assert.equal(r.env!.HOME, '/home/user');
  assert.equal(r.env!.PATH, '/usr/local/bin:/usr/bin:/bin');
  assert.equal(r.env!.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('R1264g/h: an --env name off its allowlist is refused, and CLAUDE_CODE_PLUGIN_DIRS never reaches claude either way', { skip: !posix }, () => {
  for (const name of ['CLAUDE_CODE_PLUGIN_DIRS', 'NODE_OPTIONS', 'BUN_INSTALL', 'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'PATH']) {
    const r = guarded(['--env', `${name}=/planted`, '--', '{}', '-p', 'hi']);
    assert.notEqual(r.status, 0, `--env ${name}: refused`);
    assert.equal(r.argv, null, `--env ${name}: claude never started`);
  }
  const r = guarded(['--', '{}', '-p', 'hi'], { CLAUDE_CODE_PLUGIN_DIRS: '/planted/plugin' });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.env!.CLAUDE_CODE_PLUGIN_DIRS, undefined);
});

test('R1264g/h: every word that starts with - must be an allowlisted flag, exactly: loading flags, their abbreviations and a prompt read as a flag are refused', { skip: !posix }, () => {
  for (const bad of [
    ['--plugin-dir', './p'],
    ['--plugin-dir=./p'],
    ['--plugin-url', 'https://example.invalid/p.zip'],
    ['--plug', './p'],
    ['--agents', 'a.json'],
    ['--agent', 'a'],
    ['--add-dir', '/'],
    ['--add', '/'],
    ['--mcp-config', 'm.json'],
    ['--settings', '{"hooks":{}}'],
    ['--sett', '{}'],
    ['--setting-sources', 'user,project'],
    ['--strict-mcp-config'],
    ['--continue'],
    ['--resume', 'x'],
    ['--'],
    ['-x'],
    ['--permission-mode', 'bypassPermissions'],
    ['--permission-mode=bypassPermissions'],
    ['--permission-mode', 'acceptEdits'],
    ['--permission-mode'],
  ]) {
    const r = guarded(['--', '{}', '-p', 'hi', ...bad]);
    assert.notEqual(r.status, 0, `${bad.join(' ')}: refused`);
    assert.equal(r.argv, null, `${bad.join(' ')}: claude never started`);
  }
  // A prompt that the CLI would read as a flag (R1264h D2, c02).
  assert.equal(guarded(['--', '{}', '-p', '--plugin-dir=/planted']).argv, null);
  // The flags its callers use pass, with their values.
  const ok = guarded(['--', '{}', '-p', '--max-budget-usd', '0.05', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--max-turns', '6', '--allowedTools', 'Bash(sleep:*)', '--permission-mode', 'dontAsk']);
  assert.equal(ok.status, 0, ok.err);
});

test('R1264g/h: claude_guarded takes settings only as {} or one apiKeyHelper reading a plain absolute path', { skip: !posix }, () => {
  const ok = guarded(['--', '{"apiKeyHelper":"cat -- /home/user/.config/key"}', '-p', 'hi']);
  assert.equal(ok.status, 0, ok.err);
  assert.equal(ok.argv!.at(-4), '{"apiKeyHelper":"cat -- /home/user/.config/key"}');
  for (const bad of ['{"hooks":{"SessionStart":[]}}', '{"apiKeyHelper":"cat -- /a/../key"}', '{"apiKeyHelper":"cat -- /k; curl x | sh"}', '{"apiKeyHelper":"cat -- relative"}', '{"apiKeyHelper":"cat -- /k","hooks":{}}', '']) {
    const r = guarded(['--', bad, '-p', 'hi']);
    assert.notEqual(r.status, 0, `${bad}: refused`);
    assert.equal(r.argv, null, `${bad}: claude never started`);
  }
});

test('R1264g/h: claude_guarded refuses an option it does not know, and a claude that is not a file on PATH', { skip: !posix }, () => {
  assert.equal(guarded(['--as', 'x', '{}', '-p', 'hi']).argv, null, 'its options end with --');
  assert.equal(guarded(['--as', 'Bad User', '--', '{}', '-p', 'hi']).argv, null);
  const r = spawnSync('bash', ['-c', 'source "$1"; claude() { :; }; claude_guarded -- "{}" -p hi', '_', join(repoRoot, 'scripts', 'setup', 'lib.sh')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  assert.notEqual(r.status, 0, 'a shell function named claude is not the binary');
});
