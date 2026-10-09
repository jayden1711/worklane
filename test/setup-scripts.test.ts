import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const dir = join(repoRoot, 'scripts', 'setup');
const scripts = readdirSync(dir).filter((f) => f.endsWith('.sh'));

test('setup scripts parse, stop at the first error, and only install sudoers rules that visudo accepted', { skip: process.platform === 'win32' && 'bash scripts' }, () => {
  assert.ok(scripts.length >= 5);
  for (const f of scripts) {
    const r = spawnSync('bash', ['-n', join(dir, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    const text = readFileSync(join(dir, f), 'utf8');
    if (f !== 'lib.sh') assert.match(text, /source "\$\(dirname "\$0"\)\/lib\.sh"/, `${f} uses the shared strict-mode helpers`);
    // Any write into /etc/sudoers.d goes through install_sudoers: a dotted temp name, visudo -cf, then mv.
    for (const line of text.split('\n')) if (/\/etc\/sudoers\.d\//.test(line) && f !== 'lib.sh' && f !== 'check.sh') assert.fail(`${f} writes sudoers directly: ${line.trim()}`);
  }
  const lib = readFileSync(join(dir, 'lib.sh'), 'utf8');
  assert.match(lib, /set -euo pipefail/);
  const install = lib.slice(lib.indexOf('install_sudoers()'));
  assert.ok(install.indexOf('/etc/sudoers.d/.$1.tmp') < install.indexOf('visudo -cf') && install.indexOf('visudo -cf') < install.indexOf('mv -f'), 'temp name, then validate, then move');
});
