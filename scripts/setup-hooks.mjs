#!/usr/bin/env node
// Install this repo's pre-push hook (the push gate) into the repo's common hooks dir, where every worktree runs it,
// and its commit-msg hook (#1259): the gate's own message rule (push-gate.mjs --commit-msg), run before a commit is
// made, so none is made that the gate would refuse and that would then have to be rewritten.
//
//   npm run setup:hooks        (run it again after the hook changes; it replaces its own earlier install)
//
// WHY: the hook is a copy outside any branch (scripts/push-gate-hook.mjs, beside a three-line sh stub), so the
// branch being pushed can't change it; and the copy holds no rules of its own: it loads the gate and its rules
// from origin's default branch on every push. The older `core.hooksPath=.githooks` setup ran the hook straight
// from the checked-out branch, so this unsets it.
import { gitExecFileSync } from './lib/git.cjs';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '# managed by setup-hooks: push gate';
const LAUNCHER = 'push-gate-hook.mjs';
const MSG_MARKER = '# managed by setup-hooks: commit-msg';
/** Where the commit-msg hook's copy of the gate goes, inside the hooks dir. */
const MSG_GATE = 'commit-msg-gate';
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
if (tryGit('config', '--local', '--get', 'core.hooksPath') === '.githooks') {
  git('config', '--local', '--unset', 'core.hooksPath');
  console.log('unset core.hooksPath=.githooks (that hook ran from whatever branch was checked out)');
}
const elsewhere = tryGit('config', '--get', 'core.hooksPath');
if (elsewhere) fail(`core.hooksPath is ${elsewhere}: git would not run a hook installed in the repo's own hooks dir. Unset it, or install the gate there by hand.`);

const hooks = join(resolve(git('rev-parse', '--git-common-dir')), 'hooks');
const hook = join(hooks, 'pre-push');
const msgHook = join(hooks, 'commit-msg');
// WHY: checked before anything is written, so a refusal leaves both hooks as they were.
if (existsSync(msgHook) && !readFileSync(msgHook, 'utf8').includes(MSG_MARKER)) fail(`${msgHook} is another commit-msg hook. Move it aside (or chain the gate's \`PUSH_GATE_COMMIT_MSG="$1" node <hooks>/${MSG_GATE}/scripts/push-gate.mjs --commit-msg "$1"\` into it by hand), then run this again.`);
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
writeFileSync(hook, `#!/bin/sh\n${MARKER} (rules from origin's default branch). Reinstall: npm run setup:hooks\nexec node "$(dirname "$0")/${LAUNCHER}" --pre-push "$@"\n`);
chmodSync(hook, 0o755);
console.log(`push gate installed: ${hook}`);

// The commit-msg hook runs the gate's own code (the files the launcher loads for a push: --print-gate-files), as
// installed here; the push gate still judges every pushed commit by origin's rules.
const launcher = fileURLToPath(new URL(`./${LAUNCHER}`, import.meta.url));
const { code } = JSON.parse(execFileSync(process.execPath, [launcher, '--print-gate-files'], { encoding: 'utf8' }));
const top = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gateDir = join(hooks, MSG_GATE);
rmSync(gateDir, { recursive: true, force: true });
for (const f of code) {
  mkdirSync(dirname(join(gateDir, f)), { recursive: true });
  copyFileSync(join(top, f), join(gateDir, f));
}
writeFileSync(msgHook, `#!/bin/sh\n${MSG_MARKER} (the push gate's message rule, as installed). Reinstall: npm run setup:hooks\nPUSH_GATE_COMMIT_MSG="$1" exec node "$(dirname "$0")/${MSG_GATE}/${code[0]}" --commit-msg "$1"\n`);
chmodSync(msgHook, 0o755);
console.log(`commit-msg hook installed: ${msgHook}`);
