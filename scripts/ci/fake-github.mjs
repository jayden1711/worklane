#!/usr/bin/env node
// CI only (the "add-project (real systemd)" job in .github/workflows/ci-slow.yml): the fake GitHub the manifest flow's
// tests use (test/fake-github.ts, built to dist/test), as a server, for add-project.sh end to end on a real host. The
// App (id 91) is installed on <owner/repo> alone, with the agent App's permissions; the repo is served over git's
// smart HTTP from <git root>, to the installation token only. Every request goes to <log file>, one line each, with
// the git user for git's (x-access-token when it came through the App's credential helper). With <key.pem>, a manifest
// conversion returns that key; the job plays GitHub's side of the manifest flow and of sign-in through /_fake/
// (scripts/ci/manifest-browser.mjs).
//
//   node fake-github.mjs <dist dir> <port> <git root> <owner/repo> <log file> [<key.pem>]
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, port, gitRoot, repo, logFile, pem] = process.argv.slice(2);
if (!dist || !port || !gitRoot || !repo || !logFile) {
  console.error('usage: fake-github.mjs <dist dir> <port> <git root> <owner/repo> <log file> [<key.pem>]');
  process.exit(2);
}
const { fakeGitHub, FAKE_PEM } = await import(pathToFileURL(join(dist, 'test', 'fake-github.js')).href);
const { AGENT_APP_PERMISSIONS } = await import(pathToFileURL(join(dist, 'src', 'setup', 'app-manifest.js')).href);
if (pem) FAKE_PEM.value = readFileSync(pem, 'utf8');
// The log never holds a manifest code: GitHub's conversion call carries it in its path.
const safe = (l) => l.replace(/(\/app-manifests\/)[^/]+(\/conversions)/, '$1<code>$2');
const gh = await fakeGitHub({ repo, permissions: { ...AGENT_APP_PERMISSIONS }, installed: true, gitRoot, lenient: true, control: true, port: Number(port), log: (l) => appendFileSync(logFile, `${safe(l)}\n`) });
console.log(`fake GitHub at ${gh.url}, ${repo} at ${join(gitRoot, `${repo}.git`)}`);
