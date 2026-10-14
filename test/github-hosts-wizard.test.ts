// The wizard's two additions to the code that talks to GitHub hold to the same rule as the rest (issue #377,
// test/github-hosts.test.ts): the hub's setup mode (the sign-in App's manifest flow) and Add project's repo picker
// name GitHub's hosts as constants, and read no environment variable that could name another.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { clearRepoListCache, listInstallableRepos } from '../src/setup/repo-picker.js';
import { repoRoot } from './helpers.js';

const HOST_VARIABLES = [`${BRAND.envPrefix}_GITHUB_API`, `${BRAND.envPrefix}_GITHUB_WEB`, 'GITHUB_API_URL', 'GITHUB_SERVER_URL', 'GH_HOST', 'GITHUB_HOST'];

test("the hub's setup mode and the repo picker read no environment variable at all", () => {
  for (const f of ['src/hub-setup.ts', 'src/setup/repo-picker.ts']) assert.doesNotMatch(readFileSync(join(repoRoot, f), 'utf8'), /process\.env/, f);
});

test('the repo picker asks api.github.com whatever the environment names', async () => {
  clearRepoListCache();
  const saved = HOST_VARIABLES.map((n) => process.env[n]);
  for (const n of HOST_VARIABLES) process.env[n] = 'https://elsewhere.example.test';
  const asked: string[] = [];
  const github = (async (input: RequestInfo | URL) => (asked.push(String(input)), new Response(String(input).endsWith('/users/ada') ? '{"type":"User"}' : '[]', { status: 200 }))) as typeof fetch;
  try {
    const v = await listInstallableRepos({ owner: 'ada', login: 'ada', fetch: github });
    assert.equal(v.error, null);
  } finally {
    HOST_VARIABLES.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n];
      else process.env[n] = saved[i];
    });
    clearRepoListCache();
  }
  assert.ok(asked.length >= 3, asked.join(' '));
  for (const u of asked) assert.equal(new URL(u).origin, 'https://api.github.com', u);
});
