#!/usr/bin/env node
// CI's stand-in for `claude auth status --json` (the real-systemd job, scripts/setup/claude-account.sh): signed in when
// the calling user's own login holds a setup token ($CLAUDE_CONFIG_DIR/.credentials.json, as the real claude reads it:
// an account profile's; else ~/.claude/.credentials.json), unless that user is listed in
// /etc/ci-claude-fail (one user per line), which a test writes to make a check fail. It names the account by the
// token's last 4 characters, never the token. The login's proof (issue #463: one minimal real call, `-p "Reply with the
// single word: ok" ...`) is answered when signed in, unless the token's last 4 characters are listed in
// /etc/ci-claude-refuse, which a test writes to make the API refuse a login: then a 401 as claude prints it. Anything
// else it is asked: exit 2. `auth login` (the relayed sign-in, claude-account.sh login): prints a sign-in link whose
// redirect is Anthropic's code page, reads the pasted code on stdin and, when it is the one in /etc/ci-claude-login
// (root's, 0644: "<code> <token>"), stores that token as this user's login in CLAUDE_CONFIG_DIR; else exit 1.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const proof = args[0] === '-p' && args[1] === 'Reply with the single word: ok';
if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write("Opening browser to sign in… If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&client_id=ci&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=ci-relayed-link-4s7\nPaste code here if prompted > ");
  let line = '';
  const b = Buffer.alloc(1);
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, b, 0, 1, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      break;
    }
    if (!n || b[0] === 10) break;
    line += String.fromCharCode(b[0]);
  }
  let want = ['', ''];
  try {
    want = fs.readFileSync('/etc/ci-claude-login', 'utf8').trim().split(' ');
  } catch {
    // no sign-in expected
  }
  if (!want[0] || line !== want[0]) {
    process.stdout.write('\nInvalid code\n');
    process.exit(1);
  }
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: want[1], refreshToken: 'ci' } }), { mode: 0o600 });
  process.stdout.write('\nLogin successful.\n');
  process.exit(0);
}
if (!proof && (args[0] !== 'auth' || args[1] !== 'status')) {
  process.stderr.write(`claude stand-in: only auth status and the login's proof (asked: ${args.join(' ')})\n`);
  process.exit(2);
}
const user = os.userInfo().username;
let token = '';
try {
  token = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8')).claudeAiOauth.accessToken || '';
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
if (proof) {
  let refused = [];
  try {
    refused = fs.readFileSync('/etc/ci-claude-refuse', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // none refused
  }
  if (ok && !refused.includes(token.slice(-4))) {
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 })}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key · Please run /login' })}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(ok ? { loggedIn: true, authMethod: 'claude.ai', email: `agents-${token.slice(-4)}@example.test`, subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }, null, 2)}\n`);
