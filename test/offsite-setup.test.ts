import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { loadOffsiteConfig, offsiteBackup } from '../src/offsite-backup.js';
import { repoRoot } from './helpers.js';

const script = join(repoRoot, 'scripts', 'setup', 'offsite-backup.sh');
const recipient = `age1${'q'.repeat(58)}`;
const print = (...args: string[]) => spawnSync('bash', [script, '--print-config', ...args], { encoding: 'utf8' });

/** Stand-ins for age and rclone with the same command lines: a marked base64 "encryption" and a directory as the bucket. */
function fakeTools(root: string) {
  const bin = join(root, 'bin');
  const bucket = join(root, 'b2');
  mkdirSync(bin);
  mkdirSync(bucket);
  writeFileSync(
    join(bin, 'age'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = -d ]; then [ -f "$3" ] || exit 9; tail -n +2 "$6" | base64 -d > "$5"
else [ "$1" = -r ] || exit 8; { echo "STUB-AGE $2"; base64 < "$5"; } > "$4"; fi
`,
  );
  writeFileSync(
    join(bin, 'rclone'),
    `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = --config ] && [ "$3" = copyto ] || exit 7
map() { case "$1" in *-offsite:*) echo "${bucket}/\${1#*-offsite:}" ;; *) echo "$1" ;; esac; }
dst="$(map "$5")"; mkdir -p "$(dirname "$dst")"; cp "$(map "$4")" "$dst"
`,
  );
  chmodSync(join(bin, 'age'), 0o755);
  chmodSync(join(bin, 'rclone'), 0o755);
  return { bin, bucket };
}

test('the B2 config it writes is one the engine loads, and a backup through it round-trips', { skip: process.platform === 'win32' && 'bash setup script' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'offsite-setup-'));
  const keys = join(root, 'keys');
  mkdirSync(keys);
  writeFileSync(join(keys, 'age.key'), 'AGE-SECRET-KEY-stub');
  writeFileSync(join(keys, 'rclone.conf'), '[site-offsite]\ntype = b2\n');
  const r = print('site', 'my-bucket', 'site', recipient, keys);
  assert.equal(r.status, 0, r.stderr);
  const file = join(root, 'offsite-backup.yaml');
  writeFileSync(file, r.stdout);
  chmodSync(file, 0o600);
  const loaded = loadOffsiteConfig(file);
  assert.ok(loaded && 'config' in loaded, JSON.stringify(loaded));
  const c = loaded.config;
  assert.equal(c.destination, 'Backblaze B2 my-bucket/site');
  assert.match(c.encrypt, new RegExp(`-r ${recipient} `), 'encrypts to the public key');
  assert.ok(c.decrypt.includes(`${keys}/age.key`) && !c.encrypt.includes('age.key') && !c.put.includes('age.key') && !c.get.includes('age.key'), 'only decrypt names the private key');

  const t = fakeTools(root);
  const prev = process.env.PATH;
  process.env.PATH = `${t.bin}:${prev}`;
  const log = new EventLog(join(root, 'events.db'));
  try {
    for (let i = 0; i < 3; i++) log.append('coordinator.started', { instance: 'site', pid: i, version: '0.0.0' }, 'test');
    const b = await offsiteBackup(log, c);
    assert.equal(b.ok, true, b.error);
    const sent = readdirSync(join(t.bucket, 'my-bucket', 'site'));
    assert.equal(sent.length, 1, 'one copy, under the bucket and prefix');
    assert.match(readFileSync(join(t.bucket, 'my-bucket', 'site', sent[0]!), 'utf8'), /^STUB-AGE /, 'what left was the encrypted form');
  } finally {
    process.env.PATH = prev;
    log.close();
  }
});

test('names that would reach a shell command are refused, and so is a key that is not an age recipient', { skip: process.platform === 'win32' && 'bash setup script' }, () => {
  assert.notEqual(print('site', 'b;rm -rf ~', 'site', recipient, '/k').status, 0);
  assert.notEqual(print('site', 'bucket', '$(id)', recipient, '/k').status, 0);
  assert.notEqual(print('si te', 'bucket', 'site', recipient, '/k').status, 0);
  assert.notEqual(print('site', 'bucket', 'site', 'not-a-key', '/k').status, 0);
});
