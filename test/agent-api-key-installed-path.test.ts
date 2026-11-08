// #949: the runner sends credentials.yaml's agent_api_key to the API, and the coordinator user writes credentials.yaml.
// So the coordinator takes only the path credentials.sh <name> api-key installs, in the home the user database gives
// the agent user (never instance.yaml's), and doesn't start on any other: an SSH key the agent can read never goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instanceApiKeyFile } from '../src/service.js';
import { repoRoot } from './helpers.js';

const homes: Record<string, string> = { 'wl-shop-agent': '/home/user' };
const lookup = (user: string) => homes[user] ?? null;
const inst = (agent_api_key: string | undefined, runAs: { user: string } | null = { user: 'wl-shop-agent' }) => ({ name: 'shop', credentials: agent_api_key === undefined ? {} : { agent_api_key }, runAs });
const INSTALLED = '/home/user/.config/shop-claude-key/api_key';

test('#949: the installed key path is taken; no key means no key file', () => {
  assert.equal(instanceApiKeyFile(inst(INSTALLED), lookup), INSTALLED);
  assert.equal(instanceApiKeyFile(inst(undefined), lookup), undefined);
  assert.equal(instanceApiKeyFile(inst(undefined, null), lookup), undefined);
});

test('#949: any other path credentials.yaml could name is refused, so the coordinator does not start', () => {
  const refused: Record<string, ReturnType<typeof inst>> = {
    'an SSH key of the agent user': inst('/home/user/.ssh/id_ed25519'),
    'another instance\'s key directory': inst('/home/user/.config/other-claude-key/api_key'),
    'a file next to the key': inst('/home/user/.config/shop-claude-key/notes'),
    'a path that steps out of the key directory': inst('/home/user/.config/shop-claude-key/../../.ssh/id_rsa'),
    'the key path in another home': inst('/home/you/.config/shop-claude-key/api_key'),
    'an agent user the user database has no home for': inst(INSTALLED, { user: 'wl-gone-agent' }),
    'agents that do not run as their own user': inst(INSTALLED, null),
  };
  const letThrough = Object.entries(refused).filter(([, i]) => {
    try {
      instanceApiKeyFile(i, lookup);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(letThrough.map(([what]) => what), []);
});

test('#949: the coordinator hands the runner only the checked key file, never credentials.yaml\'s value unchecked', () => {
  const src = readFileSync(join(repoRoot, 'src', 'service.ts'), 'utf8');
  // The instance's runner: the one billed by instanceRuntime (a plain repo's runner takes no key file).
  const runners = src.split('\n').filter((l) => l.includes('new CliRunner(instanceRuntime('));
  assert.equal(runners.length, 1);
  assert.match(runners[0]!, /guardrailSettings\([^)]*\), agentKeyFile, login,/, 'the runner gets instanceApiKeyFile\'s result');
  assert.match(src, /agentKeyFile = instanceApiKeyFile\(i\)/);
});
