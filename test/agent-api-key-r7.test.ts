// #904 round 7, from the delta final check at 1cc9abb9:
// - Every call credentials.sh api-key makes as another user is bounded by root. Through round 6, three were plain
//   `sudo -u`: the coordinator's check that credentials.yaml is there (intake_creds_ready, which this PR added to the
//   api-key branch), and main's two agent-side steps, the key install and the apiKeyHelper settings write. A process
//   started as that user that stops itself (SIGSTOP, as any process of that uid can stop it) held root's
//   credentials.sh for ever.
// - close_fds without a /proc listing closes every descriptor below the soft limit (ulimit -n), not only up to 255.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KEY, posix, setupDir } from './api-key-fixtures.js';

/** Host tools credentials.sh or lib.sh could reach: each a recording stand-in that fails, so none of the real ones runs. */
const HOST_TOOLS = ['sudo', 'systemctl', 'loginctl', 'launchctl', 'id', 'getent', 'useradd', 'usermod', 'gh', 'docker', 'tailscale', 'shred'];

/** SIGKILL every process this test marked as another user's (AGENT_SIDE=<its temp dir>). */
function killMarked(T: string) {
  if (!existsSync('/proc')) return;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`AGENT_SIDE=${T}`)) process.kill(Number(pid), 'SIGKILL');
    } catch {
      // gone, or not this user's
    }
  }
}

/** The real program a stand-in hands on to, once it has stopped itself and been let go (never, in these tests). */
function real(tool: string): string | undefined {
  if (tool === 'node') return process.execPath;
  return [`/usr/bin/${tool}`, `/bin/${tool}`].find((p) => existsSync(p));
}

/**
 * credentials.sh api-key in a temp dir, beside a lib.sh that sources the real one, with users, homes and who a command
 * runs as stood in. Every program started as another user, by sudo or by run_as_bounded, finds <T>/side/<user> first
 * on PATH, and carries AGENT_SIDE=<T>. `stops` names, per user, the programs that stop themselves (SIGSTOP) there as
 * the first thing they do: the model of "a process of that uid stops what root started for it".
 */
