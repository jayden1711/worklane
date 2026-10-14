// CI and tests only: a stand-in for GitHub's hosts, on this machine. The engine has no setting that names another
// GitHub: its hosts are constants (src/github-hosts.ts), because every call to them carries a credential. So a test or
// CI job that runs the engine as its own process against a fake GitHub (test/fake-github.ts) loads this file into that
// process instead:
//
//   CI_LOOPBACK_GITHUB_PORT=<port> node --import <this file> dist/src/cli.js ...
//   (or NODE_OPTIONS=--import=<this file>, for a unit or a setup script that starts node itself; with
//   `<this file>?port=<port>` the port travels inside NODE_OPTIONS, through a user switch that clears the rest)
//
// What it does, in that one process:
// - fetch to https://api.github.com, https://github.com or https://uploads.github.com goes to
//   http://127.0.0.1:<port> instead, path and query kept;
// - fetch to this machine (127.0.0.1, localhost, [::1]) is left alone (the hub, an instance's dashboard);
// - fetch to anything else is REFUSED: nothing leaves the machine through a process this is loaded into;
// - for `git-credential` only, the host git asks about (127.0.0.1:<port>, where the job's git config sends
//   https://github.com/ URLs) is read as github.com, so the engine's credential helper answers for it.
//
// INVARIANT: the only thing it can be told is a port on 127.0.0.1. It cannot be pointed at another machine.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const PORT_VARIABLE = 'CI_LOOPBACK_GITHUB_PORT';
const GITHUB = new Set(['https://api.github.com', 'https://github.com', 'https://uploads.github.com']);
const HERE = new Set(['127.0.0.1', 'localhost', '[::1]']);

const port = new URL(import.meta.url).searchParams.get('port') ?? process.env[PORT_VARIABLE] ?? '';
if (!/^[1-9][0-9]{1,4}$/.test(port) || Number(port) > 65535) {
  // Loaded without a port: refuse to run at all, rather than run against the real GitHub by accident.
  console.error(`loopback-github: ${PORT_VARIABLE} (or ?port=) must be a port on 127.0.0.1 (got "${port.slice(0, 20)}")`);
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;

/** Where a request really goes: the loopback GitHub, this machine as asked, or nowhere. */
export function loopbackTarget(url) {
  const u = new URL(url);
  if (GITHUB.has(u.origin)) return `${base}${u.pathname}${u.search}`;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && HERE.has(u.hostname)) return u.toString();
  throw new Error(`loopback-github: refused ${u.origin}: a process with the loopback GitHub reaches this machine only`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (input instanceof Request) return realFetch(new Request(loopbackTarget(input.url), input), init);
  return realFetch(loopbackTarget(String(input)), init);
};

// git's credential helper protocol on stdin: `host=127.0.0.1:<port>` is the job's stand-in for github.com.
if (process.argv.includes('git-credential')) {
  const asked = readFileSync(0, 'utf8')
    .replace(new RegExp(`^host=127\\.0\\.0\\.1:${port}$`, 'm'), 'host=github.com')
    .replace(/^protocol=http$/m, 'protocol=https');
  Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(asked)]), configurable: true });
}
