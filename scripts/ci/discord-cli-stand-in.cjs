#!/usr/bin/env node
// CI's stand-in for the engine's CLI on a dashboard unit's PATH (the real-systemd job), as claude-stand-in.cjs is for
// claude: the dashboard's Discord step runs `<cli> discord channels --instance <name> --json` as a child process, and
// here that answers with canned JSON naming the user it ran as. It reads no token and makes no request, so nothing
// in CI asks Discord. Anything else it is asked goes to the real CLI unchanged.
const { spawnSync } = require('node:child_process');
const { userInfo } = require('node:os');

const REAL = '/usr/local/bin/worklane';
const args = process.argv.slice(2);
if (args.length === 5 && args[0] === 'discord' && args[1] === 'channels' && args[2] === '--instance' && /^[a-z][a-z0-9-]{0,40}$/.test(args[3]) && args[4] === '--json') {
  console.log(
    JSON.stringify({
      application: { id: '700000000000000001', name: `stand-in for ${args[3]}, run as ${userInfo().username}`, message_content: true },
      channels: [
        { guild_id: '900000000000000001', guild: 'Alpha Server', id: '100000000000000011', name: 'general', type: 0 },
        { guild_id: '900000000000000001', guild: 'Alpha Server', id: '100000000000000017', name: 'superfan-shop', type: 0 },
      ],
    }),
  );
  process.exit(0);
}
const r = spawnSync(REAL, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