function box(stops: Record<string, string[]> = {}) {
  const T = mkdtempSync(join(tmpdir(), 'creds-r7-'));
  const s = join(T, 'scripts', 'setup');
  const bin = join(T, 'bin');
  for (const d of [s, bin, join(T, 'users')]) mkdirSync(d, { recursive: true });
  copyFileSync(join(setupDir, 'credentials.sh'), join(s, 'credentials.sh'));
  for (const tool of HOST_TOOLS) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "host ${tool} $*" >> ${JSON.stringify(join(T, 'host-calls'))}\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
as_root() { :; }
home_of() { echo "$T/homes/$1"; }
id() { [ "$1" = -u ] && [ -e "$T/users/$2" ]; }
run_as() { local user="$1" script="$2"; shift 2; HOME="$T/homes/$user" PATH="$T/side/$user:$PATH" AGENT_SIDE="$T" bash -euo pipefail -c "$script" _ "$@"; }
sudo() {
  local user=""
  while [ "$#" -gt 0 ]; do case "$1" in -u|-iu) user="$2"; shift 2 ;; -H|-i) shift ;; *) break ;; esac; done
  HOME="$T/homes/$user" PATH="$T/side/$user:$PATH" AGENT_SIDE="$T" env "$@"
}
# lib.sh's run_as_bounded runs for real; only who it runs as is stood in. Root's timeout stays outside it, as with sudo.
as_user_argv() { AS_USER=(env HOME="$T/homes/$1" PATH="$T/side/$1:$PATH" AGENT_SIDE="$T"); }
AGENT_CHECK_SECONDS=2
AGENT_STATUS_SECONDS=2
ACCOUNT_STATUS_SECONDS=2
`,
  );
  const exe = (file: string, body: string) => {
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  exe(join(s, 'claude-account.sh'), `echo "claude-account $*" >> ${JSON.stringify(join(T, 'calls'))}`);
  exe(join(bin, 'worklane'), `echo "worklane $*" >> ${JSON.stringify(join(T, 'calls'))}`);
  exe(join(bin, 'claude'), `cat ${JSON.stringify(join(T, 'claude-status'))} 2>/dev/null || true`);
  writeFileSync(join(T, 'claude-status'), JSON.stringify({ loggedIn: true, authMethod: 'api_key_helper' }, null, 2));
  for (const u of ['wl-alpha', 'wl-alpha-agent']) {
    writeFileSync(join(T, 'users', u), '');
    mkdirSync(join(T, 'side', u), { recursive: true });
    mkdirSync(join(T, 'homes', u), { recursive: true });
  }
  for (const [user, tools] of Object.entries(stops)) {
    for (const tool of tools) {
      const to = real(tool);
      assert.ok(to, `no ${tool} on this machine to stand in for`);
      exe(join(T, 'side', user, tool), `kill -STOP $$\nexec ${JSON.stringify(to)} "$@"`);
    }
  }
  const inst = join(T, 'homes', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha');
  mkdirSync(inst, { recursive: true });
  const creds = join(inst, 'credentials.yaml');
  writeFileSync(creds, 'version: 1\ngithub:\n  kind: app\n  app_id: 91\n  installation_id: 4242\n  key_path: /x/private-key.pem\n');
  const given = join(T, 'given-key');
  writeFileSync(given, `${KEY}\n`);
  const keyFile = join(T, 'homes', 'wl-alpha-agent', '.config', 'alpha-claude-key', 'api_key');
  const settings = join(T, 'homes', 'wl-alpha-agent', '.claude', 'settings.json');
  const run = () => {
    // A duration: the monotonic clock, never the wall clock (test/no-wall-clock-durations.test.ts).
    const started = performance.now();
    const r = spawnSync('bash', [join(s, 'credentials.sh'), 'alpha', 'api-key', given], { encoding: 'utf8', input: '', timeout: 20_000, killSignal: 'SIGKILL', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: T } });
    return { ...r, ms: performance.now() - started };
  };
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8') : '');
  const hostCalls = () => (existsSync(join(T, 'host-calls')) ? readFileSync(join(T, 'host-calls'), 'utf8') : '');
  return { T, creds, keyFile, settings, run, calls, hostCalls };
}

test('round 7: with nothing stopped, credentials.sh api-key installs the key and the apiKeyHelper entry as before, through the bounded runner', { skip: !posix }, () => {
  const b = box();
  try {
    const r = b.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(b.keyFile, 'utf8'), KEY);
    assert.equal(statSync(b.keyFile).mode & 0o777, 0o400);
    assert.equal(statSync(dirname(b.keyFile)).mode & 0o777, 0o700);
    const settings = JSON.parse(readFileSync(b.settings, 'utf8')) as { apiKeyHelper?: string };
    assert.equal(settings.apiKeyHelper, `cat -- ${b.keyFile}`);
    assert.equal(statSync(b.settings).mode & 0o777, 0o600);
    assert.match(b.calls(), /^worklane instance set-agent-api-key alpha --file .*\/alpha-claude-key\/api_key$/m);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(KEY), 'the key is never shown');
    assert.equal(b.hostCalls(), '', 'no host tool was reached');
  } finally {
    killMarked(b.T);
  }
});

const cases: [string, Record<string, string[]>, RegExp, boolean][] = [
  // The coordinator's side: `test` (the plain sudo -u through round 6) or the bash run_as_bounded starts.
  ["the coordinator's check that credentials.yaml is there (intake_creds_ready)", { 'wl-alpha': ['test', 'bash', 'sh'] }, /checking, as wl-alpha, that .*credentials\.yaml is there didn't finish within 2 s; nothing installed/, false],
  // The agent's side: sh (main's key install) or bash; the key never got there.
  ["the agent's key install", { 'wl-alpha-agent': ['sh', 'bash'] }, /installing the key as wl-alpha-agent failed or didn't finish within 2 s \(exit 137\)/, false],
  // The agent's side: node (main's settings write); the key is in place by then.
  ["the agent's apiKeyHelper settings write", { 'wl-alpha-agent': ['node'] }, /writing the apiKeyHelper entry as wl-alpha-agent failed or didn't finish within 2 s \(exit 137\)/, true],
];
for (const [what, stops, message, keyInstalled] of cases) {
  test(`round 7: credentials.sh api-key is bounded by root when the other user's side of ${what} stops itself`, { skip: !posix }, () => {
    const b = box(stops);
    const before = readFileSync(b.creds, 'utf8');
    try {
      const r = b.run();
      assert.notEqual(r.signal, 'SIGKILL', 'credentials.sh was still running after 20 s');
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, message);
      assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
      assert.equal(readFileSync(b.creds, 'utf8'), before, 'credentials.yaml unchanged');
      assert.equal(existsSync(b.keyFile), keyInstalled, 'the key file is there only once its install finished');
      assert.doesNotMatch(b.calls(), /^worklane /m, 'agent_api_key is not written');
      assert.ok(!`${r.stdout}${r.stderr}`.includes(KEY), 'the key is never shown');
      assert.equal(b.hostCalls(), '', 'no host tool was reached');
    } finally {
      killMarked(b.T);
    }
  });
}

test('round 7: close_fds without a /proc listing closes descriptors above 255, up to the soft limit (ulimit -n)', { skip: (!posix || !existsSync('/proc/self/fd')) && 'needs /proc to look at the result' }, () => {
  const T = mkdtempSync(join(tmpdir(), 'close-fds-r7-'));
  const bin = join(T, 'bin');
  mkdirSync(bin);
  for (const tool of HOST_TOOLS) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "host ${tool} $*" >> ${JSON.stringify(join(T, 'host-calls'))}\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  // ls fails in the subshell, as on a host with no /proc: close_fds falls back to counting.
  const script = `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
ulimit -n 1024
exec 3>"$1/fd3" 300>"$1/fd300" 1000>"$1/fd1000"
(ls() { return 1; }; close_fds; for fd in 3 300 1000; do if [ -e /proc/$BASHPID/fd/$fd ]; then echo "subshell kept $fd"; fi; done; echo "subshell done")
for fd in 3 300 1000; do if [ ! -e /proc/$$/fd/$fd ]; then echo "caller lost $fd"; fi; done
echo "caller done"
`;
  const r = spawnSync('bash', ['-c', script, '_', T], { encoding: 'utf8', timeout: 60_000, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: T } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'subshell done\ncaller done\n');
  assert.ok(!existsSync(join(T, 'host-calls')), 'no host tool was reached');
});
