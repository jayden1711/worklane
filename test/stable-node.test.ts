// WHY (#468): the local service ran node by its realpath (process.execPath), e.g. Homebrew's
// /opt/homebrew/Cellar/node/26.7.0/bin/node, and the next `brew upgrade node` deleted it: the coordinator died at its
// next restart. The owner's rule: the local service and the checkout's pre-push hook name Homebrew's stable
// `$(brew --prefix)/bin/node` when this node is Homebrew's, else this node's own absolute path; never a `node` found
// on PATH; a server instance keeps its root-controlled absolute path (the service and the credential helper alike).
// Doctor and the first-run page flag a service file whose node is gone or inside a versioned directory. A fake
// Homebrew prefix stands in for /opt/homebrew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install, installCheckoutPrePush } from '../src/install.js';
import type { Instance } from '../src/instance.js';
import { inVersionedNodeDir, launchdPlist, nodePathProblem, ownedPath, programOf, stableNodePath, systemdUserUnit } from '../src/os/index.js';
import { instanceEnv, localServiceSpec } from '../src/service.js';
import { checkSetup, type SetupProbe } from '../src/setup-steps.js';
import { exampleProject } from './helpers.js';

const posix = process.platform === 'win32' && 'POSIX symlinks and paths';
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));

/** Homebrew as it lays node out under a prefix: bin/brew, the versioned binary in the Cellar, bin/node a symlink to it. */
function brew(real?: string) {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'brew-')));
  mkdirSync(join(prefix, 'bin'));
  writeFileSync(join(prefix, 'bin', 'brew'), '#!/bin/sh\n');
  let node = real;
  if (!node) {
    const cellar = join(prefix, 'Cellar', 'node', '26.7.0', 'bin');
    mkdirSync(cellar, { recursive: true });
    node = join(cellar, 'node');
    writeFileSync(node, '#!/bin/sh\n');
    chmodSync(node, 0o755);
  }
  const link = join(prefix, 'bin', 'node');
  symlinkSync(node, link);
  return { prefix, real: node, link };
}

test("#468 the node to name: Homebrew's $(brew --prefix)/bin/node when this node is Homebrew's; else this node's own path; a versioned one is said so", { skip: posix }, () => {
  const b = brew();
  assert.ok(inVersionedNodeDir(b.real));
  assert.equal(inVersionedNodeDir(b.link), false);
  assert.deepEqual(stableNodePath({ execPath: b.real, brewPrefixes: [b.prefix] }), { path: b.link, versioned: false, why: null });
  // No Homebrew: this node's own path; one inside a versioned directory is called out with what to do.
  const none = stableNodePath({ execPath: b.real, brewPrefixes: [] });
  assert.deepEqual([none.path, none.versioned], [b.real, true]);
  assert.match(none.why!, /inside a versioned directory[\s\S]*Install node with Homebrew/);
  assert.deepEqual(stableNodePath({ execPath: '/usr/bin/node', brewPrefixes: [] }), { path: '/usr/bin/node', versioned: false, why: null });
  // Homebrew's node is another node (another version): not named for this one.
  const other = brew();
  assert.equal(stableNodePath({ execPath: b.real, brewPrefixes: [other.prefix] }).path, b.real);
  // A prefix without bin/brew isn't Homebrew.
  const fake = brew();
  writeFileSync(join(fake.prefix, 'bin', 'brew.not'), '');
  execFileSync('rm', [join(fake.prefix, 'bin', 'brew')]);
  assert.equal(stableNodePath({ execPath: fake.real, brewPrefixes: [fake.prefix] }).path, fake.real);
  for (const p of ['/home/example/.nvm/versions/node/v24.1.0/bin/node', '/home/example/.local/share/fnm/node-versions/v24/installation/bin/node', '/home/example/.asdf/installs/nodejs/24.1.0/bin/node', '/opt/homebrew/Cellar/node@22/22.13.0/bin/node']) assert.ok(inVersionedNodeDir(p), p);
});

