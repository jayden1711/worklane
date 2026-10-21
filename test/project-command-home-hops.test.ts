// Issue #798, round 3: a link directly in the agent's home is walked hop by hop, as the credential paths are. Where it
// resolves isn't enough: `~/.profile -> /x/hop/profile` with `/x/hop -> ~/dotfiles` resolves inside the home, yet a
// command can re-aim /x/hop (the agent's) and then write ~/.profile's new target. And a link whose every hop only root
// can change (a skeleton's `~/.ghcup -> /usr/local/.ghcup`, `~/.bash_history -> /dev/null`) must not stop every
// project command: it is allowed, and what it reaches is read-only inside the sandbox.
//
// No real sudo and no real state: the current user stands in for the agent user, and its "home" is a temp dir. The
// root-owned targets are the machine's own (/usr/share, /etc/passwd, /dev/null), only read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// Namespace import: on the code before this change a name it lacks is undefined, not a load error.
import * as osAdapter from '../src/os/index.js';

const posix = process.platform === 'linux';
const BWRAP = '/usr/bin/bwrap';
const sandboxRuns = posix && spawnSync(BWRAP, ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const realSkip = process.env.PROJECT_SANDBOX_REQUIRED === '1' ? false : !posix ? 'bubblewrap is Linux only' : !sandboxRuns && `no usable ${BWRAP} here (ci-slow's real-users job runs this with it)`;

function asStandIn(command: string, home: string, cwd: string) {
  const pc = osAdapter.projectCommand(command, { user: 'shop-agent', home, hide: [] }, {});
  return spawnSync(pc.args[4]!, pc.args.slice(5), { cwd, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function layout() {
  const root = mkdtempSync(join(tmpdir(), 'wl-798-hop-'));
  const home = join(root, 'agent');
  const outside = join(root, 'outside');
  const work = join(root, 'work');
  for (const d of [home, outside, work, join(home, 'dotfiles')]) mkdirSync(d);
  writeFileSync(join(home, 'dotfiles', 'profile'), '# own\n');
  return { root, home, outside, work };
}

function refused(r: ReturnType<typeof asStandIn>, work: string, link: string) {
  assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, `not refused: ${r.stdout}${r.stderr}`);
  assert.ok(!existsSync(join(work, 'ran.txt')), 'the command ran');
  assert.ok(r.stderr.includes(`'${link}'`), `the link isn't named: ${r.stderr}`);
}

test('a link that resolves inside the home through a hop the agent can re-aim outside it is refused (the hop bypass)', { skip: realSkip }, () => {
  const p = layout();
  // ~/.profile -> <outside>/hop/profile, <outside>/hop -> ~/dotfiles: readlink -m says ~/dotfiles/profile, inside.
  symlinkSync(join(p.home, 'dotfiles'), join(p.outside, 'hop'));
  symlinkSync(join(p.outside, 'hop', 'profile'), join(p.home, '.profile'));
  const evil = join(p.outside, 'evil');
  const r = asStandIn(`echo ran > ran.txt; mkdir -p ${evil}; ln -sfn ${evil} ${join(p.outside, 'hop')}; echo PLANTED > ~/.profile`, p.home, p.work);
  refused(r, p.work, join(p.home, '.profile'));
  assert.ok(r.stderr.includes(`'${join(p.outside, 'hop')}'`), `the hop isn't named: ${r.stderr}`);
  assert.ok(!existsSync(evil), 'the hop was re-aimed');
  assert.equal(readFileSync(join(p.home, '.profile'), 'utf8'), '# own\n', '~/.profile reads what the command planted');
});

test('a hop in a directory the agent can write but doesn\'t own (root\'s, world-writable, as a group-writable one would be) is refused', { skip: realSkip }, () => {
  const p = layout();
  // A link in /tmp itself: root owns /tmp, everyone may write it (sticky), so the agent could replace a link of its own there.
  const hop = join('/tmp', `wl-798-hop-${randomBytes(8).toString('hex')}`);
  symlinkSync(join(p.home, 'dotfiles'), hop);
  try {
    symlinkSync(join(hop, 'profile'), join(p.home, '.profile'));
    const r = asStandIn('echo ran > ran.txt', p.home, p.work);
    refused(r, p.work, join(p.home, '.profile'));
  } finally {
    rmSync(hop, { force: true });
  }
});

test('links whose every hop only root can change are allowed (a skeleton\'s links), and what they reach stays read-only', { skip: realSkip }, () => {
  const p = layout();
  // As /etc/skel can hold on a real machine (the CI runner's has ~/.ghcup -> /usr/local/.ghcup): a root-owned
  // directory, a root-owned file, a device, and a dangling link into a root-owned directory nobody else can fill.
  symlinkSync('/usr/share', join(p.home, '.skel-dir'));
  symlinkSync('/etc/passwd', join(p.home, '.skel-file'));
  symlinkSync('/dev/null', join(p.home, '.bash_history'));
  symlinkSync(`/usr/share/wl-798-absent-${randomBytes(4).toString('hex')}`, join(p.home, '.skel-absent'));
  const r = asStandIn('echo ran > ran.txt; ls ~/.skel-dir > /dev/null && echo listed; head -c1 ~/.skel-file > /dev/null && echo read; echo gone > ~/.bash_history && echo devnull; touch ~/.skel-dir/wl-798 2>&1; true', p.home, p.work);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(p.work, 'ran.txt')), 'the command ran');
  assert.match(r.stdout, /listed\nread\ndevnull/);
  assert.match(r.stdout, /Read-only file system|Permission denied/, 'nothing written through the link');
});
