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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

// WHY (2026-11-12): every worktree of a repository shares one hooks dir, so a branch's copy installed there runs for
// every worktree and every push (it happened: a branch's commit-msg hook ran for every builder until the owner
// restored main's). So the TARGET decides, whatever checkout or copy the installer runs from (R1283b), and it fails
// CLOSED (R1283c, R1283d): in a repository that holds the gate anywhere (its HEAD, a branch or a remote-tracking
// ref), every file it would copy must be origin's default branch's, byte for byte; when that commit can't be found
// (no remote named origin, a dangling or gate-less origin/HEAD, a bare clone with no origin refs), it refuses. Only a
// repository with no gate anywhere (a scratch or test repo) has hooks of its own, and isn't limited.
const SRC_FILES = ['scripts/setup-hooks.mjs', `scripts/${LAUNCHER}`, 'scripts/lib/git.cjs'];
const GATE = `scripts/${LAUNCHER}`;
const srcTop = fileURLToPath(new URL('..', import.meta.url));
const targetCommon = resolve(git('rev-parse', '--git-common-dir'));
// A tree lookup only (no blob read, so a partial clone offline answers too: R1283c D2, R1283d D2).
const entry = (commit, path) => tryGit('rev-parse', '--verify', '--quiet', `${commit}:${path}`);
{
  const refs = (tryGit('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes') ?? '').split('\n').filter(Boolean);
  const holdsGate = entry('HEAD', GATE) !== null || refs.some((r) => entry(r, GATE) !== null);
  if (holdsGate) {
    // origin's default: origin/HEAD's branch if it resolves and holds the gate, else main; in a bare repository (a
    // `clone --bare` writes origin's branches as refs/heads/*: R1283c D1), the same names under refs/heads.
    const named = tryGit('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
    const head = named?.startsWith('refs/remotes/origin/') ? named.slice('refs/remotes/origin/'.length) : null;
    const bare = tryGit('config', '--bool', '--get', 'core.bare') === 'true';
    const tried = [...new Set([...(head ? [`refs/remotes/origin/${head}`] : []), 'refs/remotes/origin/main', ...(bare ? [...(head ? [`refs/heads/${head}`] : []), 'refs/heads/main'] : [])])];
    const ref = tried.find((r) => tryGit('rev-parse', '--verify', '--quiet', `${r}^{commit}`) !== null && entry(`${r}^{commit}`, GATE) !== null);
    const want = ref ? tryGit('rev-parse', '--verify', '--quiet', `${ref}^{commit}`) : null;
    const hooksDir = join(targetCommon, 'hooks');
    const would = [
      `It would have installed, into ${hooksDir} (shared by every worktree of this repository):`,
      `  ${join(hooksDir, 'pre-push')}: the gate's stub`,
      `  ${join(hooksDir, LAUNCHER)}: a copy of ${join(srcTop, 'scripts', LAUNCHER)}`,
    ];
    if (want === null) {
      fail([
        `refused: this repository holds the gate, but origin's default branch can't be found with it (tried ${tried.join(', ')}${named ? `; origin/HEAD names ${named}` : ''}), so there is nothing to check the files against.`,
        ...would,
        "Fetch origin's default branch into refs/remotes/origin (git fetch origin; a remote by another name: git remote rename <name> origin), then run this again from a checkout of it.",
      ].join('\n'));
    }
    // Each file as on disk (no filters: the bytes it would copy) against that commit's blob of it.
    const differ = SRC_FILES.filter((f) => tryGit('hash-object', '--no-filters', '--', join(srcTop, f)) !== entry(want, f));
    if (differ.length) {
      fail([
        `refused: the files it would copy aren't ${ref.replace(/^refs\/(remotes\/)?/, '')}'s (${want.slice(0, 8)}, as last fetched):`,
        ...differ.map((f) => `    ${join(srcTop, f)}`),
        ...would,
        `Install from a checkout of ${ref.replace(/^refs\/(remotes\/)?/, '')} (git fetch origin, then run it in a checkout or a worktree there).`,
      ].join('\n'));
    }
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
