// Issue #798, round 2: the agent's home is read-only inside a project command's sandbox, but a symlink in it is
// followed. One that leads outside the home (to a directory the agent user can write) let a sandboxed command write
// what a later agent-user process outside the sandbox reads: ~/.profile, ~/.ssh, ~/.cache as links to /tmp or /var.
// So the run is refused, before anything of it runs, when an entry directly in the home or directly in ~/.config is
// a symlink resolving outside the home, or when ~/.cache or ~/.npm (the throwaway caches) is a symlink at all.
//
// No real sudo and no real state: the current user stands in for the agent user, and its "home" is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Namespace import: on the code before this change a name it lacks is undefined, not a load error.
import * as osAdapter from '../src/os/index.js';

const posix = process.platform === 'linux';
const BWRAP = '/usr/bin/bwrap';
const sandboxRuns = posix && spawnSync(BWRAP, ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const realSkip = process.env.PROJECT_SANDBOX_REQUIRED === '1' ? false : !posix ? 'bubblewrap is Linux only' : !sandboxRuns && `no usable ${BWRAP} here (ci-slow's real-users job runs this with it)`;

/** A project command as projectCommand builds it for the agent user, run as this user: its argv after `sudo -n -u <agent> --`. */
function asStandIn(command: string, home: string, cwd: string) {
  const pc = osAdapter.projectCommand(command, { user: 'shop-agent', home, hide: [] }, {});
  return spawnSync(pc.args[4]!, pc.args.slice(5), { cwd, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A temp agent home, a working directory, and a directory outside the home that the agent user can write. */
function layout() {
  const root = mkdtempSync(join(tmpdir(), 'wl-798-ln-'));
  const home = join(root, 'agent');
  const outside = join(root, 'outside');
  const work = join(root, 'work');
  for (const d of [home, outside, work]) mkdirSync(d);
  writeFileSync(join(home, '.bashrc'), '# own\n');
  return { root, home, outside, work };
}

/** Refused before anything ran: exit 125, no ran.txt, the link named. */
function refused(r: ReturnType<typeof asStandIn>, work: string, link: string) {
  assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, `not refused: ${r.stdout}${r.stderr}`);
  assert.ok(!existsSync(join(work, 'ran.txt')), 'the command ran');
  assert.ok(r.stderr.includes(`'${link}'`), `the link isn't named: ${r.stderr}`);
}

const OUTWARD: [what: string, rel: string, dir: boolean, write: string][] = [
  ['~/.profile, a file', '.profile', false, 'echo planted >> ~/.profile'],
  ['~/.ssh, a directory', '.ssh', true, 'echo "Host *" > ~/.ssh/config'],
  ['~/.local, a directory (~/.local/bin is on a login PATH)', '.local', true, 'mkdir -p ~/.local/bin && echo planted > ~/.local/bin/claude'],
];
for (const [what, rel, dir, write] of OUTWARD) {
  test(`a symlink in the home that leads outside it is refused before the command runs: ${what}`, { skip: realSkip }, () => {
    const p = layout();
    const target = join(p.outside, rel.slice(1));
    if (dir) mkdirSync(target);
    else writeFileSync(target, '# outside\n');
    symlinkSync(target, join(p.home, rel));
    const r = asStandIn(`echo ran > ran.txt; ${write}`, p.home, p.work);
    refused(r, p.work, join(p.home, rel));
    assert.match(r.stderr, /outside the agent user's home/);
    if (dir) assert.deepEqual(readdirSync(target), [], 'written through the link');
    else assert.equal(readFileSync(target, 'utf8'), '# outside\n', 'written through the link');
  });
}

test('a relative symlink that climbs out of the home, and a dangling one pointing outside, are refused too', { skip: realSkip }, () => {
  const p = layout();
  writeFileSync(join(p.outside, 'gitconfig'), '[user]\n');
  symlinkSync('../outside/gitconfig', join(p.home, '.gitconfig'));
  refused(asStandIn('echo ran > ran.txt', p.home, p.work), p.work, join(p.home, '.gitconfig'));
  const q = layout();
  symlinkSync(join(q.outside, 'not-yet', 'npmrc'), join(q.home, '.npmrc'));
  refused(asStandIn('echo ran > ran.txt; mkdir -p ' + join(q.outside, 'not-yet') + ' && echo planted > ~/.npmrc', q.home, q.work), q.work, join(q.home, '.npmrc'));
  assert.ok(!existsSync(join(q.outside, 'not-yet')), 'the dangling link\'s target was made');
});

test('a symlink directly in ~/.config that leads outside the home is refused', { skip: realSkip }, () => {
  const p = layout();
  mkdirSync(join(p.home, '.config'));
  mkdirSync(join(p.outside, 'git'));
  symlinkSync(join(p.outside, 'git'), join(p.home, '.config', 'git'));
  const r = asStandIn('echo ran > ran.txt; echo "[core]" > ~/.config/git/config', p.home, p.work);
  refused(r, p.work, join(p.home, '.config', 'git'));
  assert.deepEqual(readdirSync(join(p.outside, 'git')), []);
});

for (const cache of ['.cache', '.npm']) {
  test(`~/${cache} as a symlink is refused, outside the home or in it: a throwaway cache is never followed through a link`, { skip: realSkip }, () => {
    const p = layout();
    mkdirSync(join(p.outside, 'c'));
    symlinkSync(join(p.outside, 'c'), join(p.home, cache));
    const r = asStandIn(`echo ran > ran.txt; echo persist > ~/${cache}/persist`, p.home, p.work);
    refused(r, p.work, join(p.home, cache));
    assert.deepEqual(readdirSync(join(p.outside, 'c')), [], 'written through the link, and it outlived the command');
    const q = layout();
    mkdirSync(join(q.home, 'big-disk'));
    symlinkSync(join(q.home, 'big-disk'), join(q.home, cache));
    refused(asStandIn('echo ran > ran.txt', q.home, q.work), q.work, join(q.home, cache));
  });
}

test('a refusal names every outward link at once, with what it points to and how to remove it as the agent user', { skip: realSkip }, () => {
  const p = layout();
  writeFileSync(join(p.outside, 'profile'), '');
  mkdirSync(join(p.outside, 'ssh'));
  symlinkSync(join(p.outside, 'profile'), join(p.home, '.profile'));
  symlinkSync(join(p.outside, 'ssh'), join(p.home, '.ssh'));
  const r = asStandIn('echo ran > ran.txt', p.home, p.work);
  refused(r, p.work, join(p.home, '.profile'));
  for (const rel of ['.profile', '.ssh']) {
    assert.ok(r.stderr.includes(`'${join(p.home, rel)}' is a symlink to '${join(p.outside, rel.slice(1))}'`), r.stderr);
    assert.ok(r.stderr.includes(`sudo -u shop-agent rm -- '${join(p.home, rel)}'`), r.stderr);
  }
});

test('symlinks that stay inside the home are fine: the command runs, and what they lead to stays read-only', { skip: realSkip }, () => {
  const p = layout();
  mkdirSync(join(p.home, 'dotfiles'));
  writeFileSync(join(p.home, 'dotfiles', 'profile'), '# own\n');
  symlinkSync(join(p.home, 'dotfiles', 'profile'), join(p.home, '.profile'));
  symlinkSync('dotfiles', join(p.home, '.dots'));
  const r = asStandIn('echo ran > ran.txt; echo planted >> ~/.profile; echo planted > ~/.dots/new; true', p.home, p.work);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(p.work, 'ran.txt')));
  assert.equal(readFileSync(join(p.home, 'dotfiles', 'profile'), 'utf8'), '# own\n');
  assert.ok(!existsSync(join(p.home, 'dotfiles', 'new')));
});

test('a home holding more symlinks than the wrapper checks is refused, never run with some unchecked', { skip: realSkip }, () => {
  const p = layout();
  mkdirSync(join(p.home, 'd'));
  for (let i = 0; i <= 500; i++) symlinkSync('d', join(p.home, `.l${i}`));
  const r = asStandIn('echo ran > ran.txt', p.home, p.work);
  assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, `not refused: ${r.stderr}`);
  assert.ok(!existsSync(join(p.work, 'ran.txt')), 'the command ran');
  assert.match(r.stderr, /more than 500 symlinks/);
});
