#!/usr/bin/env node
// CI only (the "add-project (real systemd)" job in .github/workflows/ci-slow.yml): the fake GitHub the manifest flow's
// tests use (test/fake-github.ts, built to dist/test), as a server, for add-project.sh end to end on a real host. The
// App (id 91) is installed on <owner/repo> alone, with the agent App's permissions; the repo is served over git's
// smart HTTP from <git root>, to the installation token only. Every request goes to <log file>, one line each, with
// the git user for git's (x-access-token when it came through the App's credential helper).
//
//   node fake-github.mjs <dist dir> <port> <git root> <owner/repo> <log file>
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, port, gitRoot, repo, logFile] = process.argv.slice(2);
if (!dist || !port || !gitRoot || !repo || !logFile) {
  console.error('usage: fake-github.mjs <dist dir> <port> <git root> <owner/repo> <log file>');
  process.exit(2);
}
const { fakeGitHub } = await import(pathToFileURL(join(dist, 'test', 'fake-github.js')).href);
const { AGENT_APP_PERMISSIONS } = await import(pathToFileURL(join(dist, 'src', 'setup', 'app-manifest.js')).href);
const gh = await fakeGitHub({ repo, permissions: { ...AGENT_APP_PERMISSIONS }, installed: true, gitRoot, lenient: true, port: Number(port), log: (l) => appendFileSync(logFile, `${l}\n`) });
// The manifest code GitHub would send back once the owner approves the dashboard's sign-in App (the hub's setup mode,
// dashboards.sh --setup): converted once, to client id Iv1.madeapp00001 and the fake's client secret.
gh.codes.set('ci-signin-code', { slug: 'ci-dash-signin', id: 92 });
console.log(`fake GitHub at ${gh.url}, ${repo} at ${join(gitRoot, `${repo}.git`)}`);
