// Issue #798, round 6 (the round-5 delta check): a symlink in the agent's home is walked hop by hop, and the
// directories on its way are pinned (bound onto themselves). A way into /proc (`~/.x -> /proc/1/comm`, or
// `/dev/stdout`, which leads to /proc/self/fd/1) pinned /proc, which bound the host's /proc over the sandbox's own: a
// project command saw every process outside it, which #713 had closed. And a way through a symlink under /dev, or a
// `..` out of a directory there, pinned /dev, which cost the sandbox its devices. Now each is refused before the
// command runs, naming the link, as a credential path there always was.
//
// No sudo, no namespace and no real state: the current user stands in for the agent user, and its "home" is a temp
// dir. The refusals come before the sandbox starts; the one allowed case (/dev/null) needs bubblewrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as osAdapter from '../src/os/index.js';

const posix = process.platform === 'linux';
const BWRAP = '/usr/bin/bwrap';
const sandboxRuns = posix && spawnSync(BWRAP, ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const skip = !posix && 'the Linux wrapper';
const realSkip = process.env.PROJECT_SANDBOX_REQUIRED === '1' ? false : !posix ? 'bubblewrap is Linux only' : !sandboxRuns && `no usable ${BWRAP} here`;

/** A temp agent home holding `.x -> target`, and a working directory; the command run as this user. */
function run(target: string, command: string) {
  const root = mkdtempSync(join(tmpdir(), 'wl-798-devproc-'));
  const home = join(root, 'agent');
  const work = join(root, 'work');
  for (const d of [home, work]) mkdirSync(d);
  symlinkSync(target, join(home, '.x'));
  const pc = osAdapter.projectCommand(command, { user: 'shop-agent', home, hide: [] }, {});
  const r = spawnSync(pc.args[4]!, pc.args.slice(5), { cwd: work, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { r, link: join(home, '.x'), work };
}

const REFUSED: [target: string, why: RegExp][] = [
  ['/proc/1/comm', /goes through \/proc or \/sys/],
  ['/proc/self/status', /goes through \/proc or \/sys/],
  ['/sys/kernel', /goes through \/proc or \/sys/],
  ['/dev/stdout', /goes through a symlink under \/dev/],
  ['/dev/fd/0', /goes through a symlink under \/dev/],
  ['/dev/../etc/passwd', /climbs out of a directory under \/dev/],
  ['/dev', /under \/dev but not a device/],
];
for (const [target, why] of REFUSED) {
  test(`a link in the home to ${target} is refused before the command runs: its way can't be pinned without the host's /proc over the sandbox's, or without /dev`, { skip }, () => {
    const { r, link, work } = run(target, 'echo ran > ran.txt; cat /proc/1/cmdline > pid1.txt; true');
    assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, `not refused: ${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(join(work, 'ran.txt')), 'the command ran');
    assert.ok(r.stderr.includes(`'${link}'`), `the link isn't named: ${r.stderr}`);
    assert.match(r.stderr, why, r.stderr);
  });
}

test('a link in the home to /dev/null still runs, with the sandbox its own PID 1 and its devices', { skip: realSkip }, () => {
  const { r, work } = run('/dev/null', 'echo ran > ran.txt; tr "\\0" " " < /proc/1/cmdline > pid1.txt; echo x > /dev/null && echo devnull > dev.txt; true');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(work, 'ran.txt')), 'the command did not run');
  assert.match(readFileSync(join(work, 'pid1.txt'), 'utf8'), /bwrap/, "PID 1 isn't the sandbox's own");
  assert.ok(existsSync(join(work, 'dev.txt')), `/dev/null isn't usable: ${r.stderr}`);
});
