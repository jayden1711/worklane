#!/usr/bin/env node
// CI only (ci-slow.yml, add-project (real systemd), the outbound env step): an HTTPS server on 127.0.0.1 whose
// certificate only a throwaway test CA signs, so a git or gh child gets past TLS only when it trusts that CA (root's
// network.json ca_file, #396), never through an inherited variable. Loopback only: nothing leaves the runner.
//   node test-ca-server.mjs <cert.pem> <key.pem> <port>
// It answers:
//   GET /<repo>.git/info/refs?service=git-upload-pack  a smart-HTTP v0 advertisement of one ref (refs/heads/main), so
//                                                       `git ls-remote` lists it and exits 0;
//   anything else                                       200 {"probe":"ci-probe-ok"}, for `gh api --hostname`.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const [cert, key, port] = process.argv.slice(2);
if (!cert || !key || !port) {
  console.error('usage: test-ca-server.mjs <cert.pem> <key.pem> <port>');
  process.exit(2);
}

/** One pkt-line: four hex digits of the whole length, then the payload. */
const pkt = (s) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, '0')}${s}`;
const SHA = '1'.repeat(40);

createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const url = new URL(req.url ?? '/', 'https://127.0.0.1');
  console.log(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname.endsWith('/info/refs') && url.searchParams.get('service') === 'git-upload-pack') {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
    res.end(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${SHA} refs/heads/main\0agent=ci-test-ca-server\n`)}0000`);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ probe: 'ci-probe-ok' }));
}).listen(Number(port), '127.0.0.1', () => console.log(`listening on 127.0.0.1:${port}`));
