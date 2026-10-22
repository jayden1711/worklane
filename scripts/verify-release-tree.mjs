#!/usr/bin/env node
// Before CI stages a release on npm (release.yml): every file in the tarball it would stage is, byte for byte, the
// file the signed release commit holds (#458: v0.5.0's tarball carried a rebuilt dist/web/licenses.txt that wasn't the
// signed one).
//
//   node scripts/verify-release-tree.mjs <package.tgz> --commit <the tag's commit>
//
// Fails closed, listing each file that differs from the commit or isn't in it at all. The tarball may hold fewer
// files than the commit (package.json's `files`), never other or changed ones. Compared by git blob id
// (scripts/lib/release-tree.mjs): raw bytes, no line-ending conversion.
// On success it prints `same as the signed tree: <n> files at <commit>` and exits 0.
import { execFileSync } from 'node:child_process';
import { gitExecFileSync } from './lib/git.cjs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesUnder, treeDifferences } from './lib/release-tree.mjs';

const args = process.argv.slice(2);
const tgz = args[0];
const i = args.indexOf('--commit');
const commit = i >= 0 ? args[i + 1] : undefined;
const fail = (msg) => {
  console.error(`verify-release-tree: refused: ${msg}`);
  process.exit(1);
};
if (!tgz || !commit || !existsSync(tgz)) fail('usage: verify-release-tree.mjs <package.tgz> --commit <sha>');
let sha;
try {
  sha = gitExecFileSync(['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch {
  fail(`${commit} is not a commit here`);
}
const tmp = mkdtempSync(join(tmpdir(), 'release-tree-'));
let refusal = '';
let count = 0;
try {
  execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
  const dir = join(tmp, 'package');
  const files = filesUnder(dir);
  count = files.length;
  const tops = [...new Set(files.map((p) => p.split('/')[0]))];
  const diff = count ? treeDifferences({ dir, commit: sha, prefixes: tops, exact: false }) : [];
  if (!count) refusal = `${tgz} holds no package/ files`;
  else if (diff.length) refusal = `the tarball is not the signed tree at ${sha} (${diff.length} file(s)); nothing may be staged:\n  ${diff.join('\n  ')}`;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (refusal) fail(refusal);
console.log(`same as the signed tree: ${count} files at ${sha}`);
