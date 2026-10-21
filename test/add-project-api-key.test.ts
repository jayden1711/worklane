// Issue #897: an agent that bills to an Anthropic API key (credentials.sh <name> api-key) is a first-class login for
// scripts/setup/add-project.sh's claude-token step. The step counts as done when credentials.yaml names the key file
// where credentials.sh installs it (read as the coordinator user), the file is the agent user's own and open to nobody
// else, the agent's own settings name it as their apiKeyHelper (both checked as that user, bounded), and claude, as the
// agent user, reports an API-key login; anything less still waits for root. Its waiting message names both routes.
// Every setup script and host tool is a stand-in here (test/api-key-fixtures.ts): no sudo, no claude, no systemd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isInstalledKeyPath } from '../src/instance.js';
import { RUNTIME_LOGINS } from '../src/runner.js';
import { KEY, machine, posix, setupDir, tokenStep } from './api-key-fixtures.js';

test('issue #897: an agent set up with an API key passes the claude-token step, with no token asked for or installed, and the run goes on', { skip: !posix }, () => {
  const m = machine();
  m.keyed();
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  const step = tokenStep(r.events);
  assert.equal(step.state, 'done', step.detail);
  assert.match(step.detail, /^wl-alpha-agent bills to an Anthropic API key \(.+\/\.config\/alpha-claude-key\/api_key, its own, open to nobody else\), and claude reports an API-key login as that user$/);
  assert.ok(!m.calls().includes('install_claude_token'), 'no Claude token installed');
  assert.ok(r.events.some((e) => e.step === 'dashboards' && e.state === 'done'), 'the steps after it ran');
  // credentials.yaml was read as the coordinator user, the key file checked as the agent user: never as root.
  assert.match(m.calls(), /run_as wl-alpha\n/);
  assert.match(m.calls(), /run_as wl-alpha-agent\n/);
  assert.ok(!`${r.stdout}${r.stderr}${m.calls()}`.includes(KEY), 'the key is never read or shown');
  assert.equal(m.hostCalls(), '', 'no host tool was reached');
});

test('issue #897: anything short of a working API-key setup still waits for root at the claude-token step', { skip: !posix }, () => {
  const cases: Record<string, (m: ReturnType<typeof machine>) => void> = {
    'credentials.yaml names no key': (m) => m.keyed({ line: null }),
    'the key file is open to others (0644)': (m) => m.keyed({ mode: 0o644 }),
    'the key file is open to its group (0440)': (m) => m.keyed({ mode: 0o440 }),
    'credentials.yaml names a file that is not there': (m) => m.keyed({ line: `agent_api_key: ${join(m.T, 'nowhere', 'api_key')}` }),
    'credentials.yaml names a path apiKeyHelper could not name': (m) => m.keyed({ line: `agent_api_key: "${m.keyFile.replace('api_key', 'api key')}"` }),
    'credentials.yaml names the file by a path not in normal form': (m) => m.keyed({ line: `agent_api_key: ${dirname(m.keyFile)}/../${m.keyFile.split('/').slice(-2).join('/')}` }),
    'credentials.yaml names the key directory, with a trailing slash': (m) => m.keyed({ line: `agent_api_key: ${dirname(m.keyFile)}/` }),
    'the key file is a link': (m) => {
      m.keyed({ line: `agent_api_key: ${join(dirname(m.keyFile), 'link')}` });
      symlinkSync(m.keyFile, join(dirname(m.keyFile), 'link'));
    },
    'credentials.yaml is a link (to a file that names the key)': (m) => {
      m.keyed();
      renameSync(m.creds, `${m.creds}.real`);
      symlinkSync(`${m.creds}.real`, m.creds);
    },
    // #904 round 3: the key file credentials.yaml names, the one the agent's settings name and the one claude was
    // checked with must be one, and the one credentials.sh installs: never another private file of the agent's.
    "credentials.yaml names another private file of the agent's (~/.ssh/id_ed25519, 0600); its settings still name the key": (m) => {
      const f = m.privateFile('.ssh/id_ed25519');
      m.keyed({ line: `agent_api_key: ${f}`, helper: m.keyFile });
    },
    "credentials.yaml and the agent's settings both name ~/.ssh/id_ed25519 (0600)": (m) => {
      const f = m.privateFile('.ssh/id_ed25519');
      m.keyed({ file: f, mode: 0o600 });
    },
    "credentials.yaml names the agent's own settings.json": (m) => {
      m.keyed({ line: `agent_api_key: ${m.settings}`, helper: m.settings });
      chmodSync(m.settings, 0o600);
    },
    "the key's place, but in another user's home": (m) => m.keyed({ file: join(m.T, 'homes', 'wl-other-agent', '.config', 'alpha-claude-key', 'api_key') }),
    "the agent's settings name another key helper": (m) => m.keyed({ helper: join(m.agentHome, '.config', 'beta-claude-key', 'api_key') }),
    "the agent has no settings.json": (m) => m.keyed({ helper: null }),
    'claude reports a subscription login': (m) => m.keyed({ auth: { loggedIn: true, authMethod: 'claude.ai' } }),
    'claude reports no login': (m) => m.keyed({ auth: { loggedIn: false, authMethod: 'none' } }),
    'claude gives no answer': (m) => m.keyed({ auth: null }),
  };
  for (const [why, make] of Object.entries(cases)) {
    const m = machine();
    make(m);
    const r = m.run();
    assert.equal(r.status, 3, `${why}: ${r.stderr}`);
    assert.deepEqual([tokenStep(r.events).state, r.events.at(-1)!.step], ['waiting', 'claude-token'], why);
    assert.ok(!r.events.some((e) => e.step === 'checkout'), `${why}: nothing after it started`);
    assert.equal(m.hostCalls(), '', `${why}: no host tool was reached`);
  }
});

