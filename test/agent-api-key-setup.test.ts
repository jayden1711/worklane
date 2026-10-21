// Issue #897: an Anthropic API key as the agents' login, end to end on a server.
// - `credentials.sh <name> api-key` writes credentials.yaml's agent_api_key itself, as the coordinator user through
//   the engine's own config code (`instance set-agent-api-key`, path only), once claude reports an API-key login as
//   the agent user; then refreshes the instance's account record (claude-account.sh status), as the `claude` branch does.
// - `instance set-agent-api-key` takes only this instance's key place in its agent user's home (the user database's,
//   never instance.yaml's), to a key file this user can't read. Defense in depth, not a boundary: the coordinator user
//   writes credentials.yaml anyway.
// - The setup step other-keys, run as the coordinator user (who can't see into the agent user's home), reports the key
//   from root's account record, never "isn't there", and only at that place.
// Every host tool is a stand-in: no sudo, no claude, no real user database, no real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { AGENT, canHide, coordinatorView, engineInstance, KEY, posix, setupDir } from './api-key-fixtures.js';

/** Not `timeout`: lib.sh's run_as_bounded uses it (#904), and it runs nothing of the machine's. */
const HOST_TOOLS = ['sudo', 'systemctl', 'loginctl', 'launchctl', 'getent', 'useradd', 'usermod', 'gh', 'docker', 'tailscale', 'shred'];

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'agent-api-key-setup-state-'));

/**
 * credentials.sh in a temp dir, beside a lib.sh that sources the real one with users, homes, sudo and run_as pointed
 * into the temp dir (each records who it ran as), a stand-in claude-account.sh, and a stand-in `worklane` CLI and
 * `claude` on PATH. What claude auth status says as a user is <root>/claude-status-<user>.
 */
