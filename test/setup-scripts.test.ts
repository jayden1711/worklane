import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

test('no setup script hands a shell script to sudo -i (its login-shell quoting mangles multi-line scripts)', () => {
  for (const f of scripts) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (/sudo\s+(-\S+\s+)*-i\S*\s.*\b(ba)?sh\b.*\s-c\b/.test(line)) assert.fail(`${f}: use run_as, not sudo -i ... -c: ${line.trim()}`);
    }
  }
});

/** Each `run_as "$coord" '<script>' args` section of a setup script. */
const sections = (f: string) => [...readFileSync(join(dir, f), 'utf8').matchAll(/run_as "\$coord" '\n([\s\S]*?)\n\s*' /g)].map((m) => m[1]!);

// A real other user, which passwordless sudo can switch to (CI runners; skipped where sudo asks for a password).
const other = 'nobody';
const canSwitch = process.platform !== 'win32' && spawnSync('sudo', ['-n', '-u', other, 'true']).status === 0;

test('acceptance: every run_as section of the setup scripts runs as a real other user with its arguments intact', { skip: !canSwitch && 'needs passwordless sudo to another user' }, () => {
  // Stub the tools so only the scripts' own shell (quoting, arguments, control flow) is under test.
  const stubs = 'worklane() { echo "worklane $*"; }\ngit() { echo "git $*"; case "$1" in rev-parse) echo main;; esac; }\n';
  const runAs = (body: string, args: string[]) =>
    spawnSync('bash', ['-c', `source "${join(dir, 'lib.sh')}"; run_as ${other} "$@"`, '_', stubs + body, ...args], { encoding: 'utf8' });
  const engine = sections('engine.sh');
  const checkout = sections('checkout.sh');
  assert.equal(engine.length, 1);
  assert.equal(checkout.length, 2);
  const dest = mkdtempSync('/tmp/wl-setup-');
  chmodSync(dest, 0o777);
  try {
    const repo = 'example-org/example shop';
    let r = runAs(engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^worklane instance init site --repo \/srv\/worklane\/site\/example shop --github example-org\/example shop$/m);
    // Re-running after the instance exists (e.g. made by hand) changes nothing.
    const listed = 'worklane() { if [ "$2" = list ]; then echo site; else echo "worklane $*"; fi; }\n';
    r = runAs(listed + engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'instance site exists\n');
    r = runAs(checkout[0]!, ['site', dest, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^git -c credential.helper= -c credential.helper=!\/usr\/local\/bin\/worklane git-credential clone -q https:\/\/github.com\/example-org\/example shop.git /m);
    assert.match(r.stdout, /^git config core.sharedRepository group$/m);
    r = runAs(checkout[1]!, ['site', dest, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^worklane install --root \. --engine \/opt\/worklane\/current\/dist\/src\/cli.js$/m);
    assert.match(r.stdout, /^git push -q origin HEAD:refs\/heads\/worklane\/setup$/m);
    assert.match(r.stdout, /compare\/worklane\/setup/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
