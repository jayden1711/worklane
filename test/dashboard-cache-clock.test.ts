// The first-run page's listing caches (the Discord bot's view, the Slack and Linear views) age by the clock the
// dashboard is given, a monotonic one by default, never by the wall clock (#582): a wall-clock step (an NTP correction)
// can neither keep a listing past its window nor cut one short. The windows are unchanged: 5 s asked fresh, 60 s
// otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { discordListingStandIn, type RunCli } from '../src/intake/discord-setup.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const posix = process.platform !== 'win32';
const BOT = { application: { id: '700000000000000001', name: 'Example bot', message_content: true }, channels: [{ guild_id: '900000000000000001', guild: 'Example', id: '100000000000000011', name: 'general', type: 0 }] };
const LINEAR = { organization: { name: 'Example' }, viewer: { id: '00000000-0000-4000-8000-000000000010', name: 'Intake bot' }, teams: [], labels: [] };

/**
 * A server instance's dashboard with a Discord token and a Linear key stored, its listings answered in code and
 * counted, and its clock in the test's hand. Runs `fn`, then puts Date.now back and closes the dashboard.
 */
async function withDashboard(fn: (o: { get: (path: string) => Promise<number>; listings: Record<string, number>; advance: (ms: number) => void }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cache-clock-'));
  const home = join(dir, 'shop');
  mkdirSync(home);
  writeFileSync(join(home, 'instance.yaml'), 'version: 1\nname: shop\nrepos: [{ path: ./repo, repo: example/shop }]\n');
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: false\n');
  const token = join(home, 'discord-token');
  const key = join(home, 'linear-api-key');
  writeFileSync(token, 'MTAwMDAwMDAwMDAwMDAwMDAx.fake02.placeholder-bot-token-value\n', { mode: 0o400 });
  writeFileSync(key, 'lin_api_PLACEHOLDERKEY0000000000000000000000\n', { mode: 0o400 });
  writeFileSync(join(home, 'credentials.yaml'), `version: 1\ngithub: { kind: gh-config-dir, path: /nonexistent }\nintake: { discord_token: ${JSON.stringify(token)}, linear_api_key: ${JSON.stringify(key)} }\n`, { mode: 0o600 });
  const { dir: root } = exampleProject();
  const state = mkdtempSync(join(tmpdir(), 'cache-clock-state-'));
  const listings: Record<string, number> = { discord: 0, linear: 0 };
  const cli: RunCli = async (args) => {
    listings[args[0]!] = (listings[args[0]!] ?? 0) + 1;
    return { status: 0, stdout: `${JSON.stringify(args[0] === 'discord' ? BOT : LINEAR)}\n`, stderr: '' };
  };
  let t = 1_000;
  const dash = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(state, 'events.db'), stateDir: join(state, 'state'), user: 'example-owner', roleOf: exampleRoles, instance: 'shop', policyFile: join(home, 'policy.yaml'), slotsDir: join(state, 'slots'), webDir: join(state, 'web'), discordListing: discordListingStandIn(cli), now: () => t });
  const base = dash.url.split('/?')[0]!;
  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${dash.token}`, ...asPerson('example-owner') } });
    await r.text();
    return r.status;
  };
  const wall = Date.now;
  try {
    await fn({ get, listings, advance: (ms) => (t += ms) });
  } finally {
    Date.now = wall;
    await dash.close();
  }
}

test('a wall-clock step back does not keep a listing cache', { skip: !posix && 'POSIX modes' }, async () => {
  await withDashboard(async ({ get, listings, advance }) => {
    assert.equal(await get('/api/first-run/discord/channels'), 200);
    assert.equal(await get('/api/first-run/linear/view'), 200);
    assert.deepEqual(listings, { discord: 1, linear: 1 });
    // Asked fresh within 5 s: the listing kept.
    advance(4_900);
    assert.equal(await get('/api/first-run/discord/channels?fresh=1'), 200);
    assert.equal(await get('/api/first-run/linear/view?fresh=1'), 200);
    assert.deepEqual(listings, { discord: 1, linear: 1 }, 'kept for 5 s when asked fresh');
    // 5.1 s have passed, and the wall clock stepped back 3 s meanwhile: asked fresh, listed again.
    const wall = Date.now;
    Date.now = () => wall() - 3_000;
    advance(200);
    assert.equal(await get('/api/first-run/discord/channels?fresh=1'), 200);
    assert.equal(await get('/api/first-run/linear/view?fresh=1'), 200);
    assert.deepEqual(listings, { discord: 2, linear: 2 }, 'a step back of the wall clock kept the listing');
  });
});

test('a wall-clock step forward does not expire a cache', { skip: !posix && 'POSIX modes' }, async () => {
  await withDashboard(async ({ get, listings, advance }) => {
    assert.equal(await get('/api/first-run/discord/channels'), 200);
    assert.equal(await get('/api/first-run/linear/view'), 200);
    // A second later the wall clock jumps an hour ahead: the listing is still a second old, so it's kept.
    const wall = Date.now;
    Date.now = () => wall() + 3_600_000;
    advance(1_000);
    assert.equal(await get('/api/first-run/discord/channels'), 200);
    assert.equal(await get('/api/first-run/linear/view'), 200);
    assert.deepEqual(listings, { discord: 1, linear: 1 }, 'a step forward of the wall clock expired the listing');
    // The 60 s window itself is unchanged: kept at 59.9 s, listed again at 60.1 s.
    advance(58_900);
    assert.equal(await get('/api/first-run/discord/channels'), 200);
    assert.deepEqual(listings, { discord: 1, linear: 1 });
    advance(200);
    assert.equal(await get('/api/first-run/discord/channels'), 200);
    assert.equal(await get('/api/first-run/linear/view'), 200);
    assert.deepEqual(listings, { discord: 2, linear: 2 });
  });
});
