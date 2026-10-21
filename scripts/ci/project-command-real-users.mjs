#!/usr/bin/env node
// CI only (the "Claude sign-in probe (real users)" job in .github/workflows/ci-slow.yml), issue #713: a project
// command (a check, a setup step, a full run), run as the coordinator user through its real sudoers rule to its real
// agent user, as the coordinator runs one. The agent user is signed in (its ~/.claude/.credentials.json) and holds an
// API key file where credentials.sh puts one; the agent user itself can read both. The project command can't.
//
//   node project-command-real-users.mjs <dir with dist/src> <agent user> <agent home> <a git checkout> [<root-owned symlink>]
// The last two: a symlink in a root-owned directory to <agent home>/secret-store, and one to <agent home>/secret-store/x/..
// (root makes them in the workflow).
//   node project-command-real-users.mjs <dist> <agent user> <agent home> <checkout> [<root-owned symlink> [<one with ..>]]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, user, home, checkout, linkPath, dotdotLink] = process.argv.slice(2);
if (!dist || !user || !home || !checkout) {
  console.error('usage: project-command-real-users.mjs <dist dir> <agent user> <agent home> <checkout>');
  process.exit(2);
}
const { asUser, projectCommand } = await import(pathToFileURL(join(dist, 'src', 'os', 'index.js')).href);
assert.notEqual(userInfo().username, user, 'run as the coordinator, not the agent user');

const login = join(home, '.claude', '.credentials.json');
const apiKey = join(home, '.config', 'probe-claude-key', 'api_key');
const run = (file, args, cwd) => spawnSync(file, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });

// Control: the agent user, outside any sandbox, reads both (so the planted files are there and readable to it).
for (const f of [login, apiKey]) {
  const [file, args] = asUser(user, '/bin/cat', [f], { PATH: '/usr/bin:/bin' });
  const r = run(file, args, '/');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sk-ant-/, `the agent user reads ${f} outside the sandbox`);
}
console.log('control: the agent user, unsandboxed, reads its login and its API key');

// The project command, as the coordinator builds it: the same files, by every path, read nothing.
const pc = projectCommand(`cat ${login} ${apiKey}; grep -rs sk-ant- "$HOME"; id -un`, { user, home, hide: [apiKey, ...(linkPath ? [join(linkPath, 'key')] : [])] });
const r = run(pc.file, pc.args, checkout);
console.log(`project command: exit ${r.status}; stdout ${JSON.stringify(r.stdout.slice(0, 400))}; stderr ${JSON.stringify(r.stderr.slice(0, 400))}`);
assert.ok(!/sk-ant-/.test(r.stdout + r.stderr), 'a project command read a credential');
assert.equal(r.stdout.trim().split('\n').pop(), user, 'it ran as the agent user');

