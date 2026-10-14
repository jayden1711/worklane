#!/usr/bin/env node
// Install this repo's pre-push hook (the push gate) into the repo's common hooks dir, where every worktree runs it.
//
//   npm run setup:hooks        (run it again after the hook changes; it replaces its own earlier install)
//
// WHY: the hook is a copy outside any branch (scripts/push-gate-hook.mjs, beside a three-line sh stub), so the
// branch being pushed can't change it; and the copy holds no rules of its own: it loads the gate and its rules
// from origin's default branch on every push. The older `core.hooksPath=.githooks` setup ran the hook straight
// from the checked-out branch, so this unsets it.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '# managed by setup-hooks: push gate';
const LAUNCHER = 'push-gate-hook.mjs';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};

function fail(why) {
  console.error(`setup-hooks: ${why}`);
  process.exit(1);
}

if (tryGit('rev-parse', '--git-dir') === null) fail('not in a git repository');
if (tryGit('config', '--local', '--get', 'core.hooksPath') === '.githooks') {
  git('config', '--local', '--unset', 'core.hooksPath');
  console.log('unset core.hooksPath=.githooks (that hook ran from whatever branch was checked out)');
}
const elsewhere = tryGit('config', '--get', 'core.hooksPath');
if (elsewhere) fail(`core.hooksPath is ${elsewhere}: git would not run a hook installed in the repo's own hooks dir. Unset it, or install the gate there by hand.`);

const hooks = join(resolve(git('rev-parse', '--git-common-dir')), 'hooks');
const hook = join(hooks, 'pre-push');
mkdirSync(hooks, { recursive: true });
if (existsSync(hook)) {
  const old = readFileSync(hook, 'utf8');
  if (!old.includes(MARKER)) {
    // WHY: an earlier, hand-installed gate hook is replaced (and kept beside it); anyone else's hook is not ours to drop.
    if (!old.includes('push-gate.mjs')) fail(`${hook} is another pre-push hook. Move it aside (or chain the gate into it by hand), then run this again.`);
    renameSync(hook, `${hook}.before-push-gate`);
    console.log(`kept the earlier gate hook as ${hook}.before-push-gate`);
  }
}
copyFileSync(fileURLToPath(new URL(`./${LAUNCHER}`, import.meta.url)), join(hooks, LAUNCHER));
writeFileSync(hook, `#!/bin/sh\n${MARKER} (rules from origin's default branch). Reinstall: npm run setup:hooks\nexec node "$(dirname "$0")/${LAUNCHER}" "$@"\n`);
chmodSync(hook, 0o755);
console.log(`push gate installed: ${hook}`);
