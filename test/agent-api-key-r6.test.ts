// #904 round 6, from the second adversarial review at 76632556:
// - Another user's process that escapes the bound's process group (setsid) and keeps what it inherited holds nothing
//   of add-project's: every descriptor above 2 is closed before the other user's side starts, so add-project's event
//   stream (fd 3) ends when add-project does.
// - credentials.sh api-key's call as the coordinator (set-agent-api-key) is bounded by root: the coordinator's
//   instance.yaml as a FIFO doesn't hold root's setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KEY, machine, posix, setupDir, tokenStep } from './api-key-fixtures.js';
import { engineCli } from './helpers.js';

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
/** Let anything blocked reading a FIFO go: open its write end without blocking, then close it (EOF). */
function release(path: string) {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // no reader left
  }
}
const hasSetsid = posix && spawnSync('setsid', ['true']).status === 0;

test("round 6: an agent-side process that escapes with setsid and keeps what it inherited doesn't hold add-project", { skip: !hasSetsid && 'needs setsid(1)' }, () => {
  const m = machine();
  m.keyed();
  // claude, as the agent user: answers, and leaves a process behind in a session of its own, keeping its descriptors.
  writeFileSync(join(m.T, 'agent-bin', 'claude'), `#!/bin/sh\nsetsid sleep 20 &\ncat ${JSON.stringify(m.T)}/claude-status-"$(basename "$HOME")" 2>/dev/null || true\n`);
  chmodSync(join(m.T, 'agent-bin', 'claude'), 0o755);
  try {
    const r = m.run(undefined, 60_000);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(tokenStep(r.events).state, 'done', tokenStep(r.events).detail);
    // The sleep is 20 s: add-project (whose event stream is fd 3) must not wait for it.
    assert.ok(r.ms < 8_000, `took ${r.ms} ms: something left behind held add-project's output`);
    assert.equal(m.hostCalls(), '', 'no host tool was reached');
  } finally {
    killMarked(m.T);
  }
});

/**
 * credentials.sh api-key in a temp dir, as test/agent-api-key-setup.test.ts runs it, but with the engine's real CLI as
 * `worklane` for the coordinator and a 2 s bound; the coordinator's instance.yaml is a FIFO.
 */
function credentialsWithFifo() {
  const T = mkdtempSync(join(tmpdir(), 'credentials-fifo-'));
  const s = join(T, 'scripts', 'setup');
  const bin = join(T, 'bin');
  for (const d of [s, bin, join(T, 'users')]) mkdirSync(d, { recursive: true });
  copyFileSync(join(setupDir, 'credentials.sh'), join(s, 'credentials.sh'));
  for (const tool of ['sudo', 'systemctl', 'getent', 'useradd', 'gh', 'docker', 'shred']) {
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
run_as() { local user="$1" script="$2"; shift 2; HOME="$T/homes/$user" AGENT_SIDE="$T" bash -euo pipefail -c "$script" _ "$@"; }
sudo() {
  local user=""
  while [ "$#" -gt 0 ]; do case "$1" in -u|-iu) user="$2"; shift 2 ;; -H|-i) shift ;; *) break ;; esac; done
  HOME="$T/homes/$user" AGENT_SIDE="$T" "$@"
}
as_user_argv() { AS_USER=(env HOME="$T/homes/$1" AGENT_SIDE="$T"); }
AGENT_CHECK_SECONDS=2
`,
  );
  const exe = (file: string, body: string) => {
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  exe(join(s, 'claude-account.sh'), 'exit 0');
  exe(join(bin, 'worklane'), `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(engineCli)} "$@"`);
  exe(join(bin, 'claude'), `cat ${JSON.stringify(T)}/claude-status 2>/dev/null || true`);
  writeFileSync(join(T, 'claude-status'), JSON.stringify({ loggedIn: true, authMethod: 'api_key_helper' }, null, 2));
  for (const u of ['wl-alpha', 'wl-alpha-agent']) writeFileSync(join(T, 'users', u), '');
  const inst = join(T, 'homes', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha');
  mkdirSync(inst, { recursive: true });
  const creds = join(inst, 'credentials.yaml');
  writeFileSync(creds, 'version: 1\ngithub:\n  kind: app\n  app_id: 91\n  installation_id: 4242\n  key_path: /x/private-key.pem\n');
  const fifo = join(inst, 'instance.yaml');
  const r = spawnSync('mkfifo', ['-m', '0600', fifo], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const given = join(T, 'given-key');
  writeFileSync(given, `${KEY}\n`);
  mkdirSync(join(T, 'homes', 'wl-alpha-agent'), { recursive: true });
  const run = () => {
    const started = performance.now();
    const out = spawnSync('bash', [join(s, 'credentials.sh'), 'alpha', 'api-key', given], { encoding: 'utf8', input: '', timeout: 30_000, killSignal: 'SIGKILL', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: T } });
    return { ...out, ms: performance.now() - started };
  };
  return { T, creds, fifo, run };
}

test("round 6: credentials.sh api-key's call as the coordinator is bounded by root: the coordinator's instance.yaml as a FIFO doesn't hold it", { skip: !posix }, () => {
  const c = credentialsWithFifo();
  const before = readFileSync(c.creds, 'utf8');
  try {
    const r = c.run();
    assert.notEqual(r.signal, 'SIGKILL', 'credentials.sh was still running after 30 s');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /writing agent_api_key as wl-alpha failed or didn't finish within 2 s/);
    assert.ok(r.ms < 20_000, `took ${r.ms} ms`);
    assert.equal(readFileSync(c.creds, 'utf8'), before, 'credentials.yaml unchanged');
  } finally {
    release(c.fifo);
    killMarked(c.T);
  }
});