function box(o: { creds?: boolean; auth?: object | null } = {}) {
  const T = mkdtempSync(join(tmpdir(), 'credentials-key-'));
  const s = join(T, 'scripts', 'setup');
  const bin = join(T, 'bin');
  for (const d of [s, bin, join(T, 'users')]) mkdirSync(d, { recursive: true });
  copyFileSync(join(setupDir, 'credentials.sh'), join(s, 'credentials.sh'));
  for (const tool of HOST_TOOLS) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "host ${tool} $*" >> ${JSON.stringify(join(T, 'calls'))}\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
as_root() { :; }
home_of() { echo "$T/homes/$1"; }
id() { [ "$1" = -u ] && [ -e "$T/users/$2" ]; }
run_as() { local user="$1" script="$2"; shift 2; HOME="$T/homes/$user" bash -euo pipefail -c "$script" _ "$@"; }
sudo() {
  local user=""
  while [ "$#" -gt 0 ]; do case "$1" in -u|-iu) user="$2"; shift 2 ;; -H|-i) shift ;; *) break ;; esac; done
  HOME="$T/homes/$user" "$@"
}
claude_status_json() { cat "$T/claude-status-$1" 2>/dev/null || true; }
# lib.sh's run_as_bounded runs for real (#904); only who it runs as is stood in: this user, with that user's HOME.
as_user_argv() { AS_USER=(env HOME="$T/homes/$1"); }
`,
  );
  const stub = (file: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\nT=${JSON.stringify(T)}\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub(join(s, 'claude-account.sh'), 'echo "claude-account $*" >> "$T/calls"');
  stub(join(bin, 'worklane'), 'echo "worklane $* HOME=$HOME" >> "$T/calls"');
  stub(join(bin, 'claude'), 'echo "claude $* HOME=$HOME" >> "$T/calls"; cat "$T/claude-status-$(basename "$HOME")" 2>/dev/null || true');
  for (const u of ['wl-alpha', 'wl-alpha-agent']) writeFileSync(join(T, 'users', u), '');
  const inst = join(T, 'homes', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha');
  mkdirSync(inst, { recursive: true });
  const creds = join(inst, 'credentials.yaml');
  if (o.creds !== false) writeFileSync(creds, 'version: 1\ngithub:\n  kind: app\n  app_id: 91\n  installation_id: 4242\n  key_path: /x/private-key.pem\n');
  const auth = o.auth === undefined ? { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' } : o.auth;
  if (auth) writeFileSync(join(T, 'claude-status-wl-alpha-agent'), JSON.stringify(auth, null, 2));
  const given = join(T, 'given-key');
  writeFileSync(given, `${KEY}\n`);
  const keyFile = join(T, 'homes', 'wl-alpha-agent', '.config', 'alpha-claude-key', 'api_key');
  const run = () => spawnSync('bash', [join(s, 'credentials.sh'), 'alpha', 'api-key', given], { encoding: 'utf8', input: '', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: T } });
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  return { T, s, run, calls, keyFile, creds };
}

test('issue #897: credentials.sh api-key installs the key for the agent user, writes agent_api_key as the coordinator, then refreshes the account record', { skip: !posix }, () => {
  const b = box();
  const r = b.run();
  assert.equal(r.status, 0, r.stderr);
  // The key: the agent user's, 0400, in a 0700 dir; claude reads it through apiKeyHelper.
  assert.equal(readFileSync(b.keyFile, 'utf8'), KEY);
  assert.equal(statSync(b.keyFile).mode & 0o777, 0o400);
  assert.equal(statSync(dirname(b.keyFile)).mode & 0o777, 0o700);
  const settings = JSON.parse(readFileSync(join(b.T, 'homes', 'wl-alpha-agent', '.claude', 'settings.json'), 'utf8')) as { apiKeyHelper?: string };
  assert.equal(settings.apiKeyHelper, `cat -- ${b.keyFile}`);
  // credentials.yaml's entry, written by the engine's config code as the coordinator user (its HOME), the path only;
  // then the account record, as the claude branch refreshes it.
  const calls = b.calls().filter((c) => !c.startsWith('claude '));
  const set = calls.findIndex((c) => c === `worklane instance set-agent-api-key alpha --file ${b.keyFile} HOME=${join(b.T, 'homes', 'wl-alpha')}`);
  const status = calls.findIndex((c) => c.startsWith('claude-account status alpha'));
  assert.ok(set >= 0, calls.join('\n'));
  assert.ok(status > set, `the record is refreshed after the key is set: ${calls.join('\n')}`);
  assert.ok(!calls.some((c) => c.startsWith('host ')), `no host tool reached: ${calls.join('\n')}`);
  assert.doesNotMatch(r.stdout, /In credentials\.yaml set/, 'no hand edit asked for');
  assert.ok(!`${r.stdout}${r.stderr}${b.calls().join('\n')}`.includes(KEY), 'the key is never shown or passed');
});

test('issue #897: credentials.sh api-key refuses before taking the key when the instance has no credentials.yaml yet', { skip: !posix }, () => {
  const b = box({ creds: false });
  const r = b.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the instance's GitHub credential comes first/);
  assert.ok(!existsSync(b.keyFile), 'nothing installed');
  assert.ok(!b.calls().some((c) => c.startsWith('worklane ') || c.startsWith('claude-account ')));
});

test('issue #897: credentials.sh api-key leaves credentials.yaml alone when claude, as the agent user, reports no API-key login', { skip: !posix }, () => {
  for (const auth of [{ loggedIn: true, authMethod: 'claude.ai' }, { loggedIn: false }, null]) {
    const b = box({ auth });
    const r = b.run();
    assert.equal(r.status, 1, JSON.stringify(auth));
    assert.match(r.stderr, /doesn't report an API-key login/, JSON.stringify(auth));
    assert.ok(!b.calls().some((c) => c.startsWith('worklane ') || c.startsWith('claude-account ')), `${JSON.stringify(auth)}: ${b.calls().join('\n')}`);
  }
});

test("issue #897: instance set-agent-api-key points credentials.yaml at a key file in a home this user can't see, the rest kept, 0600", { skip: !canHide && 'needs POSIX modes, not as root' }, () => {
  const e = engineInstance();
  const home = e.agentHome;
  const key = e.installed;
  writeFileSync(key, KEY, { mode: 0o400 });
  chmodSync(home, 0o000);
  try {
    const r = e.cli('--file', key);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(e.creds, 'utf8');
    assert.equal((parse(text) as { agent_api_key?: string }).agent_api_key, key);
    assert.match(text, /# the App/, 'the rest kept');
    assert.equal(statSync(e.creds).mode & 0o777, 0o600);
    assert.ok(!`${text}${r.stdout}${r.stderr}`.includes(KEY), 'the path only, never the key');
  } finally {
    chmodSync(home, 0o700);
  }
});

test('issue #897: instance set-agent-api-key refuses a key file this user could read, a link, a missing file, a path apiKeyHelper or the sandbox would refuse, and no credentials.yaml; the file left as it was', { skip: !posix }, () => {
  // Each in a fresh instance whose agent home this user can see (the stand-in for a mistake or a forged path).
  const refused: [string, (e: ReturnType<typeof engineInstance>) => string[], RegExp, number][] = [
    ["the installed path, but this user's own file", (e) => (writeFileSync(e.installed, KEY, { mode: 0o400 }), ['--file', e.installed]), /this user's own/, 1],
    ['the installed path, open to others', (e) => (writeFileSync(e.installed, KEY), chmodSync(e.installed, 0o644), ['--file', e.installed]), /open to its group or others/, 1],
    ['the installed path, a link', (e) => (writeFileSync(join(e.T, 'k'), KEY, { mode: 0o400 }), symlinkSync(join(e.T, 'k'), e.installed), ['--file', e.installed]), /not a plain file/, 1],
    ['the installed path, no file there', (e) => ['--file', e.installed], /no key file/, 1],
    // #904 round 3: never another file, however private: the runner would send it to the API as the key.
    ["another private file of the agent's (~/.ssh/id_ed25519)", (e) => ['--file', join(e.agentHome, '.ssh', 'id_ed25519')], /not where credentials\.sh <name> api-key installs the key/, 1],
    ["the key's place in another home", (e) => ['--file', join(e.T, 'other-home', '.config', 'alpha-claude-key', 'api_key')], /not where credentials\.sh <name> api-key installs the key/, 1],
    ["the agent's settings.json", (e) => ['--file', join(e.agentHome, '.claude', 'settings.json')], /not where credentials\.sh <name> api-key installs the key/, 1],
    ['a path apiKeyHelper could not name', (e) => ['--file', join(e.T, 'a key')], /letters, digits and \. _ - \/ only/, 1],
    ['a path not in normal form', (e) => ['--file', `${e.agentHome}/.config/x/../alpha-claude-key/api_key`], /normal form/, 1],
    ['a relative path', () => ['--file', 'api_key'], /usage: instance set-agent-api-key/, 2],
    ['no path', () => [], /usage: instance set-agent-api-key/, 2],
  ];
  for (const [why, make, re, status] of refused) {
    const e = engineInstance();
    const r = e.cli(...make(e));
    assert.equal(r.status, status, `${why}: ${r.stderr}`);
    assert.match(r.stderr, re, why);
    assert.equal(readFileSync(e.creds, 'utf8'), e.text, `${why}: credentials.yaml unchanged`);
  }
  const none = engineInstance();
  renameSync(none.creds, `${none.creds}.gone`);
  const missing = none.cli('--file', none.installed);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /GitHub credential comes first/);
  // An instance whose agents don't run as their own user has no agent home to install a key in.
  const shared = engineInstance({ runAs: false });
  const noRunAs = shared.cli('--file', shared.installed);
  assert.equal(noRunAs.status, 1);
  assert.match(noRunAs.stderr, /run_as/);
  assert.equal(readFileSync(shared.creds, 'utf8'), shared.text);
});

test("issue #897: doctor's other-keys, as the coordinator user, reports the agent's key from root's account record, never as missing", { skip: !canHide && 'needs POSIX modes, not as root' }, () => {
  const v = coordinatorView(AGENT);
  const s = v.check();
  assert.equal(s.done, true, s.detail);
  assert.equal(s.detail, `agent API key set (${v.key}), in wl-shop-agent's home, which this user can't see, as intended; wl-shop-agent is signed in with it (api_key_helper), per claude auth status as that user at 2026-10-20T10:00:00Z`);
});

test("issue #897: other-keys, as the coordinator user, is not done when root's record shows no API-key login that works, and says how to check again", { skip: !canHide && 'needs POSIX modes, not as root' }, () => {
  for (const record of [null, { ...AGENT, auth_method: 'claude.ai' }, { ...AGENT, logged_in: false, auth_method: null }, { ...AGENT, api_ok: false, api_error: 'HTTP 401' }, { ...AGENT, instance: 'other' }]) {
    const s = coordinatorView(record).check();
    assert.equal(s.done, false, JSON.stringify(record));
    assert.match(s.detail, /in a home this user can't see \(as intended\), and root's account record shows no working API-key login for the instance's agent user/, JSON.stringify(record));
    assert.match(s.detail, /claude-account\.sh status shop$/, JSON.stringify(record));
    assert.doesNotMatch(s.detail, /isn't there/);
  }
});

test("#904 round 3: other-keys, as the coordinator user, certifies only the key where credentials.sh installs it, whatever root's record says", { skip: !canHide && 'needs POSIX modes, not as root' }, () => {
  const notInstalled = /not where credentials\.sh <name> api-key installs the key/;
  const cases: Record<string, Parameters<typeof coordinatorView>[1]> = {
    'a missing file in the hidden home': { key: (h) => join(h, 'no-such-key') },
    "another private file of the agent's": { key: (h) => join(h, '.ssh', 'id_ed25519') },
    "the key's place in another home": { key: (h) => join(dirname(h), 'other-home', '.config', 'shop-claude-key', 'api_key') },
    'no agent home known (no such agent user, or no run_as)': { agentHome: false },
  };
  for (const [why, o] of Object.entries(cases)) {
    const s = coordinatorView(AGENT, o).check();
    assert.equal(s.done, false, `${why}: ${s.detail}`);
    assert.match(s.detail, notInstalled, why);
  }
});
