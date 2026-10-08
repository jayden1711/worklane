#!/usr/bin/env node
// Cut a release tag whose commit contains the built dist/, so projects can
// install `github:<owner>/<repo>#vX.Y.Z` without running install scripts
// (npm 11 blocks them by default). main itself never holds build output:
// the tag points at a release commit on top of main.
//   node scripts/release.mjs 0.1.1
import { execFileSync } from 'node:child_process';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('usage: release.mjs X.Y.Z');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('working tree not clean');
const pkg = JSON.parse(git('show', 'HEAD:package.json'));
if (pkg.version !== version) throw new Error(`package.json is ${pkg.version}, not ${version}`);
const head = git('rev-parse', 'HEAD');
// Where to come back to: the branch if on one, else the exact commit (a detached start has no `-`).
let back = head;
try {
  back = git('symbolic-ref', '-q', '--short', 'HEAD');
} catch {
  // detached
}
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
execFileSync('npm', ['run', 'build:web'], { stdio: 'inherit' });
execFileSync('npm', ['test'], { stdio: 'inherit' });
git('checkout', '-q', '--detach');
try {
  git('add', '-f', 'dist/src', 'dist/web');
  git('commit', '-q', '-s', '-m', `Release v${version} (with built dist/)`);
  git('tag', '-a', `v${version}`, '-m', `v${version}`);
  console.log(`tagged v${version} at ${git('rev-parse', 'HEAD')} (on top of ${head.slice(0, 7)})`);
} finally {
  git('checkout', '-q', back);
  // Leaving the release commit deletes its tracked dist/ from the working tree.
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' });
  execFileSync('npm', ['run', 'build:web'], { stdio: 'ignore' });
}
console.log(`push with: git push origin v${version}`);
