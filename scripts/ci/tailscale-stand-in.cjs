#!/usr/bin/env node
// CI's and the tests' stand-in for the tailscale CLI (scripts/setup/tailscale.sh; the "add-project (real systemd)"
// job installs the real package first, from the signed repository, then puts this in its place: nobody can log a CI
// machine in to a tailnet). It keeps its state in one directory ($TAILSCALE_STAND_IN_DIR, else /var/lib/ci-tailscale):
//   state.json   what `status --json` prints (default: NeedsLogin, no name)
//   serve.json   what `serve status --json` prints (default: {})
//   calls        every argument list it was given, one JSON array a line, and whether TS_AUTHKEY was in its environment
//   last-url     the login link its last `up` printed
//   login.json   written by the test to "log in": the state `up` moves to. `up` waits for it, as the real one waits for
//                the owner, until its --timeout.
// It answers: version; status --json; up --timeout=<n>s; serve --bg --https=443|8443|8444 <target>; serve --https=8443 off; serve status --json. Anything
// else, an auth key among them: exit 64.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = process.env.TAILSCALE_STAND_IN_DIR || '/var/lib/ci-tailscale';
const args = process.argv.slice(2);
try {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'calls'), `${JSON.stringify({ args, authkey_env: 'TS_AUTHKEY' in process.env || 'TS_AUTH_KEY' in process.env })}\n`);
} catch {
  // asked by a user who can't write there (status needs no root): answered all the same
}
const read = (name, otherwise) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return otherwise;
  }
};
const is = (...want) => args.length === want.length && want.every((w, i) => (w instanceof RegExp ? w.test(args[i]) : w === args[i]));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (is('version')) {
  process.stdout.write('1.104.1\n  tailscale commit: stand-in\n');
} else if (is('status', '--json')) {
  process.stdout.write(`${JSON.stringify(read('state.json', { BackendState: 'NeedsLogin', Self: { DNSName: '' }, CertDomains: null }), null, 2)}\n`);
} else if (is('serve', 'status', '--json')) {
  process.stdout.write(`${JSON.stringify(read('serve.json', {}))}\n`);
} else if (is('up', /^--timeout=[0-9]+s$/)) {
  if (read('state.json', {}).BackendState === 'Running') process.exit(0);
  const seconds = Number(/[0-9]+/.exec(args[1])[0]);
  // An odd link when the test asks for one (odd-url holds it): what the script must refuse to pass on.
  let url = `https://login.tailscale.com/a/${crypto.randomBytes(8).toString('hex')}`;
  try {
    url = fs.readFileSync(path.join(dir, 'odd-url'), 'utf8').trim() || url;
  } catch {
    // the usual link
  }
  fs.writeFileSync(path.join(dir, 'last-url'), `${url}\n`, { mode: 0o600 });
  process.stderr.write(`\nTo authenticate, visit:\n\n\t${url}\n\n`);
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const to = read('login.json', null);
    if (to) {
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(to));
      fs.rmSync(path.join(dir, 'login.json'), { force: true });
      process.stdout.write('Success.\n');
      process.exit(0);
    }
    if (Date.now() >= until) {
      process.stderr.write('timeout waiting for Tailscale service to enter a Running state; check health with "tailscale status"\n');
      process.exit(1);
    }
    sleep(200);
  }
} else if (is('serve', '--bg', /^--https=(443|8443|8444)$/, /^http:\/\/127\.0\.0\.1:[0-9]+$/)) {
  const s = read('state.json', {});
  const name = ((s.Self && s.Self.DNSName) || '').replace(/\.$/, '');
  if (s.BackendState !== 'Running' || !name) {
    process.stderr.write('tailscale is not running\n');
    process.exit(1);
  }
  // 443 (the hub): written afresh, as it always was here. 8443 (the Siri gateway) and 8444 (the hooks gateway): added beside what is served already.
  const port = args[2].slice('--https='.length);
  const sv = port === '443' ? {} : read('serve.json', {});
  const next = { TCP: { ...(sv.TCP || {}), [port]: { HTTPS: true } }, Web: { ...(sv.Web || {}), [`${name}:${port}`]: { Handlers: { '/': { Proxy: args[3] } } } } };
  fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify(next));
  process.stdout.write(`Available within your tailnet:\n\nhttps://${name}${port === '443' ? '' : `:${port}`}/\n|-- proxy ${args[3]}\n\nServe started and running in the background.\n`);
} else if (is('serve', /^--https=8443$/, 'off')) {
  // One port's forward taken away (the removed Siri gateway's 8443), everything else served as it was.
  const s = read('state.json', {});
  const name = ((s.Self && s.Self.DNSName) || '').replace(/\.$/, '');
  const sv = read('serve.json', {});
  const tcp = { ...(sv.TCP || {}) };
  delete tcp['8443'];
  const web = { ...(sv.Web || {}) };
  delete web[`${name}:8443`];
  fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify({ ...sv, TCP: tcp, Web: web }));
} else {
  process.stderr.write(`tailscale stand-in: not something it answers (asked: ${args.join(' ')})\n`);
  process.exit(64);
}
