import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  const service = sections('service.sh');
  assert.equal(engine.length, 1);
  assert.equal(checkout.length, 2);
  assert.equal(service.length, 1);
  const dest = mkdtempSync('/tmp/wl-setup-');
  chmodSync(dest, 0o777);
  try {
    const repo = 'example-org/example shop';
    let r = runAs(engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^worklane instance init site --repo \/srv\/worklane\/site\/example shop --github example-org\/example shop --agent-user wl-site-agent$/m);
    // Re-running after the instance exists (e.g. made by hand, naming another agent user) points it at wl-site-agent, once.
    const instDir = join(dest, '.local', 'state', 'worklane', 'instances', 'site');
    mkdirSync(instDir, { recursive: true, mode: 0o777 });
    for (let d = instDir; d !== dest; d = dirname(d)) chmodSync(d, 0o777);
    const yaml = join(instDir, 'instance.yaml');
    writeFileSync(yaml, 'version: 1\nname: site\nrun_as:\n  agent_user: site-agent\n  agent_home: /home/site-agent\n', { mode: 0o666 });
    chmodSync(yaml, 0o666);
    const listed = `HOME=${dest}\nworklane() { if [ "$2" = list ]; then echo site; else echo "worklane $*"; fi; }\n`;
    r = runAs(listed + engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'instance site exists; run_as now wl-site-agent\n');
    assert.match(readFileSync(yaml, 'utf8'), /^ {2}agent_user: wl-site-agent\n {2}agent_home: \/home\/wl-site-agent$/m);
    r = runAs(listed + engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.stdout, 'instance site exists; agents run as wl-site-agent\n');
    r = runAs(checkout[0]!, ['site', dest, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^git -c credential.helper= -c credential.helper=!\/usr\/local\/bin\/worklane git-credential clone -q https:\/\/github.com\/example-org\/example shop.git /m);
    assert.match(r.stdout, /^git config core.sharedRepository group$/m);
    assert.match(r.stdout, /^git -c core.hooksPath=\/dev\/null pull -q --ff-only$/m);
    r = runAs(checkout[1]!, ['site', dest, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^worklane install --root \. --engine \/opt\/worklane\/current\/dist\/src\/cli.js$/m);
    assert.match(r.stdout, /^git push -q origin HEAD:refs\/heads\/worklane\/setup$/m);
    assert.match(r.stdout, /compare\/worklane\/setup/);
    r = runAs(service[0]!, ['site']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'worklane instance show site\n');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('the coordinator service unit runs as the coordinator user, can still sudo to agents, and stops them with it', { skip: process.platform === 'win32' && 'bash scripts' }, () => {
  const r = spawnSync('bash', [join(dir, 'service.sh'), 'site', '--print'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const unit = r.stdout;
  assert.match(unit, /^User=wl-site$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/worklane coordinator run --instance site$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.doesNotMatch(unit, /NoNewPrivileges=(yes|true)/, 'agents are started through sudo');
  const install = readFileSync(join(dir, 'service.sh'), 'utf8');
  assert.ok(install.indexOf('systemd-analyze verify') < install.indexOf('mv -f'), 'validated before it is moved into place');
});