// A hidden path through a symlink in a root-owned directory (which the agent can't change): followed, its target
// masked, and neither the symlink nor the target's directories can be moved by one command to unmask it for the next.
if (linkPath) {
  const store = join(home, 'secret-store', 'key');
  const [cf, ca] = asUser(user, '/bin/cat', [store], { PATH: '/usr/bin:/bin' });
  assert.match(run(cf, ca, '/').stdout, /sk-ant-/, 'the agent user reads its secret store outside the sandbox');
  const runAs = { user, home, hide: [join(linkPath, 'key')] };
  const read = projectCommand(`cat ${store} ${join(linkPath, 'key')}; true`, runAs);
  const r1 = run(read.file, read.args, checkout);
  assert.ok(!/sk-ant-/.test(r1.stdout + r1.stderr), `read through the root-owned symlink: ${r1.stdout}`);
  assert.equal(r1.status, 0, r1.stderr);
  const attack = projectCommand(`ln -sfn /tmp ${linkPath} 2>&1; mv ${join(home, 'secret-store')} ${join(home, 'moved')} 2>&1; true`, runAs);
  console.log(`root-owned symlink: the attack says ${JSON.stringify(run(attack.file, attack.args, checkout).stdout.slice(0, 300))}`);
  const r2 = run(read.file, read.args, checkout);
  const again = projectCommand(`cat ${store} ${join(home, 'moved', 'key')}; true`, runAs);
  const r3 = run(again.file, again.args, checkout);
  assert.ok(!/sk-ant-/.test(r2.stdout + r2.stderr + r3.stdout + r3.stderr), 'a command moved the secret out from under its mask');
  console.log('root-owned symlink: followed and masked; neither it nor its target could be moved away');
}
// A root-owned symlink whose target goes through `<store>/x/..`: the directory the `..` leaves is bound onto itself, so
// one command can't remove it to make the path resolve to nothing (and hide nothing) for the next.
if (dotdotLink) {
  const store = join(home, 'secret-store', 'key');
  const runAs = { user, home, hide: [join(dotdotLink, 'key')] };
  const attack = projectCommand(`rmdir ${join(home, 'secret-store', 'x')} 2>&1; true`, runAs);
  console.log(`root-owned link with a '..': the attack says ${JSON.stringify(run(attack.file, attack.args, checkout).stdout.slice(0, 200))}`);
  const read = projectCommand(`cat ${store}; true`, runAs);
  const r = run(read.file, read.args, checkout);
  assert.equal(r.status, 0, `still followed, not refused: ${r.stderr}`);
  assert.ok(!/sk-ant-/.test(r.stdout + r.stderr), 'the directory a `..` left was removed and the secret unmasked');
  console.log("root-owned link with a '..': the directory it leaves can't be removed; the secret stays masked");
}

// #798: the agent's home is read-only inside the sandbox. A project command can't plant ~/.bashrc or ~/.gitconfig for a
// later agent-user process outside it (a login shell, git) to run or read.
// (A failed `>>` is reported by the shell before any `2>&1` applies: the refusal is on stderr.)
const rcBefore = asUser(user, '/bin/cat', [join(home, '.bashrc')], { PATH: '/usr/bin:/bin' });
const before = run(rcBefore[0], rcBefore[1], '/').stdout;
const plant = projectCommand(`echo 'echo PLANTED-RC' >> "$HOME/.bashrc"; printf '[wl]\\n\\tplanted = PLANTED-GIT\\n' >> "$HOME/.gitconfig"; true`, { user, home, hide: [] });
const pr = run(plant.file, plant.args, checkout);
assert.equal(pr.status, 0, pr.stderr);
assert.match(pr.stderr, /\.bashrc: Read-only file system/, `a project command wrote the agent's ~/.bashrc: ${pr.stderr}`);
assert.match(pr.stderr, /\.gitconfig: Read-only file system/, `a project command wrote the agent's ~/.gitconfig: ${pr.stderr}`);
assert.equal(run(rcBefore[0], rcBefore[1], '/').stdout, before, "the agent's ~/.bashrc is unchanged");
const [lf, la] = asUser(user, '/bin/bash', ['--norc', '--noprofile', '-c', 'cat "$HOME/.bashrc" "$HOME/.gitconfig" 2>/dev/null; git config --global --get wl.planted; true'], { PATH: '/usr/bin:/bin', HOME: home });
const later = run(lf, la, '/');
assert.doesNotMatch(later.stdout, /PLANTED-/, `a later agent-user process read what a project command planted: ${later.stdout}`);
console.log("agent home: read-only to a project command; nothing planted for a later agent-user process");

// And a check that runs git in the coordinator's checkout still gets git's answer inside the sandbox.
const g = projectCommand('git diff --exit-code && git log -1 --format=%s', { user, home, hide: [] });
const gr = run(g.file, g.args, checkout);
assert.equal(gr.status, 0, gr.stderr);
console.log(`git in the checkout: ${gr.stdout.trim()}`);
console.log('\nOK: a project command run as the agent user reads neither its Claude login nor its API key');
