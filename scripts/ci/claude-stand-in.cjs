#!/usr/bin/env node
// CI's stand-in for `claude auth status --json` (the real-systemd job, scripts/setup/claude-account.sh): signed in when
// the calling user's own ~/.claude/.credentials.json holds a setup token, unless that user is listed in
// /etc/ci-claude-fail (one user per line), which a test writes to make a check fail. It names the account by the
// token's last 4 characters, never the token. Anything else it is asked: exit 2.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
if (args[0] !== 'auth' || args[1] !== 'status') {
  process.stderr.write(`claude stand-in: only auth status (asked: ${args.join(' ')})\n`);
  process.exit(2);
}
const user = os.userInfo().username;
let token = '';
try {
  token = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken || '';
} catch {
  // no login stored
}
let failing = [];
try {
  failing = fs.readFileSync('/etc/ci-claude-fail', 'utf8').split('\n').map((s) => s.trim());
} catch {
  // none listed
}
const ok = /^sk-ant-oat01-/.test(token) && !failing.includes(user);
process.stdout.write(`${JSON.stringify(ok ? { loggedIn: true, authMethod: 'claude.ai', email: `agents-${token.slice(-4)}@example.test`, subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }, null, 2)}\n`);
