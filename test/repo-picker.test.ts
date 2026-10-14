// Add project's repo picker (wizard screen 5, src/setup/repo-picker.ts): an account's repos the agents' App can be
// installed on, from GitHub (a fake one here), and the dashboard route that serves them to owners and writers only.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { clearRepoListCache, listInstallableRepos, REPO_LIST_TTL_MS, type RepoPickerView } from '../src/setup/repo-picker.js';
import { fakeGitHub } from './fake-github.js';
import { asPerson, exampleProject, exampleRoles, machineOwnersFile } from './helpers.js';

const REPOS = {
  ada: [
    { full_name: 'ada/old-site', archived: true, pushed_at: '2026-10-12T00:00:00Z' },
    { full_name: 'ada/shop', private: false, pushed_at: '2026-10-11T00:00:00Z' },
    { full_name: 'ada/notes', disabled: true },
    { full_name: 'ada/../etc' },
  ],
  'example-org': [{ full_name: 'example-org/api', pushed_at: '2026-10-10T00:00:00Z' }],
};
const gh = () => {
  const seen: string[] = [];
  return fakeGitHub({ repo: 'ada/shop', permissions: {}, accountRepos: REPOS, orgs: { ada: ['example-org'] }, log: (l) => seen.push(l) }).then((g) => ({ ...g, seen }));
};

test("an account's repos: installable first, archived and disabled ones shown but not pickable, a bad name dropped; the person's organizations offered", async () => {
  clearRepoListCache();
  const g = await gh();
  try {
    const v = await listInstallableRepos({ owner: 'ada', login: 'ada', api: g.url });
    assert.equal(v.error, null);
    assert.equal(v.ownerType, 'User');
    assert.deepEqual(v.accounts, ['ada', 'example-org']);
    assert.deepEqual(
      v.repos.map((r) => [r.fullName, r.installable]),
      [
        ['ada/shop', true],
        ['ada/old-site', false],
        ['ada/notes', false],
      ],
    );
    assert.match(v.repos.find((r) => r.fullName === 'ada/old-site')!.why ?? '', /archived/);
    assert.match(v.note, /only public repos[\s\S]*type a private repo as owner\/name/, 'says what it cannot list');
    assert.ok(g.seen.includes('GET /users/ada/repos'), "a user's own repos");

    // An organization: its repos through /orgs.
    const o = await listInstallableRepos({ owner: 'example-org', login: 'ada', api: g.url });
    assert.equal(o.ownerType, 'Organization');
    assert.deepEqual(o.repos.map((r) => r.fullName), ['example-org/api']);
    assert.ok(g.seen.includes('GET /orgs/example-org/repos'));

    // Kept for a while: GitHub allows few requests without a token.
    const before = g.seen.length;
    assert.deepEqual(await listInstallableRepos({ owner: 'ada', login: 'ada', api: g.url }), v);
    assert.equal(g.seen.length, before, 'served from the cache');
    const later = await listInstallableRepos({ owner: 'ada', login: 'ada', api: g.url, now: () => Date.now() + REPO_LIST_TTL_MS + 1 });
    assert.deepEqual(later.repos, v.repos);
    assert.ok(g.seen.length > before, 'asked again once stale');
  } finally {
    await g.close();
  }
});

test("GitHub's refusals become a message, never a throw, and the page still takes a typed owner/name", async () => {
  clearRepoListCache();
  const answer = (status: number) => (async () => new Response(status === 200 ? '{"type":"User"}' : '{}', { status })) as typeof fetch;
  const none = await listInstallableRepos({ owner: 'nobody-here', api: 'http://gh.invalid', fetch: answer(404) });
  assert.match(none.error ?? '', /no account nobody-here/);
  const limited = await listInstallableRepos({ owner: 'ada', api: 'http://gh.invalid', fetch: answer(403) });
  assert.match(limited.error ?? '', /limit[\s\S]*type owner\/name/);
  const down = await listInstallableRepos({ owner: 'ada', api: 'http://gh.invalid', fetch: (async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch });
  assert.match(down.error ?? '', /couldn't reach GitHub/);
  let asked = 0;
  const bad = await listInstallableRepos({ owner: 'ada/../x', api: 'http://gh.invalid', fetch: (async () => (asked++, new Response('{}'))) as typeof fetch });
  assert.match(bad.error ?? '', /not a GitHub account name/);
  assert.equal(asked, 0, 'a bad name never reaches GitHub');
  // No account to start from (the break-glass): nothing asked, no error; the page asks for one.
  const empty = await listInstallableRepos({ owner: '', api: 'http://gh.invalid', fetch: (async () => (asked++, new Response('{}'))) as typeof fetch });
  assert.deepEqual([empty.error, empty.repos, asked], [null, [], 0]);
  for (const v of [none, limited, down, bad]) assert.deepEqual(v.repos, []);
});

test("the dashboard's repo picker: the signed-in person's account by default, another on request; owners and writers only", { skip: process.platform === 'win32' }, async () => {
  clearRepoListCache();
  const g = await gh();
  // The route asks GitHub itself (its host is a constant): for this test, this process's fetch carries those requests
  // to the fake, and leaves the test's own calls to the dashboard alone.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(String(input).replace(/^https:\/\/api\.github\.com/, g.url), init)) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'repo-picker-'));
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: machineOwnersFile('example-owner'), slotsDir: join(dir, 'slots') });
  try {
    const base = d.url.split('/?')[0]!;
    const get = (who: string, q = '') => fetch(`${base}/api/add-project/repos${q}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } });
    const own = await get('example-owner');
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as RepoPickerView).owner, 'example-owner', "the signed-in person's own account");
    const other = await get('example-collaborator', '?owner=ada');
    assert.equal(other.status, 200, 'a writer');
    const v = (await other.json()) as RepoPickerView;
    assert.deepEqual([v.owner, v.repos[0]!.fullName], ['ada', 'ada/shop']);
    const viewer = await get('example-viewer');
    assert.equal(viewer.status, 403, 'a viewer');
  } finally {
    await d.close();
    await g.close();
    globalThis.fetch = realFetch;
  }
});
