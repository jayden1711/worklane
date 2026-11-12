#!/usr/bin/env node
// Install this repo's pre-push hook (the push gate) into the repo's common hooks dir, where every worktree runs it.
//
//   npm run setup:hooks        (run it again after the hook changes; it replaces its own earlier install)
//
// WHY: the hook is a copy outside any branch (scripts/push-gate-hook.mjs, beside a three-line sh stub), so the
// branch being pushed can't change it; and the copy holds no rules of its own: it loads the gate and its rules
// from origin's default branch on every push. The older `core.hooksPath=.githooks` setup ran the hook straight
// from the checked-out branch, so this unsets it.
import { gitExecFileSync } from './lib/git.cjs';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '# managed by setup-hooks: push gate';
const LAUNCHER = 'push-gate-hook.mjs';
const git = (...a) => gitExecFileSync(a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

// WHY (2026-11-12): every worktree of a repository shares one hooks dir, so installing from a branch's checkout into
// its own repository puts that branch's unmerged hook in front of every worktree and every push (it happened: a
// branch's commit-msg hook ran for every builder until the owner restored main's). Into this checkout's own
// repository, then, only a checkout at origin's default branch installs: HEAD at the fetched origin/<default>
// commit, and the files it copies unedited. Installing into another repository (a scratch repo, a test's) is not
// limited: its hooks are its own.
const SRC_FILES = ['scripts/setup-hooks.mjs', `scripts/${LAUNCHER}`, 'scripts/lib/git.cjs'];
const real = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
const srcTop = fileURLToPath(new URL('..', import.meta.url));
const inSrc = (...a) => tryGit('-C', srcTop, ...a);
const srcCommon = inSrc('rev-parse', '--git-common-dir');
const targetCommon = real(resolve(git('rev-parse', '--git-common-dir')));
if (srcCommon !== null && real(resolve(srcTop, srcCommon)) === targetCommon) {
  const head = inSrc('rev-parse', '--verify', 'HEAD^{commit}');
  const named = inSrc('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  const branch = named?.startsWith('origin/') ? named.slice('origin/'.length) : 'main';
  const want = inSrc('rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`);
  // Each file it copies, as on disk, against origin/<default>'s blob of it (no listing of changed names).
  const edited = want === null ? [] : SRC_FILES.filter((f) => inSrc('hash-object', '--', f) !== inSrc('rev-parse', '--verify', `${want}:${f}`));
  const why = want === null
    ? `there is no fetched origin/${branch} to compare with (git fetch origin first)`
    : head !== want
      ? `this checkout's HEAD (${head?.slice(0, 8) ?? 'none'}${inSrc('symbolic-ref', '--quiet', '--short', 'HEAD') ? `, on ${inSrc('symbolic-ref', '--quiet', '--short', 'HEAD')}` : ', detached'}) is not origin/${branch} (${want.slice(0, 8)})`
      : edited.length
        ? `the files it would copy differ from origin/${branch}'s in this checkout:\n${edited.map((f) => `    ${f}`).join('\n')}`
        : null;
  if (why) {
    const hooksDir = join(targetCommon, 'hooks');
    fail(
      [
        `refused: ${why}.`,
        `It would have installed, into ${hooksDir} (shared by every worktree of this repository):`,
        `  ${join(hooksDir, 'pre-push')}: the gate's stub`,
        `  ${join(hooksDir, LAUNCHER)}: a copy of ${join(srcTop, 'scripts', LAUNCHER)}`,
        `Install from a checkout of origin/${branch} (git fetch origin, then run it in a checkout or a worktree at origin/${branch}).`,
      ].join('\n'),
    );
  }
}
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
