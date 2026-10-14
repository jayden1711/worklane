// CI only (the real-systemd job): an instance's dashboard, the engine's own startDashboard, started in a unit of its
// own as the coordinator user, to show on a real host how its Discord listing is chosen. The listing is the engine's
// own cli.js by absolute path, and the only way to replace it is a stand-in made in code (discordListingStandIn).
//
//   node discord-seam-dashboard.mjs <dist> engine|stand-in|option <port> <instances dir> <checkout>
//     engine    no stand-in: the listing is the engine's own CLI, whatever PATH or the environment say
//     stand-in  the stand-in, set here in code: it answers in-process, naming the user it ran as
//     option    an option naming another program instead: refused (prints "refused: ..."), nothing started
// The dashboard listens on 127.0.0.1:<port>; its token is in <instances dir>/../state-<mode>/dashboard-token.
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, mode, port, instances, checkout] = process.argv.slice(2);
if (!dist || !['engine', 'stand-in', 'option'].includes(mode ?? '') || !/^[1-9][0-9]{0,4}$/.test(port ?? '') || !instances || !checkout) {
  console.error('usage: discord-seam-dashboard.mjs <dist> engine|stand-in|option <port> <instances dir> <checkout>');
  process.exit(2);
}
const mod = (p) => import(pathToFileURL(join(dist, p)).href);
const { startDashboard } = await mod('src/dashboard.js');
const { loadConfig } = await mod('src/config/load.js');
const { discordListingStandIn } = await mod('src/intake/discord-setup.js');

const seam = dirname(instances);
const opts = {
  root: checkout,
  cfg: loadConfig(checkout),
  eventsDb: join(seam, `events-${mode}.db`),
  stateDir: join(seam, `state-${mode}`),
  user: 'ci-owner',
  instance: 'ci',
  policyFile: join(instances, 'ci', 'policy.yaml'),
  slotsDir: join(seam, `slots-${mode}`),
  port: Number(port),
};
if (mode === 'option') {
  try {
    const d = await startDashboard({ ...opts, discordListing: '/usr/local/lib/ci-discord/worklane' });
    await d.close();
    console.log('accepted: an option naming another program was taken');
    process.exit(1);
  } catch (e) {
    console.log(`refused: ${e.message}`);
    process.exit(0);
  }
}
const standIn =
  mode === 'stand-in'
    ? discordListingStandIn(async (args) => ({
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          application: { id: '700000000000000001', name: `stand-in through the code seam for ${args[3]}, run as ${userInfo().username}`, message_content: true },
          channels: [{ guild_id: '900000000000000001', guild: 'Alpha Server', id: '100000000000000011', name: 'general', type: 0 }],
        }),
      }))
    : undefined;
const d = await startDashboard({ ...opts, ...(standIn ? { discordListing: standIn } : {}) });
console.log(`listening ${d.url.split('/?')[0]}`);