test('#468 a `node` earlier on PATH is never what gets written: the local service and the pre-push hook name Homebrew\'s or this node\'s own path', { skip: posix }, () => {
  // A node planted first on PATH, even one that is this very node (a symlink to it), and Homebrew's beside it.
  const planted = realpathSync(mkdtempSync(join(tmpdir(), 'planted-')));
  symlinkSync(process.execPath, join(planted, 'node'));
  const env = { PATH: `${planted}:/usr/bin:/bin`, HOME: '/home/example' };
  const { dir: root } = exampleProject();
  const spec = localServiceSpec(root, loadConfig(root), env);
  assert.notEqual(spec.program[0], join(planted, 'node'), 'never the PATH node');
  assert.equal(spec.program[0], stableNodePath().path, "Homebrew's bin/node or this node's own path");
  for (const text of [launchdPlist(spec), systemdUserUnit(spec)]) assert.equal(programOf(text), spec.program[0]);
  // With a Homebrew whose bin/node is the node installing: that symlink, never the realpath, in the plist and the unit.
  // (A Homebrew of its own: the runner's real node may sit where others can write, which the rule rightly refuses.)
  const b = brew();
  const viaBrew = localServiceSpec(root, loadConfig(root), env, stableNodePath({ execPath: b.real, brewPrefixes: [b.prefix] }).path);
  assert.equal(viaBrew.program[0], b.link);
  assert.equal(programOf(launchdPlist(viaBrew)), b.link);
  assert.equal(programOf(systemdUserUnit(viaBrew)), b.link);
  // The checkout's pre-push hook: the same node, never the PATH one.
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: root });
  const hook = readFileSync(installCheckoutPrePush(root, ['main'], '/opt/engine/dist/src/cli.js', stableNodePath({ execPath: b.real, brewPrefixes: [b.prefix] }).path), 'utf8');
  assert.match(hook, re(b.link));
  assert.doesNotMatch(hook, re(join(planted, 'node')));
  assert.doesNotMatch(readFileSync(installCheckoutPrePush(root, ['main'], '/opt/engine/dist/src/cli.js'), 'utf8'), re(join(planted, 'node')));
});

test("#468 a server instance keeps its root-controlled absolute path: the credential helper is process.execPath, whatever PATH holds", { skip: posix }, () => {
  const planted = realpathSync(mkdtempSync(join(tmpdir(), 'planted-')));
  symlinkSync(process.execPath, join(planted, 'node'));
  const home = mkdtempSync(join(tmpdir(), 'inst-'));
  const i = { name: 'shop', home, stateDir: join(home, 'state'), credentials: { version: 1, github: { kind: 'app', app_id: 1, installation_id: 2, key_path: join(home, 'app.pem') } } } as unknown as Instance;
  const env = instanceEnv(i, { PATH: `${planted}:/usr/bin:/bin` });
  const helper = Object.entries(env).find(([k, v]) => k.startsWith('GIT_CONFIG_VALUE_') && String(v).includes('git-credential'))![1]!;
  assert.match(helper, new RegExp(`^!"${re(process.execPath).source}" ".*cli\\.js" git-credential$`));
});

test("#468 Homebrew's bin/node is named only if no other user can redirect it", { skip: posix }, () => {
  const b = brew();
  assert.equal(ownedPath(b.link), true);
  assert.equal(stableNodePath({ execPath: b.real, brewPrefixes: [b.prefix] }).path, b.link);
  chmodSync(join(b.prefix, 'bin'), 0o777);
  assert.equal(ownedPath(b.link), false, 'a bin/ anyone may write');
  assert.equal(stableNodePath({ execPath: b.real, brewPrefixes: [b.prefix] }).path, b.real, 'passed over: this node\'s own path');
  assert.equal(ownedPath('/x/node', { uid: 501, lstat: ((p: string) => ({ uid: p === '/x/node' ? 777 : 0, gid: 0, mode: 0o755, isSymbolicLink: () => false })) as never }), false, "another user's file");
  const groupDir = (gid: number) => ((p: string) => ({ uid: 0, gid: p === '/x' ? gid : 0, mode: p === '/x' ? 0o775 : 0o755, isSymbolicLink: () => false })) as never;
  assert.equal(ownedPath('/x/node', { uid: 501, lstat: groupDir(4242) }), false, 'a directory any member of an ordinary group may write');
  assert.equal(ownedPath('/x/node', { uid: 501, lstat: groupDir(0) }), true, "wheel's: its members are root already");
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
    serviceManagerEnv: () => ({ env: {} }),
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
  assert.match(gone.detail, new RegExp(`^${re(plist).source} runs node at /opt/homebrew/Cellar/node/26\\.7\\.0/bin/node, which no longer exists.*run \`${BRAND.cli} up\` to rewrite it`));
  const cellar = step(probe('/opt/homebrew/Cellar/node/26.7.0/bin/node', true));
  assert.equal(cellar.done, false);
  assert.match(cellar.detail, /inside a versioned directory: the next upgrade deletes it: run `.* up`/);
  assert.equal(step(probe('/opt/homebrew/bin/node', true)).done, true);
});