test("#904 round 3: an instance renamed since its key was installed (the key's directory keeps the old name's) still passes add-project, its settings naming that key; the settings are read as the agent user", { skip: !posix }, () => {
  const m = machine();
  m.keyed({ file: join(m.agentHome, '.config', 'old-name-claude-key', 'api_key') });
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(tokenStep(r.events).state, 'done', tokenStep(r.events).detail);
  assert.equal((m.calls().match(/run_as wl-alpha-agent\n/g) ?? []).length, 2, 'the key file and the settings, each checked as the agent user');
  assert.equal(m.hostCalls(), '', 'no host tool was reached');
});

test('issue #897: the waiting message names both routes, the API key included, whole within the 400 characters a step line keeps, for the longest instance name', { skip: !posix }, () => {
  const name = 'abcdefghijklmnopqrstu';
  const m = machine(name);
  const r = m.run([name, 'example/alpha']);
  assert.equal(r.status, 3, r.stderr);
  const step = tokenStep(r.events);
  assert.equal(step.state, 'waiting');
  // Whole: nothing of it cut off (the test's temp path is longer than the installed engine's).
  assert.equal(
    step.detail,
    `the agents' Claude login, which only root installs, on this machine: sudo bash ${m.s}/credentials.sh ${name} claude (it asks for the token claude setup-token prints), or the same with api-key for claude (it asks for an Anthropic API key), neither shown; or sudo -u wl-${name}-agent -i claude auth login`,
  );
  assert.ok(m.s.length >= '/opt/worklane/current/scripts/setup'.length, m.s);
});

test("#904 round 3: lib.sh's agent_key_path_ok and the engine's isInstalledKeyPath take exactly the same paths; with an instance, the engine takes only that instance's", { skip: !posix }, () => {
  const home = '/var/lib/agents/wl-alpha-agent';
  const paths = [
    `${home}/.config/alpha-claude-key/api_key`,
    `${home}/.config/old-name-claude-key/api_key`,
    `${home}/.config/a-claude-key/api_key`,
    `${home}/.ssh/id_ed25519`,
    `${home}/.claude/settings.json`,
    `${home}/.config/alpha-claude-key/other`,
    `${home}/.config/Alpha-claude-key/api_key`,
    `${home}/.config/alpha-claude-key/api_key/x`,
    `${home}/.config/-claude-key/api_key`,
    `${home}/.config/x/alpha-claude-key/api_key`,
    `${home}x/.config/alpha-claude-key/api_key`,
    `/var/lib/agents/wl-beta-agent/.config/alpha-claude-key/api_key`,
    `${home}/.config/abcdefghijklmnopqrstuv-claude-key/api_key`,
  ];
  const script = 'source "$1"; shift; h="$1"; shift; for p in "$@"; do if agent_key_path_ok "$h" "$p"; then echo yes; else echo no; fi; done';
  const r = spawnSync('bash', ['-c', script, '_', join(setupDir, 'lib.sh'), home, ...paths], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), paths.map((p) => (isInstalledKeyPath(home, p) ? 'yes' : 'no')));
  assert.deepEqual(paths.map((p) => isInstalledKeyPath(home, p)), [true, true, true, false, false, false, false, false, false, false, false, false, false]);
  // #904 round 4: the engine's rule (set-agent-api-key, other-keys) names the instance: only its own directory.
  assert.deepEqual(paths.map((p) => isInstalledKeyPath(home, p, 'alpha')), [true, false, false, false, false, false, false, false, false, false, false, false, false]);
  assert.equal(isInstalledKeyPath(home, `${home}/.config/a.b-claude-key/api_key`, 'a.b'), true, 'an instance name is matched as text');
  assert.equal(isInstalledKeyPath(home, `${home}/.config/aXb-claude-key/api_key`, 'a.b'), false, 'never as a pattern');
});

test("issue #897: lib.sh's API-key logins are the api_key runtime's (src/runner.ts RUNTIME_LOGINS)", { skip: !posix }, () => {
  const r = spawnSync('bash', ['-c', 'source "$1"; printf %s "$CLAUDE_API_KEY_LOGINS"', '_', join(setupDir, 'lib.sh')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('|'), [...RUNTIME_LOGINS.api_key]);
});
