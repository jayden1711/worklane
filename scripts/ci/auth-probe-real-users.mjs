#!/usr/bin/env node
// CI only (the "Claude sign-in probe (real users)" job in .github/workflows/ci-slow.yml): the watchdog's `claude auth
// status` probe, run as the instance's coordinator user through its real sudoers rule to its real agent user, as the
// coordinator's service runs it. The stand-in claude (scripts/ci/claude-stand-in.cjs) says signed in only when a
// login is stored under the HOME it is given, and only the agent user's home holds one.
//
//   node auth-probe-real-users.mjs <dir with dist/src> <agent user> <agent home>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, user, home] = process.argv.slice(2);
if (!dist || !user || !home) {
  console.error('usage: auth-probe-real-users.mjs <dist dir> <agent user> <agent home>');
  process.exit(2);
}
const load = (m) => import(pathToFileURL(join(dist, 'src', m)).href);
const { claudeAuthStatus, claudeAuthStatusJson } = await load('runner.js');
const { asUser } = await load('os/index.js');

const runAs = { user, home };
console.log(`as ${userInfo().username} (HOME=${process.env.HOME}), probing ${user} (home ${home})`);
assert.notEqual(userInfo().username, user, 'run as the coordinator, not the agent user');

// Control: the agent user with the coordinator's environment (what the probe did before) finds no login.
const [file, args] = asUser(user, 'claude', ['auth', 'status', '--json'], process.env);
const before = spawnSync(file, args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
console.log(`with the coordinator's HOME: ${before.stdout.trim()} ${before.stderr.trim()}`);
assert.equal(JSON.parse(before.stdout).loggedIn, false, "the stand-in finds no login in the coordinator's home");

// The watchdog's probe (src/watchdog/wire.ts) and the runs' preflight, as production calls them.
const probe = claudeAuthStatusJson(process.env, runAs);
console.log(`the watchdog's probe: ${JSON.stringify(probe)}`);
assert.deepEqual(probe, { loggedIn: true }, "the watchdog's probe finds the agent user's login");
const status = claudeAuthStatus(process.env, runAs);
console.log(`claudeAuthStatus: ${JSON.stringify(status)}`);
assert.equal(status.method, 'claude.ai');
console.log('\nOK: the probe finds the agent user signed in');
