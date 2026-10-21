// Issue #798: a project command runs as the agent user inside bubblewrap (#713). The agent's home was writable there,
// so one command could plant config (~/.bashrc, ~/.profile, ~/.gitconfig, ~/.npmrc, ...) that a later agent-user
// process outside the sandbox reads and acts on: a login shell, git, npm, the agent's own claude. Now the home is
// read-only inside the sandbox; only its caches (~/.cache, ~/.npm) are writable, each a tmpfs that is gone when the
// command ends.
//
// No real sudo and no real state: the current user stands in for the agent user (the command's own `env -i ...`, run
// without the `sudo -n -u <agent> --` in front of it), and its "home" is a temp dir. The "later agent-user process"
// is this user with HOME at that temp dir, reading the files a login shell and git read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// Namespace import: on the code before #798 a name it lacks is undefined, not a load error.
import * as osAdapter from '../src/os/index.js';

const posix = process.platform === 'linux';
const BWRAP = '/usr/bin/bwrap';
const sandboxRuns = posix && spawnSync(BWRAP, ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const realSkip = process.env.PROJECT_SANDBOX_REQUIRED === '1' ? false : !posix ? 'bubblewrap is Linux only' : !sandboxRuns && `no usable ${BWRAP} here (ci-slow's real-users job runs this with it)`;

/** A project command as projectCommand builds it for the agent user, run as this user: its argv after `sudo -n -u <agent> --`. */
function asStandIn(command: string, home: string, cwd: string, hide: readonly string[] = []) {
  const pc = osAdapter.projectCommand(command, { user: 'shop-agent', home, hide }, {});
  assert.deepEqual(pc.args.slice(0, 5), ['-n', '-u', 'shop-agent', '--', '/usr/bin/env']);
  return spawnSync(pc.args[4]!, pc.args.slice(5), { cwd, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** An agent home with a stand-in login, an ordinary ~/.bashrc and ~/.gitconfig, and a working directory outside it. */
function agentHome() {
  const root = mkdtempSync(join(tmpdir(), 'wl-798-'));
  const home = join(root, 'agent');
  const login = `PLANTED-LOGIN-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), `${login}\n`, { mode: 0o600 });
  writeFileSync(join(home, '.bashrc'), '# the agent user\'s own\n');
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Agent Stand-in\n');
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  const work = join(root, 'work');
  mkdirSync(work);
  return { root, home, login, work, loot: join(root, 'loot') };
}

/**
 * What a later agent-user process outside the sandbox reads from its home: a login shell's startup files (sourced
 * as bash would, without the machine's /etc/profile) and git's global config. Never the real home: HOME is the temp one.
 */
function laterAgentProcess(home: string, cwd: string) {
  const script = 'for f in .bash_profile .bash_login .profile .bashrc; do [ -r "$HOME/$f" ] && . "$HOME/$f"; done; git config --global --get-all wl.planted; true';
  return spawnSync('/bin/bash', ['--norc', '--noprofile', '-c', script], { cwd, env: { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Each file an unsandboxed agent-user process reads as config or runs: shell startup, git, npm, ssh, PATH entries.
const PLANTS: [name: string, rel: string][] = [
  ['~/.bashrc (appended)', '.bashrc'],
  ['~/.bash_profile', '.bash_profile'],
  ['~/.bash_login', '.bash_login'],
  ['~/.profile', '.profile'],
  ['~/.gitconfig (appended)', '.gitconfig'],
  ['~/.config/git/config', '.config/git/config'],
  ['~/.npmrc', '.npmrc'],
  ['~/.ssh/config', '.ssh/config'],
  ['~/.local/bin/claude', '.local/bin/claude'],
];

test('a sandboxed command can\'t write the agent\'s shell startup files, git, npm or ssh config, or a PATH entry in its home', { skip: realSkip }, () => {
  const p = agentHome();
  const steal = `cat ${JSON.stringify(join(p.home, '.claude', '.credentials.json'))} >> ${JSON.stringify(p.loot)} 2>/dev/null`;
  const attack = PLANTS.map(([, rel]) => {
    const target = join(p.home, rel);
    const body = rel.includes('git') ? `[wl]\\n\\tplanted = PLANTED-GIT\\n` : `${steal}\\n`;
    return `{ mkdir -p ${JSON.stringify(join(target, '..'))} 2>/dev/null; printf '${body}' >> ${JSON.stringify(target)}; } 2>/dev/null && echo "WROTE ${rel}" || echo "REFUSED ${rel}"`;
  }).join('; ');
  const r = asStandIn(attack, p.home, p.work);
  assert.equal(r.status, 0, r.stderr);
  for (const [what, rel] of PLANTS) assert.ok(r.stdout.includes(`REFUSED ${rel}`), `${what}: the sandboxed command wrote it: ${r.stdout}`);
  assert.equal(readFileSync(join(p.home, '.bashrc'), 'utf8'), '# the agent user\'s own\n', '~/.bashrc unchanged');
  assert.equal(readFileSync(join(p.home, '.gitconfig'), 'utf8'), '[user]\n\tname = Agent Stand-in\n', '~/.gitconfig unchanged');
  for (const rel of ['.bash_profile', '.bash_login', '.profile', '.npmrc', '.ssh', '.local', '.config/git/config']) assert.ok(!existsSync(join(p.home, rel)), `~/${rel} was created`);
  // And the later agent-user process outside the sandbox finds nothing planted to run or read.
  const later = laterAgentProcess(p.home, p.work);
  assert.ok(!existsSync(p.loot) || !readFileSync(p.loot, 'utf8').includes(p.login), 'a planted startup file read the login outside the sandbox');
  assert.doesNotMatch(later.stdout, /PLANTED-GIT/, 'a planted git config reached git outside the sandbox');
});

test('a sandboxed command can\'t rename, remove or chmod what its home holds, nor create anything new in it', { skip: realSkip }, () => {
  const p = agentHome();
  writeFileSync(join(p.home, 'notes.txt'), 'ordinary\n');
  const r = asStandIn('mv ~/.bashrc ~/.bashrc.bak 2>&1; rm -f ~/notes.txt 2>&1; chmod 777 ~ 2>&1; ln -s /tmp ~/.cargo 2>&1; mkdir ~/.config/autostart 2>&1; touch ~/.hushlogin 2>&1; true', p.home, p.work);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(p.home, '.bashrc')) && !existsSync(join(p.home, '.bashrc.bak')), 'renamed');
  assert.ok(existsSync(join(p.home, 'notes.txt')), 'removed');
  for (const rel of ['.cargo', '.config/autostart', '.hushlogin']) assert.ok(!existsSync(join(p.home, rel)), `~/${rel} created`);
  assert.match(r.stdout, /Read-only file system/);
});

test('its caches (~/.cache, ~/.npm) are writable inside the command and gone after it; the checkout and its reads are as before', { skip: realSkip }, () => {
  const p = agentHome();
  // ~/.cache there already, with what an earlier run left; no ~/.npm yet (a new agent user): npm needs one it can
  // write, or `npm ci` fails (measured on #798).
  mkdirSync(join(p.home, '.cache'));
  const r =asStandIn('echo c > ~/.cache/probe && mkdir -p ~/.npm/_cacache && echo n > ~/.npm/_cacache/probe && cat ~/.cache/probe ~/.npm/_cacache/probe && git config --global user.name && echo built > out.txt', p.home, p.work);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['c', 'n', 'Agent Stand-in'], 'caches written and read back; the home\'s config still readable');
  assert.ok(existsSync(join(p.work, 'out.txt')), 'the command still writes its own working directory');
  for (const d of ['.cache', '.npm']) assert.deepEqual(existsSync(join(p.home, d)) ? readdirSync(join(p.home, d)) : [], [], `~/${d} kept what a command wrote`);
  // A second command starts from the same empty caches: nothing one command leaves there reaches the next.
  const again = asStandIn('ls -A ~/.cache ~/.npm; true', p.home, p.work);
  assert.doesNotMatch(again.stdout, /probe|_cacache/, again.stdout);
});

test('a cache that is a symlink into the home is not made writable: what it points to stays read-only', { skip: realSkip }, () => {
  const p = agentHome();
  symlinkSync(join(p.home, '.config'), join(p.home, '.cache'));
  const r = asStandIn('echo x > ~/.cache/planted 2>&1; true', p.home, p.work);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(p.home, '.config', 'planted')), 'wrote through the symlink into ~/.config');
});

test('a home that isn\'t a directory, or is /, is refused before anything runs: there is no home to make read-only', { skip: !posix && 'bubblewrap is Linux only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-798-nohome-'));
  for (const home of [join(root, 'no-such-home'), '/']) {
    const r = asStandIn('echo ran > ran.txt', home, root);
    assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, `${home}: ${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(join(root, 'ran.txt')), `${home}: the command ran`);
    assert.match(r.stderr, /project command not run: the agent user's home .* read-only/, r.stderr);
  }
});

test('macOS: the sandbox profile denies every write under the agent\'s home, and refuses a home of /', () => {
  const s = osAdapter.seatbeltProfile('/var/agent.home', []);
  assert.ok(s.includes('(deny file-write* (subpath "/var/agent.home"))'), s);
  assert.throws(() => osAdapter.seatbeltProfile('/', []), /home/);
});
