// #904 round 5, from the second adversarial review at ea648db5:
// - One parser: add-project judges credentials.yaml's agent_api_key as the engine loads it. A flow mapping that puts
//   another `agent_api_key:` (a provider key's name) at column 0, naming the installed key, while the real entry names
//   ~/.ssh/id_ed25519, leaves claude-token waiting.
// - A bound the bounded user can't freeze: a process run as another user (the agent, the coordinator) that is stopped
//   (SIGSTOP) never holds add-project, and with it the machine-wide lock: root's timeout kills it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { machine, posix, tokenStep } from './api-key-fixtures.js';
import { engineCli } from './helpers.js';

/** The bound this test allows add-project's whole run: well past the 3 s check bound set below, short of a hang. */
const RUN_LIMIT_MS = 45_000;

/** credentials.yaml as one top-level flow mapping, a provider key named agent_api_key at column 0 naming `shown`. */
const flowCredentials = (shown: string, real: string) => `{version: 1,
  github: {
  kind: app, app_id: 91, installation_id: 4242, key_path: /x/private-key.pem},
  provider_keys: {
agent_api_key: ${shown}
  },
  agent_api_key: ${real}}
`;

/** The engine's own read of credentials.yaml text: `instance agent-api-key-of`, the text on stdin. */
function engineRead(text: string) {
  const T = mkdtempSync(join(tmpdir(), 'agent-key-of-'));
  return spawnSync(process.execPath, [engineCli, 'instance', 'agent-api-key-of'], {
    encoding: 'utf8',
    input: text,
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T, [`${BRAND.envPrefix}_STATE_DIR`]: join(T, 'state'), [`${BRAND.envPrefix}_INSTANCES_DIR`]: join(T, 'instances') },
  });
}

/** SIGKILL every process this test marked as another user's (AGENT_SIDE=<its temp dir>), left stopped or not. */
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

test('round 5: the engine reads agent_api_key from a flow mapping as the YAML says, not as a line looks', { skip: !posix }, () => {
  const shown = '/var/lib/agents/wl-alpha-agent/.config/alpha-claude-key/api_key';
  const real = '/var/lib/agents/wl-alpha-agent/.ssh/id_ed25519';
  const r = engineRead(flowCredentials(shown, real));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), real);
  // None named, a file that doesn't load, and one over 64 KiB: nothing, exit 1.
  assert.equal(engineRead('version: 1\ngithub: { kind: app, app_id: 1, installation_id: 2, key_path: /x/k.pem }\n').status, 1);
  assert.equal(engineRead('agent_api_key: /a\nagent_api_key: /b\n').status, 1, 'duplicate keys: refused');
  const big = engineRead(`version: 1\ngithub: { kind: app, app_id: 1, installation_id: 2, key_path: /x/k.pem }\nagent_api_key: ${shown}\n# ${'x'.repeat(70_000)}\n`);
  assert.equal(big.status, 1);
  assert.equal(big.stdout, '');
});

test("round 5: add-project judges the key the engine loads: a flow mapping naming the installed key at column 0 and ~/.ssh/id_ed25519 for real waits", { skip: !posix }, () => {
  const m = machine();
  const ssh = m.privateFile('.ssh/id_ed25519');
  m.keyed({ line: null });
  writeFileSync(m.creds, flowCredentials(m.keyFile, ssh));
  const r = m.run(undefined, RUN_LIMIT_MS);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(tokenStep(r.events).state, 'waiting', tokenStep(r.events).detail);
  assert.ok(!r.events.some((e) => e.step === 'checkout'), 'nothing after it started');
  assert.equal(m.hostCalls(), '', 'no host tool was reached');
});

test('round 5: a stopped (SIGSTOP) process of the agent or the coordinator never holds add-project: root kills it at the bound', { skip: !posix }, () => {
  const m = machine();
  m.keyed();
  // Every process run as another user stops itself at once (as that user could, to its own processes, or to any
  // timeout of its own); the bound is 3 s here.
  appendFileSync(
    join(m.s, 'lib.sh'),
    `AGENT_CHECK_SECONDS=3 AGENT_STATUS_SECONDS=3
run_as() { local user="$1" script="$2"; shift 2; echo "run_as $user" >> "$T/calls"; HOME="$T/homes/$user" AGENT_SIDE="$T" sh -c 'kill -STOP $$; exec bash -euo pipefail -c "$@"' _ "$script" _ "$@"; }
as_user_argv() { echo "run_as $1" >> "$T/calls"; AS_USER=(env HOME="$T/homes/$1" AGENT_SIDE="$T" sh -c 'kill -STOP $$; exec "$@"' _); }
`,
  );
  try {
    const r = m.run(undefined, RUN_LIMIT_MS);
    assert.notEqual(r.signal, 'SIGKILL', `add-project was still running after ${RUN_LIMIT_MS} ms`);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(tokenStep(r.events).state, 'waiting');
    assert.ok(r.ms < 30_000, `took ${r.ms} ms`);
    assert.equal(m.hostCalls(), '', 'no host tool was reached');
  } finally {
    killMarked(m.T);
  }
});
