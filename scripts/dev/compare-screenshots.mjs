#!/usr/bin/env node
// Before/after screenshots of every dashboard page: builds two refs of this repo
// (default: origin/main and the current branch) in temporary clones, then runs
// scripts/dev/screenshots.mjs against each. Needs git, npm and an installed
// Chrome or Chromium. macOS, Linux and Windows.
//   node scripts/dev/compare-screenshots.mjs [--base <ref>] [--head <ref>] [--out <dir>] [--chrome <path>]
// Writes <out>/before/*.png and <out>/after/*.png (light and dark per page).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const repo = fileURLToPath(new URL('../..', import.meta.url));
const run = (cmd, args, cwd) => {
  // npm is npm.cmd on Windows, which only a shell resolves.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}`);
};
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

run('git', ['fetch', '-q', 'origin'], repo);
const base = arg('--base', 'origin/main');
const head = arg('--head', git('rev-parse', '--abbrev-ref', 'HEAD'));
const out = resolve(arg('--out', 'screenshots'));
const chrome = arg('--chrome');
const work = mkdtempSync(join(tmpdir(), 'dash-compare-'));
const script = join(repo, 'scripts', 'dev', 'screenshots.mjs');
try {
  for (const [label, ref] of [['before', base], ['after', head]]) {
    const dir = join(work, label);
    console.log(`\n== ${label}: ${ref}`);
    run('git', ['clone', '-q', repo, dir], repo);
    // A clone gets this repo's branches, not its remote-tracking refs (origin/main): fetch those too.
    run('git', ['fetch', '-q', 'origin', '+refs/remotes/origin/*:refs/remotes/origin/*'], dir);
    run('git', ['checkout', '-q', '--detach', git('rev-parse', ref)], dir);
    run('npm', ['ci', '--no-audit', '--no-fund'], dir);
    run('npm', ['run', '-s', 'build'], dir);
    run('npm', ['run', '-s', 'build:web'], dir);
    run(process.execPath, [script, '--engine', dir, '--out', join(out, label), ...(chrome ? ['--chrome', chrome] : [])], dir);
  }
  console.log(`\nbefore: ${join(out, 'before')}\nafter:  ${join(out, 'after')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
