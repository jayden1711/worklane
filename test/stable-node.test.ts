// WHY (#468): the local service ran node by its realpath (process.execPath), e.g. Homebrew's
// /opt/homebrew/Cellar/node/26.7.0/bin/node, and the next `brew upgrade node` deleted it: the coordinator died at its
// next restart. The service, the instance's service and the git credential helper now name the node the shell
// finds (the symlink kept as it is), and doctor and the first-run page flag a service file whose node is gone or
// sits inside a versioned directory. A fake PATH and a fake Cellar stand in for Homebrew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install } from '../src/install.js';
import type { Instance } from '../src/instance.js';
import { inVersionedNodeDir, launchdPlist, nodePathProblem, programOf, stableNodePath, systemdUserUnit } from '../src/os/index.js';
import { instanceEnv, localServiceSpec } from '../src/service.js';
import { checkSetup, type SetupProbe } from '../src/setup-steps.js';
import { exampleProject } from './helpers.js';

const posix = process.platform === 'win32' && 'POSIX symlinks and paths';

/** Homebrew as it lays node out: the versioned binary in the Cellar, and bin/node a symlink to it. */
function brew() {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'brew-')));
  const cellar = join(prefix, 'Cellar', 'node', '26.7.0', 'bin');
  mkdirSync(cellar, { recursive: true });
  const real = join(cellar, 'node');
  writeFileSync(real, '#!/bin/sh\n');
  chmodSync(real, 0o755);
  mkdirSync(join(prefix, 'bin'));
  const link = join(prefix, 'bin', 'node');
  symlinkSync(real, link);
  return { prefix, real, link, path: `${join(prefix, 'bin')}:/usr/bin:/bin` };
}

test('#468 the node to name: the symlink on PATH when it is this node, never its realpath in the Cellar; only a versioned one is said so, with what to do', { skip: posix }, () => {
  const b = brew();
  assert.ok(inVersionedNodeDir(b.real));
  assert.equal(inVersionedNodeDir(b.link), false);
  assert.deepEqual(stableNodePath({ execPath: b.real, path: b.path }), { path: b.link, versioned: false, why: null });
  // No node on PATH that is this one: its own path, and a versioned one is called out.
  const only = stableNodePath({ execPath: b.real, path: '/usr/bin:/bin' });
  assert.equal(only.path, b.real);
  assert.equal(only.versioned, true);
  assert.match(only.why!, /inside a versioned directory \(Homebrew's Cellar, nvm, fnm, asdf, volta or mise\): the next upgrade deletes it[\s\S]*Put a stable node on PATH/);
  // A node on PATH that is another node (another version): not this one, so not named for it.
  const other = brew();
  assert.equal(stableNodePath({ execPath: b.real, path: other.path }).path, b.real);
  for (const p of ['/home/example/.nvm/versions/node/v24.1.0/bin/node', '/home/example/.local/share/fnm/node-versions/v24/installation/bin/node', '/home/example/.asdf/installs/nodejs/24.1.0/bin/node', '/opt/homebrew/Cellar/node@22/22.13.0/bin/node']) assert.ok(inVersionedNodeDir(p), p);
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) assert.equal(inVersionedNodeDir(p), false, p);
});

test('#468 the local service (launchd plist and systemd unit) runs node by the PATH symlink, not the realpath this process runs from', { skip: posix }, () => {
  // A PATH whose bin/node is a symlink to the node running this test (whatever its real path).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'path-')));
  symlinkSync(process.execPath, join(dir, 'node'));
  const { dir: root } = exampleProject();
  const spec = localServiceSpec(root, loadConfig(root), { PATH: `${dir}:/usr/bin:/bin`, HOME: '/home/example' });
  assert.equal(spec.program[0], join(dir, 'node'));
  for (const text of [launchdPlist(spec), systemdUserUnit(spec)]) {
    assert.equal(programOf(text), join(dir, 'node'), 'what the service file runs');
    if (realpathSync(process.execPath) !== join(dir, 'node')) assert.ok(!text.includes(`>${realpathSync(process.execPath)}<`) && !text.includes(`"${realpathSync(process.execPath)}"`), 'never the realpath');
  }
});

test("#468 the instance's git credential helper names the same stable node", { skip: posix }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'path-')));
  symlinkSync(process.execPath, join(dir, 'node'));
  const home = mkdtempSync(join(tmpdir(), 'inst-'));
  const i = { name: 'shop', home, stateDir: join(home, 'state'), credentials: { version: 1, github: { kind: 'app', app_id: 1, installation_id: 2, key_path: join(home, 'app.pem') } } } as unknown as Instance;
  const env = instanceEnv(i, { PATH: `${dir}:/usr/bin:/bin` });
  const helper = Object.entries(env).find(([k, v]) => k.startsWith('GIT_CONFIG_VALUE_') && String(v).includes('git-credential'))![1]!;
  assert.match(helper, new RegExp(`^!"${join(dir, 'node').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}" ".*cli\\.js" git-credential$`));
});

test('#468 doctor and the first-run page: a service whose node is gone, or inside a versioned directory, is flagged with its file and the fix', { skip: posix }, () => {
  assert.match(nodePathProblem('/nowhere/node', () => false)!, /^runs node at \/nowhere\/node, which no longer exists/);
  assert.match(nodePathProblem('/opt/homebrew/Cellar/node/26.7.0/bin/node', () => true)!, /inside a versioned directory: the next upgrade deletes it/);
  assert.equal(nodePathProblem('/opt/homebrew/bin/node', () => true), null);
  const { dir } = exampleProject();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: dir });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  install({ root: dir });
  const plist = `/Users/example/Library/LaunchAgents/dev.${BRAND.cli}.example-shop.plist`;
  const probe = (node: string, exists: boolean): SetupProbe => ({
    which: (c) => `/stand-in/${c}`,
    run: () => ({ status: 1, stdout: '', stderr: 'stand-in' }),
    serviceRunning: () => true,
    systemUnitActive: () => false,
    linger: () => null,
    serviceProgram: () => ({ file: plist, node }),
    exists: () => exists,
  });
  const ctx = { mode: 'local' as const, root: dir, repo: 'example-org/example-shop', instance: null, stateDir: projectStateDir(dir), policyFile: null, openQuestions: 0, setupPr: null };
  const step = (p: SetupProbe) => checkSetup(ctx, p).groups.flatMap((g) => g.steps).find((s) => s.id === 'service')!;
  const gone = step(probe('/opt/homebrew/Cellar/node/26.7.0/bin/node', false));
  assert.equal(gone.done, false, 'running now, but not after its next restart');
  assert.match(gone.detail, new RegExp(`^${plist.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} runs node at /opt/homebrew/Cellar/node/26\\.7\\.0/bin/node, which no longer exists.*run \`${BRAND.cli} up\` to rewrite it with the node on your PATH$`));
  const cellar = step(probe('/opt/homebrew/Cellar/node/26.7.0/bin/node', true));
  assert.equal(cellar.done, false);
  assert.match(cellar.detail, /inside a versioned directory: the next upgrade deletes it: run `.* up`/);
  const fine = step(probe('/opt/homebrew/bin/node', true));
  assert.equal(fine.done, true, fine.detail);
});
