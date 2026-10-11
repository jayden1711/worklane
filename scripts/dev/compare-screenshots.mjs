#!/usr/bin/env node
// Before/after screenshots of every dashboard page: builds two refs of this repo
// (default: origin/main and the current branch) in temporary clones, then runs
// scripts/dev/screenshots.mjs against each. Needs git, npm and an installed
// Chrome or Chromium. macOS, Linux and Windows.
//   node scripts/dev/compare-screenshots.mjs [--base <ref>] [--head <ref>] [--out <dir>] [--chrome <path>]
// Writes <out>/before/*.png and <out>/after/*.png (light and dark per page).
// Stopped (Ctrl-C, a signal) or failing partway, it stops the step it is running, whose own clean-up
// stops what that step started (the screenshot script's dashboards and Chrome), and removes its clones.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCleanup } from './children.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const repo = fileURLToPath(new URL('../..', import.meta.url));
const cleanup = exitCleanup();
/** One step, as a child this script stops if it ends first (a synchronous child would be left running). */
const run = (cmd, args, cwd) =>
  new Promise((ok, fail) => {
    // npm is npm.cmd on Windows, which only a shell resolves.
    const p = cleanup.track(spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' }));
    p.on('error', fail);
    p.on('exit', (code, signal) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} failed in ${cwd}${signal ? ` (${signal})` : ''}`))));
  });
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

await run('git', ['fetch', '-q', 'origin'], repo);
const base = arg('--base', 'origin/main');
const head = arg('--head', git('rev-parse', '--abbrev-ref', 'HEAD'));
const out = resolve(arg('--out', 'screenshots'));
const chrome = arg('--chrome');
const work = mkdtempSync(join(tmpdir(), 'dash-compare-'));
cleanup.finally(() => rmSync(work, { recursive: true, force: true }));
const script = join(repo, 'scripts', 'dev', 'screenshots.mjs');
for (const [label, ref] of [['before', base], ['after', head]]) {
  const dir = join(work, label);
  console.log(`\n== ${label}: ${ref}`);
  await run('git', ['clone', '-q', repo, dir], repo);
  // A clone gets this repo's branches, not its remote-tracking refs (origin/main): fetch those too.
  await run('git', ['fetch', '-q', 'origin', '+refs/remotes/origin/*:refs/remotes/origin/*'], dir);
  await run('git', ['checkout', '-q', '--detach', git('rev-parse', ref)], dir);
  await run('npm', ['ci', '--no-audit', '--no-fund'], dir);
  await run('npm', ['run', '-s', 'build'], dir);
  await run('npm', ['run', '-s', 'build:web'], dir);
  await run(process.execPath, [script, '--engine', dir, '--out', join(out, label), ...(chrome ? ['--chrome', chrome] : [])], dir);
}
console.log(`\nbefore: ${join(out, 'before')}\nafter:  ${join(out, 'after')}`);
