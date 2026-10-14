// CI only (the real-systemd job): the engine's own `discord channels --json` code, run as an instance's coordinator
// user, with Discord stood in for in code. The listing has no setting for its host (its base URL is a constant), so
// this injects `fetch`, as the unit tests do: what the listing asks of Discord's base goes to scripts/ci/fake-discord.mjs
// on this machine instead. The token is read by the listing itself, from the instance's own file.
//
//   node discord-listing-fake.mjs <built engine's dist> <instance> http://127.0.0.1:<port>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, instance, fake] = process.argv.slice(2);
if (!dist || !instance || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(fake ?? '')) {
  console.error('usage: discord-listing-fake.mjs <dist> <instance> http://127.0.0.1:<port>');
  process.exit(2);
}
const mod = (p) => import(pathToFileURL(join(dist, p)).href);
const { discordChannelsCommand } = await mod('src/intake/discord-channels.js');
const { API } = await mod('src/intake/discord.js');
const toFake = (url, init) => {
  if (!String(url).startsWith(`${API}/`)) throw new Error(`the listing asked ${String(url).split('?')[0]}, not Discord's base`);
  return fetch(`${fake}${String(url).slice(API.length)}`, init);
};
process.exit(await discordChannelsCommand({ instance, json: true, fetch: toFake }));
