#!/usr/bin/env node
// CI only (the "Claude sign-in probe (real users)" job in .github/workflows/ci-slow.yml), issue #713: a project
// command (a check, a setup step, a full run), run as the coordinator user through its real sudoers rule to its real
// agent user, as the coordinator runs one. The agent user is signed in (its ~/.claude/.credentials.json) and holds an
// API key file where credentials.sh puts one; the agent user itself can read both. The project command can't.
//
//   node project-command-real-users.mjs <dir with dist/src> <agent user> <agent home> <a git checkout>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, user, home, checkout] = process.argv.slice(2);
if (!dist || !user || !home || !checkout) {
  console.error('usage: project-command-real-users.mjs <dist dir> <agent user> <agent home> <checkout>');
  process.exit(2);
}
const { asUser, projectCommand } = await import(pathToFileURL(join(dist, 'src', 'os', 'index.js')).href);
assert.notEqual(userInfo().username, user, 'run as the coordinator, not the agent user');

const login = join(home, '.claude', '.credentials.json');
const apiKey = join(home, '.config', 'probe-claude-key', 'api_key');
const run = (file, args, cwd) => spawnSync(file, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 });

// Control: the agent user, outside any sandbox, reads both (so the planted files are there and readable to it).
for (const f of [login, apiKey]) {
  const [file, args] = asUser(user, '/bin/cat', [f], { PATH: '/usr/bin:/bin' });
  const r = run(file, args, '/');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sk-ant-/, `the agent user reads ${f} outside the sandbox`);
}
console.log('control: the agent user, unsandboxed, reads its login and its API key');

// The project command, as the coordinator builds it: the same files, by every path, read nothing.
const pc = projectCommand(`cat ${login} ${apiKey}; grep -rs sk-ant- "$HOME"; id -un`, { user, home, hide: [apiKey] });
const r = run(pc.file, pc.args, checkout);
console.log(`project command: exit ${r.status}; stdout ${JSON.stringify(r.stdout.slice(0, 400))}; stderr ${JSON.stringify(r.stderr.slice(0, 400))}`);
assert.ok(!/sk-ant-/.test(r.stdout + r.stderr), 'a project command read a credential');
assert.equal(r.stdout.trim().split('\n').pop(), user, 'it ran as the agent user');

// And a check that runs git in the coordinator's checkout still gets git's answer inside the sandbox.
const g = projectCommand('git diff --exit-code && git log -1 --format=%s', { user, home });
const gr = run(g.file, g.args, checkout);
assert.equal(gr.status, 0, gr.stderr);
console.log(`git in the checkout: ${gr.stdout.trim()}`);
console.log('\nOK: a project command run as the agent user reads neither its Claude login nor its API key');
