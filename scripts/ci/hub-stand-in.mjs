#!/usr/bin/env node
// CI only (the "add-project (real systemd)" job in .github/workflows/ci-slow.yml): a stand-in for the dashboard hub
// while add-project.sh makes an instance's GitHub App through the manifest flow, run as the hub's own user (wl-dash)
// in place of its stopped unit, on the hub's two ports, with the hub's own state directory (so add-project finds the
// hub's token where it looks).
//
// WHY a stand-in: the manifest flow's callback needs a machine owner signed in, and the hub signs people in at
// github.com only. Its sign-in hosts are constants, with no override, because the sign-in App's client secret goes to
// them. So the real hub can't sign anyone in against the job's fake GitHub. This runs the hub's own code
// (startHub: the same manifest routes, sessions and machine-owner check) with its sign-in pointed at the fake GitHub
// through startHub's in-process options, as the unit tests do. No real secret is involved: the sign-in client secret it
// sends the fake is the made-up constant below, not the machine's.
//
//   node hub-stand-in.mjs <dist dir> <fake GitHub> <hub public origin>
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, gh, publicUrl] = process.argv.slice(2);
if (!dist || !gh || !publicUrl) {
  console.error('usage: hub-stand-in.mjs <dist dir> <fake GitHub> <hub public origin>');
  process.exit(2);
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(gh)) {
  console.error('the stand-in talks to a fake GitHub on this machine only (http://127.0.0.1:<port>)');
  process.exit(2);
}
const { startHub, HUB_PORT, HUB_BREAK_GLASS_PORT } = await import(pathToFileURL(join(dist, 'src', 'dashboard-hub.js')).href);
const home = userInfo().homedir;
// The hub's own session secret, so its sessions file stays readable to the real hub afterwards. It signs session ids
// on this machine and is never sent anywhere.
const sessionSecret = readFileSync(join(home, '.config', 'dashboard-signin', 'session-secret'), 'utf8').trim();
const h = await startHub({
  instances: [],
  stateDir: join(home, '.local', 'state', 'worklane', 'dashboard-hub'),
  webDir: join(dist, 'web'),
  port: HUB_PORT,
  breakGlassPort: HUB_BREAK_GLASS_PORT,
  signIn: { clientId: 'Iv1.cistandin0001', clientSecret: 'ci-stand-in-not-a-secret', sessionSecret, publicUrl, web: gh, api: gh },
  appManifest: { api: gh, web: gh },
});
console.log(`hub stand-in as ${userInfo().username} on ${h.url}, GitHub at ${gh}`);
process.on('SIGTERM', () => {
  // Free the ports at once: the real hub starts on them next. An open keep-alive connection must not hold that up.
  setTimeout(() => process.exit(0), 1000).unref();
  void h.close().then(() => process.exit(0));
});
